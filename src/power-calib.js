/**
 * power-calib.js — 功率可信度的编排层（v2，自 VoltCoach src/services/power-calib.ts
 * 回同步；旧仓无 services 层，直调 db/records/reanalyze）
 *
 * 两个入口（均由 AI 经工具层或用户在 Web 详情页触发）：
 *  - setPowerFlagAndRefresh：标记/取消某骑行「功率不可信」→ 训练档案即时重建
 *    （被标记骑行从功率派生基线排除，口径见 src/dossier.js）。可逆操作。
 *  - recalibrateActivityPower：按系数缩放重算单骑全部功率派生指标并写回——
 *    复用 reanalyze 的 powerScale 口径（NP/avg/max/VI/峰曲线入重算集、爬坡/圈
 *    均值线性换算），入库与 form 注入照 import 两段式；逐秒原始数据不改写
 *    （重导原 FIT 或换系数重跑即可回退）；系数夹逼到 POWER_CALIBRATION 界限并
 *    在结果中如实回报是否被夹逼。
 */

import path from "node:path";
import { POWER_CALIBRATION } from "./settings.js";
import { rebuildSummaryFromRecords } from "./reanalyze.js";
import { loadAllRecords } from "./records.js";
import {
  computeForm,
  getActivityFileName,
  getActivitySummary,
  getAthleteState,
  rebuildDossierQuietly,
  setActivityPowerFlag,
  updateActivitySummary,
} from "./db.js";
import { t } from "./i18n.js";

function outputDir() {
  return path.resolve(process.env.FIT_OUTPUT_DIR || "output");
}

/** 标记/取消功率不可信并重建档案（可逆；不滚任何快照——旧仓无本地快照） */
export function setPowerFlagAndRefresh(uuid, flagged, lang = "zh", reason = null) {
  const r = setActivityPowerFlag(uuid, flagged, lang);
  rebuildDossierQuietly();
  return {
    ok: true,
    uuid: r.uuid,
    file_name: getActivityFileName(r.uuid),
    flagged: r.flagged,
    reason: reason ?? null,
    dossier_updated: true,
  };
}

/** 旧→新对比项（仅记录确实变化的字段，避免结果膨胀） */
const pushChange = (changes, key, a, b) => {
  if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null))
    changes[key] = { old: a ?? null, new: b ?? null };
};

/** 对比新旧 summary 的校准敏感字段（缩放重算集：功率派生全量） */
function diffSummaries(prev, rebuilt) {
  const changes = {};
  pushChange(changes, "normalized_power", prev.power?.normalized_power, rebuilt.power?.normalized_power);
  pushChange(changes, "avg_power", prev.power?.avg, rebuilt.power?.avg);
  pushChange(changes, "max_power", prev.power?.max, rebuilt.power?.max);
  pushChange(changes, "peak_curve", prev.power?.peak_curve, rebuilt.power?.peak_curve);
  pushChange(changes, "tss", prev.power?.tss, rebuilt.power?.tss);
  pushChange(changes, "intensity_factor", prev.power?.intensity_factor, rebuilt.power?.intensity_factor);
  pushChange(changes, "power_zone_distribution_pct", prev.power?.zone_distribution_pct, rebuilt.power?.zone_distribution_pct);
  pushChange(changes, "calibration_scale", prev.power?.calibration_scale, rebuilt.power?.calibration_scale);
  pushChange(changes, "w_per_kg_avg", prev.power?.w_per_kg_avg, rebuilt.power?.w_per_kg_avg);
  pushChange(changes, "ftp_estimate", prev.power?.ftp_estimate, rebuilt.power?.ftp_estimate);
  pushChange(changes, "interval_set", prev.interval_set, rebuilt.interval_set);
  pushChange(changes, "cadence_power", prev.cadence_power, rebuilt.cadence_power);
  pushChange(changes, "climbs_avg_power", prev.climbs, rebuilt.climbs);
  return changes;
}

/**
 * 按系数缩放重算一次训练的功率派生指标并写回。活动行不存在/无功率/缺逐秒
 * 数据抛双语 Error（工具层兜为 {error}）；系数夹逼到 POWER_CALIBRATION 界限。
 */
export function recalibrateActivityPower(uuid, scaleFactor, lang = "zh") {
  const prev = getActivitySummary(uuid);
  const fileName = getActivityFileName(uuid);
  if (!prev) throw new Error(t(lang, "tool.summary_not_found", { name: fileName ?? uuid }));
  if (!prev.power)
    throw new Error(t(lang, "tool.no_power_data", { name: fileName ?? uuid }));
  const records = loadAllRecords(uuid, { outputDir: outputDir() });
  if (!records)
    throw new Error(t(lang, "tool.records_not_found", { name: fileName ?? uuid }));

  const requestedScale = Number(scaleFactor);
  if (!Number.isFinite(requestedScale))
    throw new Error(t(lang, "tool.scale_invalid"));
  const scaleApplied = Math.min(
    POWER_CALIBRATION.max_scale,
    Math.max(POWER_CALIBRATION.min_scale, requestedScale),
  );
  const athlete = getAthleteState().athlete;
  const rebuilt = rebuildSummaryFromRecords(records, prev, athlete, {
    powerScale: scaleApplied,
  });
  // category/note/power_flagged 是 activities 列属数据（读取时由 db 层合并回填），
  // 不落 summary_json——原样写回会把用户随后清除的备注"复活"
  delete rebuilt.activity.category;
  delete rebuilt.activity.note;
  delete rebuilt.activity.power_flagged;

  // 写回 + 注入当日 CTL/ATL/TSB 后终版再写回（两段式，口径同导入管线）
  updateActivitySummary(uuid, rebuilt);
  const form = computeForm(rebuilt.activity.date);
  if (form) {
    Object.assign(rebuilt.athlete_context, form);
    updateActivitySummary(uuid, rebuilt);
  }
  rebuildDossierQuietly(); // 功率基线变了，档案立即对齐

  return {
    ok: true,
    uuid,
    file_name: fileName,
    date: rebuilt.activity.date,
    sport: rebuilt.activity.sport,
    scale_requested: requestedScale,
    scale_applied: scaleApplied,
    changes: diffSummaries(prev, rebuilt),
    form: form ? { ctl: form.ctl, atl: form.atl, tsb: form.tsb } : null,
  };
}
