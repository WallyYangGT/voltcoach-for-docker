# AGENTS.md — VoltCoach（voltcoach-for-docker）项目说明（供 AI 编码代理阅读）

## 项目概览

**VoltCoach**（GitHub 仓库名 `voltcoach-for-docker`，与安卓版 App 对齐）是一个无构建步骤的 Node.js 命令行项目（主脚本 `index.js` + 配置 `src/settings.js`），用于解析码表/运动手表导出的 `.fit` 文件（当前以骑行数据为主），输出两类结果：

1. `xxx.records.csv` — 重采样到严格 1 秒网格的逐秒时序明细（timestamp, power, heart_rate, cadence, altitude, speed, distance_m, temperature），供存档与程序化计算；
2. `xxx.summary.json` — 汇总训练指标（NP、IF、TSS、功率/心率分区分布、峰功率曲线、心率漂移、圈/赛段、数据质量与异常标注），设计上用于直接喂给 AI 做训练解读。

**界面与 AI 报告双语（zh 默认 / en）**：Web UI、图表、AI 提示词/报告均支持英文；首次启动按浏览器系统语言检测（非中文一律英文，存 localStorage 并同步训练库 settings 表 `lang` 键），设置页可手动切换；CLI 提示词命令支持 `--lang en`。机制详见「界面语言（i18n）」一节。

这不是一个库，也没有构建步骤——直接运行脚本即可。

## 双仓关系与权威方向（A6，2026-10-20 落地）

- **主仓是 `WallyYangGT/voltcoach`（安卓 App，本地 `../fit-reader-android`）**：它是算法、提示词、技能与数据口径的**唯一权威**。本仓（`voltcoach-for-docker`，GitHub `Sicheng886/voltcoach-for-docker`）是它的 Docker/Web 下游版本，**随下次发版从主仓回同步**，不再要求「算法先落本仓」。
- 本批已完成 schema v2 + v3 回同步：个人训练档案、记忆分层（scope/strategy）、功率可信度（标记/校准/技能 06）、编号迁移机制；活动 uuid 身份、records 以 uuid 命名、外键/孤儿重挂、备份 v3 闸门。
- 两仓口径仍保持同源的模块：`src/settings.js`（阈值）、`src/ftp.js`、`src/tools.js`、`src/prompts.js`、`skills/`。**修改这些模块时以主仓实现为基准**，回同步 commit 应标注来源 commit（历史提交如「自 VoltCoach 回同步」）。
- 尚未回同步的主仓能力（属后续批次，不要误以为本仓已具备）：训练计划 §19、记忆回顾轮 §20、本地日全局口径 §24、业余教练模式 §30、上下文装配器/top-k/S4 §31、健康瓦片 §35、技能 07–10、多平台云同步。

## schema v3 数据口径（本仓当前）

- 训练库 `PRAGMA user_version = 3`；新库按 `src/schema.js` 整体建表，存量 v1/v2 库开库时走 `src/migrations.js` 编号迁移（v2→v3 表重建单事务，失败回滚；迁移前保留一次性 `fitness.db.pre-v3.bak`）。
- `activities.uuid`（32 位小写 hex）是对外唯一身份：Web 详情路由 `#/activity/<uuid>`、records 文件名、AI 报告/对话引用、工具入参 `activity_id` 全部用它；整数 `id` 仅内部插入序；`file_name` 是来源元数据、**不再唯一**。
- 去重判据是内容指纹（`src/dedupe.js`）：户外「同日 + 时长 ±2s + 距离 ±0.05km」，室内「同日 + 时长 ±2s + 起骑时刻 ±60s」；导入决策为指纹精确/同名同趟更新、异名同趟跳过、同名不同趟插新行。
- records 文件为 `output/<uuid>.records.csv`；存量旧基名由 `src/records-layout.js` 在开库后复制到各 uuid 再删旧文件（共享基名逐条复制），并回填室内骑行第 4 段指纹。
- 删除训练只删活动行 + records，已生成 AI 报告/对话保留（外键置 NULL，指纹保留）；重导入同一趟骑行按精确指纹自动重挂。合并重复走 `mergeActivityRows`。
- `.fitbackup` 导出 `schema_version=3`，包内 records 以 uuid 命名；旧仓 `node:sqlite` 无 SQLCipher，**不能导入新 App 的加密备份包**（导出方向仍可用；v1/v2 旧包由新 App 导入）。

## 技术栈与运行方式

- **运行时**：Node.js（本机 v24；`node:sqlite` 为内置实验特性），**ESM（ECMAScript Modules）**（`package.json` 中 `"type": "module"`，源码使用 `import`/`export` 语法），零构建、零转译。
- **依赖**：`fit-file-parser ^6.2.1`（解析 `.fit`）、`marked`（AI 报告 Markdown 转 HTML）、`dayjs`（提示词时间格式化）、`fflate`（`.fitbackup` zip STORE），均通过 `npm install` 安装。
- **关键配置**：`package.json`（`main: index.js`，脚本 `npm test` 运行 node:test 回归测试，`npm run analysis` 批量分析+趋势图）。

### 命令

```bash
npm install          # 安装依赖

# 分析单个文件（输出默认写到输入文件所在目录）
node index.js <输入.fit> [输出目录]

# 批量处理：扫描目录顶层所有 .fit（输出默认写到 cwd 的 output/）
node index.js <目录> [输出目录]
# 快捷脚本：批量分析 input/ → output/ 并自动重新生成趋势图
npm run analysis

# 运行回归测试（指标算法单测 + 合成 FIT 端到端 + Web 服务端到端，训练库用 FIT_DB_PATH 隔离）
npm test

# Web 界面（P4）：本地服务 + 浏览器仪表盘
npm run web            # 默认 http://localhost:3000，PORT 环境变量可改端口

# 训练库查询（基于 ./db/fitness.db）
node index.js --monthly [月数=6]              # 逐月训练汇总
node index.js --trend [月数=12] [输出.html]   # 生成 CTL/ATL/TSB 逐月趋势图

# AI 提示词生成（P2）：拼好 角色+指标口径+数据+问题，打印到 stdout；给输出路径则同时写 .md
node index.js --review <summary.json> [输出.md]        # 单次复盘
node index.js --plan [周数=8] [输出.md]                # 周期规划
node index.js --taper <比赛日期YYYY-MM-DD> [输出.md]   # 赛前减量
node index.js --compare <A.json> <B.json> [输出.md]    # 两次训练对比
# 提示词命令可追加 --lang en（任意位置）生成英文提示词；缺省读训练库 lang，再缺省 zh

# 项目内真实示例
node index.js input/MAGENE_C506SE_2026-07-17_202219_1273797.fit output/
```

单文件模式成功后会打印两个输出文件路径及 summary JSON 全文；批量模式逐文件打印一行进度（失败不中断）并在结尾打印成功/失败计数；解析失败时输出 `解析失败: <message>` 并以退出码 1 结束。

### 骑手参数与算法阈值

