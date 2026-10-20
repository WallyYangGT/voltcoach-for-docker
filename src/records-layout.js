/**
 * records-layout.js — records 文件布局（v3：以活动 uuid 命名）与室内指纹回填
 *
 * 自 VoltCoach src/core/records.ts（纯函数）与 src/records-store.ensureRecordFileLayout
 * / src/db/fingerprint.ts 回同步。旧仓 records 是明文 CSV（`<base>.records.csv`），
 * 布局迁移只做文件复制/删除，不涉及 gzip。
 *
 * 存量升级（settings `records_layout_version='3'` 标记）：
 *  - 旧基名可能被 `ride.fit` / `ride.FIT` 共享，必须逐条复制到各自 uuid 后再删旧文件
 *    （不能 rename，否则会丢掉其中一条）；
 *  - 目标 `<uuid>.records.csv` 已存在则跳过（幂等重跑）；
 *  - 孤儿文件（无活动引用）不动；
 *  - 失败只告警、下次开库重试（标记只在全部成功后写）。
 *
 * 室内骑行指纹回填：v3 迁移在 SQL 里只能回填前三段（date|duration|distance），
 * 无有效距离的骑行需要 records 首帧才能补第 4 段 `|start_at`；因此放在布局迁移后
 * 做一次（读文件是 IO，纯 SQL 迁移做不到）。缺 records 的行保留旧指纹，无法重挂。
 */

import fs from "node:fs";
import path from "node:path";
import { isActivityUuid } from "./identity.js";
import { rideFingerprint } from "./dedupe.js";
import { readRecordStartFromFile, safeName } from "./records.js";

/** records 存储基名是否为活动 uuid（与 db 身份同一形状） */
export function isActivityRecordBase(base) {
  return isActivityUuid(base);
}

/** 旧布局（v2 及以前）的活动文件名 → records 基名（去最后一个扩展名） */
export function recordBaseFromFileName(fileName) {
  const safe = safeName(fileName);
  if (!safe) return null;
  return safe.replace(/\.[^.]+$/, "");
}

/**
 * 计算 v2 → v3 records 布局迁移计划（纯函数；执行侧只做 IO）：
 *  - 目标 `<uuid>` 已存在 → 不复制（幂等重跑）；
 *  - 目标缺失且旧基名文件存在 → 复制（复制而非改名）；
 *  - 迁移完成后删除不再被任何活动 uuid 引用的旧基名；孤儿文件不动。
 */
export function planRecordLayout(activities, existingBases) {
  const existing = new Set(existingBases);
  const targets = new Set();
  const oldBases = new Set();
  const copies = [];
  for (const a of activities) {
    if (!isActivityRecordBase(a.uuid)) continue; // 防御：非法身份不参与改名
    targets.add(a.uuid);
    const old = recordBaseFromFileName(a.file_name);
    if (!old || old === a.uuid) continue;
    oldBases.add(old);
    if (!existing.has(a.uuid) && existing.has(old)) copies.push({ from: old, to: a.uuid });
  }
  const deletes = [...oldBases].filter((b) => existing.has(b) && !targets.has(b)).sort();
  return { copies, deletes };
}

// ---------------- 设备侧布局迁移 ----------------

function readSetting(db, key) {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;
}

function writeSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

function recordsPath(outputDir, base) {
  return path.join(outputDir, `${base}.records.csv`);
}

function listExistingBases(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  return fs
    .readdirSync(outputDir)
    .filter((name) => name.toLowerCase().endsWith(".records.csv"))
    .map((name) => name.slice(0, -".records.csv".length));
}

/**
 * 执行 v2 → v3 records 布局迁移 + 室内指纹回填。
 * 调用方负责 try/catch（失败只告警、下次开库重试）。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} outputDir records 目录
 * @param {{ readStart?: (uuid: string) => string | null }} [opts] 测试注入首帧读取
 * @returns {{migrated:boolean, copies:number, deletes:number,
 *   backfill:object|null, skipped?:boolean}} skipped=true 表示目录未就绪、
 *   本次未写标记（下次开库重试）
 */
