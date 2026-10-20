/**
 * records-layout.test.mjs — v2 → v3 records 布局迁移与室内指纹回填
 * （自 VoltCoach test/records-layout.test.mjs 与 test/fingerprint-backfill.test.mjs 回同步）
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  backfillIndoorFingerprints,
  ensureRecordFileLayout,
  planRecordLayout,
  recordBaseFromFileName,
} from "../src/records-layout.js";
import { CREATE_SCHEMA_SQL } from "../src/schema.js";
import { newActivityUuid } from "../src/identity.js";

const U1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const U2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fit-records-layout-"));
}

function makeDb(dir) {
  const dbPath = path.join(dir, "fitness.db");
  const db = new DatabaseSync(dbPath);
  db.exec(CREATE_SCHEMA_SQL);
  return { db, dbPath };
}

function insertActivity(db, { uuid, fileName, fingerprint, date = "2026-10-01", distance = null }) {
  db.prepare(
    `INSERT INTO activities (uuid, file_name, fingerprint, date, sport, duration_sec, distance_km, summary_json)
     VALUES (?, ?, ?, ?, 'cycling', 3600, ?, '{}')`,
  ).run(uuid, fileName, fingerprint, date, distance);
}

function writeRecords(dir, base, start = "2026-10-01T01:00:00.000Z") {
  fs.writeFileSync(
    path.join(dir, `${base}.records.csv`),
    `timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature\n${start},200,150,90,10,30,0,\n`,
  );
}

test("recordBaseFromFileName：去最后一个扩展名，路径/穿越拒绝", () => {
  assert.equal(recordBaseFromFileName("ride.fit"), "ride");
  assert.equal(recordBaseFromFileName("ride.FIT"), "ride");
  assert.equal(recordBaseFromFileName("a.b.fit"), "a.b");
  assert.equal(recordBaseFromFileName("../ride.fit"), null);
});

test("planRecordLayout：复制到各 uuid、旧基名最后删除、孤儿不动、幂等", () => {
  const plan = planRecordLayout(
    [
      { uuid: U1, file_name: "ride.fit" },
      { uuid: U2, file_name: "ride.FIT" },
      { uuid: newActivityUuid(), file_name: "other.fit" },
    ],
    ["ride", "orphan"],
  );
  assert.deepEqual(plan.copies, [
    { from: "ride", to: U1 },
    { from: "ride", to: U2 },
  ]);
  assert.deepEqual(plan.deletes, ["ride"]);

  // 目标已存在 → 不再复制，但旧基名仍可删
  const idempotent = planRecordLayout(
    [{ uuid: U1, file_name: "ride.fit" }],
    ["ride", U1],
  );
  assert.deepEqual(idempotent.copies, []);
  assert.deepEqual(idempotent.deletes, ["ride"]);

  // 孤儿旧基名不动
  assert.deepEqual(planRecordLayout([], ["orphan"]).deletes, []);
});

test("ensureRecordFileLayout：共享旧基名逐条复制、删旧文件、写标记、幂等", () => {
  const dir = tmpDir();
  try {
    const { db } = makeDb(dir);
    insertActivity(db, { uuid: U1, fileName: "ride.fit", fingerprint: "2026-10-01|3600|" });
    insertActivity(db, { uuid: U2, fileName: "ride.FIT", fingerprint: "2026-10-01|3600|" });
    writeRecords(dir, "ride");
    writeRecords(dir, "orphan");

    const first = ensureRecordFileLayout(db, dir);
    assert.equal(first.migrated, true);
    assert.equal(first.copies, 2);
    assert.equal(first.deletes, 1);
    assert.ok(fs.existsSync(path.join(dir, `${U1}.records.csv`)));
    assert.ok(fs.existsSync(path.join(dir, `${U2}.records.csv`)));
    assert.ok(!fs.existsSync(path.join(dir, "ride.records.csv")));
    assert.ok(fs.existsSync(path.join(dir, "orphan.records.csv")), "孤儿文件不动");
    assert.equal(
      db.prepare(`SELECT value FROM settings WHERE key = 'records_layout_version'`).get().value,
      "3",
    );

    const second = ensureRecordFileLayout(db, dir);
    assert.equal(second.migrated, false);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureRecordFileLayout：输出目录缺失时不写标记，目录出现后可重试", () => {
  const dir = tmpDir();
  try {
    const { db } = makeDb(dir);
    insertActivity(db, { uuid: U1, fileName: "ride.fit", fingerprint: "2026-10-01|3600|" });
    const missingDir = path.join(dir, "not-mounted-yet");
    const first = ensureRecordFileLayout(db, missingDir);
    assert.equal(first.skipped, true);
    assert.equal(
      db.prepare(`SELECT value FROM settings WHERE key = 'records_layout_version'`).get(),
      undefined,
      "目录缺失时不应盖戳",
    );

    // 目录存在但为空（挂错空目录）也不盖戳
    fs.mkdirSync(missingDir, { recursive: true });
    const empty = ensureRecordFileLayout(db, missingDir);
    assert.equal(empty.skipped, true);
    assert.equal(
      db.prepare(`SELECT value FROM settings WHERE key = 'records_layout_version'`).get(),
      undefined,
    );

    // 正确目录出现 + 旧基名 records → 可继续迁移
    writeRecords(missingDir, "ride");
    const second = ensureRecordFileLayout(db, missingDir);
    assert.equal(second.migrated, true);
    assert.ok(fs.existsSync(path.join(missingDir, `${U1}.records.csv`)));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureRecordFileLayout：室内行指纹补第 4 段，并同步报告/对话引用", () => {
  const dir = tmpDir();
  try {
    const { db } = makeDb(dir);
    insertActivity(db, { uuid: U1, fileName: "indoor.fit", fingerprint: "2026-10-01|3600|" });
    writeRecords(dir, U1, "2026-10-01T01:00:00.000Z");
    insertActivity(db, { uuid: U2, fileName: "outdoor.fit", fingerprint: "2026-10-01|3600|30000", distance: 30 });
    writeRecords(dir, U2, "2026-10-01T02:00:00.000Z");
    db.prepare(
      `INSERT INTO ai_reports (mode, activity_uuid, compare_uuid, activity_fingerprint, compare_fingerprint, prompt, markdown)
       VALUES ('review', ?, ?, '2026-10-01|3600|', '2026-10-01|3600|30000', 'p', 'm')`,
    ).run(U1, U2);
    db.prepare(
      `INSERT INTO ai_chats (mode, activity_uuid, activity_fingerprint, title)
       VALUES ('follow_up', ?, '2026-10-01|3600|', 't')`,
    ).run(U1);

    const result = ensureRecordFileLayout(db, dir);
    assert.equal(result.backfill.updated, 1);
    assert.equal(
      db.prepare(`SELECT fingerprint FROM activities WHERE uuid = ?`).get(U1).fingerprint,
      "2026-10-01|3600||2026-10-01T01:00:00.000Z",
    );
    assert.equal(
      db.prepare(`SELECT fingerprint FROM activities WHERE uuid = ?`).get(U2).fingerprint,
      "2026-10-01|3600|30000",
      "户外行指纹不动",
    );
    assert.equal(
      db.prepare(`SELECT activity_fingerprint FROM ai_reports`).get().activity_fingerprint,
      "2026-10-01|3600||2026-10-01T01:00:00.000Z",
    );
    assert.equal(
      db.prepare(`SELECT activity_fingerprint FROM ai_chats`).get().activity_fingerprint,
      "2026-10-01|3600||2026-10-01T01:00:00.000Z",
    );
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backfillIndoorFingerprints：缺 records 保留旧指纹；已带第 4 段跳过", () => {
  const dir = tmpDir();
  try {
    const { db } = makeDb(dir);
    insertActivity(db, { uuid: U1, fileName: "a.fit", fingerprint: "2026-10-01|3600|" });
    insertActivity(db, { uuid: U2, fileName: "b.fit", fingerprint: "2026-10-01|3600||2026-10-01T01:00:00.000Z" });
    const r = backfillIndoorFingerprints(db, (uuid) =>
      uuid === U1 ? null : "2026-10-01T01:00:00.000Z",
    );
    assert.equal(r.missing_start, 1);
    assert.equal(r.updated, 0);
    assert.equal(
      db.prepare(`SELECT fingerprint FROM activities WHERE uuid = ?`).get(U1).fingerprint,
      "2026-10-01|3600|",
    );
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
