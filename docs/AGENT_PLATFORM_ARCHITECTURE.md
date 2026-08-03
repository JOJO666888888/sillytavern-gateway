# Agent 平台化架构设计文档

> change-id: `design-agent-platform`
> 状态：文档先行（Task 0 / SubTask 0.1 + 0.4），为 Phase 1-5 落地提供依据
> 前置 spec：`evaluate-agent-integration`（已确认路径 C）、`create-agent-framework`（已落地 YAML Agent + 工具注册表 + 子代理调度）

---

## 目录

1. [设计目标与原则](#1-设计目标与原则)
2. [核心设计：表现层抽象（Presentation Surface）](#2-核心设计表现层抽象presentation-surface)
3. [三套界面适配器](#3-三套界面适配器)
4. [Workspace + Journal 能力](#4-workspace--journal-能力)
5. [整合数据流图](#5-整合数据流图)
6. [借鉴 TauriTavern 的 5 个设计模式](#6-借鉴-tauritavern-的-5-个设计模式)
7. [社区实践来源](#7-社区实践来源)
8. [目录结构设计](#8-目录结构设计)
9. [与现有系统的整合边界](#9-与现有系统的整合边界)
10. [关键功能实现建议](#10-关键功能实现建议)

---

## 1. 设计目标与原则

### 1.1 设计目标

本架构面向四类用户与四类痛点：

| 痛点 | 现状 | 目标 |
|------|------|------|
| 表现力单薄 | IM 侧只有纯文字 + `>选项X：` 按钮条 | 状态栏 / 立绘 / 时间线 / 实时进度 |
| 强绑单一界面 | Agent 能力只能在 IM 文字流跑 | 一套引擎驱动 IM / ST / Native 三界面 |
| 新手门槛高 | 用户要自己拼 YAML + 工具 + 记忆 | 开箱即用的默认方案 + 进阶模板 |
| 架构未对齐最佳实践 | 长线 RP 出现"幽灵事实"和状态漂移 | Workspace-as-Truth + Journal/Checkpoint 可审计可回滚 |

### 1.2 设计原则

1. **表现层抽象为核心**：Agent 引擎不再直接 `ctx.reply(text)`，而是产出结构化 `AgentRunResult`，由表现层适配器决定渲染。一套引擎驱动多界面，而非为每界面写一套逻辑。
2. **不产生破坏性变更**：IM 文字模式作为兜底保留，新能力以可选模块叠加。
3. **借鉴而非照搬**：借鉴 TauriTavern 的 Workspace/Journal 思想，落地到 JS 轻量版，不引入 Rust 依赖；不借鉴 Rust Clean Architecture 物理边界（网关是 JS，用模块约定 + 插件隔离即可）。
4. **领域工具替代裸 JSON Patch**：状态变更通过 `state.write` / `condition.apply` / `economy.spend` / `scene.finish` 等领域工具，工具入口校验，保证状态不漂移。
5. **开箱即用**：默认 Profile + 默认记忆模板 + 默认文风 + 默认界面绑定，`/rp start` 一条命令开玩。

---

## 2. 核心设计：表现层抽象（Presentation Surface）

### 2.1 问题：引擎与界面强耦合

当前 `agent-runner.run()` 的返回值是 `{ text, steps, subAgentResults, logs }`，调用方（`agent-framework/index.js` 的 `_executeAgent` 或 `agent-rp/index.js` 的 `onMessage`）拿到 `text` 后直接 `ctx.reply(text)`。这意味着：

- 引擎输出的是"一段文本"，而非"结构化产物"。
- 想在 IM 渲染状态图、想在 ST 复用前端、想在面板做时间线，都要各自从文本里再解析，逻辑重复且脆弱。
- 同一会话无法同时喂给多个界面（IM 跑着，浏览器也开着，两套各自调引擎，状态不一致）。

### 2.2 解决：结构化输出 + 表现层适配器

#### 2.2.1 AgentRunResult 结构化输出契约

Agent 引擎一次 run 完成后，产出 `AgentRunResult`（完整 JSON 契约见原型文档 `AGENT_PLATFORM_PROTOTYPE.md` §3）：

```
AgentRunResult
├── artifacts    产物（正文 / 大纲 / 草稿等，markdown 文本 + 类型标签）
├── options       玩家行动选项（标签 + 文本 + 回调标识）
├── state         本轮状态快照（visible 可见层 + private 私有层，按角色过滤）
├── events        本轮事件流（工具调用 / 子代理 / 状态变更，用于时间线）
└── meta          视角模式 / 当前文风 / 轮次 / 引用记忆
```

引擎不再决定"怎么显示"，只决定"产出了什么"。

#### 2.2.2 表现层适配器接口

适配器是一个实现下述接口的对象（签名见原型文档 §4）：

```
interface SurfaceAdapter {
  surfaceType: 'im' | 'st' | 'native' | string   // 支持的界面类型
  render(result: AgentRunResult, ctx: SurfaceCtx): Promise<void>  // 渲染一次完整结果
  onEvent?(event: AgentEvent, ctx: SurfaceCtx): Promise<void>     // 可选：流式/事件回调
}
```

- `render(result, ctx)` 消费一次完整的 `AgentRunResult`，按目标界面渲染。
- `onEvent(event, ctx)` 可选，用于流式输出阶段把 token / 工具调用事件实时推给前端（Native 适配器走 WebSocket，IM 适配器通常不走）。

#### 2.2.3 适配器注册与调度

- 插件在 `onLoad()` 中调用 `ctx.surface.register(adapter)` 注册适配器（需 `surface` 权限）。
- Agent 会话可绑定 **一个主适配器 + 多个旁路适配器**（如 IM 主界面 + 状态图旁路）。
- 表现层调度器（`server/agent/surface/dispatcher.js`，新建）负责：
  - 维护已注册适配器列表。
  - 会话级绑定（哪个会话用哪个主适配器 + 哪些旁路）。
  - 引擎产出 `AgentRunResult` 后，分发到主适配器 + 全部旁路适配器。
  - 流式阶段把 `AgentEvent` 推给声明了 `onEvent` 的适配器。

#### 2.2.4 同一引擎驱动多界面

当用户在 IM 启动 Agent RP，同时在浏览器打开 Agent 专用前端：

- 两套界面消费**同一** `AgentRunResult` 流。
- IM 适配器渲染为文字 + 选项 + 状态图。
- Native 适配器渲染为时间线 + 状态面板 + 正文卡片。
- 任一界面的用户输入都进入同一会话（同一 `platform:chatId` 或同一 `session_id`）。

---

## 3. 三套界面适配器

### 3.1 IM 界面增强适配器

**改造对象**：`plugins/agent-rp/index.js`（现有）→ IM 适配器（改造）。

现有 `agent-rp` 自己组装 prompt + 调 LLM + 解析 `>选项X：`。改造后：

- 不再自己组装 prompt + 调 LLM，改为调用 `ctx.agent.run(profile, input, session)` 触发引擎。
- 消费 `AgentRunResult`，渲染逻辑委托表现层：
  - **正文分段发送**：按段落切分 `artifacts[].content`，避免超长消息。
  - **选项交互按钮**：复用 `option-splitter`，把 `options[].label` 渲染为平台原生按钮 / 引用 / 菜单。
  - **实时状态图**：复用 `message-to-image`，把 `state.visible` 渲染为状态卡片图片，旁路发送。
  - **立绘 / 场景背景**：可选，按角色卡资源渲染。
- **群聊多 Bot 协同**：多个 bot 绑定不同 Agent Profile，共用 workspace（需 `workspace` 权限），分工扮演 NPC / GM / Critic。

IM 文字模式作为兜底保留：若适配器未注册或会话未绑定，回退到现有的"先正文后选项"纯文字流。

### 3.2 ST 兼容前端桥（HTTP 路由 shim）

> ⚠️ 已废弃（2026-08-03）：ST 兼容前端桥方案已移除实现，本节仅作历史设计记录保留。

**新建对象**：`server/compat/st-shim.js` + `server/index.js` 新增路由。

用户在浏览器打开本地 SillyTavern 前端，后端地址指向网关。网关提供同源 HTTP 路由 shim，模拟 ST 的 `/api/*` 契约：

| ST 路由 | 网关 shim 行为 |
|---------|---------------|
| `/api/characters` | 列出 / 读写 `assets/characters/`（复用 `card-loader.js`） |
| `/api/chats` | 读写会话历史（复用 `session-manager.js` + `chat-archive.js`） |
| `/api/presets` | 读写 `assets/presets/`（复用 `preset-engine.js`） |
| `/api/worldinfo` | 读写 `assets/worldbooks/`（复用 `worldbook-engine.js`） |
| `/api/generate` | Agent 模式下触发 `ctx.agent.run`，把 `AgentRunResult.artifacts` 作为生成结果回传 |

关键约束：

- **不引入 ST 源码**，用户自带前端；网关只做路由 shim + 资产读写。
- ST 前端的角色卡 / 世界书 / 预设编辑器直接读写网关 `assets/`。
- 用户获得 ST 成熟 UI（立绘 / 背景群 / macro / 正则 / QuickReply）+ Agent 引擎能力的叠加。
- 现有 `server/compat/astrbot-shim.js` 已是同类路由 shim 的先例，ST shim 参照其结构实现。

### 3.3 Agent 专用前端（面板内置 Web UI）

**改造对象**：`panel.html` + `server/index.js`（新增 WebSocket/SSE 端点）。

用户在网关面板打开 "Agent 剧场" 页面，内置 Web UI 提供：

- **实时正文流**：流式输出，不刷新页面（WebSocket/SSE 订阅）。
- **状态面板**：当前时间 / 地点 / 在场角色 / 各角色状态，按 `state.visible` 渲染。
- **时间线**：从 `events` 重建，显示工具调用 / 子代理审查 / 状态变更。
- **选项区**：点击即提交，无需输入。
- **Agent 配置侧栏**：Profile / 文风 / 视角 / 工具白名单，可边玩边改，热重载。

关键约束：

- 前端通过 **WebSocket / SSE 订阅** `AgentRunResult` 流，不走轮询。
- 支持"边玩边改"：修改 YAML Profile 后自动热重载，当前会话不中断。

---

## 4. Workspace + Journal 能力

借鉴 TauriTavern 的 Workspace-as-Truth 与 Journal/Checkpoint，落地到 JS 引擎，解决长期 RP 的"幽灵事实"和状态漂移。

### 4.1 可审计可回滚的 Workspace

**新建对象**：`plugins/agent-framework/runs/`（run 级 workspace 目录）+ `agent-runner.js` 改造。

Agent run 执行工具调用（`state.write` / `file.write` / `narrative.generate`）时：

1. **所有变更先写入 run 级 workspace**：`data/plugins/agent-framework/runs/<run-id>/`。
2. **每次 workspace 变更追加事件到 `events.jsonl`**（append-only journal）。
3. **关键节点自动创建 checkpoint**：workspace 初始化 / 草稿生成 / commit 前。
4. **run 成功 commit 后产物 promote 到会话级稳定层**；失败 / 取消不污染后续 run。
5. **用户可在时间线查看完整工具调用链**，定位"模型以为发生了但状态没有"的幽灵事实。

### 4.2 run 级 workspace 目录结构

```
data/plugins/agent-framework/runs/<run-id>/
├── workspace/             # 本 run 的工作区（草稿、状态快照、临时文件）
│   ├── state.snapshot.json
│   ├── draft.md
│   └── ...
├── events.jsonl           # append-only 事件日志
├── checkpoints/           # 关键节点快照
│   ├── 00-init.json
│   ├── 01-after-draft.json
│   └── 02-pre-commit.json
└── result.json            # commit 后的 AgentRunResult（成功才写）
```

会话级稳定层：`data/plugins/agent-framework/sessions/<session-key>/`（现有 `states/` 升级），只有 commit 成功的产物才 promote 到这里。

### 4.3 状态优先 + 领域工具

Agent 改变状态时，通过领域工具而非裸 JSON Patch：

- `state.write` / `condition.apply` / `economy.spend` / `scene.finish` 等领域工具。
- 工具入口校验：钱包 id 错误打回、不存在的 actor 不能受伤、未结束的 scene beat 不能推进场景。
- 工具报错具体可读（列出可用钱包 / 当前场景目标），Agent loop 可自我纠正。
- 工具错误分级（参考 TauriTavern）：`Recoverable` / `PolicyDenied` / `SystemFailure`，见 §10.1。

---

## 5. 整合数据流图

```
用户输入 (IM/ST前端/Native前端)
  -> 表现层适配器 (统一入口)
       │  - IM: agent-rp 适配器拦截消息
       │  - ST: /api/generate 路由 shim
       │  - Native: WebSocket/SSE 接收前端输入
  -> ctx.agent.run(profile, input, session)
  -> agent-runner:
       ├── context-builder 组装 prompt (ST资产 + 记忆 + 文风)
       │     - context-builder.js: systemPrompt + injectAssets + injectFiles + history
       ├── ctx.llm.runTools (工具循环)
       │     ├── state.write      -> workspace 校验 + journal 追加
       │     ├── narrative.generate -> 草稿入 workspace
       │     ├── subagent.dispatch  -> 独立上下文 Critic (subagent-dispatcher.js)
       │     └── 其他领域工具       -> validate 钩子校验
       ├── checkpoint (关键节点快照)
       └── commit -> AgentRunResult (artifacts/options/state/events/meta)
  -> 表现层调度器分发:
       ├── IM 适配器:    文字 + 选项 + 状态图 (message-to-image)
       ├── ST 适配器:    /api/generate 返回 artifacts
       └── Native 适配器: WebSocket 推送 AgentRunResult
```

关键点：

- **统一入口**：无论输入来自 IM / ST / Native，都经表现层适配器进入 `ctx.agent.run`，引擎不感知界面。
- **工具循环内写入 workspace**：`state.write` 等工具的副作用不直接落盘到稳定层，而是先入 run 级 workspace + `events.jsonl`。
- **commit 才 promote**：只有 run 成功 commit，产物才从 workspace 提升到会话级稳定层；失败 / 取消不污染。
- **多界面同时消费**：`AgentRunResult` 由表现层调度器分发给所有绑定的适配器。

---

## 6. 借鉴 TauriTavern 的 5 个设计模式

| 模式 | TauriTavern 实现 | 网关落地方式 |
|------|------------------|--------------|
| **Workspace-as-Truth** | Agent 编辑 workspace，commit artifact | run 级 workspace + commit promote，JS 实现（`plugins/agent-framework/runs/`） |
| **Journal + Checkpoint** | append-only `events.jsonl` + snapshot | `events.jsonl` + checkpoint 目录，JS 实现（`runs/<run-id>/events.jsonl` + `checkpoints/`） |
| **Canonical IR + Provider** | `AgentModelRequest` 统一语义 | 复用现有 `server/runtime/llm-client.js` 多 provider，无需新建统一 IR |
| **Delegation + Handoff** | 同 run 内 `AgentInvocation` | 复用现有 `engine/subagent-dispatcher.js`，补充 handoff 语义（见 §10.2） |
| **Host Bridge 兼容** | 前端 fetch 拦截 + 路由 shim | 网关 HTTP `/api/*` 路由 shim（`server/compat/st-shim.js`），ST 前端直连（已废弃） |

### 6.1 不借鉴的部分

- **Rust Clean Architecture 物理边界**：网关是 JS，用模块约定 + 插件隔离即可，不引入 Rust 依赖。
- **复用 ST PromptManager headless broker**：网关已有 `server/runtime/preset-engine.js`，简化版即可。
- **完整 Plan Mode runtime**：schema 已就绪（现有 `agent/pipeline.js`），runtime 延后。

---

## 7. 社区实践来源

本架构的开箱即用方案与进阶模板直接对应社区实践文档：

| 社区实践来源 | 对应能力 | 落地位置 |
|-------------|---------|---------|
| **`agent-其二.md`**：多 Agent GM + Critic | 多 Critic 审查流水线（大纲→草稿→审查→成品四阶段） | `templates/multi-critic.yaml`（已存在，Task 6.7 增强） |
| **`agent-其三.md`**：独立角色认知隔离 | 每个角色挂独立子代理 + 独立记忆 namespace，实现认知隔离 | `templates/director-mode.yaml`（已存在）+ Task 6.8 独立角色模式 |
| **`agent-其四.md`**：状态优先领域工具 | 状态引擎 + 后台导演组子代理，状态变更通过领域工具而非裸 JSON Patch | `templates/state-engine.yaml`（Task 6.7 新增）+ §10.4 状态优先循环 |
| **`agent相关.md`**：渐进式 Skill + 四层记忆 | 渐进式加载 + 四层记忆（project / reference / feedback / user）+ 叙事驱动 | 默认记忆模板（Task 6.2）+ 现有 `memory-engine.js` |

### 7.1 假设

- 用户主要用 DeepSeek V4 等国产推理模型（参考 `agent-其三.md` 模型选择章节）。
- IM 平台原生支持图片消息（用于状态图渲染）。

---

## 8. 目录结构设计

### 8.1 新增目录与文件清单

```
sillytavern-gateway/
├── server/
│   ├── agent/
│   │   ├── context-builder.js        # 已有
│   │   ├── pipeline.js               # 已有
│   │   └── surface/                  # 【新增】表现层抽象
│   │       ├── dispatcher.js         #   表现层调度器（主适配器 + 旁路适配器）
│   │       ├── adapter-interface.js  #   SurfaceAdapter 接口定义与校验
│   │       └── surface-ctx.js        #   SurfaceCtx 构造（按适配器收窄的能力视图）
│   └── compat/
│       ├── astrbot-shim.js           # 已有
│       ├── index.js                  # 已有
│       └── st-shim.js                # 【新增】ST 兼容前端桥（/api/* 路由 shim）【已废弃】
│
├── plugins/
│   ├── agent-framework/
│   │   ├── engine/
│   │   │   ├── agent-runner.js       # 改造：产出 AgentRunResult + workspace/journal
│   │   │   ├── tool-registry.js      # 改造：领域工具校验钩子 + 错误分级
│   │   │   ├── state-manager.js      # 已有
│   │   │   ├── subagent-dispatcher.js # 改造：补充 handoff 语义
│   │   │   ├── memory-engine.js      # 已有
│   │   │   ├── workspace-manager.js  # 【新增】run 级 workspace 读写 + checkpoint
│   │   │   └── journal.js            # 【新增】events.jsonl append + 重建时间线
│   │   ├── tools/
│   │   │   ├── state-tools.js        # 改造：写入走 workspace + validate
│   │   │   ├── narrative-tools.js    # 改造：草稿入 workspace
│   │   │   └── ...                   # 其他已有
│   │   ├── runs/                     # 【新增】run 级 workspace 运行时数据
│   │   │   └── <run-id>/             #   （运行时生成，见 §4.2）
│   │   ├── templates/
│   │   │   ├── simple-rp.yaml        # 已有
│   │   │   ├── multi-critic.yaml     # 已有（Task 6.7 增强）
│   │   │   ├── director-mode.yaml   # 已有
│   │   │   ├── state-engine.yaml    # 【新增】状态引擎模板（Task 6.7）
│   │   │   └── default-rp.yaml      # 【新增】默认方案（Task 6.1）
│   │   └── index.js                  # 改造：注册 surface 适配器绑定
│   │
│   └── agent-rp/
│       └── index.js                  # 改造为 IM 界面适配器
│
├── panel.html                        # 改造：新增 "Agent 剧场" 页面
├── style.css                        # 改造：Agent 剧场样式
└── docs/
    ├── AGENT_PLATFORM_ARCHITECTURE.md  # 本文
    ├── AGENT_PLATFORM_WHITEPAPER.md    # 白皮书
    └── AGENT_PLATFORM_PROTOTYPE.md    # 原型设计
```

### 8.2 运行时数据目录

```
data/plugins/agent-framework/
├── agents/                # YAML Agent 定义（已有）
├── skills/                # Skill 文件（已有）
├── styles/                # 文风文件（已有）
├── memory/                # 四层记忆（已有）
│   ├── project.md
│   ├── reference.md
│   ├── feedback.md
│   └── user.md
├── states/                # 会话状态（已有，StateManager）
├── sessions/              # 【升级】会话级稳定层（commit promote 目标）
│   └── <session-key>/
│       └── state.json
└── runs/                  # 【新增】run 级 workspace
    └── <run-id>/
        ├── workspace/
        ├── events.jsonl
        ├── checkpoints/
        └── result.json
```

---

## 9. 与现有系统的整合边界

### 9.1 改造（MODIFIED）

| 现有模块 | 改造内容 |
|---------|---------|
| `plugins/agent-framework/engine/agent-runner.js` | 产出 `AgentRunResult` 替代 `{ text, steps }`；接入 workspace/journal；commit/promote |
| `plugins/agent-framework/engine/tool-registry.js` | 工具可声明 `validate` 函数；错误分级 `Recoverable`/`PolicyDenied`/`SystemFailure` |
| `plugins/agent-framework/engine/subagent-dispatcher.js` | 补充 handoff 语义（`AgentHandoff` 标识主控权移交） |
| `plugins/agent-framework/index.js` | 注册 surface 适配器绑定；`_agentService.run` 暴露 |
| `plugins/agent-rp/index.js` | 改造为 IM 适配器，调 `ctx.agent.run` + 消费 `AgentRunResult` |
| `server/plugin-context.js` | 新增 `ctx.surface`（受 `surface` 权限约束） |
| `server/plugin-permissions.js` | 新增 `surface` / `workspace` 权限 |
| `server/index.js` | 新增 ST 兼容路由 shim + WebSocket/SSE 端点 |
| `panel.html` / `style.css` | 新增 "Agent 剧场" 页面 |

### 9.2 新增（ADDED）

| 新增模块 | 职责 |
|---------|------|
| `server/agent/surface/dispatcher.js` | 表现层调度器 |
| `server/agent/surface/adapter-interface.js` | `SurfaceAdapter` 接口定义 |
| `server/agent/surface/surface-ctx.js` | `SurfaceCtx` 构造 |
| `server/compat/st-shim.js` | ST 兼容前端桥（已废弃，实现已移除） |
| `plugins/agent-framework/engine/workspace-manager.js` | run 级 workspace + checkpoint |
| `plugins/agent-framework/engine/journal.js` | events.jsonl + 时间线重建 |
| `plugins/agent-framework/templates/default-rp.yaml` | 默认方案 |
| `plugins/agent-framework/templates/state-engine.yaml` | 状态引擎模板 |

### 9.3 不破坏

- IM 文字模式作为兜底保留：若适配器未注册或会话未绑定，回退到现有 `agent-rp` 的"先正文后选项"纯文字流。
- 现有 `ctx.agent.registerTool` / `dispatch` / `registerAgent` API 不变，新增 `ctx.agent.run`。
- 现有 `StateManager` 不替换，workspace 在其之上叠加 run 级隔离层。

---

## 10. 关键功能实现建议

本节为 SubTask 0.4 交付内容，覆盖四个关键功能的实现思路（仅设计，不含实现代码）。

### 10.1 领域工具校验实现思路

**目标**：工具可声明 `validate` 函数，状态变更前校验；错误分级 `Recoverable` / `PolicyDenied` / `SystemFailure`。

#### 10.1.1 扩展 ToolRegistry 工具声明

现有 `tool-registry.js` 的 `register(tool)` 接受 `{ name, description, parameters, handler, source }`。扩展为：

```
register(tool) 接受字段:
  - name, description, parameters, handler, source   # 已有
  - validate?: (args, context) => ValidationResult    # 【新增】校验钩子
  - errorLevel?: 'Recoverable' | 'PolicyDenied' | 'SystemFailure'  # 【新增】错误分级
```

`ValidationResult` 形如：
```
{ ok: true }                                    // 通过
{ ok: false, level: 'Recoverable', message, hint }  // 可恢复（Agent 可重试）
{ ok: false, level: 'PolicyDenied', message }       // 策略拒绝（Agent 不应再试）
{ ok: false, level: 'SystemFailure', message }      // 系统故障（引擎层兜底）
```

#### 10.1.2 执行器改造

现有 `createExecutor(context)` 返回 `async (name, args) => { ... }`。改造为：

1. 调用 `tool.validate(args, context)`（若声明了）。
2. 校验失败：按 `errorLevel` 决定行为：
   - `Recoverable`：返回结构化错误字符串（含可用项列表 / 当前场景目标），Agent loop 可继续（不中止 run）。
   - `PolicyDenied`：返回错误，Agent loop 应停止当前方向（但 run 不崩）。
   - `SystemFailure`：抛异常，agent-runner 捕获并标记 run 失败。
3. 校验通过：调用 `tool.handler(args, context)`，副作用写入 workspace（见 §10.4）。

#### 10.1.3 报错具体可读示例

- `economy.spend({ wallet: 'alice' })` 但不存在该钱包：返回 `Recoverable`，message 列出可用钱包 `['bob', 'shop']`。
- `scene.finish({ beatId: 'b3' })` 但当前 beat 未结束：返回 `Recoverable`，message 说明当前场景目标。
- `state.write({ key: 'health', value: -10 })` 违反不变量：返回 `PolicyDenied`。

#### 10.1.4 与 workspace 的协作

校验读取的是 **workspace 内的当前状态快照**（run 级），而非会话级稳定层。这样失败 run 的校验副作用不会污染稳定层。

### 10.2 handoff 语义实现思路

**目标**：补充 handoff 语义，让子代理调度支持"主控权移交"（Delegation + Handoff 模式）。

#### 10.2.1 现状

现有 `subagent-dispatcher.js` 的 `dispatch(agentName, task, session, ctx, options)` 返回 `{ text, steps, agent }`，是"委托"（delegation）语义：主代理委托子代理做事，结果回主代理。没有"移交"（handoff）语义：主代理把控制权完全交给子代理，后续轮次由子代理主导。

#### 10.2.2 扩展 AgentHandoff 标识

在 `dispatch` 的 `options` 中新增 `handoff: boolean`：

- `handoff: false`（默认，现有行为）：委托。子代理结果回主代理，主代理继续。
- `handoff: true`：移交。子代理结果成为本轮的"主控产物"，主代理本轮不再追加生成；后续轮次可由子代理继续主导（通过 session 绑定）。

#### 10.2.3 落地路径

1. `subagent-dispatcher.dispatch` 接收 `options.handoff`。
2. 若 `handoff: true`：
   - 子代理产出的 `AgentRunResult`（改造后子代理也产出结构化结果）直接作为本轮 run 的候选结果。
   - 在 `events.jsonl` 追加 `AgentHandoff` 事件，记录 `from: 主代理, to: 子代理, reason`。
   - 在 session 中记录 `currentController: 子代理名`，下一轮由该子代理优先接管（或主代理重新接管，取决于 Profile 配置）。
3. 若 `handoff: false`：现有行为不变，子代理结果作为主代理的输入素材。

#### 10.2.4 与独立角色 namespace 的协作

独立角色模式下（§10.3），每个角色子代理有自己的 namespace。handoff 到角色子代理后，后续轮次的角色行为由该子代理在其 namespace 内生成，实现认知隔离。

### 10.3 独立角色 namespace 实现思路

**目标**：每个角色可挂独立子代理 + 独立记忆 namespace，实现认知隔离（源自 `agent-其三.md`）。

#### 10.3.1 认知隔离的含义

"认知隔离"指：角色 A 不知道角色 B 的内心独白 / 私有状态 / 记忆，只能观察到外部可见行为。当前 `StateManager` 是按 `platform:chatId` 隔离的单一状态对象，所有角色共享，无法实现隔离。

#### 10.3.2 namespace 方案

1. **记忆 namespace**：`MemoryEngine` 按 `namespace` 隔离。现有 `memory/` 目录下 `project.md` 等是全局的；改造为 `memory/<namespace>/project.md`。
   - 全局 GM namespace：`memory/gm/`
   - 角色 Alice namespace：`memory/alice/`
   - 角色 Bob namespace：`memory/bob/`
2. **状态 namespace**：`StateManager` 的 `read/write` 增加 `namespace` 参数。`state.visible` 是所有 namespace 共享的可见层；`state.private.<namespace>` 是各角色私有层。
   - `state.visible`：所有角色可见（时间、地点、在场角色、公开行为）。
   - `state.private.alice`：仅 Alice 子代理可读写（Alice 的内心、计划、私有记忆）。
   - `state.private.bob`：仅 Bob 子代理可读写。
3. **角色子代理绑定**：Profile 中声明 `characters[].agent` 和 `characters[].namespace`，handoff 时按此绑定。

#### 10.3.3 过滤规则

`AgentRunResult.state` 按角色过滤：

- 主代理（GM）拿到全量（visible + 所有 private）。
- 角色 Alice 子代理只拿到 `visible + private.alice`，不拿到 `private.bob`。
- 表现层适配器渲染时只用 `state.visible`（不渲染任何 private）。

#### 10.3.4 落地步骤

1. `MemoryEngine` 构造接受 `namespace`，所有 `read/update` 路径加上 namespace 前缀。
2. `StateManager.read/write` 签名扩展：`read(platform, chatId, key, namespace)`。
3. `subagent-dispatcher.dispatch` 在 `options.namespace` 指定时，为子代理构造的 `context` 注入对应 namespace 的 MemoryEngine 和 StateManager 视图（按 namespace 收窄）。
4. `AgentRunResult.state` 输出时，引擎按当前 run 的 controller 决定输出哪些 private 层。

### 10.4 状态优先循环实现思路

**目标**：状态优先 + 领域工具，先改变状态再根据状态叙事（源自 `agent-其四.md`）。

#### 10.4.1 状态优先 vs 叙事优先

- **叙事优先**（现有 `simple-rp`）：LLM 先生成叙事文本，状态是叙事的副产品（甚至不维护状态）。
- **状态优先**（`agent-其四.md`）：LLM 先通过领域工具改变状态，再根据状态变化生成叙事。叙事是状态的投影，状态是真相。

状态优先的好处：状态可校验、可审计、可回滚；叙事与状态一致，不出现"叙事里说受伤了但状态没扣血"的幽灵事实。

#### 10.4.2 循环结构

`agent-runner.run` 的工具循环（`ctx.llm.runTools`）内，引导 LLM 按以下顺序调用工具：

1. `state.read` / `state.list`：读取当前状态（visible + 当前 controller 的 private）。
2. `memory.recall`：检索相关记忆。
3. **状态变更工具**（`state.write` / `condition.apply` / `economy.spend` / `scene.finish`）：先改变状态。每次调用经 `validate` 校验 + 写入 workspace + 追加 `events.jsonl`。
4. `narrative.generate`：根据状态变化生成叙事正文（草稿入 workspace）。
5. （可选）`subagent.dispatch`：Critic 审查草稿，审查结果回主代理。
6. 主代理产出最终 `artifacts` + `options`，commit。

#### 10.4.3 引导手段

LLM 不会自动按此顺序，需要引导：

1. **systemPrompt 约束**：`state-engine.yaml` 的 systemPrompt 明确写"先调 state.write 改变状态，再调 narrative.generate 根据状态生成正文"。
2. **工具描述引导**：`state.write` 的 description 注明"状态优先：先调用本工具改变状态，再调用 narrative.generate"。
3. **工具返回值引导**：`state.write` 返回 `{ success, key, currentState }`，把变更后的状态回显给 LLM，提示它基于此生成叙事。
4. **validate 约束**：`narrative.generate` 的 `validate` 可检查"本轮是否已调用过状态变更工具"，若未变更则返回 `Recoverable` 提示"请先通过 state.write 改变状态"。

#### 10.4.4 与 workspace / journal 的协作

- 状态变更工具的副作用写入 `runs/<run-id>/workspace/state.snapshot.json`。
- 每次变更追加事件到 `events.jsonl`：`{ type: 'state_change', tool, args, before, after, ts }`。
- commit 时把 `workspace/state.snapshot.json` promote 到会话级 `sessions/<session-key>/state.json`。
- 失败 run 的 workspace 不 promote，稳定层不受污染。
- 时间线 UI 从 `events.jsonl` 重建，显示完整状态变更链，定位幽灵事实。

#### 10.4.5 后台导演组子代理

源自 `agent-其四.md`：玩家休息时世界仍运转。落地方式：

- `director-mode.yaml` 的 `subAgents` 声明 `parallel-line` 和 `timeline-showrunner`（已有），`trigger: manual`。
- 通过定时任务（`server/scheduler-service.js`）周期性 `subagent.dispatch` 这些子代理，生成暗线事件写入 workspace + journal。
- 这些事件在下一轮用户输入时被主代理读取（通过 `events.jsonl` 重建或 `memory.recall`）。

---

> 本文档为 Task 0 交付物，配合 `AGENT_PLATFORM_WHITEPAPER.md`（问题背景与路线）与 `AGENT_PLATFORM_PROTOTYPE.md`（线框图与数据契约）共同构成 Phase 0 文档先行依据。Phase 1-5 落地以此为准。
