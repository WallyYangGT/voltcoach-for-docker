/**
 * backup-manifest.test.mjs — .fitbackup 清单校验与版本闸门
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_ERRORS,
  checkSchemaVersion,
  validateBackupManifest,
} from "../src/backup-manifest.js";

const valid = () => ({
  format: "fitbackup",
  schema_version: 3,
  app_version: "2.0.0",
  exported_at: "2026-10-20T00:00:00.000Z",
  device: "docker-web",
  db_key: null,
  counts: { activities: 2, records: 2 },
});

test("validateBackupManifest：合法清单通过（多余字段忽略）", () => {
  assert.equal(validateBackupManifest(valid()), null);
  assert.equal(validateBackupManifest({ ...valid(), extra: 1 }), null);
});

test("validateBackupManifest：格式/字段类型/计数非法 → bad_manifest", () => {
  for (const bad of [
    null,
    [],
    { ...valid(), format: "zip" },
    { ...valid(), schema_version: 0 },
    { ...valid(), schema_version: "3" },
    { ...valid(), app_version: 1 },
    { ...valid(), exported_at: "" },
    { ...valid(), device: null },
    { ...valid(), db_key: 123 },
    { ...valid(), counts: null },
    { ...valid(), counts: { activities: -1, records: 2 } },
    { ...valid(), counts: { activities: 2, records: 1.5 } },
  ]) {
    assert.equal(validateBackupManifest(bad), BACKUP_ERRORS.bad_manifest);
  }
});

test("checkSchemaVersion：包版本高于本机拒绝，低/等于放行", () => {
  assert.deepEqual(checkSchemaVersion(4, 3), {
    ok: false,
    error: BACKUP_ERRORS.unsupported_version,
  });
  assert.deepEqual(checkSchemaVersion(3, 3), { ok: true, error: null });
  assert.deepEqual(checkSchemaVersion(1, 3), { ok: true, error: null });
  assert.equal(checkSchemaVersion(0, 3).error, BACKUP_ERRORS.bad_manifest);
});
