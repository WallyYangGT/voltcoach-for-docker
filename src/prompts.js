/**
 * prompts.js
 * AI 分析提示词模板库（P2）：把「角色 + 指标口径 + 训练数据 + 固化问题」
 * 拼成完整 Markdown，打印到终端供一键复制给任意 AI（API 对接属 P4）。
 *
 * 双语（zh 默认 / en）：所有 builder 接受可选 lang 末参，静态文本按语言切换
 * （回归测试断言依赖；2026-09-25 客观性修正起 zh 文案与安卓版 VoltCoach 逐字
 * 同步、不再与更早历史版本逐字一致）；动态数据（JSON/数值/
 * profile/备注/记忆原文）为语言中立，原样透传——用户自填内容不翻译。
 *
 * 指标口径说明由 settings.js 动态生成，改骑手参数/分区后提示词自动同步。
 * 本模块除「当前时间」段取 now 参数外均为纯函数、无状态、无 IO；
 * 各场景 builder 的 now 缺省为当前时刻（本地时区），可注入固定值便于测试。
 */

import dayjs from "dayjs";
import "dayjs/locale/zh-cn.js";

import { ATHLETE, POWER_ZONES, HR_ZONES } from "./settings.js";
import { PEAK_WINDOWS } from "./dossier.js";

// ---------------- 双语静态文本 ----------------

