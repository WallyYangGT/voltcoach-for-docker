/**
 * db.js
 * 训练库（SQLite，node:sqlite 内置模块，零第三方依赖；schema v3）：
 *   - 每次分析后把 summary 入库：活动 uuid 是对外身份（32 位 hex），file_name
 *     仅为来源元数据（可同名并存）；去重决策在导入管线（src/dedupe.js），
 *     本层提供 insertActivity / updateActivitySummary
 *   - 开库自动跑编号迁移（src/migrations.js，v1/v2 → v3）、恢复外键约束，并做
 *     records 布局迁移 + 室内指纹回填（src/records-layout.js）
 *   - 基于历史 TSS 计算 CTL / ATL / TSB（体能/疲劳/状态）
 *   - 月汇总、趋势数据与提示词上下文查询（recentActivities / recentFormDaily）
 *   - settings 表：骑手参数（athlete）、AI 服务配置（ai）与用户背景/训练目标（profile）
 *     持久化，Web 设置页维护；
 *     syncAthleteFromDb() / syncAiConfigFromDb() 把库值原地合并进 settings.js 的
 *     ATHLETE / AI_CONFIG 导出对象；migrateAiEnvToDb() 负责老版本 FIT_AI_*
 *     环境变量的一次性迁入（迁移后 env 被完全忽略）
 *   - activities.note 列：用户在详情页填写的训练备注（体感/路况等），
 *     getActivitySummary() 合并进 summary.activity.note，AI 复盘提示词纳入考量
 *   - ai_chats / ai_chat_messages 表：AI 对话持久化（报告追问 follow_up 与
 *     直接对话 chat），assistant 消息沿用 pending/completed/failed 状态机，
 *     每 mode 滚动保留最近 50 个对话（清理时级联删除消息）
 *   - ai_memories 表：AI 记忆（带时间戳与取代链 superseded_by——同主题新事实
 *     覆盖旧事实；scope=short 短期记忆按 14 天/5 次训练失效（src/memory.js），
 *     category=strategy 进权威段；库中最多 100 条滚动清理，注入全部有效记忆
 *     （≤100，短期过期的在注入前过滤）；用户可在记忆页删除）
 *   - 新增 v2 能力：power_flagged 功率可信度标记、settings dossier 档案缓存、
 *     ai_reports/ai_chats 的 uuid 外键 + 指纹（删除置 NULL、重导入按指纹重挂）
 *
 * 数据库文件固定为 ./db/fitness.db（可用环境变量 FIT_DB_PATH 覆盖，供测试隔离），
 * 不存在时自动创建。
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ATHLETE,
  AI_CONFIG,
  FACTORY_FTP_WATTS,
  FTP_ESTIMATION,
} from "./settings.js";
import { normalizeLang, t, formNote } from "./i18n.js";
import { migrateSchema } from "./migrations.js";
import { isActivityUuid, newActivityUuid } from "./identity.js";
import { buildDossier } from "./dossier.js";
import { isShortMemoryExpired } from "./memory.js";
import { isFtpCalibratedFrom } from "./ftp.js";
import { ensureRecordFileLayout } from "./records-layout.js";

export const DB_PATH = process.env.FIT_DB_PATH || path.resolve("db", "fitness.db");

let _db = null;
let _layoutDone = false;

/** records 目录（与 server.js/tools.js 同一环境变量口径，测试隔离用） */
function outputDir() {
  return path.resolve(process.env.FIT_OUTPUT_DIR || "output");
}

/**
 * 懒打开数据库：目录/文件/表不存在时自动创建；存量库走编号步进迁移
 * （v1/v2 → v3），随后恢复外键约束并做 records 布局迁移。
 *
 * 迁移失败时关闭句柄并抛错——不能把半初始化的连接留成单例。
 */
function runLayoutOnce() {
  if (_layoutDone || !_db) return;
  try {
    const result = ensureRecordFileLayout(_db, outputDir());
    // 输出目录尚未挂载时 ensure 会返回 skipped：不能置 done，下次开库继续重试
    if (!result?.skipped) _layoutDone = true;
  } catch (e) {
    console.warn(`records 布局迁移失败（下次开库重试）: ${e.message}`);
  }
}

function openDb() {
  if (_db) {
    runLayoutOnce(); // 上次布局迁移失败时重试
    return _db;
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  try {
    migrateSchema(db, { dbPath: DB_PATH });
    // 外键按连接生效：每次开库都要重新打开（迁移内部会临时关闭）
    db.exec(`PRAGMA foreign_keys = ON;`);
  } catch (e) {
    try {
      db.close();
    } catch {
      // 迁移失败时关闭失败无额外信息
    }
    throw e;
  }
  _db = db;
  // records 布局迁移失败只告警（下次 openDb 重试），不影响训练库可用性
  runLayoutOnce();
  return _db;
}

/** 关闭数据库句柄（测试清理临时库文件前调用；生产路径无需调用） */
export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
    _layoutDone = false;
  }
}

// ---------------- 骑手参数（存 settings 表，Web 设置页维护） ----------------

/**
 * 从训练库读取 athlete 行并原地覆盖 settings.js 的 ATHLETE 导出对象。
 * 库中无 athlete 行时保持 settings.js 出厂默认值。
 * index.js（analyzeFile / main）与 server.js 启动时调用，
 * 利用"导出对象属性可变"让所有读 ATHLETE 的模块看到最新值。
 */
export function syncAthleteFromDb() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'athlete'`).get();
  if (!row) return;
  try {
    Object.assign(ATHLETE, JSON.parse(row.value));
  } catch {
    // 行内容损坏时忽略，保持默认值
  }
}

/** 读 settings 行并 JSON.parse（无行/损坏返回 null） */
function readSettingJson(db, key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/** 当前骑手参数状态：生效值（库行覆盖默认值）+ 是否已在库中配置 +
 *  FTP 是否已校准（§35：溯源戳或当前值≠出厂默认 106W） */
export function getAthleteState() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'athlete'`).get();
  const athlete = { ...ATHLETE };
  if (row) {
    try {
      Object.assign(athlete, JSON.parse(row.value));
    } catch {
      // 行内容损坏时按未配置之外的默认值返回
    }
  }
  const hasAiUpdate = !!readSettingJson(db, "ai_ftp_update");
  const ftp_calibrated = isFtpCalibratedFrom(
    Number(athlete.ftp_watts),
    athlete.ftp_updated_at,
    FACTORY_FTP_WATTS,
    { source: athlete.ftp_source ?? null, hasAiUpdate },
  );
  return { athlete, configured: !!row, ftp_calibrated };
}

/**
 * FTP 是否已校准（与 get_athlete_profile 的 athlete_configured 同源）：
 * 有溯源戳（曾发生实际变更）或当前值≠出厂默认值。只改过体重/最大心率的用户
 * 仍判未校准——不用默认 FTP 算出的 IF 冒充真实强度。
 */
export function isFtpCalibrated() {
  return getAthleteState().ftp_calibrated;
}

/** 最近一次 AI 更新 FTP 的撤销快照（settings `ai_ftp_update`，无则 null） */
export function getAiFtpUpdate() {
  return readSettingJson(openDb(), "ai_ftp_update");
}

