# fit-reader 安卓移植改造计划

> 2026-09-17 制定，2026-09-17 更新（新增 §4 UI/UX 重构）。目标：把 Docker/Web 版 fit-reader 改造为**纯本地安卓 App**，功能对齐现有 Web 版、UI 按 Material 3 移动优先重构，AI 继续 BYOK，不架设任何服务器。本文档是规划成果，不涉及实现。

---

## 0. 结论速览（TL;DR）

| 决策项 | 结论 |
|---|---|
| 技术栈 | **React Native（Expo 框架）+ TypeScript** |
| 核心理由 | 现有 ~3500 行纯 JS 算法/提示词/工具层**直接复用**，`fit-file-parser` 无 Node 内置依赖可在 RN 运行（待 PoC 确认），单人维护成本最低 |
| UI | **不照搬 Web 版**：底部 Navigation Bar 四 tab（首页/训练/AI/我的）+ Material 3 规范重构；AI 报告与对话合并为「AI 会话中心」（详见 §4） |
| 图表 | 继续走**自绘**路线：`react-native-svg` 把现有"拼 SVG 字符串"的 charts.js 翻译成组件（+ 抽稀 ≤1400 点，与现有 `/api/records` 同口径） |
| 数据库 | `expo-sqlite`（可开 SQLCipher 加密），schema 从现有 `src/db.js` 平移 |
| AI | BYOK 不变；API Key 从明文 SQLite 改存 `expo-secure-store`（Android Keystore）；SSE 流式用 `expo/fetch`，兜底 `react-native-sse`，再兜底非流式（与现版默认行为一致） |
| 长期数据 | 主方案：**应用内「导出/导入备份包」**（`.fitbackup` = zip：db 副本 + records 文件 + manifest），经系统 SAF/分享面板落到用户自选位置（Downloads/网盘/换机）；辅助：Android Auto Backup 兜底（国内 ROM 无 GMS 基本无效，不指望） |
| Repo 策略 | **新建 repo 重新开始**，旧 repo 冻结为 reference；一次性在旧 repo 增加 `--export` 命令产出迁移包，把现有 `db/fitness.db` 历史带进 App |
| 去掉的功能 | CLI 批量 analysis、`--monthly`/`--trend`、四个 CLI 提示词命令、`server.js` 与 `web/`、Docker 部署 |

---

## 1. 范围：保留 / 去掉 / 换实现

### 1.1 保留（功能对齐，布局重构）

- FIT 文件导入 → 分析 → 逐秒指标与异常标注 → 入库
- 训练列表 / 详情页（时序多轴图、分区分布、峰功率曲线、间歇组、爬坡段、踏频风格、数据质量）
- 训练库与 CTL/ATL/TSB 体系（仪表盘大数字、趋势图、form 状态）
- 骑手参数（FTP/最大心率/体重）、FTP 历史估算与应用
- AI 四场景报告（复盘/规划/减量/对比）+ 报告追问 + 直接对话（agentic 工具查库、simulate_form/generate_workout 推演）
- AI 记忆、训练分类标记、训练备注、用户身份与自定义目标（profile）
- 双语 zh/en（词典直接搬）
- BYOK：用户自配 OpenAI 兼容接口

> 注意：以上是**功能清单**对齐；信息架构与布局按 §4 重构（底部导航、AI 两 tab 合并、上传并入训练页等），Web 版 UI 仅作内容参考、不作布局蓝本。

### 1.2 去掉

- `index.js` 的 CLI 批量分析与单文件命令行入口（App 内导入取代）
- `--monthly` / `--trend`（界面已有同等信息）
- `--review` / `--plan` / `--taper` / `--compare` CLI 提示词命令（四场景全部并入 App UI；「复制提示词」兜底模式保留在 AI 设置的空态引导里）
- `server.js`、`web/`、Docker 部署（被 App 取代）

### 1.3 换实现（功能等价、底层替换）