const TEXT = {
  zh: {
    role: `## 角色

你是一位严谨、务实的自行车教练，熟悉 Coggan 功率训练体系与 TrainingPeaks 负荷模型。请基于数据给出具体、可执行的建议，避免泛泛而谈；评价客观平衡——做得好的地方（有数据支撑）明确肯定，存在的问题也直接指出，不回避不美化；数据缺失或可信度不足时明确指出，不要编造。`,

    "glossary.head": `## 指标口径与骑手参数`,
    "glossary.rider": `骑手参数：FTP {ftp}W，最大心率 {hr}bpm，体重 {kg}kg。`,
    "glossary.intro": `指标定义（口径与 Coggan / TrainingPeaks 一致）：`,
    "glossary.np": `- NP（标准化功率）：30 秒滚动平均的四次方均根，反映"生理代价等效功率"`,
    "glossary.if": `- IF（强度因子）= NP / FTP；TSS = 时长秒 × NP × IF / (FTP × 3600) × 100`,
    "glossary.vi": `- VI（变异指数）= NP / 平均功率，越接近 1 输出越平稳`,
    "glossary.drift": `- 心率漂移（有氧解耦）：前后半程 效率因子(功率/心率，跑步无功率计时为 速度/心率) 的相对变化，<5% 为有氧基础扎实的标志`,
    "glossary.ctl": `- CTL（体能）= TSS 的 42 天指数加权；ATL（疲劳）= 7 天指数加权；TSB（状态）= CTL − ATL，正值=新鲜`,
    "glossary.dist": `- 强度分布类型：polarized=极化（大量低强度+高强度多于中强度）、pyramidal=金字塔（低>中>高）、sweet_spot=甜区取向`,
    "glossary.power_zones": `功率分区（Coggan 7 区，%FTP）：`,
    "glossary.power_zone_line": `  - {name}: {min}–{max} FTP`,
    "glossary.hr_zones": `心率分区（%最大心率）：`,
    "glossary.hr_zone_line": `  - {name}: {min}–{max} 最大心率`,
    "glossary.data_note.head": `数据口径注意：`,
    "glossary.data_note.0": `- 功率分区按秒级功率值统计：0W（滑行、下坡、停车但计时未停）也计入 Z1，Z1 占比高不等于没有踩踏输出；pedal_time 字段给出踩踏/滑行/静止三分解（秒数），可据此量化解释 Z1 占比偏高，anomalies 中 stationary 条目为计时未停的静止段；`,
    "glossary.data_note.1": `- duration_sec 已剔除计时暂停；anomalies 中 timer_pause 条目的 at 为暂停起始时刻，可据此定位暂停发生的环节；`,
    "glossary.data_note.2": `- segments 中 lap 分段的 duration_sec 为含暂停的经过时间，与整体时长口径不同。`,

    "sec.now": `## 当前时间`,
    "sec.now.line": `今天是 {date}（{weekday}），当前时刻 {time}（UTC{offset}）。`,
    "sec.now.utc_note": `训练数据中的日期时间已按本地时区（UTC{offset}）标注，请直接按本地时间解读（如 19:51 即傍晚），不要再做时区换算；仅纯日期字段（activity.date 与训练库日期）为 UTC 口径，清晨训练可能显示为前一天。涉及「今天/本周/下周」等表述时，以本段日期为准。`,

    "agentic.head": `## 数据查询与计算工具`,
    "agentic.rules_head": `使用规则：`,
    "agentic.intro": `你可以通过工具调用主动查询本应用训练库中的数据、做负荷推演与课表计算，不必只依赖上方预装的数据。可用工具：`,
    "agentic.tool.list_activities": `- list_activities：训练简明清单（日期/类型/时长/TSS/NP/IF，每行带 activity_id），可按日期范围/运动类型/分类过滤——这是"目录页"`,
    "agentic.tool.get_activity_summary": `- get_activity_summary：按 activity_id 取单次训练完整汇总指标（NP/IF/TSS/分区/峰功率/心率漂移/备注等）`,
    "agentic.tool.get_activity_records": `- get_activity_records：按 activity_id 取逐秒时序（功率/心率/踏频等），可用 start_sec/end_sec 只取时间窗片段`,
    "agentic.tool.get_form_series": `- get_form_series：最近 N 天逐日 CTL/ATL/TSB（疲劳与状态走势）`,
    "agentic.tool.get_monthly_summary": `- get_monthly_summary：逐月训练汇总（长期负荷趋势）`,
    "agentic.tool.get_athlete_profile": `- get_athlete_profile：骑手参数（FTP/最大心率/体重）与用户身份、训练目标`,
    "agentic.tool.estimate_ftp": `- estimate_ftp：基于历史骑行估算 FTP（含置信度）`,
    "agentic.tool.simulate_form": `- simulate_form：未来负荷推演——给出逐日计划 TSS，预测 CTL/ATL/TSB 走势与风险（"每周加练会怎样"、赛前减量评估）`,
    "agentic.tool.generate_workout": `- generate_workout：按目标（recovery/endurance/sweet_spot/threshold/vo2max）与可用时长生成单次课表（功率瓦特区间/组数/TSS 估算）`,
    "agentic.tool.update_ftp": `- update_ftp：按当前最佳科学估算更新用户 FTP 配置（可选 ftp_watts 在估算区间内自选，夹逼后写入；内部校验数据量/两法一致性/全力锚点/新鲜度，不满足返回拒绝原因）`,
    "agentic.tool.reanalyze_activity": `- reanalyze_activity：按当前骑手参数重新分析一次训练并写回（重算 IF/TSS/区间/间歇等，返回新旧对比）——FTP 更新后对受影响训练使用`,
    "agentic.tool.get_dossier": `- get_dossier：个人训练档案长期基线（峰功率 PB/近 90 天、爬坡与踏频画像、强度结构、8 周负荷、心率漂移）——评估进步/退步、规划或讨论长期技术策略前先取它作对照`,
    "agentic.tool.set_power_flag": `- set_power_flag：标记/取消某次骑行「功率不可信」（功率计未校准/读数明显失真）；被标记骑行从档案功率基线排除，可逆`,
    "agentic.tool.recalibrate_activity_power": `- recalibrate_activity_power：按系数（0.5–1.5）缩放重算单骑全部功率派生指标并写回（系统性校准偏差修正；逐秒原始数据不改写）——拿不准时先 set_power_flag`,
    "agentic.rule.0": `1. 只在上方预装数据不足以回答时才调用工具；能直接回答就不要调用。`,
    "agentic.rule.1": `2. 深挖单次训练时先 list_activities 找到 activity_id，再用 get_activity_summary / get_activity_records 按 id 取数。`,
    "agentic.rule.2": `3. 每轮只发起回答所必需的调用，不要批量试探。`,
    "agentic.rule.3": `4. 需要先调用工具时，中间轮只写简短过渡语；完整结论/报告正文留到不再调用工具的最后一轮一次性输出。`,
    "agentic.rule.4": `5. FTP 自动更新（update_ftp）：复盘或对话中发现功率-心率区间系统性错位、峰功率与当前 FTP 明显不符等数据偏移迹象时，主动跑 estimate_ftp；门槛满足（置信度足够且数据新鲜）即调用 update_ftp，无需等用户开口。更新成功后必须在回答中明确指出「FTP 已由 X 更新为 Y」及数据依据；被拒绝时向用户转述原因与数据收集建议。用户口头给出的 FTP 数值不要用本工具，引导其到 Web 设置页手动设置。`,
    "agentic.rule.5": `6. 重新分析（reanalyze_activity）：FTP 更新后可对受影响的训练（如作为估算依据的锚点骑行、用户关心的最近训练）调用，把分析结果对齐新参数；用户要求重新分析某次训练时同样调用。调用后在回答中说明关键指标的变化（旧→新）与对体能序列的影响。`,
    "agentic.rule.6": `7. 功率可信度：发现功率计未校准/读数明显失真（20min 峰功率无解释突进、功率-心率系统性错位、w/kg 与爬坡表现矛盾）时，先按知识库技能 06 判断；高度可疑先 set_power_flag 标记（可逆），有可信校准依据再 recalibrate_activity_power（系数夹逼 0.5–1.5）。不要凭猜测缩放；被标记骑行的 FTP 估算已自动剔除，不要手工折价。`,

    "chat.followup": `请基于下面的训练分析报告与训练数据回答后续问题。要求：每次回答控制在 200 字以内；调用工具查询数据的过程不计入回答字数；必须引用本次训练中的具体数据细节（如 NP/IF、分区占比、心率漂移、峰功率、备注等）给出针对性指导，避免泛泛而谈；不要分点罗列。`,
    "chat.direct": `## 回答要求

你是用户的随身 AI 训练顾问。回答务实简洁、结合训练库中的具体数据，不限字数；用户没有指明某次训练时，先用数据查询工具了解近期训练与负荷走势再作答，不要凭空猜测。`,

    "mem.head": `## 用户记忆`,
    "mem.rules_head": `规则：`,
    "mem.cat.general": `通用`,
    "mem.cat.injury": `伤病`,
    "mem.cat.schedule": `日程`,
    "mem.cat.goal": `目标`,
    "mem.cat.preference": `偏好`,
    "mem.cat.strategy": `策略`,
    "mem.tag.short": `短期`,
    "mem.list_intro": `以下是你在此前交互中记录的用户相关事实（按日期排列）：`,
    "mem.empty": `（暂无记忆——这是你第一次积累对用户的了解，请从本次交互开始主动记录。）`,
    "mem.rule.0": `1. 同一主题的记忆相互矛盾时，以日期最新者为准；旧记忆仅作变化轨迹参考，不得忽略其存在。`,
    "mem.rule.1": `2. 主动记录，宁多勿漏：只要用户透露训练数据之外的个人事实或倾向，就立即调用 save_memory 记下，不必等用户明确要求。包括：目标与赛事计划、伤病与身体不适、日程/时间约束、训练偏好（室内/户外、时段、课表类型）、器材、对建议的反馈与纠正、自述的主观状态。训练数据本身已有的事实不要重复记。`,
    "mem.rule.2": `3. 每次回答或报告收尾时回顾一遍本次对话：若有符合第 2 条而尚未记录的信息，补记一条 save_memory（工具调用不影响回答内容）。`,
    "mem.rule.3": `4. 每条记忆 ≤500 字、用中文、写成带主语的完整陈述；同主题更新时用 supersedes_id 取代旧记忆（id 见上方 #标注）。`,
    "mem.rule.4": `5. 记录时区分时效与类别：仅在本次或近两三周有意义的临时上下文（如出差、临时换器材）用 scope='short'——短期记忆超过两周或 5 次训练后自动失效；长期有效的事实不传 scope（默认长期）；与用户商定的训练策略用 category='strategy'（该类记忆会单独进入「训练策略（既定结论）」权威段）。`,
    "strat.head": `## 训练策略（既定结论）`,
    "strat.rules": `以上是用户与教练此前讨论确认的训练策略，是分析与建议的既定前提：涉及相关主题时必须以其为出发点；若本次数据或你的专业判断与既定策略冲突，必须显式指出「这与既定策略不同」并给出数据依据，由用户决定是否修订；确需修订时用 save_memory（category='strategy'，supersedes_id 指向旧策略 id）取代，不得默默按相反的假设分析或给建议。`,

    "dossier.head": `## 个人训练档案（本地自动汇总的长期基线）`,
    "dossier.baseline": `数据基线：截至 {date}，近 90 天 {considered} 次骑行（{with_power} 次带功率）。以下是与本次训练/规划对照的参考基准：`,
    "dossier.peak": `- 峰功率（W）历史最佳：{v}`,
    "dossier.peak.recent": `- 峰功率（W）近 90 天最佳：{v}`,
    "dossier.climb": `- 爬坡画像（{n} 段中位）：坡度 {g}%、强度 {p}%FTP、心率 {h} bpm`,
    "dossier.cadence": `- 踏频风格（{m} 次骑行占比）：低踏频 {low}%、正常 {normal}%、高踏频 {high}%`,
    "dossier.zones": `- 90 天强度结构（按时长加权）：Z1–Z2 {low}%、Z3–Z4 {mid}%、Z5–Z7 {high}%`,
    "dossier.zones.hr": `- 90 天心率强度结构（功率不可用骑行，按时长加权）：Z1–Z2 {low}%、Z3–Z4 {mid}%、Z5 {high}%（心率五区，单锚点分析用）`,
    "dossier.types": `- 月度强度类型：{v}`,
    "dossier.load": `- 近 8 周负荷：周均 TSS {avg}（峰值 {peak}），周均骑行 {hours} 小时`,
    "dossier.drift": `- 心率漂移中位 {v}%（{n} 次样本，有氧耐力参考）`,
    "dossier.flagged": `- 功率可信度：{n} 次骑行被标记功率不可信，已从上述功率基线排除；涉及峰功率/强度的纵向对比时请注明该口径`,

    "profile.head": `## 用户背景与训练目标`,
    "profile.identity": `身份：{v}`,
    "profile.goal": `训练目标：{v}`,
    "profile.tail": `请结合上述身份与目标评估训练安排的可行性与侧重点（如时间预算、目标赛事/能力提升方向）。`,

    "answer.head": `## 请回答`,
    "seg.omitted": `...（中间省略 {n} 段）`,

    "cat.training": `训练`,
    "cat.race": `比赛`,
    "cat.recovery": `恢复`,
    "cat.leisure": `休闲`,

    "sec.review": `## 训练数据（单次骑行汇总）

用户已将本次记录分类为：**{cat}**。请基于该分类进行解读；如果是比赛，请按比赛而非日常训练来评估强度与恢复建议。`,
    "sec.review.note": `用户还为本次训练填写了备注（见 activity.note 字段，内容为体感/路况等主观信息），请结合备注与客观数据互相印证（例如体感差是否对应心率漂移偏大、路况是否解释了功率波动）。`,
    "review.q.0": `参考用户标记的分类，判断本次记录的训练/比赛属性，并说明依据。`,
    "review.q.note": `结合用户备注（activity.note）解读本次训练：主观感受与客观数据是否一致？有何线索？`,
    "review.q.1": `评估功率与心率的强度分布是否合理：基线结合用户标记的分类与场景判断（如通勤/热身/恢复骑以 Z1–Z2 为主属正常），各区时间占比是否符合预期？`,
    "review.q.2": `评估心率漂移（有氧解耦）：数值说明什么？对有氧基础训练有何指示？`,
    "review.q.3": `如有间歇组（interval_set）或爬坡段（climbs）：完成质量如何（功率达成度、衰减情况）？`,
    "review.q.4": `结合 athlete_context 中的 CTL/ATL/TSB，评价这次训练在当前训练周期中的位置与必要性。`,
    "review.q.5": `如 anomalies / data_quality 有异常标注：先按 timer_pause 的 at 时间戳对照时间线定位暂停发生的环节（如热身、通勤、间歇之间、放松），再说明可能原因及对数据可信度与相关段落解读的影响；红绿灯、会合等造成的暂停是真实骑行的正常现象，不要解读为对应环节「没有出力」，也不要凭推测把暂停安放到某个发力段；无法确定位置时如实说明。`,
    "review.q.6": `给出 2-3 条下次同类训练的改进建议。`,

    "sec.plan.monthly": `## 逐月训练汇总`,
    "sec.plan.form": `## 近期 CTL/ATL/TSB 走势（逐周取样，每天 0 点值）`,
    "sec.plan.recent": `## 近期训练清单`,
    "plan.q.0": `评价最近的 CTL 走势：体能是在增长、停滞还是下滑？增速是否安全（一般认为每周 CTL 增幅不宜超过 5-7 点）？`,
    "plan.q.1": `当前 TSB 与疲劳状态如何？近期是否需要安排减量恢复？`,
    "plan.q.2": `从月汇总的强度分布类型（polarized / pyramidal / sweet_spot）看，目前的强度结构是否合理？`,
    "plan.q.3": `下一周应安排什么强度结构？请给出逐日训练建议（类型、时长、目标功率区间或 %FTP）。`,
    "plan.q.4": `中期（4-8 周）应侧重什么能力短板？依据峰功率曲线或间歇数据说明。`,

    "sec.taper.race": `## 比赛信息`,
    "sec.taper.race_line": `比赛日期：{date}（距今 {days} 天）`,
    "sec.taper.form": `## 当前状态（今日 CTL/ATL/TSB）`,
    "sec.taper.trend": `## 近期 CTL/ATL/TSB 走势（逐周取样）`,
    "sec.taper.recent": `## 近期训练清单`,
    "taper.q.0": `以比赛日 TSB 达到 +5 ~ +15（新鲜但不掉体能）为目标，当前 TSB 与目标差距多大？`,
    "taper.q.1": `给出从今天到比赛日的逐日减量计划：每天训练类型、时长、强度（%FTP），说明减量幅度与依据。`,
    "taper.q.2": `减量期间应保留多少高强度（强度保留 vs 纯休息）以避免体能流失？`,
    "taper.q.3": `赛前最后 48 小时的具体安排建议（含预热/ opener 训练）。`,
    "taper.q.4": `指出当前数据中的风险点（如疲劳过深、CTL 太低、近期训练结构问题）。`,

    "sec.compare.a": `## 训练 A（{date}）`,
    "sec.compare.b": `## 训练 B（{date}）`,
    "compare.q.0": `先判断两次训练是否属于同类训练（可比性如何），若类型不同请指出对比的局限。`,
    "compare.q.1": `时长归一化比较核心指标：IF、VI、心率漂移、功体比，哪次完成质量更高？`,
    "compare.q.2": `比较峰功率曲线（5s/1min/5min/20min）与分区时间分布，能力结构上有何变化？`,
    "compare.q.3": `比较踏频-功率习惯（cadence_power）与间歇/爬坡数据（如有）。`,
    "compare.q.4": `综合判断：从 A 到 B 是进步、退步还是持平？给出证据。`,
    "compare.q.5": `基于对比结果，给出下一阶段的训练重点建议。`,
  },

  en: {
    role: `## Role

You are a rigorous, pragmatic cycling coach, well-versed in the Coggan power training system and the TrainingPeaks load model. Base your advice on the data — be specific and actionable, avoid generic platitudes. Be objective and balanced: explicitly acknowledge what the data shows was done well, and point out problems just as directly — do not dodge or sugar-coat. When data is missing or unreliable, say so explicitly; never make things up.`,

    "glossary.head": `## Metrics & Athlete Parameters`,
    "glossary.rider": `Athlete parameters: FTP {ftp} W, max HR {hr} bpm, weight {kg} kg.`,
    "glossary.intro": `Metric definitions (Coggan / TrainingPeaks conventions):`,
    "glossary.np": `- NP (Normalized Power): fourth-root mean of 30-second rolling averages, reflecting the "physiological cost equivalent power"`,
    "glossary.if": `- IF (Intensity Factor) = NP / FTP; TSS = duration_sec × NP × IF / (FTP × 3600) × 100`,
    "glossary.vi": `- VI (Variability Index) = NP / average power; closer to 1 means steadier output`,
    "glossary.drift": `- HR drift (aerobic decoupling): relative change of the efficiency factor (power/HR; speed/HR when no power, e.g. running) between the first and second half; <5% marks a solid aerobic base`,
    "glossary.ctl": `- CTL (fitness) = 42-day exponentially weighted TSS; ATL (fatigue) = 7-day weighted TSS; TSB (form) = CTL − ATL, positive = fresh`,
    "glossary.dist": `- Intensity distribution types: polarized (lots of low intensity, high > mid), pyramidal (low > mid > high), sweet_spot oriented`,
    "glossary.power_zones": `Power zones (Coggan 7, %FTP):`,
    "glossary.power_zone_line": `  - {name}: {min}–{max} FTP`,
    "glossary.hr_zones": `Heart rate zones (%HRmax):`,
    "glossary.hr_zone_line": `  - {name}: {min}–{max} HRmax`,
    "glossary.data_note.head": `Data conventions to note:`,
    "glossary.data_note.0": `- Power zones are computed from per-second power values: 0 W seconds (coasting, descending, stationary with the timer still running) also count toward Z1 — a high Z1 share does not mean the rider was not pedaling; the pedal_time field breaks the time down into pedaling/coasting/stationary seconds so a high Z1 share can be quantified, and stationary entries in anomalies are stationary spans with the timer running;`,
    "glossary.data_note.1": `- duration_sec excludes timer pauses; the at field of timer_pause entries in anomalies is the pause start time, which locates where each pause happened;`,
    "glossary.data_note.2": `- duration_sec of lap segments in segments is elapsed time including pauses, which differs from the overall duration convention.`,

    "sec.now": `## Current Date & Time`,
    "sec.now.line": `Today is {weekday}, {date}; local time {time} (UTC{offset}).`,
    "sec.now.utc_note": `Date-times in the training data are already labelled in local time (UTC{offset}) — read them as local wall-clock (e.g. 19:51 is evening) and do not shift them again. Only plain date fields (activity.date and training-library dates) stay UTC-based, so early-morning sessions may show the previous day. Treat the date above as the baseline for "today / this week / next week".`,

    "agentic.head": `## Data Query & Computation Tools`,
    "agentic.rules_head": `Rules:`,
    "agentic.intro": `You may proactively query this app's training library, run load simulations, and build workouts through tool calls — you are not limited to the preloaded data above. Available tools:`,
    "agentic.tool.list_activities": `- list_activities: brief activity list (date/type/duration/TSS/NP/IF, each row carries activity_id) with date range / sport / category filters — the "catalog page"`,
    "agentic.tool.get_activity_summary": `- get_activity_summary: full summary metrics for one activity by activity_id (NP/IF/TSS/zones/peak power/HR drift/notes etc.)`,
    "agentic.tool.get_activity_records": `- get_activity_records: per-second time series (power/HR/cadence etc.) by activity_id, with start_sec/end_sec to fetch only a time window`,
    "agentic.tool.get_form_series": `- get_form_series: daily CTL/ATL/TSB for the last N days (fatigue and form trend)`,
    "agentic.tool.get_monthly_summary": `- get_monthly_summary: monthly training summary (long-term load trend)`,
    "agentic.tool.get_athlete_profile": `- get_athlete_profile: athlete parameters (FTP/max HR/weight) plus user identity and training goals`,
    "agentic.tool.estimate_ftp": `- estimate_ftp: estimate FTP from ride history (with confidence)`,
    "agentic.tool.simulate_form": `- simulate_form: future load simulation — give a daily plan TSS to predict the CTL/ATL/TSB trend and risks ("what if I add X weekly", taper evaluation)`,
    "agentic.tool.generate_workout": `- generate_workout: build a single workout by target (recovery/endurance/sweet_spot/threshold/vo2max) and available time (power watt ranges/sets/TSS estimate)`,
    "agentic.tool.update_ftp": `- update_ftp: update the user's FTP config from the current best scientific estimate (optional ftp_watts chosen within the estimate range, clamped before writing; validates data volume/method consistency/all-out anchor/freshness internally, returns the refusal reason when unmet)`,
    "agentic.tool.reanalyze_activity": `- reanalyze_activity: re-analyze one activity with the current athlete parameters and write it back (recomputes IF/TSS/zones/intervals etc., returns an old-vs-new diff) — use for affected rides after an FTP update`,
    "agentic.tool.get_dossier": `- get_dossier: athlete dossier long-term baseline (all-time/90-day peak power, climb and cadence profile, intensity structure, 8-week load, HR drift) — consult before judging progress, planning, or discussing long-term technique strategy`,
    "agentic.tool.set_power_flag": `- set_power_flag: flag/unflag a ride as power-untrusted (uncalibrated meter or clearly distorted readings); flagged rides are excluded from dossier power baselines and this is reversible`,
    "agentic.tool.recalibrate_activity_power": `- recalibrate_activity_power: rescale (0.5–1.5) and recompute all power-derived metrics of one ride and write back (systematic calibration offset; raw per-second data unchanged) — when unsure, set_power_flag first`,
    "agentic.rule.0": `1. Only call a tool when the preloaded data above is insufficient; answer directly whenever possible.`,
    "agentic.rule.1": `2. To dig into a single workout, first list_activities to find the activity_id, then get_activity_summary / get_activity_records by id.`,
    "agentic.rule.2": `3. Per round, make only the calls needed to answer — no batch probing.`,
    "agentic.rule.3": `4. When tools are needed first, keep intermediate rounds to a short transition; write the full conclusion/report only in the final round, which makes no tool calls.`,
    "agentic.rule.4": `5. FTP auto-update (update_ftp): when a review or chat reveals systematic power-HR zone mismatch, peak power clearly inconsistent with the current FTP, or similar drift signals, proactively run estimate_ftp; when the gate passes (confidence sufficient and data fresh) call update_ftp without waiting for the user to ask. After a successful update the reply must state explicitly that "FTP has been updated from X to Y" with the data basis; when refused, relay the reason and data-collection advice. Never use this tool for FTP values the user states verbally — guide them to the Web settings page instead.`,
    "agentic.rule.5": `6. Re-analysis (reanalyze_activity): after an FTP update, call it for affected rides (e.g. the anchor ride used for estimation, recent rides the user cares about) to align their analysis with the new parameters; also call it when the user asks to re-analyze a ride. In the reply, explain the key metric changes (old vs new) and the impact on the fitness series.`,
    "agentic.rule.6": `7. Power credibility: when the meter is uncalibrated or readings are clearly distorted (unexplained 20-min peak jump, systematic power-HR mismatch, w/kg contradicting climbing), judge per skill 06; when highly suspect call set_power_flag first (reversible), and only recalibrate_activity_power with a credible basis (factor clamped 0.5–1.5). Never rescale on a guess; flagged rides are already excluded from FTP estimation — do not discount estimates manually.`,

    "chat.followup": `Answer follow-up questions based on the training analysis report and the training data below. Requirements: keep each answer within 200 characters; tool queries for data do not count toward the limit; cite concrete details from this workout (e.g. NP/IF, zone shares, HR drift, peak power, notes) for targeted guidance — avoid generic advice; do not use bullet lists.`,
    "chat.direct": `## Answer Requirements

You are the user's personal AI training advisor. Answer pragmatically and concisely, grounded in concrete data from the training library, with no length limit; when the user does not name a specific workout, first use the data-query tools to review recent training and load trends before answering — never guess blindly.`,

    "mem.head": `## User Memory`,
    "mem.rules_head": `Rules:`,
    "mem.cat.general": `General`,
    "mem.cat.injury": `Injury`,
    "mem.cat.schedule": `Schedule`,
    "mem.cat.goal": `Goal`,
    "mem.cat.preference": `Preference`,
    "mem.cat.strategy": `Strategy`,
    "mem.tag.short": `short-term`,
    "mem.list_intro": `Facts about the user recorded in earlier interactions (chronological):`,
    "mem.empty": `(No memories yet — this is your first time building a picture of the user; start recording proactively from this interaction.)`,
    "mem.rule.0": `1. When memories about the same topic conflict, the newest date wins; older memories remain reference points in the change history — do not ignore their existence.`,
    "mem.rule.1": `2. Record proactively — better too many than too few: whenever the user reveals personal facts or preferences beyond training data, call save_memory immediately rather than waiting to be asked. This includes: goals and race plans, injuries or physical issues, schedule/time constraints, training preferences (indoor/outdoor, time of day, workout types), equipment, feedback on and corrections to your advice, self-reported subjective state. Facts already present in the training data need not be re-recorded.`,
    "mem.rule.2": `3. At the end of each answer or report, review this conversation: if anything per rule 2 is not yet recorded, add one save_memory call (tool calls do not affect answer content).`,
    "mem.rule.3": `4. Each memory ≤500 characters, written in the user's current language as a complete statement with a subject; when updating the same topic, supersede the old memory via supersedes_id (ids are the #annotations above).`,
    "mem.rule.4": `5. Distinguish freshness and kind when recording: temporary context meaningful only for this or the next couple of weeks (travel, temporary equipment swap) uses scope='short' — short-term memories auto-expire after two weeks or 5 activities, whichever comes first; long-lived facts take no scope (long by default); training strategies agreed with the user use category='strategy' (rendered separately in the "Training Strategies (Agreed Conclusions)" authoritative block).`,
    "strat.head": `## Training Strategies (Agreed Conclusions)`,
    "strat.rules": `The above are training strategies previously agreed between user and coach — the standing premises for analysis and advice: treat them as the starting point for related topics; if today's data or your professional judgment conflicts with an agreed strategy, you must explicitly flag "this differs from the agreed strategy" with data-backed reasoning and let the user decide on any revision; to revise, supersede via save_memory (category='strategy', supersedes_id pointing at the old strategy id). Never silently analyze or advise against an agreed strategy.`,

    "dossier.head": `## Athlete Dossier (local deterministic long-term baseline)`,
    "dossier.baseline": `Data baseline: as of {date}, {considered} rides in the last 90 days ({with_power} with power). Reference baselines for this session/plan:`,
    "dossier.peak": `- Peak power (W) all-time best: {v}`,
    "dossier.peak.recent": `- Peak power (W) best in last 90 days: {v}`,
    "dossier.climb": `- Climb profile ({n} climbs, medians): grade {g}%, intensity {p}%FTP, HR {h} bpm`,
    "dossier.cadence": `- Cadence style ({m} rides): low {low}%, normal {normal}%, high {high}%`,
    "dossier.zones": `- 90-day intensity structure (duration-weighted): Z1–Z2 {low}%, Z3–Z4 {mid}%, Z5–Z7 {high}%`,
    "dossier.zones.hr": `- 90-day HR intensity structure (power-unusable rides, duration-weighted): Z1–Z2 {low}%, Z3–Z4 {mid}%, Z5 {high}% (5 HR zones, for single-anchor analysis)`,
    "dossier.types": `- Monthly intensity types: {v}`,
    "dossier.load": `- Last 8 weeks: avg TSS {avg} (peak {peak}), avg {hours} h/week`,
    "dossier.drift": `- Median HR drift {v}% ({n} samples, aerobic reference)`,
    "dossier.flagged": `- Power credibility: {n} rides flagged power-untrusted and excluded from the power baselines above; note this when comparing peak power/intensity longitudinally`,

    "profile.head": `## User Background & Training Goals`,
    "profile.identity": `Identity: {v}`,
    "profile.goal": `Training goal: {v}`,
    "profile.tail": `Assess the feasibility and priorities of the training plan in light of the identity and goals above (e.g. time budget, target races, capability direction).`,

    "answer.head": `## Please Answer`,
    "seg.omitted": `...({n} segments omitted in the middle)`,

    "cat.training": `Training`,
    "cat.race": `Race`,
    "cat.recovery": `Recovery`,
    "cat.leisure": `Leisure`,

    "sec.review": `## Training data (single-ride summary)

The user has categorized this record as **{cat}**. Interpret it accordingly; if it is a race, assess intensity and recovery as a race rather than a routine workout.`,
    "sec.review.note": `The user also left a note for this workout (activity.note — subjective info such as feel/conditions); cross-check it against the objective data (e.g. does poor feel match high HR drift, do road conditions explain power swings).`,
    "review.q.0": `Given the category the user assigned, decide whether this record is a workout or a race and justify your judgment.`,
    "review.q.note": `Interpret this workout with the user's note (activity.note): do the subjective feelings match the objective data? Any clues?`,
    "review.q.1": `Assess whether the power and HR intensity distributions are appropriate, judging the baseline against the user-assigned category and context (e.g. a commute/warm-up/recovery ride dominated by Z1–Z2 is normal): are the zone time shares as expected?`,
    "review.q.2": `Evaluate HR drift (aerobic decoupling): what does the number mean, and what does it indicate for aerobic-base training?`,
    "review.q.3": `If there are interval sets (interval_set) or climbs: how was execution quality (power achieved, decay)?`,
    "review.q.4": `Using CTL/ATL/TSB from athlete_context, judge where this workout sits in the current training cycle and whether it was necessary.`,
    "review.q.5": `If anomalies / data_quality flags exist: first locate where each timer_pause happened by matching its at timestamp against the timeline (e.g. warm-up, commuting, between intervals, cool-down), then explain likely causes and the impact on data reliability and on reading the affected segments; pauses at traffic lights or regrouping are normal in real riding — do not read them as "no effort" where they occur, and do not place a pause into a hard segment by guesswork; say so plainly when the location cannot be determined.`,
    "review.q.6": `Give 2-3 improvement suggestions for the next similar workout.`,

    "sec.plan.monthly": `## Monthly Training Summary`,
    "sec.plan.form": `## Recent CTL/ATL/TSB Trend (weekly sampling, 00:00 values)`,
    "sec.plan.recent": `## Recent Activity List`,
    "plan.q.0": `Assess the recent CTL trend: is fitness growing, plateauing, or declining? Is the rate safe (weekly CTL increase should generally stay under 5-7 points)?`,
    "plan.q.1": `What is the current TSB and fatigue state? Is a deload/recovery block needed soon?`,
    "plan.q.2": `Looking at the monthly intensity distribution type (polarized / pyramidal / sweet_spot), is the current intensity structure reasonable?`,
    "plan.q.3": `What intensity structure should next week have? Give day-by-day training suggestions (type, duration, target power zone or %FTP).`,
    "plan.q.4": `Over the medium term (4-8 weeks), which capability gap should be the focus? Justify with the peak power curve or interval data.`,

    "sec.taper.race": `## Race Info`,
    "sec.taper.race_line": `Race date: {date} ({days} days away)`,
    "sec.taper.form": `## Current Status (today's CTL/ATL/TSB)`,
    "sec.taper.trend": `## Recent CTL/ATL/TSB Trend (weekly sampling)`,
    "sec.taper.recent": `## Recent Activity List`,
    "taper.q.0": `The goal is a race-day TSB of +5 to +15 (fresh but fit). How far is current TSB from the target?`,
    "taper.q.1": `Give a day-by-day taper plan from today to race day: type, duration, intensity (%FTP) per day, with the reduction rationale.`,
    "taper.q.2": `How much high-intensity work should be kept during the taper (intensity preservation vs pure rest) to avoid losing fitness?`,
    "taper.q.3": `Concrete suggestions for the final 48 hours before the race (including warm-up / opener).`,
    "taper.q.4": `Point out risk factors in the current data (e.g. deep fatigue, CTL too low, recent training structure issues).`,

    "sec.compare.a": `## Workout A ({date})`,
    "sec.compare.b": `## Workout B ({date})`,
    "compare.q.0": `First decide whether the two workouts are comparable (same type); if not, note the limits of the comparison.`,
    "compare.q.1": `Compare duration-normalized core metrics: IF, VI, HR drift, W/kg — which session was executed better?`,
    "compare.q.2": `Compare the peak power curves (5s/1min/5min/20min) and zone time distributions — what changed in the ability structure?`,
    "compare.q.3": `Compare cadence-power habits (cadence_power) and interval/climb data if present.`,
    "compare.q.4": `Overall: from A to B, is it progress, regression, or unchanged? Give evidence.`,
    "compare.q.5": `Based on the comparison, give training priorities for the next phase.`,
  },
};