/** 写入/清除 AI 更新 FTP 的撤销快照（null 删除行） */
export function setAiFtpUpdate(snapshot) {
  const db = openDb();
  if (snapshot == null) {
    db.prepare(`DELETE FROM settings WHERE key = 'ai_ftp_update'`).run();
    return;
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai_ftp_update', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(snapshot));
}

// 骑手参数合法范围（FTP 上下限复用 FTP_ESTIMATION 的采纳写回口径）
const ATHLETE_LIMITS = {
  ftp_watts: [FTP_ESTIMATION.apply_min_w, FTP_ESTIMATION.apply_max_w],
  max_hr: [120, 230],
  weight_kg: [30, 200],
};

/**
 * 更新骑手参数（允许只给部分字段）：校验 → 合并当前值写库 → 原地生效。
 * 非法值抛 Error（message 按 lang 双语，Web API 直接透传给前端）。
 */
export function setAthlete(partial, lang = "zh", opts = null) {
  const updates = {};
  for (const key of Object.keys(ATHLETE_LIMITS)) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    const [lo, hi] = ATHLETE_LIMITS[key];
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw new Error(t(lang, "athlete.range", { key, lo, hi }));
    updates[key] = v;
  }
  if (!Object.keys(updates).length)
    throw new Error(t(lang, "athlete.none"));
  // opts.source：FTP 值实际变更时在 athlete JSON 上盖溯源戳（ftp_updated_at/ftp_source），
  // 供「AI 已代为更新」的追溯（自 VoltCoach 同步）；扩展字段经 syncAthleteFromDb 的
  // Object.assign 天然保活（不加列、不动表结构）
  const merged = { ...ATHLETE, ...updates };
  const ftpChanged = updates.ftp_watts != null && updates.ftp_watts !== ATHLETE.ftp_watts;
  if (ftpChanged) {
    if (opts?.stamps) {
      // 撤销 AI 更新时恢复撤销前的溯源戳（null 表示原本无戳，删键而非写 null）
      if (opts.stamps.ftp_updated_at == null) delete merged.ftp_updated_at;
      else merged.ftp_updated_at = opts.stamps.ftp_updated_at;
      if (opts.stamps.ftp_source == null) delete merged.ftp_source;
      else merged.ftp_source = opts.stamps.ftp_source;
    } else {
      merged.ftp_updated_at = new Date().toISOString();
      merged.ftp_source = opts?.source ?? "manual";
    }
  }
  const db = openDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(merged));
  Object.assign(ATHLETE, merged); // 原地生效，当前进程无需重启
  if (ftpChanged) rebuildDossierQuietly(); // FTP 是档案缓存指纹成分，立即对齐
  return { ...ATHLETE };
}

/** 读 FTP 溯源戳（athlete 行 JSON 的扩展字段；无行/损坏/旧数据返回全 null，自 VoltCoach 同步） */
export function getFtpMeta() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'athlete'`).get();
  if (!row) return { updated_at: null, source: null };
  try {
    const p = JSON.parse(row.value);
    return {
      updated_at: typeof p.ftp_updated_at === "string" ? p.ftp_updated_at : null,
      source: p.ftp_source ?? null,
    };
  } catch {
    return { updated_at: null, source: null };
  }
}

// ---------------- AI 服务配置（存 settings 表，Web 设置页维护） ----------------

/**
 * 从训练库读取 ai 行并原地覆盖 settings.js 的 AI_CONFIG 导出对象。
 * 库中无 ai 行时保持 settings.js 出厂默认值（默认 Kimi，api_key 为空）。
 * server.js 启动时调用；setAiConfig() 保存后也会原地生效。
 */
export function syncAiConfigFromDb() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get();
  if (!row) return;
  try {
    Object.assign(AI_CONFIG, JSON.parse(row.value));
  } catch {
    // 行内容损坏时忽略，保持默认值
  }
}

/** 当前 AI 配置状态：生效值（库行覆盖默认值）+ 是否已配置密钥 */
export function getAiConfig() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get();
  const config = { ...AI_CONFIG };
  if (row) {
    try {
      Object.assign(config, JSON.parse(row.value));
    } catch {
      // 行内容损坏时按默认值返回
    }
  }
  return { config, configured: Boolean(config.api_key) };
}

/**
 * 更新 AI 服务配置（允许只给部分字段）：校验 → 合并当前值写库 → 原地生效。
 * 非法值抛 Error（message 按 lang 双语，Web API 直接透传给前端）。
 * api_key 传空字符串表示清除密钥（退化为复制提示词模式）。
 */
export function setAiConfig(partial, lang = "zh") {
  const updates = {};
  if (partial?.api_key != null) {
    if (typeof partial.api_key !== "string")
      throw new Error(t(lang, "ai.key_type"));
    updates.api_key = partial.api_key.trim() || null;
  }
  if (partial?.base_url != null) {
    const u = String(partial.base_url).trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(u)) throw new Error(t(lang, "ai.base_url"));
    updates.base_url = u;
  }
  if (partial?.model != null) {
    const m = String(partial.model).trim();
    if (!m) throw new Error(t(lang, "ai.model"));
    updates.model = m;
  }
  if (partial?.temperature !== undefined) {
    if (partial.temperature === null || partial.temperature === "") {
      updates.temperature = null; // 不传 temperature，用 API 默认
    } else {
      const t = Number(partial.temperature);
      if (!Number.isFinite(t) || t < 0 || t > 2)
        throw new Error(t(lang, "ai.temperature"));
      updates.temperature = t;
    }
  }
  for (const key of ["timeout_ms", "stall_ms"]) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    if (!Number.isFinite(v) || v < 1000)
      throw new Error(t(lang, "ai.ms", { key }));
    updates[key] = Math.round(v);
  }
  if (partial?.stream != null) updates.stream = Boolean(partial.stream);
  if (partial?.agentic != null) updates.agentic = Boolean(partial.agentic);
  if (!Object.keys(updates).length)
    throw new Error(t(lang, "ai.none"));
  const merged = { ...AI_CONFIG, ...updates };
  const db = openDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('ai', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(merged));
  Object.assign(AI_CONFIG, merged); // 原地生效，当前进程无需重启
  return { ...AI_CONFIG };
}

/**
 * 一次性迁移：老版本用 FIT_AI_* 环境变量配置 AI，若库中尚无 ai 行而
 * 环境里存在 FIT_AI_API_KEY，则把它迁入训练库（server.js 入口在
 * process.loadEnvFile() 之后调用一次）。迁移后环境变量被完全忽略。
 */
export function migrateAiEnvToDb() {
  const key = process.env.FIT_AI_API_KEY;
  if (!key) return false;
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get();
  if (row) return false; // 库里已有配置，以库为准
  const num = (name) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  };
  const fromEnv = {
    api_key: key,
    base_url: process.env.FIT_AI_BASE_URL || undefined,
    model: process.env.FIT_AI_MODEL || undefined,
    temperature:
      process.env.FIT_AI_TEMPERATURE != null
        ? Number(process.env.FIT_AI_TEMPERATURE)
        : undefined,
    timeout_ms: num("FIT_AI_TIMEOUT_MS"),
    stream:
      process.env.FIT_AI_STREAM != null
        ? process.env.FIT_AI_STREAM === "true" || process.env.FIT_AI_STREAM === "1"
        : undefined,
    stall_ms: num("FIT_AI_STALL_MS"),
  };
  // 清掉 undefined 后复用 setAiConfig 的校验与写库路径
  const clean = Object.fromEntries(Object.entries(fromEnv).filter(([, v]) => v !== undefined));
  setAiConfig(clean);
  return true;
}

const VALID_CATEGORIES = new Set(["training", "race", "recovery", "leisure"]);
const CATEGORY_LABEL = {
  training: "训练",
  race: "比赛",
  recovery: "恢复",
  leisure: "休闲",
};

/** 校验训练分类是否合法 */
export function isValidCategory(category) {
  return VALID_CATEGORIES.has(category);
}

/** 返回分类的中文名，未知时返回原值 */
export function categoryLabel(category) {
  return CATEGORY_LABEL[category] ?? category ?? "训练";
}

/**
 * 更新训练分类（训练/比赛/恢复/休闲）。
 * identifier 优先按 uuid 解析，兼容旧 file_name 深链。
 * 非法值或训练不存在时抛 Error（message 按 lang 双语，Web API 直接透传给前端）。
 */
export function setActivityCategory(identifier, category, lang = "zh") {
  if (!isValidCategory(category)) throw new Error(t(lang, "category.invalid"));
  const uuid = resolveActivityUuid(identifier);
  if (!uuid) throw new Error(t(lang, "activity.not_found"));
  const db = openDb();
  db.prepare(`UPDATE activities SET category = ? WHERE uuid = ?`).run(category, uuid);
  return { ok: true, uuid };
}

/** 获取训练分类，未设置时默认训练（identifier 可为 uuid 或旧 file_name） */
export function getActivityCategory(identifier) {
  const uuid = resolveActivityUuid(identifier);
  if (!uuid) return "training";
  const db = openDb();
  const row = db.prepare(`SELECT category FROM activities WHERE uuid = ?`).get(uuid);
  return row?.category ?? "training";
}

// 备注长度上限（自由文本：体感/路况等），防止误贴大段内容撑爆训练库与提示词
const NOTE_MAX_LEN = 2000;

/**
 * 更新训练备注（用户自由注释，AI 复盘时纳入考量）。
 * 传空字符串/纯空白表示清除备注；训练不存在时抛 Error（Web API 直接透传给前端）。
 */
export function setActivityNote(identifier, note, lang = "zh") {
  const text = String(note ?? "").trim();
  if (text.length > NOTE_MAX_LEN)
    throw new Error(t(lang, "note.too_long", { n: NOTE_MAX_LEN }));
  const uuid = resolveActivityUuid(identifier);
  if (!uuid) throw new Error(t(lang, "activity.not_found"));
  const db = openDb();
  db.prepare(`UPDATE activities SET note = ? WHERE uuid = ?`).run(text || null, uuid);
  return { ok: true, uuid, note: text || null };
}

/** 标记/取消「功率不可信」（可逆；被标记骑行从档案功率基线排除） */
export function setActivityPowerFlag(identifier, flagged, lang = "zh") {
  const uuid = resolveActivityUuid(identifier);
  if (!uuid) throw new Error(t(lang, "activity.not_found"));
  const db = openDb();
  db.prepare(`UPDATE activities SET power_flagged = ? WHERE uuid = ?`).run(
    flagged ? 1 : 0,
    uuid,
  );
  return { ok: true, uuid, flagged: !!flagged };
}

/** 读取「功率不可信」标记（identifier 可为 uuid 或旧 file_name） */
export function getActivityPowerFlag(identifier) {
  const uuid = resolveActivityUuid(identifier);
  if (!uuid) return false;
  const db = openDb();
  return !!db.prepare(`SELECT power_flagged FROM activities WHERE uuid = ?`).get(uuid)
    ?.power_flagged;
}

// ---------------- 用户背景与训练目标（存 settings 表 profile 行，Web 设置页维护） ----------------

// 各字段长度上限：身份一句话、目标一段话
const PROFILE_LIMITS = { identity: 100, goal: 500 };

/** 当前用户背景与训练目标：{ identity, goal, configured }；未配置时两字段为空字符串 */
export function getProfile() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'profile'`).get();
  let profile = { identity: "", goal: "" };
  if (row) {
    try {
      const p = JSON.parse(row.value);
      profile = {
        identity: typeof p.identity === "string" ? p.identity : "",
        goal: typeof p.goal === "string" ? p.goal : "",
      };
    } catch {
      // 行内容损坏时按未配置返回
    }
  }
  return { ...profile, configured: !!(profile.identity || profile.goal) };
}

