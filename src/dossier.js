/**
 * dossier.js — 个人训练档案（纯函数层，无 IO、无第三方依赖；自 VoltCoach
 * src/core/dossier.ts 回同步）
 *
 * 目标：把逐次训练指标沉淀为一份可长期参考的骑手画像，随每次数据变更自动重建
 * （确定性计算，零 AI token），注入 AI 提示词让长期规划与单次分析都有历史基准
 * 可依。聚合全部在本层完成；展示文案由 prompts 层按语言拼装（与记忆段同口径）。
 *
 * 数据口径：
 *  - 90 天窗以「最新一次骑行日期」为锚（不用墙钟）：档案随数据自然滚动、结果
 *    可复现可测；周负荷窗口 = 结束于锚日的连续 8 周（每周 7 天，含锚日当周）；
 *  - 功率不可信骑行（activities.power_flagged，用户或 AI 教练标记）从一切
 *    功率派生基线中排除：峰功率、分区/强度结构、爬坡画像、踏频风格、周 TSS；
 *    但心率漂移与骑行时长仍采信——标记语义是"功率失真"而非"整趟作废"；
 *    排除量在 cycling 计数中披露，提示词侧据此提醒模型对比时的边界；
 *  - PB 并列时取更早的骑行（输入按日期升序遍历，严格大于才替换，天然保序）；
 *  - 中位数：偶数个取中间两数均值；分位字段缺失/空段不参与对应分位统计。
 */

/** 档案滚动窗（天）：以最新骑行日为锚的近 N 天（含锚日） */
export const DOSSIER_WINDOW_DAYS = 90;
/** 周负荷窗口周数：结束于锚日的连续 N 周 */
export const DOSSIER_LOAD_WEEKS = 8;

/** 峰功率窗口（与 summary.power.peak_curve 的 key 同源） */
export const PEAK_WINDOWS = ["5s", "1min", "5min", "20min"];

// ---------------- 日期小工具（全部 UTC 日历日口径，输入输出 YYYY-MM-DD） ----------------

const DAY_MS = 86400000;

export function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const r1 = (x) => Math.round(x * 10) / 10;

// ---------------- 档案聚合 ----------------

/**
 * 构建个人训练档案。无任何骑行数据时返回 null（提示词侧整段省略、UI 显示空态）。
 *
 * @param {Array} rides 全部活动（含非骑行；非骑行在本函数内忽略）——建议按 date
 *   升序传入，PB 并列时即取最早达成者。元素形状：
 *   { uuid, file_name, date, sport, power_flagged, duration_sec, tss, summary }
 * @param {number} ftp 当前生效 FTP（爬坡强度 %FTP 的分母；≤0 时强度分位为 null）
 * @param {Array} monthly 月度汇总透传（[{ month, type }]，强度类型）
 * @param {Date} now 生成时刻（仅写进 generated_at，不参与聚合——聚合只看数据锚点）
 */