const TT = (lang, key, vars) => {
  const tpl = TEXT[lang]?.[key] ?? TEXT.zh[key] ?? key;
  if (!vars) return tpl;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(v == null ? "" : String(v)),
    tpl,
  );
};

// ---------------- 公共片段 ----------------

/** 指标口径与骑手参数说明（数值取自 settings.js，不硬编码） */
export function buildMetricGlossary(lang = "zh") {
  const pct = (x) => (x === Infinity ? "∞" : `${Math.round(x * 100)}%`);
  const powerZones = POWER_ZONES.map((z) =>
    TT(lang, "glossary.power_zone_line", { name: z.name, min: pct(z.min), max: pct(z.max) }),
  ).join("\n");
  const hrZones = HR_ZONES.map((z) =>
    TT(lang, "glossary.hr_zone_line", { name: z.name, min: pct(z.min), max: pct(z.max) }),
  ).join("\n");

  return [
    TT(lang, "glossary.head"),
    "",
    TT(lang, "glossary.rider", { ftp: ATHLETE.ftp_watts, hr: ATHLETE.max_hr, kg: ATHLETE.weight_kg }),
    "",
    TT(lang, "glossary.intro"),
    TT(lang, "glossary.np"),
    TT(lang, "glossary.if"),
    TT(lang, "glossary.vi"),
    TT(lang, "glossary.drift"),
    TT(lang, "glossary.ctl"),
    TT(lang, "glossary.dist"),
    "",
    TT(lang, "glossary.power_zones"),
    powerZones,
    "",
    TT(lang, "glossary.hr_zones"),
    hrZones,
    "",
    TT(lang, "glossary.data_note.head"),
    TT(lang, "glossary.data_note.0"),
    TT(lang, "glossary.data_note.1"),
    TT(lang, "glossary.data_note.2"),
  ].join("\n");
}