/**
 * 更新用户背景与训练目标（允许只给部分字段）：校验 → 合并写库。
 * 两字段都为空时删除 profile 行（视为未配置）。非法值抛 Error（Web API 直接透传）。
 */
export function setProfile(partial, lang = "zh") {
  const current = getProfile();
  const merged = { identity: current.identity, goal: current.goal };
  for (const key of Object.keys(PROFILE_LIMITS)) {
    if (partial?.[key] == null) continue;
    if (typeof partial[key] !== "string")
      throw new Error(t(lang, "profile.type", { key }));
    const v = partial[key].trim();
    if (v.length > PROFILE_LIMITS[key])
      throw new Error(t(lang, "profile.too_long", { key, n: PROFILE_LIMITS[key] }));
    merged[key] = v;
  }
  const db = openDb();
  if (!merged.identity && !merged.goal) {
    db.prepare(`DELETE FROM settings WHERE key = 'profile'`).run();
  } else {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(merged));
  }
  return { ...merged, configured: !!(merged.identity || merged.goal) };
}

/**
 * 报告上下文的身份归一化：优先 uuid；旧调用方传 file_name/compare_with 时回退解析。
 * v3 起落库只存 uuid + 指纹，file_name 仅用于展示（JOIN 读取）。
 */
function normalizeReportContext(context) {
  // resolveActivityUuid 对 uuid 会做存在性校验，避免失效 uuid 触发外键错误
  const activity_uuid =
    resolveActivityUuid(context?.activity_uuid) ??
    resolveActivityUuid(context?.file_name);
  const compare_uuid =
    resolveActivityUuid(context?.compare_uuid) ??
    resolveActivityUuid(context?.compare_with);
  return {
    activity_uuid: activity_uuid ?? null,
    compare_uuid: compare_uuid ?? null,
    race_date: context?.race_date ?? null,
  };
}

/** 插入报告行；指纹由 uuid 子查询取自 activities（活动不存在则为 NULL） */
function insertReportRow(mode, context, prompt, markdown, status) {
  const db = openDb();
  const c = normalizeReportContext(context);
  const info = db
    .prepare(
      `INSERT INTO ai_reports
         (mode, activity_uuid, race_date, compare_uuid, activity_fingerprint,
          compare_fingerprint, prompt, markdown, status)
       VALUES (?, ?, ?, ?,
         (SELECT fingerprint FROM activities WHERE uuid = ?),
         (SELECT fingerprint FROM activities WHERE uuid = ?),
         ?, ?, ?)`,
    )
    .run(
      mode,
      c.activity_uuid,
      c.race_date,
      c.compare_uuid,
      c.activity_uuid,
      c.compare_uuid,
      prompt ?? "",
      markdown ?? "",
      status,
    );
  return Number(info.lastInsertRowid);
}

/** 保存 AI 分析报告；每个 mode 仅保留最近 30 条 */
export function saveAiReport(mode, context, prompt, markdown) {
  const id = insertReportRow(mode, context, prompt, markdown, "completed");
  // 每个 mode 仅保留最近 30 条（用 id DESC，自增主键严格反映插入顺序，不受 created_at 秒级精度影响）
  const db = openDb();
  db.prepare(
    `DELETE FROM ai_reports
     WHERE id NOT IN (
       SELECT id FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT 30
     ) AND mode = ?`,
  ).run(mode, mode);
  return id;
}

/** 创建一个 status = pending 的 AI 报告占位记录，用于后台生成时前端可见进度 */
export function createPendingAiReport(mode, context, prompt) {
  const id = insertReportRow(mode, context, prompt, "", "pending");
  // 同样受 30 条滚动限制；pending 占位也参与计数
  const db = openDb();
  db.prepare(
    `DELETE FROM ai_reports
     WHERE id NOT IN (
       SELECT id FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT 30
     ) AND mode = ?`,
  ).run(mode, mode);
  return id;
}