| 现有实现 | 安卓端实现 |
|---|---|
| `node:sqlite`（src/db.js） | `expo-sqlite`（同步 API；SQL 可基本照搬，只换驱动层） |
| `node:http/https` + 自管超时（src/ai.js） | `expo/fetch`（WinterCG 合规 fetch，支持流式读 body；超时用 AbortController） |
| `marked` 渲染报告 HTML | `react-native-markdown-display` 渲染原生组件 |
| AI Key 存 settings 表（明文） | `expo-secure-store`（Keystore 加密；**安全升级**，且默认不进系统备份） |
| `node:test` 回归测试 | 纯函数单测**原样保留** node:test 跑（算法层不依赖 RN）；UI/集成层用 Jest/Expo test |
| 文件读写 `fs`（input/output 目录） | `expo-document-picker` 选 FIT + `expo-file-system` 读字节 |
| Web hash 路由 SPA（顶栏 tab + 三点菜单） | Expo Router 底部 Tabs 导航（§4） |

---

## 2. 技术栈选型

### 2.1 候选对比

| 维度 | **React Native (Expo)** ✅ | Kotlin + Jetpack Compose | Flutter |
|---|---|---|---|
| UI 成熟度 | 成熟（Expo + RN 新架构，2026 稳定） | 原生 Material3，最成熟 | 成熟 |
| **FIT 解析** | **`fit-file-parser` 直接复用**（已验证：唯一外部依赖是 npm `buffer` polyfill，不用任何 Node 内置 API） | Garmin 官方 Java SDK（`com.garmin:fit`，Maven 可用，需自写消息→模型映射层） | pub.dev 的 fit 包质量参差、维护弱，风险大 |
| **算法层复用** | index.js 纯函数 + src/ftp、planning、prompts、tools、i18n、skills ≈ **3500 行直接搬** | 全部重写为 Kotlin（NP/TSS 公式简单，但暂停识别、anomalies、爬升去抖等口径细节多） | 全部重写为 Dart |
| 图表 | react-native-svg 组件化（现有 charts.js 本就是拼 SVG 字符串，机械翻译） | Compose Canvas 重写或 Vico（高度定制需求下库反而碍事） | fl_chart 或 CustomPainter 重写 |
| SQLite | expo-sqlite（+SQLCipher） | Room（最正规） | drift/sqflite |
| AI SSE | expo/fetch 流式；react-native-sse 兜底 | OkHttp SSE（最成熟） | http 包 SSE 较弱 |
| 与现有 repo 语言 | **同为 JS/TS**，词典/提示词/技能 md 原样可用 | 换语言 | 换语言 |
| 单人开发成本 | **最低**（估 5–8 周业余量级） | 中高（估 2–3 倍于 RN） | 中高 |

> 关于"RN 性能/大厂弃用"的补充（2026-09 讨论）：弃用叙事源于旧 bridge 架构时代（Airbnb 2018 等）；RN 0.76 起新架构（Fabric/JSI/TurboModules）默认开启后该债已清，2025–2026 生态处于强势期。更关键的是 RN 的经典弱区（长列表快速滚动、复杂手势动画、每帧 UI 更新）本项目一个不踩；真实性能敏感点是图表自绘（两路线等价）与导入时一次性算法计算（现 Docker 版即浏览器 JS 跑同款代码）。选择 RN 的本质是"复用 3500 行已验证资产，把时间花在产品上"；若你更看重原生天花板、想学 Kotlin、或未来要做 BLE 实时码表连接，则改选 Kotlin + Compose + Garmin Java SDK，代价约 2–3 倍工期。

### 2.2 推荐：React Native + Expo

决定性因素是**资产复用率**：本项目的价值大头不在 UI，而在分析管线（解析→重采样→指标→异常→入库→提示词→agentic 工具），这 3500 行是纯 JS 且经过 node:test 回归与真实数据验证。RN 路线让它们零翻译进入 App，测试体系也能整体搬走；Kotlin/Flutter 路线则要在重写过程中重新踩一遍所有口径细节的坑（海拔 km 缩放 bug、暂停三级判据这类），regressions 风险高。

性能不是问题：逐秒重采样与指标计算的数据量（单次骑行 ≤ 2 万点）在 Hermes 引擎上轻松处理——现在 Web 版就是在浏览器 JS 里跑同样的代码。图表渲染点数沿用现有 ≤1400 抽稀口径。

**备选说明**：若你想借机学原生 Android 开发、不在意全部重写，Kotlin + Compose + Room + Garmin Java SDK 是"最正统"路线，长期无桥接层；但作为单人效率优先的项目，不推荐。

