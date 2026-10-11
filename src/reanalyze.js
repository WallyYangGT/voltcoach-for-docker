/**
 * reanalyze.js — 从已存逐秒记录按当前骑手参数重建训练 summary（纯函数、无 IO）。
 * 自 VoltCoach src/core/reanalyze.ts 逐字转 JS（AI 自动采纳 FTP 能力包回同步）。
 *
 * 背景：FIT 原始字节不落盘（只有 records CSV），FTP/最大心率/体重变更后无法对
 * 历史训练直接重跑 analyzeFile。本模块以「overlay 口径」重建：records 无损往返
 * （CSV 列里的功率/心率/踏频均为整数通道，往返零漂移），因此凡 f(records) 或
 * f(records, athlete) 的字段重算后与原管线同源同值、参数不变时幂等；FIT 消息层
 * 才有的信息（lap 段、swim、开发者字段、设备爬升、暂停事件判据）与参数无关字段
 * 从旧 summary 继承。
 *
 * 入库（upsertActivity）与当日 CTL/ATL/TSB 注入由调用方（tools.js 的
 * reanalyze_activity 工具）负责，本模块只做纯计算。
 */

import {
  cadencePowerAnalysis,
  detectIntervals,
  estimateFtp,
  fillShortGaps,
  zoneDistribution,
} from "../index.js";
import { PEAK_CURVE, HR_ZONES, POWER_ZONES } from "./settings.js";

/** segments 里自动识别的间歇段特征（IntervalItem 必有 start/pct_ftp 键；lap 段两者皆无） */
const isIntervalItem = (s) => "start" in s || "pct_ftp" in s;

/**
 * 从已存 records 按当前骑手参数重建 summary。
 *
 * 重算（f(records, athlete)）：功率 IF/TSS/区间分布/单次 FTP 估算/w_per_kg、
 * 心率区间分布、间歇识别与组统计（阈值 1.05×FTP）、踏频-功率分析（门槛
 * 0.75×FTP，骑行专属）、athlete_context 三参数。
 * 继承（FIT 消息层信息或参数无关）：activity 全部、NP/avg/max/VI/峰曲线、
 * 心率 avg/max/漂移、踏频均值、pace/temperature/swim/developer_fields/climbs、
 * anomalies、data_quality、segments 中的 lap 段。
 *
 * @param {Array} records 已存逐秒记录（1s 网格形状：timestamp/power/heart_rate/
 *                        cadence/altitude/speed/distance/temperature；由调用方从
 *                        records CSV 全量行适配）
 * @param {object} prev 库内现有 summary（getActivitySummary 的输出，含 category/note 合并）
 * @param {object} athlete 当前生效骑手参数 { ftp_watts, max_hr, weight_kg }
 * @returns {object} 重建后的 summary
 */
export function rebuildSummaryFromRecords(records, prev, athlete) {
  // 深拷贝起底：summary 本就是 JSON 可序列化结构，JSON 往返即安全克隆
  const out = JSON.parse(JSON.stringify(prev));

  // ---- 骑手参数三件套覆盖（form 字段随 prev 带入，入库后两段式重注） ----
  out.athlete_context = {
    ...out.athlete_context,
    ftp_watts: athlete.ftp_watts,
    max_hr: athlete.max_hr,
    weight_kg: athlete.weight_kg,
  };

  // ---- 心率区间分布（f(records, max_hr)；avg/max/漂移参数无关，继承） ----
  out.heart_rate = {
    ...out.heart_rate,
    zone_distribution_pct: zoneDistribution(
      records.map((r) => r.heart_rate),
      HR_ZONES,
      athlete.max_hr,
    ),
  };

  // ---- 功率块（全程无功率的运动没有 power 段，跳过） ----
  if (prev.power) {
    const powers = records.map((r) => r.power);
    const np = prev.power.normalized_power; // f(records) 参数无关 → 继承
    const durationSec = prev.activity.duration_sec; // 网格秒数−暂停秒数，records 未变 → 继承
    const ifactor =
      np && athlete.ftp_watts
        ? Math.round((np / athlete.ftp_watts) * 100) / 100
        : null;
    const tss =
      np && ifactor
        ? Math.round(((durationSec * np * ifactor) / (athlete.ftp_watts * 3600)) * 100)
        : null;
    const powersFilled = fillShortGaps(powers, PEAK_CURVE.max_interp_gap_sec);
    out.power = {
      ...prev.power,
      intensity_factor: ifactor,
      tss,
      w_per_kg_avg: prev.power.avg
        ? Math.round((prev.power.avg / athlete.weight_kg) * 100) / 100
        : null,
      ftp_estimate: estimateFtp(powersFilled, athlete) ?? undefined,
      zone_distribution_pct: zoneDistribution(powers, POWER_ZONES, athlete.ftp_watts),
    };
    // 时长不足 20 分钟无估算 → 删键（口径同 analyzeFile 收尾）
    if (out.power.ftp_estimate == null) delete out.power.ftp_estimate;
  }

  // ---- 间歇段与组统计（识别阈值 1.05×FTP → 随 FTP 重算）；lap 段来自 FIT 消息，继承 ----
  const intervalResult = detectIntervals(records, athlete);
  const laps = (prev.segments ?? []).filter((s) => !isIntervalItem(s));
  const segments = [...laps, ...(intervalResult?.intervals ?? [])];
  if (segments.length) out.segments = segments;
  else delete out.segments;
  if (intervalResult?.interval_set) out.interval_set = intervalResult.interval_set;
  else delete out.interval_set;

  // ---- 踏频-功率联合分析（骑行专属口径，发力门槛 0.75×FTP）；非骑行保持原样 ----
  if (prev.activity.sport === "cycling") {
    const cadencePower = cadencePowerAnalysis(records, athlete) ?? undefined;
    if (cadencePower) out.cadence_power = cadencePower;
    else delete out.cadence_power;
  }

  return out;
}