/** 更新 AI 报告（后台生成成功/失败时回填） */
export function updateAiReport(id, { markdown, status, error } = {}) {
  const db = openDb();
  db.prepare(
    `UPDATE ai_reports
     SET markdown = COALESCE(?, markdown),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(markdown ?? null, status ?? null, error ?? null, id);
}

/** 报告行 → 接口形状：uuid 为身份，file_name/compare_with 为 JOIN 后的展示别名 */
function mapReportRow(r) {
  return {
    id: r.id,
    mode: r.mode,
    activity_uuid: r.activity_uuid ?? null,
    compare_uuid: r.compare_uuid ?? null,
    activity_file_name: r.activity_file_name ?? null,
    compare_file_name: r.compare_file_name ?? null,
    // 旧前端字段（展示用）；活动被删后为 null
    file_name: r.activity_file_name ?? null,
    compare_with: r.compare_file_name ?? null,
    race_date: r.race_date,
    activity_fingerprint: r.activity_fingerprint ?? null,
    compare_fingerprint: r.compare_fingerprint ?? null,
    status: r.status,
    error: r.error,
    created_at: r.created_at,
    // 只有「曾引用活动、现 uuid 为空」才算训练已删除；plan/taper 报告本就没有活动
    activity_deleted:
      r.activity_uuid == null &&
      !!(r.activity_fingerprint || r.compare_fingerprint),
  };
}

/** 列出某 mode 的最近 N 条报告（默认 30）；LEFT JOIN 活动取展示文件名 */
export function listAiReports(mode, n = 30) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT r.id, r.mode, r.activity_uuid, r.compare_uuid, r.race_date,
              r.activity_fingerprint, r.compare_fingerprint,
              r.status, r.error, r.created_at,
              a.file_name AS activity_file_name,
              ca.file_name AS compare_file_name
       FROM ai_reports r
       LEFT JOIN activities a ON a.uuid = r.activity_uuid
       LEFT JOIN activities ca ON ca.uuid = r.compare_uuid
       WHERE r.mode = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(mode, n);
  return rows.map(mapReportRow);
}

/** 按 id 取单条完整报告（含 prompt + markdown + status + error），不存在返回 null */
export function getAiReport(id) {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT r.*, a.file_name AS activity_file_name,
              ca.file_name AS compare_file_name
       FROM ai_reports r
       LEFT JOIN activities a ON a.uuid = r.activity_uuid
       LEFT JOIN activities ca ON ca.uuid = r.compare_uuid
       WHERE r.id = ?`,
    )
    .get(id);
  if (!row) return null;
  return {
    ...mapReportRow(row),
    prompt: row.prompt,
    markdown: row.markdown,
  };
}

// ---------------- AI 对话（ai_chats / ai_chat_messages，追问与直接对话统一） ----------------

// 每个 mode 滚动保留的对话数上限（沿用 ai_reports 的 id DESC LIMIT 清理模式）
const AI_CHAT_KEEP = 50;

/**
 * 创建 AI 对话（mode: follow_up 报告追问 / chat 直接对话），返回 id。
 * 每个 mode 仅保留最近 50 个对话，超出的旧对话连同其全部消息一起删除。
 */
export function createAiChat(mode, { report_id, activity_uuid, file_name, title } = {}) {
  const db = openDb();
  // 对 uuid 也做存在性校验；失效 uuid 回退旧文件名，避免外键错误
  const uuid =
    resolveActivityUuid(activity_uuid) ?? resolveActivityUuid(file_name);
  // 报告可能已被滚动清理：悬空 report_id 置 NULL（外键 ON DELETE SET NULL 同口径），
  // 不让"继续追问一份已清理的报告"直接 500
  let rid = report_id ?? null;
  if (rid != null && !db.prepare(`SELECT 1 AS ok FROM ai_reports WHERE id = ?`).get(rid))
    rid = null;
  const info = db
    .prepare(
      `INSERT INTO ai_chats
         (mode, report_id, activity_uuid, activity_fingerprint, title)
       VALUES (?, ?, ?,
         (SELECT fingerprint FROM activities WHERE uuid = ?), ?)`,
    )
    .run(mode, rid, uuid ?? null, uuid ?? null, title ?? null);
  // 滚动清理：先删被挤出对话的消息，再删对话本身（级联）
  db.prepare(
    `DELETE FROM ai_chat_messages WHERE chat_id IN (
       SELECT id FROM ai_chats WHERE mode = ? AND id NOT IN (
         SELECT id FROM ai_chats WHERE mode = ? ORDER BY id DESC LIMIT ?
       )
     )`,
  ).run(mode, mode, AI_CHAT_KEEP);
  db.prepare(
    `DELETE FROM ai_chats
     WHERE id NOT IN (
       SELECT id FROM ai_chats WHERE mode = ? ORDER BY id DESC LIMIT ?
     ) AND mode = ?`,
  ).run(mode, AI_CHAT_KEEP, mode);
  return Number(info.lastInsertRowid);
}

/** 追加一条对话消息（assistant 可用 status='pending' 占位），返回消息 id */
export function addAiChatMessage(chatId, role, content, status = "completed") {
  const db = openDb();
  const info = db
    .prepare(
      `INSERT INTO ai_chat_messages (chat_id, role, content, status) VALUES (?, ?, ?, ?)`,
    )
    .run(chatId, role, String(content ?? ""), status);
  return Number(info.lastInsertRowid);
}

/** 更新对话消息（后台生成成功/失败时回填，COALESCE 模式同 updateAiReport） */
export function updateAiChatMessage(id, { content, status, error } = {}) {
  const db = openDb();
  db.prepare(
    `UPDATE ai_chat_messages
     SET content = COALESCE(?, content),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(content ?? null, status ?? null, error ?? null, id);
}

/** 有新消息时刷新对话的 updated_at（列表按它倒序，最近活跃的对话排前） */
export function touchAiChat(chatId) {
  const db = openDb();
  db.prepare(`UPDATE ai_chats SET updated_at = datetime('now') WHERE id = ?`).run(chatId);
}

/**
 * 某 mode 的对话列表（按 updated_at 倒序），附消息条数与是否有 pending 消息的
 * 聚合字段（供列表态显示"生成中"标记），不含消息正文。
 */
export function listAiChats(mode, n = AI_CHAT_KEEP) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.mode, c.report_id, c.activity_uuid, c.activity_fingerprint,
              c.title, c.created_at, c.updated_at,
              a.file_name AS activity_file_name,
              (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) AS message_count,
              EXISTS(SELECT 1 FROM ai_chat_messages m
                     WHERE m.chat_id = c.id AND m.status = 'pending') AS has_pending
       FROM ai_chats c
       LEFT JOIN activities a ON a.uuid = c.activity_uuid
       WHERE c.mode = ?
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    )
    .all(mode, n);
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    report_id: r.report_id,
    activity_uuid: r.activity_uuid ?? null,
    activity_fingerprint: r.activity_fingerprint ?? null,
    activity_file_name: r.activity_file_name ?? null,
    file_name: r.activity_file_name ?? null, // 旧前端展示别名
    title: r.title,
    message_count: r.message_count,
    has_pending: !!r.has_pending,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** 按 id 取对话元信息 + 全部消息（按 id 升序），不存在返回 null */
export function getAiChat(id) {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT c.*, a.file_name AS activity_file_name
       FROM ai_chats c
       LEFT JOIN activities a ON a.uuid = c.activity_uuid
       WHERE c.id = ?`,
    )
    .get(id);
  if (!row) return null;
  const messages = db
    .prepare(
      `SELECT id, role, content, status, error, created_at
       FROM ai_chat_messages WHERE chat_id = ? ORDER BY id`,
    )
    .all(id);
  return {
    id: row.id,
    mode: row.mode,
    report_id: row.report_id,
    activity_uuid: row.activity_uuid ?? null,
    activity_fingerprint: row.activity_fingerprint ?? null,
    activity_file_name: row.activity_file_name ?? null,
    file_name: row.activity_file_name ?? null, // 旧前端展示别名
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    messages,
  };
}