export const ROLE = TEXT.zh.role;

/** 英文角色（chat 直接对话系统段按语言选用；四场景模板由 assemble 内部处理） */
export const ROLE_EN = TEXT.en.role;

/**
 * 当前日期时间段：让 AI 知道「今天几号、星期几、几点、什么时区」，
 * 用于周计划节奏、「今天还练不练」、赛前倒计时等时间判断。
 * 日期按服务器本地时区渲染（本地部署即用户时区），星期名经 dayjs locale
 * 随语言切换（zh-cn → 星期四 / en → Thursday）；训练库日期为 UTC 口径，
 * 段内文案已注明差异。now 非法时返回 null（不产生该段）。
 */
export function buildDateSection(now, lang = "zh") {
  if (now == null) return null;
  const d = dayjs(now).locale(lang === "en" ? "en" : "zh-cn");
  if (!d.isValid()) return null;
  const offset = d.format("Z");
  return [
    TT(lang, "sec.now"),
    "",
    TT(lang, "sec.now.line", {
      date: d.format("YYYY-MM-DD"),
      weekday: d.format("dddd"),
      time: d.format("HH:mm"),
      offset,
    }),
    TT(lang, "sec.now.utc_note", { offset }),
  ].join("\n");
}

function jsonBlock(obj) {
  return "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
}

