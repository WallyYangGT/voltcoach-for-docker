/**
 * ftp.js
 * FTP 历史估算（纯函数、无 IO）：基于最近窗口期内全部骑行训练的
 * 功率峰曲线 + 心率响应做联合估算，给出估值、置信度与数据收集建议。
 *
 * 科学参照：
 *   1. 双参数临界功率模型（Morton CP/W′ 模型）：
 *      P(t) = CP + W′/t，用 5min 与 20min 两个锚点解出 CP ≈ FTP；
 *   2. Coggan《Training and Racing with a Power Meter》：
 *      FTP ≈ 20 分钟峰功率 × 0.95；
 *   3. 心率交叉验证：全力 20min 测试心率峰值应接近 LTHR/HRmax 高位；
 *      功率区间与心率区间的系统性偏移提示 FTP 配置漂移；
 *      有氧解耦（hr drift）> 5% 提示疲劳/脱水/高温导致的数据漂移。
 */

import { FTP_ESTIMATION } from "./settings.js";
import { t } from "./i18n.js";

/** 中位数（输入可含 null，自动过滤；空数组返回 null） */
function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * 从历史骑行估算 FTP。
 * @param {Array} activities 窗口内骑行（db.cyclingSummariesSince 的输出）：
 *   [{ file_name, date, duration_sec, summary }]
 * @param {object} athlete 骑手参数（ATHLETE：ftp_watts / max_hr）
 * @param {object} cfg 阈值配置（默认 settings.js 的 FTP_ESTIMATION）
 * @param {string} [lang] 消息语言（zh/en，默认 zh；zh 与历史逐字一致）
 * @returns {{status: string, estimate: object|null, data_needs: string[], notes: string[]}}
 */