骑手参数（`ftp_watts` / `max_hr` / `weight_kg`）**以训练库为准**：存于 SQLite `settings` 表（key=`athlete`），由 Web 设置页（`POST /api/athlete`）维护；`src/settings.js` 里的 `ATHLETE` 只是出厂默认值（库中无配置时兜底）。`src/db.js` 的 `syncAthleteFromDb()` 把库值原地合并进 `ATHLETE` 导出对象（`analyzeFile()` 开头、`main()` 入口、`server.js` 启动时各调一次），`setAthlete()` 校验后写库并原地生效。功率/心率分区及间歇识别、爬坡提取、踏频分析、数据质量、累计爬升的算法阈值（`POWER_ZONES` / `HR_ZONES` / `INTERVAL_DETECTION` / `CLIMB_DETECTION` / `CADENCE_ANALYSIS` / `DATA_QUALITY` / `ELEVATION` / `PEAK_CURVE`）仍集中在 `src/settings.js`。

## 代码结构

- `src/settings.js`：算法配置（功率/心率分区、各分析阈值）+ 骑手参数出厂默认值（`ATHLETE`，训练库 settings 表无 athlete 行时兜底；Web 设置页保存后以库为准）。纯数据、无逻辑。
- `src/i18n.js`：服务端双语词典（zh 默认 / en）。`t(lang, key, vars)` 取文案并插值（zh 文案与历史逐字一致，回归测试断言依赖）；`normalizeLang()` 语言归一化；`formNote(tsb, lang)` TSB 状态简评；`formatAnomaly(anomaly, lang)` 把结构化异常标注（summary.json 的 anomalies 数组）渲染为展示文本（旧数据的字符串 anomalies 原样透传）。覆盖 db.js/ftp.js/planning.js/tools.js/ai.js/server.js 的用户可见消息与工具层文案。
- `src/db.js`：训练库模块。基于 Node 内置 `node:sqlite`（≥22.5，零第三方依赖），数据库默认 `./db/fitness.db`（可用环境变量 `FIT_DB_PATH` 覆盖，供测试隔离；懒打开，目录/表不存在时自动创建）；提供 `upsertActivity`（按文件名去重）、`computeForm`（CTL/ATL/TSB 指数加权，返回 `form_note` 本地化简评 + `form_state` 枚举 fresh/good/balanced/fatigued/overtrained 供界面/AI 按语言渲染，lang 末参缺省 zh）、`monthlySummary`（逐月汇总与强度分类）、`trendMonthly`（逐月趋势数据）、`recentFormDaily`（最近 N 天逐日 form 序列，末端延伸到当前实际日期——无训练日 TSS=0 照常衰减，首页大数字与趋势图反映"今天"而非最后一次训练日）、`recentActivities`（近期训练简明清单，供提示词上下文：基础负荷字段 + 从完整 summary 补充心率漂移/峰功率曲线/平均踏频，IF 保留 2 位小数避免反推 FTP 噪音）、`cyclingSummariesSince`（最近 N 天骑行完整 summary，FTP 历史估算用）、`listActivities` / `getActivitySummary`（Web 界面列表与详情查询，详情会把 category 与 note 合并进 summary.activity）、`setActivityCategory` / `setActivityNote`（训练分类与备注：体感/路况等自由注释，上限 2000 字，AI 复盘纳入考量）、`getProfile` / `setProfile`（settings 表 profile 行：用户身份与训练目标，各场景 AI 提示词纳入考量，两字段皆空时删行视为未配置）、`getLang` / `setLang`（settings 表 lang 键：界面语言持久化，AI 提示词语言缺省取此值）、`syncAthleteFromDb` / `getAthleteState` / `setAthlete`（settings 表骑手参数：同步进 `ATHLETE`、查询状态、校验写库并原地生效）、AI 对话持久化（`ai_chats` / `ai_chat_messages` 两表：`createAiChat`（每 mode 50 个滚动清理并级联删消息）、`addAiChatMessage` / `updateAiChatMessage`（pending/completed/failed 状态机）、`touchAiChat`、`listAiChats`（含消息数/pending 聚合）、`getAiChat`（元信息 + 消息联查）、`findFollowUpChat`（按 report_id 找回追问对话）、`deleteAiChat`（级联删除））、AI 记忆（`ai_memories` 表：`saveMemory`（≤500 字校验、category 白名单、supersedes_id 取代链、滚动清理 100 条——先删最旧已取代再删最旧有效）、`listMemories`（注入用最近 30 条有效记忆）、`listAllMemories`（管理界面用，含已取代）、`deleteMemory`）、`closeDb`（测试收尾释放句柄）。校验类错误消息按 lang 双语（各写函数带可选 lang 末参，缺省 zh）。
  - **v2/v3 更新（2026-10-20）**：`upsertActivity`（按文件名 upsert）已由 `insertActivity` / `updateActivitySummary` + `resolveActivityUuid` 取代；新增 `listActivityRideKeys`（去重/重复检查）、`deleteActivity`（先补指纹再删）、`reattachOrphanRefs`（按精确指纹重挂孤儿报告/对话）、`mergeActivityRows`（合并重复，一个事务）、`setActivityPowerFlag` / `getActivityPowerFlag`、`getDossier` / `rebuildDossierQuietly`（settings `dossier` 缓存，指纹=活动数+FTP）。`listMemories` 注入全部有效记忆（≤100；short 过期在 db 层按 `src/memory.js` 过滤），`saveMemory` 支持 `scope` 与 `category='strategy'`。每开库恢复 `PRAGMA foreign_keys=ON` 并执行 records 布局迁移；`getAthleteState` 额外返回 `ftp_calibrated`。
- `src/ftp.js`：FTP 历史估算（纯函数、无 IO）。`estimateFtpFromHistory(activities, athlete, cfg, lang)` 基于窗口期内骑行的 5min/20min 峰功率做双方法互校——Morton 双参数 CP 模型（P(t)=CP+W′/t）+ Coggan 20min×0.95；心率交叉验证（锚点全力判定、功率/心率区间系统性偏移、心率漂移中位数）；数据不足时输出 `data_needs` 收集清单；返回估值/区间/置信度（high/medium/low）。阈值集中在 src/settings.js `FTP_ESTIMATION`。
- `src/prompts.js`：AI 提示词模板库（P2），双语（zh 默认 / en）。静态文本抽为 zh/en 两套词典（`TEXT`），所有 builder 接受可选 `lang` 末参——zh 文案与历史逐字一致（回归测试断言依赖）；动态数据（JSON/数值/profile/备注/记忆原文）语言中立、原样透传（用户自填内容不翻译）。`buildMetricGlossary(lang)` 由 src/settings.js 动态生成指标口径说明；`buildProfileSection(profile, lang)` 生成"用户背景与训练目标"段（身份/目标，未配置则不产生该段），四个场景模板 `buildReviewPrompt` / `buildPlanPrompt` / `buildTaperPrompt` / `buildComparePrompt` 均接受可选 profile 参数统一纳入（review 还会在 activity.note 存在时提示 AI 结合备注印证数据），并另接受可选末参 `skills`（专业知识库段，仅服务端注入，CLI 不传保持原样）与 `now`（当前时刻，缺省 `new Date()`，测试可注入固定值）；`buildDateSection(now, lang)` 生成「当前时间」段（dayjs 按 lang 选 zh-cn/en locale 渲染本地日期/星期/时刻/UTC 偏移，并附时间口径说明——数据中的时间戳已按本地时区标注、请勿重复换算，仅纯日期字段仍为 UTC 口径；now 非法或缺失返回 null），由 `assemble` 统一插在指标口径段之后、skills 之前——四场景服务端与 CLI 提示词自动携带，server.js 的 chat/follow_up 系统段另行显式注入；`localizeTimestamps(value, key)` 把数据中的 ISO-8601 UTC 时间戳改写为带本地时区偏移的等价表示（`2026-03-25T11:51:24.000Z` → `2026-03-25T19:51:24+08:00`，时刻不变、偏移按该时刻实际生效值取）——训练数据时间戳一律 UTC 口径，不改写会被 AI 按字面当本地时间读（本地 19:51 的骑行在数据里是 11:51Z，AI 会理解成上午）；纯日期字段（`activity.date`、训练库日期）与用户自填内容（note/identity/goal 等 `USER_TEXT_KEYS`）不改写，返回新对象；`compactSummaryForPrompt(summary, lang)` 在提交前把随时长线性增长的列表压缩（anomalies 按结构化 type 键聚合为 anomalies_summary、segments 保留首尾省略中段、climbs 只留爬升最大段），保证提示词长度与训练时长无关，并在出口统一经 `localizeTimestamps` 转本地时区；`thinToWeekly()` 把逐日 form 序列抽稀为逐周点；`buildAgenticSection(lang)` 生成数据查询与计算工具使用指引（仅 Web 端 AI 调用注入，CLI 提示词命令不注入）；`buildChatInstruction(mode, lang)` 生成对话指令（follow_up：≤200 字快答、工具查询不计入字数；chat：务实简洁、结合数据、不限字数）；`buildMemorySection(memories, lang)` 生成「用户记忆」段（逐条带日期与 id、冲突以最新为准规则、save_memory 主动记录指引——无有效记忆时也返回该段显示"暂无"，保证指引始终注入；仅 Web 端 agentic 调用注入，CLI 提示词命令不注入）。除当前时间段取 `now` 参数外均为纯函数、无 IO。
  - **v2 更新**：`buildMemorySection` 把 `category='strategy'` 条目置顶为「训练策略（既定结论）」权威段、`scope='short'` 行加「短期」标注；新增 `buildDossierSection(dossier, lang)`（个人训练档案段，四场景报告 + chat/follow_up 注入，空库整段省略）；`buildAgenticSection` 工具清单加 `get_dossier` / `set_power_flag` / `recalibrate_activity_power`，activity 句柄改 `activity_id`。
