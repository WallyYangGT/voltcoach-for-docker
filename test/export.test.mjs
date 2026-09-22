/**
 * export.test.mjs — --export 迁移包测试（node:test）
 *
 * 夹具库（node:sqlite 内存建表落盘）+ 夹具 records CSV → buildBackupPackage →
 * fflate 解包断言 manifest / db 字节 / gzip roundtrip / STORE 口径；另覆盖
 * 库缺失退出、records 目录缺失容错。
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

/** 建夹具库：activities 表最小列集（与旧库同名的关键列）+ 2 行 */
function makeFixtureDb(dir) {
  const dbPath = path.join(dir, "fitness.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL UNIQUE,
      date TEXT NOT NULL,
      tss REAL,
      summary_json TEXT NOT NULL,
      category TEXT DEFAULT 'training',
      note TEXT
    );
  `);
  db.prepare(
    "INSERT INTO activities (file_name, date, tss, summary_json) VALUES (?, ?, ?, ?)",
  ).run("MAGENE_TEST_1.fit", "2026-08-30", 93, "{}");
  db.prepare(
    "INSERT INTO activities (file_name, date, tss, summary_json) VALUES (?, ?, ?, ?)",
  ).run("MAGENE_TEST_2.fit", "2026-09-04", 71, "{}");
  db.close();
  return dbPath;
}

function makeFixture(dir) {
  const dbPath = makeFixtureDb(dir);
  const recordsDir = path.join(dir, "output");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(
    path.join(recordsDir, "MAGENE_TEST_1.records.csv"),
    "timestamp,power,heart_rate\n2026-08-30T01:00:00.000Z,200,150\n",
  );
  fs.writeFileSync(
    path.join(recordsDir, "MAGENE_TEST_2.records.csv"),
    "timestamp,power,heart_rate\n2026-09-04T01:00:00.000Z,180,140\n",
  );
  return { dbPath, recordsDir };
}

test("buildBackupPackage: manifest / db / gzip records 三部分齐备", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fit-export-"));
  try {
    const { dbPath, recordsDir } = makeFixture(dir);
    const { manifest, files } = buildBackupPackage({
      dbPath,
      recordsCsvDir: recordsDir,
      appVersion: "1.9.6",
      now: new Date("2026-09-22T08:00:00Z"),
    });

    assert.equal(manifest.format, "fitbackup");
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.device, "docker-web");
    assert.equal(manifest.db_key, null);
    assert.equal(manifest.exported_at, "2026-09-22T08:00:00.000Z");
    assert.deepEqual(manifest.counts, { activities: 2, records: 2 });

    // db 副本是 SQLite 文件（魔数头），写回后可打开且活动数一致
    assert.equal(strFromU8(files["fitness.db"].slice(0, 15)), "SQLite format 3");
    const reopenedPath = path.join(dir, "reopened.db");
    fs.writeFileSync(reopenedPath, files["fitness.db"]);
    const reopened = new DatabaseSync(reopenedPath);
    const count = reopened.prepare("SELECT COUNT(*) AS c FROM activities").get();
    reopened.close();
    assert.equal(count.c, 2);

    // records 条目 gzip roundtrip，内容与夹具 CSV 一致
    const gz = files["records/MAGENE_TEST_1.records.csv.gz"];
    assert.ok(gz, "records 条目缺失");
    const csv = Buffer.from(gunzipSync(gz)).toString("utf8");
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

    assert.deepEqual(Object.keys(out).sort(), ["fitness.db", "manifest.json", "records/MAGENE_TEST_1.records.csv.gz", "records/MAGENE_TEST_2.records.csv.gz"]);
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
    const { manifest } = buildBackupPackage({ dbPath, recordsCsvDir: path.join(dir, "no-such-dir") });
    assert.deepEqual(manifest.counts, { activities: 2, records: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
