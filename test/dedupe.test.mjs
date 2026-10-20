/**
 * dedupe.test.mjs — 同趟骑行判定 / 内容指纹 / 导入决策（自 VoltCoach
 * test/dedupe.test.mjs 回同步）
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RIDE_DISTANCE_TOLERANCE_KM,
  RIDE_DURATION_TOLERANCE_SEC,
  decideImport,
  findDuplicateGroups,
  hasPositiveDistance,
  isSameRide,
  rideFingerprint,
} from "../src/dedupe.js";

const outdoor = (over = {}) => ({
  date: "2026-10-01",
  duration_sec: 3600,
  distance_km: 30,
  sport: "cycling",
  ...over,
});

test("isSameRide：户外同日同时长距离在容差内判同，超容差不判", () => {
  assert.equal(isSameRide(outdoor(), outdoor({ distance_km: 30 + RIDE_DISTANCE_TOLERANCE_KM })), true);
  assert.equal(isSameRide(outdoor(), outdoor({ distance_km: 30.06 })), false);
  assert.equal(
    isSameRide(outdoor(), outdoor({ duration_sec: 3600 + RIDE_DURATION_TOLERANCE_SEC })),
    true,
  );
  assert.equal(isSameRide(outdoor(), outdoor({ duration_sec: 3603 })), false);
  assert.equal(isSameRide(outdoor(), outdoor({ date: "2026-10-02" })), false);
});

test("isSameRide：室内（无有效距离/null/0）按起骑时刻 ±60s，sport 已知不同不判", () => {
  const indoor = (over = {}) => ({
    date: "2026-10-02",
    duration_sec: 2400,
    distance_km: null,
    sport: "cycling",
    start_at: "2026-10-02T01:00:00.000Z",
    ...over,
  });
  assert.equal(isSameRide(indoor(), indoor({ start_at: "2026-10-02T01:00:59.000Z" })), true);
  assert.equal(isSameRide(indoor(), indoor({ start_at: "2026-10-02T01:01:01.000Z" })), false);
  assert.equal(isSameRide(indoor({ distance_km: 0 }), indoor({ distance_km: null })), true);
  assert.equal(isSameRide(indoor(), indoor({ sport: "running" })), false);
  assert.equal(isSameRide(indoor({ sport: "unknown" }), indoor({ sport: "cycling" })), true);
  assert.equal(isSameRide(indoor(), indoor({ start_at: null })), false);
});

test("isSameRide：一侧有距离一侧无 → 保守不判", () => {
  assert.equal(isSameRide(outdoor(), outdoor({ distance_km: 0 })), false);
  assert.equal(isSameRide(outdoor(), outdoor({ distance_km: null })), false);
});

test("hasPositiveDistance：null/0/NaN 都不是有效距离", () => {
  assert.equal(hasPositiveDistance(0), false);
  assert.equal(hasPositiveDistance(null), false);
  assert.equal(hasPositiveDistance(NaN), false);
  assert.equal(hasPositiveDistance(0.001), true);
});

test("rideFingerprint：户外三段式；室内无有效距离追加首帧", () => {
  assert.equal(rideFingerprint(outdoor()), "2026-10-01|3600|30000");
  assert.equal(rideFingerprint(outdoor({ distance_km: 0 })), "2026-10-01|3600|");
  assert.equal(
    rideFingerprint({ ...outdoor({ distance_km: null }), start_at: "2026-10-01T01:00:00.000Z" }),
    "2026-10-01|3600||2026-10-01T01:00:00.000Z",
  );
});

test("decideImport：指纹精确 → 更新；同名同趟 → 更新；异名同趟 → 跳过", () => {
  const candidate = { ...outdoor(), file_name: "a.fit", fingerprint: "fp-a" };
  const rows = [
    { uuid: "u1", file_name: "old.fit", fingerprint: "fp-a", ...outdoor() },
    { uuid: "u2", file_name: "b.fit", fingerprint: "fp-b", ...outdoor({ distance_km: 31 }) },
  ];
  assert.deepEqual(decideImport(candidate, rows), { action: "update", uuid: "u1", file_name: "old.fit" });

  const sameName = [{ uuid: "u3", file_name: "a.fit", fingerprint: "other", ...outdoor() }];
  assert.deepEqual(decideImport(candidate, sameName), { action: "update", uuid: "u3", file_name: "a.fit" });

  const otherName = [{ uuid: "u4", file_name: "copy.fit", fingerprint: "other", ...outdoor() }];
  assert.deepEqual(decideImport(candidate, otherName), { action: "skip", uuid: "u4", file_name: "copy.fit" });
});

test("decideImport：同名但不同骑行 → 插入新行；无匹配 → 插入", () => {
  const candidate = { ...outdoor(), file_name: "a.fit", fingerprint: "fp-a" };
  const sameNameDifferent = [
    { uuid: "u5", file_name: "a.fit", fingerprint: "fp-old", ...outdoor({ distance_km: 40 }) },
  ];
  assert.deepEqual(decideImport(candidate, sameNameDifferent), { action: "insert" });
  assert.deepEqual(decideImport(candidate, []), { action: "insert" });
});

test("decideImport：同名多行时精确指纹优先", () => {
  const candidate = { ...outdoor(), file_name: "a.fit", fingerprint: "fp-new" };
  const rows = [
    { uuid: "u6", file_name: "a.fit", fingerprint: "fp-old", ...outdoor({ distance_km: 40 }) },
    { uuid: "u7", file_name: "a.fit", fingerprint: "fp-new", ...outdoor() },
  ];
  assert.deepEqual(decideImport(candidate, rows), { action: "update", uuid: "u7", file_name: "a.fit" });
});

test("findDuplicateGroups：只返回 ≥2 的组，支持链式相等", () => {
  const rows = [
    outdoor({ distance_km: 30 }),
    outdoor({ distance_km: 30.03 }),
    outdoor({ distance_km: 30.06 }),
    outdoor({ distance_km: 50 }),
    outdoor({ date: "2026-10-03" }),
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3);
});
