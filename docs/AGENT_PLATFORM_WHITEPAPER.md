# Agent 平台化技术方案白皮书

> change-id: `design-agent-platform`
> 状态：文档先行（Task 0 / SubTask 0.2）
> 配套：架构设计见 `AGENT_PLATFORM_ARCHITECTURE.md`，原型设计见 `AGENT_PLATFORM_PROTOTYPE.md`

---

## 目录

1. [问题背景](#1-问题背景)
2. [三条路径对比](#2-三条路径对比)
3. [推荐方案](#3-推荐方案)
4. [分阶段路线](#4-分阶段路线)
5. [性能策略](#5-性能策略)
6. [安全策略](#6-安全策略)
7. [终端优势发挥](#7-终端优势发挥)

---

## 1. 问题背景

### 1.1 聊天平台 Agent 体验不佳的根因

当前网关已有 `agent-framework`（YAML Agent 定义、工具注册表、子代理调度）与 `agent-rp`（IM 平台 `/rp start` 文字 + 选项按钮）两套能力，但用户在聊天平台上使用 Agent 角色扮演的体验明显不佳。根因有四：

#### 根因一：表现力单薄

IM 侧只有纯文字 + `>选项X：` 按钮条。社区实践（`agent-其二.md` 的多 Critic 审查、`agent-其四.md` 的状态引擎）展示了极深的工作流，但其价值在 IM 文字流里**完全无法呈现**——没有状态栏 / 立绘 / 时间线 / 实时进度，复杂 Agent 工作流被压扁成"一段文字 + 几个按钮"，用户感知不到 Agent 在做什么。

#### 根因二：强绑单一界面

Agent 能力只能在 IM 文字流里跑。SillyTavern 有成熟的前端（立绘 / 背景群 / macro / 正则 / QuickReply），但 Agent 引擎与 ST 前端无桥接；网关也没有 Agent 专用前端。结果是：**要么放弃 IM 的多平台常驻优势用 ST，要么在 IM 里忍受单薄的文字流**，二者不可兼得。

#### 根因三：新手门槛高

社区实践展示了极强的玩法，但网关缺少"开箱即用的一整套初始 Agent 方案"。用户要自己拼 YAML Profile + 工具白名单 + 记忆结构 + 文风 Skill + 表现模板，门槛极高。能复现社区玩法的用户凤毛麟角，多数用户卡在"第一步怎么写 YAML"。

#### 根因四：架构未对齐社区最佳实践

TauriTavern 已验证"Workspace-as-Truth + Journal/Checkpoint + Profile + Delegation/Handoff"这套成熟架构，当前网关 agent-framework **缺少**可审计可回滚的 Workspace、事件流和产物组装。长线 RP 会出现两类典型问题：

- **幽灵事实**：模型在叙事里"以为发生了"某事，但状态里没有记录。下一轮模型读到状态没有该事实，叙事前后矛盾。
- **状态漂移**：失败 / 取消的 run 把半成品状态污染了稳定层，后续 run 基于错误状态继续，越跑越偏。

### 1.2 根因的本质

四个根因的本质是**架构层面缺少一个抽象层**：Agent 引擎的输出与渲染界面强耦合，导致"一套引擎"无法驱动"多种界面"，也无法引入 Workspace/Journal 这种需要结构化输出的成熟实践。

---

## 2. 三条路径对比

针对上述根因，评估了三条落地路径：

### 路径 A：网关内置完整 Agent Runtime

**方案**：在网关内重写一套完整的 Agent Runtime（含 Plan Mode、完整 PromptManager headless broker、Rust 风格 Clean Architecture 物理边界），对标 TauriTavern 全量能力。

| 维度 | 评价 |
|------|------|
| 能力覆盖 | 最高，可全量对齐 TauriTavern |
| 工程量 | 极大，相当于重写引擎 |
| 风险 | 过度工程，偏离网关"JS 轻量"定位 |
| 决策 | **否决**：过度工程 |

否决理由：网关已有 `agent-framework`（YAML 定义 + 工具注册表 + 子代理调度 + 记忆引擎 + 状态管理器），基础已就绪。重写一套是浪费。且网关是 JS，引入 Rust Clean Architecture 物理边界不现实（插件同进程，用模块约定 + 插件隔离即可）。

### 路径 B：网关作为 Pi/CC Harness 桥接层

**方案**：网关作为 Pi（Claude Code 等 CLI Agent）或 CC（Claude Code）的 Harness 桥接层，把 Agent RP 转译为 Pi/CC 的任务，复用其成熟 Runtime。

| 维度 | 评价 |
|------|------|
| 能力覆盖 | 高，复用成熟 Runtime |
| 工程量 | 中，需写转译层 + 进程管理 |
| 风险 | 强依赖外部工具，部署门槛升高；RP 场景与 Pi 的通用任务场景不完全契合 |
| 决策 | **作为高级选项保留**，不作为主路径 |

保留理由：对资深用户，Pi/CC 的 Plan Mode 和工具生态确实强大，可作为高级选项支持。但作为主路径，会让普通用户承担"装 Pi/CC + 配置网关桥接"的双重门槛，且 RP 场景的领域工具（`state.write` / `scene.finish`）与 Pi 的通用工具不匹配。主路径应让网关自身能力足够强。

### 路径 C：插件化 Agent RP（推荐）

**方案**：在现有 `agent-framework` 插件基础上，叠加**表现层抽象 + Workspace/Journal + 三界面适配器 + 开箱即用方案**，把 Agent RP 做强。

| 维度 | 评价 |
|------|------|
| 能力覆盖 | 高，覆盖四类痛点 |
| 工程量 | 中，复用现有引擎，新增抽象层与适配器 |
| 风险 | 低，已有基础，渐进式叠加，不破坏现有 |
| 决策 | **推荐** |

推荐理由：

1. **已有基础**：`agent-framework` 的 YAML 定义、工具注册表、子代理调度、四层记忆、状态管理器已落地，不需重写。
2. **渐进式**：表现层抽象是叠加层，IM 文字模式作为兜底保留，新能力以可选模块叠加，不产生破坏性变更。
3. **对齐社区**：借鉴 TauriTavern 的 5 个设计模式（Workspace-as-Truth / Journal+Checkpoint / Canonical IR+Provider / Delegation+Handoff / Host Bridge 兼容），但落地到 JS 轻量版，够用即可。
4. **新手友好**：开箱即用的默认方案让 `/rp start` 一条命令开玩，进阶模板对应社区实践。

---

## 3. 推荐方案

### 3.1 核心思路：表现层抽象为核心

推荐方案（路径 C）的核心是**表现层抽象（Presentation Surface）**：

- Agent 引擎不再直接 `ctx.reply(text)`，而是产出**结构化输出** `AgentRunResult`（artifacts / options / state / events / meta）。
- 由**表现层适配器**决定如何渲染：IM 适配器渲染为文字 + 选项 + 状态图；ST 适配器走 `/api/generate` 回传 artifacts；Native 适配器走 WebSocket 推送时间线 + 状态面板 + 正文卡片。
- **一套引擎驱动三界面**，而非为每界面写一套 Agent 逻辑。

### 3.2 方案组成

| 组成 | 说明 |
|------|------|
| 表现层抽象 | `AgentRunResult` 契约 + `SurfaceAdapter` 接口 + 表现层调度器 |
| 三套界面适配器 | IM 增强 / ST 兼容前端桥 / Agent 专用前端 |
| Workspace + Journal | run 级 workspace + `events.jsonl` + checkpoint + commit/promote |
| 开箱即用方案 | 默认 Profile + 默认记忆模板 + 默认文风 + 默认界面绑定 |
| 领域工具校验 | 工具声明 `validate` + 错误分级 `Recoverable`/`PolicyDenied`/`SystemFailure` |

### 3.3 三界面分工

```
                    ┌─────────────────────────────────────┐
                    │       Agent 引擎 (agent-runner)      │
                    │   产出 AgentRunResult (结构化输出)    │
                    └─────────────────┬───────────────────┘
                                      │
                         表现层调度器分发
                      ┌───────────────┼───────────────┐
                      │               │               │
                ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
                │ IM 适配器 │   │ ST 适配器 │   │Native 适配│
                │ 文字+选项 │   │/api/generate│  │ WebSocket │
                │ +状态图   │   │ 回传 artifacts │  │ 时间线+面板│
                └───────────┘   └───────────┘   └───────────┘
```

- **IM 适配器**：复用 `option-splitter`（选项按钮）、`message-to-image`（状态图），改造现有 `agent-rp`。文字模式兜底。
- **ST 适配器（已废弃）**：HTTP 路由 shim（`/api/*`），用户自带 ST 前端直连网关，复用 ST 成熟 UI。零源码侵入。
- **Native 适配器**：`panel.html` 新增 "Agent 剧场"，WebSocket/SSE 订阅，实时 / 自适应 / 可边玩边改。

---

## 4. 分阶段路线

> 交付以"文档先行 + 原型落地"并行推进。Phase 0 产出文档交付物，Phase 1-7 落地能力。

### Phase 0：文档先行（Task 0）

| 子任务 | 交付物 |
|--------|--------|
| SubTask 0.1 | `docs/AGENT_PLATFORM_ARCHITECTURE.md`（架构设计） |
| SubTask 0.2 | `docs/AGENT_PLATFORM_WHITEPAPER.md`（本文，白皮书） |
| SubTask 0.3 | `docs/AGENT_PLATFORM_PROTOTYPE.md`（原型设计） |
| SubTask 0.4 | 架构文档末尾"关键功能实现建议" |

无硬前置，可与 Phase 1 并行，为落地提供依据。

### Phase 1：表现层抽象（Task 1）

落地表现层抽象这一基础。后续 Phase 2-5 的界面与 Workspace 都消费 `AgentRunResult`。

- 定义 `AgentRunResult` 数据契约（artifacts/options/state/events/meta）。
- `plugin-context.js` 新增 `ctx.surface.register(adapter)` + `surface` 权限。
- 实现表现层调度器（主适配器 + 旁路适配器）。
- `agent-runner.js` 改造：产出 `AgentRunResult` 替代直接文本。
- 单元测试（契约 + 适配器分发）。

### Phase 2-5：三界面 + Workspace（Task 2-5）

| Phase | 任务 | 依赖 |
|-------|------|------|
| Phase 2 | IM 界面增强适配器（正文分段 / 选项 / 状态图 / 群聊多 Bot） | Task 1 |
| Phase 3 | ST 兼容前端桥（`/api/*` 路由 shim + 资产读写 + Agent generate）（已废弃） | Task 1 |
| Phase 4 | Agent 专用前端（Agent 剧场 + WebSocket/SSE + 时间线 + 边玩边改） | Task 1 |
| Phase 5 | Workspace + Journal（run 级 workspace + events.jsonl + checkpoint + commit/promote + 领域工具校验） | Task 1 |

### Phase 6：默认方案（Task 6）

开箱即用的初始 Agent 方案，依赖 Phase 1 + Phase 5（默认方案用表现层 + Workspace）。

- `templates/default-rp.yaml`（默认 GM + 可选 Critic，视角可切）。
- 默认记忆模板（四层 memory 初始文件 + 自动摘要规则）。
- 默认文风 Skill（去八股写作）。
- 默认界面绑定（IM 用增强适配器，面板用 Native 适配器）。
- `/rp start` 一条命令开玩。
- 配置面板"从默认方案创建副本"按钮。
- 进阶模板补全（multi-critic / director-mode / state-engine）。
- 独立角色模式（每角色独立子代理 + 独立记忆 namespace，认知隔离）。

### Phase 7：整合验证与性能优化（Task 7）

最后整合，依赖 Phase 2-6 全部完成。

- 三界面端到端联调（同一会话，IM + ST + Native 同时消费）。
- 性能优化（流式输出 / 事件推送 / workspace 写入批处理）。
- 权限控制验证（surface / workspace / agent 权限隔离）。
- 与现有插件协同验证（option-splitter / message-to-image / group-rp-bidding / rp-memory）。
- 文档更新（README + AGENT_FRAMEWORK_GUIDE 接入新章节）。

---

## 5. 性能策略

### 5.1 流式输出

- **IM 适配器**：IM 平台不支持流式显示，收集完整 `AgentRunResult` 后一次性渲染（正文分段发送）。现有 `agent-rp` 已是此模式。
- **Native 适配器**：实时流式输出。引擎在工具循环 / 正文生成阶段，通过 `onEvent(event)` 把 token 增量推给 Native 适配器，前端不刷新页面增量渲染。
- **ST 适配器**：`/api/generate` 是请求-响应模式，非流式；但 ST 前端自身支持流式显示，可在 shim 层把引擎的流式 token 透传给 ST 前端（SSE chunked response）。（已废弃）

### 5.2 事件推送（非轮询）

- **Native 适配器**：前端通过 **WebSocket / SSE 订阅** `AgentRunResult` 流与 `AgentEvent` 流，**不走轮询**。引擎产出事件后主动推，前端被动接收，延迟为毫秒级。
- **事件类型**：`tool_call`（工具调用）、`state_change`（状态变更）、`subagent_dispatch`（子代理调度）、`token_delta`（token 增量）、`run_complete`（run 完成）。
- **降级**：若 WebSocket 不可用，降级为 SSE（HTTP 长连接），仍非轮询。

### 5.3 workspace 写入批处理

- **问题**：工具循环内每次 `state.write` 都同步写盘（`workspace/state.snapshot.json` + 追加 `events.jsonl`），高频工具调用会拖慢 run。
- **策略**：
  - `events.jsonl`：append-only，单次 append 开销小，保持同步写（保证 journal 完整性）。
  - `workspace/state.snapshot.json`：内存缓存 + 批量刷盘。工具循环内只更新内存快照，在 checkpoint 节点 / commit 时统一刷盘。
  - checkpoint 创建时机受控（workspace 初始化 / 草稿生成 / commit 前），不在每次工具调用时创建。

### 5.4 工具调用原生 function calling

- 引擎走 `ctx.llm.runTools`（原生 function calling），非 prompt 注入式工具调用。现有 `agent-runner.js` 已用此模式。
- 原生 function calling 在推理模型侧并行解码工具调用，延迟低于"让模型输出工具名再解析"。

### 5.5 性能基线（目标）

| 指标 | 目标 | 说明 |
|------|------|------|
| 首字延迟 | < 2s | 从用户输入到 Native 适配器收到首个 `token_delta` |
| 工具调用开销 | < 50ms/次 | 单次 `state.write` 含 validate + journal append + 内存快照更新 |
| checkpoint 开销 | < 200ms | 单次 checkpoint 创建（受控频率） |
| 多界面分发开销 | < 20ms | `AgentRunResult` 分发到 3 适配器的总开销 |

---

## 6. 安全策略

### 6.1 surface / workspace / agent 权限隔离

在现有权限模型（`server/plugin-permissions.js`）基础上新增两项权限：

| 权限 | risk | desc | default |
|------|------|------|---------|
| `surface` | medium | 注册表现层适配器（可拦截 / 改写 Agent 渲染输出） | false |
| `workspace` | medium | 跨插件共享 workspace（多 Bot 协同场景） | false |

- **`surface` 权限**：只有声明了 `surface` 权限的插件才能调用 `ctx.surface.register(adapter)` 注册适配器。适配器能消费 `AgentRunResult`（含 `state.private` 私有层），风险中等，非默认授予。
- **`workspace` 权限**：多 Bot 协同场景下，多个 bot 绑定不同 Agent Profile 但共用 workspace。只有声明了 `workspace` 权限的插件才能跨插件访问 workspace。
- **`agent` 权限**：已有，使用 Agent 框架（注册工具 / 调度子代理 / 触发 run）。

### 6.2 领域工具校验

- 工具声明 `validate` 函数，状态变更前校验（见架构文档 §10.1）。
- 错误分级 `Recoverable` / `PolicyDenied` / `SystemFailure`：
  - `Recoverable`：Agent 可重试（如钱包 id 错误，列出可用项）。
  - `PolicyDenied`：Agent 不应再试（如违反状态不变量）。
  - `SystemFailure`：引擎层兜底，run 失败。
- 校验读取的是 **workspace 内的当前状态快照**（run 级），而非会话级稳定层，失败 run 不污染稳定层。

### 6.3 workspace 路径穿越防护

- run 级 workspace 路径：`data/plugins/agent-framework/runs/<run-id>/`。
- `run-id` 由引擎生成（`${Date.now()}-${random}`），不接受用户输入，无穿越风险。
- workspace 内文件操作（`file.write` 工具）的相对路径经 `safeResolve` 校验：解析后路径必须仍在 `runs/<run-id>/` 之下，否则抛 `路径越界`。
- 现有 `createFsService` 已实现 `safeResolve`（`server/plugin-permissions.js`），workspace 的文件工具复用此模式。

### 6.4 ST shim 的边界（已废弃）

> ⚠️ 已废弃（2026-08-03）：ST 兼容前端桥方案已移除实现，本节仅作历史设计记录保留。

- ST shim 只暴露 `/api/characters` / `/api/chats` / `/api/presets` / `/api/worldinfo` / `/api/generate` 等白名单路由，不暴露网关内部管理路由。
- ST shim 的资产读写复用 `createAssetsService`（只读 + 路径校验）与 `card-loader.js`。
- `/api/generate` 触发 `ctx.agent.run` 需校验调用方权限（网关鉴权 token 或 ST 前端 session）。

### 6.5 现有安全基线继承

本方案不削弱现有安全基线：

- 插件权限模型（`buildScopedServices`）继续按权限收窄能力。
- 网关配置脱敏（`makeGatewayConfigView`）继续对凭据字段脱敏。
- LLM 调用不暴露 API key（`ctx.llm` 只给调用能力）。
- 插件代码扫描（`scanPluginRisk`）继续在安装前展示风险。

### 6.6 诚实说明

继承现有 `plugin-permissions.js` 的诚实说明：本模块实现的是**能力收窄**，不是安全沙箱。插件与网关同进程、共享 Node 权限，无法阻止刻意为恶的插件 `import('fs')` 直接读磁盘。真正的隔离需要独立进程 + Node 权限模型，路线见 `docs/PLUGIN_SECURITY.md`。本方案的权限隔离把"装了就等于交出所有凭据"降级为"装了等于让它在你的网关里跑代码"。

---

## 7. 终端优势发挥

网关作为常驻终端服务运行，相比 SillyTavern 单端浏览器架构，突破以下原生限制：

### 7.1 多平台常驻

QQ / Telegram / Discord / 飞书 / 钉钉同时在线。酒馆是单端浏览器，挂一个就占一个标签页；网关是终端服务，一个进程同时服务多平台。

### 7.2 多会话独立 Profile

每个 IM 会话可绑不同角色（Profile）。酒馆全局单激活聊天，切换角色要手动切；网关每个群 / 每个私聊独立 Profile，并行运行。

### 7.3 无浏览器依赖

网关自建推理管线（`server/runtime/pipeline.js` + `llm-client.js`），不依赖浏览器。酒馆必须挂前端；网关可在无头服务器 / Docker 里跑，IM 适配器 + Native 适配器都无需浏览器。

### 7.4 高性能原生工具循环

网关的 `ctx.llm.runTools` 走原生 function calling，无前端 JS 开销。酒馆的工具循环跑在浏览器 JS 里，受前端性能限制。

### 7.5 定时任务 / 后台子代理

网关有 `server/scheduler-service.js`，支持定时任务。酒馆是单次 LLM 调用，用户不发言模型不动；网关可定时调度后台导演组子代理（`agent-其四.md` 的暗线生成），玩家休息时世界仍运转。这是本架构 §10.4.5"后台导演组子代理"的落地基础，也是网关相对酒馆的核心差异化优势。

---

> 本白皮书为 Task 0 交付物。落地依据见 `AGENT_PLATFORM_ARCHITECTURE.md`，线框图与数据契约见 `AGENT_PLATFORM_PROTOTYPE.md`。
