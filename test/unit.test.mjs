/**
 * unit.test.mjs
 * 指标算法纯函数的单元测试（node:test，零依赖）。
 * 运行：npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizedPower,
  peakAvg,
  fillShortGaps,
  zoneDistribution,
  elevationGain,
  findPowerGaps,
  findMissingSpans,
  detectPauseSpans,
  estimateFtp,
  detectIntervals,
  hrDriftPct,
  collectDeveloperFields,
  patchTruncatedFitHeader,
  pedalTimeBreakdown,
  detectStationarySpans,
} from "../index.js";
import {
  estimateFtpFromHistory,
  evaluateFtpApply,
  isFtpCalibratedFrom,
  selectFtpFromEstimate,
} from "../src/ftp.js";
import {
  compactSummaryForPrompt,
  localizeTimestamps,
  buildDateSection,
  buildReviewPrompt,
} from "../src/prompts.js";
import { simulateForm, generateWorkout } from "../src/planning.js";
import { formatAnomaly } from "../src/i18n.js";
import { ATHLETE, FORM_SIMULATION, WORKOUT_TEMPLATES, DATA_QUALITY } from "../src/settings.js";

// 构造逐秒记录对象的辅助函数
const rec = (i, fields = {}) => ({
  timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  power: null,
  heart_rate: null,
  cadence: null,
  altitude: null,
  speed: null,
  distance: null,
  ...fields,
});

test("normalizedPower: 恒定功率时 NP 等于该功率", () => {
  assert.equal(normalizedPower(Array(300).fill(200)), 200);
});

test("normalizedPower: 缺口窗口不参与计算", () => {
  // 中间一个 null：覆盖该秒的 30s 窗口被跳过，其余窗口仍为 200
  const arr = Array(300).fill(200);
  arr[150] = null;
  assert.equal(normalizedPower(arr), 200);
});

test("normalizedPower: 数据不足 30 秒返回 null", () => {
  assert.equal(normalizedPower(Array(29).fill(200)), null);
});

test("peakAvg: 递增序列取窗口最大值，要求窗口连续", () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(peakAvg(arr, 10), 96); // avg(91..100) = 95.5 → 96
  // 峰值窗口含 null 则该窗口被跳过：孤立尖峰被两个 null 夹住，
  // 任何覆盖尖峰的窗口都因不连续而被排除
  const withGap = Array(100).fill(100);
  withGap[45] = null;
  withGap[50] = 500;
  withGap[55] = null;
  assert.equal(peakAvg(withGap, 10), 100);
});

test("fillShortGaps: 短缺口按左右邻居线性插值", () => {
  const arr = [100, null, null, null, 160];
  assert.deepEqual(fillShortGaps(arr, 3), [100, 115, 130, 145, 160]);
  // 不改原数组
  assert.deepEqual(arr, [100, null, null, null, 160]);
});

test("fillShortGaps: 超长缺口与两端无邻居的 null 保持原样", () => {
  const longGap = [100, null, null, null, null, 200];
  assert.deepEqual(fillShortGaps(longGap, 3), longGap); // 4s 缺口 > 上限 3s
  const edges = [null, null, 100, 200, null];
  assert.deepEqual(fillShortGaps(edges, 10), edges); // 两端无邻居不补
});

test("fillShortGaps + peakAvg: 掉秒不再让 20min 峰功率整体作废", () => {
  // 1300 秒恒定 200W，中间掉 3 秒：原始序列无连续 20min 窗口，补齐后恢复
  const arr = Array(1300).fill(200);
  arr[600] = arr[601] = arr[602] = null;
  assert.equal(peakAvg(arr, 1200), null);
  assert.equal(peakAvg(fillShortGaps(arr, 10), 1200), 200);
});

test("zoneDistribution: 按基数比例分区并输出百分比", () => {
  const zones = [
    { name: "L", min: 0, max: 0.5 },
    { name: "H", min: 0.5, max: Infinity },
  ];
  assert.deepEqual(zoneDistribution([40, 60, null], zones, 100), {
    L: 50,
    H: 50,
  });
  assert.equal(zoneDistribution([null, null], zones, 100), null);
});

test("elevationGain: 1m 阈值去抖，小抖动不计爬升", () => {
  assert.equal(elevationGain([0, 0.4, 0.8, 1.2]), 1); // 累计 1.2m → 计 1.2 → 取整 1
  assert.equal(elevationGain([0, 0.3, 0, 0.3, 0]), 0); // 抖动被压掉
  // 100→110 计 10m，下降到 105 后 105→120 再计 15m，合计 25m
  assert.equal(elevationGain([null, 100, 110, 105, 120]), 25);
});

test("elevationGain: 滞回去抖按相邻增量累计，连续小步爬升不双计数", () => {
  // 5 步 × 0.2m = 1.0m 爬升：旧算法相对陈旧基线重复累计会虚报到 2.0m
  assert.equal(elevationGain([0, 0.2, 0.4, 0.6, 0.8, 1.0]), 1);
  // 长缓坡 50 步 × 0.2m = 10m：每满 1m 确认一次，合计恰为 10m
  const ramp = Array.from({ length: 51 }, (_, i) => 100 + i * 0.2);
  assert.equal(elevationGain(ramp), 10);
  // 平地上亚米级噪声（±0.2m 反复 600 秒）不产生爬升
  const flat = Array.from({ length: 600 }, (_, i) => (i % 2 ? 0.2 : -0.2));
  assert.equal(elevationGain(flat), 0);
});

test("detectPauseSpans: 静止恢复的间隙判为暂停，骑行中恢复仍为数据缺失", () => {
  // 200s：50-80s 全空（恢复后静止）→ 暂停；120-140s 全空（恢复时已在移动）→ 非暂停
  const records = [];
  for (let i = 0; i < 200; i++) {
    const empty = (i >= 50 && i < 80) || (i >= 120 && i < 140);
    records.push(
      rec(
        i,
        empty
          ? {}
          : { power: 200, heart_rate: 120, speed: i >= 80 && i < 140 ? 0 : 6 },
      ),
    );
  }
  const spans = detectPauseSpans(records, []);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 30);
  assert.equal(spans[0].start, records[50].timestamp);
});

test("detectPauseSpans: 距离冻结判为暂停（恢复即起步），距离跳变仍为数据缺失", () => {
  // 30-60s 全空且恢复后立即起步（速度 8），但设备累计距离在两侧几乎不动 → 暂停；
  // 90-100s 全空且距离按骑行速度跳变 80m → 数据缺失
  const records = [];
  for (let i = 0; i < 120; i++) {
    if ((i >= 30 && i < 60) || (i >= 90 && i < 100)) {
      records.push(rec(i));
      continue;
    }
    const dist = i < 30 ? i * 8 : i < 90 ? 240 + (i - 60) * 2 : 378 + (i - 100) * 8;
    records.push(rec(i, { power: 200, heart_rate: 120, speed: 8, distance: dist }));
  }
  const spans = detectPauseSpans(records, []);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, records[30].timestamp);
  assert.equal(spans[0].duration_sec, 30);
});

test("detectPauseSpans: FIT timer 事件 stop_all→start 区间判为暂停", () => {
  // 100s 记录，30-60s 全空且恢复时已在移动；但事件表明 28s 停表、62s 恢复计时
  const t0 = 1700000000000;
  const records = Array.from({ length: 100 }, (_, i) =>
    rec(i, i >= 30 && i < 60 ? {} : { power: 200, heart_rate: 120, speed: 6 }),
  );
  const events = [
    { event: "timer", event_type: "stop_all", timestamp: new Date(t0 + 28000) },
    { event: "timer", event_type: "start", timestamp: new Date(t0 + 62000) },
  ];
  const spans = detectPauseSpans(records, events);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 30);
  // 无事件时同一段恢复侧在移动 → 不判暂停
  assert.equal(detectPauseSpans(records, []).length, 0);
});

test("findPowerGaps: 只报告连续缺失超过阈值的片段", () => {
  const records = Array.from({ length: 200 }, (_, i) =>
    rec(i, { power: i >= 50 && i < 120 ? null : 200 }),
  );
  const gaps = findPowerGaps(records); // 默认 60s 阈值
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].duration_sec, 70);
  assert.equal(findPowerGaps(records, 80).length, 0);
});

test("findMissingSpans: 整条记录（全字段 null）缺失检测", () => {
  const records = Array.from({ length: 100 }, (_, i) =>
    i >= 30 && i < 45 ? rec(i) : rec(i, { power: 100, heart_rate: 120 }),
  );
  const spans = findMissingSpans(records, 10);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 15);
  // 阈值大于缺失时长则不报告
  assert.equal(findMissingSpans(records, 20).length, 0);
});

// 构造一个最小 FIT 头：headerSize + protocol + profile + data_size(uint32 LE) + ".FIT"
function fitHeader(dataSize, headerSize = 14) {
  const buf = Buffer.alloc(headerSize);
  buf[0] = headerSize;
  buf[1] = 0x10;
  buf.writeUInt16LE(2140, 2);
  buf.writeUInt32LE(dataSize, 4);
  buf.write(".FIT", 8, "ascii");
  return buf;
}

test("patchTruncatedFitHeader: 头声明长度超过实际字节数时改写为可用长度", () => {
  const content = Buffer.concat([fitHeader(1000), Buffer.alloc(500)]);
  const patched = patchTruncatedFitHeader(content);
  assert.ok(patched, "应返回修复后的 Buffer");
  assert.equal(patched.readUInt32LE(4), 500); // 可用字节 = 500
  assert.equal(patched.length, content.length); // 数据长度不变
  // 头之外的数据一个字节都不改
  assert.deepEqual(patched.subarray(14), content.subarray(14));
  // 不改动入参
  assert.equal(content.readUInt32LE(4), 1000);
});

test("patchTruncatedFitHeader: 头声明与实际相符或更小时返回 null", () => {
  assert.equal(patchTruncatedFitHeader(Buffer.concat([fitHeader(500), Buffer.alloc(500)])), null);
  assert.equal(patchTruncatedFitHeader(Buffer.concat([fitHeader(100), Buffer.alloc(500)])), null);
});

test("patchTruncatedFitHeader: 非法输入安全返回 null", () => {
  assert.equal(patchTruncatedFitHeader(Buffer.alloc(5)), null); // 比头还短
  assert.equal(patchTruncatedFitHeader(Buffer.concat([fitHeader(999, 8), Buffer.alloc(100)])), null); // 头长度非法
  const truncatedHeader = fitHeader(999, 14).subarray(0, 13); // 头本身被截断
  assert.equal(patchTruncatedFitHeader(truncatedHeader), null);
  assert.equal(patchTruncatedFitHeader("not a buffer"), null);
});

test("patchTruncatedFitHeader: 非 14 字节头（12 字节）同样按头长换算可用字节", () => {
  const content = Buffer.concat([fitHeader(1000, 12), Buffer.alloc(300)]);
  const patched = patchTruncatedFitHeader(content);
  assert.equal(patched.readUInt32LE(4), 300);
});

test("estimateFtp: 20 分钟峰功率 × 0.95，并给出更新建议", () => {
  const est = estimateFtp(Array(1200).fill(200));
  assert.equal(est.peak_20min_w, 200);
  assert.equal(est.estimated_ftp_w, 190);
  assert.equal(est.current_ftp_w, ATHLETE.ftp_watts);
  assert.equal(est.suggestion, "consider_update"); // 190 明显高于 118
  // 不足 20 分钟 → null
  assert.equal(estimateFtp(Array(1199).fill(200)), null);
  // 明显偏低 → 不建议直接下调
  assert.equal(estimateFtp(Array(1200).fill(60)).suggestion, "consider_recheck");
});

test("detectIntervals: 识别重复过阈工作段并给出组统计", () => {
  // 3×(120s @ 150W) 间歇，夹 120s @ 80W 恢复，前后各 60s 热身/放松
  const thr = ATHLETE.ftp_watts * 1.05; // 123.9
  const records = [];
  const push = (n, power) => {
    for (let k = 0; k < n; k++)
      records.push(rec(records.length, { power, heart_rate: 140, cadence: 90 }));
  };
  push(60, 80);
  for (let s = 0; s < 3; s++) {
    push(120, 150);
    push(120, 80);
  }
  assert.ok(150 >= thr);
  const r = detectIntervals(records);
  assert.equal(r.intervals.length, 3);
  assert.equal(r.intervals[0].duration_sec, 120);
  assert.equal(r.intervals[0].avg_power, 150);
  assert.equal(r.interval_set.count, 3);
  // 全程低于阈值 → null
  const easy = Array.from({ length: 300 }, (_, i) => rec(i, { power: 80 }));
  assert.equal(detectIntervals(easy), null);
});

test("hrDriftPct: 心率上升而输出不变时漂移为正（功率口径）", () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    rec(i, { power: 200, heart_rate: i < 300 ? 130 : 140 }),
  );
  // ef1 = 200/130, ef2 = 200/140 → drift = 1 − 130/140 ≈ 7.1%
  assert.equal(hrDriftPct(records, "power"), 7.1);
});

test("hrDriftPct: 支持速度口径（跑步无功率计）", () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    rec(i, { speed: 12, heart_rate: i < 300 ? 140 : 150 }),
  );
  // drift = 1 − 140/150 ≈ 6.7%
  assert.equal(hrDriftPct(records, "speed"), 6.7);
});

test("collectDeveloperFields: 只统计白名单外的数值字段", () => {
  const raw = [
    { timestamp: new Date(), power: 200, core_temperature: 38.5, note: "x" },
    { timestamp: new Date(), power: 210, core_temperature: 39.5 },
    { timestamp: new Date(), power: 220 },
  ];
  const dev = collectDeveloperFields(raw);
  assert.deepEqual(dev, {
    core_temperature: { samples: 2, avg: 39, min: 38.5, max: 39.5 },
  });
  assert.equal(collectDeveloperFields([{ timestamp: new Date(), power: 1 }]), null);
});

// ---------------- FTP 历史估算（ftp.js：CP 模型 + Coggan + 心率交叉验证） ----------------

// 构造一次合成骑行（FTP 估算输入：db.cyclingSummariesSince 的元素形状）
const mkRide = (
  name,
  date,
  { p5 = 150, p20 = 130, hrMax = 180, pz = { Z5: 5 }, hz = { Z4: 5 }, drift = 2, dur = 3600 } = {},
) => ({
  file_name: name,
  date,
  duration_sec: dur,
  summary: {
    power: {
      peak_curve: {
        ...(p5 != null ? { "5min": p5 } : {}),
        ...(p20 != null ? { "20min": p20 } : {}),
      },
      zone_distribution_pct: pz,
    },
    heart_rate: { max: hrMax, zone_distribution_pct: hz, hr_drift_pct: drift },
    data_quality: { power_coverage_pct: 100, hr_coverage_pct: 100 },
  },
});
const FTP_ATHLETE = { ftp_watts: 118, max_hr: 195 };
const threeRides = (opts) => [
  mkRide("a.fit", "2026-07-01", opts),
  mkRide("b.fit", "2026-07-03", opts),
  mkRide("c.fit", "2026-07-05", opts),
];

test("estimateFtpFromHistory: 双方法一致且心率验证通过 → 高置信", () => {
  const r = estimateFtpFromHistory(threeRides(), FTP_ATHLETE);
  assert.equal(r.status, "ok");
  // CP = (130×1200 − 150×300) / 900 = 123.3 → 123；W′ = (150−123.3)×300 = 8kJ
  assert.equal(r.estimate.methods.cp_model.ftp_w, 123);
  assert.equal(r.estimate.methods.cp_model.w_prime_kj, 8);
  // Coggan = 130 × 0.95 = 123.5 → 124；两法均值 123.5 → 124
  assert.equal(r.estimate.methods.coggan_20min.ftp_w, 124);
  assert.equal(r.estimate.ftp_w, 124);
  assert.equal(r.estimate.confidence, "high");
  assert.equal(r.estimate.methods.hr_check.maximal_effort, true);
  assert.equal(r.estimate.diff_w, 124 - FTP_ATHLETE.ftp_watts);
});

test("estimateFtpFromHistory: 无 20min 峰功率 → 数据不足并给出收集清单", () => {
  const r = estimateFtpFromHistory(threeRides({ p20: null }), FTP_ATHLETE);
  assert.equal(r.status, "insufficient");
  assert.equal(r.estimate, null);
  assert.ok(r.data_needs.length > 0);
  assert.match(r.data_needs.join("\n"), /20 分钟/);
});

test("estimateFtpFromHistory: 样本次数不足 → 低置信并提示补充数据", () => {
  const r = estimateFtpFromHistory([mkRide("a.fit", "2026-07-01")], FTP_ATHLETE);
  assert.equal(r.status, "ok");
  assert.equal(r.estimate.confidence, "low");
  assert.match(r.data_needs.join("\n"), /更多佩戴功率计的骑行/);
});

test("estimateFtpFromHistory: 锚点骑行心率未达全力阈值 → 降置信并建议全力测试", () => {
  // 全力阈值 = round(195×0.9) = 176bpm，心率峰值 150 未达
  const r = estimateFtpFromHistory(threeRides({ hrMax: 150 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.maximal_effort, false);
  assert.equal(r.estimate.confidence, "medium");
  assert.match(r.data_needs.join("\n"), /全力测试/);
});

test("estimateFtpFromHistory: 功率强度显著高于心率响应 → 判定系统性偏移", () => {
  const r = estimateFtpFromHistory(
    threeRides({ pz: { Z5: 30 }, hz: { Z4: 5 } }),
    FTP_ATHLETE,
  );
  const zm = r.estimate.methods.hr_check.zone_mismatch;
  assert.equal(zm.direction, "power_above_hr");
  assert.match(r.notes.join("\n"), /低估/);
});

test("estimateFtpFromHistory: 心率漂移超阈值 → 数据漂移提示", () => {
  const r = estimateFtpFromHistory(threeRides({ drift: 8 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.median_hr_drift_pct, 8);
  assert.match(r.notes.join("\n"), /有氧解耦/);
});

test("estimateFtpFromHistory: 缺 5min 峰功率时 CP 模型退化，仅用 Coggan 法", () => {
  const r = estimateFtpFromHistory(threeRides({ p5: null }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.cp_model, null);
  assert.equal(r.estimate.ftp_w, r.estimate.methods.coggan_20min.ftp_w);
  assert.match(r.notes.join("\n"), /CP 模型不可用/);
});

// ---------------- FTP 自动采纳门槛（evaluateFtpApply，自 VoltCoach unit.test.mjs 同源搬运） ----------------

// 基准估算：threeRides()（窗口 2026-07-01~07-05）→ 高置信、ftp_w=124、diff=+6
const baseApplyResult = () => estimateFtpFromHistory(threeRides(), FTP_ATHLETE);
// 无心率数据的骑行（锚点无法判定全力与否 → maximal_effort=null）
const ridesNoHr = () =>
  threeRides().map((r) => ({ ...r, summary: { ...r.summary, heart_rate: undefined } }));

test("evaluateFtpApply: 高置信 + 数据新鲜 → 放行", () => {
  const check = evaluateFtpApply(baseApplyResult(), "2026-07-05", "2026-07-10");
  assert.deepEqual(check, { ok: true, reason_key: null });
});

test("evaluateFtpApply: 区间错位（power_above_hr）降级的 medium → 放行（配置漂移正是该更新的信号）", () => {
  const r = estimateFtpFromHistory(threeRides({ pz: { Z5: 30 }, hz: { Z4: 5 } }), FTP_ATHLETE);
  assert.equal(r.estimate.confidence, "medium");
  assert.equal(r.estimate.methods.hr_check.zone_mismatch.direction, "power_above_hr");
  const check = evaluateFtpApply(r, "2026-07-05", "2026-07-10");
  assert.deepEqual(check, { ok: true, reason_key: null });
});

test("evaluateFtpApply: 心率漂移降级的 medium → 放行", () => {
  const r = estimateFtpFromHistory(threeRides({ drift: 8 }), FTP_ATHLETE);
  assert.equal(r.estimate.confidence, "medium");
  assert.deepEqual(evaluateFtpApply(r, "2026-07-05", "2026-07-10"), { ok: true, reason_key: null });
});

test("evaluateFtpApply: 锚点无心率（maximal_effort=null）→ 不拦（峰值法只依赖功率）", () => {
  const r = estimateFtpFromHistory(ridesNoHr(), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.maximal_effort, null);
  assert.deepEqual(evaluateFtpApply(r, "2026-07-05", "2026-07-10"), { ok: true, reason_key: null });
});

test("evaluateFtpApply: 无 20min 峰 → 数据不足拒绝", () => {
  const check = evaluateFtpApply(
    estimateFtpFromHistory(threeRides({ p20: null }), FTP_ATHLETE),
    "2026-07-05",
    "2026-07-10",
  );
  assert.equal(check.ok, false);
  assert.equal(check.reason_key, "ftp.apply.no_data");
});

test("evaluateFtpApply: 骑行次数不足 → 拒绝（few_rides 先于 low_confidence）", () => {
  const check = evaluateFtpApply(
    estimateFtpFromHistory([mkRide("a.fit", "2026-07-01")], FTP_ATHLETE),
    "2026-07-01",
    "2026-07-02",
  );
  assert.equal(check.reason_key, "ftp.apply.few_rides");
  assert.equal(check.reason_vars.min, 3);
});

test("evaluateFtpApply: 置信度 low → 拒绝", () => {
  const r = baseApplyResult();
  r.estimate.confidence = "low";
  assert.equal(evaluateFtpApply(r, "2026-07-05", "2026-07-10").reason_key, "ftp.apply.low_confidence");
});

test("evaluateFtpApply: 两法互斥（差超一致性阈值）→ 拒绝（与置信度独立校验）", () => {
  const r = baseApplyResult(); // confidence=high，但手动拉开 CP 与 Coggan
  r.estimate.methods.cp_model.ftp_w = 260; // 与 Coggan 124 差 ~110%
  assert.equal(evaluateFtpApply(r, "2026-07-05", "2026-07-10").reason_key, "ftp.apply.inconsistent");
});

test("evaluateFtpApply: 锚点明确非全力 → 拒绝（估值只会低估）", () => {
  const r = estimateFtpFromHistory(threeRides({ hrMax: 150 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.maximal_effort, false);
  assert.equal(evaluateFtpApply(r, "2026-07-05", "2026-07-10").reason_key, "ftp.apply.not_maximal");
});

test("evaluateFtpApply: 新鲜度边界 —— 最近骑行距今 ≤7 天放行、>7 天拒绝、无骑行拒绝", () => {
  const r = baseApplyResult(); // 窗口内最近一次骑行 2026-07-05
  assert.deepEqual(evaluateFtpApply(r, "2026-07-05", "2026-07-12"), { ok: true, reason_key: null });
  const stale = evaluateFtpApply(r, "2026-07-05", "2026-07-13");
  assert.equal(stale.reason_key, "ftp.apply.stale");
  assert.equal(stale.reason_vars.n, 7);
  assert.equal(evaluateFtpApply(r, null, "2026-07-10").reason_key, "ftp.apply.stale");
});

test("evaluateFtpApply: 估算与当前一致（diff=0）→ 无需更新", () => {
  const r = estimateFtpFromHistory(threeRides(), { ftp_watts: 124, max_hr: 195 });
  assert.equal(r.estimate.diff_w, 0);
  assert.equal(evaluateFtpApply(r, "2026-07-05", "2026-07-10").reason_key, "ftp.apply.no_change");
});

test("evaluateFtpApply: 单一方法（仅 Coggan）降级的 medium → 放行（样本量已由 min_rides 把关）", () => {
  const r = estimateFtpFromHistory(threeRides({ p5: null }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.cp_model, null);
  assert.equal(r.estimate.confidence, "medium");
  assert.deepEqual(evaluateFtpApply(r, "2026-07-05", "2026-07-10"), { ok: true, reason_key: null });
});

test("evaluateFtpApply: 两法一致性分母与估算器同口径（取整均值）", () => {
  const r = baseApplyResult();
  // coggan 101 / cp 98：未取整均值 99.5 → 估算器口径取整 100，差 3% 恰在线上判"一致"
  r.estimate.methods.cp_model.ftp_w = 98;
  r.estimate.methods.coggan_20min.ftp_w = 101;
  r.estimate.ftp_w = 100;
  assert.deepEqual(evaluateFtpApply(r, "2026-07-05", "2026-07-10"), { ok: true, reason_key: null });
});

test("evaluateFtpApply: 估值超采纳上界 → 拒绝", () => {
  const r = baseApplyResult();
  r.estimate.ftp_w = 600;
  r.estimate.diff_w = 482;
  assert.equal(evaluateFtpApply(r, "2026-07-05", "2026-07-10").reason_key, "ftp.apply.range");
});

test("evaluateFtpApply: 估值越采纳范围 → 拒绝", () => {
  const r = baseApplyResult();
  r.estimate.ftp_w = 30;
  r.estimate.diff_w = -94;
  // 两法同步改为 30/30，避免一致性检查（分母为估值）先于范围检查触发
  r.estimate.methods.cp_model.ftp_w = 30;
  r.estimate.methods.coggan_20min.ftp_w = 30;
  const check = evaluateFtpApply(r, "2026-07-05", "2026-07-10");
  assert.equal(check.reason_key, "ftp.apply.range");
  assert.equal(check.reason_vars.w, 30);
});

// ---------------- FTP 区间自选 / 校准判据 / flagged 剔除（§35 回同步） ----------------

test("selectFtpFromEstimate: 缺省取均值；区间内取整；越界夹逼；无估算返回 null", () => {
  const r = estimateFtpFromHistory(threeRides(), FTP_ATHLETE);
  assert.deepEqual(selectFtpFromEstimate(r), {
    ftp_w: r.estimate.ftp_w,
    requested_w: null,
    clamped: false,
  });
  const inside = r.estimate.range_low + 0.4;
  assert.deepEqual(selectFtpFromEstimate(r, inside), {
    ftp_w: r.estimate.range_low,
    requested_w: r.estimate.range_low,
    clamped: false,
  });
  const low = selectFtpFromEstimate(r, r.estimate.range_low - 100);
  assert.equal(low.ftp_w, r.estimate.range_low);
  assert.equal(low.clamped, true);
  const high = selectFtpFromEstimate(r, r.estimate.range_high + 100);
  assert.equal(high.ftp_w, r.estimate.range_high);
  assert.equal(high.clamped, true);
  assert.equal(selectFtpFromEstimate({ status: "insufficient", estimate: null }), null);
});

test("isFtpCalibratedFrom: 溯源戳/非默认值/旧撤销假戳归一化", () => {
  assert.equal(isFtpCalibratedFrom(106, null, 106), false);
  assert.equal(isFtpCalibratedFrom(106, "", 106), false);
  assert.equal(isFtpCalibratedFrom(150, null, 106), true);
  assert.equal(
    isFtpCalibratedFrom(106, "2026-10-01T00:00:00.000Z", 106, {
      source: "manual",
      hasAiUpdate: false,
    }),
    false,
    "默认值 + manual 戳 + 无 AI 快照 = 旧撤销假戳",
  );
  assert.equal(
    isFtpCalibratedFrom(106, "2026-10-01T00:00:00.000Z", 106, {
      source: "manual",
      hasAiUpdate: true,
    }),
    true,
  );
  assert.equal(
    isFtpCalibratedFrom(106, "2026-10-01T00:00:00.000Z", 106, { source: "ai_coach" }),
    true,
  );
});

test("estimateFtpFromHistory: flagged 骑行从样本剔除并在 data_needs 披露", () => {
  const rides = [
    ...threeRides(),
    { ...mkRide("flagged.fit", "2026-07-06"), power_flagged: true },
  ];
  const r = estimateFtpFromHistory(rides, FTP_ATHLETE);
  assert.equal(r.sample.cycling_rides, 4);
  assert.equal(r.sample.flagged_excluded, 1);
  assert.equal(r.sample.usable_power_rides, 3);
  assert.ok(r.data_needs.some((s) => s.includes("标记")));
});

test("evaluateFtpApply: chosenW 按最终写入值判 no_change / 范围闸", () => {
  const r = baseApplyResult();
  assert.deepEqual(
    evaluateFtpApply(r, "2026-07-05", "2026-07-10", undefined, r.estimate.range_high),
    { ok: true, reason_key: null },
  );
  assert.equal(
    evaluateFtpApply(
      r,
      "2026-07-05",
      "2026-07-10",
      undefined,
      r.estimate.current_ftp_w,
    ).reason_key,
    "ftp.apply.no_change",
  );
});

// ---------------- 踩踏时间分解与静止段识别（0W 根治：pedal_time 进 summary + stationary 异常） ----------------

/** 逐秒记录夹具（只带分解用到的字段；timestamp 供静止段 at 取值） */
const psec = (power, speed, i = 0) => ({
  timestamp: `2026-10-11T00:00:${String(i % 60).padStart(2, "0")}Z`,
  power,
  speed,
});