export function estimateFtpFromHistory(
  activities,
  athlete,
  cfg = FTP_ESTIMATION,
  lang = "zh",
) {
  const dataNeeds = [];
  const notes = [];
  const warnings = []; // 影响置信度的内部标记

  // ---- 1. 样本筛选：排除「功率不可信」标记，仅采信覆盖率达标且有 power 段的骑行 ----
  // 标记语义是功率失真（心率/时长仍可信），FTP 峰值法只依赖功率，故整趟剔除并在
  // data_needs 披露剔除数——模型不得手工折价估算（技能 06 口径）。
  const flagged = activities.filter((a) => a.power_flagged);
  const unflagged = activities.filter((a) => !a.power_flagged);
  const withPower = unflagged.filter((a) => a.summary?.power);
  const usable = withPower.filter(
    (a) =>
      (a.summary.data_quality?.power_coverage_pct ?? 100) >=
      cfg.min_coverage_pct,
  );
  const withHr = usable.filter(
    (a) =>
      a.summary?.heart_rate &&
      (a.summary.data_quality?.hr_coverage_pct ?? 0) >= cfg.min_coverage_pct,
  );
  const sample = {
    cycling_rides: activities.length,
    flagged_excluded: flagged.length,
    rides_with_power: withPower.length,
    usable_power_rides: usable.length,
    rides_with_hr: withHr.length,
  };

  if (flagged.length) {
    dataNeeds.push(t(lang, "ftp.flagged_excluded", { n: flagged.length }));
  }
  if (usable.length < cfg.min_rides) {
    dataNeeds.push(t(lang, "ftp.few_rides", { n: usable.length, min: cfg.min_rides }));
    warnings.push("few_rides");
  }
  if (usable.length && withHr.length < usable.length) {
    dataNeeds.push(
      t(lang, "ftp.hr_coverage", { n: withHr.length, total: usable.length }),
    );
    warnings.push("hr_coverage");
  }

  // ---- 2. 窗口内最佳 5min / 20min 峰功率（CP 模型与 Coggan 法的锚点） ----
  const bestPeak = (key) => {
    let best = null;
    for (const a of usable) {
      const w = a.summary.power.peak_curve?.[key];
      if (w == null) continue;
      if (!best || w > best.watts)
        best = { watts: w, date: a.date, uuid: a.uuid, file_name: a.file_name };
    }
    return best;
  };
  const p5 = bestPeak("5min");
  const p20 = bestPeak("20min");

  if (!p20) {
    dataNeeds.push(t(lang, "ftp.no_20min"));
    return {
      status: "insufficient",
      window_days: cfg.window_days,
      sample,
      estimate: null,
      data_needs: dataNeeds,
      notes,
      references: methodReferences(lang),
    };
  }

  // ---- 3. 方法一：双参数 CP 模型（Morton）：P(t) = CP + W′/t ----
  let cpModel = null;
  if (p5 && p5.watts > p20.watts) {
    const t1 = cfg.cp_short_sec,
      t2 = cfg.cp_long_sec;
    const cp = (p20.watts * t2 - p5.watts * t1) / (t2 - t1);
    if (cp > 0) {
      cpModel = {
        ftp_w: Math.round(cp),
        cp_w: Math.round(cp),
        w_prime_kj: r1(((p5.watts - cp) * t1) / 1000),
        p5,
        p20,
      };
    }
  }
  if (!cpModel) {
    notes.push(t(lang, "ftp.cp_unavailable"));
    warnings.push("single_method");
  } else {
    dataNeeds.push(t(lang, "ftp.cp_precision"));
  }

  // ---- 4. 方法二：Coggan 20min × 0.95 ----
  const coggan = {
    ftp_w: Math.round(p20.watts * cfg.coggan_factor),
    peak_20min_w: p20.watts,
    date: p20.date,
    uuid: p20.uuid,
    file_name: p20.file_name,
  };

  // ---- 5. 心率交叉验证 ----
  const hrCheck = {
    maximal_effort: null, // true=全力可信 / false=大概率非全力 / null=无心率无法判定
    best20_max_hr: null,
    threshold_hr: null,
    zone_mismatch: null,
    median_hr_drift_pct: null,
  };

  // 5a. 全力判定：20min 峰功率所在骑行的心率峰值是否达到全力阈值
  const anchor = usable.find((a) =>
    p20.uuid ? a.uuid === p20.uuid : a.file_name === p20.file_name,
  );
  const thresholdHr = Math.round(athlete.max_hr * cfg.max_effort_hr_pct);
  hrCheck.threshold_hr = thresholdHr;
  const anchorHr = anchor?.summary.heart_rate;
  if (
    anchorHr &&
    (anchor.summary.data_quality?.hr_coverage_pct ?? 0) >= cfg.min_coverage_pct
  ) {
    hrCheck.best20_max_hr = anchorHr.max ?? null;
    hrCheck.maximal_effort =
      hrCheck.best20_max_hr != null && hrCheck.best20_max_hr >= thresholdHr;
    if (!hrCheck.maximal_effort) {
      notes.push(
        t(lang, "ftp.not_maximal", {
          date: p20.date,
          hr: hrCheck.best20_max_hr,
          thr: thresholdHr,
        }),
      );
      dataNeeds.push(t(lang, "ftp.maximal_test"));
      warnings.push("not_maximal");
    }
  } else {
    notes.push(t(lang, "ftp.anchor_no_hr"));
    dataNeeds.push(t(lang, "ftp.anchor_hr"));
    warnings.push("not_maximal");
  }

  // 5b. 功率/心率区间一致性（时长加权）：系统性偏移提示 FTP 配置漂移
  let pHighSec = 0,
    hHighSec = 0,
    bothSec = 0;
  for (const a of withHr) {
    const dur = a.duration_sec ?? 0;
    const pz = a.summary.power?.zone_distribution_pct;
    const hz = a.summary.heart_rate?.zone_distribution_pct;
    if (!pz || !hz || dur <= 0) continue;
    pHighSec += ((pz.Z5 ?? 0) + (pz.Z6 ?? 0) + (pz.Z7 ?? 0)) * 0.01 * dur;
    hHighSec += ((hz.Z4 ?? 0) + (hz.Z5 ?? 0)) * 0.01 * dur;
    bothSec += dur;
  }
  if (bothSec > 0) {
    const pPct = r1((pHighSec / bothSec) * 100);
    const hPct = r1((hHighSec / bothSec) * 100);
    const diff = r1(pPct - hPct);
    let direction = "consistent";
    if (diff >= cfg.zone_mismatch_pct) {
      direction = "power_above_hr";
      notes.push(t(lang, "ftp.power_above_hr", { p: pPct, h: hPct }));
      warnings.push("zone_mismatch");
    } else if (diff <= -cfg.zone_mismatch_pct) {
      direction = "hr_above_power";
      notes.push(t(lang, "ftp.hr_above_power", { h: hPct, p: pPct }));
      warnings.push("zone_mismatch");
    }
    hrCheck.zone_mismatch = {
      power_high_pct: pPct,
      hr_high_pct: hPct,
      diff_pct: diff,
      direction,
    };
  }

  // 5c. 有氧解耦：心率漂移中位数超阈值 → 数据漂移提示
  const driftMedian = median(
    withHr.map((a) => a.summary.heart_rate?.hr_drift_pct),
  );
  hrCheck.median_hr_drift_pct = driftMedian != null ? r1(driftMedian) : null;
  if (driftMedian != null && driftMedian > cfg.drift_warn_pct) {
    notes.push(t(lang, "ftp.drift", { d: r1(driftMedian), t: cfg.drift_warn_pct }));
    warnings.push("drift");
  }

  // ---- 6. 合成估值与置信度 ----
  const ftps = [cpModel?.ftp_w, coggan.ftp_w].filter((x) => x != null);
  const ftpW = Math.round(ftps.reduce((a, b) => a + b, 0) / ftps.length);
  const rangeLow = Math.min(...ftps);
  const rangeHigh = Math.max(...ftps);
  const consistent =
    ftps.length === 2 &&
    (rangeHigh - rangeLow) / ftpW <= cfg.consistency_pct / 100;

  let confidence = "high";
  if (!consistent) warnings.push("inconsistent");
  if (warnings.includes("inconsistent") || warnings.includes("single_method"))
    confidence = "medium";
  if (
    warnings.includes("not_maximal") ||
    warnings.includes("zone_mismatch") ||
    warnings.includes("drift") ||
    warnings.includes("hr_coverage")
  )
    confidence = "medium";
  if (warnings.includes("few_rides")) confidence = "low";

  const estimate = {
    ftp_w: ftpW,
    range_low: rangeLow,
    range_high: rangeHigh,
    confidence,
    confidence_note: confidenceNote(confidence, lang),
    current_ftp_w: athlete.ftp_watts,
    diff_w: ftpW - athlete.ftp_watts,
    methods: {
      cp_model: cpModel,
      coggan_20min: coggan,
      hr_check: hrCheck,
    },
  };

  return {
    status: "ok",
    window_days: cfg.window_days,
    sample,
    estimate,
    data_needs: dataNeeds,
    notes,
    references: methodReferences(lang),
  };
}