export function buildDossier(rides, ftp, monthly, now) {
  const cycling = (rides ?? []).filter((r) => r?.sport === "cycling");
  if (!cycling.length) return null;

  const anchor = cycling.reduce((max, r) => (r.date > max ? r.date : max), cycling[0].date);
  const windowStart = addDaysStr(anchor, -(DOSSIER_WINDOW_DAYS - 1));
  const inWindow = (r) => r.date >= windowStart;
  const powerUsable = (r) => !r.power_flagged && r.summary?.power != null;

  // ---- 峰功率基线（历史 PB + 近 90 天；排除功率不可信） ----
  const allTime = new Map();
  const recent = new Map();
  for (const r of cycling) {
    if (!powerUsable(r)) continue;
    const curve = r.summary?.power?.peak_curve ?? {};
    for (const w of PEAK_WINDOWS) {
      const v = curve[w];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      const entry = {
        window: w,
        value_w: Math.round(v),
        date: r.date,
        uuid: r.uuid,
        file_name: r.file_name,
      };
      const cur = allTime.get(w);
      if (!cur || entry.value_w > cur.value_w) allTime.set(w, entry);
      if (inWindow(r)) {
        const curR = recent.get(w);
        if (!curR || entry.value_w > curR.value_w) recent.set(w, entry);
      }
    }
  }
  const toEntries = (m) => PEAK_WINDOWS.filter((w) => m.has(w)).map((w) => m.get(w));

  // ---- 爬坡画像（90 天窗、功率可用骑行的全部爬坡段；逐分位独立取中位） ----
  const grades = [];
  const pcts = [];
  const hrs = [];
  for (const r of cycling) {
    if (!powerUsable(r) || !inWindow(r)) continue;
    for (const c of r.summary?.climbs ?? []) {
      grades.push(c.avg_grade_pct);
      if (ftp > 0 && typeof c.avg_power === "number") pcts.push((c.avg_power / ftp) * 100);
      if (typeof c.avg_hr === "number") hrs.push(c.avg_hr);
    }
  }

  // ---- 踏频风格画像（90 天窗、功率可用——踏频-功率分析的门槛以功率为准） ----
  const style = { low: 0, normal: 0, high: 0 };
  let cadenceRides = 0;
  for (const r of cycling) {
    if (!powerUsable(r) || !inWindow(r)) continue;
    const cp = r.summary?.cadence_power;
    if (!cp) continue;
    cadenceRides += 1;
    if (cp.style === "low_cadence") style.low += 1;
    else if (cp.style === "high_cadence") style.high += 1;
    else if (cp.style === "normal") style.normal += 1;
  }

  // ---- 强度结构（90 天窗按骑行时长加权；时长缺失的骑行无法加权，跳过）。
  // 已知口径边界（留档）：分区占比在有功率的秒上归一，功率覆盖率低的骑行会被
  // 时长权重高估——精确权重应改用 power_coverage_pct × duration 或
  // pedal_time.sample_sec，牵动黄金口径前维持简单加权。 ----
  const zoneSec = {};
  let zoneWeightSec = 0;
  for (const r of cycling) {
    if (!powerUsable(r) || !inWindow(r)) continue;
    const dist = r.summary?.power?.zone_distribution_pct;
    if (!dist || r.duration_sec == null || r.duration_sec <= 0) continue;
    for (const [z, pct] of Object.entries(dist)) {
      if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
      zoneSec[z] = (zoneSec[z] ?? 0) + (pct / 100) * r.duration_sec;
    }
    zoneWeightSec += r.duration_sec;
  }
  const zonePct =
    zoneWeightSec > 0
      ? Object.fromEntries(
          Object.entries(zoneSec).map(([z, sec]) => [z, r1((sec / zoneWeightSec) * 100)]),
        )
      : null;

  // ---- 心率强度结构（单锚点降级：功率不可用骑行按心率五区聚合，时长加权） ----
  // 功率可用骑行不进此口径（已计入 zone_pct）；功率被标记不可信的骑行功率作废、
  // 心率仍可信，因此进入 HR 口径。无心率分布数据的骑行跳过。
  const hrZoneSec = {};
  let hrZoneWeightSec = 0;
  for (const r of cycling) {
    if (!inWindow(r) || powerUsable(r)) continue;
    const dist = r.summary?.heart_rate?.zone_distribution_pct;
    if (!dist || r.duration_sec == null || r.duration_sec <= 0) continue;
    for (const [z, pct] of Object.entries(dist)) {
      if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
      hrZoneSec[z] = (hrZoneSec[z] ?? 0) + (pct / 100) * r.duration_sec;
    }
    hrZoneWeightSec += r.duration_sec;
  }
  const hrZonePct =
    hrZoneWeightSec > 0
      ? Object.fromEntries(
          Object.entries(hrZoneSec).map(([z, sec]) => [z, r1((sec / hrZoneWeightSec) * 100)]),
        )
      : null;

  // ---- 周负荷（结束于锚日的连续 8 周；TSS 剔除功率不可信，时长全采信） ----
  const weeks = [];
  for (let k = DOSSIER_LOAD_WEEKS - 1; k >= 0; k -= 1) {
    const end = addDaysStr(anchor, -7 * k);
    weeks.push({ start: addDaysStr(end, -6), end, tss: 0, duration_sec: 0, rides: 0 });
  }
  for (const r of cycling) {
    const wk = weeks.find((w) => r.date >= w.start && r.date <= w.end);
    if (!wk) continue;
    wk.rides += 1;
    wk.duration_sec += r.duration_sec ?? 0;
    if (!r.power_flagged && r.tss != null) wk.tss += r.tss;
  }
  for (const w of weeks) w.tss = Math.round(w.tss);

  // ---- 心率漂移基线（90 天窗，含功率不可信骑行——心率不受功率失真影响） ----
  const drifts = [];
  for (const r of cycling) {
    if (!inWindow(r)) continue;
    const d = r.summary?.heart_rate?.hr_drift_pct;
    if (typeof d === "number" && Number.isFinite(d)) drifts.push(d);
  }

  const flaggedAll = cycling.filter((r) => r.power_flagged).length;
  const windowRides = cycling.filter(inWindow);
  const windowUnflagged = windowRides.filter((r) => !r.power_flagged);

  return {
    generated_at: now.toISOString(),
    anchor_date: anchor,
    ftp_watts: ftp,
    cycling: {
      considered: windowUnflagged.length,
      with_power: windowUnflagged.filter((r) => r.summary?.power != null).length,
      flagged_excluded: windowRides.length - windowUnflagged.length,
      total_flagged: flaggedAll,
    },
    peak_power: { all_time: toEntries(allTime), last_90d: toEntries(recent) },
    climb_profile: {
      climbs_analyzed: grades.length,
      median_grade_pct: median(grades) == null ? null : r1(median(grades)),
      median_pct_ftp: median(pcts) == null ? null : r1(median(pcts)),
      median_avg_hr: median(hrs) == null ? null : Math.round(median(hrs)),
    },
    cadence_profile: { rides_analyzed: cadenceRides, style_counts: style },
    intensity_structure: {
      zone_pct: zonePct,
      hr_zone_pct: hrZonePct,
      intensity_types: (monthly ?? [])
        .filter((m) => m.type)
        .slice(0, 6)
        .map((m) => ({ month: m.month, type: m.type })),
    },
    load_shape: {
      weeks,
      hr_drift: {
        median_pct: median(drifts) == null ? null : r1(median(drifts)),
        rides: drifts.length,
      },
    },
  };
}
