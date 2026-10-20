/**
 * reanalyze-scale.test.mjs — 功率校准系数（powerScale）重算口径：
 * NP/平均/峰值/峰曲线线性、TSS ∝ scale²、爬坡/圈均值线性、留痕继承与撤销。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rebuildSummaryFromRecords } from "../src/reanalyze.js";

const ATHLETE = { ftp_watts: 200, max_hr: 195, weight_kg: 60 };

function records(sec = 600, power = 200) {
  const out = [];
  for (let i = 0; i < sec; i++) {
    out.push({
      timestamp: new Date(Date.UTC(2026, 9, 1, 1, 0, i)).toISOString(),
      power,
      heart_rate: 150,
      cadence: 90,
      altitude: 100,
      speed: 30,
      distance: i * 8,
      temperature: 20,
    });
  }
  return out;
}

function prevSummary() {
  return {
    activity: { date: "2026-10-01", sport: "cycling", duration_sec: 600, distance_km: 4.8 },
    athlete_context: {},
    power: {
      avg: 200,
      normalized_power: 200,
      max: 200,
      variability_index: 1,
      intensity_factor: 1,
      tss: 17,
      w_per_kg_avg: 3.33,
      peak_curve: { "5s": 200, "1min": 200, "5min": 200 },
      zone_distribution_pct: { Z4: 100 },
    },
    heart_rate: { avg: 150, max: 150, zone_distribution_pct: { Z3: 100 }, hr_drift_pct: 0 },
    cadence: { avg: 90 },
    cadence_power: { style: "normal" },
    climbs: [{ name: "climb_1", avg_power: 200, avg_grade_pct: 5 }],
    segments: [{ name: "lap_1", duration_sec: 600, avg_power: 200, max_power: 220 }],
    anomalies: [],
  };
}

test("powerScale=1.2：NP/avg/max/峰曲线线性，TSS ∝ scale²，爬坡与圈均值线性", () => {
  const out = rebuildSummaryFromRecords(records(), prevSummary(), ATHLETE, {
    powerScale: 1.2,
  });
  assert.equal(out.power.normalized_power, 240);
  assert.equal(out.power.avg, 240);
  assert.equal(out.power.max, 240);
  assert.equal(out.power.peak_curve["5min"], 240);
  assert.equal(
    out.power.tss,
    Math.round((600 * 240 * 1.2) / (200 * 3600) * 100),
  );
  assert.equal(out.power.calibration_scale, 1.2);
  assert.equal(out.climbs[0].avg_power, 240);
  assert.equal(out.segments[0].avg_power, 240);
  assert.equal(out.segments[0].max_power, 264);
  // 心率通道不缩放
  assert.equal(out.heart_rate.avg, 150);
});

test("间歇/踏频阈值使用传入 athlete（不读全局默认 FTP）", () => {
  // 200W 恒定功率：传入 athlete FTP 200 → 间歇阈值 210W，不应识别出间歇；
  // 若误用全局 ATHLETE（106W→阈值 111W）会被错误识别为一段间歇。
  const out = rebuildSummaryFromRecords(records(), prevSummary(), ATHLETE);
  assert.equal(out.interval_set, undefined);
  assert.ok(!(out.segments ?? []).some((s) => String(s.name).startsWith("interval")));
});

test("无显式系数：继承 summary.power.calibration_scale 的持久口径", () => {
  const scaled = rebuildSummaryFromRecords(records(), prevSummary(), ATHLETE, {
    powerScale: 1.2,
  });
  const inherited = rebuildSummaryFromRecords(records(), scaled, ATHLETE);
  assert.equal(inherited.power.normalized_power, 240);
  assert.equal(inherited.power.calibration_scale, 1.2);
  // 爬坡/圈均值来自已缩放 prev，不能被二次缩放
  assert.equal(inherited.climbs[0].avg_power, 240);
  assert.equal(inherited.segments[0].avg_power, 240);
  assert.equal(inherited.segments[0].max_power, 264);
});

test("换系数（1.2 → 0.9）：爬坡/圈均值按新旧系数比换算，不重复缩放", () => {
  const scaled = rebuildSummaryFromRecords(records(), prevSummary(), ATHLETE, {
    powerScale: 1.2,
  });
  const changed = rebuildSummaryFromRecords(records(), scaled, ATHLETE, {
    powerScale: 0.9,
  });
  assert.equal(changed.power.normalized_power, 180);
  assert.equal(changed.power.calibration_scale, 0.9);
  assert.equal(changed.climbs[0].avg_power, 180);
  assert.equal(changed.segments[0].avg_power, 180);
  assert.equal(changed.segments[0].max_power, 198);
});

test("显式 scale=1：撤销校准，重算回未缩放值并清留痕", () => {
  const scaled = rebuildSummaryFromRecords(records(), prevSummary(), ATHLETE, {
    powerScale: 1.2,
  });
  const undo = rebuildSummaryFromRecords(records(), scaled, ATHLETE, {
    powerScale: 1,
  });
  assert.equal(undo.power.normalized_power, 200);
  assert.equal(undo.power.avg, 200);
  assert.equal(undo.power.tss, 17);
  assert.equal(undo.power.calibration_scale, undefined);
  assert.equal(undo.climbs[0].avg_power, 200);
});

test("非法显式系数（0/负/NaN）：按无操作处理，不猜、不写留痕", () => {
  for (const bad of [0, -1, NaN]) {
    const out = rebuildSummaryFromRecords(records(), prevSummary(), ATHLETE, {
      powerScale: bad,
    });
    assert.equal(out.power.normalized_power, 200);
    assert.equal(out.power.calibration_scale, undefined);
  }
});
