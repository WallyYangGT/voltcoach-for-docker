/**
 * server.js
 * Web 界面（P4）：本地 HTTP 服务，零第三方依赖（Node 内置 http/fs）。
 * 提供：
 *   - 静态前端（web/ 目录：训练库仪表盘 + 单次训练详情 + 上传分析 + AI 报告）
 *   - REST API：
 *       GET  /api/overview              仪表盘数据（骑手参数/月汇总/趋势/训练清单/AI 配置状态）
 *       GET  /api/athlete               当前骑手参数（库值覆盖 settings.js 默认值 + configured 标记）
 *       POST /api/athlete               {ftp_watts?, max_hr?, weight_kg?} 更新骑手参数（写训练库并即时生效）
 *       GET  /api/ai-config             当前 AI 服务配置（库值覆盖默认值）
 *       POST /api/ai-config             {api_key?, base_url?, model?, ...} 更新 AI 配置（写训练库并即时生效）
 *       GET  /api/activity?id=<uuid>    单次训练完整 summary JSON（id 也接受旧文件名；兼容 ?name=）
 *       POST /api/activity/category     {id, category} 标记训练分类（训练/比赛/恢复/休闲）
 *       POST /api/activity/note         {id, note} 保存训练备注（体感/路况等，AI 复盘纳入考量）
 *       POST /api/activity/power-flag   {id, flagged, reason?} 标记/取消「功率不可信」
 *       DELETE /api/activity?id=<uuid>  删除训练（records 一并删；AI 报告/对话保留）
 *       GET  /api/dossier               个人训练档案（长期基线）
 *       GET  /api/duplicates            重复骑行组（同趟骑行多份副本）
 *       POST /api/activity/merge        {keep, drop} 合并重复骑行（服务端校验同趟）
 *       GET  /api/profile               用户背景与训练目标（identity / goal / configured）
 *       POST /api/profile               {identity?, goal?} 更新用户背景与训练目标（写训练库，AI 报告纳入考量）
 *       GET  /api/records?id=<uuid>     逐秒时序（抽稀到 ≤1400 点，供前端画图；id 也接受旧文件名）
 *       POST /api/upload?filename=x.fit 上传 FIT（原始字节作 body）→ 分析并入库 → 返回 {uuid, summary, duplicate_of}
 *       GET  /api/ftp-estimate          基于最近窗口期骑行（功率峰曲线+心率交叉验证）科学估算 FTP
 *       POST /api/ftp-apply             {ftp_w} 把估算 FTP 写入训练库骑手参数并立即生效
 *       POST /api/ai                    AI 报告：{mode:'review'|'plan'|'taper'|'compare', activity_id?, ...}
 *                                       未配置 AI 密钥时返回提示词供手动复制
 *       POST /api/ai/chat               AI 对话：{chat_id?, mode:'follow_up'|'chat', message, report_id?, activity_id?}
 *                                       落库 user 消息 + pending 占位 → 202，后台生成回填
 *       GET  /api/ai/chat?id=           对话详情（含消息；有 pending 时返回 202 快照供轮询）
 *       GET  /api/ai/chats?mode=        对话列表（可选 report_id 找回该报告的追问对话）
 *       DELETE /api/ai/chat?id=         删除整个对话及其全部消息
 *       GET  /api/ai/memories           全部 AI 记忆（含已被取代的，设置页管理用）
 *       DELETE /api/ai/memory?id=       删除指定记忆
 *
 * 运行：npm run web（默认 http://localhost:3000，PORT 环境变量可改端口）
 * 输出目录用 FIT_OUTPUT_DIR 覆盖（默认 ./output，测试隔离用）。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { analyzeFile } from "./index.js";
import {
  listActivities,
  getActivitySummary,
  saveAiReport,
  createPendingAiReport,
  updateAiReport,
  listAiReports,
  getAiReport,
  getActivityFileName,
  monthlySummary,
  trendMonthly,
  recentFormDaily,
  recentActivities,
  computeForm,
  cyclingSummariesSince,
  syncAthleteFromDb,
  getAthleteState,
  setAthlete,
  syncAiConfigFromDb,
  migrateAiEnvToDb,
  getAiConfig,
  setAiConfig,
  setActivityCategory,
  isValidCategory,
  setActivityNote,
  getProfile,
  setProfile,
  createAiChat,
  addAiChatMessage,
  updateAiChatMessage,
  touchAiChat,
  listAiChats,
  getAiChat,
  findFollowUpChat,
  deleteAiChat,
  listMemories,
  listAllMemories,
  deleteMemory,
  getLang,
  setLang,
  getDossier,
  deleteActivity,
  mergeActivityRows,
  resolveActivityUuid,
  listActivityRideKeys,
  rebuildDossierQuietly,
} from "./src/db.js";
import {
  buildReviewPrompt,
  buildPlanPrompt,
  buildTaperPrompt,
  buildComparePrompt,
  buildAgenticSection,
  buildChatInstruction,
  buildDateSection,
  buildDossierSection,
  buildMemorySection,
  buildMetricGlossary,
  buildProfileSection,
  compactSummaryForPrompt,
  thinToWeekly,
  ROLE,
  ROLE_EN,
} from "./src/prompts.js";
import { callAI, runAgentLoop, isAiConfigured, aiConfigInfo } from "./src/ai.js";
import { buildSkillsSection } from "./src/skills.js";
import { toolDefs, executeTool } from "./src/tools.js";
import {
  copyRecordFile,
  deleteRecordFile,
  loadRecords,
  readRecordStart,
  safeName,
} from "./src/records.js";
import { setPowerFlagAndRefresh } from "./src/power-calib.js";
import {
  findDuplicateGroups,
  hasPositiveDistance,
  isSameRide,
} from "./src/dedupe.js";
import { isActivityUuid } from "./src/identity.js";
import { AI_CONFIG, ATHLETE, FTP_ESTIMATION, POWER_ZONES, HR_ZONES } from "./src/settings.js";
import { estimateFtpFromHistory } from "./src/ftp.js";
import { normalizeLang, t, formatAnomaly } from "./src/i18n.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(ROOT, "web");
const OUTPUT_DIR = path.resolve(process.env.FIT_OUTPUT_DIR || "output");
const INPUT_DIR = path.resolve(process.env.FIT_INPUT_DIR || "input");
const PORT = Number(process.env.PORT) || 3000;
// 默认只监听本机（纯本地应用）；Docker 通过 HOST=0.0.0.0 显式暴露端口
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

// ---------------- 小工具 ----------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/**
 * 请求语言解析：显式 lang 参数（query / X-Lang 头）> 训练库 lang > Accept-Language
 * （zh → zh，其他具体语言标签 → en；`*`/空视为无偏好回落 zh）> zh 默认。
 * 前端 api() 统一带 X-Lang 头，AI 接口再以请求体 lang 为准（见各 handler）。
 */
