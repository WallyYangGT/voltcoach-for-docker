/**
 * dossier.test.mjs — 个人训练档案聚合（自 VoltCoach test/dossier.test.mjs 回同步）
 */

import test from "node:test";
import assert from "node:assert/strict";
import { addDaysStr, buildDossier, DOSSIER_WINDOW_DAYS } from "../src/dossier.js";

const NOW = new Date("2026-10-20T00:00:00.000Z");

function ride(over = {}) {
  const date = over.date ?? "2026-10-01";
  return {
    uuid: over.uuid ?? date.replaceAll("-", "").padEnd(32, "0"),
    file_name: `${date}.fit`,
    date,
    sport: "cycling",
    power_flagged: false,
    duration_sec: 3600,
    tss: 60,
    summary: {
      activity: { date, sport: "cycling", duration_sec: 3600, distance_km: 30 },
      power: {
        peak_curve: { "5s": 600, "1min": 400, "5min": 250, "20min": 200 },
        zone_distribution_pct: { Z1: 10, Z2: 50, Z3: 20, Z4: 15, Z5: 5 },
      },
      heart_rate: {
        zone_distribution_pct: { Z1: 20, Z2: 40, Z3: 20, Z4: 15, Z5: 5 },
        hr_drift_pct: 3,
      },
      climbs: [{ avg_grade_pct: 6, avg_power: 180, avg_hr: 150 }],
      cadence_power: { style: "normal" },
    },
    ...over,
  };
}

test("buildDossier：无骑行 → null；非骑行不参与", () => {
  assert.equal(buildDossier([], 200, [], NOW), null);
  assert.equal(buildDossier([ride({ sport: "running" })], 200, [], NOW), null);
});

test("buildDossier：锚最新骑行日，90 天窗外不进近 90 天基线", () => {
  const anchor = "2026-10-20";
  const inside = addDaysStr(anchor, -(DOSSIER_WINDOW_DAYS - 1));
  const outside = addDaysStr(anchor, -DOSSIER_WINDOW_DAYS);
  const d = buildDossier(
    [
      ride({ date: outside, summary: { ...ride().summary, power: { peak_curve: { "5min": 999 } } } }),
      ride({ date: inside, summary: { ...ride().summary, power: { peak_curve: { "5min": 300 } } } }),
      ride({ date: anchor, summary: { ...ride().summary, power: { peak_curve: { "5min": 280 } } } }),
    ],
    200,
    [],
    NOW,
  );
  assert.equal(d.anchor_date, anchor);
  assert.equal(d.peak_power.all_time[0].value_w, 999);
  assert.equal(d.peak_power.last_90d[0].value_w, 300);
  assert.equal(d.cycling.considered, 2);
});

test("buildDossier：power_flagged 从功率基线排除，但心率漂移/时长仍采信", () => {
  const d = buildDossier(
    [
      ride({ date: "2026-10-19", power_flagged: true, tss: 90 }),
      ride({ date: "2026-10-20" }),
    ],
    200,
    [],
    NOW,
  );
  assert.equal(d.cycling.considered, 1);
  assert.equal(d.cycling.flagged_excluded, 1);
  assert.equal(d.cycling.total_flagged, 1);
  assert.equal(d.peak_power.all_time[0].value_w, 600); // 被标记行的 600 不计入也不会更高
  assert.equal(d.load_shape.hr_drift.rides, 2); // 心率漂移含被标记行
  assert.equal(d.load_shape.weeks.at(-1).rides, 2); // 周骑行次数含被标记行
  assert.equal(d.load_shape.weeks.at(-1).tss, 60); // 周 TSS 剔除被标记行
});

test("buildDossier：功率不可用骑行进心率强度结构，功率可用行不进", () => {
  const d = buildDossier(
    [
      ride({ date: "2026-10-19", power_flagged: true }),
      ride({ date: "2026-10-20" }),
    ],
    200,
    [{ month: "2026-10", type: "pyramidal" }],
    NOW,
  );
  assert.ok(d.intensity_structure.zone_pct);
  assert.ok(d.intensity_structure.hr_zone_pct);
  assert.equal(d.intensity_structure.hr_zone_pct.Z1, 20);
  assert.deepEqual(d.intensity_structure.intensity_types, [
    { month: "2026-10", type: "pyramidal" },
  ]);
});

test("buildDossier：8 周窗口结束于锚日，周界连续", () => {
  const d = buildDossier([ride({ date: "2026-10-20" })], 200, [], NOW);
  assert.equal(d.load_shape.weeks.length, 8);
  assert.equal(d.load_shape.weeks.at(-1).end, "2026-10-20");
  assert.equal(d.load_shape.weeks.at(-1).start, "2026-10-14");
  assert.equal(d.load_shape.weeks[0].end, "2026-09-01");
});

test("addDaysStr：跨月/跨年", () => {
  assert.equal(addDaysStr("2026-08-31", 1), "2026-09-01");
  assert.equal(addDaysStr("2026-01-01", -1), "2025-12-31");
});
