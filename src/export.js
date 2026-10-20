/**
 * export.js
 * `--export` 子命令：把训练库与逐秒 records 打包成安卓版（VoltCoach）可导入的
 * `.fitbackup` 迁移包（格式见主仓 voltcoach 的 docs/BACKUP_FORMAT.md 与
 * 本仓 MIGRATION_PLAN §7.3）。
 *
 * v3 起（decisions §34）：
 *  - 包内 manifest.schema_version = 3（与 App 端 SCHEMA_VERSION 同一口径）；
 *  - 包内 DB 先跑编号迁移链（旧 v1/v2 库也能直接导出成 v3 包）；
 *  - records 条目名 `records/<活动 uuid>.records.csv.gz`；只收录库内活动引用的
 *    文件（无主孤儿跳过并告警），counts.records 即有效载荷数。
 *
 * 包结构（zip STORE，payload 已压缩不再 deflate）：
 *   manifest.json
 *   fitness.db                         训练库整库（明文；App 端导入时自动重加密）
 *   records/<uuid>.records.csv.gz      output/<uuid>.records.csv 逐个 gzip
 *
 * db_key 恒为 null：本包内库是明文，App 端按「明文库」分支导入。
 * 库一致性：VACUUM INTO 出副本再打包（同时压缩空闲页），不动原库。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { zipSync } from "fflate";
import { migrateSchema } from "./migrations.js";
import { SCHEMA_VERSION } from "./schema.js";
import { validateBackupManifest } from "./backup-manifest.js";
import { recordBaseFromFileName } from "./records-layout.js";

const encoder = new TextEncoder();

/** 读本包 package.json 版本（manifest.app_version 的缺省来源） */
function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "");
  } catch {
    return "";
  }
}

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
  // Docker 部署把库与输出挂在 /app/db、/output（FIT_DB_PATH/FIT_OUTPUT_DIR），
  // 默认值必须同口径读取，否则容器内 --export 会漏掉全部 records
  dbPath = process.env.FIT_DB_PATH || path.resolve("db", "fitness.db"),
  recordsCsvDir = process.env.FIT_OUTPUT_DIR || path.resolve("output"),
  // Docker 本地默认构建会把 APP_VERSION 设为 latest——那不是真实版本号，回落 package.json
  appVersion =
    process.env.APP_VERSION && process.env.APP_VERSION !== "latest"
      ? process.env.APP_VERSION
      : packageVersion(),
  now = new Date(),
} = {}) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`训练库不存在: ${dbPath}`);
  }

  // ---- db：先跑迁移链（旧库导出必须是 v3 形状），再 VACUUM INTO 一致性副本 ----
  const live = new DatabaseSync(dbPath);
  try {
    migrateSchema(live, { dbPath });
  } finally {
    live.close();
  }

  const vacuumCopy = `${dbPath}.export-tmp`;
  if (fs.existsSync(vacuumCopy)) fs.rmSync(vacuumCopy);
  const db = new DatabaseSync(dbPath);
  let activityRows;
  try {
    db.exec(`VACUUM INTO '${vacuumCopy.replaceAll("'", "''")}'`);
    activityRows = db.prepare("SELECT uuid, file_name FROM activities").all();
  } catch (e) {
    try {
      db.close();
    } catch {
      // 关闭失败不掩盖原始错误
    }
    if (fs.existsSync(vacuumCopy)) fs.rmSync(vacuumCopy, { force: true });
    throw e;
  }
  db.close();
  const activities = activityRows.length;
  const activityUuids = new Set(activityRows.map((r) => r.uuid));
  // 旧布局兼容：CLI --export 不经过 openDb，可能还没做 records 布局迁移。
  // 旧基名按 file_name 映射到 uuid（共享基名展开多份），包内条目始终是 uuid 名。
  const uuidsByOldBase = new Map();
  for (const r of activityRows) {
    const old = recordBaseFromFileName(r.file_name);
    if (!old) continue;
    const list = uuidsByOldBase.get(old) ?? [];
    list.push(r.uuid);
    uuidsByOldBase.set(old, list);
  }
  const dbBytes = new Uint8Array(fs.readFileSync(vacuumCopy));
  fs.rmSync(vacuumCopy);

  // ---- records：只收录库内活动引用的 <uuid>.records.csv（孤儿跳过并告警） ----
  const files = {};
  const included = new Set();
  let recordsCount = 0;
  let skippedOrphans = 0;
  if (fs.existsSync(recordsCsvDir)) {
    const names = fs
      .readdirSync(recordsCsvDir)
      .filter((n) => n.toLowerCase().endsWith(".records.csv"))
      .sort();
    const baseOf = (name) => name.slice(0, -".records.csv".length);
    // 先处理 uuid 基名（v3 权威布局），再处理旧基名兜底；混合状态下避免
    // 旧文件先占位、后面的新 uuid 文件被 included 跳过而打包旧数据。
    const ordered = [
      ...names.filter((n) => activityUuids.has(baseOf(n))),
      ...names.filter((n) => !activityUuids.has(baseOf(n))),
    ];
    for (const name of ordered) {
      const base = baseOf(name);
      const targets = activityUuids.has(base)
        ? [base]
        : (uuidsByOldBase.get(base) ?? []);
      if (!targets.length) {
        skippedOrphans += 1;
        continue;
      }
      const gz = new Uint8Array(
        zlib.gzipSync(fs.readFileSync(path.join(recordsCsvDir, name))),
      );
      for (const uuid of targets) {
        const entry = `records/${uuid}.records.csv.gz`;
        if (included.has(entry)) continue;
        included.add(entry);
        files[entry] = gz;
        recordsCount += 1;
      }
    }
  }
  if (skippedOrphans)
    console.warn(`跳过 ${skippedOrphans} 份无主 records（无活动引用，不入包）`);

  const manifest = {
    format: "fitbackup",
    schema_version: SCHEMA_VERSION,
    app_version: appVersion,
    exported_at: now.toISOString(),
    device: "docker-web",
    db_key: null,
    counts: { activities, records: recordsCount },
  };
  const manifestError = validateBackupManifest(manifest);
  if (manifestError) throw new Error(`manifest 自检失败: ${manifestError}`);

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
