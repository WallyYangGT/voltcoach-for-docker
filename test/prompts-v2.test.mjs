/**
 * prompts-v2.test.mjs — v2 提示词层回归：档案段 / 记忆分层·策略权威段 /
 * agentic 新工具清单与 activity_id 口径。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgenticSection,
  buildDossierSection,
  buildMemorySection,
  buildReviewPrompt,
} from "../src/prompts.js";

function dossier() {
  return {
    generated_at: "2026-10-20T00:00:00.000Z",
    anchor_date: "2026-10-20",
    ftp_watts: 200,
    cycling: { considered: 12, with_power: 10, flagged_excluded: 2, total_flagged: 3 },
    peak_power: {
      all_time: [
        { window: "5s", value_w: 900 },
        { window: "5min", value_w: 300 },
      ],
      last_90d: [{ window: "5min", value_w: 280 }],
    },
    climb_profile: {
      climbs_analyzed: 4,
      median_grade_pct: 6.2,
      median_pct_ftp: 92.5,
      median_avg_hr: 165,
    },
    cadence_profile: {
      rides_analyzed: 10,
      style_counts: { low: 2, normal: 7, high: 1 },
    },
    intensity_structure: {
      zone_pct: { Z1: 10, Z2: 50, Z3: 20, Z4: 15, Z5: 5 },
      hr_zone_pct: { Z1: 20, Z2: 40, Z3: 20, Z4: 15, Z5: 5 },
      intensity_types: [{ month: "2026-10", type: "pyramidal" }],
    },
    load_shape: {
      weeks: Array.from({ length: 8 }, (_, i) => ({
        start: `2026-09-0${i + 1}`,
        end: `2026-09-0${i + 7}`,
        tss: 100 + i,
        duration_sec: 3600,
        rides: 2,
      })),
      hr_drift: { median_pct: 3.2, rides: 11 },
    },
  };
}

test("buildDossierSection：无档案返回 null；有档案渲染峰功率/爬坡/踏频/分区/负荷/标记披露", () => {
  assert.equal(buildDossierSection(null), null);
  const s = buildDossierSection(dossier(), "zh");
  assert.match(s, /个人训练档案/);
  assert.match(s, /近 90 天 12 次骑行（10 次带功率）/);
  assert.match(s, /5s 900 \/ 1min — \/ 5min 300 \/ 20min —/);
  assert.match(s, /爬坡画像（4 段中位）/);
  assert.match(s, /踏频风格/);
  assert.match(s, /Z1–Z2 60%、Z3–Z4 35%、Z5–Z7 5%/);
  assert.match(s, /心率强度结构/);
  assert.match(s, /2026-10 pyramidal/);
  assert.match(s, /近 8 周负荷/);
  assert.match(s, /心率漂移中位 3.2%/);
  assert.match(s, /3 次骑行被标记功率不可信/);
});

test("buildMemorySection：策略条目置顶为权威段，短期条目标注，规则含 scope/strategy 口径", () => {
  const s = buildMemorySection(
    [
      { id: 3, content: "用户目标 granfondo", category: "goal", created_at: "2026-10-03 09:00:00" },
      { id: 2, content: "每周三固定甜区课", category: "strategy", created_at: "2026-10-02 09:00:00" },
      { id: 1, content: "下周出差只能骑台子", category: "schedule", scope: "short", created_at: "2026-10-01 09:00:00" },
    ],
    "zh",
  );
  assert.match(s, /## 训练策略（既定结论）/);
  assert.match(s, /每周三固定甜区课/);
  assert.match(s, /这与既定策略不同/);
  assert.ok(s.indexOf("训练策略（既定结论）") < s.indexOf("## 用户记忆"), "策略段应置顶");
  assert.match(s, /短期/);
  assert.match(s, /scope='short'/);
  assert.match(s, /category='strategy'/);
});

test("buildAgenticSection：新工具与 activity_id 口径进入工具指引", () => {
  const zh = buildAgenticSection("zh");
  assert.match(zh, /get_dossier/);
  assert.match(zh, /set_power_flag/);
  assert.match(zh, /recalibrate_activity_power/);
  assert.match(zh, /activity_id/);
  assert.deepEqual(
    ["get_dossier", "set_power_flag", "recalibrate_activity_power"].filter(
      (x) => !zh.includes(x),
    ),
    [],
  );
  const en = buildAgenticSection("en");
  assert.match(en, /get_dossier/);
  assert.match(en, /activity_id/);
});

test("buildReviewPrompt：档案段注入在训练数据之前", () => {
  const summary = {
    activity: { date: "2026-10-20", sport: "cycling", duration_sec: 3600, distance_km: 30 },
    power: { normalized_power: 200, intensity_factor: 1, tss: 100 },
  };
  const prompt = buildReviewPrompt(
    summary,
    { identity: "上班族", goal: "提升 FTP" },
    null,
    "zh",
    new Date("2026-10-20T08:00:00Z"),
    buildDossierSection(dossier(), "zh"),
  );
  assert.match(prompt, /个人训练档案/);
  assert.ok(prompt.indexOf("个人训练档案") < prompt.indexOf("```json"));
});
