/**
 * export.js
 * `--export` 子命令：把训练库与逐秒 records 打包成安卓版（VoltCoach）可导入的
 * `.fitbackup` 迁移包（fit-reader-android 仓库 MIGRATION_PLAN §7.3）。
 *
 * 包结构（zip STORE，payload 已压缩不再 deflate）：
 *   manifest.json                      清单（schema_version 与 App 端 src/db
 *                                      SCHEMA_VERSION 同一口径，当前为 1）
 *   fitness.db                         训练库整库（明文；App 端导入时自动重加密）
 *   records/<base>.records.csv.gz      output/*.records.csv 逐个 gzip（App 端同构）
 *
 * db_key 恒为 null：本包内库是明文，App 端按「明文库」分支导入（§7.2 语义）。
 * 库一致性：VACUUM INTO 出副本再打包（同时压缩空闲页），不动原库。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { zipSync, unzipSync } from "fflate";

const encoder = new TextEncoder();

/**
 * 构建 .fitbackup 包内容（纯构建，不落盘；测试直接断言返回值）。
 * @param {object} opts
 * @param {string} opts.dbPath          训练库路径（默认 ./db/fitness.db，可传测试夹具）
 * @param {string} [opts.recordsCsvDir] records CSV 目录（默认 ./output；不存在按 0 条）
 * @param {string} [opts.appVersion]    写入 manifest 的导出方版本
 * @param {Date}   [opts.now]           导出时间（测试注入）
 * @returns {{ manifest: object, files: Record<string, Uint8Array> }}
 */
export function buildBackupPackage({
  dbPath = path.resolve("db", "fitness.db"),
  recordsCsvDir = path.resolve("output"),
  appVersion = "",
  now = new Date(),
} = {}) {
  if (!fs.existsSync(dbPath)) {
    console.error(`训练库不存在: ${dbPath}`);
    process.exit(1);
  }

  // ---- db：VACUUM INTO 一致性副本（离线 CLI 本可直接拷，VACUUM 顺带回收空闲页） ----
  const vacuumCopy = `${dbPath}.export-tmp`;
  if (fs.existsSync(vacuumCopy)) fs.rmSync(vacuumCopy);
  const db = new DatabaseSync(dbPath);
  db.exec(`VACUUM INTO '${vacuumCopy.replaceAll("'", "''")}'`);
  const activities = Number(
    db.prepare("SELECT COUNT(*) AS c FROM activities").get()?.c ?? 0,
  );
  db.close();
  const dbBytes = new Uint8Array(fs.readFileSync(vacuumCopy));
  fs.rmSync(vacuumCopy);

  // ---- records：output/*.records.csv → gzip，条目名与 App 端 records-store 同构 ----
  const files = {};
  let recordsCount = 0;
  if (fs.existsSync(recordsCsvDir)) {
    for (const name of fs.readdirSync(recordsCsvDir).sort()) {
      if (!name.toLowerCase().endsWith(".records.csv")) continue;
      const base = name.slice(0, -".records.csv".length);
      const gz = zlib.gzipSync(fs.readFileSync(path.join(recordsCsvDir, name)));
      files[`records/${base}.records.csv.gz`] = new Uint8Array(gz);
      recordsCount += 1;
    }
  }

  const manifest = {
    format: "fitbackup",
    schema_version: 1, // 与 App 端 src/db SCHEMA_VERSION 对齐；App schema 已含旧版历次 ALTER 的列
    app_version: appVersion,
    exported_at: now.toISOString(),
    device: "docker-web",
    db_key: null,
    counts: { activities, records: recordsCount },
  };

  return {
    manifest,
    files: {
      "manifest.json": encoder.encode(JSON.stringify(manifest)),
      "fitness.db": dbBytes,
      ...files,
    },
  };
}

/** zip（STORE）打包为 .fitbackup 字节 */
export function packBackupZip(files) {
  return zipSync(files, { level: 0 });
}

/**
 * --export 入口：打包并写到 <输出目录>/voltcoach-backup-<本地时间戳>.fitbackup。
 * 输出目录默认 ./export（避让存分析产物的 ./output）。
 */
export function exportBackup(outDir = path.resolve("export"), opts = {}) {
  const { manifest, files } = buildBackupPackage(opts);
  const zip = packBackupZip(files);

  fs.mkdirSync(outDir, { recursive: true });
  const n = opts.now ?? new Date();
  const p = (x) => String(x).padStart(2, "0");
  const stamp = `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
  const outFile = path.join(outDir, `voltcoach-backup-${stamp}.fitbackup`);
  fs.writeFileSync(outFile, zip);

  console.log(`迁移包已生成: ${outFile}`);
  console.log(
    `  活动 ${manifest.counts.activities} 条 · records ${manifest.counts.records} 份 · ${(zip.length / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log("  导入方式：安卓版 VoltCoach → 我的 → 数据管理 → 从备份包导入");
  return outFile;
}
