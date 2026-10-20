/**
 * memory.test.mjs — 短期记忆失效判定（自 VoltCoach test/dossier.test.mjs 的
 * memory 段回同步）
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_SHORT_MAX_AGE_DAYS,
  MEMORY_SHORT_MAX_NEW_ACTIVITIES,
  isShortMemoryExpired,
  parseSqliteUtc,
} from "../src/memory.js";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const sqliteUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

test("parseSqliteUtc：SQLite UTC 文本与 ISO T 分隔符均可解析，非法返回 null", () => {
  assert.equal(parseSqliteUtc("2026-10-20 12:00:00"), NOW);
  assert.equal(parseSqliteUtc("2026-10-20T12:00:00"), NOW);
  assert.equal(parseSqliteUtc("2026-10-20T12:00:00Z"), null);
  assert.equal(parseSqliteUtc("bad"), null);
});

test("长期/legacy 记忆永不过期；缺 created_at 保守不过期", () => {
  assert.equal(isShortMemoryExpired({ scope: "long", created_at: "2000-01-01 00:00:00" }, NOW, []), false);
  assert.equal(isShortMemoryExpired({ scope: null, created_at: "2000-01-01 00:00:00" }, NOW, []), false);
  assert.equal(isShortMemoryExpired({ scope: "short", created_at: null }, NOW, []), false);
  assert.equal(isShortMemoryExpired({ scope: "short", created_at: "bad" }, NOW, []), false);
});

test("短期记忆：严格超过 14 天失效，恰好 14 天不失效", () => {
  const exactly14 = sqliteUtc(NOW - MEMORY_SHORT_MAX_AGE_DAYS * 86400000);
  const over14 = sqliteUtc(NOW - (MEMORY_SHORT_MAX_AGE_DAYS * 86400000 + 1000));
  assert.equal(isShortMemoryExpired({ scope: "short", created_at: exactly14 }, NOW, []), false);
  assert.equal(isShortMemoryExpired({ scope: "short", created_at: over14 }, NOW, []), true);
});

test("短期记忆：写入后新增 ≥5 次训练失效，4 次不失效（按 created_at 字符串比较）", () => {
  const created = "2026-10-19 12:00:00";
  const four = ["2026-10-19 13:00:00", "2026-10-19 14:00:00", "2026-10-19 15:00:00", "2026-10-19 16:00:00"];
  const five = [...four, "2026-10-19 17:00:00"];
  assert.equal(isShortMemoryExpired({ scope: "short", created_at: created }, NOW, four), false);
  assert.equal(isShortMemoryExpired({ scope: "short", created_at: created }, NOW, five), true);
});

test("短期记忆：时间与训练次数任一先到即失效", () => {
  const created = "2026-10-01 12:00:00";
  assert.equal(
    isShortMemoryExpired(
      { scope: "short", created_at: created },
      NOW,
      Array.from({ length: MEMORY_SHORT_MAX_NEW_ACTIVITIES }, (_, i) => `2026-10-02 0${i}:00:00`),
    ),
    true,
  );
});