- `src/ai.js`：AI API 客户端（P4）。OpenAI 兼容 chat/completions（基于 node:http/node:https 自行管理超时——旧实现用全局 fetch，undici 内置 300s body/headers 超时会把长报告生成静默掐断，表现为"AI 后台分析失败: fetch failed"；Markdown 转 HTML 由 server.js 用 `marked` 处理，ai.js 本身不依赖 marked）；**配置唯一事实来源是训练库 settings 表 ai 行**（Web 设置页维护），由 db.js `syncAiConfigFromDb()` 原地合并进 settings.js 的 `AI_CONFIG` 导出对象（api_key / base_url / model / temperature / timeout_ms / stream / stall_ms，出厂默认 Kimi `https://api.moonshot.cn/v1` + `kimi-k2.6`），**不再读取任何 FIT_AI_* 环境变量**——db.js `migrateAiEnvToDb()` 仅在 server.js 入口做一次性的老版本 env 迁入；`isAiConfigured()` 供调用方判断退化为复制提示词模式。默认非流式 + 30 秒心跳日志。`runAgentLoop(messages, tools, executeTool, opts)` 为 agentic 工具调用循环（≤6 轮、共享总超时、轮内全非流式；模型不支持 tools 返回 400 时自动降级单轮；各轮 assistant 正文取最长者返回——模型偶尔把完整报告写在带 tool_calls 的中间轮、末轮只剩收尾片段，只取末轮会让报告整体丢失；依赖注入不 import db/tools，工具调用经 onToolCall 回调交给调用方记日志）；`opts.lang` 控制超时/降级等消息语言（缺省 zh，工具截断标记与轮数耗尽指令随语言切换）。
- `src/tools.js`：AI agentic 工具集（function calling，共 15 个）：8 个只读查询（list_activities / get_activity_summary / get_activity_records / get_form_series / get_monthly_summary / get_athlete_profile / estimate_ftp / get_dossier）+ 2 个纯计算（simulate_form / generate_workout，逻辑在 src/planning.js）+ 5 个写/动作（save_memory 支持 scope 与 strategy；set_power_flag；recalibrate_activity_power；update_ftp 可选 ftp_watts 夹逼区间；reanalyze_activity）。活动句柄统一 `activity_id`（32 位 uuid），`file_name` 只展示。`toolDefs(lang)` 双语 schema + `executeTool` 分发（错误返回 `{error}` JSON 不抛，超 `AGENTIC.tool_result_max_chars` 截断）；内部调用 db.js/records.js，不重复查询逻辑。
- `src/planning.js`：计划推演纯函数（无 IO，仿 src/ftp.js）。`simulateForm({startCtl, startAtl, plan, cfg, lang})` 按 computeForm 同一递推口径推演未来逐日 CTL/ATL/TSB（紧凑数组输出），并按 FORM_SIMULATION 阈值标注 TSB 持续过低与 CTL 周增幅超阈风险；`generateWorkout({target, durationMinutes, ftpWatts, tsb, templates, tsbRecovery, lang})` 按 WORKOUT_TEMPLATES 模板拼装单次课表（热身/主组/冷身，组数由可用时长推算，剩余时长并入冷身保证各段合计=总时长；TSS 估算为逐段 时长秒×IF²/36；TSB 低于阈值自动降级恢复课；时长装不下最小组数返回 error）；风险/错误消息按 lang 双语（缺省 zh）。
- `src/records.js`：records CSV 读写（v3：只认 `<uuid>.records.csv`）——`parseRecordsCsv` / `thinRecords` / `loadRecords`（时间窗 + 点数上限）/ `loadAllRecords`（重算/校准全量）/ `readRecordStart`（首帧起骑时刻，室内指纹与标题用）/ `writeRecordsCsv`（临时文件 + rename）/ `deleteRecordFile` / `copyRecordFile` + `safeName`（basename 防路径穿越）。
- `src/records-layout.js`：v2→v3 records 布局迁移纯函数（`planRecordLayout`：共享旧基名逐条复制到 uuid 后再删旧文件、孤儿不动）+ `ensureRecordFileLayout`（settings `records_layout_version=3` 标记，失败下次重试）+ `backfillIndoorFingerprints`（无有效距离骑行按首帧补第 4 段指纹，事务内同步报告/对话引用）。
- `src/dedupe.js`：同趟骑行判定与内容指纹（户外/室内三分支）、`findDuplicateGroups`（并查集）、`decideImport`（指纹精确/同名同趟更新、异名同趟跳过、同名不同趟插入）。
- `src/identity.js`：活动 uuid 形状校验与生成（32 位小写 hex）。
- `src/dossier.js`：个人训练档案纯聚合（90 天锚最新骑行日、峰功率 PB/近 90 天、爬坡/踏频画像、强度结构、8 周负荷、心率漂移；`power_flagged` 从功率派生基线排除）。
- `src/memory.js`：短期记忆失效判定单源（14 天或 5 次新训练，先到即失效）。
- `src/schema.js` / `src/migrations.js`：v3 建表脚本 + 编号步进迁移（v1→2 加列、v2→3 表重建单事务、`PRAGMA user_version=3`）；开库入口 `migrateSchema` 处理新库/v1 残留/v2/v3 丢戳分支。
- `src/backup-manifest.js`：`.fitbackup` 清单校验与版本闸门（包版本高于本机拒绝）。
- `src/power-calib.js`：功率可信度编排（`setPowerFlagAndRefresh` 标记并重建档案；`recalibrateActivityPower` 系数夹逼 0.5–1.5、重算写回、返回新旧 diff）。
- `src/skills.js`：技能文档系统（训练科学知识库注入 AI 提示词）。`loadSkills(lang)` 每次调用实时扫描 `skills/` 目录（不缓存——用户直接往目录放 `.md` 文件即可扩充，无需改代码/重启；文件名排序加载、`_` 前缀与非 `.md` 跳过、空文件与读取失败跳过、目录不存在返回 `[]`；标题取文件首个 `# ` 一级标题行，缺失用文件名兜底；目录可用环境变量 `FIT_SKILLS_DIR` 覆盖，测试隔离用），`buildSkillsSection(lang)` 拼成「专业知识库」提示词段（无技能返回 null）。**双语约定**：文件名以 `.en.md` 结尾 → 英文技能（lang='en' 时加载）；其余 `.md` 文件（含无后缀）→ 中文技能（zh 默认加载，向后兼容旧文件名）；同一主题可放两份（如 `01-coggan-power.md` + `01-coggan-power.en.md`）。注入点：server.js 四场景报告（经 prompts.js 四模板的可选 `skills` 末参，插在指标口径段之后）+ chat 直接对话系统段；follow_up 追问与 CLI 提示词命令不注入。内置技能：`skills/01-coggan-power.md`（Coggan 功率体系）+ `.en.md` 英文版、`02-trainingpeaks-load.md`（CTL/ATL/TSB 负荷模型）+ `.en.md`、`03-heart-rate.md`（心率区间与解读）+ `.en.md`、`04-report-writing.md`（报告撰写规范）+ `.en.md`、`05-weekly-planning.md`（周计划节奏：按星期几安排训练周，与「当前时间」段配合）+ `.en.md`、`06-power-data-quality.md`（功率数据质量与校准：失真启发式、标记/校准流程与边界）+ `.en.md`；`skills/_README.md` 为目录使用说明（不注入）。
- `src/settings.js` 另含 `AGENTIC` 配置块（max_rounds / tool_result_max_chars / records_max_points / list_limit / form_max_days / monthly_max / simulate_max_days）、`FORM_SIMULATION` 负荷推演风险阈值（TSB 持续过低 / CTL 周增幅上限 / TSB 恢复课降级线）、`WORKOUT_TEMPLATES` 课表模板（recovery/endurance/sweet_spot/threshold/vo2max 的功率区间、组数与时长范围）与 `AI_CONFIG.agentic` 开关（默认开）。
- `server.js`：Web 服务（P4，`npm run web`）。Node 内置 http，零依赖；静态托管 `web/` 前端 + REST API（`/api/overview` 仪表盘聚合（含 `athlete_configured` 首开引导标记）、`GET/POST /api/athlete` 骑手参数查询与更新（写训练库 settings 表并原地生效）、`GET/POST /api/ai-config` AI 服务配置查询与更新（同样写 settings 表并原地生效）、`GET/POST /api/profile` 用户身份与训练目标查询与更新（写 settings 表 profile 行，各场景 AI 提示词纳入考量）、`GET/POST /api/lang` 界面语言查询与保存（写 settings 表 lang 键，前端首启检测/设置页切换同步）、`POST /api/activity/category` 训练分类标记、`POST /api/activity/note` 训练备注保存（空串清除）、`/api/activity`（完整 summary + `zone_ranges` 分区具体范围：POWER_ZONES/HR_ZONES × athlete_context 骑手参数换算的 W/bpm 区间文本，前端分区条右侧显示；anomalies 按请求语言格式化、form_note 按 form_state 本地化）、`/api/records` 时序抽稀 ≤1400 点、`POST /api/upload` 原始字节上传 FIT 即分析入库、`GET /api/ftp-estimate` FTP 历史估算、`POST /api/ftp-apply` 把估算 FTP 写入训练库骑手参数并原地更新 `ATHLETE` 使当前进程即时生效、`POST /api/ai` 四场景 AI 报告/提示词（提示词统一注入专业知识库段，见 src/skills.js；按请求语言生成，见下方「界面语言（i18n）」）、返回 `marked` 渲染后的 HTML、保存到 `ai_reports` 表并保留每 mode 最近 30 条、`POST /api/ai/chat` AI 对话统一入口（follow_up 报告追问 / chat 直接对话；落库 user 消息 + pending 占位 → 202 → 后台 agentic 生成回填，系统段每轮重拼：指令 + 当前时间 + 关联报告正文与压缩训练数据 + 工具指引）、`GET /api/ai/chat`（对话详情，有 pending 时 202 快照供轮询）、`GET /api/ai/chats`（对话列表，可选 report_id 找回该报告的追问对话）、`DELETE /api/ai/chat`（整串删除，每 mode 滚动保留 50 个）、`GET /api/ai/reports`、`GET /api/ai/report`、`GET /api/ai/memories`（全部记忆含已取代）、`DELETE /api/ai/memory`）；报告与对话的 agentic 调用注入记忆段（最近 30 条有效记忆），save_memory 的 source 场景标记由调用方透传；文件名参数一律 basename 防路径穿越；输出/输入目录可用 `FIT_OUTPUT_DIR` / `FIT_INPUT_DIR` 覆盖（测试隔离）。
  - **v3 更新**：活动接口优先 `?id=<uuid>`（兼容旧 `?name=`）；上传返回 `uuid`/`activity_id` 与 `duplicate_of`；新增 `POST /api/activity/power-flag`、`DELETE /api/activity?id=`、`GET /api/dossier`、`GET /api/duplicates`、`POST /api/activity/merge`；AI 报告/对话落库用 `activity_uuid`，列表 JOIN 活动返回展示文件名，活动删除显示「训练已删除」。
