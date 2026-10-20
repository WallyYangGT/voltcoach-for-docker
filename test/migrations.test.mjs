/**
 * migrations.test.mjs — schema 编号步进迁移（纯步骤序列 + 真实 node:sqlite）
 * 自 VoltCoach test/migrations.test.mjs 与 test/migrations-db.test.mjs 回同步。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMA_VERSION,
  migrateSchema,
  migrationsFor,
  readUserVersion,
  runMigrations,
} from "../src/migrations.js";
import { CREATE_SCHEMA_SQL } from "../src/schema.js";

const UUID_RE = /^[0-9a-f]{32}$/;

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-migrations-"));
  return { dir, dbPath: path.join(dir, "fitness.db") };
}

/** 构造真正的 v2 库：v1 建表 + v1→2 两条 ALTER + user_version=2 */
function makeV2Db(dbPath) {
  makeV1Db(dbPath);
  const db = new DatabaseSync(dbPath);
  runMigrations(db, 1, 2);
  db.exec(`PRAGMA user_version = 2;`);
  db.close();
}

function makeV1Db(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      sport TEXT,
      duration_sec INTEGER,
      distance_km REAL,
      elevation_gain_m REAL,
      tss REAL,
      np REAL,
      avg_power REAL,
      intensity_factor REAL,
      summary_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE ai_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      file_name TEXT,
      race_date TEXT,
      compare_with TEXT,
      prompt TEXT NOT NULL,
      markdown TEXT NOT NULL,
      status TEXT DEFAULT 'completed',
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ai_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      report_id INTEGER,
      file_name TEXT,
      title TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'completed',
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE ai_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      source TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      superseded_by INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO activities (file_name, date, sport, duration_sec, distance_km, tss, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ride1.fit", "2026-10-01", "cycling", 3600, 30, 60, '{"activity":{}}');
  db.prepare(
    `INSERT INTO activities (file_name, date, sport, duration_sec, distance_km, tss, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("ride2.fit", "2026-10-02", "cycling", 2400, null, 40, '{"activity":{}}');
  db.prepare(
    `INSERT INTO ai_reports (mode, file_name, compare_with, prompt, markdown)
     VALUES ('review', 'ride1.fit', 'ride2.fit', 'p', 'm')`,
  ).run();
  db.prepare(
    `INSERT INTO ai_reports (mode, file_name, prompt, markdown)
     VALUES ('review', 'missing.fit', 'p', 'm')`,
  ).run();
  db.prepare(
    `INSERT INTO ai_chats (mode, report_id, file_name, title) VALUES ('follow_up', 1, 'ride1.fit', 't1')`,
  ).run();
  db.prepare(
    `INSERT INTO ai_chats (mode, report_id, file_name, title) VALUES ('chat', 999, 'ride2.fit', 't2')`,
  ).run();
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (1, 'user', 'u1')`).run();
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (2, 'user', 'u2')`).run();
  db.prepare(`INSERT INTO ai_chat_messages (chat_id, role, content) VALUES (999, 'user', 'orphan')`).run();
  db.prepare(`INSERT INTO ai_memories (content, category) VALUES ('长期事实', 'general')`).run();
  db.close();
}

test("migrationsFor：v1→2 两条 ALTER、v2→3 单 rebuild、v1→3 顺序；越界/反向报错", () => {
  assert.equal(SCHEMA_VERSION, 3);
  assert.deepEqual(
    migrationsFor(1, 2).map((s) => s.kind),
    ["sql", "sql"],
  );
  assert.deepEqual(migrationsFor(2, 3), [{ kind: "rebuild-v3" }]);
  assert.deepEqual(
    migrationsFor(1, 3).map((s) => s.kind),
    ["sql", "sql", "rebuild-v3"],
  );
  assert.deepEqual(migrationsFor(3, 3), []);
  assert.throws(() => migrationsFor(0, 3));
  assert.throws(() => migrationsFor(3, 2));
  assert.throws(() => migrationsFor(1, 4));
  assert.throws(() => migrationsFor(1.5, 3));
});

test("v1→v3：数据保留、uuid 回填、指纹、报告/对话映射、孤儿消息丢弃", () => {
  const { dir, dbPath } = tmpDb();
  try {
    makeV1Db(dbPath);
    const db = new DatabaseSync(dbPath);
    migrateSchema(db, { dbPath });
    assert.equal(readUserVersion(db), 3);

    const acts = db.prepare(`SELECT * FROM activities ORDER BY id`).all();
    assert.equal(acts.length, 2);
    for (const a of acts) assert.match(a.uuid, UUID_RE);
    assert.equal(acts[0].fingerprint, "2026-10-01|3600|30000");
    assert.equal(acts[1].fingerprint, "2026-10-02|2400|");
    assert.equal(acts[1].power_flagged, 0);

    const r1 = db.prepare(`SELECT * FROM ai_reports WHERE id = 1`).get();
    assert.equal(r1.activity_uuid, acts[0].uuid);
    assert.equal(r1.compare_uuid, acts[1].uuid);
    assert.equal(r1.activity_fingerprint, "2026-10-01|3600|30000");
    assert.equal(r1.compare_fingerprint, "2026-10-02|2400|");
    const r2 = db.prepare(`SELECT * FROM ai_reports WHERE id = 2`).get();
    assert.equal(r2.activity_uuid, null);
    assert.equal(r2.compare_uuid, null);

    const c1 = db.prepare(`SELECT * FROM ai_chats WHERE id = 1`).get();
    assert.equal(c1.activity_uuid, acts[0].uuid);
    assert.equal(c1.report_id, 1);
    const c2 = db.prepare(`SELECT * FROM ai_chats WHERE id = 2`).get();
    assert.equal(c2.activity_uuid, acts[1].uuid);
    assert.equal(c2.report_id, null); // dangling report_id 置 NULL

    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ai_chat_messages`).get().c, 2);
    assert.equal(
      db.prepare(`SELECT scope FROM ai_memories WHERE id = 1`).get().scope,
      "long",
    );
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v3 外键：删活动 uuid 置 NULL 且指纹保留；删报告对话 report_id 置 NULL；删对话消息级联", () => {
  const { dir, dbPath } = tmpDb();
  try {
    makeV1Db(dbPath);
    let db = new DatabaseSync(dbPath);
    migrateSchema(db, { dbPath });
    db.exec(`PRAGMA foreign_keys = ON;`);
    const a1 = db.prepare(`SELECT uuid FROM activities WHERE file_name = 'ride1.fit'`).get();
    db.prepare(`DELETE FROM activities WHERE uuid = ?`).run(a1.uuid);

    const r1 = db.prepare(`SELECT * FROM ai_reports WHERE id = 1`).get();
    assert.equal(r1.activity_uuid, null);
    assert.equal(r1.activity_fingerprint, "2026-10-01|3600|30000");
    const c1 = db.prepare(`SELECT * FROM ai_chats WHERE id = 1`).get();
    assert.equal(c1.activity_uuid, null);
    assert.equal(c1.activity_fingerprint, "2026-10-01|3600|30000");

    db.prepare(`DELETE FROM ai_reports WHERE id = 1`).run();
    assert.equal(db.prepare(`SELECT report_id FROM ai_chats WHERE id = 1`).get().report_id, null);
    db.prepare(`DELETE FROM ai_chats WHERE id = 1`).run();
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS c FROM ai_chat_messages WHERE chat_id = 1`).get().c,
      0,
    );
    db.close();

    // 重新打开：每连接都要恢复 FK
    db = new DatabaseSync(dbPath);
    migrateSchema(db, { dbPath });
    db.exec(`PRAGMA foreign_keys = ON;`);
    assert.equal(db.prepare(`PRAGMA foreign_key_check`).all().length, 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v2→v3：power_flagged / scope 原值保留；同名 file_name 可并存", () => {
  const { dir, dbPath } = tmpDb();
  try {
    makeV2Db(dbPath);
    let db = new DatabaseSync(dbPath);
    db.exec(`UPDATE activities SET power_flagged = 1 WHERE file_name = 'ride1.fit'`);
    db.exec(`UPDATE ai_memories SET scope = 'short' WHERE id = 1`);
    db.close();

    db = new DatabaseSync(dbPath);
    migrateSchema(db, { dbPath });
    assert.equal(readUserVersion(db), 3);
    assert.equal(
      db.prepare(`SELECT power_flagged FROM activities WHERE file_name = 'ride1.fit'`).get()
        .power_flagged,
      1,
    );
    assert.equal(db.prepare(`SELECT scope FROM ai_memories WHERE id = 1`).get().scope, "short");
    const uuids = db.prepare(`SELECT uuid FROM activities`).all().map((r) => r.uuid);
    db.prepare(
      `INSERT INTO activities (uuid, file_name, fingerprint, date, summary_json)
       VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ride1.fit', '', '2026-10-03', '{}')`,
    ).run();
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM activities`).get().c, 3);
    assert.equal(new Set(uuids).size, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("全新库：整体建表并盖戳；v3 形状丢版本戳只补表不重建 uuid", () => {
  const { dir, dbPath } = tmpDb();
  try {
    let db = new DatabaseSync(dbPath);
    migrateSchema(db, { dbPath });
    assert.equal(readUserVersion(db), 3);
    for (const table of ["activities", "ai_reports", "ai_chats", "ai_chat_messages", "ai_memories", "settings"])
      assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table), table);
    db.close();

    const db2Path = path.join(dir, "v3-lost-version.db");
    let db2 = new DatabaseSync(db2Path);
    db2.exec(CREATE_SCHEMA_SQL);
    db2.prepare(
      `INSERT INTO activities (uuid, file_name, fingerprint, date, summary_json)
       VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'x.fit', 'fp', '2026-10-01', '{}')`,
    ).run();
    db2.exec(`PRAGMA user_version = 0;`);
    db2.close();

    db2 = new DatabaseSync(db2Path);
    migrateSchema(db2, { dbPath: db2Path });
    assert.equal(readUserVersion(db2), 3);
    assert.equal(
      db2.prepare(`SELECT uuid FROM activities`).get().uuid,
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v2→v3 重建失败：事务回滚，旧表与 user_version=2 保持", () => {
  const { dir, dbPath } = tmpDb();
  try {
    makeV2Db(dbPath);
    let db = new DatabaseSync(dbPath);
    // 预置同名表让 CREATE TABLE activities_v3 失败
    db.exec(`CREATE TABLE activities_v3 (x INTEGER);`);
    db.close();

    db = new DatabaseSync(dbPath);
    assert.throws(() => migrateSchema(db, { dbPath }), /already exists/i);
    assert.equal(readUserVersion(db), 2);
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM activities`).get().c, 2);
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='activities_v3'`).get());
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