function resolveLang(req, url) {
  const q = url?.searchParams.get("lang");
  if (q) return normalizeLang(q);
  const h = req.headers["x-lang"];
  if (h) return normalizeLang(h);
  try {
    const dbLang = getLang();
    if (dbLang === "en") return "en";
  } catch {
    // 训练库不可用时回落后续判定
  }
  const al = String(req.headers["accept-language"] || "").replace(/\*/g, "").trim();
  if (/zh/i.test(al)) return "zh";
  if (/[a-z]{2}/i.test(al)) return "en"; // 非中文的具体语言一律英文
  return "zh";
}

/** TSB 状态枚举 → i18n key（与 db.js computeForm 的 form_state 口径一致） */
const FORM_STATE_KEYS = {
  fresh: "form.note.0",
  good: "form.note.1",
  balanced: "form.note.2",
  fatigued: "form.note.3",
  overtrained: "form.note.4",
};

/** 分区定义 × 基准值（FTP/最大心率）→ 各区具体范围文本，如 { Z2: "72-98", Z7: "195+" } */
function zoneRanges(zones, base) {
  const out = {};
  for (const z of zones) {
    const lo = Math.round(z.min * base);
    out[z.name] = z.max === Infinity ? `${lo}+` : `${lo}-${Math.round(z.max * base)}`;
  }
  return out;
}

function readBody(req, limitBytes = 64 * 1024 * 1024, lang = "zh") {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(t(lang, "srv.body_too_large")));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * AI 调用统一入口：agentic 开启（AI_CONFIG.agentic，默认开）时走 runAgentLoop
 * 并挂训练库查询工具（function calling，schema 按 lang 本地化），工具调用与
 * 降级记服务日志；关闭时维持原单轮 callAI（含流式设置）。
 * source 为场景标记（review/plan/taper/compare/follow_up/chat），透传给
 * save_memory 工具写入 ai_memories.source；lang 决定工具描述/错误消息语言。
 */
function callAiMaybeAgentic(messages, { onChunk, onHeartbeat, source, lang = "zh" } = {}) {
  if (AI_CONFIG.agentic !== false) {
    return runAgentLoop(
      messages,
      toolDefs(lang),
      (name, args) => executeTool(name, args, { source, lang }),
      {
        lang,
        onHeartbeat,
        onToolCall: (name, args, result) => {
          const chars = typeof result === "string" ? result.length : 0;
          console.log(`[AI tool] ${name}(${JSON.stringify(args)}) → ${chars} 字符`);
        },
        onDegrade: (errMsg) =>
          console.warn(`[AI] 模型不支持 tools，已降级为单轮调用（${errMsg}）`),
      },
    );
  }
  return callAI(messages, { onChunk, onHeartbeat, lang });
}

/**
 * 活动身份解析：优先 activity_id（uuid），旧调用方传 file_name 时回退解析。
 * 非法/不存在返回 null。
 */
function activityRefOf(body, idKey, nameKey) {
  const id = body?.[idKey];
  if (isActivityUuid(id) && resolveActivityUuid(id)) return id;
  const name = safeName(body?.[nameKey]);
  return name ? resolveActivityUuid(name) : null;
}

/** 写接口的身份解析：id 可为 uuid 或旧文件名；兼容旧 name 字段 */
function bodyActivityIdentifier(body) {
  return isActivityUuid(body?.id)
    ? body.id
    : safeName(body?.id) || safeName(body?.name);
}

/** 档案段装配失败只降级（档案可再生，不能阻断报告/对话生成） */
function safeDossierSection(lang) {
  try {
    return buildDossierSection(getDossier(), lang);
  } catch (e) {
    console.warn(`训练档案段生成失败（本次省略）: ${e.message}`);
    return null;
  }
}