function confidenceNote(c, lang) {
  return t(lang, `ftp.confidence.${c}`);
}

function methodReferences(lang) {
  return [0, 1, 2].map((i) => t(lang, `ftp.ref.${i}`));
}

// ---------------- AI 自动采纳门槛（evaluateFtpApply，自 VoltCoach core/ftp.ts 回同步） ----------------

/**
 * 从估算结果选定写入值（AI 教练在估算区间内自选 FTP，2026-10-20 §35）：
 * 缺省（requested 省略/非有限数）取估算器输出（两法均值）；给了 requested 时
 * **夹逼到本次估算区间 [range_low, range_high]**——模型只能在科学估算的区间内
 * 表达保守/激进的取舍，永远写不出区间外的值。写入前的 50–500W 采纳范围闸仍由
 * evaluateFtpApply 在最终值上执行。
 * @returns {{ftp_w:number, requested_w:number|null, clamped:boolean}|null}
 */
export function selectFtpFromEstimate(result, requested) {
  const e = result?.estimate;
  if (result?.status !== "ok" || !e) return null;
  if (requested == null || !Number.isFinite(requested)) {
    return { ftp_w: e.ftp_w, requested_w: null, clamped: false };
  }
  const want = Math.round(requested);
  const ftp_w = Math.min(Math.max(want, e.range_low), e.range_high);
  return { ftp_w, requested_w: want, clamped: ftp_w !== want };
}

/**
 * FTP 是否已校准（2026-10 §35 收紧）：有溯源戳（曾发生实际值变更）或当前值
 * ≠ 出厂默认值。旧版撤销的假戳（值=默认 + manual 戳 + 无待处理 AI 快照）
 * 在读取时归一化为未校准，不改写存量数据。
 */