### 2.3 RN 路线组件清单

- **框架**：Expo（SDK 最新稳定版），Expo Router 导航，dev client 真机调试，最终产出 APK 侧载（不上 Play Store 也可）
- **UI**：React Native Paper 5（Material 3 组件库）+ `react-native-safe-area-context`；主题照搬现有 volt 荧光黄暗色风作为 MD3 自定义暗色 scheme 的品牌主色（详见 §4.4）
- **导航**：Expo Router Tabs（`@react-navigation/bottom-tabs`，底部 Navigation Bar）
- **图表**：`react-native-svg`（详见 §5）
- **存储**：`expo-sqlite`（训练库）+ `expo-secure-store`（AI Key）+ `expo-file-system`（records 数据文件、备份临时目录）
- **文件选择**：`expo-document-picker`（导入 FIT / 导入备份包）；分享用系统 Share Sheet
- **弹层/表单**：`@gorhom/bottom-sheet`（报告场景选择）；`@react-native-community/datetimepicker`（减量比赛日期）
- **网络**：`expo/fetch`（AI 调用，含 SSE）
- **时间**：dayjs 继续用（纯 JS）

---

## 3. 架构映射（现有模块 → App）

```
fit-reader-app/
├─ app/                          # Expo Router 文件路由（对应 §4 新导航架构）
│   ├─ _layout.tsx               # 根栈：底部 Tabs + 模态页
│   ├─ (tabs)/
│   │   ├─ _layout.tsx           # 底部导航：首页 / 训练 / AI / 我的
│   │   ├─ index.tsx             # 首页（dashboard）
│   │   ├─ activities.tsx        # 训练列表（FAB「＋」导入 FIT）
│   │   ├─ ai.tsx                # AI 会话中心（报告 + 对话合并，见 §4.2）
│   │   └─ me.tsx                # 我的（设置主体 + 记忆/数据管理/关于入口）
│   ├─ activity/[id].tsx         # 训练详情（时序图/分区/峰功率/异常/备注/分类）
│   ├─ ai/session/[id].tsx       # 会话详情（报告正文 + 追问 / 对话）
│   ├─ memory.tsx / about.tsx    # 从「我的」进入的二级页
│   └─ import.tsx                # FIT 导入流程（FAB 触发的全屏模态）
├─ src/
│   ├─ core/                     # ★ 从旧 repo 原样搬（纯 JS，仅补 TS 类型）
│   │   ├─ analyze.ts            # index.js 的工具函数 + P0 分析 + analyzeFile 主体（去 fs/入库 IO，改依赖注入）
│   │   ├─ settings.ts           # 分区/阈值配置原样
│   │   ├─ ftp.ts / planning.ts / records.ts
│   ├─ prompts/                  # ★ prompts.js + i18n.js + skills/ 目录原样搬
│   ├─ tools/                    # ★ tools.js 的 schema/校验/分发搬，executeTool 改调本地 expo-sqlite
│   ├─ ai/                       # ai.js 重写：fetch + SSE + agentic 循环（循环骨架可搬，传输层换）
│   ├─ db/                       # db.js 平移：建表/查询 SQL 保留，驱动换 expo-sqlite；
│   │                            #   computeForm/monthlySummary 等纯计算逻辑原样
│   └─ backup/                   # 新增：备份导出/导入（§7）
└─ assets/icons/...
```

**搬运原则**：`src/core` 与 `src/prompts` 里的函数都是"输入→输出"纯函数，搬运时只在文件头补类型与 `@types`，逻辑不动——这保证 node:test 黄金断言继续成立。IO 型模块（db/ai/records）保留"逻辑与驱动分离"的现有分层，只换驱动。

`analyzeFile()` 的改造点：现在它直接 `fs` 读写 + 入库；改为接收 `{ bytes: Uint8Array, fileName }` 返回 `{ records, summary }`，入库/落盘由调用方（App 层）决定——这让管线可单测、可在导出工具里复用。

---

## 4. UI/UX 重构（移动优先，参考 Material 3）