/**
 * Agentic 工具使用指引段（仅服务端 agentic 调用注入；CLI 提示词命令不注入——
 * 复制出去的提示词无法回调本机接口，挂工具指引只会得到幻觉调用）。
 * 工具清单与 src/tools.js 的 TOOL_DEFS 对应。
 */
export function buildAgenticSection(lang = "zh") {
  const tools = [
    "list_activities",
    "get_activity_summary",
    "get_activity_records",
    "get_form_series",
    "get_monthly_summary",
    "get_athlete_profile",
    "estimate_ftp",
    "simulate_form",
    "generate_workout",
    "update_ftp",
    "reanalyze_activity",
    "get_dossier",
    "set_power_flag",
    "recalibrate_activity_power",
  ]
    .map((name) => TT(lang, `agentic.tool.${name}`))
    .join("\n");
  const rules = [0, 1, 2, 3, 4, 5, 6].map((i) => TT(lang, `agentic.rule.${i}`)).join("\n");
  return `${TT(lang, "agentic.head")}

${TT(lang, "agentic.intro")}
${tools}

${TT(lang, "agentic.rules_head")}
${rules}`;
}

/**
 * 对话场景回答指令（server.js 拼装对话系统段用）：
 * - follow_up：报告追问的快问快答口径——≤200 字、结合具体数据、不分点罗列，
 *   工具查询过程不计入回答字数；
 * - chat：直接对话——务实简洁、结合数据，不限字数。
 */