/** 该报告最新的 follow_up 对话 id（报告详情页追问"继续既有对话"用），没有返回 null */
export function findFollowUpChat(reportId) {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id FROM ai_chats WHERE mode = 'follow_up' AND report_id = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(reportId);
  return row?.id ?? null;
}

/** 删除整个对话及其全部消息，返回删除的对话数（0 = 不存在，供 server 判 404） */
export function deleteAiChat(id) {
  const db = openDb();
  db.prepare(`DELETE FROM ai_chat_messages WHERE chat_id = ?`).run(id);
  const info = db.prepare(`DELETE FROM ai_chats WHERE id = ?`).run(id);
  return info.changes;
}

// ---------------- AI 记忆（ai_memories，带时间戳与取代链） ----------------

// 记忆分类白名单（非法值归入 general）；strategy = 与用户商定的训练策略（权威段）
const MEMORY_CATEGORIES = new Set([
  "general",
  "injury",
  "schedule",
  "goal",
  "preference",
  "strategy",
]);
// 记忆分层：short 短期（注入时按 14 天/5 次训练过滤），long 默认长期
const MEMORY_SCOPES = new Set(["short", "long"]);
// 单条记忆长度上限（AI 用中文概括的完整陈述）
const MEMORY_MAX_LEN = 500;
// 库中最多保留条数：超出先删最旧的已被取代记忆，不足再删最旧有效记忆
const MEMORY_KEEP = 100;

/**
 * 保存一条 AI 记忆（用户个人事实：伤病/日程约束/目标变化/明确偏好等），返回 id。
 * content 必填且 ≤500 字；category 非法归 general；supersedes_id 存在时校验目标
 * 记忆存在，并把其 superseded_by 置为新 id（被取代的记忆不再注入但保留可追溯）。
 * 非法输入抛 Error（中文 message，工具层转为 {error} JSON 反馈给 AI）。
 */
export function saveMemory(
  { content, category, source, scope, supersedes_id } = {},
  lang = "zh",
) {
  const text = String(content ?? "").trim();
  if (!text) throw new Error(t(lang, "memory.empty"));
  if (text.length > MEMORY_MAX_LEN)
    throw new Error(t(lang, "memory.too_long", { n: MEMORY_MAX_LEN }));
  const cat = MEMORY_CATEGORIES.has(category) ? category : "general";
  // scope 缺省长期；显式非法值拒绝（与 category 的"非法归 general"不同——
  // 分层影响注入时效，静默猜测会把长期事实错当短期丢掉）
  if (scope != null && !MEMORY_SCOPES.has(scope))
    throw new Error(t(lang, "memory.scope_invalid"));
  const memScope = scope ?? "long";
  const db = openDb();
  let supersedeId = null;
  if (supersedes_id != null) {
    supersedeId = Number(supersedes_id);
    const target = db.prepare(`SELECT id FROM ai_memories WHERE id = ?`).get(supersedeId);
    if (!target)
      throw new Error(t(lang, "memory.supersede_not_found", { id: supersedes_id }));
  }
  const info = db
    .prepare(
      `INSERT INTO ai_memories (content, category, source, scope) VALUES (?, ?, ?, ?)`,
    )
    .run(text, cat, source ?? null, memScope);
  const id = Number(info.lastInsertRowid);
  if (supersedeId != null) {
    db.prepare(`UPDATE ai_memories SET superseded_by = ? WHERE id = ?`).run(id, supersedeId);
  }
  // 滚动清理：最多保留 100 条，先删最旧的已被取代记忆，不足再删最旧有效记忆
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ai_memories`).get().c;
  if (total > MEMORY_KEEP) {
    let excess = total - MEMORY_KEEP;
    const del = db
      .prepare(
        `DELETE FROM ai_memories WHERE id IN (
           SELECT id FROM ai_memories WHERE superseded_by IS NOT NULL ORDER BY id LIMIT ?
         )`,
      )
      .run(excess);
    excess -= del.changes;
    if (excess > 0) {
      db.prepare(
        `DELETE FROM ai_memories WHERE id IN (
           SELECT id FROM ai_memories ORDER BY id LIMIT ?
         )`,
      ).run(excess);
    }
  }
  return id;
}

/** 全部活动的入库时刻（短期记忆"新增 5 次训练"判据；SQLite UTC 文本） */
export function listActivityCreatedAts() {
  const db = openDb();
  return db
    .prepare(`SELECT created_at FROM activities ORDER BY id ASC`)
    .all()
    .map((r) => r.created_at)
    .filter((v) => typeof v === "string" && v);
}

/**
 * 全部有效记忆（未被取代），短期已失效的在注入前过滤；id DESC，拼装时反转为
 * 时间正序。上限 100（库内滚动保留量），不再只取最近 30 条——策略类记忆必须
 * 有机会进入权威段。失效判定单源在 src/memory.js。
 */
export function listMemories(n = MEMORY_KEEP) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, content, category, source, scope, created_at
       FROM ai_memories WHERE superseded_by IS NULL
       ORDER BY id DESC`,
    )
    .all();
  const activityCreatedAts = listActivityCreatedAts();
  const now = Date.now();
  return rows
    .filter((m) => !isShortMemoryExpired(m, now, activityCreatedAts))
    .slice(0, n);
}

/** 全部记忆（含已被取代的，管理界面用；id DESC，附 active / expired 标记） */
export function listAllMemories() {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, content, category, source, scope, created_at, superseded_by
       FROM ai_memories ORDER BY id DESC`,
    )
    .all();
  const activityCreatedAts = listActivityCreatedAts();
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    active: r.superseded_by == null,
    expired: isShortMemoryExpired(r, now, activityCreatedAts),
  }));
}

/** 删除指定记忆，返回删除条数（0 = 不存在，供 server 判 404） */
export function deleteMemory(id) {
  const db = openDb();
  return db.prepare(`DELETE FROM ai_memories WHERE id = ?`).run(id).changes;
}

// ---------------- 活动（v3：uuid 是对外身份，file_name 仅来源元数据） ----------------

/** summary → activities 行镜像列（v3 起插入/更新共用同一投影） */
function activityRowValues(summary) {
  const a = summary?.activity ?? {};
  const p = summary?.power ?? {}; // 无功率数据的运动（跑步/游泳）没有 power 段
  return {
    date: a.date,
    sport: a.sport ?? null,
    duration_sec: a.duration_sec ?? null,
    distance_km: a.distance_km ?? null,
    elevation_gain_m: a.elevation_gain_m ?? null,
    tss: p.tss ?? null,
    np: p.normalized_power ?? null,
    avg_power: p.avg ?? null,
    intensity_factor: p.intensity_factor ?? null,
    summary_json: JSON.stringify(summary),
  };
}

/** 新活动入库（uuid 由本层生成；去重决策在 services/index.js 导入管线） */
export function insertActivity({ fileName, fingerprint = "", source = "import", summary }) {
  const db = openDb();
  const uuid = newActivityUuid();
  const v = activityRowValues(summary);
  db.prepare(
    `INSERT INTO activities
       (uuid, file_name, source, fingerprint, date, sport, duration_sec, distance_km,
        elevation_gain_m, tss, np, avg_power, intensity_factor, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuid,
    fileName,
    source ?? null,
    fingerprint,
    v.date,
    v.sport,
    v.duration_sec,
    v.distance_km,
    v.elevation_gain_m,
    v.tss,
    v.np,
    v.avg_power,
    v.intensity_factor,
    v.summary_json,
  );
  return uuid;
}

