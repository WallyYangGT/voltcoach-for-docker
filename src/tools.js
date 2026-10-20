/**
 * tools.js
 * AI agentic 工具集（function calling）：工具 JSON schema 定义 + 参数校验 + 执行分发。
 * 三类工具：只读查询（调用 db.js/records.js，不重复实现查询逻辑）、纯计算
 * （simulate_form / generate_workout → src/planning.js）、写（save_memory /
 * set_power_flag / recalibrate_activity_power / update_ftp / reanalyze_activity）。
 *
 * v3 起活动句柄统一为 `activity_id`（32 位 uuid）：list_activities 返回它，
 * get_activity_summary / get_activity_records / reanalyze_activity 等按它取数；
 * `file_name` 只作为展示用的来源元数据返回。
 *
 * 双语：toolDefs(lang) 返回按语言本地化的工具 schema（描述随提示词语言切换）；
 * 执行层的错误消息经 src/i18n.js 按 ctx.lang（缺省 zh）生成。
 *
 * 约定：
 * - 所有工具返回 JSON 字符串；业务错误返回 {error: "..."} JSON，不抛异常中断
 *   agent 循环。
 * - 每个结果超过 AGENTIC.tool_result_max_chars 时截断并附"（结果已截断）"标记。
 */

import path from "node:path";
import {
  listActivities,
  getActivitySummary,
  getActivityFileName,
  recentFormDaily,
  monthlySummary,
  getAthleteState,
  getProfile,
  getDossier,
  cyclingSummariesSince,
  computeForm,
  saveMemory,
  setAthlete,
  setAiFtpUpdate,
  getFtpMeta,
  updateActivitySummary,
  rebuildDossierQuietly,
} from "./db.js";
import { compactSummaryForPrompt, localizeTimestamps } from "./prompts.js";
import { loadAllRecords, loadRecords } from "./records.js";
import {
  estimateFtpFromHistory,
  evaluateFtpApply,
  selectFtpFromEstimate,
} from "./ftp.js";
import { rebuildSummaryFromRecords } from "./reanalyze.js";
import {
  recalibrateActivityPower,
  setPowerFlagAndRefresh,
} from "./power-calib.js";
import { simulateForm, generateWorkout } from "./planning.js";
import { t } from "./i18n.js";
import { isActivityUuid } from "./identity.js";
import {
  AGENTIC,
  ATHLETE,
  FTP_ESTIMATION,
  FORM_SIMULATION,
  WORKOUT_TEMPLATES,
} from "./settings.js";

// 输出目录解析规则与 server.js 一致（FIT_OUTPUT_DIR 覆盖，默认 ./output，测试隔离用）
const OUTPUT_DIR = path.resolve(process.env.FIT_OUTPUT_DIR || "output");

// ---------------- 工具 schema 定义（OpenAI tools 格式，按语言本地化） ----------------