- `web/`：纯 HTML/CSS/JS SPA（P4），零依赖零构建，浏览器原生 ES Module（`index.html` 以 `<script type="module">` 加载 `app.js`，server.js 已按 `text/javascript` 提供 `.js`）：模块化结构为 `web/app.js`（入口：hash 路由 + 顶栏导航 + 首开引导 + **语言初始化**——首次启动按 `navigator.language` 检测（非中文一律 en）存 localStorage 并同步 `POST /api/lang`，应用静态导航文案（data-i18n）与 `<html lang>`）、`web/js/i18n.js`（**前端双语词典**：`DICT` zh/en 两套文案 + `t(key, vars)` 插值 + `detectLang/getStoredLang/setStoredLang` + 标签类函数 sportLabel/categoryLabel/modeLabel/memCategoryLabel/memSourceLabel/formNote/cadenceStyleHint，零依赖）、`web/js/common.js`（共享基础：$/esc/api（自动带 X-Lang 头）/弹窗/格式化（fmtLocalDateTime 按语言选 locale）/徽章标签/全局 state 与概览缓存/顶栏骑手参数条/训练列表行）、`web/js/charts.js`（手写 SVG 图表：多系列时序图各系列独立纵轴、≤180s 短缺口线性插值桥接显示（码表自动暂停产生的停顿不断线，仅显示层不改数据）、CTL/ATL/TSB 趋势、分区分布、峰功率曲线）、`web/js/ai.js`（AI 报告生成/历史列表/追问/对话轮询与消息渲染——详情页、AI 报告页、对话页三方共用；AI 请求体带 lang）、`web/js/views/`（8 个视图各一文件：dashboard/activities（含详情）/upload/ai/chat/settings/memory/about）；依赖方向单向：views → common/charts/ai，app.js → views，禁止视图互相 import。路由覆盖概览/训练/详情/上传/AI 报告/对话/记忆/设置/关于，导航栏右侧三点菜单展开「记忆」与「设置」；详情页含训练分类标记与训练备注（体感/路况自由注释，保存按钮写库，AI 复盘纳入考量）；「AI 报告」页生成/查看报告并支持追问（持久化 follow_up 对话：提交后异步生成、前端轮询、可关闭页面事后回看，回答 ≤200 字且结合本次训练具体数据，报告下可「清除追问」）；「对话」页（#/chat）支持无报告上下文的直接对话（AI 经 agentic 工具自行取数）、对话新建/删除与 pending 轮询；「记忆」页（#/memory）独立列出全部 AI 记忆含已取代标记，只做删除不做编辑；设置页维护**界面语言（切换即刷新，同步训练库）**、骑手参数、身份与训练目标（身份一句话/目标一段话，AI 报告纳入考量）与 AI 服务配置（存训练库，保存后跳回首页，未配置时首开自动引导）；暗色平面科技运动风（荧光黄 volt 主色 + 斜切元素 + 等宽斜体大数字）。
  - **v3 更新**：详情路由 `#/activity/<uuid>`（API 带 `?id=`）；列表行/上传链接/AI 选择器全部用 uuid；详情页新增「功率不可信」开关与删除按钮（二次确认）；训练列表页新增重复检查/合并面板；记忆页按短期/长期分区并标注已失效；新增档案页 `#/dossier`（views/dossier.js，只读长期基线）；三点菜单加「档案」。视图数 9 个。
