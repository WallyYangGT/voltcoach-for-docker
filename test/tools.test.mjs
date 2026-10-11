/**
 * tools.test.mjs — agentic 工具层回归测试（node:test）
 *
 * 自 VoltCoach test/tools.test.mjs 同源适配：旧仓无 ToolIo 注入缝隙（tools.js 直调
 * db.js/records.js），故走「临时库 + analyzeFile 真实入库」夹具。
 * 覆盖：get_activity_records 的 60s 全秒窗在放宽后的截断线上不截断
 * （tool_result_max_chars 4000→16000 的行为回归——4000 上限时这种窗也会被硬切，
 * AI 逐秒核对暂停时刻基本不可用）。
 * 运行：npm test
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fit-reader-tools-"));
process.env.FIT_DB_PATH = path.join(tmp, "test.db");
process.env.FIT_OUTPUT_DIR = path.join(tmp, "output");
fs.mkdirSync(process.env.FIT_OUTPUT_DIR, { recursive: true });

const { buildRideFit } = await import("./make_test_fit.mjs");
const { analyzeFile } = await import("../index.js");
const { executeTool } = await import("../src/tools.js");
const { AGENTIC } = await import("../src/settings.js");
const { closeDb, upsertActivity, getActivitySummary, setAthlete, getFtpMeta } = await import("../src/db.js");

const RIDE_NAME = "tools_window_ride.fit";

before(async () => {
  // 60 秒全秒数据（< records_max_points 抽稀线 → 工具侧不抽稀、全量返回）
  const fitPath = path.join(tmp, RIDE_NAME);
  fs.writeFileSync(fitPath, buildRideFit({ durationSec: 60, power: 220, speedMS: 8 }));
  await analyzeFile(fitPath, process.env.FIT_OUTPUT_DIR);
});

after(() => {
  closeDb(); // 先释放 SQLite 句柄，Windows 上才能删库文件
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("get_activity_records：60s 全秒窄窗不截断（逐秒核对暂停时刻的可用性，截断放宽回归）", async () => {
  const raw = await executeTool(
    "get_activity_records",
    { file_name: RIDE_NAME, start_sec: 0, end_sec: 59 },
    { lang: "zh" },
  );
  assert.ok(raw.length > 4000, "60s 全秒窗应超旧 4000 上限（证明放宽实际生效），实测 " + raw.length);
  const parsed = JSON.parse(raw); // 截断标记会破坏 JSON——能 parse 即未截断
  assert.equal(parsed.points.length, 60);
  assert.ok(raw.length <= AGENTIC.tool_result_max_chars + "（结果已截断）".length);
});

// ---------------- update_ftp / reanalyze_activity（自 VoltCoach 能力包回同步的编排层） ----------------

/** 构造一次可过采纳门槛的骑行 summary（入库用；口径同 unit.test.mjs 的 mkRide 夹具：
 *  p5=150/p20=130 → CP 123 / Coggan 124 → ftp_w=124、置信 high、diff=124−当前 FTP） */
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
function seedRide(name, date) {
  upsertActivity(name, {
    activity: {
      date,
      sport: "cycling",
      duration_sec: 3600,
      distance_km: 30,
      elevation_gain_m: 0,
      elevation_gain_source: "computed",
    },
    athlete_context: { ftp_watts: 106, max_hr: 195, weight_kg: 60 },
    power: {
      avg: 130,
      normalized_power: 135,
      max: 200,
      intensity_factor: 1.27,
      tss: 47,
      w_per_kg_avg: 2.17,
      peak_curve: { "5min": 150, "20min": 130 },
      zone_distribution_pct: { Z1: 5, Z2: 10, Z3: 20, Z4: 30, Z5: 5, Z6: 0, Z7: 0 },
    },
    heart_rate: {
      avg: 150,
      max: 180,
      hr_drift_pct: 2,
      // 心率 Z4+ 占比须与功率 Z5+ 占比（5%）平衡，否则区间错位警告会把置信度压到 medium
      zone_distribution_pct: { Z1: 60, Z2: 20, Z3: 10, Z4: 5, Z5: 0 },
    },
    data_quality: { power_coverage_pct: 100, hr_coverage_pct: 100 },
  });
}

test("update_ftp：窗口内无 20min 连续输出 → 拒绝（no_data），estimate/data_needs 随结果透出", async () => {
  // 夹具里唯一的活动是 60s 合成骑行 → 估算器 insufficient
  const raw = await executeTool("update_ftp", {}, { lang: "zh" });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.applied, false);
  assert.match(parsed.reason, /无法自动更新/);
  assert.ok(Array.isArray(parsed.data_needs));
});

test("update_ftp：三骑高置信 + 数据新鲜 → 放行写回，数值来自估算器且盖 ai_coach 溯源戳", async () => {
  seedRide("seed_a.fit", daysAgo(1));
  seedRide("seed_b.fit", daysAgo(2));
  seedRide("seed_c.fit", daysAgo(3));
  // 当前 FTP 106（出厂默认）→ 估算 124，diff=+18
  const raw = await executeTool("update_ftp", {}, { lang: "zh" });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.applied, true);
  assert.equal(parsed.old_ftp_w, 106);
  assert.equal(parsed.new_ftp_w, 124);
  assert.equal(parsed.estimate.confidence, "high");
  assert.ok(typeof parsed.updated_at === "string");
  assert.equal(getFtpMeta().source, "ai_coach");
  // 重复调用：估算与当前一致（diff=0）→ no_change 拒绝（幂等闸）
  const again = JSON.parse(await executeTool("update_ftp", {}, { lang: "zh" }));
  assert.equal(again.applied, false);
  assert.match(again.reason, /无需更新/);
});

test("reanalyze_activity：file_name 校验/缺失拒绝；FTP 变更后重算写回并返回新旧对比", async () => {
  // 不存在 / 路径穿越
  const missing = JSON.parse(await executeTool("reanalyze_activity", { file_name: "x.fit" }, { lang: "zh" }));
  assert.match(missing.error, /找不到/);
  const evil = JSON.parse(await executeTool("reanalyze_activity", { file_name: "../etc/passwd" }, { lang: "zh" }));
  assert.match(evil.error, /非法/);

  // 60s 骑行入库于出厂 FTP 106；update_ftp 放行测试已把 FTP 写成 124 → 重算必有数值变化
  const prev = getActivitySummary(RIDE_NAME);
  const raw = await executeTool("reanalyze_activity", { file_name: RIDE_NAME }, { lang: "zh" });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.file_name, RIDE_NAME);
  assert.equal(parsed.ftp_used, 124);
  assert.equal(parsed.changes.tss.old, prev.power.tss);
  assert.notEqual(parsed.changes.tss.new, prev.power.tss);
  assert.ok(parsed.changes.intensity_factor);
  // 写回生效：库内 tss 与对比项一致
  const after = getActivitySummary(RIDE_NAME);
  assert.equal(after.power.tss, parsed.changes.tss.new);
  assert.equal(after.athlete_context.ftp_watts, 124);
  // 当日 CTL/ATL/TSB 两段式注入
  assert.ok(parsed.form && Number.isFinite(parsed.form.ctl));
});