export function buildChatInstruction(mode, lang = "zh") {
  return mode === "follow_up" ? TT(lang, "chat.followup") : TT(lang, "chat.direct");
}

/**
 * 用户记忆段（AI 在交互中记录的用户个人事实，带时间戳）。
 * 始终返回该段（无有效记忆时显示"暂无"），保证 save_memory 主动记录指引
 * 对首次/无记忆用户同样注入；有记忆时逐条标注日期与 #id，
 * 写死冲突处理规则（同主题以日期最新者为准）与主动记录指引。
 * 仅服务端 agentic 调用注入（CLI 提示词命令不注入——复制出去的提示词无法回调本机）。
 * memories 为 listMemories() 返回（id DESC），此处反转为时间正序展示。
 */
export function buildMemorySection(memories, lang = "zh") {
  const catLabel = (c) =>
    TT(lang, `mem.cat.${c}`) || c || TT(lang, "mem.cat.general");
  const all = [...(memories ?? [])].reverse();
  // category='strategy' 单独进「既定结论」权威段并置顶（分析与建议的前提）
  const strategies = all.filter((m) => m.category === "strategy");
  const rest = all.filter((m) => m.category !== "strategy");
  const strategyBlock = strategies.length
    ? `${TT(lang, "strat.head")}\n\n${strategies
        .map((m) => {
          const date = String(m.created_at ?? "").slice(0, 10);
          return `- [${date}] (#${m.id}) ${m.content}`;
        })
        .join("\n")}\n\n${TT(lang, "strat.rules")}`
    : null;
  const lines = rest.map((m) => {
    const date = String(m.created_at ?? "").slice(0, 10);
    const cat = catLabel(m.category);
    const scopeTag = m.scope === "short" ? `, ${TT(lang, "mem.tag.short")}` : "";
    return `- [${date}] (#${m.id}, ${cat}${scopeTag}) ${m.content}`;
  });
  const list = lines.length
    ? `${TT(lang, "mem.list_intro")}\n${lines.join("\n")}`
    : TT(lang, "mem.empty");
  const memBlock = `${TT(lang, "mem.head")}

${list}

${TT(lang, "mem.rules_head")}
${[0, 1, 2, 3, 4].map((i) => TT(lang, `mem.rule.${i}`)).join("\n")}`;
  return [strategyBlock, memBlock].filter(Boolean).join("\n\n");
}

/**
 * 个人训练档案段（src/dossier.js 聚合的长期基线，语言中立数据 → 按语言渲染）。
 * dossier 为 null（无骑行数据）返回 null 整段省略；段内各数据行按有无数据
 * 独立省略（如库中尚无带功率骑行则无峰功率行）。四场景报告与对话/追问均注入。
 */
export function buildDossierSection(dossier, lang = "zh") {
  if (!dossier) return null;
  const lines = [];

  const fmtPeaks = (es) => {
    const byWindow = new Map((es ?? []).map((e) => [e.window, e.value_w]));
    // 四窗口固定输出、缺项用 —（让模型明确知道哪些窗口没有数据，而不是误以为已列全）
    return PEAK_WINDOWS.map((w) => `${w} ${byWindow.get(w) ?? "—"}`).join(" / ");
  };
  if (dossier.peak_power?.all_time?.length) {
    lines.push(TT(lang, "dossier.peak", { v: fmtPeaks(dossier.peak_power.all_time) }));
    if (dossier.peak_power.last_90d?.length)
      lines.push(TT(lang, "dossier.peak.recent", { v: fmtPeaks(dossier.peak_power.last_90d) }));
  }
  const cp = dossier.climb_profile;
  if (cp?.climbs_analyzed > 0) {
    lines.push(
      TT(lang, "dossier.climb", {
        n: cp.climbs_analyzed,
        g: cp.median_grade_pct ?? "—",
        p: cp.median_pct_ftp ?? "—",
        h: cp.median_avg_hr ?? "—",
      }),
    );
  }
  const cad = dossier.cadence_profile;
  if (cad?.rides_analyzed > 0) {
    const total = cad.style_counts.low + cad.style_counts.normal + cad.style_counts.high;
    const pct = (x) => (total ? Math.round((x / total) * 1000) / 10 : 0);
    lines.push(
      TT(lang, "dossier.cadence", {
        m: cad.rides_analyzed,
        low: pct(cad.style_counts.low),
        normal: pct(cad.style_counts.normal),
        high: pct(cad.style_counts.high),
      }),
    );
  }
  const zp = dossier.intensity_structure?.zone_pct;
  if (zp) {
    const r1 = (x) => Math.round(x * 10) / 10;
    lines.push(
      TT(lang, "dossier.zones", {
        low: r1((zp.Z1 ?? 0) + (zp.Z2 ?? 0)),
        mid: r1((zp.Z3 ?? 0) + (zp.Z4 ?? 0)),
        high: r1((zp.Z5 ?? 0) + (zp.Z6 ?? 0) + (zp.Z7 ?? 0)),
      }),
    );
  }
  // 单锚点降级基线：功率不可用骑行的心率分区结构（无功率骑手的主要强度依据）
  const hzp = dossier.intensity_structure?.hr_zone_pct;
  if (hzp) {
    const r1 = (x) => Math.round(x * 10) / 10;
    lines.push(
      TT(lang, "dossier.zones.hr", {
        low: r1((hzp.Z1 ?? 0) + (hzp.Z2 ?? 0)),
        mid: r1((hzp.Z3 ?? 0) + (hzp.Z4 ?? 0)),
        high: r1(hzp.Z5 ?? 0),
      }),
    );
  }
  if (dossier.intensity_structure?.intensity_types?.length) {
    const joiner = lang === "en" ? ", " : "、";
    lines.push(
      TT(lang, "dossier.types", {
        v: dossier.intensity_structure.intensity_types
          .map((m) => `${m.month} ${m.type}`)
          .join(joiner),
      }),
    );
  }
  const weeks = dossier.load_shape?.weeks ?? [];
  const totalRides = weeks.reduce((a, w) => a + w.rides, 0);
  if (totalRides > 0) {
    lines.push(
      TT(lang, "dossier.load", {
        avg: Math.round(weeks.reduce((a, w) => a + w.tss, 0) / weeks.length),
        peak: Math.max(...weeks.map((w) => w.tss)),
        hours:
          Math.round(
            (weeks.reduce((a, w) => a + w.duration_sec, 0) / weeks.length / 3600) * 10,
          ) / 10,
      }),
    );
  }
  const hd = dossier.load_shape?.hr_drift;
  if (hd?.median_pct != null) {
    lines.push(TT(lang, "dossier.drift", { v: hd.median_pct, n: hd.rides }));
  }
  if (dossier.cycling?.total_flagged > 0) {
    lines.push(TT(lang, "dossier.flagged", { n: dossier.cycling.total_flagged }));
  }

  return `${TT(lang, "dossier.head")}

${TT(lang, "dossier.baseline", {
    date: dossier.anchor_date ?? "—",
    considered: dossier.cycling?.considered ?? 0,
    with_power: dossier.cycling?.with_power ?? 0,
  })}
${lines.join("\n")}`;
}

