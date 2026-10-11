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
const { closeDb } = await import("../src/db.js");

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