/**
 * 按 uuid 更新已有活动的分析结果（保留 uuid/created_at/category/note/power_flagged）。
 * fingerprint 传 null 时保持原值。
 */
export function updateActivitySummary(uuid, summary, { fingerprint = null } = {}) {
  if (!isActivityUuid(uuid)) throw new Error(t("zh", "activity.not_found"));
  const db = openDb();
  const v = activityRowValues(summary);
  const info = db
    .prepare(
      `UPDATE activities SET
         date = ?, sport = ?, duration_sec = ?, distance_km = ?, elevation_gain_m = ?,
         tss = ?, np = ?, avg_power = ?, intensity_factor = ?, summary_json = ?,
         fingerprint = COALESCE(?, fingerprint)
       WHERE uuid = ?`,
    )
    .run(
      v.date,
      v.sport,
      v.duration_sec,
      v.distance_km,
      v.elevation_gain_m,
      v.tss,
      v.np,
      v.avg_power,
      v.intensity_factor,
      v.summary_json,
      fingerprint,
      uuid,
    );
  if (info.changes === 0) throw new Error(t("zh", "activity.not_found"));
  return { ok: true, uuid };
}

/** 活动总数（档案缓存指纹成分） */
export function countActivities() {
  return Number(openDb().prepare(`SELECT COUNT(*) AS c FROM activities`).get().c ?? 0);
}

/**
 * 身份解析：uuid 精确校验存在；旧 file_name 回退取最新入库行（v2 深链兼容）。
 * 非法/不存在返回 null。
 */
export function resolveActivityUuid(identifier) {
  if (identifier == null) return null;
  const db = openDb();
  if (isActivityUuid(identifier)) {
    const row = db.prepare(`SELECT uuid FROM activities WHERE uuid = ?`).get(identifier);
    return row?.uuid ?? null;
  }
  if (typeof identifier !== "string" || !identifier) return null;
  const row = db
    .prepare(`SELECT uuid FROM activities WHERE file_name = ? ORDER BY id DESC LIMIT 1`)
    .get(identifier);
  return row?.uuid ?? null;
}

/** 取活动的来源文件名（展示用；uuid 不存在返回 null） */
export function getActivityFileName(uuid) {
  if (!isActivityUuid(uuid)) return null;
  return openDb().prepare(`SELECT file_name FROM activities WHERE uuid = ?`).get(uuid)
    ?.file_name ?? null;
}

/**
 * 去重/重复检查所需的全部骑行键（id ASC：最早入库在前，合并时天然作为保留方）。
 * 含 category/note/power_flagged 供合并时接管用户数据。
 */
export function listActivityRideKeys() {
  return openDb()
    .prepare(
      `SELECT id, uuid, file_name, fingerprint, date, sport, duration_sec, distance_km,
              category, note, power_flagged
       FROM activities ORDER BY id ASC`,
    )
    .all()
    .map((r) => ({ ...r, power_flagged: !!r.power_flagged }));
}

/**
 * 删除活动：先把活动 fingerprint 补写到仍引用它的报告/对话（外键随后把 uuid
 * 置 NULL），再删行。AI 报告/对话本身保留（孤儿策略）。records 文件由调用方删。
 * @returns {{ok:boolean, uuid:string, file_name:string, fingerprint:string}|null}
 */
export function deleteActivity(uuid) {
  if (!isActivityUuid(uuid)) return null;
  const db = openDb();
  const row = db
    .prepare(`SELECT uuid, file_name, fingerprint FROM activities WHERE uuid = ?`)
    .get(uuid);
  if (!row) return null;
  db.exec("BEGIN;");
  try {
    db.prepare(`UPDATE ai_reports SET activity_fingerprint = ? WHERE activity_uuid = ?`).run(
      row.fingerprint,
      uuid,
    );
    db.prepare(`UPDATE ai_reports SET compare_fingerprint = ? WHERE compare_uuid = ?`).run(
      row.fingerprint,
      uuid,
    );
    db.prepare(`UPDATE ai_chats SET activity_fingerprint = ? WHERE activity_uuid = ?`).run(
      row.fingerprint,
      uuid,
    );
    db.prepare(`DELETE FROM activities WHERE uuid = ?`).run(uuid);
    db.exec("COMMIT;");
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // 无活动事务时忽略
    }
    throw e;
  }
  return { ok: true, uuid: row.uuid, file_name: row.file_name, fingerprint: row.fingerprint };
}

/**
 * 孤儿报告/对话重挂：按精确内容指纹把 uuid 为空且指纹匹配的引用挂到新活动。
 * 一个事务内更新报告主引用、对比引用与对话引用。
 */
export function reattachOrphanRefs(fingerprint, uuid) {
  if (!fingerprint || !isActivityUuid(uuid)) return 0;
  const db = openDb();
  db.exec("BEGIN;");
  try {
    let changed = 0;
    changed += db
      .prepare(
        `UPDATE ai_reports SET activity_uuid = ?
         WHERE activity_uuid IS NULL AND activity_fingerprint = ?`,
      )
      .run(uuid, fingerprint).changes;
    changed += db
      .prepare(
        `UPDATE ai_reports SET compare_uuid = ?
         WHERE compare_uuid IS NULL AND compare_fingerprint = ?`,
      )
      .run(uuid, fingerprint).changes;
    changed += db
      .prepare(
        `UPDATE ai_chats SET activity_uuid = ?
         WHERE activity_uuid IS NULL AND activity_fingerprint = ?`,
      )
      .run(uuid, fingerprint).changes;
    db.exec("COMMIT;");
    return changed;
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // 无活动事务时忽略
    }
    throw e;
  }
}

/**
 * 合并重复活动（保留最早入库的 keep，删除 drop）：
 * 用户数据接管（非默认分类/非空备注/功率标记 OR）→ 报告/对话引用重挂 + 指纹
 * 同步为 keep 的指纹 → 删副本，一个事务。records 复制/删除由调用方在事务外做。
 *
 * ⚠️ 本函数不做「是否同趟」校验（它看不到 records 首帧）：调用方必须先校验。
 * Web 合并接口在调用前用 `isSameRide`（室内补 start_at）做服务端守卫。
 */
export function mergeActivityRows(keepUuid, dropUuid) {
  if (!isActivityUuid(keepUuid) || !isActivityUuid(dropUuid) || keepUuid === dropUuid)
    throw new Error(t("zh", "activity.not_found"));
  const db = openDb();
  const keep = db.prepare(`SELECT * FROM activities WHERE uuid = ?`).get(keepUuid);
  const drop = db.prepare(`SELECT * FROM activities WHERE uuid = ?`).get(dropUuid);
  if (!keep || !drop) throw new Error(t("zh", "activity.not_found"));

  const category =
    keep.category && keep.category !== "training"
      ? keep.category
      : drop.category && drop.category !== "training"
        ? drop.category
        : "training";
  const note = (keep.note && keep.note.trim()) || (drop.note ?? null);
  const powerFlagged = keep.power_flagged || drop.power_flagged ? 1 : 0;
  const fingerprint = keep.fingerprint || drop.fingerprint || "";

  db.exec("BEGIN;");
  try {
    db.prepare(
      `UPDATE activities SET category = ?, note = ?, power_flagged = ?,
         fingerprint = CASE WHEN fingerprint = '' THEN ? ELSE fingerprint END
       WHERE uuid = ?`,
    ).run(category, note, powerFlagged, fingerprint, keepUuid);
    let reportsMoved = 0;
    reportsMoved += db
      .prepare(
        `UPDATE ai_reports SET activity_uuid = ?, activity_fingerprint = ? WHERE activity_uuid = ?`,
      )
      .run(keepUuid, fingerprint, dropUuid).changes;
    reportsMoved += db
      .prepare(
        `UPDATE ai_reports SET compare_uuid = ?, compare_fingerprint = ? WHERE compare_uuid = ?`,
      )
      .run(keepUuid, fingerprint, dropUuid).changes;
    db.prepare(
      `UPDATE ai_chats SET activity_uuid = ?, activity_fingerprint = ? WHERE activity_uuid = ?`,
    ).run(keepUuid, fingerprint, dropUuid);
    db.prepare(`DELETE FROM activities WHERE uuid = ?`).run(dropUuid);
    db.exec("COMMIT;");
    return { ok: true, keep_uuid: keepUuid, drop_uuid: dropUuid, reports_moved: reportsMoved };
  } catch (e) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // 无活动事务时忽略
    }
    throw e;
  }
}