- `index.js`（约 800 行）：主脚本，内部组织为：

| 区块 | 内容 |
|---|---|
| 工具函数 | `zoneOf` / `zoneDistribution`（区间分布）、`normalizedPower`（30s 滚动平均的四次方均根，缺口窗口不参与）、`peakAvg`（指定时长最大平均功率，要求窗口连续）、`fillShortGaps`（≤阈值短缺口线性插值，峰功率曲线/FTP 估算前预处理）、`hrDriftPct`（前后半程效率因子相对变化，功率或速度口径）、`findPowerGaps`（功率缺失 > 60s 检测）、`findMissingSpans`（整段记录缺失检测）、`detectPauseSpans`（计时暂停识别：FIT timer 事件区间 / 设备累计距离冻结 / 恢复侧静止三级判据，阈值见 `DATA_QUALITY`）、`patchTruncatedFitHeader`（截断 FIT 头修复：头声明 `data_size` 超过实际字节数时改写为可用长度，用于 v5 结构校验下的损坏文件兜底）、`collectDeveloperFields`（非标准字段数值统计）、`elevationGain`（滞回去抖的累计爬升：以最近确认点为基线，累计上升达阈值才计入，亚米级气压抖动不计数）、`avgField` / `maxField`（片段统计）。纯函数均 `export`，供单元测试直接引用；`main()` 仅当作为入口脚本运行时执行 |
| P0 分析函数 | `estimateFtp`（20min 峰功率 × 0.95 估算 FTP 并给更新建议）、`detectIntervals`（≥105% FTP 过阈段识别 + 间歇组统计）、`detectClimbs`（30s 窗口坡度 ≥3% 的爬坡段提取）、`cadencePowerAnalysis`（发力时段踏频习惯与踏频-功率相关性） |
| 单文件流程 `analyzeFile()` | ① 解析 FIT（`force: true`, `km/h`, `km`, `mode: "list"`；海拔/爬升由解析器缩放成 km，代码统一换回米；首次解析失败时经 `patchTruncatedFitHeader()` 改写头声明重试一次）→ ② 按秒重采样记录（缺口置 `null`，暂停不计入时长/缺失）→ ③ 计算指标（跑步配速/游泳 length/无功率时省略 power 段；anomalies 结构化、踏频风格枚举）→ ④ v3 去重决策（`decideImport`：指纹精确/同名同趟更新、异名同趟跳过、同名不同趟插新行）→ ⑤ records 写到 `<uuid>.records.csv` + 训练库写入/更新 + `athlete_context` 注入当日 CTL/ATL/TSB（失败仅警告；DB 失败仍落孤儿 records）→ ⑥ 按指纹重挂孤儿报告、重建档案、写 `<base>.summary.json`，返回 `{csvPath, jsonPath, summary, uuid, duplicate_of}` |
| 查询命令 | `printMonthly()`（逐月汇总表）、`writeTrendHtml()`（自包含 HTML 趋势图：月 TSS 柱 + CTL/ATL/TSB 月末折线 + 指标解读脚注，原生 SVG 无外部库） |
| 提示词命令（P2） | `emitPrompt()`（打印 stdout + 可选写 .md）、`loadSummaryJson()`、`emitPlanPrompt()` / `emitTaperPrompt()`（从训练库取数并调 src/prompts.js 组装）、`cliLang()` / `cliArgv()`（`--lang en` 解析：剔除标志后取位置参数，缺省读训练库 lang 再缺省 zh） |
| 入口 `main()` | `--monthly` / `--trend` → 训练库查询；`--review` / `--plan` / `--taper` / `--compare` → 提示词生成（可带 `--lang en`）；输入是目录 → 批量模式（逐文件调用 `analyzeFile`，失败不中断）；输入是文件 → 单文件模式并打印 JSON 全文 |

目录约定：`input/` 放待分析的 `.fit` 文件，`output/` 放分析结果。这两个目录只是约定，脚本本身不依赖它们。

## 版本控制约定（重要）

- 项目使用 **git** 进行版本控制。**每次完成修改后（无论是代码、配置还是文档变更）都必须先提升 `package.json` 中的 `version` 字段，再执行 `git commit`**，并附上清晰描述本次变更内容的中文 commit message。
- 当前版本：`2.0.0`（schema v3 破坏性数据格式变更：活动 uuid 身份、records uuid 命名、备份 v3 闸门）。版本号遵循语义化版本（SemVer）：`MAJOR.MINOR.PATCH`，bug 修复/小调整升 PATCH，新增功能升 MINOR，破坏性改动升 MAJOR。
- 推荐工作流：
  1. 完成修改并跑通 `npm test`。
  2. 运行 `npm version patch|minor|major --no-git-tag-version`（仅修改 `package.json` 与 `package-lock.json`，不自动提交、不打 tag）。
  3. `git add package.json package-lock.json <其他变更文件> && git commit -m "中文提交说明"`。
  4. 如需发版，再手动打标签：`git tag v$(node -p "require('./package.json').version")`，然后推送 `git push && git push --tags`。
- commit message 约定：使用中文，简要说明“做了什么 + 为什么”，例如 `重构: index.js 迁移到 ESM 模块`。
- `node_modules/`、`output/`、`db/` 等生成物不入库（见 `.gitignore`）。

## 开发约定与编码风格