test("pedalTimeBreakdown: 三桶划分——踩踏 P>0 / 滑行 P=0 且移动 / 静止 P=0 且速度低于暂停阈值", () => {
  const b = pedalTimeBreakdown([
    psec(250, 30),
    psec(0, 25), // 滑行（0W 下坡）
    psec(0, 0.5), // 静止（计时未停）
    psec(120, 5),
  ]);
  assert.deepEqual(b, { sample_sec: 4, pedaling_sec: 2, coasting_sec: 1, stationary_sec: 1 });
});

test("pedalTimeBreakdown: 速度阈值边界——speed 恰等于阈值判滑行（≥ 阈值即移动）", () => {
  const kmh = DATA_QUALITY.pause_resume_speed_kmh;
  const b = pedalTimeBreakdown([psec(0, kmh), psec(0, kmh - 0.1)]);
  assert.equal(b.coasting_sec, 1);
  assert.equal(b.stationary_sec, 1);
});

test("pedalTimeBreakdown: P=0 且速度缺失判静止（无速度可证仍在移动，向披露侧保守）", () => {
  const b = pedalTimeBreakdown([psec(0, null), psec(0, null), psec(100, null)]);
  assert.deepEqual(b, { sample_sec: 3, pedaling_sec: 1, coasting_sec: 0, stationary_sec: 2 });
});

