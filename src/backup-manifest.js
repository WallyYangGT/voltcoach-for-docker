/**
 * backup-manifest.js — .fitbackup 清单校验与版本闸门（纯函数，自 VoltCoach
 * src/backup/manifest.ts 回同步）
 *
 * 旧仓只负责**导出** v3 包（新 App 导入）；本模块给导出侧做自检，并为未来
 * 可用的导入路径提供同一套稳定错误码。v3 起 manifest.schema_version=3，
 * 包内 records 以活动 uuid 命名。
 *
 * 闸门口径（主仓 voltcoach 的 docs/BACKUP_FORMAT.md）：
 *  - 包 schema_version **高于**本机支持版本 → unsupported_version（提示升级）；
 *  - 低于或等于 → 放行（由调用方在 staged 库上跑迁移链）。
 */

import { SCHEMA_VERSION } from "./schema.js";

/** 稳定错误码（与 App 端 BackupError 同名，便于两边文档/日志对账） */
export const BACKUP_ERRORS = {
  invalid_zip: "invalid_zip",
  missing_manifest: "missing_manifest",
  bad_manifest: "bad_manifest",
  unsupported_version: "unsupported_version",
  missing_db: "missing_db",
};

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const isNonNegativeInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * 校验 manifest 形状。合法返回 null，非法返回稳定错误码 `bad_manifest`。
 * 多余字段忽略（向前兼容）；字段缺失或类型不对一律拒绝。
 */
export function validateBackupManifest(manifest) {
  if (!isObject(manifest)) return BACKUP_ERRORS.bad_manifest;
  if (manifest.format !== "fitbackup") return BACKUP_ERRORS.bad_manifest;
  if (!Number.isInteger(manifest.schema_version) || manifest.schema_version < 1)
    return BACKUP_ERRORS.bad_manifest;
  if (typeof manifest.app_version !== "string") return BACKUP_ERRORS.bad_manifest;
  if (typeof manifest.exported_at !== "string" || !manifest.exported_at)
    return BACKUP_ERRORS.bad_manifest;
  if (typeof manifest.device !== "string" || !manifest.device)
    return BACKUP_ERRORS.bad_manifest;
  if (manifest.db_key !== null && typeof manifest.db_key !== "string")
    return BACKUP_ERRORS.bad_manifest;
  if (!isObject(manifest.counts)) return BACKUP_ERRORS.bad_manifest;
  if (!isNonNegativeInt(manifest.counts.activities)) return BACKUP_ERRORS.bad_manifest;
  if (!isNonNegativeInt(manifest.counts.records)) return BACKUP_ERRORS.bad_manifest;
  return null;
}

/**
 * 版本闸门：包版本高于本机支持版本 → 拒绝（unsupported_version）。
 * 低/等于放行；是否为 v3 包由调用方按 schema_version 判断 records 命名。
 */
export function checkSchemaVersion(packageVersion, currentVersion = SCHEMA_VERSION) {
  if (!Number.isInteger(packageVersion) || packageVersion < 1)
    return { ok: false, error: BACKUP_ERRORS.bad_manifest };
  if (packageVersion > currentVersion)
    return { ok: false, error: BACKUP_ERRORS.unsupported_version };
  return { ok: true, error: null };
}