export function isFtpCalibratedFrom(
  ftpWatts,
  ftpUpdatedAt,
  defaultFtpWatts,
  opts = {},
) {
  const stamped = typeof ftpUpdatedAt === "string" && ftpUpdatedAt.trim().length > 0;
  const valueCalibrated = Number(ftpWatts) !== Number(defaultFtpWatts);
  if (!valueCalibrated && stamped && opts?.source === "manual" && !opts?.hasAiUpdate) {
    return false;
  }
  return stamped || valueCalibrated;
}

/**
 * 「AI 教练自动更新 FTP」的采纳门槛（纯函数，从估算结果的结构化字段重新推导）。
 *
 * 与 Web 设置页的 UI 门控（仅 confidence === 'high'）刻意不同：置信度口径
 * 不动（避免牵动两仓同步的估算算法），但在这里按"该警告是否动摇估值本身"重新
 * 分级——zone_mismatch（功率-心率区间错位）/ drift / hr_coverage 是「当前 FTP 配置
 * 漂移」的信号、正是该更新的依据，由其降级的 medium 放行；而数据单薄（few_rides
 * →low）、两法互斥（inconsistent）、锚点明确非全力（not_maximal）才真正不可信，拦下。
 * 数值始终取估算器输出（调用方不给模型自定数值的入口），工具侧零参。
 *
 * @param {object} result estimateFtpFromHistory 的返回
 * @param {string|null} latestRideDate 窗口内最近一次骑行日期（YYYY-MM-DD；无骑行为 null）
 * @param {string} today 今日日期（YYYY-MM-DD，调用方注入以便测试）
 * @param {object} cfg 阈值配置（freshness_days 为 AI 采纳专属门槛）
 * @param {number|null} [chosenW] 自选后的最终写入值（缺省取 e.ftp_w，即两法均值）
 * @returns {{ok: boolean, reason_key: string|null, reason_vars?: object}}
 */
export function evaluateFtpApply(
  result,
  latestRideDate,
  today,
  cfg = FTP_ESTIMATION,
  chosenW = null,
) {
  const applyReject = (key, vars) => ({ ok: false, reason_key: key, ...(vars ? { reason_vars: vars } : {}) });
  const e = result.estimate;
  if (result.status !== "ok" || !e) return applyReject("ftp.apply.no_data");
  if (result.sample.usable_power_rides < cfg.min_rides)
    return applyReject("ftp.apply.few_rides", { min: cfg.min_rides });
  if (e.confidence === "low") return applyReject("ftp.apply.low_confidence");
  // 两法互斥：CP 模型可用时与 Coggan 法差超一致性阈值 → 估值本身不可信。
  // 分母与估算器 consistent 判定同口径（两法取整均值，即 e.ftp_w）
  const cp = e.methods.cp_model;
  if (cp && e.ftp_w > 0) {
    if (Math.abs(cp.ftp_w - e.methods.coggan_20min.ftp_w) / e.ftp_w > cfg.consistency_pct / 100)
      return applyReject("ftp.apply.inconsistent", { pct: cfg.consistency_pct });
  }
  // single_method（缺 5min 峰、仅 Coggan 法）放行：样本量已由 min_rides 把关。
  // 锚点"明确非全力"（有合格心率且未达全力线）才拦；无心率（null）不拦——
  // 峰值法只依赖功率，缺心率只是无法交叉验证（estimateFtpFromHistory 同口径）
  if (e.methods.hr_check.maximal_effort === false) return applyReject("ftp.apply.not_maximal");
  // 新鲜度：窗口内最近一次骑行距今天 ≤ freshness_days（天数按 UTC 日历日差）
  if (!latestRideDate) return applyReject("ftp.apply.stale", { n: cfg.freshness_days });
  const days = Math.round(
    (Date.parse(today + "T00:00:00Z") - Date.parse(latestRideDate + "T00:00:00Z")) / 86400000,
  );
  if (days > cfg.freshness_days) return applyReject("ftp.apply.stale", { n: cfg.freshness_days });
  // no_change 与 50–500W 范围闸按最终写入值判定（自选值可能不同于两法均值）
  const target = chosenW != null && Number.isFinite(chosenW) ? chosenW : e.ftp_w;
  if (target === e.current_ftp_w) return applyReject("ftp.apply.no_change");
  if (target < cfg.apply_min_w || target > cfg.apply_max_w)
    return applyReject("ftp.apply.range", { w: target, lo: cfg.apply_min_w, hi: cfg.apply_max_w });
  return { ok: true, reason_key: null };
}