const TOOL_TEXT = {
  zh: {
    list_activities:
      "查询训练简明清单（目录页）：日期/类型/分类/时长/距离/TSS/NP/IF，每行带 activity_id。先用它找到目标训练的 activity_id，再用 get_activity_summary 或 get_activity_records 深挖单次。",
    "list_activities.start_date": "起始日期 YYYY-MM-DD（含）",
    "list_activities.end_date": "结束日期 YYYY-MM-DD（含）",
    "list_activities.sport": "运动类型过滤，如 cycling / running / swimming",
    "list_activities.category": "训练分类过滤，如 训练 / 比赛 / 恢复 / 休闲",
    "list_activities.limit": "返回条数上限，最大 {n}",
    get_activity_summary:
      "取单次训练的完整汇总指标 JSON（NP/IF/TSS/分区分布/峰功率曲线/心率漂移/间歇/爬坡/备注等），入参为 list_activities 返回的 activity_id。",
    "get_activity_summary.activity_id": "活动 id（list_activities 返回的 activity_id，32 位 uuid）",
    get_activity_records:
      "取单次训练的逐秒时序（功率/心率/踏频/海拔/速度，抽稀后返回）。可用 start_sec/end_sec 只取时间窗片段（如最后 600 秒），不必取全程。",
    "get_activity_records.activity_id": "活动 id（activity_id）",
    "get_activity_records.start_sec": "时间窗起点（相对训练开始的秒数，含）",
    "get_activity_records.end_sec": "时间窗终点（相对训练开始的秒数，含）",
    get_form_series:
      "取最近 N 天逐日训练状态序列（CTL/ATL/TSB/TSS），用于判断疲劳与状态走势。",
    "get_form_series.days": "回看天数，最大 {n}",
    get_monthly_summary:
      "取逐月训练汇总（TSS/时长/距离/强度分布类型），用于长期负荷趋势。",
    "get_monthly_summary.months": "回看月数，最大 {n}",
    get_athlete_profile:
      "取骑手参数（FTP/最大心率/体重）与用户身份、训练目标，以及 FTP 是否已校准。",
    estimate_ftp:
      "基于最近窗口期骑行的功率峰曲线与心率交叉验证估算 FTP（含置信度与数据需求），用户问 FTP 是否该调整时使用。",
    simulate_form:
      "未来负荷推演：给出未来逐日计划 TSS，按当前 CTL/ATL 推演 CTL/ATL/TSB 走势并标注风险（深度疲劳/CTL 周增幅过高）。用户问「如果我每周加练 X 会怎样」「赛前怎么减量」时使用。",
    "simulate_form.plan": "未来逐日计划（无训练日 tss=0），最多 {n} 天",
    "simulate_form.date": "日期 YYYY-MM-DD",
    "simulate_form.tss": "当日计划 TSS（0–1000）",
    "simulate_form.start_ctl": "起始 CTL；缺省取训练库当前值",
    "simulate_form.start_atl": "起始 ATL；缺省取训练库当前值",
    generate_workout:
      "按目标与可用时长生成单次课表：热身/主组（组数/时长/功率瓦特区间/组间休息）/冷身 + TSS 估算。用户问「今天有 X 小时，练什么」时使用。",
    "generate_workout.target":
      "课表类型：recovery 恢复 / endurance 有氧耐力 / sweet_spot 甜区 / threshold 阈值 / vo2max",
    "generate_workout.duration_minutes": "可用总时长（分钟，15–300）",
    "generate_workout.tsb": "当前 TSB（可选）；过低时自动降级为恢复课",
    save_memory:
      "保存一条关于用户的记忆。只要用户透露训练数据之外的个人事实或倾向（目标与赛事计划/伤病与身体不适/日程时间约束/训练偏好/器材/对建议的反馈与纠正/自述主观状态）就主动记录，不必等用户明确要求，宁多勿漏；训练数据本身已有的事实不要记。",
    "save_memory.content": "记忆内容：带主语的完整陈述，≤500 字",
    "save_memory.category":
      "分类：general 通用 / injury 伤病 / schedule 日程 / goal 目标 / preference 偏好 / strategy 与用户商定的训练策略",
    "save_memory.scope":
      "记忆时效：short = 短期（超过两周或 5 次训练自动失效，适合临时上下文）；不传默认 long 长期",
    "save_memory.supersedes_id":
      "取代某条旧记忆的 id（注入的记忆清单中有 #id 标注），同主题更新时使用",
    get_dossier:
      "取个人训练档案（本地自动汇总的长期基线）：峰功率历史最佳与近 90 天、爬坡画像（坡度/强度/心率中位）、踏频风格占比、90 天强度结构、近 8 周负荷与心率漂移基线。评估进步/退步、定计划或讨论爬坡/踏频技术策略前先取它作对照，不要凭单次数据下长期结论。",
    set_power_flag:
      "标记/取消某次骑行的「功率不可信」：功率计未校准、读数明显失真时使用（如 20 分钟峰功率无解释地大幅突进且心率无对应响应）。被标记的骑行会从训练档案的功率基线中排除（心率与时长仍保留），档案随之自动更新。可逆：误标可再次调用（flagged=false）取消。",
    "set_power_flag.activity_id": "活动 id（activity_id）",
    "set_power_flag.flagged": "true = 标记功率不可信；false = 取消标记",
    "set_power_flag.reason": "标记原因（可选，≤200 字，供追溯）",
    recalibrate_activity_power:
      "按系数缩放重算某次骑行的全部功率派生指标并写回（功率计系统性校准偏差的修正）：逐秒功率 × scale 后重算 NP/平均/峰值功率/峰曲线/IF/TSS/区间/间歇/踏频-功率等，返回新旧指标对比。系数范围 0.5–1.5（越界被夹逼）；逐秒原始数据不改写，重导原文件或换系数重跑即可回退。仅在能给出可信依据（心率-功率交叉印证或用户明确告知偏差）时使用；拿不准时先 set_power_flag 标记。",
    "recalibrate_activity_power.activity_id": "活动 id（activity_id）",
    "recalibrate_activity_power.scale_factor":
      "功率缩放系数（0.5–1.5，越界夹逼）；如读数偏高 8% 则传 0.92",
    update_ftp:
      "按当前最佳科学估算更新用户的 FTP 配置。工具内部重新估算并硬校验数据量、两法一致性、全力锚点与数据新鲜度，不满足时返回拒绝原因与数据需求清单。可选 ftp_watts：在本次估算区间内自选（夹逼到区间边界，不会写出区间外的值）；不传取两法均值。",
    "update_ftp.ftp_watts":
      "可选自选值（瓦特）：须先经 estimate_ftp 知道本次估算的参考区间，只在有明确依据时指定（用户偏保守/激进、新手入门取低端、心率与体感显示高估取低端）；缺省则取两法均值。结果若被夹逼到区间边界会以 clamped=true 返回",
    reanalyze_activity:
      "按当前骑手参数（FTP/最大心率/体重）重新分析一次训练并写回训练库：从已存逐秒数据重算 IF/TSS/功率心率区间/间歇识别等并覆盖该训练的分析结果，返回新旧指标对比。FTP 更新后可对受影响的训练（如估算锚点骑行）或用户指名的训练使用。",
    "reanalyze_activity.activity_id": "活动 id（activity_id）",
  },
  en: {
    list_activities:
      "Query the brief activity list (catalog page): date/type/category/duration/distance/TSS/NP/IF, each row carries activity_id. Use it first to find the target activity's activity_id, then dig into a single one with get_activity_summary or get_activity_records.",
    "list_activities.start_date": "Start date YYYY-MM-DD (inclusive)",
    "list_activities.end_date": "End date YYYY-MM-DD (inclusive)",
    "list_activities.sport": "Sport filter, e.g. cycling / running / swimming",
    "list_activities.category": "Category filter, e.g. training / race / recovery / leisure",
    "list_activities.limit": "Max number of results, up to {n}",
    get_activity_summary:
      "Get the full summary-metrics JSON of one activity (NP/IF/TSS/zone distribution/peak power curve/HR drift/intervals/climbs/notes etc.); input is the activity_id returned by list_activities.",
    "get_activity_summary.activity_id": "Activity id (activity_id from list_activities, 32-hex uuid)",
    get_activity_records:
      "Get the per-second time series of one activity (power/HR/cadence/altitude/speed, thinned). Use start_sec/end_sec to fetch only a time window (e.g. the last 600 seconds) instead of the whole ride.",
    "get_activity_records.activity_id": "Activity id (activity_id)",
    "get_activity_records.start_sec": "Window start (seconds from ride start, inclusive)",
    "get_activity_records.end_sec": "Window end (seconds from ride start, inclusive)",
    get_form_series:
      "Get the daily form series for the last N days (CTL/ATL/TSB/TSS) to judge fatigue and form trends.",
    "get_form_series.days": "Days to look back, up to {n}",
    get_monthly_summary:
      "Get the monthly training summary (TSS/hours/distance/intensity distribution type) for long-term load trends.",
    "get_monthly_summary.months": "Months to look back, up to {n}",
    get_athlete_profile:
      "Get athlete parameters (FTP/max HR/weight), user identity and training goals, plus whether FTP is calibrated.",
    estimate_ftp:
      "Estimate FTP from rides in the recent window using peak power curves and HR cross-validation (with confidence and data needs). Use when the user asks whether FTP should be adjusted.",
    simulate_form:
      "Future load simulation: given a daily plan TSS, project the CTL/ATL/TSB trend and flag risks (deep fatigue / CTL weekly ramp too high). Use when the user asks \"what if I add X per week\" or \"how should I taper\".",
    "simulate_form.plan": "Future daily plan (rest days tss=0), up to {n} days",
    "simulate_form.date": "Date YYYY-MM-DD",
    "simulate_form.tss": "Planned TSS for the day (0–1000)",
    "simulate_form.start_ctl": "Starting CTL; defaults to the current library value",
    "simulate_form.start_atl": "Starting ATL; defaults to the current library value",
    generate_workout:
      "Build a single workout by target and available time: warmup/main sets (reps/duration/watt range/rest)/cooldown + TSS estimate. Use when the user asks \"I have X hours today, what should I do\".",
    "generate_workout.target":
      "Workout type: recovery / endurance / sweet_spot / threshold / vo2max",
    "generate_workout.duration_minutes": "Total available time (minutes, 15–300)",
    "generate_workout.tsb": "Current TSB (optional); auto-downgrades to recovery when too low",
    save_memory:
      "Save a memory about the user. Proactively record whenever the user reveals personal facts or preferences beyond training data (goals and race plans / injuries and physical issues / schedule-time constraints / training preferences / equipment / feedback on and corrections to your advice / self-reported subjective state) — better too many than too few, don't wait to be asked; facts already present in the training data need not be recorded.",
    "save_memory.content": "Memory content: a complete statement with a subject, ≤500 chars",
    "save_memory.category":
      "Category: general / injury / schedule / goal / preference / strategy (training strategy agreed with the user)",
    "save_memory.scope":
      "Memory freshness: short = short-term (auto-expires after two weeks or 5 activities; for temporary context); omit for long (default)",
    "save_memory.supersedes_id":
      "id of an old memory to supersede (ids are #annotated in the injected memory list); use when updating the same topic",
    get_dossier:
      "Fetch the athlete dossier (auto-aggregated long-term baseline): all-time and 90-day peak power, climb profile (median grade/intensity/HR), cadence style shares, 90-day intensity structure, last-8-weeks load and HR-drift baseline. Consult it before judging progress, planning, or discussing climbing/cadence technique — never draw long-term conclusions from a single ride.",
    set_power_flag:
      "Flag/unflag a ride as power-untrusted: use when the power meter was uncalibrated or readings are clearly distorted (e.g. an unexplained 20-min peak jump with no HR response). Flagged rides are excluded from the dossier's power baselines (HR and duration are kept) and the dossier updates automatically. Reversible: call again with flagged=false to unflag.",
    "set_power_flag.activity_id": "Activity id (activity_id)",
    "set_power_flag.flagged": "true = flag power as untrusted; false = clear the flag",
    "set_power_flag.reason": "Reason (optional, ≤200 chars, for the audit trail)",
    recalibrate_activity_power:
      "Rescale and recompute all power-derived metrics of one ride and write back (corrects a systematic power-meter calibration offset): per-second power × scale, then recompute NP/avg/peak power/peak curve/IF/TSS/zones/intervals/cadence-power etc., returning an old-vs-new diff. Scale range 0.5–1.5 (clamped); raw per-second data is not rewritten — re-import the original file or re-run with another factor to revert. Use only with a credible basis (HR-power cross-check or a user-stated offset); when unsure, set_power_flag first.",
    "recalibrate_activity_power.activity_id": "Activity id (activity_id)",
    "recalibrate_activity_power.scale_factor":
      "Power scale factor (0.5–1.5, clamped); e.g. readings 8% high → 0.92",
    update_ftp:
      "Update the user's FTP config from the current best scientific estimate. The tool re-estimates internally and hard-validates data volume, method consistency, all-out anchor and data freshness; when unmet it returns the refusal reason and data-needs list. Optional ftp_watts: choose within this run's estimate range (clamped to the range boundaries; values outside can never be written); omit to use the mean of both methods.",
    "update_ftp.ftp_watts":
      "Optional chosen value (watts): first use estimate_ftp to learn this run's reference range, and only specify it with a clear basis (rider is conservative/aggressive, beginner taking the low end, HR/perceived effort suggesting an overestimate); omit to use the mean of both methods. Returns clamped=true when the value was clipped to a range boundary",
    reanalyze_activity:
      "Re-analyze one activity with the current athlete parameters (FTP/max HR/weight) and write it back to the library: recomputes IF/TSS/power-HR zones/interval detection etc. from stored per-second data, overwrites that activity's analysis results, and returns an old-vs-new metrics diff. Use after an FTP update for affected rides (e.g. the anchor ride) or rides the user names.",
    "reanalyze_activity.activity_id": "Activity id (activity_id)",
  },
};