/** 取出 [起始, endDate] 范围内逐日 TSS（按天聚合，缺天补 0）→ [{ date, tss }] */
function dailyTssSeries(endDate) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, SUM(COALESCE(tss, 0)) AS tss
       FROM activities WHERE date <= ? GROUP BY date ORDER BY date`,
    )
    .all(endDate);
  if (!rows.length) return [];
  // 补齐缺天（TSS = 0，休息日同样参与 CTL/ATL 衰减）
  const series = [];
  const byDate = new Map(rows.map((r) => [r.date, r.tss]));
  const cur = new Date(rows[0].date + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    series.push({ date: d, tss: byDate.get(d) ?? 0 });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return series;
}

/**
 * CTL / ATL / TSB（指数加权，口径与 TrainingPeaks 一致）：
 *   CTL_d = CTL_{d-1} + (TSS_d − CTL_{d-1}) / 42   慢性负荷（体能）
 *   ATL_d = ATL_{d-1} + (TSS_d − ATL_{d-1}) / 7    急性负荷（疲劳）
 *   TSB   = CTL − ATL                              状态（正值=新鲜）
 * 初始值 0，计算到 date 当天（含）。
 * 返回 form_state（枚举：fresh/good/balanced/fatigued/overtrained，语言中立，
 * 供界面/AI 按语言渲染）与 form_note（按 lang 生成的简评文本）。
 */
export function computeForm(date, lang = "zh") {
  const series = dailyTssSeries(date);
  if (!series.length) return null;
  let ctl = 0,
    atl = 0;
  for (const d of series) {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
  }
  const tsb = ctl - atl;
  const r1 = (x) => Math.round(x * 10) / 10;
  const state = tsb >= 15 ? "fresh" : tsb >= 5 ? "good" : tsb >= -10 ? "balanced" : tsb >= -20 ? "fatigued" : "overtrained";
  return {
    ctl: r1(ctl),
    atl: r1(atl),
    tsb: r1(tsb),
    form_state: state,
    form_note: formNote(tsb, lang),
  };
}

/**
 * 最近 N 天逐日负荷序列：[{ date, tss, ctl, atl, tsb }]。
 * 与 computeForm 同一递推口径，供周期规划/赛前调整提示词取走势数据。
 * 序列末端延伸到当前实际日期（无训练日 TSS=0 照常参与 CTL/ATL 衰减），
 * 这样趋势图与"当前体能指数"反映今天，而不是停在最后一次训练的日期。
 */
export function recentFormDaily(days = 56) {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  // 活动日期为 UTC 口径（records 时间戳的 ISO 前 10 位），今天同样取 UTC
  const today = new Date().toISOString().slice(0, 10);
  const series = dailyTssSeries(row.d < today ? today : row.d);
  let ctl = 0,
    atl = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const daily = series.map((d) => {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    return { date: d.date, tss: r1(d.tss), ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) };
  });
  return daily.slice(-days);
}

/** 训练清单（uuid 是列表 key/路由身份；file_name 仅展示），按日期倒序 */
export function listActivities(n = 200) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT uuid, file_name, date, sport, category, duration_sec, distance_km,
              elevation_gain_m, tss, np, avg_power, intensity_factor, power_flagged
       FROM activities ORDER BY date DESC, id DESC LIMIT ?`,
    )
    .all(n);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    uuid: r.uuid,
    activity_id: r.uuid, // 工具/前端通用别名（与 App 端 activity_id 口径一致）
    file_name: r.file_name,
    date: r.date,
    sport: r.sport,
    category: r.category ?? "training",
    duration_sec: r.duration_sec,
    distance_km: r1(r.distance_km),
    elevation_gain_m: r.elevation_gain_m == null ? null : Math.round(r.elevation_gain_m),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    avg_power: r.avg_power == null ? null : Math.round(r.avg_power),
    intensity_factor: r.intensity_factor == null ? null : r1(r.intensity_factor),
    power_flagged: !!r.power_flagged,
  }));
}

/**
 * 按 uuid（或旧 file_name）取单条训练的完整 summary JSON（Web 详情页用）。
 * category/note/power_flagged 是 activities 列属数据，读取时合并回 summary.activity。
 */
export function getActivitySummary(identifier) {
  const uuid = resolveActivityUuid(identifier);
  if (!uuid) return null;
  const db = openDb();
  const row = db
    .prepare(
      `SELECT summary_json, category, note, power_flagged FROM activities WHERE uuid = ?`,
    )
    .get(uuid);
  if (!row) return null;
  try {
    const summary = JSON.parse(row.summary_json);
    if (summary?.activity) {
      if (row.category) summary.activity.category = row.category;
      if (row.note) summary.activity.note = row.note; // 用户备注（体感/路况等），AI 复盘时纳入考量
      summary.activity.power_flagged = !!row.power_flagged;
    }
    return summary;
  } catch {
    return null;
  }
}

/**
 * 最近 n 条训练简明清单（供提示词上下文，按日期倒序）。
 * 除基础负荷字段外，从完整 summary 补充心率漂移/峰功率曲线/平均踏频（缺则省略）；
 * IF 保留 2 位小数——1 位小数会让 AI 用 NP/IF 反推 FTP 时产生 ±5W 级噪音。
 */
export function recentActivities(n = 10) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT uuid, date, duration_sec, distance_km, tss, np, intensity_factor, summary_json
       FROM activities ORDER BY date DESC, id DESC LIMIT ?`,
    )
    .all(n);
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return rows.map((r) => {
    const out = {
      activity_id: r.uuid,
      date: r.date,
      duration_min: r.duration_sec == null ? null : Math.round(r.duration_sec / 60),
      distance_km: r1(r.distance_km),
      tss: r.tss == null ? null : Math.round(r.tss),
      np: r.np == null ? null : Math.round(r.np),
      intensity_factor:
        r.intensity_factor == null ? null : r2(r.intensity_factor),
    };
    try {
      const s = JSON.parse(r.summary_json);
      if (s?.heart_rate?.hr_drift_pct != null)
        out.hr_drift_pct = r1(s.heart_rate.hr_drift_pct);
      if (s?.power?.peak_curve) out.peak_power_curve = s.power.peak_curve;
      if (s?.cadence?.avg != null) out.cadence_avg = s.cadence.avg;
    } catch {
      // summary_json 损坏时仅返回基础字段
    }
    return out;
  });
}

/**
 * 最近 N 天内的骑行训练完整 summary（FTP 历史估算用，按日期倒序）。
 * 仅返回 sport='cycling' 的记录；summary_json 损坏的行跳过。
 */
export function cyclingSummariesSince(days = 42) {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  const since = new Date(row.d + "T00:00:00Z");
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT uuid, file_name, date, duration_sec, power_flagged, summary_json
       FROM activities
       WHERE sport = 'cycling' AND date >= ?
       ORDER BY date DESC, id DESC`,
    )
    .all(sinceStr);
  const out = [];
  for (const r of rows) {
    try {
      out.push({
        uuid: r.uuid,
        activity_id: r.uuid,
        file_name: r.file_name,
        date: r.date,
        duration_sec: r.duration_sec,
        power_flagged: !!r.power_flagged,
        summary: JSON.parse(r.summary_json),
      });
    } catch {
      // 存档 JSON 损坏时跳过该条
    }
  }
  return out;
}