/**
 * 统一拼装：角色 + 口径 + 当前时间 + 专业知识库（可选）+ 用户背景（可选）+
 * 训练档案（可选）+ 各数据段 + 问题清单。
 * skills 为 src/skills.js buildSkillsSection() 的输出，仅服务端 AI 调用注入
 * （CLI 提示词命令不传，保持原样）；
 * now 为当前时刻（buildDateSection 用，非法时该段省略）；
 * dossierSection 为 buildDossierSection 输出（可空）。
 */
function assemble(dataSections, questions, profile, skills, lang, now, dossierSection = null) {
  return [
    lang === "en" ? TEXT.en.role : ROLE,
    buildMetricGlossary(lang),
    ...[
      buildDateSection(now, lang),
      skills,
      buildProfileSection(profile, lang),
      dossierSection,
      ...dataSections,
    ].filter(Boolean),
    `${TT(lang, "answer.head")}\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
  ].join("\n\n");
}

/**
 * 用户背景与训练目标段（设置页维护，存训练库 settings 表 profile 行）。
 * 未配置或两字段皆空时返回 null（不产生该段）。
 */
export function buildProfileSection(profile, lang = "zh") {
  if (!profile) return null;
  const identity = String(profile.identity ?? "").trim();
  const goal = String(profile.goal ?? "").trim();
  if (!identity && !goal) return null;
  const lines = [];
  if (identity) lines.push(TT(lang, "profile.identity", { v: identity }));
  if (goal) lines.push(TT(lang, "profile.goal", { v: goal }));
  return `${TT(lang, "profile.head")}\n\n${lines.join("\n")}\n\n${TT(lang, "profile.tail")}`;
}

// ---------------- 提交前数据整形 ----------------
// summary.json 本身是聚合指标，体积基本与时长无关；但 anomalies（每段缺失一行）
// 与 segments（自动圈）两个列表会随时长线性增长。发送给 AI 前先把它们压缩成
// 聚合统计/首尾取样，保证提示词长度与训练时长无关（纯函数，不改原对象）。

/** ISO-8601 UTC 时间戳（带 Z 后缀、含可选毫秒） */
const ISO_UTC_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** 用户自填内容字段：原样透传，其中的时间戳不改写 */
const USER_TEXT_KEYS = new Set(["note", "identity", "goal", "content", "title"]);

/**
 * 把数据中的 ISO-8601 UTC 时间戳改写为带本地时区偏移的等价表示。
 * 训练数据的时间戳一律是 UTC 口径（records/segments/climbs/anomalies 均为
 * ISO 的 Z 形式），直接喂给 AI 会被按字面当成本地时间读——本地 19:51 的骑行
 * 在数据里是 11:51Z，AI 会理解成上午。改写后（2026-03-25T11:51:24.000Z →
 * 2026-03-25T19:51:24+08:00）时刻不变、语言中立，AI 无需自行逐条换算，
 * 也不会在跨日时算错。偏移取该时刻实际生效的本地偏移（夏令时按时刻判定）。
 * 纯日期字段（activity.date、训练库日期）保持 UTC 口径不动——它们与界面显示、
 * 训练库查询一致，单独换算会与之矛盾；用户自填内容（备注/身份/目标）不改写。
 * 返回新对象，入参不被修改（与 compactSummaryForPrompt 同一约定）。
 */
export function localizeTimestamps(value, key = "") {
  if (typeof value === "string") {
    if (USER_TEXT_KEYS.has(key)) return value;
    return value.replace(ISO_UTC_RE, (m) => {
      const d = dayjs(m);
      return d.isValid() ? d.format("YYYY-MM-DDTHH:mm:ssZ") : m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => localizeTimestamps(v, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = localizeTimestamps(v, k);
    return out;
  }
  return value;
}

/** 原始 anomalies 条数超过该值时聚合为 anomalies_summary */
const ANOMALY_RAW_MAX = 5;
/** segments 超过该值时保留前 KEEP_HEAD + 后 KEEP_TAIL，中间用占位标记省略 */
const SEGMENTS_MAX = 20;
const SEGMENTS_KEEP_HEAD = 10;
const SEGMENTS_KEEP_TAIL = 5;
/** climbs 超过该值时只保留爬升最大的若干段 */
const CLIMBS_MAX = 10;

/**
 * 把逐条异常标注按类型聚合为 anomalies_summary。
 * 新格式为结构化对象 { type, duration_sec?, at }（语言中立，按 type 键聚合）；
 * 旧数据（字符串"功率缺失 78s，起始 ISO"式）兼容按前缀/正则解析。
 */
function aggregateAnomalies(anomalies) {
  const groups = new Map();
  for (const a of anomalies) {
    let type, at, dur;
    if (typeof a === "string") {
      type = a.split(" ")[0] || "other";
      dur = /(\d+)s[，,]/.exec(a)?.[1];
      at = /(?:起始|位于)\s+(.+)$/.exec(a)?.[1];
    } else if (a && typeof a === "object") {
      type = a.type ?? "other";
      dur = a.duration_sec ?? null;
      at = a.at ?? null;
    } else {
      continue;
    }
    let g = groups.get(type);
    if (!g) {
      g = { type, count: 0, first_at: at };
      groups.set(type, g);
    }
    g.count++;
    if (dur != null) {
      const d = Number(dur);
      g.total_sec = (g.total_sec ?? 0) + d;
      g.max_sec = Math.max(g.max_sec ?? 0, d);
    }
  }
  return [...groups.values()];
}

/**
 * 压缩 summary 中随时长增长的列表，返回新对象（原对象不变）：
 * - anomalies 超过 ANOMALY_RAW_MAX 条 → timer_pause（计时暂停）不参与聚合、
 *   逐条保留在 anomalies 里，其余类型替换为 anomalies_summary 聚合统计。
 *   暂停的 at 是判断其落在哪个环节（热身/通勤/间歇之间）的唯一位置证据，
 *   聚合掉会迫使 AI 凭叙述需要"安放"暂停（真实缺陷：热身段暂停被归因为
 *   冲刺段没出力）；通勤红灯多也就十几条，逐条保留体积可控。
 * - segments 超过 SEGMENTS_MAX 段 → 保留首尾，中间省略（首尾对比仍可看出衰减）；
 * - climbs 超过 CLIMBS_MAX 段 → 只保留爬升最大的段。
 * 最后统一经 localizeTimestamps 把 UTC 时间戳改写为本地时区偏移表示
 * （见该函数说明），保证 AI 按本地时间解读训练时段。
 */
export function compactSummaryForPrompt(summary, lang = "zh") {
  if (!summary || typeof summary !== "object") return summary;
  const out = { ...summary };
  if (Array.isArray(out.anomalies) && out.anomalies.length > ANOMALY_RAW_MAX) {
    const isPause = (a) => a && typeof a === "object" && a.type === "timer_pause";
    const pauses = out.anomalies.filter(isPause);
    const others = out.anomalies.filter((a) => !isPause(a));
    if (pauses.length) {
      out.anomalies = pauses;
      const agg = aggregateAnomalies(others);
      if (agg.length) out.anomalies_summary = agg;
    } else {
      out.anomalies_summary = aggregateAnomalies(others);
      delete out.anomalies;
    }
  }
  if (Array.isArray(out.segments) && out.segments.length > SEGMENTS_MAX) {
    const omitted = out.segments.length - SEGMENTS_KEEP_HEAD - SEGMENTS_KEEP_TAIL;
    out.segments = [
      ...out.segments.slice(0, SEGMENTS_KEEP_HEAD),
      { name: TT(lang, "seg.omitted", { n: omitted }) },
      ...out.segments.slice(-SEGMENTS_KEEP_TAIL),
    ];
  }
  if (Array.isArray(out.climbs) && out.climbs.length > CLIMBS_MAX) {
    out.climbs = [...out.climbs]
      .sort((a, b) => (b.elevation_gain_m ?? 0) - (a.elevation_gain_m ?? 0))
      .slice(0, CLIMBS_MAX);
  }
  return localizeTimestamps(out);
}

// ---------------- 场景模板 ----------------

function categoryName(cat, lang) {
  return TT(lang, `cat.${cat}`) || TT(lang, "cat.training");
}

/**
 * 单次复盘：传入某次训练的 summary.json 对象。
 * 若 summary.activity.note 存在（用户在详情页填写的体感/路况备注），提示 AI 纳入考量；
 * profile 为用户背景与训练目标（可选，来自训练库 settings 表）；
 * skills 为专业知识库段（可选，仅服务端注入，见 src/skills.js）；
 * lang 为提示词语言（zh/en，默认 zh）；
 * now 为当前时刻（可注入固定值便于测试，缺省当前时间）。
 */
export function buildReviewPrompt(
  summary,
  profile,
  skills,
  lang = "zh",
  now = new Date(),
  dossierSection = null,
) {
  const catName = categoryName(summary?.activity?.category, lang);
  const note = String(summary?.activity?.note ?? "").trim();
  return assemble(
    [
      `${TT(lang, "sec.review", { cat: catName })}` +
        (note ? ` ${TT(lang, "sec.review.note")}` : "") +
        `\n\n${jsonBlock(compactSummaryForPrompt(summary, lang))}`,
    ],
    [
      TT(lang, "review.q.0"),
      ...(note ? [TT(lang, "review.q.note")] : []),
      TT(lang, "review.q.1"),
      TT(lang, "review.q.2"),
      TT(lang, "review.q.3"),
      TT(lang, "review.q.4"),
      TT(lang, "review.q.5"),
      TT(lang, "review.q.6"),
    ],
    profile,
    skills,
    lang,
    now,
    dossierSection,
  );
}

/**
 * 周期规划：基于月汇总 + 逐周 CTL/ATL/TSB 走势 + 近期训练清单。
 * @param {{ months: object[], formSeries: object[], recentActivities: object[] }} data
 * @param {object} [profile] 用户背景与训练目标（可选）
 * @param {string} [skills] 专业知识库段（可选，仅服务端注入）
 * @param {string} [lang] 提示词语言（zh/en，默认 zh）
 * @param {Date} [now] 当前时刻（可注入固定值便于测试，缺省当前时间）
 */
export function buildPlanPrompt(
  { months, formSeries, recentActivities },
  profile,
  skills,
  lang = "zh",
  now = new Date(),
  dossierSection = null,
) {
  return assemble(
    [
      `${TT(lang, "sec.plan.monthly")}\n\n${jsonBlock(months)}`,
      `${TT(lang, "sec.plan.form")}\n\n${jsonBlock(formSeries)}`,
      `${TT(lang, "sec.plan.recent")}\n\n${jsonBlock(recentActivities)}`,
    ],
    [0, 1, 2, 3, 4].map((i) => TT(lang, `plan.q.${i}`)),
    profile,
    skills,
    lang,
    now,
    dossierSection,
  );
}

/**
 * 赛前调整（减量 taper）。
 * @param {{ raceDate: string, daysLeft: number, form: object, formSeries: object[], recentActivities: object[] }} data
 * @param {object} [profile] 用户背景与训练目标（可选）
 * @param {string} [skills] 专业知识库段（可选，仅服务端注入）
 * @param {string} [lang] 提示词语言（zh/en，默认 zh）
 * @param {Date} [now] 当前时刻（可注入固定值便于测试，缺省当前时间）
 */
export function buildTaperPrompt(
  { raceDate, daysLeft, form, formSeries, recentActivities },
  profile,
  skills,
  lang = "zh",
  now = new Date(),
  dossierSection = null,
) {
  return assemble(
    [
      `${TT(lang, "sec.taper.race")}\n\n${TT(lang, "sec.taper.race_line", { date: raceDate, days: daysLeft })}`,
      `${TT(lang, "sec.taper.form")}\n\n${jsonBlock(form)}`,
      `${TT(lang, "sec.taper.trend")}\n\n${jsonBlock(formSeries)}`,
      `${TT(lang, "sec.taper.recent")}\n\n${jsonBlock(recentActivities)}`,
    ],
    [0, 1, 2, 3, 4].map((i) => TT(lang, `taper.q.${i}`)),
    profile,
    skills,
    lang,
    now,
    dossierSection,
  );
}

/**
 * 两次训练对比：传入两个 summary.json 对象。
 * profile 为用户背景与训练目标（可选，来自训练库 settings 表）；
 * skills 为专业知识库段（可选，仅服务端注入）；
 * lang 为提示词语言（zh/en，默认 zh）；
 * now 为当前时刻（可注入固定值便于测试，缺省当前时间）。
 */
export function buildComparePrompt(
  summaryA,
  summaryB,
  profile,
  skills,
  lang = "zh",
  now = new Date(),
  dossierSection = null,
) {
  const dateA = summaryA.activity?.date ?? "未知日期";
  const dateB = summaryB.activity?.date ?? "未知日期";
  return assemble(
    [
      `${TT(lang, "sec.compare.a", { date: dateA })}\n\n${jsonBlock(compactSummaryForPrompt(summaryA, lang))}`,
      `${TT(lang, "sec.compare.b", { date: dateB })}\n\n${jsonBlock(compactSummaryForPrompt(summaryB, lang))}`,
    ],
    [0, 1, 2, 3, 4, 5].map((i) => TT(lang, `compare.q.${i}`)),
    profile,
    skills,
    lang,
    now,
    dossierSection,
  );
}

// ---------------- 数据整形（供 index.js 调用） ----------------

/** 逐日 form 序列抽稀为逐周点（每 7 天取一个，含最后一天），控制 prompt 长度 */
export function thinToWeekly(dailySeries) {
  const out = [];
  for (let i = 0; i < dailySeries.length; i += 7) out.push(dailySeries[i]);
  const last = dailySeries[dailySeries.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}