const LANG_T = (lang, key, vars) => {
  const tpl = TOOL_TEXT[lang]?.[key] ?? TOOL_TEXT.zh[key] ?? key;
  if (!vars) return tpl;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(v == null ? "" : String(v)),
    tpl,
  );
};

/** 工具 JSON schema（描述按语言本地化；OpenAI tools 格式） */
export function toolDefs(lang = "zh") {
  const L = (key, vars) => LANG_T(lang, key, vars);
  const activityId = (descKey) => ({
    type: "string",
    description: L(descKey),
  });
  return [
    {
      type: "function",
      function: {
        name: "list_activities",
        description: L("list_activities"),
        parameters: {
          type: "object",
          properties: {
            start_date: { type: "string", description: L("list_activities.start_date") },
            end_date: { type: "string", description: L("list_activities.end_date") },
            sport: { type: "string", description: L("list_activities.sport") },
            category: { type: "string", description: L("list_activities.category") },
            limit: { type: "integer", description: L("list_activities.limit", { n: AGENTIC.list_limit }) },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_activity_summary",
        description: L("get_activity_summary"),
        parameters: {
          type: "object",
          properties: {
            activity_id: activityId("get_activity_summary.activity_id"),
          },
          required: ["activity_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_activity_records",
        description: L("get_activity_records"),
        parameters: {
          type: "object",
          properties: {
            activity_id: activityId("get_activity_records.activity_id"),
            start_sec: { type: "integer", description: L("get_activity_records.start_sec") },
            end_sec: { type: "integer", description: L("get_activity_records.end_sec") },
          },
          required: ["activity_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_form_series",
        description: L("get_form_series"),
        parameters: {
          type: "object",
          properties: {
            days: { type: "integer", description: L("get_form_series.days", { n: AGENTIC.form_max_days }) },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_monthly_summary",
        description: L("get_monthly_summary"),
        parameters: {
          type: "object",
          properties: {
            months: { type: "integer", description: L("get_monthly_summary.months", { n: AGENTIC.monthly_max }) },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_athlete_profile",
        description: L("get_athlete_profile"),
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "estimate_ftp",
        description: L("estimate_ftp"),
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "simulate_form",
        description: L("simulate_form"),
        parameters: {
          type: "object",
          properties: {
            plan: {
              type: "array",
              description: L("simulate_form.plan", { n: AGENTIC.simulate_max_days }),
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: L("simulate_form.date") },
                  tss: { type: "number", description: L("simulate_form.tss") },
                },
                required: ["date", "tss"],
              },
            },
            start_ctl: { type: "number", description: L("simulate_form.start_ctl") },
            start_atl: { type: "number", description: L("simulate_form.start_atl") },
          },
          required: ["plan"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generate_workout",
        description: L("generate_workout"),
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["recovery", "endurance", "sweet_spot", "threshold", "vo2max"],
              description: L("generate_workout.target"),
            },
            duration_minutes: { type: "integer", description: L("generate_workout.duration_minutes") },
            tsb: { type: "number", description: L("generate_workout.tsb") },
          },
          required: ["target", "duration_minutes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "save_memory",
        description: L("save_memory"),
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: L("save_memory.content") },
            category: {
              type: "string",
              enum: ["general", "injury", "schedule", "goal", "preference", "strategy"],
              description: L("save_memory.category"),
            },
            scope: {
              type: "string",
              enum: ["short", "long"],
              description: L("save_memory.scope"),
            },
            supersedes_id: { type: "integer", description: L("save_memory.supersedes_id") },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_dossier",
        description: L("get_dossier"),
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "set_power_flag",
        description: L("set_power_flag"),
        parameters: {
          type: "object",
          properties: {
            activity_id: activityId("set_power_flag.activity_id"),
            flagged: { type: "boolean", description: L("set_power_flag.flagged") },
            reason: { type: "string", description: L("set_power_flag.reason") },
          },
          required: ["activity_id", "flagged"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "recalibrate_activity_power",
        description: L("recalibrate_activity_power"),
        parameters: {
          type: "object",
          properties: {
            activity_id: activityId("recalibrate_activity_power.activity_id"),
            scale_factor: { type: "number", description: L("recalibrate_activity_power.scale_factor") },
          },
          required: ["activity_id", "scale_factor"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_ftp",
        description: L("update_ftp"),
        parameters: {
          type: "object",
          properties: {
            ftp_watts: { type: "number", description: L("update_ftp.ftp_watts") },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "reanalyze_activity",
        description: L("reanalyze_activity"),
        parameters: {
          type: "object",
          properties: {
            activity_id: activityId("reanalyze_activity.activity_id"),
          },
          required: ["activity_id"],
        },
      },
    },
  ];
}

// ---------------- 参数校验小工具 ----------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** activity_id 严格校验（32 位小写 hex）；非法返回 null */
function activityIdOf(v) {
  return isActivityUuid(v) ? v : null;
}

/** 结果序列化 + 截断（超 AGENTIC.tool_result_max_chars 附截断标记，按语言） */
function toResult(obj, lang = "zh") {
  let s = JSON.stringify(obj);
  if (s.length > AGENTIC.tool_result_max_chars) {
    s = s.slice(0, AGENTIC.tool_result_max_chars) + t(lang, "tool.result_truncated");
  }
  return s;
}

const errResult = (message) => JSON.stringify({ error: message });

// ---------------- 各工具实现 ----------------

function toolListActivities(args, ctx) {
  const lang = ctx?.lang || "zh";
  const limit = clampInt(args?.limit, 1, AGENTIC.list_limit, 20);
  let list = listActivities(200);
  if (args?.start_date != null) {
    if (!DATE_RE.test(args.start_date))
      return errResult(t(lang, "tool.date_invalid", { key: "start_date" }));
    list = list.filter((a) => a.date >= args.start_date);
  }
  if (args?.end_date != null) {
    if (!DATE_RE.test(args.end_date))
      return errResult(t(lang, "tool.date_invalid", { key: "end_date" }));
    list = list.filter((a) => a.date <= args.end_date);
  }
  if (args?.sport != null) list = list.filter((a) => a.sport === args.sport);
  if (args?.category != null) list = list.filter((a) => a.category === args.category);
  // 工具面只暴露 activity_id；内部 uuid/activity_id 双字段归一为一个
  const activities = list.slice(0, limit).map(({ uuid, activity_id, ...rest }) => ({
    activity_id: uuid,
    ...rest,
  }));
  return toResult({ count: activities.length, activities }, lang);
}

function toolGetActivitySummary(args, ctx) {
  const lang = ctx?.lang || "zh";
  const id = activityIdOf(args?.activity_id);
  if (!id) return errResult(t(lang, "tool.activity_id_invalid"));
  const summary = getActivitySummary(id);
  if (!summary) return errResult(t(lang, "tool.summary_not_found", { name: id }));
  return toResult(compactSummaryForPrompt(summary, lang), lang);
}

function toolGetActivityRecords(args, ctx) {
  const lang = ctx?.lang || "zh";
  const id = activityIdOf(args?.activity_id);
  if (!id) return errResult(t(lang, "tool.activity_id_invalid"));
  const data = loadRecords(id, {
    outputDir: OUTPUT_DIR,
    maxPoints: AGENTIC.records_max_points,
    startSec: args?.start_sec != null ? Number(args.start_sec) : undefined,
    endSec: args?.end_sec != null ? Number(args.end_sec) : undefined,
  });
  if (!data) return errResult(t(lang, "tool.records_not_found", { name: id }));
  // 时序时间戳为 UTC 口径，提交前改写为本地时区偏移，AI 按本地时间解读时段
  return toResult(localizeTimestamps(data), lang);
}

function toolGetFormSeries(args, ctx) {
  const days = clampInt(args?.days, 1, AGENTIC.form_max_days, 56);
  return toResult({ days, series: recentFormDaily(days) }, ctx?.lang || "zh");
}

function toolGetMonthlySummary(args, ctx) {
  const months = clampInt(args?.months, 1, AGENTIC.monthly_max, 6);
  return toResult({ months, summary: monthlySummary(months) }, ctx?.lang || "zh");
}

function toolGetAthleteProfile(ctx) {
  const { athlete, configured, ftp_calibrated } = getAthleteState();
  const profile = getProfile();
  return toResult(
    {
      athlete,
      // §35：AI 侧「已配置」判据是 FTP 已校准（不是"有 athlete 行"）
      athlete_configured: ftp_calibrated,
      ftp_calibrated,
      athlete_row_configured: configured,
      identity: profile.identity || null,
      goal: profile.goal || null,
    },
    ctx?.lang || "zh",
  );
}

function toolEstimateFtp(ctx) {
  const lang = ctx?.lang || "zh";
  const acts = cyclingSummariesSince(FTP_ESTIMATION.window_days);
  return toResult(estimateFtpFromHistory(acts, ATHLETE, FTP_ESTIMATION, lang), lang);
}

/** get_dossier：个人训练档案长期基线（评估进步/规划前的对照基准；空库返回提示） */
function toolGetDossier(_args, ctx) {
  const lang = ctx?.lang || "zh";
  const dossier = getDossier();
  if (!dossier) return errResult(t(lang, "tool.dossier_empty"));
  return toResult(dossier, lang);
}

/** simulate_form：未来负荷推演（纯计算；起始 CTL/ATL 缺省时读一次训练库当前值） */
function toolSimulateForm(args, ctx) {
  const lang = ctx?.lang || "zh";
  const plan = args?.plan;
  if (!Array.isArray(plan) || !plan.length)
    return errResult(t(lang, "tool.plan_array"));
  if (plan.length > AGENTIC.simulate_max_days)
    return errResult(t(lang, "tool.plan_max_days", { n: AGENTIC.simulate_max_days }));
  const clean = [];
  for (const d of plan) {
    if (!d || !DATE_RE.test(d.date ?? ""))
      return errResult(t(lang, "tool.plan_date"));
    const tss = Number(d.tss);
    if (!Number.isFinite(tss)) return errResult(t(lang, "tool.plan_tss"));
    clean.push({ date: d.date, tss: Math.min(1000, Math.max(0, tss)) });
  }
  clean.sort((a, b) => (a.date < b.date ? -1 : 1));
  let startCtl = Number(args?.start_ctl);
  let startAtl = Number(args?.start_atl);
  if (!Number.isFinite(startCtl) || !Number.isFinite(startAtl)) {
    const today = new Date().toISOString().slice(0, 10);
    const cur = computeForm(today); // 训练库为空时返回 null，按 0 起步
    startCtl = cur?.ctl ?? 0;
    startAtl = cur?.atl ?? 0;
  }
  const { projection, risk_flags, end_form } = simulateForm({
    startCtl,
    startAtl,
    plan: clean,
    cfg: FORM_SIMULATION,
    lang,
  });
  return toResult({ start: { ctl: startCtl, atl: startAtl }, projection, risk_flags, end_form }, lang);
}

/** generate_workout：单次课表生成（纯计算，FTP 取 ATHLETE 当前生效值） */
function toolGenerateWorkout(args, ctx) {
  const lang = ctx?.lang || "zh";
  const duration = clampInt(args?.duration_minutes, 15, 300, NaN);
  if (!Number.isFinite(duration))
    return errResult(t(lang, "tool.duration_invalid"));
  const result = generateWorkout({
    target: args?.target,
    durationMinutes: duration,
    ftpWatts: ATHLETE.ftp_watts,
    tsb: args?.tsb != null ? Number(args.tsb) : null,
    templates: WORKOUT_TEMPLATES,
    tsbRecovery: FORM_SIMULATION.tsb_recovery,
    lang,
  });
  if (result.error) return errResult(result.error);
  return toResult({ ftp_watts: ATHLETE.ftp_watts, ...result }, lang);
}

/** save_memory：写 ai_memories（scope 分层：short 两周/5 次训练失效） */
function toolSaveMemory(args, ctx) {
  const id = saveMemory(
    {
      content: args?.content,
      category: args?.category,
      scope: args?.scope,
      source: ctx?.source ?? null,
      supersedes_id: args?.supersedes_id,
    },
    ctx?.lang || "zh",
  );
  return toResult(
    {
      ok: true,
      memory_id: id,
      date: new Date().toISOString().slice(0, 10),
    },
    ctx?.lang || "zh",
  );
}

/**
 * update_ftp：AI 教练按当前最佳估算更新 FTP；可选 ftp_watts 在估算区间内自选
 * （selectFtpFromEstimate 夹逼后写入，区间外的值写不进去）。
 */
function toolUpdateFtp(args, ctx) {
  const lang = ctx?.lang || "zh";
  let requested;
  if (args?.ftp_watts != null) {
    // 严格类型：Number('')/Number(true)/Number([]) 都是有限数，宽容解析会把
    // 「未填的可选参数」（空串）静默变成 0 → 夹到区间低端并真实写库
    if (typeof args.ftp_watts !== "number" || !Number.isFinite(args.ftp_watts))
      return errResult(t(lang, "tool.ftp_invalid"));
    requested = args.ftp_watts;
  }
  const rides = cyclingSummariesSince(FTP_ESTIMATION.window_days);
  const { athlete } = getAthleteState();
  const result = estimateFtpFromHistory(rides, athlete, FTP_ESTIMATION, lang);
  const selection = selectFtpFromEstimate(result, requested);
  // 新鲜度依据：与估算器同款"可用"口径，且排除功率不可信骑行
  const usableRides = rides.filter(
    (r) =>
      !r.power_flagged &&
      r.summary?.power &&
      (r.summary.data_quality?.power_coverage_pct ?? 100) >= FTP_ESTIMATION.min_coverage_pct,
  );
  const latestRideDate = usableRides.reduce(
    (max, r) => (r.date > (max ?? "") ? r.date : max),
    null,
  );
  const today = new Date().toISOString().slice(0, 10);
  const check = evaluateFtpApply(
    result,
    latestRideDate,
    today,
    FTP_ESTIMATION,
    selection?.ftp_w ?? null,
  );
  if (!check.ok || !result.estimate || !selection) {
    return toResult(
      {
        applied: false,
        reason: t(lang, check.reason_key ?? "ftp.apply.no_data", check.reason_vars),
        estimate: result.estimate ?? undefined,
        data_needs: result.data_needs,
        requested_w: selection?.requested_w ?? null,
        clamped: selection?.clamped ?? false,
      },
      lang,
    );
  }
  const e = result.estimate;
  const metaBefore = getFtpMeta();
  const oldFtp = athlete.ftp_watts;
  // 撤销快照：记录旧值与旧溯源戳（撤销时恢复旧戳，避免回默认值被误判已校准）
  const snapshot = {
    requested_w: selection.requested_w,
    range_low: e.range_low,
    range_high: e.range_high,
    old_ftp_w: oldFtp,
    old_ftp_updated_at: metaBefore.updated_at,
    old_ftp_source: metaBefore.source,
    updated_at: new Date().toISOString(),
  };
  const updated = setAthlete({ ftp_watts: selection.ftp_w }, lang, { source: "ai_coach" });
  setAiFtpUpdate(snapshot);
  const meta = getFtpMeta();
  return toResult(
    {
      applied: true,
      old_ftp_w: oldFtp,
      new_ftp_w: updated.ftp_watts,
      estimate: e,
      requested_w: selection.requested_w,
      clamped: selection.clamped,
      updated_at: meta.updated_at,
    },
    lang,
  );
}

/** set_power_flag：标记/取消「功率不可信」（可逆；服务层负责档案重建） */
function toolSetPowerFlag(args, ctx) {
  const lang = ctx?.lang || "zh";
  const id = activityIdOf(args?.activity_id);
  if (!id) return errResult(t(lang, "tool.activity_id_invalid"));
  if (typeof args?.flagged !== "boolean") return errResult(t(lang, "tool.flag_invalid"));
  const reason = typeof args?.reason === "string" ? args.reason.slice(0, 200) : null;
  return toResult(setPowerFlagAndRefresh(id, args.flagged, lang, reason), lang);
}

/** recalibrate_activity_power：按系数缩放重算并写回（夹逼界限在服务层执行） */
function toolRecalibratePower(args, ctx) {
  const lang = ctx?.lang || "zh";
  const id = activityIdOf(args?.activity_id);
  if (!id) return errResult(t(lang, "tool.activity_id_invalid"));
  const scale = Number(args?.scale_factor);
  if (!Number.isFinite(scale)) return errResult(t(lang, "tool.scale_invalid"));
  return toResult(recalibrateActivityPower(id, scale, lang), lang);
}

/** reanalyze_activity：按当前骑手参数重算一次训练并写回，返回新旧指标对比 */
function toolReanalyzeActivity(args, ctx) {
  const lang = ctx?.lang || "zh";
  const id = activityIdOf(args?.activity_id);
  if (!id) return errResult(t(lang, "tool.activity_id_invalid"));
  const prev = getActivitySummary(id);
  if (!prev) return errResult(t(lang, "tool.summary_not_found", { name: id }));
  const records = loadAllRecords(id, { outputDir: OUTPUT_DIR });
  if (!records || !records.length)
    return errResult(t(lang, "tool.records_not_found", { name: id }));
  const athlete = getAthleteState().athlete;
  const rebuilt = rebuildSummaryFromRecords(records, prev, athlete);
  // category/note/power_flagged 是 activities 列属数据（读取时由 db 层合并回填），
  // 不落 summary_json——原样写回会把用户随后清除的备注"复活"
  delete rebuilt.activity.category;
  delete rebuilt.activity.note;
  delete rebuilt.activity.power_flagged;
  // 入库 + 注入当日 CTL/ATL/TSB 后终版再入库（两段式，口径同 analyzeFile）
  updateActivitySummary(id, rebuilt);
  const form = computeForm(rebuilt.activity.date);
  if (form) {
    Object.assign(rebuilt.athlete_context, form);
    updateActivitySummary(id, rebuilt);
  }
  rebuildDossierQuietly();
  // 旧→新对比项（仅记录确实变化的字段，避免结果膨胀；口径同 VoltCoach diffSummaries）
  const changes = {};
  const pushChange = (key, a, b) => {
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null))
      changes[key] = { old: a ?? null, new: b ?? null };
  };
  pushChange("tss", prev.power?.tss ?? null, rebuilt.power?.tss ?? null);
  pushChange("intensity_factor", prev.power?.intensity_factor ?? null, rebuilt.power?.intensity_factor ?? null);
  pushChange("power_zone_distribution_pct", prev.power?.zone_distribution_pct ?? null, rebuilt.power?.zone_distribution_pct ?? null);
  pushChange("hr_zone_distribution_pct", prev.heart_rate?.zone_distribution_pct ?? null, rebuilt.heart_rate?.zone_distribution_pct ?? null);
  pushChange("w_per_kg_avg", prev.power?.w_per_kg_avg ?? null, rebuilt.power?.w_per_kg_avg ?? null);
  pushChange("ftp_estimate", prev.power?.ftp_estimate ?? null, rebuilt.power?.ftp_estimate ?? null);
  pushChange("interval_set", prev.interval_set ?? null, rebuilt.interval_set ?? null);
  pushChange("cadence_power", prev.cadence_power ?? null, rebuilt.cadence_power ?? null);
  return toResult(
    {
      ok: true,
      activity_id: id,
      file_name: getActivityFileName(id),
      date: rebuilt.activity.date,
      sport: rebuilt.activity.sport,
      ftp_used: athlete.ftp_watts,
      max_hr_used: athlete.max_hr,
      weight_kg_used: athlete.weight_kg,
      changes,
      form: form ? { ctl: form.ctl, atl: form.atl, tsb: form.tsb } : null,
    },
    lang,
  );
}

const TOOL_IMPL = {
  list_activities: toolListActivities,
  get_activity_summary: toolGetActivitySummary,
  get_activity_records: toolGetActivityRecords,
  get_form_series: toolGetFormSeries,
  get_monthly_summary: toolGetMonthlySummary,
  get_athlete_profile: toolGetAthleteProfile,
  estimate_ftp: toolEstimateFtp,
  get_dossier: toolGetDossier,
  simulate_form: toolSimulateForm,
  generate_workout: toolGenerateWorkout,
  save_memory: toolSaveMemory,
  set_power_flag: toolSetPowerFlag,
  recalibrate_activity_power: toolRecalibratePower,
  update_ftp: toolUpdateFtp,
  reanalyze_activity: toolReanalyzeActivity,
};

/**
 * 工具执行分发：未知工具名 / 执行异常均返回 {error} JSON，不抛出。
 * 返回值为 JSON 字符串（直接作为 role:"tool" 消息的 content）。
 * ctx 为可选上下文（{ source: 场景标记, lang: 消息语言 }）。
 */
export async function executeTool(name, args, ctx) {
  const lang = ctx?.lang || "zh";
  const impl = TOOL_IMPL[name];
  if (!impl) return errResult(t(lang, "tool.unknown", { name }));
  try {
    return impl(args ?? {}, ctx);
  } catch (e) {
    return errResult(t(lang, "tool.failed", { msg: e.message }));
  }
}
