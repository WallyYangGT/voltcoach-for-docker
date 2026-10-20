/**
 * schema.js — 训练库最新 schema 的整体建表脚本（纯字符串，无平台依赖；
 * 自 VoltCoach src/db/schema.ts 回同步）
 *
 * 新库（PRAGMA user_version = 0 且无表）直接按本脚本一次建齐；存量库走
 * ./migrations.js 的编号步进迁移。两者必须保持同源口径：本文件的列定义就是
 * 当前 SCHEMA_VERSION（v3）的权威形状。
 *
 * v3（decisions §34）：活动身份改为 `uuid`（对外唯一身份），`file_name` 降级为
 * 来源元数据（不再唯一）；AI 报告/对话改 uuid 外键（ON DELETE SET NULL，孤儿保留）；
 * 逐秒 records 以 uuid 命名。v2 的 `power_flagged` 与 `ai_memories.scope` 一并保留。
 */

/** 训练库 schema 版本（备份包 manifest.schema_version 与迁移链共用此口径） */
export const SCHEMA_VERSION = 3;

/** 活动表：整数 id 仅作内部插入序（合并重复按“最早入库”保留），uuid 是对外身份 */
const ACTIVITIES_SQL = `
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    source TEXT,
    fingerprint TEXT NOT NULL DEFAULT '',
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
    category TEXT DEFAULT 'training',
    note TEXT,
    power_flagged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);
  CREATE INDEX IF NOT EXISTS idx_activities_file_name ON activities(file_name);
  CREATE INDEX IF NOT EXISTS idx_activities_fingerprint ON activities(fingerprint);
`;

/** AI 报告：活动引用为 uuid 外键（删活动置 NULL，标题退化为“训练已删除”） */
const AI_REPORTS_SQL = `
  CREATE TABLE IF NOT EXISTS ai_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    activity_uuid TEXT REFERENCES activities(uuid) ON DELETE SET NULL,
    race_date TEXT,
    compare_uuid TEXT REFERENCES activities(uuid) ON DELETE SET NULL,
    activity_fingerprint TEXT,
    compare_fingerprint TEXT,
    prompt TEXT NOT NULL,
    markdown TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_reports_mode_activity ON ai_reports(mode, activity_uuid, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_reports_compare ON ai_reports(compare_uuid);
  CREATE INDEX IF NOT EXISTS idx_ai_reports_activity_fp ON ai_reports(activity_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_ai_reports_status ON ai_reports(status);
`;

const SETTINGS_SQL = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** AI 对话：report_id / activity_uuid 均为外键，被清理时置 NULL 而非删对话 */
const AI_CHATS_SQL = `
  CREATE TABLE IF NOT EXISTS ai_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    report_id INTEGER REFERENCES ai_reports(id) ON DELETE SET NULL,
    activity_uuid TEXT REFERENCES activities(uuid) ON DELETE SET NULL,
    activity_fingerprint TEXT,
    title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chats_mode ON ai_chats(mode, id DESC);
  CREATE INDEX IF NOT EXISTS idx_ai_chats_report ON ai_chats(report_id);
  CREATE INDEX IF NOT EXISTS idx_ai_chats_activity ON ai_chats(activity_uuid);
`;

const AI_CHAT_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, id);
`;

const AI_MEMORIES_SQL = `
  CREATE TABLE IF NOT EXISTS ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    source TEXT,
    scope TEXT NOT NULL DEFAULT 'long',
    created_at TEXT DEFAULT (datetime('now')),
    superseded_by INTEGER
  );
`;

/** 最新 schema 整体建表（全部 IF NOT EXISTS，可安全重复执行；仅用于全新库） */
export const CREATE_SCHEMA_SQL = [
  ACTIVITIES_SQL,
  AI_REPORTS_SQL,
  SETTINGS_SQL,
  AI_CHATS_SQL,
  AI_CHAT_MESSAGES_SQL,
  AI_MEMORIES_SQL,
].join("\n");

/**
 * v1/v2 崩溃残留的**空表补齐**脚本（历史列形状）。
 *
 * 存量库在迁移前不能执行 CREATE_SCHEMA_SQL——最新脚本里的 `idx_activities_fingerprint`
 * 与 `activity_uuid` 索引会在 v3 列创建前直接报 no such column。这里只按 v2 形状
 * 补建缺失的表（IF NOT EXISTS，已存在的表不受影响），交给随后的步进迁移统一升到 v3。
 * 仅使用于 user_version=0 且 activities 已存在、但结构仍是 v1 的残留库。
 */
export const CREATE_V2_COMPAT_SQL = `
  CREATE TABLE IF NOT EXISTS activities (
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
    category TEXT DEFAULT 'training',
    note TEXT,
    power_flagged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_reports (
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
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ai_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    report_id INTEGER,
    file_name TEXT,
    title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    source TEXT,
    scope TEXT NOT NULL DEFAULT 'long',
    created_at TEXT DEFAULT (datetime('now')),
    superseded_by INTEGER
  );
`;
