/**
 * export.test.mjs — --export 迁移包测试（node:test）
 *
 * 夹具库（node:sqlite v1 建表落盘）+ 旧布局 records CSV → buildBackupPackage →
 * fflate 解包断言 manifest / v3 迁移 / uuid records 命名 / gzip roundtrip /
 * STORE 口径；另覆盖库缺失、records 目录缺失与孤儿 records 过滤。
 * 运行：npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, gunzipSync, strFromU8 } from "fflate";
import { buildBackupPackage, packBackupZip } from "../src/export.js";

const UUID_RE = /^[0-9a-f]{32}$/;

/** 建 v1 夹具库：完整旧列集（迁移链依赖）+ 2 行活动 + 报告/对话/记忆 */
function makeFixtureDb(dir) {
  const dbPath = path.join(dir, "fitness.db");
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
     VALUES (?, ?, 'cycling', 3600, 30, ?, '{}')`,
  ).run("MAGENE_TEST_1.fit", "2026-08-30", 93);
  db.prepare(
    `INSERT INTO activities (file_name, date, sport, duration_sec, distance_km, tss, summary_json)
     VALUES (?, ?, 'cycling', 3600, 30, ?, '{}')`,
  ).run("MAGENE_TEST_2.fit", "2026-09-04", 71);
  db.prepare(
    `INSERT INTO ai_reports (mode, file_name, compare_with, prompt, markdown)
     VALUES ('review', 'MAGENE_TEST_1.fit', 'MAGENE_TEST_2.fit', 'p', 'm')`,
  ).run();
  db.close();
  return dbPath;
}

function makeFixture(dir) {
  const dbPath = makeFixtureDb(dir);
  const recordsDir = path.join(dir, "output");
  fs.mkdirSync(recordsDir, { recursive: true });
  // 旧布局：文件名基名（v3 导出应映射成 uuid 条目）
  fs.writeFileSync(
    path.join(recordsDir, "MAGENE_TEST_1.records.csv"),
    "timestamp,power,heart_rate\n2026-08-30T01:00:00.000Z,200,150\n",
  );
  fs.writeFileSync(
    path.join(recordsDir, "MAGENE_TEST_2.records.csv"),
    "timestamp,power,heart_rate\n2026-09-04T01:00:00.000Z,180,140\n",
  );
  fs.writeFileSync(
    path.join(recordsDir, "ORPHAN.records.csv"),
    "timestamp,power\n2026-09-04T01:00:00.000Z,1\n",
  );
  return { dbPath, recordsDir };
}

test("buildBackupPackage: manifest v3 / db 已迁移 / uuid records 三部分齐备", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-export-"));
  try {
    const { dbPath, recordsDir } = makeFixture(dir);
    const { manifest, files } = buildBackupPackage({
      dbPath,
      recordsCsvDir: recordsDir,
      appVersion: "2.0.0",
      now: new Date("2026-09-22T08:00:00Z"),
    });

    assert.equal(manifest.format, "fitbackup");
    assert.equal(manifest.schema_version, 3);
    assert.equal(manifest.device, "docker-web");
    assert.equal(manifest.db_key, null);
    assert.equal(manifest.exported_at, "2026-09-22T08:00:00.000Z");
    assert.equal(manifest.counts.activities, 2);
    assert.equal(manifest.counts.records, 2, "孤儿 records 不入包");

    // db 副本是 SQLite 文件（魔数头），写回后可打开且已迁到 v3
    assert.equal(strFromU8(files["fitness.db"].slice(0, 15)), "SQLite format 3");
    const reopenedPath = path.join(dir, "reopened.db");
    fs.writeFileSync(reopenedPath, files["fitness.db"]);
    const reopened = new DatabaseSync(reopenedPath);
    assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 3);
    const acts = reopened.prepare("SELECT uuid, fingerprint FROM activities").all();
    assert.equal(acts.length, 2);
    for (const a of acts) {
      assert.match(a.uuid, UUID_RE);
      assert.match(a.fingerprint, /^2026-0[89]-\d{2}\|3600\|30000$/);
    }
    reopened.close();

    // records 条目全部 uuid 名；内容与旧 CSV 的 gzip 一致
    const recordKeys = Object.keys(files).filter((k) => k.startsWith("records/"));
    assert.equal(recordKeys.length, 2);
    for (const key of recordKeys) {
      assert.match(key, /^records\/[0-9a-f]{32}\.records\.csv\.gz$/);
    }
    const csv = Buffer.from(gunzipSync(files[recordKeys[0]])).toString("utf8");
    assert.match(csv, /^timestamp,power,heart_rate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("packBackupZip: zip STORE 容器可解包，条目与包内一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-export-"));
  try {
    const { dbPath, recordsDir } = makeFixture(dir);
    const { manifest, files } = buildBackupPackage({ dbPath, recordsCsvDir: recordsDir });
    const out = unzipSync(packBackupZip(files));

    assert.deepEqual(Object.keys(out).sort(), Object.keys(files).sort());
    assert.equal(Object.keys(out).filter((k) => k.startsWith("records/")).length, 2);
    const manifest2 = JSON.parse(strFromU8(out["manifest.json"]));
    assert.deepEqual(manifest2, manifest);
    assert.deepEqual(out["fitness.db"], files["fitness.db"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildBackupPackage: records 目录缺失 → counts.records=0 不失败", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-export-"));
  try {
    const dbPath = makeFixtureDb(dir);
    const { manifest } = buildBackupPackage({
      dbPath,
      recordsCsvDir: path.join(dir, "no-such-dir"),
    });
    assert.deepEqual(manifest.counts, { activities: 2, records: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildBackupPackage: 库不存在抛错（CLI 由入口处理）", () => {
  assert.throws(
    () => buildBackupPackage({ dbPath: path.join(os.tmpdir(), "no-such-fit.db") }),
    /训练库不存在/,
  );
});

test("buildBackupPackage: 默认路径读取 FIT_DB_PATH / FIT_OUTPUT_DIR（Docker 场景）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-export-"));
  const oldDb = process.env.FIT_DB_PATH;
  const oldOut = process.env.FIT_OUTPUT_DIR;
  try {
    const { dbPath, recordsDir } = makeFixture(dir);
    process.env.FIT_DB_PATH = dbPath;
    process.env.FIT_OUTPUT_DIR = recordsDir;
    const { manifest } = buildBackupPackage({ now: new Date("2026-10-20T00:00:00Z") });
    assert.equal(manifest.counts.activities, 2);
    assert.equal(manifest.counts.records, 2);
  } finally {
    if (oldDb == null) delete process.env.FIT_DB_PATH;
    else process.env.FIT_DB_PATH = oldDb;
    if (oldOut == null) delete process.env.FIT_OUTPUT_DIR;
    else process.env.FIT_OUTPUT_DIR = oldOut;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