> 原则：**功能对齐 Web 版，布局不照搬**。现有 UI 是桌面 web 优先设计（顶栏 6 tab + 三点菜单、AI 报告页四张大卡片表单），移动端按 Google [Material Design 3](https://m3.material.io) 规范重新组织信息架构。

### 4.1 导航架构：顶部 tab → 底部 Navigation Bar（4 目的地）

| Web 现状 | App 新结构 | 依据 |
|---|---|---|
| 顶栏 tab：概览 / 训练 / 上传 / AI 报告 / 对话 | 底部导航：**首页 / 训练 / AI / 我的** | MD3：底部 Navigation Bar 承载 3–5 个同级顶级目的地，处于拇指易达区 |
| 独立「上传」tab | 训练页 **FAB「＋」**导入 FIT | MD3：FAB 是首要创建动作的标准位置；导入本质是"给训练库加一条记录"，归属训练域 |
| 「AI 报告」「对话」两个 tab（功能重复感） | 合并为**「AI」会话中心** | 见 §4.2 |
| 三点菜单：记忆 / 设置 / 关于 | **「我的」tab**，默认打开设置 | 设置类内容不作一级目的地；记忆/关于/数据管理作为页内入口 |

### 4.2 AI tab：报告与对话合并为「AI 会话中心」

数据层已天然统一——`ai_chats` 两表模型里报告追问本来就是 follow_up 对话，合并**无数据迁移成本**，纯 UI 层重组。

- **页面结构**：顶部两个主操作「＋ 新对话」「生成报告」；主体为**统一历史列表**（报告与对话混排、按时间倒序，卡片以类型徽章区分 review/plan/taper/compare/chat，支持按类型过滤）。
- **报告生成交互**：替换现有"四张大卡片（标题+描述+下拉+按钮）+ 历史列表堆同一页"的 web 布局（移动端空间浪费的主因）。改为 Bottom Sheet 场景选择流：点「生成报告」→ 底部弹层列出四场景（名称 + 一句话说明）→ 选中后按场景追加参数——复盘：活动选择器；规划：无参数；减量：系统日期选择器；对比：双活动选择器 → 确认生成 → **跳转会话详情页**（markdown 正文 + 追问输入框，沿用现有报告正文与追问机制）。
- **降级路径**：AI 未配置时空态引导去「我的 → AI 服务配置」，同时保留「复制提示词」按钮。
- 会话详情页支持分享（系统 Share Sheet 分享 markdown 全文）。

### 4.3 「我的」tab（设置为主体）

- 顶部骑手摘要卡（现顶栏 athlete chip 的信息：FTP/最大心率/体重 + 当前 form 状态）。
- 分组设置项：骑手参数、界面语言、用户背景与训练目标（自定义目标入口）、AI 服务配置（BYOK）。
- 页内入口行（icon + label 的 list item）：**AI 记忆**、**数据管理**（备份导出/导入，§7——新 App 的关键能力，放这里而非设置项）、**关于**。
- 首开引导沿用：未配置骑手参数时首次落地「我的」页（不强制锁定）。

### 4.4 设计规范与实现

- **规范**：Material 3（m3.material.io）——Navigation Bar / FAB / Cards / Bottom Sheets / 过滤 Chips；日期与选择用系统原生控件；深色主题为默认基调。
- **品牌延续**：现有 volt 荧光黄暗色风保留为 MD3 自定义暗色 color scheme 的品牌主色（MD3 允许以品牌色构造 scheme），组件形态与交互模式遵循 MD3，视觉个性靠品牌色与等宽数字排版延续。
- **大屏/横屏**：按 MD3 自适应规范，后期可把底部栏替换为 Navigation Rail（首版手机优先，不强制）。
- **实现**：Expo Router Tabs + React Native Paper 5 + `@gorhom/bottom-sheet` + `@react-native-community/datetimepicker`（清单见 §2.3）。
- **i18n**：双语词典与 zh/en 切换逻辑照搬（`web/js/i18n.js` → `src/prompts/i18n`），导航与新增控件文案补 key。

---

## 5. 图表方案（不用 WebView）

现状：`web/js/charts.js`（187 行）是**模板字符串拼 SVG**（`<path d="...">`、渐变、网格刻度），四类图：多系列时序（各系列独立纵轴 + 短缺口桥接 + 中心移动平均）、CTL/ATL/TSB 趋势（TSS 背景柱）、分区横条、峰功率柱状。

方案：**`react-native-svg` 组件化直译**。理由：

1. 现有代码已经是"计算 path 数据 → 拼 SVG 元素"两段式，计算段（bridge/smooth/坐标映射）是纯 JS **原样复用**，只有拼字符串段换成 JSX（`<Path d={d}/>`、`<Defs><LinearGradient>` 一一对应）；
2. 需求高度定制（多系列独立纵轴、null 断段、≤180s 桥接、双 Y 轴 + 背景柱），通用图表库（victory-native、gifted-charts）覆盖这些定制反而比自绘费劲；
3. 渲染点数：沿用现有 `/api/records` 的 **≤1400 点抽稀**口径（`src/records.js` 的 `loadRecords` 本来就做这件事，直接搬），react-native-svg 在该量级流畅。

移动端增强（可后置）：时序图加双指缩放/拖动查看细节（react-native-gesture-handler + 重新映射视窗，计算层不变）。

兜底：若真机帧率不达标，升级到 `@shopify/react-native-skia` 重绘同一套 path 数据（计算层不变，只换渲染器），或 victory-native XL（也基于 Skia）。

---

## 6. AI 层（BYOK 不变，本地直连）

- **配置**：设置页（「我的」tab）维护 base_url/model/api_key 等（与现 Web 设置页同构），Key 存 `expo-secure-store`，其余存库；未配置时保留"复制提示词"降级模式。
- **调用**：`expo/fetch` 直连用户接口。现版自管超时/心跳日志的诉求由 AbortController + 分块读取覆盖；**默认仍可非流式**（现版本默认就是非流式 + 30s 心跳，App 端体验不降级），流式作为增强。
- **SSE 流式**：`expo/fetch` 的 response body 是 WinterCG ReadableStream，可逐块解析 `data:` 行（现 src/ai.js 已有 SSE 拼接逻辑可参考）；兜底 `react-native-sse`（对 chat/completions 场景成熟，本项目恰好就是 chat/completions 接口）。
- **Agentic 工具**：`src/tools.js` 的 9 个工具 schema、参数白名单、`executeTool` 分发逻辑全部复用——工具只是查本地库与纯计算，换掉底层 db 调用即可。`runAgentLoop` 循环骨架（≤6 轮、超时、降级）同样直译。
- **提示词与技能**：`src/prompts.js` 双语模板、`skills/*.md` 知识库、记忆段拼装原样搬——这套是项目的核心竞争力，RN 路线零损耗。
- **对话持久化**：ai_chats 两表 schema 平移，pending 状态机与轮询改本地化（无网络请求，直接异步任务 + 状态订阅，比 Web 版还简单）；UI 侧按 §4.2 呈现为统一会话列表。

---

## 7. 长期数据保存方案（调研结论）

### 7.1 候选对比

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 应用内导出/导入备份包** ✅主方案 | 把库+数据文件打包 zip，经 SAF（Storage Access Framework）存到用户选的目录，或系统分享面板发出 | 零依赖（无 Google/无自建服务）、用户完全可控、跨品牌换机通用、顺带满足"定期备份" | 手动操作 | **采用** |
| B. Android Auto Backup | 系统 automatically 备份到 Google Drive（≤25MB） | 零代码 | **国内 ROM 无 GMS 基本无效**；有 GMS 也常被用户跳过恢复；KeyVault 数据默认排除 | 开着兜底，不指望 |
| C. 自建云同步（WebDAV/坚果云/Dropbox） | App 内置云客户端定期上传 | 自动化 | 新增凭据管理/冲突合并逻辑，工作量大 | 后续可选增强，首版不做 |
| D. 换机克隆类工具 | 小米换机等直接拷 app 私有目录 | 用户零操作 | 厂商实现不一、不可靠、用户难感知 | 不依赖，但方案 A 的文件落在公共目录时自然被带走 |

### 7.2 采用的备份包设计

格式：`.fitbackup`（本质 zip），内容：

```
manifest.json        # { schema_version, app_version, exported_at, device, counts }
fitness.db           # SQLite 库文件副本（PRAGMA user_version 标 schema 版本）
records/             # 每活动一个 gzip 压缩的逐秒数据（从 CSV 改为压缩存储）
```

要点：

- **db 整库拷贝**而非逐表 JSON：SQLite 文件格式跨平台稳定，`PRAGMA user_version` 驱动导入端跑迁移链（与 App 内升级共用同一套 migration）；操作是 `VACUUM INTO` 或 checkpoint 后复制，秒级完成。
- records 逐秒数据不入库（单次 4h 骑行 1.4 万行，一年几百次会让库膨胀到几十 MB，拖累每次打开速度），以每活动一个 gzip 文件存 app 私有目录（gzip 后单次约 50–150KB），备份时整目录打包。详情页图表读文件 + 现有 `loadRecords` 抽稀。
- **导入**：选包 → 校验 manifest.schema_version → 版本高于本机则提示升级 App → 覆盖前先把当前数据自动导出一份（防误导入清库）→ 原子替换。
- **触发点**：「我的 → 数据管理」手动按钮 + 每次入库后静默在 app 目录滚一份本地快照（空间换安全）。

### 7.3 从 Docker 版带走历史数据

旧 repo 终止维护前加**一次性命令** `node index.js --export [输出目录]`：

- 打包 `db/fitness.db` + `output/*.records.csv`（转 gzip 进 records/）+ manifest（schema_version 与现库一致）
- App 端「我的 → 数据管理 → 导入」消费同一格式 → 现有 CTL/ATL 历史、AI 记忆、分类备注全部无缝迁移
- 实现量小（复用现有 db.js 与 fs），建议作为安卓版 M1 之前/并行的小任务先落地，这样开发期间两版数据可随时互通

---

## 8. 迁移路径

### 8.1 Repo 策略

**新建 repo（建议名 `fit-reader-app`），从零开始；旧 repo 冻结为 reference。**

- 理由：构建体系（npm → Expo/Metro）、测试框架、目录结构全变，在旧 repo 上改会留下大量半死分支与无意义 diff 历史；而旧 repo 的 git 历史本身就是最好的参考档案（口径演进、bug 修复记录都在）。
- 做法：`npx create-expo-app` 起骨架 → 把 `src/core`、`src/prompts`、`skills/`、`test/unit.test.mjs` 逐个**复制**过来（保留文件头注释，标注来源 commit），边搬边补 TS 类型。
- 旧 repo 处置：完成 `--export` 命令 + README 加"已迁移至 fit-reader-app"声明后进入只修关键 bug 状态。
- 双 repo 并行期数据互通靠 §7.3 的备份包。

### 8.2 里程碑

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **M0** | Expo 骨架、**底部四 tab 导航 + MD3 暗色主题（volt 品牌色）**、i18n 词典接入；**4 个 PoC**（见 8.3） | PoC 全过 | 0.5–1 周 |
| **M1** | 解析管线搬运（analyzeFile 改依赖注入）+ expo-sqlite 建库 + 训练导入（FAB 流程）+ 详情页四类图表 | 真实 MAGENE 文件在 App 内跑出与 Docker 版一致的 summary（黄金 diff） | 1–2 周 |
| **M2** | 首页仪表盘、趋势图、训练列表、「我的」设置页（骑手参数/语言/FTP 估算与应用） | 与 Web 版功能对齐 | 1 周 |
| **M3** | AI 层：配置页（secure-store）、**AI 会话中心（四场景 Bottom Sheet 生成流 + 统一历史列表）**、会话详情追问、agentic 工具、记忆 | 对真实库生成中文报告，工具调用正常 | 1–2 周 |
| **M4** | 备份导出/导入（§7.2）+ 旧 repo `--export` 命令 + 旧数据实机迁移 | 换机演练：旧库数据完整出现在 App | 0.5–1 周 |
| **M5** | 打磨：图标、启动屏、错误边界、空态/加载态（MD3）、APK 构建（EAS 或本地 gradle）侧载 | 日常可用 | 0.5 周 |

单人业余时间合计约 **5–8 周**。

### 8.3 M0 必须先做的 4 个 PoC（风险前置）

1. **fit-parser PoC**：Expo 项目里 `import FitParser from "fit-file-parser"`，`expo-file-system` 读真实 `.fit` 字节传入解析。buffer polyfill 是它自带依赖、无 Node 内置引用，理论可行，但 Metro/Hermes 下未实测过。**不过则 fork 修或换 dist 路径，此为全计划最大单点风险。**
2. **SVG 性能 PoC**：react-native-svg 渲染 1400 点多系列折线，真机滑动帧率。
3. **SSE PoC**：expo/fetch 对用户 Kimi 接口流式读 chat/completions。
4. **SQLite 兼容 PoC**：把现有 `db/fitness.db` 直接 push 到设备用 expo-sqlite 打开查询——顺便验证 §7 迁移路径可行性（node:sqlite 与 expo-sqlite 都是标准 SQLite，理论无障碍）。

### 8.4 测试策略

- **黄金数据集**：在旧 repo 用 `input/` 真实 FIT 跑出 summary.json 存入新 repo `fixtures/`；新端分析同一文件后 diff 关键指标（NP/TSS/峰功率/anomalies/pause_seconds），毫位级一致才算搬运合格。这是防"重写走样"的核心手段。
- 纯函数单测（现 `test/unit.test.mjs` 覆盖的 NP/peakAvg/间歇/爬升/漂移/ftp/planning/prompts）原样搬，node:test 继续跑（算法层不 import RN）。
- db 层测试：expo-sqlite 内存库 + 现有 web.test.mjs 的场景断言改写。

### 8.5 风险清单

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| fit-file-parser 在 Metro/Hermes 不可用 | 低–中 | 高（换解析器=重写管线） | M0 PoC 前置；兜底 fork 修（库很小）或 Garmin Java SDK 经原生模块桥接 |
| react-native-svg 大数据卡顿 | 低 | 中 | ≤1400 抽稀；兜底 Skia |
| expo/fetch 流式在部分国产 ROM 网络栈异常 | 低 | 低 | react-native-sse 兜底；最终兜底非流式（现版本默认即非流式） |
| schema 演进破坏旧备份导入 | 中 | 中 | user_version 迁移链 + 每次升级用真实备份回归导入测试 |
| 单人双 repo 维护分心 | 中 | 低 | 旧 repo 冻结策略，只修 P0 |

---

## 9. 开放问题（动手前需要你拍板的）

1. **iOS 要不要顺带支持？** Expo 路线天然双端，但 FIT 导入、Keystore 等只需多少量适配；若明确只发安卓，dev client 与发布流程更省。（建议：按双端写代码、只出安卓包，零额外成本。）
2. **是否上 Play Store？** 侧载 APK 完全够个人用；上架涉及隐私声明（健康数据）与账号体系要求。（建议：个人用侧载。）
3. **records 历史留不留？** Docker 版 output/ 里的逐秒 CSV 若不再需要图表回看，迁移包可瘦身。（建议：保留，gzip 后很小。）
4. **SQLCipher 加密是否启用？** 健康数据 + 可 root 设备，建议开，成本仅构建配置。
5. **AI 会话中心的历史列表**：报告与对话混排（按时间倒序）还是分两组显示？（建议：混排 + 顶部类型过滤 chips，更贴近聊天 App 心智。）

---

## 附：调研参考

- [Material Design 3 官方规范](https://m3.material.io)（导航/FAB/Bottom Sheet/自适应布局，§4 的设计依据）
- [Garmin FIT SDK 官方页](https://developer.garmin.com/fit/) / [官方 Java SDK (com.garmin:fit) on Maven](https://mvnrepository.com/artifact/com.garmin/fit)（Kotlin 备选路线用）
- [Expo AI SDK 指南（expo/fetch 流式）](https://ai-sdk.dev/v4/docs/getting-started/expo) / [expo/fetch 文档](https://docs.expo.dev/versions/latest/sdk/expo/) / [react-native-sse](https://www.npmjs.com/package/react-native-sse)
- [React Native 新架构官方文档](https://reactnative.dev/architecture/landing-page)（0.76+ 默认 Fabric/JSI，性能债已清的证据）
- [Android Auto Backup 官方文档（25MB 限制）](https://developer.android.com/identity/data/autobackup) / [r/androiddev 备份实践讨论](https://www.reddit.com/r/androiddev/comments/p3e2hk/what_is_the_best_practice_for_backing/)
- 本地验证：`fit-file-parser@3.0.2` dist 源码审查（唯一外部依赖 `buffer@^6`，无 `fs`/`process`/Node 内置引用）；`web/js/charts.js` 为字符串拼 SVG 实现；`web/app.js` 现有导航为顶栏 6 tab + 三点菜单。