// ---------------- 个人训练档案（v2：确定性聚合 + settings 缓存） ----------------

const DOSSIER_CACHE_SHAPE = 2;

/** 档案聚合输入：全部活动行（含非骑行，buildDossier 自行过滤；日期升序） */
function loadDossierRides() {
  const db = openDb();
  return db
    .prepare(
      `SELECT uuid, file_name, date, sport, duration_sec, tss, power_flagged, summary_json
       FROM activities ORDER BY date ASC, id ASC`,
    )
    .all()
    .map((r) => {
      let summary = null;
      try {
        summary = JSON.parse(r.summary_json);
      } catch {
        // 损坏行按无 summary 处理（仍参与时长/骑行计数）
      }
      return {
        uuid: r.uuid,
        file_name: r.file_name,
        date: r.date,
        sport: r.sport,
        duration_sec: r.duration_sec,
        tss: r.tss,
        power_flagged: !!r.power_flagged,
        summary,
      };
    });
}

/** 全量重建档案并写缓存（指纹=活动总数+FTP；数据变更触发点显式调用） */
function rebuildDossier() {
  const db = openDb();
  const rides = loadDossierRides();
  const monthly = monthlySummary(6).map((m) => ({
    month: m.month,
    type: m.intensity_type,
  }));
  const dossier = buildDossier(rides, Number(ATHLETE.ftp_watts) || 0, monthly, new Date());
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('dossier', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(
    JSON.stringify({
      shape: DOSSIER_CACHE_SHAPE,
      dossier,
      fingerprint: { rides: rides.length, ftp: Number(ATHLETE.ftp_watts) || 0 },
    }),
  );
  return dossier;
}

/**
 * 个人训练档案（settings `dossier` 缓存）：指纹 = 活动总数 + 当前 FTP，匹配直接
 * 返回，miss 重建。导入/删除/合并/FTP 变更/功率标记/校准都调
 * rebuildDossierQuietly 强制刷新。
 */
export function getDossier() {
  const db = openDb();
  const cached = readSettingJson(db, "dossier");
  const rides = countActivities();
  const ftp = Number(ATHLETE.ftp_watts) || 0;
  if (
    cached?.shape === DOSSIER_CACHE_SHAPE &&
    Object.prototype.hasOwnProperty.call(cached, "dossier") &&
    cached?.fingerprint?.rides === rides &&
    cached?.fingerprint?.ftp === ftp
  )
    return cached.dossier ?? null;
  return rebuildDossier();
}

/** 档案重建的静默入口（fire-and-forget 语义；失败只告警，不影响主流程） */
export function rebuildDossierQuietly() {
  try {
    return rebuildDossier();
  } catch (e) {
    console.warn(`训练档案重建失败（下次读取时自愈）: ${e.message}`);
    return null;
  }
}

// ---------------- 界面语言（存 settings 表 lang 键，Web 前端检测/设置页切换） ----------------

/** 当前界面语言（zh/en，settings 表 lang 键；无配置回落 zh） */
export function getLang() {
  const db = openDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'lang'`).get();
  return row ? normalizeLang(row.value) : "zh";
}

/** 保存界面语言（仅认 zh/en，非法值抛 Error） */
export function setLang(lang) {
  const l = String(lang ?? "");
  if (l !== "zh" && l !== "en") throw new Error(t("zh", "srv.lang_invalid"));
  const db = openDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('lang', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(l);
  return l;
}

/**
 * 最近 n 个月汇总（按自然月）：
 * 月 TSS / 时长 / 距离 / 次数，以及 低(Z1-Z2)/中(Z3-Z4)/高(Z5-Z7) 强度时间占比与类型判读。
 */
export function monthlySummary(n = 6) {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT date, duration_sec, distance_km, tss, summary_json
       FROM activities ORDER BY date DESC`,
    )
    .all();

  const months = new Map();
  for (const r of rows) {
    const m = r.date.slice(0, 7); // YYYY-MM
    if (!months.has(m)) {
      months.set(m, {
        month: m,
        tss: 0,
        duration_sec: 0,
        distance_km: 0,
        count: 0,
        low: 0, // 各区加权秒数
        mid: 0,
        high: 0,
      });
    }
    const agg = months.get(m);
    const dur = r.duration_sec ?? 0;
    agg.tss += r.tss ?? 0;
    agg.duration_sec += dur;
    agg.distance_km += r.distance_km ?? 0;
    agg.count += 1;
    // 强度分布：zone_distribution_pct × 时长 加权累计
    try {
      const z = JSON.parse(r.summary_json).power?.zone_distribution_pct;
      if (z && dur > 0) {
        agg.low += ((z.Z1 ?? 0) + (z.Z2 ?? 0)) * 0.01 * dur;
        agg.mid += ((z.Z3 ?? 0) + (z.Z4 ?? 0)) * 0.01 * dur;
        agg.high += ((z.Z5 ?? 0) + (z.Z6 ?? 0) + (z.Z7 ?? 0)) * 0.01 * dur;
      }
    } catch {
      // 存档 JSON 损坏时跳过强度分布，不影响其他字段
    }
  }

  const result = [...months.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, n)
    .map((w) => {
      const zoneTotal = w.low + w.mid + w.high;
      const pct = (x) =>
        zoneTotal > 0 ? Math.round((x / zoneTotal) * 1000) / 10 : null;
      const lowPct = pct(w.low),
        midPct = pct(w.mid),
        highPct = pct(w.high);
      let intensity_type = null;
      if (lowPct != null) {
        // 极化：大量低强度 + 高强度多于中强度；金字塔：低>中>高；其余归为甜区/阈值取向
        if (lowPct >= 75 && highPct > midPct) intensity_type = "polarized";
        else if (lowPct > midPct && midPct > highPct)
          intensity_type = "pyramidal";
        else intensity_type = "sweet_spot";
      }
      return {
        month: w.month,
        tss: Math.round(w.tss),
        hours: Math.round((w.duration_sec / 3600) * 10) / 10,
        distance_km: Math.round(w.distance_km * 10) / 10,
        sessions: w.count,
        intensity_pct:
          lowPct != null ? { low: lowPct, mid: midPct, high: highPct } : null,
        intensity_type,
      };
    });
  return result;
}

/**
 * 逐月趋势：每月 { month, tss, ctl, atl, tsb }。
 * tss 为当月合计；ctl/atl/tsb 取该月最后一天的值（逐日递推得到，衰减口径不变）。
 */
export function trendMonthly() {
  const db = openDb();
  const row = db.prepare(`SELECT MAX(date) AS d FROM activities`).get();
  if (!row?.d) return [];
  const series = dailyTssSeries(row.d);
  let ctl = 0,
    atl = 0;
  const r1 = (x) => Math.round(x * 10) / 10;
  const months = new Map();
  for (const d of series) {
    ctl += (d.tss - ctl) / 42;
    atl += (d.tss - atl) / 7;
    const m = d.date.slice(0, 7);
    const agg = months.get(m) ?? { month: m, tss: 0 };
    agg.tss += d.tss;
    agg.ctl = r1(ctl); // 遍历按日期升序，月末值自然覆盖
    agg.atl = r1(atl);
    agg.tsb = r1(ctl - atl);
    months.set(m, agg);
  }
  return [...months.values()].map((m) => ({ ...m, tss: r1(m.tss) }));
}