- 使用 ESM 语法（`import`/`export`），禁止使用 CommonJS 的 `require`/`module.exports`。
- 注释与文档一律使用**中文**（本项目的主要自然语言），函数级注释说明算法口径（如"30s 滚动平均的四次方均根"）。
- 主逻辑集中在 `index.js`：新功能优先加入"工具函数"区，保持纯函数、无状态；分区定义与算法阈值一律放进 `src/settings.js`，不要在 `index.js` 里硬编码常量；骑手参数属于"会变的数据"，走训练库 settings 表（src/db.js `setAthlete`），不要新增文件型配置。
- 数值处理惯例：缺数据统一用 `null` 表示（CSV 中留空，JSON 中字段可省略）；`undefined` 字段在输出前会被清理； rounding 口径写在代码里（如功率取整、海拔保留 1 位、速度保留 2 位）。
- 算法须遵循运动科学标准口径（公式见下文「输出格式与指标算法口径」一节），改算法时同步更新该节。
- 核心指标依赖骑手参数（FTP / 最大心率 / 体重），生效值 = 训练库 settings 表 athlete 行（Web 设置页维护），库中无配置时回落 `src/settings.js` 的 `ATHLETE` 出厂默认值。

## 输出格式与指标算法口径

summary.json 字段（喂 AI 的汇总结构，records.csv 列见上文「项目概览」）：

- `activity`：日期、运动类型（cycling/running/swimming）、时长（剔除计时暂停，只含实际计时骑行时间）、距离、爬升（优先用码表自报 `session.total_ascent`，缺失时自算；附 `elevation_gain_source: 'device'|'computed'` 标明口径）、平均速度、卡路里
- `athlete_context`：骑手参数 + 当日 CTL/ATL/TSB + `form_state` 枚举（fresh/good/balanced/fatigued/overtrained，语言中立）与 `form_note` 简评（分析时语言，界面按 form_state 重新本地化）
- `power`：平均/NP/最大功率、VI、IF、TSS、功体比、峰功率曲线（5s/1min/5min/20min）、FTP 自动估算、Coggan 7 区时间分布
- `heart_rate`：平均/最大心率、5 区时间分布、心率漂移（有氧解耦 %）
- `cadence`：平均踏频（剔除 0 rpm 滑行秒，只统计踩踏时段，与码表 session / Strava 口径一致；跑步为步频 spm）
- `temperature`（avg/min/max）/ `pace`（仅跑步：配速 min/km）/ `swim`（仅游泳：趟数/泳池长度/划水/SWOLF）/ `developer_fields`（非标准字段数值统计）
- `cadence_power`（踏频-功率联合分析，发力习惯为 `style` 枚举 normal/low_cadence/high_cadence，界面/AI 按语言渲染）、`climbs`（爬坡段）、`interval_set`（间歇组）、`segments`（圈/赛段 + 间歇工作段）、`anomalies`（设备异常标注，**结构化对象**：`{type: 'power_gap'|'record_gap'|'timer_pause'|'hr_jump', duration_sec?, from?, to?, at}`——语言中立，展示时经 src/i18n.js `formatAnomaly()` 按语言渲染，旧库字符串格式原样透传）、`data_quality`（覆盖率/丢弃数/缺失秒数（不含暂停）/暂停秒数 `pause_seconds`）

指标算法口径：

- NP：30s 滚动平均 → 四次方均值 → 开四次方根（缺口窗口不参与）；IF = NP / FTP；TSS = 时长秒 × NP × IF / (FTP × 3600) × 100
- 心率漂移（有氧解耦）：前后半程效率因子的相对变化；骑行用功率/心率，无功率数据时自动切换速度/心率
- CTL = TSS 的 42 天指数加权（体能）；ATL = 7 天（疲劳）；TSB = CTL − ATL（状态）；缺天按 TSS=0 参与衰减
- 峰功率曲线要求窗口数据连续，但允许 ≤10s 的短缺口先线性插值补齐再取峰（容忍功率计偶发掉秒，阈值见 src/settings.js `PEAK_CURVE.max_interp_gap_sec`；NP/分区/TSS 仍用原始序列）
- 累计爬升：优先采用码表自报 `session.total_ascent`（与码表屏幕同口径，设备气压计自带滤波校准）；缺失时自算——滞回去抖（以最近确认点为基线，累计上升 ≥ `ELEVATION.noise_threshold_m` 才计入并抬升基线，期间跌破基线则下跟新低，亚米级气压抖动不计数）；record 海拔缺失时回退 `enhanced_altitude`
- 计时暂停识别：码表暂停/自动暂停期间不写记录，网格上表现为整段空缺；按三级判据归类（FIT timer `stop_all`→`start` 事件区间相交 > 设备累计距离在空缺两侧冻结（跳变 ≤ `DATA_QUALITY.pause_dist_jump_m`，骑行中掉数据距离会按速度继续跳变）> 恢复侧静止（恢复后窗口内最大速度 < `pause_resume_speed_kmh`）），命中标 `timer_pause` 且不计入时长/TSS/平均速度/缺失秒数；未命中的空缺仍标 `record_gap`/`power_gap`（与暂停区间重叠的功率缺失不算异常）
- 异常检测：功率缺失 >60s、整段记录缺失 ≥10s、心率跳变（相邻秒差 >25）
- FTP 自动估算：20min 峰功率 × 0.95（无连续 20min 窗口时省略）
- 间歇识别：≥105% FTP 过阈段，≤10s 瞬时掉功率合并、<30s 丢弃；爬坡段：30s 窗口坡度 ≥3% 且爬升 ≥15m、长度 ≥300m；踏频-功率联合分析：仅统计 ≥75% FTP 发力时段，低踏频 <80rpm / 高踏频 >90rpm
- 月度强度分布：低(Z1–Z2)/中(Z3–Z4)/高(Z5–Z7) 按时长加权；低≥75% 且高>中 → polarized，低>中>高 → pyramidal，其余 → sweet_spot

## 界面语言（i18n）

**双语（zh 默认 / en），单位保持公制**（W/km/km/h/kg/°C/m，不做英制换算）。覆盖 Web UI 全部文案、SVG 图表标签、AI 提示词与报告、服务端错误消息。