/** 报告落库上下文（uuid + 指纹由 db 层子查询补齐） */
function reportContextOf(body) {
  return {
    activity_uuid: activityRefOf(body, "activity_id", "file_name"),
    compare_uuid: activityRefOf(body, "compare_id", "compare_with"),
    race_date: body?.race_date ?? null,
  };
}

/** 组装 AI 提示词（复用 P2 模板，按 lang 双语），返回提示词字符串或抛出带 message 的错误 */
function buildPromptForMode(body, lang = "zh") {
  const mode = body?.mode;
  const profile = getProfile(); // 用户背景与训练目标，四个场景统一纳入考量
  const skills = buildSkillsSection(lang); // 专业知识库（skills/ 目录，按语言加载），四场景统一注入
  const dossierSection = safeDossierSection(lang); // 长期基线，四场景统一注入（失败降级）
  if (mode === "review") {
    const id = activityRefOf(body, "activity_id", "file_name");
    const summary = id && getActivitySummary(id);
    if (!summary)
      throw new Error(
        t(lang, "tool.summary_not_found", {
          name: body?.activity_id ?? body?.file_name ?? "(未提供)",
        }),
      );
    return buildReviewPrompt(summary, profile, skills, lang, new Date(), dossierSection);
  }
  if (mode === "plan") {
    const daily = recentFormDaily(56);
    if (!daily.length) throw new Error(t(lang, "srv.library_empty"));
    return buildPlanPrompt(
      {
        months: monthlySummary(3),
        formSeries: thinToWeekly(daily),
        recentActivities: recentActivities(10),
      },
      profile,
      skills,
      lang,
      new Date(),
      dossierSection,
    );
  }
  if (mode === "taper") {
    const raceDate = body.race_date;
    if (!raceDate || !/^\d{4}-\d{2}-\d{2}$/.test(raceDate))
      throw new Error(t(lang, "srv.race_date"));
    const today = new Date().toISOString().slice(0, 10);
    const form = computeForm(today);
    if (!form) throw new Error(t(lang, "srv.library_empty"));
    const daysLeft = Math.round(
      (new Date(raceDate + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000,
    );
    return buildTaperPrompt(
      {
        raceDate,
        daysLeft,
        form,
        formSeries: thinToWeekly(recentFormDaily(56)),
        recentActivities: recentActivities(10),
      },
      profile,
      skills,
      lang,
      new Date(),
      dossierSection,
    );
  }
  if (mode === "compare") {
    const a = activityRefOf(body, "activity_id", "file_name");
    const b = activityRefOf(body, "compare_id", "compare_with");
    const sa = a && getActivitySummary(a);
    const sb = b && getActivitySummary(b);
    if (!sa || !sb) throw new Error(t(lang, "srv.compare_not_found"));
    return buildComparePrompt(sa, sb, profile, skills, lang, new Date(), dossierSection);
  }
  throw new Error(t(lang, "srv.unknown_mode", { mode }));
}

/**
 * 拼装对话系统段（每轮后台生成时按当前状态重新生成，历史消息只带正文）：
 * - follow_up：快答指令 + 当前时间 + 关联报告正文 + 关联训练压缩数据 + 工具指引 + 用户记忆段；
 * - chat：教练角色 + 指标口径 + 当前时间 + 专业知识库 + 用户背景 + 对话指令 + 工具指引 + 用户记忆段。
 * 记忆段只在 agentic 模式注入——其中的 save_memory 指引依赖工具调用能力。
 * 专业知识库段（src/skills.js）只注入 chat 与四场景报告；follow_up 快答场景不注入。
 * 当前时间段（buildDateSection）每轮重建，AI 对「今天/星期几」的感知始终最新。
 * lang 为提交时的请求语言（zh/en，缺省 zh）。
 */
function buildChatSystemSection(chat, lang = "zh") {
  const agentic = AI_CONFIG.agentic !== false;
  const dossierSection = safeDossierSection(lang);
  if (chat.mode === "follow_up") {
    let s = buildChatInstruction("follow_up", lang);
    // 当前时间：追问常涉及「今天感觉如何/接下来怎么练」，先锚定日期基准
    const nowSection = buildDateSection(new Date(), lang);
    if (nowSection) s += `\n\n${nowSection}`;
    // 报告正文：追问以报告内容为锚（报告可能已被滚动清理，缺则仅靠训练数据）
    if (chat.report_id != null) {
      const rep = getAiReport(chat.report_id);
      if (rep?.markdown) s += `\n\n${t(lang, "srv.report_body")}\n${rep.markdown}`;
    }
    // 追问只带报告会让 AI 无法回答报告未覆盖的细节，按 activity_uuid 附压缩后的训练数据
    const summary = chat.activity_uuid ? getActivitySummary(chat.activity_uuid) : null;
    if (summary) {
      s +=
        `\n\n${t(lang, "srv.training_data")}\n` + "```json\n" +
        JSON.stringify(compactSummaryForPrompt(summary, lang)) +
        "\n```";
    }
    if (dossierSection) s += `\n\n${dossierSection}`;
    if (agentic) {
      s += "\n\n" + buildAgenticSection(lang);
      const mem = buildMemorySection(listMemories(), lang);
      if (mem) s += "\n\n" + mem;
    }
    return s;
  }
  // chat：无报告上下文的直接对话，取数全靠 agentic 工具调用
  const parts = [
    lang === "en" ? ROLE_EN : ROLE,
    buildMetricGlossary(lang),
    buildDateSection(new Date(), lang),
    buildSkillsSection(lang),
    buildProfileSection(getProfile(), lang),
    dossierSection,
    buildChatInstruction("chat", lang),
  ].filter(Boolean);
  if (agentic) {
    parts.push(buildAgenticSection(lang));
    const mem = buildMemorySection(listMemories(), lang);
    if (mem) parts.push(mem);
  }
  return parts.join("\n\n");
}

// ---------------- 请求处理 ----------------

async function handleApi(req, res, url) {
  const lang = resolveLang(req, url); // 请求语言：X-Lang 头/query > 训练库 > Accept-Language > zh

  // GET /api/lang  当前界面语言（前端首次启动检测后写入，AI 提示词语言缺省取此值）
  if (req.method === "GET" && url.pathname === "/api/lang") {
    sendJson(res, 200, { lang: getLang() });
    return;
  }

  // POST /api/lang {lang: 'zh'|'en'}  保存界面语言（写训练库 settings 表）
  if (req.method === "POST" && url.pathname === "/api/lang") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    try {
      const saved = setLang(body?.lang);
      sendJson(res, 200, { applied: true, lang: saved });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/overview
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const { athlete, configured } = getAthleteState();
    sendJson(res, 200, {
      athlete,
      athlete_configured: configured,
      ai: aiConfigInfo(),
      monthly: monthlySummary(6),
      trend: trendMonthly(),
      form_daily: recentFormDaily(90),
      activities: listActivities(100),
    });
    return;
  }

  // GET /api/athlete  当前骑手参数（库值覆盖 settings.js 默认值）
  if (req.method === "GET" && url.pathname === "/api/athlete") {
    sendJson(res, 200, getAthleteState());
    return;
  }

  // POST /api/athlete  {ftp_watts?, max_hr?, weight_kg?}  更新骑手参数（写训练库并即时生效）
  if (req.method === "POST" && url.pathname === "/api/athlete") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    try {
      const athlete = setAthlete(body ?? {}, lang);
      sendJson(res, 200, { applied: true, athlete });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/ai-config  当前 AI 服务配置（库值覆盖默认值；本地单用户应用，密钥原样返回供编辑）
  if (req.method === "GET" && url.pathname === "/api/ai-config") {
    sendJson(res, 200, getAiConfig());
    return;
  }

  // POST /api/ai-config  {api_key?, base_url?, model?, ...}  更新 AI 配置（写训练库并即时生效）
  if (req.method === "POST" && url.pathname === "/api/ai-config") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    try {
      const config = setAiConfig(body ?? {}, lang);
      sendJson(res, 200, { applied: true, config });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // POST /api/activity/category {name, category}
  if (req.method === "POST" && url.pathname === "/api/activity/category") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    const identifier = bodyActivityIdentifier(body);
    if (!identifier)
      return sendJson(res, 400, { error: t(lang, "srv.activity_id_invalid") });
    if (!isValidCategory(body?.category))
      return sendJson(res, 400, { error: t(lang, "srv.category_invalid") });
    try {
      const r = setActivityCategory(identifier, body.category, lang);
      sendJson(res, 200, { ok: true, uuid: r.uuid });
    } catch (e) {
      sendJson(res, 404, { error: e.message });
    }
    return;
  }

  // POST /api/activity/note {name, note}  保存训练备注（空串清除），AI 复盘时纳入考量
  if (req.method === "POST" && url.pathname === "/api/activity/note") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    const identifier = bodyActivityIdentifier(body);
    if (!identifier)
      return sendJson(res, 400, { error: t(lang, "srv.activity_id_invalid") });
    try {
      const r = setActivityNote(identifier, body?.note ?? "", lang);
      sendJson(res, 200, r);
    } catch (e) {
      const status = e.message === t(lang, "activity.not_found") ? 404 : 400;
      sendJson(res, status, { error: e.message });
    }
    return;
  }

  // GET /api/dossier  个人训练档案（本地聚合的长期基线）
  if (req.method === "GET" && url.pathname === "/api/dossier") {
    sendJson(res, 200, { dossier: getDossier() });
    return;
  }

  // GET /api/duplicates  重复骑行组（同趟骑行的多份副本；室内按起骑时刻判）
  if (req.method === "GET" && url.pathname === "/api/duplicates") {
    const rows = listActivityRideKeys();
    const noDistByDate = new Map();
    for (const r of rows) {
      if (hasPositiveDistance(r.distance_km)) continue;
      noDistByDate.set(r.date, (noDistByDate.get(r.date) ?? 0) + 1);
    }
    const enriched = rows.map((r) => {
      if (hasPositiveDistance(r.distance_km)) return r;
      if ((noDistByDate.get(r.date) ?? 0) < 2) return r;
      return { ...r, start_at: readRecordStart(r.uuid, { outputDir: OUTPUT_DIR }) };
    });
    const groups = findDuplicateGroups(enriched).map((group) =>
      group.map((r) => ({
        activity_id: r.uuid,
        file_name: r.file_name,
        date: r.date,
        sport: r.sport,
        duration_sec: r.duration_sec,
        distance_km: r.distance_km,
        category: r.category,
        note: r.note,
      })),
    );
    sendJson(res, 200, { groups });
    return;
  }

  // POST /api/activity/merge {keep, drop}  合并重复骑行（保留最早入库方，一个事务）
  if (req.method === "POST" && url.pathname === "/api/activity/merge") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    let keepId = resolveActivityUuid(body?.keep);
    let dropId = resolveActivityUuid(body?.drop);
    if (!keepId || !dropId || keepId === dropId)
      return sendJson(res, 400, { error: t(lang, "srv.activity_id_invalid") });
    // 破坏性接口的服务端守卫：两条必须确实是同趟骑行（与重复检查同一判据），
    // 防止传错参数把无关训练合并/删除。室内行按首帧补起骑时刻后再判。
    const rows = listActivityRideKeys();
    const byId = new Map(rows.map((r) => [r.uuid, r]));
    if (!byId.has(keepId) || !byId.has(dropId))
      return sendJson(res, 404, { error: t(lang, "srv.activity_not_found") });
    const enrich = (r) =>
      hasPositiveDistance(r.distance_km)
        ? r
        : { ...r, start_at: readRecordStart(r.uuid, { outputDir: OUTPUT_DIR }) };
    if (!isSameRide(enrich(byId.get(keepId)), enrich(byId.get(dropId))))
      return sendJson(res, 400, { error: t(lang, "srv.merge_not_same_ride") });
    // 「最早入库保留」：前端传反了也按 id 顺序纠正
    if ((byId.get(keepId)?.id ?? 0) > (byId.get(dropId)?.id ?? 0))
      [keepId, dropId] = [dropId, keepId];
    try {
      const keepName = getActivityFileName(keepId);
      const dropName = getActivityFileName(dropId);
      // records 复制在事务前、删除在事务后（副本先保住，再删原件）
      copyRecordFile(dropId, keepId, { outputDir: OUTPUT_DIR });
      const result = mergeActivityRows(keepId, dropId);
      deleteRecordFile(dropId, { outputDir: OUTPUT_DIR });
      rebuildDossierQuietly();
      sendJson(res, 200, {
        ok: true,
        ...result,
        keep_file_name: keepName,
        drop_file_name: dropName,
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // POST /api/activity/power-flag {id, flagged, reason?}  标记/取消「功率不可信」
  if (req.method === "POST" && url.pathname === "/api/activity/power-flag") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    const identifier = bodyActivityIdentifier(body);
    if (!identifier)
      return sendJson(res, 400, { error: t(lang, "srv.activity_id_invalid") });
    if (typeof body?.flagged !== "boolean")
      return sendJson(res, 400, { error: t(lang, "tool.flag_invalid") });
    try {
      const r = setPowerFlagAndRefresh(
        resolveActivityUuid(identifier),
        body.flagged,
        lang,
        typeof body?.reason === "string" ? body.reason.slice(0, 200) : null,
      );
      sendJson(res, 200, r);
    } catch (e) {
      const status = e.message === t(lang, "activity.not_found") ? 404 : 400;
      sendJson(res, status, { error: e.message });
    }
    return;
  }

  // DELETE /api/activity?id=<uuid>  删除训练（二次确认在前端；报告/对话保留为孤儿）
  if (req.method === "DELETE" && url.pathname === "/api/activity") {
    const idParam = url.searchParams.get("id");
    const identifier = isActivityUuid(idParam)
      ? idParam
      : safeName(idParam) || safeName(url.searchParams.get("name"));
    const uuid = resolveActivityUuid(identifier);
    if (!uuid) return sendJson(res, 404, { error: t(lang, "srv.activity_not_found") });
    try {
      const deleted = deleteActivity(uuid);
      deleteRecordFile(uuid, { outputDir: OUTPUT_DIR });
      rebuildDossierQuietly();
      sendJson(res, 200, { ok: true, ...deleted });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/profile  当前用户背景与训练目标（identity / goal / configured）
  if (req.method === "GET" && url.pathname === "/api/profile") {
    sendJson(res, 200, getProfile());
    return;
  }

  // POST /api/profile  {identity?, goal?}  更新用户背景与训练目标（写训练库 settings 表）
  if (req.method === "POST" && url.pathname === "/api/profile") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    try {
      sendJson(res, 200, { applied: true, profile: setProfile(body ?? {}, lang) });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/activity?id=<uuid>（id 也接受旧文件名；兼容 ?name=）
  if (req.method === "GET" && url.pathname === "/api/activity") {
    const idParam = url.searchParams.get("id");
    const identifier = isActivityUuid(idParam)
      ? idParam
      : safeName(idParam) || safeName(url.searchParams.get("name"));
    const uuid = resolveActivityUuid(identifier);
    const summary = uuid && getActivitySummary(uuid);
    if (!summary) return sendJson(res, 404, { error: t(lang, "srv.activity_not_found") });
    // 异常标注按请求语言渲染（结构化 anomalies → 文本；旧数据字符串原样透传）
    if (Array.isArray(summary.anomalies)) {
      summary.anomalies = summary.anomalies.map((a) => formatAnomaly(a, lang));
    }
    // form_note 按 form_state 本地化（旧数据无 form_state 时保留存档文本）
    const ac = summary.athlete_context ?? {};
    const fsKey = FORM_STATE_KEYS[ac.form_state];
    if (fsKey) ac.form_note = t(lang, fsKey);
    // 分区具体范围（W / bpm）：按分析当时的骑手参数（athlete_context）换算，
    // 与分区分布条的计算口径一致；库中无 athlete_context 时回落当前生效参数
    const zone_ranges = {
      power: zoneRanges(POWER_ZONES, ac.ftp_watts ?? ATHLETE.ftp_watts),
      hr: zoneRanges(HR_ZONES, ac.max_hr ?? ATHLETE.max_hr),
    };
    sendJson(res, 200, {
      uuid,
      activity_id: uuid,
      file_name: getActivityFileName(uuid),
      summary,
      zone_ranges,
    });
    return;
  }

  // GET /api/records?id=<uuid>（id 也接受旧文件名；兼容 ?name=）
  if (req.method === "GET" && url.pathname === "/api/records") {
    const idParam = url.searchParams.get("id");
    const identifier = isActivityUuid(idParam)
      ? idParam
      : safeName(idParam) || safeName(url.searchParams.get("name"));
    const uuid = resolveActivityUuid(identifier);
    const data = uuid && loadRecords(uuid, { outputDir: OUTPUT_DIR });
    if (!data)
      return sendJson(res, 404, { error: t(lang, "srv.records_not_found") });
    sendJson(res, 200, data);
    return;
  }

  // POST /api/upload?filename=x.fit（body 为 FIT 原始字节）
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const name = safeName(url.searchParams.get("filename"));
    if (!name || !name.toLowerCase().endsWith(".fit"))
      return sendJson(res, 400, { error: t(lang, "srv.filename_fit") });
    const buf = await readBody(req, 64 * 1024 * 1024, lang);
    if (!buf.length) return sendJson(res, 400, { error: t(lang, "srv.file_empty") });
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const fitPath = path.join(INPUT_DIR, name);
    fs.writeFileSync(fitPath, buf);
    try {
      const { summary, uuid, duplicate_of } = await analyzeFile(fitPath, OUTPUT_DIR);
      sendJson(res, 200, {
        uuid,
        activity_id: uuid,
        file_name: name,
        duplicate_of: duplicate_of ?? null,
        summary,
      });
    } catch (e) {
      fs.rmSync(fitPath, { force: true }); // 分析失败的文件不留档
      sendJson(res, 422, { error: t(lang, "srv.parse_failed", { msg: e.message }) });
    }
    return;
  }

  // POST /api/ai  {mode, file_name?, compare_with?, race_date?, lang?}
  if (req.method === "POST" && url.pathname === "/api/ai") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    // 报告语言：请求体 lang 显式指定（前端随界面语言提交）> 请求头/训练库解析
    const aiLang = body?.lang ? normalizeLang(body.lang) : lang;
    let prompt;
    try {
      prompt = buildPromptForMode(body, aiLang);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!isAiConfigured()) {
      // 未配置密钥：退回 P2 模式，把提示词给前端供手动复制
      return sendJson(res, 200, { configured: false, prompt });
    }
    // 已配置：先写入 pending 占位记录，再返回 202 给前端；
    // 后台完成 AI 调用后更新为 completed，失败则更新为 failed 并记录原因。
    let reportId;
    try {
      reportId = createPendingAiReport(body.mode, reportContextOf(body), prompt);
    } catch (e) {
      return sendJson(res, 500, { error: t(aiLang, "srv.report_create_failed", { msg: e.message }) });
    }
    sendJson(res, 202, {
      accepted: true,
      report_id: reportId,
      message: t(aiLang, "srv.ai_submitted"),
    });
    (async () => {
      try {
        let chunkCount = 0, charCount = 0, heartbeats = 0;
        // agentic 模式：提示词末尾追加工具使用指引与用户记忆段（未配置密钥走
        // 复制提示词时不含这两段——复制出去的提示词无法回调本机工具）
        let finalPrompt = prompt;
        if (AI_CONFIG.agentic !== false) {
          finalPrompt += "\n\n" + buildAgenticSection(aiLang);
          const mem = buildMemorySection(listMemories(), aiLang);
          if (mem) finalPrompt += "\n\n" + mem;
        }
        const markdown = await callAiMaybeAgentic(
          [{ role: "user", content: finalPrompt }],
          {
            source: body.mode, // 场景标记：save_memory 写入 ai_memories.source
            lang: aiLang,
            onChunk: (delta) => {
              chunkCount++;
              charCount += delta.length;
              if (chunkCount === 1) console.log("[AI] 开始接收流式 chunk...");
              if (chunkCount % 5 === 0) {
                console.log(`[AI] 已接收 ${chunkCount} 个 chunk，累计 ${charCount} 字符`);
              }
            },
            onHeartbeat: () => {
              heartbeats++;
              console.log(`[AI] 仍在生成中...（${heartbeats * 30}s）`);
            },
          },
        );
        updateAiReport(reportId, { markdown, status: "completed", error: null });
        console.log(
          `[AI] 完成：report_id=${reportId}，${chunkCount} 个 chunk，${charCount} 字符，心跳 ${heartbeats} 次`,
        );
      } catch (e) {
        updateAiReport(reportId, { status: "failed", error: e.message });
        console.error(`[AI] 后台分析失败: ${e.message}`);
      }
    })();
    return;
  }

  // POST /api/ai/chat  {chat_id?, mode:'follow_up'|'chat', message, report_id?, file_name?, lang?}
  // 落库 user 消息 + pending 占位 → 202；后台 agentic 生成后回填 completed/failed
  if (req.method === "POST" && url.pathname === "/api/ai/chat") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    const chatLang = body?.lang ? normalizeLang(body.lang) : lang;
    if (!isAiConfigured())
      return sendJson(res, 400, { error: t(chatLang, "srv.ai_key_missing") });
    const mode = body?.mode;
    if (!/^(follow_up|chat)$/.test(mode ?? ""))
      return sendJson(res, 400, { error: t(chatLang, "srv.mode_invalid") });
    const message = String(body?.message ?? "").trim();
    if (!message) return sendJson(res, 400, { error: t(chatLang, "srv.message_empty") });
    if (message.length > 2000)
      return sendJson(res, 400, { error: t(chatLang, "srv.message_too_long", { n: 2000 }) });

    let chatId = body?.chat_id;
    if (chatId != null) {
      // 继续既有对话：校验存在（404），沿用其 mode/report_id/file_name
      chatId = Number(chatId);
      if (!Number.isInteger(chatId) || chatId <= 0)
        return sendJson(res, 400, { error: t(chatLang, "srv.chat_id_invalid") });
      if (!getAiChat(chatId)) return sendJson(res, 404, { error: t(chatLang, "srv.chat_not_found") });
    } else {
      // 新建对话：title 取首条消息前 50 字
      const activityId = activityRefOf(body, "activity_id", "file_name");
      const reportId = Number(body?.report_id);
      chatId = createAiChat(mode, {
        report_id: Number.isInteger(reportId) && reportId > 0 ? reportId : null,
        activity_uuid: activityId,
        title: message.slice(0, 50),
      });
    }
    addAiChatMessage(chatId, "user", message);
    const pendingId = addAiChatMessage(chatId, "assistant", "", "pending");
    touchAiChat(chatId);
    sendJson(res, 202, {
      accepted: true,
      chat_id: chatId,
      message_id: pendingId,
      message: t(chatLang, "srv.chat_submitted"),
    });
    (async () => {
      try {
        // 系统段每轮按当前状态重新拼装（备注/profile 修改后下一轮自动生效）；
        // 历史只带 user/assistant 正文，排除 pending 占位与失败消息
        const chat = getAiChat(chatId);
        const history = chat.messages
          .filter((m) => m.status === "completed" && m.content)
          .map((m) => ({ role: m.role, content: m.content }));
        const messages = [
          { role: "user", content: buildChatSystemSection(chat, chatLang) },
          ...history,
        ];
        let heartbeats = 0;
        const markdown = await callAiMaybeAgentic(messages, {
          source: chat.mode, // 场景标记：save_memory 写入 ai_memories.source
          lang: chatLang,
          onHeartbeat: () => {
            heartbeats++;
            console.log(`[AI chat] 仍在生成中...（${heartbeats * 30}s）`);
          },
        });
        updateAiChatMessage(pendingId, { content: markdown, status: "completed", error: null });
        touchAiChat(chatId);
        console.log(`[AI chat] 完成：chat_id=${chatId}，message_id=${pendingId}，${markdown.length} 字符`);
      } catch (e) {
        updateAiChatMessage(pendingId, { status: "failed", error: e.message });
        touchAiChat(chatId);
        console.error(`[AI chat] 后台生成失败: ${e.message}`);
      }
    })();
    return;
  }

  // GET /api/ai/chat?id=  对话元信息 + 全部消息；有 pending 消息时 202（前端继续轮询）
  if (req.method === "GET" && url.pathname === "/api/ai/chat") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: t(lang, "srv.id_invalid") });
    const chat = getAiChat(id);
    if (!chat) return sendJson(res, 404, { error: t(lang, "srv.chat_not_found") });
    // assistant 完成的回答附 marked 渲染后的 html（口径同报告）
    const messages = chat.messages.map((m) =>
      m.role === "assistant" && m.status === "completed" && m.content
        ? { ...m, html: marked.parse(m.content, { gfm: true, headerIds: false, mangle: false }) }
        : m,
    );
    const hasPending = messages.some((m) => m.status === "pending");
    sendJson(res, hasPending ? 202 : 200, { ...chat, messages });
    return;
  }

  // GET /api/ai/chats?mode=follow_up|chat[&report_id=]  对话列表（report_id 用于找回该报告的追问对话）
  if (req.method === "GET" && url.pathname === "/api/ai/chats") {
    const mode = url.searchParams.get("mode");
    if (!/^(follow_up|chat)$/.test(mode ?? ""))
      return sendJson(res, 400, { error: t(lang, "srv.mode_param_invalid") });
    const reportId = Number(url.searchParams.get("report_id"));
    if (url.searchParams.has("report_id")) {
      if (!Number.isInteger(reportId) || reportId <= 0)
        return sendJson(res, 400, { error: t(lang, "srv.report_id_invalid") });
      return sendJson(res, 200, { mode, chat_id: findFollowUpChat(reportId) });
    }
    sendJson(res, 200, { mode, chats: listAiChats(mode) });
    return;
  }

  // DELETE /api/ai/chat?id=  删除整个对话及其全部消息
  if (req.method === "DELETE" && url.pathname === "/api/ai/chat") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: t(lang, "srv.id_invalid") });
    if (deleteAiChat(id) === 0)
      return sendJson(res, 404, { error: t(lang, "srv.chat_not_found") });
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/ai/memories  全部 AI 记忆（含已被取代的，设置页管理用）
  if (req.method === "GET" && url.pathname === "/api/ai/memories") {
    sendJson(res, 200, { memories: listAllMemories() });
    return;
  }

  // DELETE /api/ai/memory?id=  删除指定记忆（用户可纠正 AI 记错的内容）
  if (req.method === "DELETE" && url.pathname === "/api/ai/memory") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: t(lang, "srv.id_invalid") });
    if (deleteMemory(id) === 0)
      return sendJson(res, 404, { error: t(lang, "srv.memory_not_found") });
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/ftp-estimate  基于最近窗口期骑行（功率峰曲线+心率）科学估算 FTP
  if (req.method === "GET" && url.pathname === "/api/ftp-estimate") {
    const acts = cyclingSummariesSince(FTP_ESTIMATION.window_days);
    sendJson(res, 200, estimateFtpFromHistory(acts, ATHLETE, FTP_ESTIMATION, lang));
    return;
  }

  // POST /api/ftp-apply  {ftp_w}  把估算出的 FTP 写入训练库骑手参数并立即生效
  if (req.method === "POST" && url.pathname === "/api/ftp-apply") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 1024 * 1024, lang)).toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: t(lang, "srv.body_json") });
    }
    const ftpW = Number(body?.ftp_w);
    if (
      !Number.isFinite(ftpW) ||
      ftpW < FTP_ESTIMATION.apply_min_w ||
      ftpW > FTP_ESTIMATION.apply_max_w
    ) {
      return sendJson(res, 400, {
        error: t(lang, "srv.ftp_range", {
          lo: FTP_ESTIMATION.apply_min_w,
          hi: FTP_ESTIMATION.apply_max_w,
        }),
      });
    }
    const ftpInt = Math.round(ftpW);
    // 写入训练库 settings 表并原地更新 ATHLETE，当前进程立即生效（无需重启）
    setAthlete({ ftp_watts: ftpInt }, lang);
    sendJson(res, 200, { applied: true, ftp_w: ftpInt });
    return;
  }

  // GET /api/ai/reports?mode=review
  if (req.method === "GET" && url.pathname === "/api/ai/reports") {
    const mode = url.searchParams.get("mode");
    if (!mode || !/^(review|plan|taper|compare)$/.test(mode))
      return sendJson(res, 400, { error: t(lang, "srv.report_mode_invalid") });
    sendJson(res, 200, { mode, reports: listAiReports(mode, 30) });
    return;
  }

  // GET /api/ai/report?id=1
  if (req.method === "GET" && url.pathname === "/api/ai/report") {
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0)
      return sendJson(res, 400, { error: t(lang, "srv.id_invalid") });
    const row = getAiReport(id);
    if (!row) return sendJson(res, 404, { error: t(lang, "srv.report_not_found") });
    if (row.status === "pending") {
      return sendJson(res, 202, {
        ...row,
        html: null,
        message: t(lang, "srv.report_pending"),
      });
    }
    if (row.status === "failed") {
      return sendJson(res, 502, {
        ...row,
        html: null,
        error: row.error || t(lang, "srv.ai_failed"),
      });
    }
    const html = marked.parse(row.markdown, {
      gfm: true,
      headerIds: false,
      mangle: false,
    });
    sendJson(res, 200, { ...row, html });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(WEB_DIR, path.normalize(p));
  if (!filePath.startsWith(WEB_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else if (req.method === "GET") serveStatic(req, res, url);
      else sendJson(res, 405, { error: "method not allowed" });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });
}

