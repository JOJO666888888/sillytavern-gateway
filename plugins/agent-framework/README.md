# Agent 框架

> SillyTavern Gateway 内置的多 Agent 叙事框架。用 YAML 定义 Agent 工作流，支持角色卡、世界书、记忆、状态引擎和子代理调度。

## 简介

Agent 框架让你在聊天平台（QQ / Telegram / Discord 等）上运行结构化的叙事 Agent。无需写代码，只需编写一个 YAML 文件即可定义完整的 Agent 行为，包括：

- **工具调用**：15 个内置工具（状态、记忆、叙事、文件、Skill、子代理）
- **资产注入**：自动加载角色卡、世界书、文风文件
- **子代理流水线**：主 Agent 可触发多个子代理并行/串行执行
- **记忆系统**：四层记忆 + 自动摘要
- **状态引擎**：键值对式状态管理，替代 MVU JSON Patch

## 安装

Agent 框架是网关内置插件，无需额外安装。启用方式：

1. 打开网关配置文件或面板
2. 找到 `agent-framework` 插件
3. 将 `enabled` 设为 `true`

插件所需权限：`llm`、`fs`、`assets`、`agent`、`gateway.inbound`、`sessions`、`gateway.send`

## 快速开始

### 第 1 步：创建 Agent YAML

在 `data/plugins/agent-framework/agents/` 目录下创建 `.yaml` 文件，例如 `my-rp.yaml`：

```yaml
name: my-rp
displayName: 我的RP
description: 简单的角色扮演Agent。

systemPrompt: |
  你是一个叙事者。根据角色设定生成沉浸式的叙事文本。
  每轮回复不少于500字。
  末尾给出3个选项，用 >选项X：内容 的格式。

tools:
  - state.read
  - state.write
  - memory.recall
  - memory.update

context:
  historyLimit: 20
  injectAssets:
    character: "${character}"
    worldbook: "${worldbook}"
  injectFiles:
    - "styles/${style}.md"
    - "memory/project.md"
```

也可以从 `templates/` 目录复制现成模板进行修改。

### 第 2 步：启动 Agent

在聊天平台发送命令：

```
/agent run my-rp
```

看到 `✅ Agent "my-rp" 已启动` 后，Agent 模式已激活，后续消息会被框架拦截处理。

### 第 3 步：开始对话

直接发送消息即可。Agent 会自动调用工具、注入角色卡和世界书、生成叙事文本。

## 命令列表

| 命令 | 说明 |
|------|------|
| `/agent run <名称> [消息]` | 启动 Agent 并可选发送首条消息 |
| `/agent list` | 列出所有已加载的 Agent |
| `/agent status` | 查看框架状态（工具数、活跃 Agent、当前会话） |
| `/agent edit` | 编辑 Agent 定义（提示去面板或直接编辑文件） |
| `/agent help` | 显示帮助信息 |

## 目录结构

```
plugins/agent-framework/
├── index.js                  # 插件入口
├── plugin.json               # 插件配置
├── engine/                   # 核心引擎
│   ├── agent-loader.js       #   YAML 加载与解析
│   ├── agent-runner.js       #   Agent 执行引擎
│   ├── tool-registry.js      #   工具注册表
│   ├── subagent-dispatcher.js#   子代理调度器
│   ├── state-manager.js      #   状态管理器
│   └── memory-engine.js      #   记忆引擎
├── tools/                    # 内置工具
│   ├── state-tools.js        #   状态工具（state.read/write/list）
│   ├── memory-tools.js       #   记忆工具（memory.recall/update/read）
│   ├── narrative-tools.js    #   叙事工具（narrative.generate）
│   ├── file-tools.js         #   文件工具（file.read/write/list）
│   ├── skill-tools.js        #   Skill 工具（skill.load/list）
│   └── subagent-tools.js     #   子代理工具（subagent.dispatch/list）
└── templates/                # Agent 模板
    ├── simple-rp.yaml        #   简单RP模板
    ├── multi-critic.yaml     #   多审查流水线模板
    └── director-mode.yaml    #   导演模式模板

data/plugins/agent-framework/  # 运行时数据（自动创建）
├── agents/                   #   Agent YAML 定义
├── skills/                   #   Skill 文件（.md）
├── styles/                   #   文风文件（.md）
├── memory/                   #   记忆文件（project/reference/feedback/user.md）
└── states/                   #   会话状态文件（按 platform:chatId 隔离）
```

## 内置模板

| 模板 | 特点 | 适用场景 |
|------|------|---------|
| `simple-rp` | 单 Agent，角色卡+世界书+记忆+文风 | 入门 RP |
| `multi-critic` | GM + 4 个 Critic 子代理，四阶段流水线 | 严谨小说创作 |
| `director-mode` | 导演模式，状态引擎驱动，后台暗线子代理 | 复杂群像剧 |

将模板文件复制到 `data/plugins/agent-framework/agents/` 目录后即可通过 `/agent run` 启动。

## 完整文档

详细的开发者文档请参阅 [AGENT_FRAMEWORK_GUIDE.md](../../docs/AGENT_FRAMEWORK_GUIDE.md)，包含：

- 架构设计与执行流程
- Agent 定义格式完整参考
- 工具注册表（15 个内置工具）
- 子代理系统详解
- 记忆系统与自动摘要
- 状态引擎使用
- ctx.agent API
- 从 ST 卡片迁移指南
- 示例与故障排除