- **检测与持久化**：前端首次启动（localStorage 无记录）按 `navigator.language` 检测——`startsWith('zh')` → zh，其余一律 en；存 localStorage（`voltcoach.lang`）并 `POST /api/lang` 同步到训练库 settings 表 `lang` 键。设置页可手动切换（切换即刷新并再次同步）。
- **服务端语言解析**（server.js `resolveLang`）：请求显式 `lang`（query / X-Lang 头）> 训练库 `lang` > Accept-Language（zh → zh，其他具体语言标签 → en；`*`/空视为无偏好回落 zh）> zh 默认。前端 `api()` 封装统一带 X-Lang 头；AI 报告/对话接口以请求体 `lang` 为准（异步后台任务在提交时捕获语言）。
- **AI 报告语言**：提示词整体按语言生成（prompts.js 双语词典，英文模板自然产出英文报告，无需额外语言指令）；当前日期时间段经 dayjs locale 随语言渲染（zh-cn → 星期四 / en → Thursday，时区取服务器本地）；专业知识库按语言加载（skills/ 的 `.en.md` 文件）；工具 schema（tools.js `toolDefs(lang)`）与工具错误消息随语言切换。历史报告 markdown 保持生成时语言，不事后翻译。
- **数据层语言中立**：summary.json 不存展示文本——anomalies 结构化（type 枚举）、cadence_power.style 枚举、athlete_context.form_state 枚举，展示时按请求语言渲染（formatAnomaly / form.note.* / cad.style.*）；旧库字符串数据原样透传。用户自填内容（身份/目标/备注/记忆）不翻译。**时间戳在提示词出口统一本地化**：数据落盘（summary.json / records.csv / 训练库日期）一律 UTC 口径不变，喂 AI 前经 `localizeTimestamps` 改写为带本地时区偏移的 ISO 表示（`11:51Z` → `19:51+08:00`），并在「当前时间」段声明该口径——否则 AI 会按字面把本地傍晚的骑行读成中午；纯日期字段（`activity.date`、训练库日期）不换算，以与界面显示、训练库查询保持一致。
- **CLI**：`--review/--plan/--taper/--compare` 支持 `--lang en`（任意 argv 位置，经 `cliArgv()` 剔除后取位置参数）；缺省读训练库 lang，再缺省 zh。`--monthly`/`--trend` 输出保持中文（开发工具）。
- **词典位置**：服务端消息在 `src/i18n.js`（含 formatAnomaly/formNote），提示词模板在 `src/prompts.js` 的 `TEXT` 词典，工具描述在 `src/tools.js` 的 `TOOL_TEXT`，前端文案在 `web/js/i18n.js` 的 `DICT`。**zh 文案与历史版本逐字一致（回归测试断言依赖），改中文文案时同步改 en 并跑 `npm test`。**

## 测试策略

**自动化测试已落地**（P3）：`npm test` = `node --test "test/*.test.mjs"`，零新增依赖（Node 内置 node:test）。