// 仅当作为入口脚本直接运行时启动监听（被测试 import 时不触发）
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 一次性迁移：老版本用 .env / 环境变量配置 AI（FIT_AI_*）。这里仍尝试加载
  // .env（存在才注入，Node ≥21.7 内置，无需 dotenv），仅作为迁移数据源——
  // 库中已有 ai 配置时 migrateAiEnvToDb 直接跳过，迁移完成后 env 被完全忽略。
  // 放在入口分支里而非模块顶层：测试 import createServer 时不加载真实 .env。
  try {
    process.loadEnvFile?.();
  } catch {
    // .env 不存在时静默跳过
  }
  if (migrateAiEnvToDb()) console.log("已将 FIT_AI_* 环境变量迁移到训练库（之后以设置页为准）");
  // 骑手参数 / AI 配置以训练库为准：启动时把库值合并进 ATHLETE / AI_CONFIG
  // （之后 /api/athlete、/api/ftp-apply、/api/ai-config 原地更新）
  syncAthleteFromDb();
  syncAiConfigFromDb();
  createServer().listen(PORT, HOST, () => {
    console.log(
      `VoltCoach Web 界面: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`,
    );
    if (!isAiConfigured())
      console.log("提示: 未配置 AI 密钥（设置页可配），AI 报告将退化为复制提示词模式");
    logTimezoneHint();
  });
}

/**
 * 启动时打印服务器时区：AI 报告中的训练时间按「服务器本地时区」呈现
 * （数据一律 UTC 存储），容器默认 UTC 时会整体偏移，需用 TZ 环境变量修正。
 */
function logTimezoneHint() {
  const tzMin = -new Date().getTimezoneOffset();
  const pad = (n) => String(n).padStart(2, "0");
  const offset = `UTC${tzMin >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(tzMin) / 60))}:${pad(Math.abs(tzMin) % 60)}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`服务器时区: ${zone}（${offset}）——AI 报告/对话中的时间按此时区呈现`);
  if (tzMin === 0)
    console.log(
      "提示: 当前时区为 UTC。若与你所在地不符，请为容器设置 TZ 环境变量（如 TZ=Asia/Shanghai）并重启，否则 AI 会按 UTC 解读训练时段。",
    );
}
