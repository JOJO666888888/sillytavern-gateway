# Agent 平台化原型设计

> change-id: `design-agent-platform`
> 状态：文档先行（Task 0 / SubTask 0.3）
> 配套：架构设计见 `AGENT_PLATFORM_ARCHITECTURE.md`，白皮书见 `AGENT_PLATFORM_WHITEPAPER.md`

---

## 目录

1. [三界面线框图](#1-三界面线框图)
2. [数据契约：AgentRunResult](#2-数据契约agentrunresult)
3. [关键 API 签名](#3-关键-api-签名)
4. [目录结构](#4-目录结构)

---

## 1. 三界面线框图

### 1.1 IM 界面增强适配器

IM 平台（QQ / Telegram / Discord 等）的渲染受限于平台消息能力。适配器把 `AgentRunResult` 渲染为：状态卡片图片 + 正文分段 + 选项按钮。

```
┌─────────────────────────────────────────────────────────┐
│  [状态卡片图片 - message-to-image 渲染 state.visible]      │
│  ┌───────────────────────────────────────────────────┐  │
│  │  📍 酒馆 · 夜晚 22:00                              │  │
│  │  👥 在场: 艾莉丝(清醒), 巴特(醉酒), 老板(忙碌)      │  │
│  │  ─────────────────────────────────────────────     │  │
│  │  艾莉丝  ❤️ 72  💰 120金币  🎒 剑,药水             │  │
│  │  巴特    ❤️ 55  💰 8金币    🎒 空手                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  [正文 - 分段发送, artifacts[].content 切分]              │
│                                                         │
│  艾莉丝推开酒馆的木门，一股暖意混着麦酒香扑面而来。      │
│  炉火旁，巴特已经喝得烂醉，桌上的酒杯歪倒了一片...      │
│                                                         │
│  "你总算来了，"老板头也不抬地擦着杯子，"老位置。"        │
│                                                         │
│  艾莉丝在吧台坐下，余光扫过角落那个蒙面人——              │
│  不像本地人，腰间的硬物轮廓让她下意识握紧了剑柄。        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  [选项按钮 - option-splitter 渲染 options[]]              │
│                                                         │
│  选项1: 走向蒙面人搭话           [按钮]                  │
│  选项2: 向老板打听最近的消息    [按钮]                  │
│  选项3: 默默观察, 先吃完东西     [按钮]                  │
│  选项4: 加速时间到当前事件结束   [按钮]                  │
└─────────────────────────────────────────────────────────┘
```

**渲染规则**：

1. 状态卡片图片由 `message-to-image` 渲染 `state.visible`，**旁路发送**（与正文独立的一条图片消息）。
2. 正文按段落（`\n\n`）切分 `artifacts[0].content`，分多条消息发送，避免超长。
3. 选项由 `option-splitter` 把 `options[]` 渲染为平台原生按钮 / 引用 / 菜单（按平台能力降级）。
4. 兜底：若适配器未注册或 `message-to-image` 不可用，回退到"先正文后选项"纯文字流（现有 `agent-rp` 行为）。

### 1.2 ST 兼容前端（复用 ST 原生布局）

用户在浏览器打开本地 SillyTavern 前端，后端指向网关。界面布局完全复用 ST 成熟 UI，网关只做路由 shim。

```
┌─────────────────────────────────────────────────────────────────────┐
│  SillyTavern 前端 (用户自带, 后端指向网关)                            │
├───────────┬─────────────────────────────────────────┬──────────────┤
│           │                                         │              │
│  角色列表  │            主聊天区                     │   右侧栏     │
│  (网关     │   (复用 ST 布局: 立绘 + 背景 + 消息流)   │  (世界书 /   │
│  /api/    │                                         │   预设 /     │
│  characters│   ┌───────────────────────────────┐    │   角色卡)    │
│  读写)     │   │  [立绘 - 角色卡资源]            │    │  (网关      │
│           │   │  [背景 - 场景背景群]            │    │   /api/*    │
│  ─────────│   └───────────────────────────────┘    │   读写)      │
│  Alice    │                                         │              │
│  Bob      │   🎭 Alice: 你推开门...                 │  ──────────  │
│  ...      │   📝 (artifacts 正文)                   │  世界书:     │
│           │   [QuickReply 选项 - options[]]         │  lore.json   │
│           │                                         │  预设:       │
│           │   ▶ 选项1: 走向蒙面人...                │  default     │
│           │   ▶ 选项2: 向老板打听...                │              │
│           │                                         │              │
├───────────┴─────────────────────────────────────────┴──────────────┤
│  输入框  [用户消息]                              [发送] [生成]      │
│  (/api/generate 触发 ctx.agent.run, 回传 artifacts)                  │
└─────────────────────────────────────────────────────────────────────┘
```

**路由映射**：

| ST 前端请求 | 网关 shim 行为 |
|-------------|---------------|
| `GET /api/characters` | 列出 `assets/characters/`（复用 `card-loader.js`） |
| `POST /api/characters` | 写入角色卡到 `assets/characters/` |
| `GET /api/chats` | 读会话历史（复用 `session-manager.js` + `chat-archive.js`） |
| `GET /api/presets` | 列出 `assets/presets/`（复用 `preset-engine.js`） |
| `GET /api/worldinfo` | 列出 `assets/worldbooks/`（复用 `worldbook-engine.js`） |
| `POST /api/generate` | Agent 模式触发 `ctx.agent.run`，回传 `artifacts[0].content` 作为生成结果 |

### 1.3 Agent 专用前端（Native 剧场布局）

网关面板内置 "Agent 剧场" 页面，三栏布局：左侧配置侧栏 + 中间主区（正文流 + 选项区）+ 右侧状态面板与时间线。

```
┌──────────────┬──────────────────────────────────────┬──────────────┐
│ 配置侧栏     │       主区 (正文流 + 选项区)          │ 状态面板     │
│ (边玩边改)   │                                      │ + 时间线     │
├──────────────┤                                      ├──────────────┤
│ ▼ Profile    │ ┌──────────────────────────────────┐ │ 📍 状态      │
│  default-rp  │ │ 实时正文流 (流式, 不刷新)          │ │ ─────────── │
│  [切换 ▼]    │ │                                  │ │ 时间: 22:00 │
│              │ │ 艾莉丝推开酒馆的木门...           │ │ 地点: 酒馆  │
│ ▼ 文风       │ │ ▍ (流式光标)                      │ │ 在场:       │
│  叙事写实    │ │                                  │ │  艾莉丝 ❤️72│
│  [切换 ▼]    │ │ "你总算来了，"老板...             │ │  巴特   ❤️55│
│              │ │                                  │ │  老板   忙  │
│ ▼ 视角       │ │ ── 工具调用: state.write ──────  │ │             │
│  actor       │ │ (事件流实时显示)                  │ │ 📊 时间线    │
│  ○ actor    │ │                                  │ │ ─────────── │
│  ○ director │ │ ┌──────────────────────────────┐ │ │ 22:00 run#3 │
│              │ │ │ 选项区 (点击即提交)            │ │ │  ├ state.wrt│
│ ▼ 工具白名单 │ │ │                              │ │ │  ├ narr.gen │
│  ☑ state.*   │ │ │ [选项1: 走向蒙面人]          │ │ │  ├ subagent │
│  ☑ memory.*  │ │ │ [选项2: 向老板打听]          │ │ │  │  critic   │
│  ☐ file.write│ │ │ [选项3: 默默观察]            │ │ │  └ commit ✓│
│              │ │ │ [选项4: 加速时间]            │ │ │ 21:45 run#2 │
│ ▼ 记忆       │ │ └──────────────────────────────┘ │ │  ├ ...     │
│  project ✓   │ │                                      │ 21:30 run#1 │
│  reference   │ │  [输入框] 或点击选项即提交           │  └ ...     │
│  feedback    │ │                                      │             │
└──────────────┴──────────────────────────────────────┴──────────────┘
```

**布局说明**：

- **配置侧栏（左）**：Profile / 文风 / 视角 / 工具白名单 / 记忆层级开关。修改后热重载，会话不中断。
- **主区（中）**：
  - 实时正文流：流式输出，不刷新页面，流式光标 `▍` 标记生成中。
  - 事件流：工具调用 / 子代理审查 / 状态变更实时显示（从 `events` 重建）。
  - 选项区：点击即提交，无需输入。
  - 输入框：可选，支持自由文本输入。
- **状态面板（右上）**：按 `state.visible` 渲染当前时间 / 地点 / 在场角色 / 各角色状态。
- **时间线（右下）**：从 `events` 重建，按 run 分组，显示每个 run 的工具调用链、子代理调度、状态变更、commit 结果。

---

## 2. 数据契约：AgentRunResult

`AgentRunResult` 是 Agent 引擎一次 run 完成后产出的结构化输出，是表现层抽象的核心契约。

### 2.1 完整 JSON 结构

```json
{
  "runId": "1755000000-a1b2c3",
  "agent": "default-rp",
  "sessionId": "telegram:12345",
  "turn": 3,
  "artifacts": [
    {
      "type": "narrative",
      "content": "艾莉丝推开酒馆的木门...（markdown 正文）",
      "label": "正文"
    },
    {
      "type": "outline",
      "content": "本轮细纲：1. 艾莉丝入场 2. 蒙面人伏笔 3. 巴特醉酒状态",
      "label": "细纲"
    }
  ],
  "options": [
    {
      "label": "选项1",
      "text": "走向蒙面人搭话",
      "callback": "select:option:1"
    },
    {
      "label": "选项2",
      "text": "向老板打听最近的消息",
      "callback": "select:option:2"
    },
    {
      "label": "选项3",
      "text": "默默观察，先吃完东西",
      "callback": "select:option:3"
    },
    {
      "label": "选项4",
      "text": "加速时间到当前事件结束",
      "callback": "select:option:4"
    }
  ],
  "state": {
    "visible": {
      "time": "22:00",
      "location": "酒馆",
      "actors": [
        { "id": "alice", "name": "艾莉丝", "status": "清醒", "health": 72 },
        { "id": "bart", "name": "巴特", "status": "醉酒", "health": 55 },
        { "id": "bartender", "name": "老板", "status": "忙碌" }
      ],
      "scene": { "beat": "入场", "goal": "艾莉丝与蒙面人初次接触" }
    },
    "private": {
      "alice": { "inner": "怀疑蒙面人是刺客", "plan": "试探身份" },
      "bart": { "inner": "醉梦中回忆往事" }
    }
  },
  "events": [
    {
      "type": "tool_call",
      "tool": "state.read",
      "args": { "key": "actors" },
      "ts": "2026-07-31T14:00:01Z"
    },
    {
      "type": "state_change",
      "tool": "state.write",
      "args": { "key": "alice.health", "value": 72 },
      "before": 75,
      "after": 72,
      "ts": "2026-07-31T14:00:02Z"
    },
    {
      "type": "subagent_dispatch",
      "agent": "critic-realism",
      "handoff": false,
      "ts": "2026-07-31T14:00:05Z"
    },
    {
      "type": "tool_call",
      "tool": "narrative.generate",
      "args": { "basedOn": "state_change" },
      "ts": "2026-07-31T14:00:06Z"
    },
    {
      "type": "checkpoint",
      "name": "01-after-draft",
      "ts": "2026-07-31T14:00:07Z"
    },
    {
      "type": "commit",
      "promoted": ["state.snapshot.json"],
      "ts": "2026-07-31T14:00:08Z"
    }
  ],
  "meta": {
    "viewMode": "actor",
    "style": "叙事写实",
    "referencedMemory": ["memory/project.md", "memory/alice/project.md"],
    "controller": "default-rp",
    "durationMs": 8200,
    "model": "deepseek-v4"
  }
}
```

### 2.2 字段说明

| 顶层字段 | 类型 | 必填 | 说明 |
|---------|------|------|------|
| `runId` | string | 是 | run 唯一标识，`${Date.now()}-${random}` |
| `agent` | string | 是 | Agent Profile 名（如 `default-rp`） |
| `sessionId` | string | 是 | 会话标识（`platform:chatId` 或 `session_id`） |
| `turn` | number | 是 | 本轮轮次（从 1 递增） |
| `artifacts` | Artifact[] | 是 | 产物数组，至少含 1 个 `type: "narrative"` |
| `options` | Option[] | 否 | 玩家行动选项，可为空（纯叙事轮） |
| `state` | StateSnapshot | 是 | 本轮状态快照 |
| `events` | AgentEvent[] | 是 | 本轮事件流（用于时间线） |
| `meta` | RunMeta | 是 | 元信息 |

#### Artifact

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | `"narrative"` / `"outline"` / `"draft"` / 自定义 |
| `content` | string | markdown 文本 |
| `label` | string | 展示标签（如"正文"/"细纲"） |

#### Option

| 字段 | 类型 | 说明 |
|------|------|------|
| `label` | string | 选项标签（如"选项1"） |
| `text` | string | 选项文本 |
| `callback` | string | 回调标识（如 `select:option:1`），供适配器回传给引擎 |

#### StateSnapshot

| 字段 | 类型 | 说明 |
|------|------|------|
| `visible` | object | 可见层（所有角色 + 表现层可见），含 `time`/`location`/`actors`/`scene` |
| `private` | object | 私有层，按角色 namespace 隔离，如 `private.alice`。按角色过滤输出 |

#### AgentEvent

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | string | `tool_call` / `state_change` / `subagent_dispatch` / `checkpoint` / `commit` / `agent_handoff` / `error` |
| `tool` | string | 工具名（`type=tool_call`/`state_change` 时） |
| `args` | object | 工具参数 |
| `ts` | string | ISO 时间戳 |
| 其他 | any | 按 `type` 不同有附加字段（如 `state_change` 有 `before`/`after`，`subagent_dispatch` 有 `agent`/`handoff`） |

#### RunMeta

| 字段 | 类型 | 说明 |
|------|------|------|
| `viewMode` | string | `"actor"` / `"director"` |
| `style` | string | 当前文风名 |
| `referencedMemory` | string[] | 引用的记忆文件路径 |
| `controller` | string | 当前控制器（主代理名或 handoff 后的子代理名） |
| `durationMs` | number | run 耗时 |
| `model` | string | 使用的模型 |

### 2.3 按角色过滤规则

`state.private` 的输出按当前 run 的 `controller` 决定：

- 主代理（GM）controller：输出全量 `private`（所有角色私有层）。
- 角色 Alice 子代理 controller（handoff 后）：只输出 `private.alice`，不输出 `private.bob`。
- 表现层适配器渲染时**只用 `state.visible`**，不渲染任何 `private`（防止泄露角色内心给玩家）。

---

## 3. 关键 API 签名

### 3.1 表现层适配器注册

```ts
// server/plugin-context.js - 新增 ctx.surface
interface SurfaceContext {
  register(adapter: SurfaceAdapter): void;          // 注册适配器（需 surface 权限）
  bindSession(sessionId: string, primary: string, bypass?: string[]): void;  // 会话绑定主适配器 + 旁路
  getAdapters(): SurfaceAdapter[];                  // 列出已注册适配器
}

// 插件 onLoad() 中调用:
ctx.surface.register({
  surfaceType: 'im',
  render: async (result, sctx) => { /* IM 渲染逻辑 */ },
  onEvent: async (event, sctx) => { /* 可选：事件回调 */ },
});
```

### 3.2 Agent run 触发

```ts
// ctx.agent.run - 新增（现有 ctx.agent.registerTool/dispatch/registerAgent 不变）
interface AgentService {
  // 现有
  registerTool(tool: ToolDef): void;
  dispatch(agentName: string, task: string, options?: DispatchOptions): Promise<SubagentResult>;
  registerAgent(agentDef: AgentDef): void;
  getStatus(): AgentStatus;
  // 新增
  run(profile: string, input: string, session: SessionRef): Promise<AgentRunResult>;
}

interface SessionRef {
  platform: string;       // 'telegram' / 'st' / 'native'
  chatId: string;         // IM 的 chatId 或 session_id
  namespace?: string;     // 独立角色模式下的 namespace
}
```

`ctx.agent.run` 是表现层适配器触发引擎的统一入口，返回 `AgentRunResult`（见 §2）。

### 3.3 表现层适配器接口

```ts
// server/agent/surface/adapter-interface.js
interface SurfaceAdapter {
  /** 支持的界面类型 */
  surfaceType: 'im' | 'st' | 'native' | string;

  /** 渲染一次完整的 AgentRunResult */
  render(result: AgentRunResult, ctx: SurfaceCtx): Promise<void>;

  /** 可选：流式/事件回调（引擎产出事件时调用，适配器可实时推送前端） */
  onEvent?(event: AgentEvent, ctx: SurfaceCtx): Promise<void>;
}

interface SurfaceCtx {
  sessionId: string;
  platform: string;
  chatId: string;
  // 按适配器收窄的能力:
  reply(text: string, opts?: ReplyOpts): Promise<void>;       // 发消息
  sendImage(buffer: Buffer, opts?: ReplyOpts): Promise<void>; // 发图片（IM 状态图用）
  emit(event: string, data: unknown): void;                   // WebSocket/SSE 推送（Native 用）
}
```

### 3.4 WebSocket / SSE 端点

```ts
// server/index.js 新增
// WebSocket: /ws/agent/:sessionId
//   - 客户端连接后订阅该 session 的 AgentRunResult 流 + AgentEvent 流
//   - 服务端推送: { type: 'agent_event', event: AgentEvent }
//                 { type: 'agent_result', result: AgentRunResult }
//                 { type: 'token_delta', delta: string }
//   - 客户端可发: { type: 'input', text: string }  // 等价于 ctx.agent.run 的 input

// SSE 降级: GET /api/agent/stream/:sessionId
//   - EventSource, 同样的消息类型, 降级方案
```

### 3.5 ST 兼容路由 shim

> ⚠️ 已废弃（2026-08-03）：ST 兼容前端桥方案已移除实现，本节仅作历史设计记录保留。

```ts
// server/compat/st-shim.js - 新增
// 挂载到 server/index.js 的 app 上

// 资产读写（复用现有 card-loader/preset-engine/worldbook-engine）
app.get('/api/characters', stShim.listCharacters);
app.post('/api/characters', stShim.writeCharacter);
app.get('/api/chats', stShim.listChats);
app.get('/api/chats/:name', stShim.readChat);
app.get('/api/presets', stShim.listPresets);
app.get('/api/worldinfo', stShim.listWorldbooks);

// Agent generate（核心）
app.post('/api/generate', stShim.generate);
//   - 若处于 Agent 模式: 调 ctx.agent.run(profile, input, session)
//   - 把 AgentRunResult.artifacts[0].content 作为生成结果回传
//   - 非 Agent 模式: 回退到现有 native runtime 的 generate
```

### 3.6 Workspace / Journal API（引擎内部）

```ts
// plugins/agent-framework/engine/workspace-manager.js - 新增
interface WorkspaceManager {
  init(runId: string, sessionId: string): Workspace;        // 初始化 run 级 workspace
  get(runId: string): Workspace | null;
  checkpoint(runId: string, name: string): void;             // 创建 checkpoint
  commit(runId: string, result: AgentRunResult): void;      // commit + promote 到会话级
  rollback(runId: string): void;                            // 丢弃失败 run 的 workspace
}

interface Workspace {
  runId: string;
  root: string;                  // runs/<run-id>/ 绝对路径
  readState(): object;           // 读 workspace 内状态快照
  writeState(patch: object): void;  // 写状态快照（内存 + 批量刷盘）
  writeFile(relPath: string, content: string): void;  // 写 workspace 文件（路径校验）
  readFile(relPath: string): string;
}

// plugins/agent-framework/engine/journal.js - 新增
interface Journal {
  append(runId: string, event: AgentEvent): void;           // 追加到 events.jsonl
  rebuild(runId: string): AgentEvent[];                      // 重建时间线（供 Native 时间线 UI）
}
```

---

## 4. 目录结构

### 4.1 新增文件清单

```
sillytavern-gateway/
├── server/
│   ├── agent/
│   │   ├── context-builder.js              # [已有] 上下文组装
│   │   ├── pipeline.js                     # [已有] 多阶段流水线
│   │   └── surface/                        # [新增] 表现层抽象
│   │       ├── dispatcher.js               #   表现层调度器
│   │       ├── adapter-interface.js        #   SurfaceAdapter 接口定义与校验
│   │       └── surface-ctx.js              #   SurfaceCtx 构造
│   ├── compat/
│   │   ├── astrbot-shim.js                 # [已有] AstrBot 路由 shim
│   │   ├── index.js                        # [已有]
│   │   └── st-shim.js                      # [新增] ST 兼容前端桥（已废弃）
│   ├── plugin-context.js                  # [改造] 新增 ctx.surface
│   ├── plugin-permissions.js               # [改造] 新增 surface/workspace 权限
│   └── index.js                            # [改造] 新增 ST shim 路由 + WebSocket/SSE 端点
│
├── plugins/
│   ├── agent-framework/
│   │   ├── engine/
│   │   │   ├── agent-runner.js             # [改造] 产出 AgentRunResult + workspace/journal
│   │   │   ├── tool-registry.js            # [改造] validate 钩子 + 错误分级
│   │   │   ├── subagent-dispatcher.js      # [改造] handoff 语义
│   │   │   ├── state-manager.js            # [已有]
│   │   │   ├── memory-engine.js            # [已有]（Task 6.8 加 namespace）
│   │   │   ├── workspace-manager.js        # [新增] run 级 workspace + checkpoint
│   │   │   ├── journal.js                  # [新增] events.jsonl + 时间线重建
│   │   │   └── ...                         # 其他已有
│   │   ├── tools/
│   │   │   ├── state-tools.js              # [改造] 写入走 workspace + validate
│   │   │   ├── narrative-tools.js         # [改造] 草稿入 workspace
│   │   │   └── ...                         # 其他已有
│   │   ├── runs/                           # [新增] run 级 workspace 运行时数据（运行时生成）
│   │   ├── templates/
│   │   │   ├── simple-rp.yaml              # [已有]
│   │   │   ├── multi-critic.yaml           # [已有] Task 6.7 增强
│   │   │   ├── director-mode.yaml         # [已有]
│   │   │   ├── state-engine.yaml          # [新增] Task 6.7
│   │   │   └── default-rp.yaml            # [新增] Task 6.1 默认方案
│   │   └── index.js                        # [改造] 注册 surface 适配器绑定 + ctx.agent.run
│   │
│   └── agent-rp/
│       └── index.js                        # [改造] 改为 IM 界面适配器
│
├── panel.html                              # [改造] 新增 "Agent 剧场" 页面
├── style.css                               # [改造] Agent 剧场样式
│
└── docs/
    ├── AGENT_PLATFORM_ARCHITECTURE.md      # [新增] 架构设计
    ├── AGENT_PLATFORM_WHITEPAPER.md        # [新增] 白皮书
    └── AGENT_PLATFORM_PROTOTYPE.md          # [新增] 本文, 原型设计
```

### 4.2 运行时数据目录

```
data/plugins/agent-framework/
├── agents/                  # YAML Agent 定义（已有）
├── skills/                  # Skill 文件（已有）
├── styles/                  # 文风文件（已有）
├── memory/                  # 四层记忆（已有，Task 6.8 加 namespace 子目录）
│   ├── project.md           #   全局（默认方案）
│   ├── reference.md
│   ├── feedback.md
│   ├── user.md
│   └── <namespace>/         #   独立角色 namespace（Task 6.8）
│       └── project.md
├── states/                  # 会话状态（已有，StateManager）
├── sessions/                # [新增] 会话级稳定层（commit promote 目标）
│   └── <session-key>/
│       └── state.json
└── runs/                    # [新增] run 级 workspace
    └── <run-id>/
        ├── workspace/
        │   ├── state.snapshot.json
        │   └── draft.md
        ├── events.jsonl
        ├── checkpoints/
        │   ├── 00-init.json
        │   ├── 01-after-draft.json
        │   └── 02-pre-commit.json
        └── result.json
```

### 4.3 关键路径速查

| 路径 | 说明 |
|------|------|
| `server/agent/surface/dispatcher.js` | 表现层调度器（Task 1.3） |
| `server/compat/st-shim.js` | ST 兼容路由 shim（Task 3.1）（已废弃） |
| `plugins/agent-framework/engine/workspace-manager.js` | run 级 workspace（Task 5.1） |
| `plugins/agent-framework/engine/journal.js` | events.jsonl（Task 5.2） |
| `data/plugins/agent-framework/runs/<run-id>/` | run 级 workspace 数据（运行时生成） |
| `data/plugins/agent-framework/sessions/<session-key>/` | 会话级稳定层（commit promote 目标） |
| `plugins/agent-framework/templates/default-rp.yaml` | 默认方案（Task 6.1） |
| `panel.html` 的 Agent 剧场区块 | Native 前端（Task 4.1） |

---

## 5. ST 前端接入步骤（Task 3 落地指南）

本节说明如何让真实 SillyTavern 前端直连网关，以及如何使用内置的 Agent 剧场（Native 前端）。ST shim 不引入 ST 源码，用户自带前端，网关只做路由 shim + 资产读写。

### 5.1 前置条件

1. **网关已运行**：`npm start` 或 `./gateway-manager.sh start`，控制台会明文打印 `authToken` 与端口（默认 3210）。
2. **agent-framework 插件已加载**：启动日志应出现 `Agent 框架已加载，工具数: N`。插件位于 `plugins/agent-framework/`。
3. **runtime.llm 已配置**（Agent 模式必需）：在 `config/gateway.json` 配置：
   ```json
   {
     "runtime": {
       "enabled": true,
       "llm": {
         "provider": "openai",
         "apiKey": "sk-xxx",
         "baseUrl": "https://api.openai.com/v1",
         "model": "gpt-4o"
       }
     }
   }
   ```
   未配置时 Agent 模式返回 503，非 Agent 模式仍可用（透传 nativeRuntime）。

### 5.2 方式一：真实 ST 前端直连网关

> ⚠️ 已废弃（2026-08-03）：ST 兼容前端桥方案已移除实现，本节仅作历史设计记录保留。

网关实现了 ST 期望的 `/api/*` 契约，ST 前端无需改动即可直连。

1. **启动 ST**：正常启动 SillyTavern（`npm start` in SillyTavern 目录）。
2. **配置 ST 指向网关**：在 ST 的 API 设置中，将 API URL 指向网关地址（如 `http://127.0.0.1:3210`）。网关已实现以下 ST 路由：
   - `GET /api/settings` - 返回最小可启动设置（ST 启动必需）（已废弃）
   - `GET /csrf-token` - CSRF 桩（返回固定 token）
   - `GET /api/characters` / `GET /api/characters/:name` / `POST /api/characters` - 角色卡读写
   - `GET /api/chats/:name` / `GET /api/chats/:name/:fileId` / `POST /api/chats/:name/:fileId` - 聊天存档
   - `GET /api/presets` / `GET /api/presets/:name` - 预设
   - `GET /api/worldinfo` / `GET /api/worldinfo/:name` - 世界书
   - `POST /api/generate` - 生成回复（双模式，见 5.3）
3. **鉴权**：所有 `/api/*` 请求需携带 `X-Gateway-Token` 头（值为网关 authToken）。若 ST 不支持自定义头，可在 `config/gateway.json` 设 `server.requireAuth: false` 关闭鉴权（仅限可信网络）。
4. **资产目录对应**：ST 读写角色卡/聊天/预设/世界书时，网关映射到：
   - 角色卡 → `data/characters/<name>.png|json`
   - 聊天存档 → `data/chats/<characterName>/<fileId>.jsonl`
   - 预设 → `data/presets/<name>.json`
   - 世界书 → `data/worldbooks/<name>.json`

### 5.3 /api/generate 双模式切换

`POST /api/generate` 支持两种模式，由 `agentMode` 字段控制：

| 模式 | 触发条件 | 行为 | 响应 |
|------|---------|------|------|
| Agent 模式 | 请求体 `agentMode: true` 或 `config.runtime.agentMode: true` | 调 `agentService.run(profile, input, session, ctx)`，产出 `AgentRunResult` | `{ message, results: [{message}], _agentMeta: {runId, options, events} }` |
| 非 Agent 模式 | 请求体 `agentMode: false` 且全局开关关闭 | 透传 `nativeRuntime.generate()` | `{ message, results: [{message}] }` |

- **Agent 模式**：`message` 字段取 `AgentRunResult.getMainText()`（type=main 的 artifact）。`_agentMeta.options` 携带玩家选项（ST 前端可渲染为按钮）。
- **输入提取**：优先取 `body.prompt` / `body.input`，否则从 `body.messages` 提取最后一条 user 消息。
- **Profile 选择**：请求体 `body.agent` 或 `body.profile` 指定 Agent 定义名，默认 `default-rp`。

### 5.4 方式二：内置 Agent 剧场（Native 前端）

无需启动 ST，直接在网关面板内使用三栏剧场界面。

1. **打开面板**：在 ST 顶部设置栏点击「多平台网关」展开面板（或访问网关地址）。
2. **连接网关**：在「连接」区块填入地址与 Token，点击连接。
3. **展开 Agent 剧场**：点击「Agent 剧场」区块标题展开。面板会自动注入 `panel-agent-theatre.js` 脚本。
4. **选择 Profile**：顶部工具栏选择 Agent Profile（如 `default-rp`），可选填文风/视角/会话标识。
5. **开始对话**：在中间输入框输入消息（Ctrl+Enter 发送），或点击选项区的按钮触发选项回调。
6. **实时反馈**：
   - 正文流：Agent 产出的叙事文本实时追加到中间栏。
   - 选项区：每次 run 后出现玩家行动选项。
   - 状态面板（右栏）：显示当前时间/地点/在场角色/场景。
   - 时间线（右栏）：工具调用/子代理/状态变更事件按序显示。
7. **边玩边改**：左栏可编辑 Profile YAML，点击「保存热重载」即生效，会话不中断。

### 5.5 SSE 实时事件流

Agent 剧场通过 SSE（Server-Sent Events）接收实时更新，无需轮询：

```
GET /api/agent-theatre/stream?session=<platform:chatId>
```

推送事件类型：
- `agent_result` - 一次 run 的完整 `AgentRunResult`（含正文/选项/状态）
- `agent_event` - 单个事件（工具调用/状态变更/子代理，用于时间线）
- `state` - 当前会话状态快照
- `heartbeat` - 30s 心跳（防止反代超时断开）

客户端用浏览器原生 `EventSource` 订阅，断开后自动重连（3s）。

### 5.6 触发 Agent run 的 API

```
POST /api/agent-theatre/input
Body: { input, session, profile, callbackId?, character?, worldbook?, style? }
```

响应：`{ success, runId, text, result }`，同时通过 SSE 广播给所有订阅者。

### 5.7 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| ST 启动卡在加载 | `/api/settings` 未返回 | 确认网关已启动且路由已注册 |
| generate 返回 503「agent-framework 未加载」 | 插件未启用 | 检查 `plugins/agent-framework/` 存在且无加载错误 |
| generate 返回 503「runtime.llm 未配置」 | 未配 LLM | 在 `config/gateway.json` 配 `runtime.llm` |
| SSE 连接立即断开 | 鉴权失败或被 CORS 拦 | 关闭 `requireAuth` 或将 ST 地址加入 `allowedOrigins` |
| 剧场不显示正文 | Profile 不存在 | 用 `/agent list` 查看可用 Profile，或检查 `default-rp.yaml` |

---

> 本原型设计为 Task 0 交付物，定义了三界面线框、`AgentRunResult` 数据契约、关键 API 签名与目录结构。Phase 1-7 落地以此为准。架构原理见 `AGENT_PLATFORM_ARCHITECTURE.md`，问题背景与路线见 `AGENT_PLATFORM_WHITEPAPER.md`。