test("pedalTimeBreakdown: 无功率数据的秒不计入分母（保守口径，同踏频均值剔 0）", () => {
  const b = pedalTimeBreakdown([psec(null, 30), psec(200, 30), psec(null, 0), psec(0, 0.5)]);
  assert.deepEqual(b, { sample_sec: 2, pedaling_sec: 1, coasting_sec: 0, stationary_sec: 1 });
});

test("pedalTimeBreakdown: 全程无功率数据返回 null（summary 装配侧不出键）", () => {
  assert.equal(pedalTimeBreakdown([psec(null, 10), psec(null, 12)]), null);
  assert.equal(pedalTimeBreakdown([]), null);
});

test("detectStationarySpans: 30s 起标、29s 不标（stationary_min_sec 边界）", () => {
  const short = Array.from({ length: 29 }, (_, i) => psec(0, 0.5, i));
  const long = Array.from({ length: 30 }, (_, i) => psec(0, 0.5, i));
  assert.deepEqual(detectStationarySpans(short), []);
  assert.deepEqual(detectStationarySpans(long), [
    { type: "stationary", duration_sec: 30, at: "2026-10-11T00:00:00Z" },
  ]);
});

test("detectStationarySpans: 踩踏/滑行秒断开静止段；速度缺失计入静止；正常骑行不标", () => {
  const recs = [
    ...Array.from({ length: 30 }, (_, i) => psec(0, 0.5, i)), // 静止 30s → 标
    psec(200, 25, 30), // 踩踏断开
    ...Array.from({ length: 29 }, (_, i) => psec(0, 0.2, 31 + i)), // 静止 29s → 不标
    psec(0, 25, 60), // 滑行断开
    ...Array.from({ length: 31 }, (_, i) => psec(0, null, 61 + i)), // 静止（速度缺失）31s → 标
  ];
  const spans = detectStationarySpans(recs);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].duration_sec, 30);
  assert.equal(spans[1].duration_sec, 31);
  // 夹具 timestamp 按 60s 取模回绕：i=61 → :01
  assert.equal(spans[1].at, "2026-10-11T00:00:01Z");
  // 全程正常骑行：无标注
  assert.deepEqual(
    detectStationarySpans(Array.from({ length: 120 }, (_, i) => psec(i % 40 ? 200 : 0, 25, i))),
    [],
  );
});