export function ensureRecordFileLayout(db, outputDir, opts = {}) {
  const marker = readSetting(db, "records_layout_version");
  if (marker === "3") return { migrated: false, copies: 0, deletes: 0, backfill: null };

  const activities = db
    .prepare(`SELECT uuid, file_name FROM activities ORDER BY id ASC`)
    .all();
  // 目录尚未挂载/不存在时不能盖戳：否则正确目录后来出现也不会再迁移。
  // （空库可以直接盖戳——新导入一律写 uuid 基名，不存在旧布局。）
  if (activities.length && !fs.existsSync(outputDir)) {
    console.warn(`records 目录不存在，推迟布局迁移（下次开库重试）: ${outputDir}`);
    return { migrated: false, copies: 0, deletes: 0, backfill: null, skipped: true };
  }
  const existing = listExistingBases(outputDir);
  // 有活动但目录里一份 records 都没有：可能挂载了错误的空目录。此时盖戳会让
  // 正确目录后来出现时永久跳过迁移——推迟到下次开库，不写标记。
  if (activities.length > 0 && existing.length === 0) {
    console.warn(`records 目录为空，推迟布局迁移（下次开库重试）: ${outputDir}`);
    return { migrated: false, copies: 0, deletes: 0, backfill: null, skipped: true };
  }
  const plan = planRecordLayout(activities, existing);

  let copies = 0;
  for (const { from, to } of plan.copies) {
    const src = recordsPath(outputDir, from);
    const dst = recordsPath(outputDir, to);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    fs.copyFileSync(src, dst);
    copies += 1;
  }
  let deletes = 0;
  for (const base of plan.deletes) {
    const p = recordsPath(outputDir, base);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      deletes += 1;
    }
  }

  const readStart =
    opts.readStart ??
    ((uuid) => readRecordStartFromFile(recordsPath(outputDir, uuid)));
  const backfill = backfillIndoorFingerprints(db, readStart);
  writeSetting(db, "records_layout_version", "3");
  return { migrated: true, copies, deletes, backfill };
}

/**
 * 室内骑行（无有效距离）指纹第 4 段回填：从 records 首帧取起骑时刻，重算指纹并
 * 在**一个事务**内同步活动行与全部引用（报告主/对比、对话）。
 * 已带第 4 段（`split('|').length >= 4`）或拿不到首帧的行跳过。
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {(uuid: string) => string | null} readStart
 */
export function backfillIndoorFingerprints(db, readStart) {
  const rows = db
    .prepare(
      `SELECT uuid, date, duration_sec, distance_km, fingerprint
       FROM activities
       WHERE distance_km IS NULL OR distance_km <= 0
       ORDER BY id ASC`,
    )
    .all();

  let updated = 0;
  let skipped = 0;
  let missingStart = 0;
  db.exec("BEGIN;");
  try {
    for (const row of rows) {
      if (!isActivityRecordBase(row.uuid)) {
        skipped += 1;
        continue;
      }
      if (typeof row.fingerprint === "string" && row.fingerprint.split("|").length >= 4) {
        skipped += 1;
        continue;
      }
      const startAt = readStart(row.uuid);
      if (!startAt) {
        missingStart += 1;
        continue;
      }
      const next = rideFingerprint({
        date: row.date,
        duration_sec: row.duration_sec,
        distance_km: row.distance_km,
        start_at: startAt,
      });
      if (next === row.fingerprint) {
        skipped += 1;
        continue;
      }
      const old = row.fingerprint;
      db.prepare(`UPDATE activities SET fingerprint = ? WHERE uuid = ? AND fingerprint = ?`).run(
        next,
        row.uuid,
        old,
      );
      db.prepare(
        `UPDATE ai_reports SET activity_fingerprint = ?
         WHERE activity_uuid = ? AND activity_fingerprint = ?`,
      ).run(next, row.uuid, old);
      db.prepare(
        `UPDATE ai_reports SET compare_fingerprint = ?
         WHERE compare_uuid = ? AND compare_fingerprint = ?`,
      ).run(next, row.uuid, old);
      db.prepare(
        `UPDATE ai_chats SET activity_fingerprint = ?
         WHERE activity_uuid = ? AND activity_fingerprint = ?`,
      ).run(next, row.uuid, old);
      updated += 1;
    }
    db.exec("COMMIT;");
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // BEGIN 未成功时 ROLLBACK 会报无事务，忽略
    }
    throw e;
  }
  return { updated, skipped, missing_start: missingStart };
}