- `test/make_test_fit.mjs`：手写 FIT 二进制生成器（文件头/定义消息/数据消息/CRC-16），可生成骑行（含功率缺失/记录缺失/无时间戳坏记录/开发者字段）、跑步、游泳（length 消息）合成文件；也可直接 `node test/make_test_fit.mjs [目录]` 生成样例。
- `test/unit.test.mjs`：指标算法纯函数单测（NP/peakAvg/分区/爬升去抖/间歇识别/心率漂移/FTP 估算/缺失检测/开发者字段 + src/ftp.js 历史估算：CP 模型/数据充分性/心率交叉验证各分支 + src/prompts.js 提示词数据压缩与当前日期时间段（buildDateSection 固定时刻断言）、时间戳本地化（`localizeTimestamps`：改写为本地偏移且时刻不变、用户自填内容不改写） + src/planning.js：simulateForm 衰减/收敛/两类风险触发与不触发、generateWorkout 五种模板结构/瓦数换算/TSS 口径/时长不足报错/TSB 降级 + `patchTruncatedFitHeader` 截断 FIT 头修复：改写声明为可用长度/声明自洽返回 null/非法头与超短输入安全返回 null/12 与 14 字节头换算）。
- `test/skills.test.mjs`：src/skills.js 技能文档加载——临时目录 + `FIT_SKILLS_DIR` 隔离（loadSkills 每次调用实时读环境变量，无需 import 前设置），覆盖排序/`_` 前缀与非 .md 跳过/标题提取与文件名兜底/目录不存在/拼装格式/实时生效/内置五技能冒烟/**`.en.md` 按语言加载与 Knowledge Base 段**。
- `test/ai.test.mjs`：src/ai.js HTTP 层回归——本地 mock chat/completions 服务，验证慢响应不被隐藏超时掐断、总超时报错、SSE 流式拼接、HTTP 错误状态透出。
- `test/e2e.test.mjs`：端到端回归——合成 FIT → `analyzeFile` → 校验 CSV 行数与 summary 指标（anomalies 结构化断言 + formatAnomaly 中/英渲染口径 + 暂停识别/时长与 TSS 剔除暂停/码表自报爬升优先；**截断文件兜底**：头声明未改写的截断文件仍解析出部分记录且指标管线跑通、头合法但数据为垃圾时抛错）；训练库通过 `FIT_DB_PATH` 指向临时目录与真实库隔离（**必须在 import index.js 之前设置该环境变量**，src/db.js 在模块加载时定路径）。
- `test/web.test.mjs`：Web 服务端到端——合成 FIT → `POST /api/upload` → 校验概览/详情/时序/AI 提示词接口（含专业知识库段注入断言）与路径穿越防护；同时直接调用 `saveAiReport` / `listAiReports` / `getAiReport` 验证 AI 缓存表 30 条滚动限制；FTP 接口用 `upsertActivity` 注入合成骑行校验 `/api/ftp-estimate`，并校验 `/api/ftp-apply` 与 `GET/POST /api/athlete`（写训练库 settings 表、部分更新、非法值 400）；训练备注（`/api/activity/note` 保存/合并进 summary/进入复盘提示词/清除与长度校验）与用户背景目标（`/api/profile` 部分更新、清空、进入复盘与规划提示词）亦有端到端覆盖；**语言机制**（`GET/POST /api/lang` 存取与非法值 400、库中 lang=en 时提示词/技能/错误消息整体英文、请求体 lang 覆盖库值、记忆段与工具指引段按语言输出、详情接口按 X-Lang 头本地化 form_note）；AI 对话（`POST/GET/DELETE /api/ai/chat(s)`：202 异步状态机轮询、系统段与历史消息口径、report_id 找回追问对话、级联删除、每 mode 50 个滚动清理、旧 follow-up 接口 404）与 AI 记忆（saveMemory 校验/取代链/100 条滚动清理、mock AI 触发 save_memory 入库带 source、memories 接口与删除 404、报告提示词含记忆段）与 simulate_form 负荷推演（mock AI 首轮 tool_calls、projection/end_form/risk_flags 回填、工具定义随请求下发、回答落库）以 mock AI 服务端到端覆盖；同样用 `FIT_DB_PATH` / `FIT_OUTPUT_DIR` / `FIT_INPUT_DIR` 指向临时目录隔离（须在 import server.js 前设置），收尾先 `closeDb()` 释放 SQLite 句柄再删临时目录（Windows 文件锁）。

**v2/v3 新增回归**（2026-10-20，当前 `npm test` 216 项）：`test/dedupe.test.mjs`（户外/室内判重、指纹、`decideImport` 五分支、重复分组）、`test/dossier.test.mjs`（90 天锚/功率标记排除/周负荷/心率结构）、`test/memory.test.mjs`（14 天/5 次失效边界）、`test/migrations.test.mjs`（v1/v2→v3 数据保留、uuid/指纹/引用映射、FK 删除置 NULL、消息级联、失败回滚、新库/丢戳）、`test/records-layout.test.mjs`（共享基名复制/删除/幂等/室内指纹回填/空目录不盖戳）、`test/backup-manifest.test.mjs`（清单校验与版本闸门）、`test/reanalyze-scale.test.mjs`（powerScale 线性/平方/换系数/撤销/非法值/传入 athlete 的间歇阈值）、`test/prompts-v2.test.mjs`（档案段/策略段/短期标注/新工具清单）、`test/unit.test.mjs` 新增 FTP 区间自选/校准判据/flagged 剔除/chosenW；`test/web.test.mjs` 新增功率标记、档案、删除→重导入重挂、同名不同趟插入、异名同趟跳过、重复合并+无关训练拒合并、旧深链、记忆 scope/strategy 端到端；`test/export.test.mjs` 断言 v3 迁移、uuid records 命名与 FIT_DB_PATH/FIT_OUTPUT_DIR 默认路径。

修改指标算法后：① 跑 `npm test`；② 用 `input/` 下的真实 FIT 文件重跑批量分析做端到端验证；涉及训练库的改动还需验证 `--monthly` / `--trend` 与删库自动重建（`rm -rf db` 后重跑分析）。

## 已知注意事项

- **v3 迁移与数据边界（2026-10-20）**：存量库首次开库会做 v2→v3 表重建（单事务；迁移前保留 `fitness.db.pre-v3.bak`）；v2→v3 失败回滚、数据不丢；v1→v2 的两条加列在重建前执行，若随后重建失败会保留新增列（数据无损、可重入续迁，恢复备份即可回到原样）。records 旧基名在布局迁移中**复制**到各 uuid 后再删旧文件（共享基名不能 rename）。v3 之前已存在的孤儿报告没有 fingerprint，无法自动重挂。户外指纹不含起骑时刻，同日同时长同距离的两趟不同骑行理论上可能被误判为同趟（与既有判据同源）；指纹不含 sport（同日同时长同距离的骑行/跑步也会命中，属共享口径的已知边界，主仓后续若收紧需两仓同步）。标记功率不可信的骑行 TSS 仍留在 `activities.tss`/CTL（档案层已剔除，彻底剔除牵动黄金口径未动）。旧仓无 SQLCipher，不能导入新 App 的加密 `.fitbackup`；导出方向为 v3。
- **旧版《FIT训练分析项目README.md》已删除**（P0–P4 路线图全部落地后，仍有价值的输出格式与算法口径并入本文档「输出格式与指标算法口径」一节；面向用户的使用说明以根目录 `README.md` 为准——中文版首段附英文文档链接，英文版为 `README.en.md`，Docker 部署见 `DEPLOY.md`）。路线图完成情况：P0（批量处理、FTP 自动估算、间歇识别、爬坡段提取、踏频-功率联合分析）、P1（SQLite 训练库、CTL/ATL/TSB 写入 `athlete_context`、月汇总 `--monthly`、趋势图 `--trend`；因训练频率低，路线图的“周汇总”落地为月汇总）、P2（提示词模板库 `src/prompts.js` + 四个提示词命令 `--review`/`--plan`/`--taper`/`--compare`）、P3（跑步/游泳适配、开发者字段统计、损坏文件缺失计数、合成 FIT 生成器 + node:test 回归测试）、P4（AI API 对接 + Web 界面）均已完成；TrainingPeaks/intervals.icu 对接未做。agentic 演进（`agentic-plan.md`：AI 顾问 agentic 查询 / 对话持久化与直接对话 / AI 记忆）四个阶段已全部完成并验证。
- **海拔单位隐藏 bug 已修复**（P3 过程中发现）：解析器按 `lengthUnit: "km"` 会把海拔/爬升缩放成 km，此前海拔输出与爬坡检测被压低 1000 倍（MAGENE 海拔恒 0 故从未暴露），现已统一换回米。
- 没有 CI、没有部署流程——这是一个纯本地脚本项目（git 仅用于本地版本控制）。
- 项目源码统一使用 ESM（`.js` + `"type": "module"`）；`fit-file-parser` 自 3.x 起本身就是 ESM 包（`"type": "module"`，同时提供 `import`/`require` 双入口与 TS 声明），源码里的 `import FitParser from "fit-file-parser"` 是原生 ESM 默认导入，**不再经过 CJS-ESM 互操作**（该包早期版本才是 CommonJS）。
- FIT 解析已开启 `force: true`：校验失败与可恢复的字段错误尽力容忍；被跳过的记录通过 `data_quality`（无时间戳丢弃数、时间跨度内缺失秒数——不含计时暂停、暂停秒数单列）与 `anomalies`（≥10s 整段空缺标注：计时暂停 `timer_pause` / 数据缺失 `record_gap`，阈值见 src/settings.js `DATA_QUALITY`）体现。
- **fit-file-parser 5.x 升级适配（v1.9.6）**：升级到 `^5.2.1` 后实测原有三份真实 FIT 的 `records`/`sessions`/`events`/`laps`/`lengths` **逐字段完全一致**（海拔/距离仍按 `lengthUnit` 缩放为 km，`index.js` 的 `*10000` / `*1000` 换算口径不变；`product_name`、`sport` 枚举、开发者字段统计均无变化），唯一影响本项目的破坏性变更是**结构校验变严**：头 `data_size` 超过实际字节数时直接报错 `File data exceeds input length`（v3 会静默按 EOF 截断），未传完/损坏的文件会从「出部分结果 + 缺失计数」退化为整个解析失败。为此 `index.js` 新增纯函数 `patchTruncatedFitHeader()`——把 FIT 头 offset 4..8 的 `data_size`（uint32 LE）改写为实际可用字节数后重试（只改头声明、不动数据，恢复出的记录数与 v3 截断口径一致）；`analyzeFile()` 捕获首次解析错误后按需重试，修复后仍失败则抛原始错误。另需注意 v5 的两个可选行为：**`elapsed_time` / `timer_time` 默认不再出现在 record 上**（需显式 `elapsedRecordField: true`；本项目未使用这两个字段，且它们已在 `STANDARD_RECORD_FIELDS` 排除表内，故无影响），掩码字段变为 `{ value, ...flags }` 对象（不再带 `"0"` 键，本项目只收集数值型开发者字段，无影响）。回归覆盖见 `test/unit.test.mjs`（`patchTruncatedFitHeader` 四例）与 `test/e2e.test.mjs`（截断文件出部分结果 / 修复后仍失败抛原始错误）。
- FIT 解析**并非用于暂停识别**：`fit-file-parser` 3.x 与 5.x 对同一文件的 `records` 与 `events` 输出完全一致，码表暂停（`timer_pause`）的判定完全由本项目的 `detectPauseSpans()` 三级判据负责；实测 MAGENE C506SE 不写 timer 事件，暂停靠「距离冻结 + 恢复侧静止」命中，其分级结果与设备自报的 `total_elapsed_time − total_timer_time`（2026-09-04：678s vs 本项目 648s 暂停 + 28s 缺失 = 676s）吻合到秒级。
- 已支持骑行/跑步/游泳三类：骑行指标最全；跑步为配速/步频/心率体系（无功率段）；游泳为 length 消息统计（趟数/泳池长度/划水/SWOLF）+ 心率。更细的运动类型适配（如公开水域游泳、铁人三项拼接）未做。

## 安全考虑

- 仅读取本地文件；唯一的网络访问是 AI 报告/对话调用用户自配的 OpenAI 兼容接口（agentic 工具全部本地执行，无新增外发通道）；FIT 文件视为不可信输入，解析器以 `force: true` 容错运行。
- AI 密钥存本地训练库 settings 表（`db/` 已被 `.gitignore` 排除），仅随 AI 请求发往用户配置的接口地址；无其它密钥或环境变量配置（`FIT_DB_PATH` / `FIT_INPUT_DIR` / `FIT_OUTPUT_DIR` / `PORT` 仅为部署/测试隔离参数；`TZ` 为部署时区——数据一律 UTC 存储，AI 呈现时间按服务器本地时区换算，Docker 镜像默认 `Asia/Shanghai`，容器默认 UTC 会使训练时段整体偏移 8 小时，见 DEPLOY.md 8.5 与 server.js 启动日志的时区提示）。