test("formatAnomaly: stationary 按语言渲染（zh/en），旧字符串透传不受影响", () => {
  const a = { type: "stationary", duration_sec: 90, at: "2026-10-11T00:05:00Z" };
  assert.equal(formatAnomaly(a, "zh"), "计时未停的静止 90s，起始 2026-10-11T00:05:00Z");
  assert.equal(formatAnomaly(a, "en"), "Stationary with the timer running 90s, at 2026-10-11T00:05:00Z");
  assert.equal(formatAnomaly("旧格式字符串", "zh"), "旧格式字符串");
});

// ---------------- prompts.js 提交前数据压缩 ----------------

/**
 * 取出字符串中的 ISO 时间戳并返回其绝对时刻（毫秒）。
 * 本地时区偏移随机器而变，断言一律用「时刻不变」而非字面量，保证时区无关。
 */
const instantOf = (v) => {
  const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/.exec(String(v));
  return m ? Date.parse(m[1]) : NaN;
};

test("compactSummaryForPrompt: 少量 anomalies 保留原文，仅时间戳改写为本地偏移", () => {
  const out = compactSummaryForPrompt({ anomalies: ["记录缺失 25s，起始 2026-07-24T13:54:16.000Z"] });
  assert.equal(out.anomalies.length, 1);
  assert.equal(out.anomalies_summary, undefined);
  assert.match(out.anomalies[0], /^记录缺失 25s，起始 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(instantOf(out.anomalies[0]), Date.parse("2026-07-24T13:54:16.000Z"));
});

test("compactSummaryForPrompt: 大量 anomalies 聚合为按类型统计", () => {
  const anomalies = [
    "功率缺失 78s，起始 2026-07-24T13:43:40.000Z",
    "功率缺失 65s，起始 2026-07-24T14:36:53.000Z",
    "记录缺失 25s，起始 2026-07-24T13:54:16.000Z",
    "记录缺失 15s，起始 2026-07-24T13:55:26.000Z",
    "记录缺失 41s，起始 2026-07-24T14:01:38.000Z",
    "心率跳变 95→148，位于 2026-07-24T14:05:00.000Z",
  ];
  const out = compactSummaryForPrompt({ anomalies });
  assert.equal(out.anomalies, undefined);
  const byType = Object.fromEntries(out.anomalies_summary.map((g) => [g.type, g]));
  const pwr = byType["功率缺失"];
  assert.equal(pwr.type, "功率缺失");
  assert.equal(pwr.count, 2);
  assert.equal(pwr.total_sec, 143);
  assert.equal(pwr.max_sec, 78);
  // first_at 已改写为本地偏移，但仍是同一时刻（时区无关断言）
  assert.equal(instantOf(pwr.first_at), Date.parse("2026-07-24T13:43:40.000Z"));
  assert.equal(byType["记录缺失"].count, 3);
  assert.equal(byType["记录缺失"].total_sec, 81);
  assert.equal(byType["心率跳变"].count, 1);
  assert.equal(byType["心率跳变"].total_sec, undefined);
});

test("compactSummaryForPrompt: timer_pause 不参与聚合、逐条保留位置证据", () => {
  // 暂停的 at 是判断其落在哪个环节（热身/通勤/间歇之间）的唯一位置证据，
  // 聚合丢失会迫使 AI 凭叙述需要"安放"暂停——热身段暂停被归因为冲刺段没出力
  const anomalies = [
    { type: "timer_pause", duration_sec: 45, at: "2026-07-24T13:40:00.000Z" },
    { type: "timer_pause", duration_sec: 30, at: "2026-07-24T13:52:00.000Z" },
    { type: "power_gap", duration_sec: 78, at: "2026-07-24T13:43:40.000Z" },
    { type: "power_gap", duration_sec: 65, at: "2026-07-24T14:36:53.000Z" },
    { type: "record_gap", duration_sec: 25, at: "2026-07-24T13:54:16.000Z" },
    { type: "hr_jump", at: "2026-07-24T14:05:00.000Z" },
  ];
  const out = compactSummaryForPrompt({ anomalies });
  assert.equal(out.anomalies.length, 2);
  assert.ok(out.anomalies.every((a) => a.type === "timer_pause"));
  assert.equal(out.anomalies[0].duration_sec, 45);
  assert.equal(instantOf(out.anomalies[0].at), Date.parse("2026-07-24T13:40:00.000Z"));
  assert.equal(instantOf(out.anomalies[1].at), Date.parse("2026-07-24T13:52:00.000Z"));
  const byType = Object.fromEntries(out.anomalies_summary.map((g) => [g.type, g]));
  assert.equal(byType["power_gap"].count, 2);
  assert.equal(byType["power_gap"].total_sec, 143);
  assert.equal(byType["record_gap"].count, 1);
  assert.equal(byType["hr_jump"].count, 1);
  assert.equal(byType["timer_pause"], undefined);
});

test("compactSummaryForPrompt: 全部为 timer_pause 时逐条保留、不产生空聚合", () => {
  const anomalies = Array.from({ length: 7 }, (_, i) => ({
    type: "timer_pause",
    duration_sec: 20 + i,
    at: `2026-07-24T1${i}:00:00.000Z`,
  }));
  const out = compactSummaryForPrompt({ anomalies });
  assert.equal(out.anomalies.length, 7);
  assert.equal(out.anomalies_summary, undefined);
});

test("compactSummaryForPrompt: 超长 segments 保留首尾并标注省略", () => {
  const segments = Array.from({ length: 30 }, (_, i) => ({ name: `lap_${i + 1}` }));
  const out = compactSummaryForPrompt({ segments });
  assert.equal(out.segments.length, 16); // 前10 + 占位 + 后5
  assert.equal(out.segments[0].name, "lap_1");
  assert.equal(out.segments[9].name, "lap_10");
  assert.match(out.segments[10].name, /省略 15 段/);
  assert.equal(out.segments[15].name, "lap_30");
});

test("compactSummaryForPrompt: 不修改原对象", () => {
  const s = {
    anomalies: Array.from({ length: 8 }, (_, i) => `记录缺失 ${10 + i}s，起始 T${i}`),
  };
  compactSummaryForPrompt(s);
  assert.equal(s.anomalies.length, 8);
});

// ---------------- prompts.js 当前日期时间段 ----------------

// 2026-09-03 恒为星期四；本地时间构造器保证日期/星期/时刻在任何时区下都固定
const FIXED_NOW = new Date(2026, 8, 3, 14, 35);

test("buildDateSection: zh 输出日期/星期/时刻/时区偏移与 UTC 说明", () => {
  const s = buildDateSection(FIXED_NOW, "zh");
  assert.match(s, /^## 当前时间/);
  assert.match(s, /今天是 2026-09-03（星期四），当前时刻 14:35（UTC[+-]\d{2}:\d{2}）。/);
  assert.match(s, /UTC 口径/);
});

test("buildDateSection: en 输出英文标题与英文星期", () => {
  const s = buildDateSection(FIXED_NOW, "en");
  assert.match(s, /^## Current Date & Time/);
  assert.match(s, /Today is Thursday, 2026-09-03; local time 14:35 \(UTC[+-]\d{2}:\d{2}\)\./);
  assert.match(s, /UTC-based/);
});

test("buildDateSection: 非法或缺失时刻返回 null（不产生该段）", () => {
  assert.equal(buildDateSection(new Date("not-a-date"), "zh"), null);
  assert.equal(buildDateSection(null, "zh"), null);
});

test("buildReviewPrompt: 经 assemble 自动带上当前时间段，位于口径之后数据之前", () => {
  const summary = { activity: { date: "2026-09-06", category: "training" } };
  const zh = buildReviewPrompt(summary, undefined, undefined, "zh", FIXED_NOW);
  assert.match(zh, /## 当前时间/);
  assert.match(zh, /星期四/);
  assert.ok(zh.indexOf("## 当前时间") < zh.indexOf("## 训练数据"), "日期段应在数据段之前");
  const en = buildReviewPrompt(summary, undefined, undefined, "en", FIXED_NOW);
  assert.match(en, /## Current Date & Time/);
  assert.match(en, /Thursday/);
});

// ---------------- prompts.js 时间戳本地化（UTC → 本地时区偏移） ----------------

test("localizeTimestamps: UTC 时间戳改写为本地偏移且时刻不变", () => {
  // 本地 19:51 的骑行在数据里是 11:51Z——改写后 AI 直接读到傍晚，无需自行换算
  const out = localizeTimestamps({ at: "2026-03-25T11:51:24.000Z" });
  assert.match(out.at, /^2026-03-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(instantOf(out.at), Date.parse("2026-03-25T11:51:24.000Z"));
});

test("localizeTimestamps: 递归处理嵌套对象与数组内的结构化时间戳", () => {
  const out = localizeTimestamps({
    climbs: [{ start: "2026-05-24T06:05:32.000Z", duration_sec: 120 }],
    segments: [{ name: "lap_1", duration_sec: 1061 }],
    power: { np: 180 },
  });
  assert.equal(instantOf(out.climbs[0].start), Date.parse("2026-05-24T06:05:32.000Z"));
  assert.equal(out.climbs[0].duration_sec, 120); // 数值字段不受影响
  assert.equal(out.segments[0].name, "lap_1");
  assert.equal(out.power.np, 180);
});

test("localizeTimestamps: 纯日期字段与用户自填内容不改写", () => {
  const out = localizeTimestamps({
    activity: {
      date: "2026-03-25", // 训练库/界面同口径的纯日期，保持 UTC 基准
      note: "19:51 出发，中途码表断电，日志里写着 2026-03-25T11:51:24.000Z 那段",
    },
    identity: "上班族，2026-03-25T11:51:24.000Z 前完成训练",
  });
  assert.equal(out.activity.date, "2026-03-25");
  assert.match(out.activity.note, /2026-03-25T11:51:24\.000Z/, "用户备注原文不改写");
  assert.match(out.identity, /2026-03-25T11:51:24\.000Z/, "用户身份原文不改写");
});

test("localizeTimestamps: 不修改入参，缺失值安全", () => {
  const src = { climbs: [{ start: "2026-05-24T06:05:32.000Z" }] };
  localizeTimestamps(src);
  assert.equal(src.climbs[0].start, "2026-05-24T06:05:32.000Z");
  assert.equal(localizeTimestamps(null), null);
  assert.equal(localizeTimestamps("没有时间戳"), "没有时间戳");
  assert.equal(localizeTimestamps(42), 42);
});

test("buildReviewPrompt: 训练时间戳按本地时区呈现（傍晚骑行不再被读成中午）", () => {
  const summary = {
    activity: { date: "2026-03-25", category: "training" },
    anomalies: [{ type: "record_gap", duration_sec: 23, at: "2026-03-25T11:51:24.000Z" }],
  };
  const out = buildReviewPrompt(summary, undefined, undefined, "zh", FIXED_NOW);
  const m = /"at": "([^"]+)"/.exec(out);
  assert.ok(m, "复盘提示词应包含 anomalies 的 at 时间戳");
  assert.match(m[1], /^2026-03-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(m[1]), Date.parse("2026-03-25T11:51:24.000Z"), "时刻不变");
  assert.doesNotMatch(out, /2026-03-25T11:51:24\.000Z/, "不应再出现裸 UTC 时间戳");
});

// ============ src/planning.js：未来负荷推演 + 课表生成 ============

test("simulateForm: TSS 全 0 时 CTL/ATL 按 1/42、1/7 衰减", () => {
  const { projection, end_form } = simulateForm({
    startCtl: 42,
    startAtl: 14,
    plan: [{ date: "2026-08-01", tss: 0 }],
    cfg: FORM_SIMULATION,
  });
  // ctl = 42 + (0-42)/42 = 41；atl = 14 + (0-14)/7 = 12；tsb = 29
  assert.deepEqual(projection[0], ["2026-08-01", 41, 12, 29]);
  assert.deepEqual(end_form, { ctl: 41, atl: 12, tsb: 29 });
});

test("simulateForm: 恒定 TSS 下 CTL/ATL 向该 TSS 收敛", () => {
  const plan = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    tss: 100,
  }));
  const { end_form } = simulateForm({ startCtl: 0, startAtl: 0, plan, cfg: FORM_SIMULATION });
  assert.ok(end_form.ctl > 70 && end_form.ctl < 100, `ctl 应向 100 收敛，实际 ${end_form.ctl}`);
  assert.ok(end_form.atl > 90 && end_form.atl <= 100, `atl 应快速逼近 100，实际 ${end_form.atl}`);
});

test("simulateForm: TSB 持续低于 -30 达 7 天触发深度疲劳警示", () => {
  // atl 恒 50（每日 tss=50 保持），ctl 从 0 缓慢爬升，前 7 天 tsb 均 < -30
  const plan = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-08-0${i + 1}`,
    tss: 50,
  }));
  const { risk_flags } = simulateForm({ startCtl: 0, startAtl: 50, plan, cfg: FORM_SIMULATION });
  const flag = risk_flags.find((f) => f.type === "tsb_low_sustained");
  assert.ok(flag, "应触发 tsb_low_sustained");
  assert.equal(flag.days, 7);
  assert.equal(flag.start, "2026-08-01");
  assert.equal(flag.end, "2026-08-07");
});

test("simulateForm: CTL 周增幅超 10% 触发过度训练警示", () => {
  // start ctl=10，每日 tss=200 → ctl 快速拉升，周增幅远超 10%
  const plan = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    tss: 200,
  }));
  const { risk_flags } = simulateForm({ startCtl: 10, startAtl: 10, plan, cfg: FORM_SIMULATION });
  assert.ok(risk_flags.some((f) => f.type === "ctl_ramp_high"), "应触发 ctl_ramp_high");
});

test("simulateForm: 温和计划不触发任何风险", () => {
  // start ctl=50，每日 tss=50 → ctl/atl 稳定在 50 附近，tsb≈0
  const plan = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    tss: 50,
  }));
  const { risk_flags } = simulateForm({ startCtl: 50, startAtl: 50, plan, cfg: FORM_SIMULATION });
  assert.deepEqual(risk_flags, []);
});

test("generateWorkout: 稳态课（endurance）全程一个强度，瓦数与 TSS 口径正确", () => {
  const w = generateWorkout({
    target: "endurance",
    durationMinutes: 60,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.steady.minutes, 60);
  assert.deepEqual(w.steady.power_watts, [112, 150]); // 56%–75% × 200
  // TSS = 3600s × 0.68² / 36 = 46.2
  assert.equal(w.estimated_tss, 46.2);
});

test("generateWorkout: 甜区课组装进 60 分钟且各段合计等于总时长", () => {
  const w = generateWorkout({
    target: "sweet_spot",
    durationMinutes: 60,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.warmup.minutes, 15);
  assert.equal(w.main_sets.reps, 2);
  assert.equal(w.main_sets.set_minutes, 15);
  assert.equal(w.main_sets.rest_minutes, 5);
  assert.deepEqual(w.main_sets.power_watts, [176, 188]); // 88%–94% × 200
  const total =
    w.warmup.minutes +
    w.main_sets.reps * w.main_sets.set_minutes +
    (w.main_sets.reps - 1) * w.main_sets.rest_minutes +
    w.cooldown.minutes;
  assert.equal(total, 60);
  // TSS = 15min@0.5 + 2×15min@0.91 + 5min@0.5 + 10min@0.5 ≈ 53.9
  assert.equal(w.estimated_tss, 53.9);
});

test("generateWorkout: VO2max 组间休息与单组等时", () => {
  const w = generateWorkout({
    target: "vo2max",
    durationMinutes: 50,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.main_sets.reps, 4);
  assert.equal(w.main_sets.set_minutes, 3);
  assert.equal(w.main_sets.rest_minutes, 3); // 等时休息
  assert.deepEqual(w.main_sets.power_watts, [212, 240]); // 106%–120% × 200
});

test("generateWorkout: 时长装不下最小组数时报错", () => {
  const w = generateWorkout({
    target: "sweet_spot",
    durationMinutes: 20,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.match(w.error, /装不下/);
});

test("generateWorkout: TSB 过低自动降级为恢复课并附说明", () => {
  const w = generateWorkout({
    target: "threshold",
    durationMinutes: 60,
    ftpWatts: 200,
    tsb: -25,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.equal(w.target, "recovery");
  assert.ok(w.steady, "降级后应为稳态恢复课");
  assert.match(w.notes[0], /自动降级为恢复骑/);
});

test("generateWorkout: 未知课表类型报错", () => {
  const w = generateWorkout({
    target: "hill_reps",
    durationMinutes: 60,
    ftpWatts: 200,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
  });
  assert.match(w.error, /未知课表类型/);
});
