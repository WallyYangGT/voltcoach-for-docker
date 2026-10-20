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
 * 入库（updateActivitySummary）与当日 CTL/ATL/TSB 注入由调用方（tools.js 的
 * reanalyze_activity 工具 / power-calib.js）负责，本模块只做纯计算。
 */

import {
  avgField,
  cadencePowerAnalysis,
  detectIntervals,
  estimateFtp,
  fillShortGaps,
  maxField,
  normalizedPower,
  peakAvg,
  pedalTimeBreakdown,
  detectStationarySpans,
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
 * @param {{ powerScale?: number }} [opts] 功率校准系数（可选；夹逼界限由服务层执行）
 * @returns {object} 重建后的 summary
 */
export function rebuildSummaryFromRecords(records, prev, athlete, opts = {}) {
  // 深拷贝起底：summary 本就是 JSON 可序列化结构，JSON 往返即安全克隆
  const out = JSON.parse(JSON.stringify(prev));

  // ---- 功率缩放源记录（仅功率通道换算；心率/踏频/海拔等其余通道原样） ----
  // 系数优先级与重算开关：
  //  - 显式 opts.powerScale（含 1 = 撤销校准）：一律按该系数重算全部功率派生字段
  //    ——撤销时必须把上一轮的缩放 NP/峰曲线重算回未缩放值，只清留痕会留下混排；
  //  - 未显式传参：回退 summary 留痕 prev.power.calibration_scale（校准是持久口径，
  //    无参重建必须沿用，否则缩放值与未缩放值混排）；
  //  - 都没有：维持原口径（继承 NP/峰曲线，逐字等价旧行为）。
  //  非法显式值（0/负/NaN）按无操作处理（保守不猜）。
  const explicit = opts?.powerScale;
  const hasExplicit = explicit !== undefined;
  const explicitValid =
    hasExplicit && typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0;
  const inheritedScale = prev.power?.calibration_scale;
  const hasInherited =
    !hasExplicit &&
    typeof inheritedScale === "number" &&
    Number.isFinite(inheritedScale) &&
    inheritedScale > 0 &&
    inheritedScale !== 1;
  const recompute = explicitValid || hasInherited; // 功率派生字段是否重算
  const scale = explicitValid ? explicit : hasInherited ? inheritedScale : 1;
  const hasScale = scale !== 1; // 逐秒记录是否换算（撤销=1 时不换算只重算）
  // prev 里的爬坡/圈均值已经是上一轮系数（prevScale）缩放过的派生值；本轮对它们
  // 的换算系数是 scale / prevScale（不是 scale）——否则「无参重建沿用旧系数」会
  // 二次缩放，显式撤销（scale=1）也回不到未缩放值。
  // 注：这是对主仓 core/reanalyze.ts 同款隐患的下游修正；回同步主仓时须带上本段
  // 与 test/reanalyze-scale.test.mjs，避免两仓对同一校准库的重算结果分叉。
  const prevScale =
    typeof prev.power?.calibration_scale === "number" &&
    Number.isFinite(prev.power.calibration_scale) &&
    prev.power.calibration_scale > 0
      ? prev.power.calibration_scale
      : 1;
  const derivedFactor = recompute ? scale / prevScale : 1;
  const src = hasScale
    ? records.map((r) => (r.power == null ? r : { ...r, power: r.power * scale }))
    : records;

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
      src.map((r) => r.heart_rate),
      HR_ZONES,
      athlete.max_hr,
    ),
  };

  // ---- 功率块（全程无功率的运动没有 power 段，跳过） ----
  if (prev.power) {
    const powers = src.map((r) => r.power);
    const powersFilled = fillShortGaps(powers, PEAK_CURVE.max_interp_gap_sec);
    // 默认（未缩放）：NP/avg/max/峰曲线是 f(records) 参数无关 → 继承；
    // 缩放时随记录线性变化 → 重算（与 analyzeFile 直跑同代码路径，结果同源同值）
    const np = recompute ? normalizedPower(powers) : prev.power.normalized_power;
    // 均值取整口径对齐 analyzeFile 的 avg 助手（1 位小数，193.3 而非 193）
    const avgPower = recompute ? avgField(src, "power", 1) : prev.power.avg;
    const maxPower = recompute ? maxField(src, "power") : prev.power.max;
    let peakCurve = null;
    if (recompute) {
      peakCurve = {};
      for (const [label, sec] of [
        ["5s", 5],
        ["1min", 60],
        ["5min", 300],
        ["20min", 1200],
      ]) {
        const p = peakAvg(powersFilled, sec);
        if (p != null) peakCurve[label] = p;
      }
    }
    const durationSec = prev.activity.duration_sec; // 网格秒数−暂停秒数，records 未变 → 继承
    const ifactor =
      np && athlete.ftp_watts
        ? Math.round((np / athlete.ftp_watts) * 100) / 100
        : null;
    const tss =
      np && ifactor
        ? Math.round(((durationSec * np * ifactor) / (athlete.ftp_watts * 3600)) * 100)
        : null;
    out.power = {
      ...prev.power,
      ...(recompute
        ? {
            avg: avgPower,
            normalized_power: np,
            max: maxPower,
            peak_curve: peakCurve,
            variability_index:
              np && avgPower ? Math.round((np / avgPower) * 100) / 100 : null,
          }
        : {}),
      intensity_factor: ifactor,
      tss,
      w_per_kg_avg: avgPower
        ? Math.round((avgPower / athlete.weight_kg) * 100) / 100
        : null,
      ftp_estimate: estimateFtp(powersFilled, athlete) ?? undefined,
      zone_distribution_pct: zoneDistribution(powers, POWER_ZONES, athlete.ftp_watts),
    };
    // 时长不足 20 分钟无估算 → 删键（口径同 analyzeFile 收尾）
    if (out.power.ftp_estimate == null) delete out.power.ftp_estimate;
    // 校准口径留痕：重算时按生效系数落痕；显式撤销（scale=1）清掉历史留痕
    if (recompute) {
      if (scale === 1) delete out.power.calibration_scale;
      else out.power.calibration_scale = scale;
    }
  }

  // ---- 爬坡段：段边界由海拔/距离决定不受影响，段内均值功率按上一轮派生值
  // 的系数比（scale / prevScale）线性换算；撤销与换系数都能回到正确口径 ----
  if (derivedFactor !== 1 && out.climbs?.length) {
    out.climbs = out.climbs.map((c) => ({
      ...c,
      avg_power:
        typeof c.avg_power === "number"
          ? Math.round(c.avg_power * derivedFactor)
          : c.avg_power,
    }));
  }

  // ---- 间歇段与组统计（识别阈值 1.05×FTP → 随 FTP/缩放记录重算）；lap 段来自 FIT 消息，继承 ----
  const intervalResult = detectIntervals(src, athlete);
  const laps = (prev.segments ?? []).filter((s) => !isIntervalItem(s));
  // lap 段功率字段随缩放线性换算（段的圈定由 FIT lap 消息决定，不受影响）——
  // 漏换算会让提示词里同时出现缩放后的整体功率与未缩放的圈均功率
  const scaledLaps =
    derivedFactor !== 1
      ? laps.map((s) => {
          // 仅在源 lap 确有该数值字段时写键（直接展开+undefined 赋值会让
          // 「无功率 lap」平添 undefined 键，deepEqual 口径下与直跑结果不再相等）
          const o = { ...s };
          if (typeof o.avg_power === "number")
            o.avg_power = Math.round(o.avg_power * derivedFactor);
          if (typeof o.max_power === "number")
            o.max_power = Math.round(o.max_power * derivedFactor);
          return o;
        })
      : laps;
  const segments = [...scaledLaps, ...(intervalResult?.intervals ?? [])];
  if (segments.length) out.segments = segments;
  else delete out.segments;
  if (intervalResult?.interval_set) out.interval_set = intervalResult.interval_set;
  else delete out.interval_set;

  // ---- 踏频-功率联合分析（骑行专属口径，发力门槛 0.75×FTP）；非骑行保持原样 ----
  if (prev.activity.sport === "cycling") {
    const cadencePower = cadencePowerAnalysis(src, athlete) ?? undefined;
    if (cadencePower) out.cadence_power = cadencePower;
    else delete out.cadence_power;
  }

  // ---- 0W 根治披露字段回填（f(records) 参数无关，升级前入库的存量 summary 缺该键/
  // 该类异常——重建时按当前 records 补算，用户改 FTP 触发 reanalyze 即完成历史行追溯；
  // 先滤掉旧 stationary 条目再并入新识别结果，重复触发幂等） ----
  const pedal = pedalTimeBreakdown(src);
  if (pedal) out.pedal_time = pedal;
  else delete out.pedal_time;
  const stationary = detectStationarySpans(src);
  if (stationary.length) {
    const others = (out.anomalies ?? []).filter((a) => a.type !== "stationary");
    out.anomalies = [...others, ...stationary];
  }

  return out;
}
