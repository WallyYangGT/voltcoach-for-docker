/**
 * records.js — 逐秒 records CSV 的读写、抽稀与首帧时间戳
 * （v3：文件以活动 uuid 命名；自 VoltCoach src/core/records.ts 与
 * src/records-store.ts 回同步）
 *
 * records 是严格 1 秒网格的 CSV（列序固定：
 * timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature），
 * 供详情页图表、AI 工具与 reanalyze/功率校准复用。文件 IO 只认 uuid 基名
 * （`<uuid>.records.csv`），旧基名迁移由 records-layout.js 负责。
 */

import fs from "node:fs";
import path from "node:path";
import { isActivityUuid } from "./identity.js";

const RECORDS_HEADER =
  "timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature";

/** 文件名安全化：只取 basename，防止路径穿越（FIT 来源文件名用） */
export function safeName(name) {
  if (!name || typeof name !== "string") return null;
  // 同时识别 / 与 \ 分隔符（Linux 部署也可能收到 Windows 路径）
  const base = name.split(/[\\/]/).pop() ?? name;
  return base === name && !base.includes("..") && base.length > 0 ? base : null;
}

/** records CSV 文本 → 逐秒记录数组（缺列/空值归一为 null） */
export function parseRecordsCsv(text) {
  const lines = String(text ?? "").trim().split("\n");
  if (lines.length < 2) return [];
  const rows = lines.slice(1); // 跳过表头
  const num = (s) =>
    s === "" || s == null || Number.isNaN(Number(s)) ? null : Number(s);
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    const c = row.split(",");
    out.push({
      timestamp: c[0],
      power: num(c[1]),
      heart_rate: num(c[2]),
      cadence: num(c[3]),
      altitude: num(c[4]),
      speed: num(c[5]),
      distance: num(c[6]),
      temperature: num(c[7]),
    });
  }
  return out;
}

/**
 * 时间窗截取 + 抽稀：startSec/endSec 为相对训练开始的秒数（先截取再抽稀），
 * 供 AI 工具只取片段（如"最后 10 分钟功率"）；maxPoints 为输出点数上限
 * （口径 1400：stride = ceil(rows/maxPoints)，从 0 号点起按 stride 取点）。
 */
export function thinRecords(records, { maxPoints = 1400, startSec, endSec } = {}) {
  let rows = records ?? [];
  const hasWindow = startSec != null || endSec != null;
  if (hasWindow && rows.length) {
    const t0 = Date.parse(rows[0].timestamp);
    if (Number.isFinite(t0)) {
      rows = rows.filter((row) => {
        const sec = (Date.parse(row.timestamp) - t0) / 1000;
        if (!Number.isFinite(sec)) return false;
        if (startSec != null && sec < startSec) return false;
        if (endSec != null && sec > endSec) return false;
        return true;
      });
    }
  }
  // 时间窗落在训练范围外 → 返回空结果（旧 loadRecords 口径），不当作“records 缺失”
  if (!rows.length) return { points: [], total_seconds: 0, stride: 1 };

  const stride = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out = [];
  for (let i = 0; i < rows.length; i += stride) {
    const r = rows[i];
    out.push({
      t: r.timestamp,
      power: r.power,
      heart_rate: r.heart_rate,
      cadence: r.cadence,
      altitude: r.altitude,
      speed: r.speed,
      distance_m: r.distance,
      temperature: r.temperature,
    });
  }
  return { points: out, total_seconds: rows.length, stride };
}

/**
 * 从 records CSV 文本取首条数据行的时间戳（ISO UTC）。
 * 只扫到第二个换行为止（不 split 整篇——万行 CSV 没必要为一行付分配的代价）；
 * 表头之后没有完整数据行（空文件/被截断）返回 null。
 */
export function firstTimestampFromCsvHead(text) {
  if (!text) return null;
  const headEnd = text.indexOf("\n");
  if (headEnd < 0) return null;
  const lineEnd = text.indexOf("\n", headEnd + 1);
  const first =
    text.slice(headEnd + 1, lineEnd < 0 ? undefined : lineEnd).split(",")[0]?.trim() ?? "";
  // 末行可能缺换行（文件未以 \n 收尾），因此不要求有第二个换行；但时间戳必须形状完整
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first) ? first : null;
}

/** 读 records 文件头两行取首帧时间戳；文件不存在/损坏返回 null */
export function readRecordStartFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return firstTimestampFromCsvHead(buf.subarray(0, n).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响读取结果
      }
    }
  }
}

function recordsCsvPath(activityId, outputDir) {
  return path.join(outputDir, `${activityId}.records.csv`);
}

/** 全量读取某活动的逐秒记录（records 缺失/损坏返回 null） */
export function loadAllRecords(activityId, { outputDir } = {}) {
  if (!isActivityUuid(activityId) || !outputDir) return null;
  const csvPath = recordsCsvPath(activityId, outputDir);
  if (!fs.existsSync(csvPath)) return null;
  try {
    const records = parseRecordsCsv(fs.readFileSync(csvPath, "utf8"));
    return records.length ? records : null;
  } catch {
    return null;
  }
}

/**
 * 解析 records CSV → 抽稀后的时序数组（null 表示缺口）。
 * 只接受 uuid——v3 起旧文件基名已由布局迁移复制为 uuid 基名。
 */
export function loadRecords(activityId, { outputDir, maxPoints = 1400, startSec, endSec } = {}) {
  const records = loadAllRecords(activityId, { outputDir });
  if (!records) return null;
  return thinRecords(records, { maxPoints, startSec, endSec });
}

/** 首帧时间戳（起骑时刻，ISO UTC；records 缺失/损坏返回 null） */
export function readRecordStart(activityId, { outputDir } = {}) {
  if (!isActivityUuid(activityId) || !outputDir) return null;
  return readRecordStartFromFile(recordsCsvPath(activityId, outputDir));
}

/**
 * 写 records CSV（临时文件 + rename，避免详情页/AI 工具读到半截文件）。
 * 仅接受 uuid；调用方已把记录整理成 1 秒网格形状。
 */
export function writeRecordsCsv(activityId, records, { outputDir } = {}) {
  if (!isActivityUuid(activityId) || !outputDir) throw new Error("invalid records identity");
  const lines = (records ?? []).map((r) =>
    [
      r.timestamp,
      r.power,
      r.heart_rate,
      r.cadence,
      r.altitude,
      r.speed,
      r.distance,
      r.temperature,
    ]
      .map((v) => (v == null ? "" : v))
      .join(","),
  );
  fs.mkdirSync(outputDir, { recursive: true });
  const target = recordsCsvPath(activityId, outputDir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${RECORDS_HEADER}\n${lines.join("\n")}`);
  fs.renameSync(tmp, target);
  return target;
}

/** 删除某活动的 records 文件（不存在不报错） */
export function deleteRecordFile(activityId, { outputDir } = {}) {
  if (!isActivityUuid(activityId) || !outputDir) return false;
  const target = recordsCsvPath(activityId, outputDir);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}

/** 复制 records 文件（合并重复用；目标已存在则不覆盖，返回是否复制） */
export function copyRecordFile(fromUuid, toUuid, { outputDir } = {}) {
  if (!isActivityUuid(fromUuid) || !isActivityUuid(toUuid) || !outputDir) return false;
  const src = recordsCsvPath(fromUuid, outputDir);
  const dst = recordsCsvPath(toUuid, outputDir);
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  fs.copyFileSync(src, dst);
  return true;
}
