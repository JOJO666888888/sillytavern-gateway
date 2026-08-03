# Agent 框架开发者指南

> 本指南面向希望在 SillyTavern Gateway 中使用 Agent 框架进行角色扮演和叙事创作的开发者。
>
> 适用版本：Agent 框架 v0.1.x（`plugins/agent-framework/`）

---

## 目录

1. [概述](#1-概述)
2. [架构设计](#2-架构设计)
3. [快速开始](#3-快速开始)
4. [Agent 定义格式](#4-agent-定义格式)
5. [工具注册表](#5-工具注册表)
6. [子代理系统](#6-子代理系统)
7. [记忆系统](#7-记忆系统)
8. [状态引擎](#8-状态引擎)
9. [ctx.agent API](#9-ctxagent-api)
10. [从 ST 卡片迁移](#10-从-st-卡片迁移)
11. [示例](#11-示例)
12. [故障排除](#12-故障排除)
13. [表现层抽象 ctx.surface](#13-表现层抽象-ctxsurface)
14. [Workspace + Journal（可审计可回滚）](#14-workspace--journal可审计可回滚)
15. [权限扩展（surface / workspace / agent）](#15-权限扩展surface--workspace--agent)
16. [整合验证与性能（Task 7）](#16-整合验证与性能task-7)

---

## 1. 概述

### 1.1 什么是 Agent 框架

Agent 框架是 SillyTavern Gateway 的一个内置插件，提供基于 YAML 定义的多 Agent 工作流能力。它让你可以在聊天平台（QQ / Telegram / Discord 等）上运行结构化的叙事 Agent，支持：

| 能力 | 说明 |
|------|------|
| **YAML 定义 Agent** | 用一个 `.yaml` 文件描述完整的 Agent 行为，无需写代码 |
| **工具注册表** | 内置状态、记忆、叙事、文件、Skill、子代理六类工具 |
| **子代理调度** | 主 Agent 可触发子代理并行/串行执行，实现多阶段流水线 |
| **记忆系统** | 四层记忆（剧情进度 / 参考信息 / 用户偏好 / 用户设定），支持自动摘要 |
| **状态引擎** | 键值对式会话状态管理，替代 MVU 的 JSON Patch |
| **资产注入** | 自动注入角色卡、世界书、文风文件到上下文 |

### 1.2 核心理念

Agent 框架的设计理念是**状态驱动叙事**：

- 传统 RP 依赖 prompt 硬编码状态（如 MVU JSON Patch），脆弱且难以维护
- Agent 框架通过 `state.read` / `state.write` 工具让 LLM 显式管理状态
- 叙事基于状态变化生成，而非靠气氛和 vague 描述

---

## 2. 架构设计

### 2.1 组件总览

```
┌─────────────────────────────────────────────────────┐
│                   AgentFrameworkPlugin               │
│                  (plugins/agent-framework/)          │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ AgentLoader  │  │ ToolRegistry │  │ AgentRunner│ │
│  │ 加载YAML定义 │  │ 工具注册/执行│  │ 执行Agent  │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                      │
│  ┌──────────────────┐  ┌──────────────┐  ┌────────┐ │
│  │SubagentDispatcher│  │ StateManager │  │Memory  │ │
│  │ 子代理调度       │  │ 会话状态     │  │Engine  │ │
│  └──────────────────┘  └──────────────┘  └────────┘ │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │              ContextBuilder                  │   │
│  │  构建 system prompt + 资产注入 + 文件注入   │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 2.2 执行流程

当用户通过 `/agent run <name>` 启动 Agent 后，后续消息会被框架拦截并走以下流程：

```
用户消息
  │
  ▼
ContextBuilder.build()
  │  拼装 system prompt + 注入角色卡/世界书/文件 + 历史消息
  ▼
ToolRegistry.getDeclarations()
  │  根据 Agent 定义的 tools 白名单筛选工具声明
  ▼
ctx.llm.runTools(messages, tools, executor, { maxSteps })
  │  LLM 循环调用工具直到生成最终文本
  ▼
SubagentDispatcher._triggerSubAgents()
  │  按触发条件调度子代理（并行/串行）
  ▼
ctx.reply(result.text)
  │  回复到聊天平台
  ▼
MemoryEngine.shouldSummarize()
     每 N 轮自动生成剧情摘要
```

### 2.3 数据目录

所有 Agent 运行时数据存放在 `data/plugins/agent-framework/` 目录下：

```
data/plugins/agent-framework/
├── agents/          # Agent YAML 定义文件
├── skills/          # Skill 文件（.md）
├── styles/          # 文风文件（.md）
├── memory/          # 四层记忆文件（project.md / reference.md / feedback.md / user.md）
└── states/          # 会话状态文件（按 platform:chatId 隔离）
```

---

## 3. 快速开始

### 3.1 启用插件

在网关配置中将 `agent-framework` 插件的 `enabled` 设为 `true`，或通过网关面板启用：

```json
// plugins/agent-framework/plugin.json
{
    "name": "agent-framework",
    "enabled": true
}
```

插件需要的权限：`["llm", "fs", "assets", "agent", "gateway.inbound", "sessions", "gateway.send"]`

### 3.2 创建第一个 Agent

在 `data/plugins/agent-framework/agents/` 目录下创建 `my-first-agent.yaml`：

```yaml
name: my-first-agent
displayName: 我的第一个Agent
description: 一个最简单的Agent示例。

systemPrompt: |
  你是一个叙事者。根据用户的输入生成沉浸式的叙事文本。
  每轮回复不少于300字。

tools:
  - state.read
  - state.write
  - memory.recall

context:
  historyLimit: 10

commands:
  - name: start
    description: 开始会话
```

### 3.3 启动 Agent

在聊天平台发送命令：

```
/agent run my-first-agent
```

看到 `✅ Agent "my-first-agent" 已启动` 后，直接发消息即可开始对话。

---

## 4. Agent 定义格式

Agent 定义是一个 YAML 文件，包含以下字段：

### 4.1 完整字段参考

```yaml
# === 基础信息 ===
name: agent-name              # 必填，唯一标识符（英文、连字符）
displayName: 显示名称          # 可选，展示用中文名
description: 描述文本          # 可选，在 /agent list 中显示

# === 系统提示词 ===
systemPrompt: |                # 必填，Agent 的核心指令
  你是一个叙事者。
  规则：
  - 保持角色一致性

# === 工具白名单 ===
tools:                         # 可选，声明此 Agent 可使用的工具
  - state.read
  - state.write
  - memory.recall
  - memory.update
  - memory.read
  - character.read
  - worldbook.search
  - narrative.generate
  - skill.load
  - skill.list
  - file.read
  - file.write
  - file.list
  - subagent.dispatch
  - subagent.list

# === 上下文配置 ===
context:                       # 可选
  historyLimit: 20             # 历史消息条数上限（每轮2条，即10轮对话）
  injectAssets:                # 注入 ST 资产
    character: "${character}"  # 角色卡名称（运行时从会话变量替换）
    worldbook: "${worldbook}"  # 世界书名称
  injectFiles:                 # 注入工作区文件（相对于 data/plugins/agent-framework/）
    - "styles/${style}.md"     # 文风文件
    - "memory/project.md"      # 剧情记忆
    - "memory/reference.md"    # 参考信息

# === 子代理 ===
subAgents:                     # 可选，声明子代理及其触发条件
  - name: critic-realism
    trigger: after_draft       # 触发时机：after_draft（草稿后）/ after_outline / manual
    parallel: true             # 是否并行执行
  - name: critic-style
    trigger: after_draft
    parallel: false

# === 执行限制 ===
maxSteps: 15                   # 可选，最大工具调用步数（默认10）

# === 模型采样参数 ===
model:                         # 可选
  temperature: 0.8
  maxTokens: 32768

# === 命令 ===
commands:                      # 可选，声明的命令（当前仅用于展示）
  - name: start
    description: 开始会话
```

### 4.2 变量替换

`systemPrompt`、`injectAssets`、`injectFiles` 中支持以下变量替换（运行时从会话状态获取）：

| 变量 | 说明 | 来源 |
|------|------|------|
| `${character}` | 角色卡名称 | `/agent run` 时从定义的 `injectAssets.character` 提取 |
| `${worldbook}` | 世界书名称 | 同上 |
| `${style}` | 文风名称 | 同上 |
| `${platform}` | 当前平台 | 运行时注入 |
| `${chatId}` | 当前会话 ID | 运行时注入 |

> 注意：变量名来自 `injectAssets` 字段中的 `${...}` 语法。框架会从中提取变量名，在 `/agent run` 时存入会话状态。

### 4.3 YAML 解析说明

框架内置基于 **js-yaml 4.x** 的 YAML 解析器（`engine/agent-loader.js`），支持 YAML 1.2 全特性：

- 键值对、多行字符串（`|` 和 `>`）
- 列表（`- item`）、嵌套缩进块
- 基本类型推断（布尔值、数字、null、字符串）
- 锚点/别名（`&`/`*`）、合并键（`<<`）、流式语法（`{}`/`[]`）

解析失败（非法 YAML）时自动回退到内置简易解析器，保证编辑出错时加载不崩溃。

---

## 5. 工具注册表

框架内置 15 个工具，分为六类。Agent 通过 `tools` 白名单声明使用哪些。

### 5.1 状态工具（state-tools.js）

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `state.read` | 读取当前会话状态 | `key`（可选，不传返回全部） |
| `state.write` | 写入会话状态 | `key`（必填）、`value`（必填，任意类型） |
| `state.list` | 列出所有状态键 | 无 |

示例 - LLM 调用工具更新状态：

```json
// LLM 调用 state.write
{
  "name": "state.write",
  "arguments": {
    "key": "time",
    "value": "第三天傍晚"
  }
}
```

状态按 `platform:chatId` 隔离，持久化到 `data/plugins/agent-framework/states/` 目录。

### 5.2 记忆工具（memory-tools.js）

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `memory.recall` | 关键词检索四层记忆 | `query`（必填，空格分隔多词）、`limit`（可选，默认5） |
| `memory.update` | 覆盖更新记忆文件 | `type`（必填：project/reference/feedback/user）、`content`（必填） |
| `memory.read` | 读取记忆文件内容 | `type`（必填） |

### 5.3 叙事工具（narrative-tools.js）

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `narrative.generate` | 调用 LLM 生成正文 | `prompt`（必填）、`style`（可选，文风名称） |

`narrative.generate` 会创建独立的 LLM 调用（temperature=0.8），适合在主 Agent 中分步生成草稿。

### 5.4 文件工具（file-tools.js）

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `file.read` | 读取工作区文件 | `path`（必填，相对路径） |
| `file.write` | 写入工作区文件 | `path`（必填）、`content`（必填） |
| `file.list` | 列出目录内容 | `path`（可选，默认根目录） |

所有路径相对于 `data/plugins/agent-framework/`，内置目录穿越防护。

### 5.5 Skill 工具（skill-tools.js）

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `skill.load` | 加载 Skill 文件内容 | `name`（必填，不含 `.md`） |
| `skill.list` | 列出所有可用 Skill | 无 |

Skill 文件存放在 `data/plugins/agent-framework/skills/` 目录下，格式为 Markdown。

### 5.6 子代理工具（subagent-tools.js）

| 工具名 | 说明 | 参数 |
|--------|------|------|
| `subagent.dispatch` | 调度子代理执行任务 | `agent`（必填）、`task`（必填）、`await`（可选，默认true） |
| `subagent.list` | 列出所有可用子代理 | 无 |

### 5.7 注册自定义工具

第三方插件可以通过 `ctx.agent.registerTool()` 注册自定义工具：

```javascript
// 在你的插件 onLoad 中
async onLoad() {
    // 需要声明 "agent" 权限
    ctx.agent.registerTool({
        name: 'my-custom-tool',
        description: '我的自定义工具',
        parameters: {
            type: 'object',
            properties: {
                input: { type: 'string', description: '输入内容' }
            },
            required: ['input'],
        },
        handler: async (args, context) => {
            // context 包含 session, ctx, definition
            return { result: '处理结果: ' + args.input };
        },
    });
}
```

注册后，Agent YAML 的 `tools` 白名单中加入 `my-custom-tool` 即可使用。

---

## 6. 子代理系统

### 6.1 子代理的概念

子代理（Sub-agent）是独立于主 Agent 运行的 Agent 实例，拥有：

- **独立的上下文**：不共享主 Agent 的历史消息，只接收任务描述
- **独立的工具白名单**：使用子代理 YAML 定义中的 `tools`
- **独立的采样参数**：默认 temperature=0.5（比主 Agent 低，更适合审查类任务）

### 6.2 触发机制

在主 Agent YAML 的 `subAgents` 字段中声明子代理及其触发条件：

```yaml
subAgents:
  - name: critic-realism       # 子代理名称（必须在 agents/ 目录有对应 YAML）
    trigger: after_draft       # 触发时机
    parallel: true             # 是否与其他同触发条件的子代理并行
```

| trigger 值 | 说明 |
|------------|------|
| `after_draft` | 主 Agent 生成草稿后触发 |
| `after_outline` | 大纲阶段后触发 |
| `manual` | 仅通过 `subagent.dispatch` 工具手动触发 |

**并行执行规则**：同一 `trigger` 下 `parallel: true` 的子代理会并行执行；`parallel: false` 的按声明顺序串行执行。

### 6.3 子代理定义示例

子代理本身也是一个标准的 Agent YAML 文件。例如 `agents/critic-realism.yaml`：

```yaml
name: critic-realism
displayName: 逻辑审查员
description: 审查叙事文本的逻辑一致性和上下文连贯性。

systemPrompt: |
  你是一个逻辑审查员。审查给定的叙事文本，检查：
  - 逻辑一致性：事件因果关系是否成立
  - 上下文连贯：与已有剧情是否矛盾
  - 时间线：时间推进是否合理

  输出格式：
  1. 问题列表（如有）
  2. 严重程度（高/中/低）
  3. 修改建议

tools:
  - memory.recall
  - state.read

context:
  historyLimit: 5

maxSteps: 5
```

### 6.4 手动调度子代理

当 `trigger: manual` 时，主 Agent 可以通过 `subagent.dispatch` 工具按需调度：

```json
// LLM 调用 subagent.dispatch
{
  "name": "subagent.dispatch",
  "arguments": {
    "agent": "parallel-line",
    "task": "生成一条与当前主线平行的暗线事件，发生在主角休息期间",
    "await": true
  }
}
```

### 6.5 执行流程

`AgentRunner._triggerSubAgents()` 的执行逻辑：

1. 筛选 `trigger === 'after_draft'` 的子代理
2. 将 `parallel: true` 的分为一组，`Promise.allSettled` 并行执行
3. 将 `parallel: false` 的按声明顺序串行执行
4. 收集所有结果，返回给主 Agent

子代理的任务文本固定为 `审查以下内容:\n${主Agent输出}`。

---

## 7. 记忆系统

### 7.1 四层记忆

记忆引擎管理四类记忆文件，存放在 `data/plugins/agent-framework/memory/` 目录：

| 类型 | 文件 | 用途 |
|------|------|------|
| `project` | `project.md` | 剧情进度：当前主线、关键事件、角色关系 |
| `reference` | `reference.md` | 参考信息：世界观设定、名词解释、背景资料 |
| `feedback` | `feedback.md` | 用户偏好：文风喜好、避雷项、创作反馈 |
| `user` | `user.md` | 用户设定：用户扮演的角色、偏好、习惯 |

### 7.2 记忆注入

在 Agent YAML 的 `context.injectFiles` 中声明要注入的记忆文件：

```yaml
context:
  injectFiles:
    - "memory/project.md"       # 剧情记忆
    - "memory/reference.md"     # 参考信息
    - "memory/feedback.md"      # 用户偏好
```

这些文件内容会被拼接到 system prompt 中，用 `---` 分隔。

### 7.3 记忆检索

`memory.recall` 工具按段落分割记忆文件，做简单关键词匹配：

```json
// LLM 调用 memory.recall 检索"王城 战斗"
{
  "name": "memory.recall",
  "arguments": {
    "query": "王城 战斗",
    "limit": 5
  }
}
```

返回匹配的段落及其所属记忆类型。

### 7.4 自动摘要

框架支持每 N 轮自动生成剧情摘要（通过插件配置 `summaryInterval` 控制，默认 10 轮）：

```javascript
// 在 plugin.json 中配置
{
    "config": {
        "summaryInterval": {
            "type": "number",
            "default": 10,
            "description": "每N轮自动生成剧情摘要（0=禁用）"
        }
    }
}
```

摘要生成流程：
1. `MemoryEngine.shouldSummarize(turnCount)` 检查是否到达间隔
2. 取最近 20 条对话记录
3. 调用 LLM（temperature=0.3）生成不超过 300 字的摘要
4. 写入 `memory/project.md`（覆盖）

设为 `0` 可禁用自动摘要。

### 7.5 手动更新记忆

LLM 可通过 `memory.update` 工具主动更新记忆：

```json
{
  "name": "memory.update",
  "arguments": {
    "type": "project",
    "content": "## 当前剧情\n主角已抵达王城，准备参加晚宴。\n\n## 关键事件\n- 在城门口遇到了神秘旅人\n- 获得了一封匿名信"
  }
}
```

---

## 8. 状态引擎

### 8.1 状态 vs 记忆

| 特性 | 状态引擎 | 记忆系统 |
|------|---------|---------|
| 数据结构 | 键值对（任意 JSON 值） | Markdown 文本 |
| 隔离方式 | 按 `platform:chatId` | 全局共享 |
| 用途 | 结构化游戏状态（时间、位置、属性） | 叙事性记忆 |
| 读取方式 | `state.read(key)` 精确读取 | `memory.recall(query)` 关键词检索 |

### 8.2 状态读写

```json
// 写入状态
{ "name": "state.write", "arguments": { "key": "location", "value": "王城大殿" } }

// 读取单个状态
{ "name": "state.read", "arguments": { "key": "location" } }

// 读取全部状态
{ "name": "state.read", "arguments": {} }

// 列出所有状态键
{ "name": "state.list", "arguments": {} }
```

### 8.3 状态持久化

状态按会话隔离，持久化到 JSON 文件：

```
data/plugins/agent-framework/states/
├── qq_123456.json       # QQ 群 123456 的状态
├── telegram_789012.json  # Telegram 会话 789012 的状态
└── discord_345678.json   # Discord 频道 345678 的状态
```

文件名由 `platform:chatId` 经过安全化处理（非字母数字替换为 `_`）生成。

### 8.4 典型状态结构

以下是一个导演模式 Agent 可能维护的状态结构：

```json
{
  "time": "第三天傍晚",
  "scene": "王城大殿-晚宴",
  "characters": {
    "主角": { "location": "大殿", "status": "警惕", "inventory": ["匕首", "匿名信"] },
    "国王": { "location": "王座", "status": " suspicious", "mood": "疑虑" },
    "侍女": { "location": "角落", "status": "normal" }
  },
  "flags": {
    "met_king": true,
    "has_letter": true,
    "alarm_triggered": false
  },
  "tension": 7
}
```

### 8.5 状态驱动叙事

导演模式的核心工作流：

```
1. state.read() → 了解当前状态
2. 根据用户大方向，决定状态变化
3. state.write() → 更新状态
4. 基于新状态生成叙事正文
```

这种方式确保叙事严格基于状态，而非 LLM 的"自由发挥"。

---

## 9. ctx.agent API

声明了 `"agent"` 权限的插件可以通过 `ctx.agent` 访问 Agent 框架服务。

### 9.1 registerTool

注册自定义工具到全局工具注册表：

```javascript
async onLoad() {
    // 通过 ctx 在命令处理器中访问
    // 或在插件加载时通过 services 获取
}

async handleSomeCommand(ctx) {
    ctx.agent.registerTool({
        name: 'dice.roll',
        description: '掷骰子',
        parameters: {
            type: 'object',
            properties: {
                sides: { type: 'number', description: '骰子面数' }
            },
            required: ['sides'],
        },
        handler: async (args) => {
            return { result: Math.ceil(Math.random() * args.sides) };
        },
    });
    ctx.reply('✅ dice.roll 工具已注册');
}
```

注册后，所有 Agent 都可在 `tools` 白名单中引用 `dice.roll`。

### 9.2 dispatch

调度子代理执行任务：

```javascript
async handleResearch(ctx) {
    const result = await ctx.agent.dispatch(
        'researcher',                          // 子代理名称
        '调查魔法体系中元素互克关系的设定',    // 任务描述
        { /* options */ }
    );

    if (result.error) {
        ctx.reply(`❌ 子代理执行失败: ${result.error}`);
    } else {
        ctx.reply(`📝 调查结果:\n${result.text}`);
    }
}
```

### 9.3 registerAgent

动态注册 Agent 定义（不经过 YAML 文件）：

```javascript
async handleQuickAgent(ctx) {
    ctx.agent.registerAgent({
        name: 'quick-narrator',
        displayName: '快速叙事',
        systemPrompt: '你是一个叙事者。',
        tools: ['state.read', 'memory.recall'],
        context: { historyLimit: 10 },
    });
    ctx.reply('✅ quick-narrator Agent 已注册');
}
```

### 9.4 getStatus

获取框架运行状态：

```javascript
async handleStatus(ctx) {
    const status = ctx.agent.getStatus();
    // status.activeAgents: 当前运行中的 Agent 列表
    // status.totalRuns: 总执行次数
    ctx.reply(`活跃Agent: ${status.activeAgents.length}, 总执行: ${status.totalRuns}`);
}
```

---

## 10. 从 ST 卡片迁移

### 10.1 角色卡迁移

ST 角色卡（Character Card）无需手动迁移。框架的 `ContextBuilder._injectAssets()` 会自动读取角色卡 JSON 并注入以下字段：

| 角色卡字段 | 注入标签 |
|-----------|---------|
| `description` | `【角色描述】` |
| `personality` | `【性格】` |
| `scenario` | `【场景】` |
| `mes_example` | `【对话示例】` |

只需在 Agent YAML 中配置：

```yaml
context:
  injectAssets:
    character: "${character}"
```

然后启动时指定角色卡名称：

```
/agent run my-agent
```

角色卡文件应放在 `assets/characters/` 目录下（.json 格式）。

### 10.2 世界书迁移

世界书同样自动注入。`ContextBuilder` 会读取 `entries` 中所有有 `content` 和 `key` 的条目，用 `---` 分隔拼接。

```yaml
context:
  injectAssets:
    worldbook: "${worldbook}"
```

世界书文件放在 `assets/worldbooks/` 目录下。

### 10.3 Prompt 迁移

将 ST 的正则注入、预设 prompt 迁移为 Agent YAML 的 `systemPrompt`：

**ST 预设（示例）**：
```
你是{{char}}。你的性格是{{personality}}。
当前场景：{{scenario}}
```

**迁移为 Agent YAML**：
```yaml
systemPrompt: |
  你是${character}。
  当前场景由角色卡注入。
  
  规则：
  - 保持角色一致性
```

变量 `${character}` 会在运行时替换为角色卡名称。

### 10.4 MVU / 状态迁移

如果你之前使用 MVU（Model-View-Update）JSON Patch 管理状态，迁移方式：

**MVU 方式（旧）**：
```
[State]
{"location": "王城", "time": "白天"}
[Update]
{"time": "夜晚"}
```

**Agent 框架方式（新）**：
```
LLM 调用 state.write("time", "夜晚")
LLM 调用 state.read("location") → "王城"
```

状态引擎的优势：
- LLM 通过函数调用显式管理状态，不需要在 prompt 中塞 JSON
- 状态持久化到文件，重启不丢失
- 按会话隔离，多群互不干扰

---

## 11. 示例

### 11.1 简单 RP Agent

参见模板文件 `templates/simple-rp.yaml`。特点：
- 单 Agent，无子代理
- 使用角色卡 + 世界书 + 记忆
- 支持文风加载
- 支持选项输出

### 11.2 多审查流水线

参见模板文件 `templates/multi-critic.yaml`。特点：
- GM 主控 + 4 个 Critic 子代理
- 多阶段流水线：大纲 → 草稿 → 审查 → 成品
- Critic-Realism（逻辑审查）/ Critic-Character（防OOC）/ Critic-Detail（细节审查）/ Critic-Style（杀八股）

使用前需创建 4 个子代理 YAML 文件（`agents/critic-realism.yaml` 等）。

### 11.3 导演模式

参见模板文件 `templates/director-mode.yaml`。特点：
- 导演模式：控制所有角色，用户给大方向
- 状态引擎：用工具管理状态
- 子代理：后台导演组（parallel-line + timeline-showrunner）
- 角色独立行动

### 11.4 自定义工具集成

以下示例展示一个插件如何向 Agent 框架注册自定义工具：

```javascript
// plugins/my-tools/index.js
import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class MyToolsPlugin extends GatewayPlugin {
    static commands = [{
        name: 'register-tools',
        handler: 'handleRegister',
        description: '注册自定义工具到Agent框架',
    }];

    async handleRegister(ctx) {
        // 注册一个掷骰工具
        ctx.agent.registerTool({
            name: 'dice.roll',
            description: '掷骰子，返回1到指定面数的结果',
            parameters: {
                type: 'object',
                properties: {
                    sides: { type: 'number', description: '骰子面数（默认6）' },
                    count: { type: 'number', description: '骰子数量（默认1）' },
                },
            },
            handler: async (args) => {
                const sides = args.sides || 6;
                const count = args.count || 1;
                const rolls = [];
                for (let i = 0; i < count; i++) {
                    rolls.push(Math.ceil(Math.random() * sides));
                }
                return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
            },
        });

        ctx.reply('✅ dice.roll 工具已注册。在Agent YAML的tools中添加 "dice.roll" 即可使用。');
    }
}
```

对应的 `plugin.json`：

```json
{
    "name": "my-tools",
    "displayName": "自定义工具",
    "version": "1.0.0",
    "main": "index.js",
    "enabled": true,
    "permissions": ["agent"],
    "dependencies": ["agent-framework"]
}
```

---

## 12. 故障排除

### 12.1 Agent 启动失败

**问题**：`/agent run` 提示 Agent 不存在

**排查**：
1. 确认 YAML 文件在 `data/plugins/agent-framework/agents/` 目录下
2. 确认文件扩展名是 `.yaml` 或 `.yml`
3. 确认 YAML 中有 `name` 字段
4. 用 `/agent list` 查看已加载的 Agent

### 12.2 工具调用失败

**问题**：LLM 回复 "工具不存在" 或 "工具执行失败"

**排查**：
1. 用 `/agent status` 查看已注册工具数量
2. 确认 Agent YAML 的 `tools` 白名单中的工具名拼写正确（如 `state.read` 不是 `state_read`）
3. 检查工具参数是否符合 schema 定义

### 12.3 子代理不触发

**问题**：主 Agent 生成草稿后没有调用子代理

**排查**：
1. 确认子代理 YAML 文件已创建（在 `agents/` 目录下，`name` 字段与 `subAgents` 中声明的一致）
2. 确认 `trigger` 值正确（目前支持 `after_draft`）
3. 检查框架日志中是否有子代理调度记录

### 12.4 角色卡/世界书未注入

**问题**：Agent 回复中似乎没有读取角色卡内容

**排查**：
1. 确认角色卡文件在 `assets/characters/` 目录，世界书在 `assets/worldbooks/` 目录
2. 确认文件格式为 `.json`
3. 确认 `injectAssets` 中的变量名正确（`character` / `worldbook`）
4. 角色卡 JSON 需包含 `description` / `personality` / `scenario` / `mes_example` 中的至少一个

### 12.5 记忆文件未注入

**问题**：Agent 似乎没有读取记忆

**排查**：
1. 确认 `context.injectFiles` 中列出的文件路径正确（相对于 `data/plugins/agent-framework/`）
2. 确认文件存在且非空
3. 文件路径中的 `${style}` 变量需要会话中有对应值（通过 `/agent run` 时从 `injectAssets` 提取）

### 12.6 YAML 解析错误

**问题**：Agent 定义加载失败

**排查**：
1. 检查 YAML 缩进是否一致（建议用空格，不用 Tab）
2. 多行字符串使用 `|`（保留换行）或 `>`（折叠换行）
3. 解析器基于 js-yaml 4.x，支持锚点/别名/合并键/流式语法；非法 YAML 会自动回退简易解析

### 12.7 性能问题

**问题**：Agent 回复很慢

**排查**：
1. 检查 `maxSteps` 是否过大（默认 10，建议不超过 20）
2. 子代理过多会增加 LLM 调用次数，审查类建议不超过 4 个
3. `historyLimit` 过大会增加 token 消耗，建议 10-20
4. 用 `/agent status` 查看执行耗时

---

## 13. 表现层抽象 ctx.surface

> 对应 spec `design-agent-platform` Task 1/2/3/4。把"引擎产出"与"界面渲染"解耦，一套 Agent 引擎驱动 IM / ST / Native 三套界面。

### 13.1 AgentRunResult 数据契约

Agent 一次 run 完成后产出 `AgentRunResult`（`server/agent/run-result.js`），由表现层适配器消费：

| 字段 | 类型 | 说明 |
|------|------|------|
| `artifacts` | `Array<{id?,type?,text}>` | 正文 / 大纲 / 草稿等产物 |
| `options` | `Array<{label,text,callbackId?}>` | 玩家行动选项 |
| `state` | `{visible,private}` | 本轮状态快照（可见层 + 私有层） |
| `events` | `Array<{type,payload,seq}>` | 本轮事件流（工具调用 / 子代理 / 状态变更） |
| `meta` | `{viewMode,style,turn,referencedMemory}` | 视角模式 / 文风 / 轮次 / 引用记忆 |

```js
import { AgentRunResult, AgentEventType } from '../../server/agent/run-result.js';
const result = AgentRunResult.fromRunResult('正文…', 3, 'run-123', { viewMode: 'actor', turn: 5 });
result.addEvent(AgentEventType.TOOL_CALL, { tool: 'state.write', args: { scene: '酒馆' } });
```

### 13.2 注册表现层适配器

插件在 `onLoad()` 中通过 `ctx.surface.register(adapter)` 注册适配器（需声明 `surface` 权限）：

```js
async onLoad() {
  this._unregister = ctx.surface.register({
    name: 'im-default',
    surfaceType: 'im',           // 'im' | 'st' | 'native' | 自定义
    async render(agentRunResult, ctx) {
      // 把 AgentRunResult 渲染为 IM 文字 + 选项 + 状态图
      return { ok: true };
    },
  });
}
async onUnload() { this._unregister?.(); }
```

### 13.3 主适配器 + 旁路适配器

一个会话可绑定**一个主适配器**（必调）+ **多个旁路适配器**（可选，互不影响）：

```js
await ctx.surface.dispatch(agentRunResult, ctx, {
  primarySurfaceType: 'im',          // 主渲染（IM 文字）
  bypassSurfaceTypes: ['native'],    // 旁路（推送到 Agent 剧场面板）
});
```

也可为会话绑定固定主适配器：`ctx.surface.bindPrimary(`${platform}:${chatId}`, 'im-default')`。

### 13.4 三套内置界面

| 界面 | 适配器/入口 | 说明 |
|------|--------|------|
| IM 增强 | `agent-rp`（`surfaceType: 'im'`） | 正文分段 + `>选项X：` 按钮（复用 option-splitter）+ 状态图（复用 message-to-image） |
| Agent 专用前端 | 独立页 `/agent`（`public/agent.html`） | 模块 B 改造后已从 ST 面板剥离：Agent 设置（折叠分组 + 统一保存）+ Agent 剧场（SSE 正文流/状态/时间线/AI 修改）；网关面板「Agent 前端」按钮或配置 `agentFrontendUrl` 访问 |

> 历史备注：早期 Agent 剧场曾内嵌于 ST 网关设置面板（`panel.html`），模块 B 改造已迁移至独立页面，ST 面板仅保留「Agent 前端」入口按钮。

---

## 14. Workspace + Journal（可审计可回滚）

> 对应 spec Task 5 / 借鉴 TauriTavern 的 Workspace-as-Truth。所有变更先写 run 级 workspace，commit 才 promote 到会话级稳定层，失败 / 取消不污染。

### 14.1 目录结构

```
data/plugins/agent-framework/
├── runs/<run-id>/
│   ├── manifest.json       run 元信息（agent / sessionId / tools）
│   ├── events.jsonl        append-only 事件流（seq 单调递增）
│   ├── output/             run 级产物（commit 时 promote）
│   ├── scratch/            run 级临时文件
│   └── checkpoints/<cp-id>/  关键节点快照
└── sessions/<session-id>/persist/  会话级稳定层（commit 合并目标）
```

### 14.2 事件流与 seq

每次工具调用 / 状态变更 / 子代理触发都 `appendEvent` 到 `events.jsonl`，seq 从 1 起单调递增。`getEvents(runId, { afterSeq, limit })` 供时间线 UI 重建。

**性能（SubTask 7.2）**：`appendEvent` 不每次 `fs.appendFileSync`，而是按 run 聚合到内存写入缓冲，每 100ms 或读取 / 检查点 / commit 前 flush。100 次 `appendEvent` 约 3ms（基准测试守护：`test/performance.test.js`）。

### 14.3 Checkpoint / Commit / Rollback

```js
// 关键节点自动 checkpoint（init / after-draft / before-commit）
ws.createCheckpoint(runId, 'after-draft');

// 成功才 commit：output/ promote 到会话级 persist/（合并覆盖）
const promoted = ws.commit(runId);  // ['state.json', 'inventory.json']

// 失败 / 取消 rollback：从 checkpoint 恢复 output/，events.jsonl 保持 append-only
ws.rollback(runId, checkpointId);
```

### 14.4 多 Bot 协同（workspace 共享）

多个 bot 绑定不同 Agent Profile，但用**同一 sessionId** 调 `ctx.agent.run()`：每次 run 各自隔离，但 `commit` 都 promote 到同一 `sessions/<sessionId>/persist/`，实现状态共享。需声明 `agent` + `workspace` 权限。

---

## 15. 权限扩展（surface / workspace / agent）

> 对应 spec Task 7.3。三项权限均**非默认授予**（`default: false`），未声明时调用即抛清晰错误。

| 权限 | risk | 说明 |
|------|------|------|
| `agent` | medium | 使用 Agent 框架（注册工具 / 调度子代理 / 触发 run） |
| `surface` | medium | 注册表现层适配器（消费 AgentRunResult 渲染到界面） |
| `workspace` | low | 跨插件共享 workspace（多 Bot 协同场景） |

`plugin.json` 声明示例（agent-rp）：

```json
{
  "permissions": ["llm", "fs", "assets", "gateway.inbound", "sessions", "agent", "surface", "workspace"]
}
```

**隔离规则**：
- 未声明 `surface` → `ctx.surface.register` 抛 `需要 "surface" 权限`
- 未声明 `agent` → `ctx.agent.run` / `registerTool` 抛 `需要 "agent" 权限`
- workspace 共享通过 `ctx.agent.run()` 触发，故 `agent` 是 workspace 共享的前置闸门
- 不同插件各自按自身权限收窄，互不影响（A 有 surface 不意味着 B 也有）

回归守护见 `test/permissions-surface-workspace.test.js`（23 项）。

---

## 16. 整合验证与性能（Task 7）

### 16.1 三界面端到端联调

同一 `AgentRunResult` 同时分发给 IM / ST / Native 三个适配器（主 + 旁路），验证表现层抽象不丢适配器、不重复调用。守护：`test/integration-multi-surface.test.js`。

### 16.2 性能基准

| 基准 | 阈值 | 守护测试 |
|------|------|----------|
| 100 次 `appendEvent` | < 200ms | `performance.test.js` |
| `dispatch` 单次（3 适配器） | < 20ms | 同上 |
| 10 客户端 SSE 广播 | < 50ms | 同上 |
| 100 轮综合 run | < 15s（回归告警，不强 fail） | 同上 |

关键优化：写入缓冲（批处理 IO）+ seq 内存计数器（不重读文件）+ `agent-runner` finally 块 `flushRun` 保证审计事件不丢。

### 16.3 与现有插件协同

| 插件 | 协同点 | 守护 |
|------|--------|------|
| `option-splitter` | `>选项X：` 格式契约（中/阿数字） | `plugin-coordination.test.js` |
| `message-to-image` | `ImageRenderer` 命名导出复用 + 降级文本 | 同上 |
| `rp-memory` | 过滤链无冲突（剥离 `<summary>` 不破坏选项行） | 同上 |
| `group-rp-bidding` | 命令空间隔离 + endMarker 不误匹配选项 | 同上 |

---

## 附录：相关文件

| 文件 | 说明 |
|------|------|
| `plugins/agent-framework/index.js` | 插件入口，命令路由和消息拦截 |
| `plugins/agent-framework/engine/agent-loader.js` | YAML 加载与解析 |
| `plugins/agent-framework/engine/agent-runner.js` | Agent 执行引擎 |
| `plugins/agent-framework/engine/tool-registry.js` | 工具注册表 |
| `plugins/agent-framework/engine/subagent-dispatcher.js` | 子代理调度器 |
| `plugins/agent-framework/engine/state-manager.js` | 状态管理器 |
| `plugins/agent-framework/engine/memory-engine.js` | 记忆引擎 |
| `server/agent/context-builder.js` | 上下文构建器 |
| `server/agent/pipeline.js` | 多阶段流水线引擎 |
| `server/agent/run-result.js` | AgentRunResult 数据契约（artifacts/options/state/events/meta） |
| `server/agent/surface-manager.js` | 表现层调度器（主 + 旁路适配器） |
| `server/agent/theatre-broadcaster.js` | SSE 广播器（AgentRunResult 推送到面板） |
| `plugins/agent-framework/engine/workspace-manager.js` | Workspace + Journal（可审计可回滚） |
| `plugins/agent-framework/templates/` | Agent 模板文件 |

**Task 7 测试文件**：

| 测试文件 | 覆盖 |
|----------|------|
| `test/integration-multi-surface.test.js` | 三界面端到端联调（SubTask 7.1） |
| `test/performance.test.js` | 性能基准：写入缓冲 / dispatch / SSE（SubTask 7.2） |
| `test/permissions-surface-workspace.test.js` | surface/workspace/agent 权限隔离（SubTask 7.3） |
| `test/plugin-coordination.test.js` | 与现有插件协同验证（SubTask 7.4） |
