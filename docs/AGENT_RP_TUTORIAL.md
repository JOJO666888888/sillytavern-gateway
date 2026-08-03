# Agent RP 使用教程

> 从入门到高阶开发，基于 SillyTavern Gateway Agent 平台的完整指南。
>
> 适用版本：Agent 框架 v0.2.x（`plugins/agent-framework/` + `plugins/agent-rp/`）

---

## 目录

### 第一部分 · 入门基础
1. [Agent RP 概念与核心价值](#1-agent-rp-概念与核心价值)
2. [安装与配置](#2-安装与配置)
3. [界面导航与核心功能](#3-界面导航与核心功能)
4. [首次使用：创建你的第一个 RP](#4-首次使用创建你的第一个-rp)
5. [术语表与概念体系](#5-术语表与概念体系)

### 第二部分 · 进阶应用
6. [核心功能深入](#6-核心功能深入)
7. [高级配置与参数优化](#7-高级配置与参数优化)
8. [多 Agent 协作模式](#8-多-agent-协作模式)
9. [应用场景案例与最佳实践](#9-应用场景案例与最佳实践)
10. [问题排查与故障处理](#10-问题排查与故障处理)

### 第三部分 · 高阶开发
11. [扩展开发框架](#11-扩展开发框架)
12. [自定义 Agent 开发规范](#12-自定义-agent-开发规范)
13. [架构设计原则](#13-架构设计原则)
14. [代码编写指南与示例](#14-代码编写指南与示例)
15. [调试、测试与部署](#15-调试测试与部署)
16. [性能优化与安全考量](#16-性能优化与安全考量)

### 第四部分 · 附录
17. [命令速查表](#17-命令速查表)
18. [API 接口文档](#18-api-接口文档)
19. [进阶学习资源](#19-进阶学习资源)
20. [社区支持与贡献](#20-社区支持与贡献)

---

# 第一部分 · 入门基础

## 1. Agent RP 概念与核心价值

### 1.1 什么是 Agent RP

Agent RP（Agent Role Play）是一种**以 Agent 引擎驱动的角色扮演方式**，区别于传统酒馆（SillyTavern）的"单次 LLM 调用"模型。

传统酒馆的工作方式是：用户发消息 → 模型生成一段文字 → 结束。模型不会主动查设定、不会管理状态、不会自我纠错。

Agent RP 的核心区别是引入了 **Agent Loop（工具循环）**：

```
用户发消息
  → Agent 读取状态（state.read）
  → Agent 检索记忆（memory.recall）
  → Agent 查阅世界书（worldbook.search）
  → Agent 生成正文（narrative.generate）
  → Agent 更新状态（state.write）
  → Agent 记录记忆（memory.update）
  → 返回结果
```

每一步都是真实的工具调用，模型基于工具返回的真实结果来叙事，而不是凭空猜测。

### 1.2 四大核心价值

| 价值 | 传统酒馆 | Agent RP |
|------|---------|----------|
| **叙事连贯** | 长对话易失忆，上下文丢失 | 四层记忆系统 + 历史归档，跨会话不失忆 |
| **逻辑严密** | 靠模型自觉，常有设定硬伤 | 领域工具校验 + Workspace 可审计，状态不漂移 |
| **角色生动** | 所有 NPC 塞同一上下文，易 OOC | 子代理上下文隔离 + 独立角色 namespace，认知隔离 |
| **文风优质** | AI 八股味难去除 | 文风 Skill 渐进式加载 + Critic 子代理杀八股 |

### 1.3 与传统酒馆的架构对比

```
传统酒馆：
  浏览器前端 ←→ LLM API（单次调用，无循环）

Agent RP（本平台）：
  IM/ST前端/专用前端 → 表现层适配器 → Agent引擎
                                         ↕
                              ┌──────────┼──────────┐
                           工具循环    记忆系统    状态引擎
                              ↕
                          Workspace + Journal（可审计可回滚）
```

本平台的关键架构优势：
- **多平台常驻**：QQ / Telegram / Discord / 飞书 / 钉钉同时在线
- **多会话独立**：每个 IM 会话绑定不同角色，互不干扰
- **无浏览器依赖**：自建推理管线，不需要挂着 SillyTavern 前端
- **引擎共享**：IM 聊天界面与 Agent 专用前端共享同一套 Agent 引擎

---

## 2. 安装与配置

### 2.1 环境要求

- Node.js 18+（推荐 20 LTS）
- 一个 LLM API 密钥（推荐 DeepSeek，也支持 OpenAI / Claude / Gemini）
- 一个聊天平台账号（QQ / Telegram / Discord 任选）

### 2.2 安装

```bash
cd d:\预设\sillytavern-gateway
npm install
```

### 2.3 基础配置

编辑 `.env` 文件（从 `.env.example` 复制）：

```bash
# LLM 配置（以 DeepSeek 为例）
LLM_PROVIDER=openai
LLM_API_KEY=sk-your-deepseek-key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat

# 网关配置
GATEWAY_PORT=3000
GATEWAY_TOKEN=your-gateway-token

# QQ 配置（OneBot v11 协议，如使用 NapCat）
QQ_BOT_ID=123456789
QQ_ACCESS_TOKEN=your-qq-token
```

### 2.4 启用 Agent 插件

在 `data/config.json` 中启用插件（首次启动会自动生成默认配置）：

```json
{
  "plugins": {
    "agent-framework": { "enabled": true },
    "agent-rp": { "enabled": true }
  }
}
```

启动网关：

```bash
npm start
```

看到日志 `Agent 框架插件已加载` 和 `Agent 角色扮演插件已加载` 即表示成功。

### 2.5 角色卡与资产准备

将你的 SillyTavern 角色卡（PNG 格式）放入 `assets/characters/`，世界书放入 `assets/worldbooks/`，预设放入 `assets/presets/`。

如果你没有现成角色卡，平台内置默认方案无需角色卡也能开玩。

---

## 3. 界面导航与核心功能

本平台提供三套界面，共享同一个 Agent 引擎：

### 3.1 IM 聊天界面（最常用）

在 QQ / Telegram / Discord 中直接使用命令交互：

```
你：/rp start
Bot：✅ RP 会话已启动（默认角色扮演，角色：未指定，第 0 轮）
     当前文风：default，视角模式：actor

你：我在一间陌生的房间里醒来，头痛欲裂。
Bot：[正文分段发送]
     >选项一：检查身上有什么东西
     >选项二：尝试回忆昨晚发生了什么
     >选项三：大声呼救
     >选项四：加速时间到当前事件结束
```

IM 界面特性：
- **正文分段**：长正文自动按段落切分逐条发送
- **选项按钮**：`>选项X：` 格式自动渲染为平台原生按钮（需 option-splitter 插件）
- **状态卡片**：每轮自动生成状态图（需 message-to-image 插件）

### 3.2 Agent 专用前端（独立页面 /agent）

模块 B 改造后，Agent 设置与 Agent 剧场已从 ST 网关设置面板剥离，独立为**不依赖 SillyTavern 的独立页面**：

- **入口**：网关面板（ST 顶部设置栏 → 多平台网关）中的「Agent 前端」按钮，或直接访问 `http://<网关地址>:<端口>/agent`。
- **独立页功能**：
  - **Agent 设置**：分类折叠面板（Agent 引擎 / Agent 前端 / IM 集成），统一保存到网关插件配置；引擎配置项（defaultMaxSteps / summaryInterval / memoryRetriever / embedderMode 等）与 IM 集成命令速查集中管理。
  - **Agent 剧场**：SSE 实时正文流、状态面板、事件时间线、AI 修改（plan/apply/undo），完整交互体验。
  - **连接配置**：页面内可独立配置网关地址与鉴权 Token（保存在浏览器 localStorage）。
- **自定义前端 URL**：在「Agent 设置 → Agent 前端」中可配置自定义访问 URL（需 `http://`/`https://`），点击「访问」在新标签打开；「验证」按钮检测 URL 格式与可访问性。留空则使用内置 `/agent` 页面。

### 3.3 核心功能模块一览

| 模块 | 功能 | 入口 |
|------|------|------|
| Agent Profile | 定义 Agent 行为的 YAML 配置 | `templates/*.yaml` |
| 工具注册表 | 15 个内置工具 + 第三方扩展 | `engine/tool-registry.js` |
| 记忆系统 | 四层记忆 + 自动摘要 + namespace 隔离 | `engine/memory-engine.js` |
| 状态引擎 | 键值对状态管理 + 领域校验 | `engine/state-manager.js` |
| 子代理调度 | 并行/串行子代理 + 上下文隔离 | `engine/subagent-dispatcher.js` |
| Workspace | run 级隔离 + events.jsonl + checkpoint | `engine/workspace-manager.js` |
| 表现层 | IM / ST / Native 三适配器 | `server/agent/surface-manager.js` |

---

## 4. 首次使用：创建你的第一个 RP

### 4.1 最快上手（零配置）

如果你不想做任何配置，直接在 IM 平台发：

```
/rp start
```

平台会自动加载默认方案（`default-rp.yaml`），包含：
- 一个 GM Agent（负责叙事推进）
- 一个 Critic-Character 子代理（自动审查防 OOC）
- 默认四层记忆模板
- 默认去八股文风

然后直接发消息开始扮演：

```
你：/rp start
Bot：✅ RP 会话已启动

你：我叫林夕，是一个刚毕业的大学生，今天第一天到新公司报到。
Bot：七月的阳光毫不留情地砸在柏油路上...
     [正文 + 选项]
```

### 4.2 使用角色卡

如果你有 SillyTavern 角色卡：

```
/rp start 艾莉娅
```

平台会从 `assets/characters/` 加载角色卡 `艾莉娅.png`，解析其中的 description、personality、scenario、first_mes 等字段注入 Agent 上下文。

### 4.3 切换视角模式

```
/rp mode director
```

- **actor 模式**：你控制主角，Agent 控制 NPC 和环境
- **director 模式**：Agent 控制所有角色，你只给大方向

### 4.4 切换文风

```
/rp style dark-fantasy
```

平台会从 `data/plugins/agent-rp/styles/dark-fantasy.md` 加载文风 Skill，注入 Agent 上下文。内置默认文风 `default`（去八股）。

### 4.5 管理记忆

```
/rp skill list        # 查看已加载的 skill
/rp skill load combat # 加载战斗描写 skill
/rp skill unload combat
/rp skill clear       # 清空所有 skill
```

记忆文件在 `data/plugins/agent-rp/memory/` 下，你可以手动编辑：
- `project.md` — 剧情进度、下一阶段方向（每轮自动更新）
- `reference.md` — 文件位置索引、角色卡路径
- `feedback.md` — 用户偏好、踩过的坑
- `user.md` — 用户角色设定

### 4.6 结束会话

```
/rp stop
```

会话状态会保存，下次 `/rp start` 可以继续。

### 4.7 完整首次流程示例

```
# 1. 启动
/rp start

# 2. 设定你的角色
我是周远，28岁，刑警，刚调到这个城市。

# 3. Agent 生成正文 + 选项，你选择
>选项二：先去案发现场看看

# 4. 持续交互...
（正常对话即可，Agent 会自动调用工具管理状态和记忆）

# 5. 想换个文风
/rp style hardboiled

# 6. 想让 Agent 控制所有角色
/rp mode director

# 7. 结束
/rp stop
```

---

## 5. 术语表与概念体系

| 术语 | 解释 |
|------|------|
| **Agent** | 一个可执行工具循环的 AI 实体，由 YAML Profile 定义 |
| **Profile** | Agent 的配置文件（YAML），定义 systemPrompt、工具白名单、上下文策略等 |
| **Agent Loop** | Agent 的执行循环：调工具 → 看结果 → 再调工具 → ... → 产出正文 |
| **工具（Tool）** | Agent 可调用的函数，如 `state.read`、`memory.recall` |
| **子代理（SubAgent）** | 由主 Agent 触发的辅助 Agent，有独立上下文，用于审查/脑暴等 |
| **Workspace** | 每次 Agent run 的隔离工作区，记录所有变更，可审计可回滚 |
| **Journal** | append-only 事件日志（events.jsonl），记录每次工具调用和状态变更 |
| **Checkpoint** | workspace 快照，可回滚到之前的状态 |
| **记忆（Memory）** | 四层结构：project（剧情）/ reference（参考）/ feedback（偏好）/ user（用户） |
| **状态（State）** | 键值对式会话状态，替代 MVU 的 JSON Patch |
| **Skill** | 外置的 markdown 文件（文风/知识/规则），按需加载，省 token |
| **表现层（Surface）** | 把 Agent 输出渲染到不同界面的适配器（IM / ST / Native） |
| **AgentRunResult** | Agent 一次 run 的结构化输出（artifacts + options + state + events） |
| **namespace** | 记忆/状态的隔离命名空间，用于独立角色模式的认知隔离 |
| **OOC** | Out Of Character，角色崩人设 |
| **MVU** | Magic Variable Update，酒馆的变量管理方式（本平台用领域工具替代） |

---

# 第二部分 · 进阶应用

## 6. 核心功能深入

### 6.1 角色设定体系

Agent RP 的角色设定不只是角色卡里的 description，而是一个分层体系：

**第一层：角色卡（assets/characters/）**
SillyTavern 格式的 PNG 角色卡，包含人设、性格、场景、开场白。Agent 通过 `character.read` 工具按需读取。

**第二层：记忆中的角色认知（memory/）**
角色卡是第三人称客观设定，记忆是角色自己的第一人称认知。例如：

```
角色卡（客观）：父亲为跨国企业高管，控制欲极强。

记忆（第一人称）：父亲控制欲极强，干涉我的一切选择。
15岁时我喜欢上了一个男孩，父亲知道后直接用商业手段逼他一家离开加州。
```

你可以手动把角色卡设定改写为第一人称写入 `memory/project.md`，让角色更"活"。

**第三层：文风 Skill（styles/）**
角色的说话风格、描写风格。例如 `styles/hardboiled.md` 定义硬汉派文风：
- 短句为主，不用华丽修辞
- 对话干脆，不解释内心
- 环境描写克制，只写关键细节

### 6.2 交互流程设计

Agent RP 的交互流程由 Profile 的 `systemPrompt` 定义。默认流程：

```
1. state.read     → 读取当前状态（时间、地点、在场角色）
2. memory.recall  → 检索相关记忆（伏笔、前情）
3. character.read → 按需查阅角色卡
4. 撰写正文        → 不少于 600 字，含场景/动作/对话/心理
5. state.write    → 更新状态变化
6. memory.update  → 记录重要进展
7. 输出选项        → 3-4 个有代价的选项
```

你可以通过自定义 Profile 改变这个流程。例如加入"先写大纲再写正文"：

```yaml
systemPrompt: |
  工作流程：
  1. 读取状态和记忆
  2. 先写本轮大纲（100字内，列出场景目标、价值逆转点）
  3. 根据大纲生成正文
  4. 更新状态和记忆
```

### 6.3 场景构建

场景信息存储在 State 中，分为 visible（所有角色可见）和 private（仅特定角色可见）：

```json
{
  "visible": {
    "当前时间": "傍晚 18:25",
    "地点": "实验室走廊",
    "天气": "阴天",
    "在场角色": ["林夕", "陈博士"]
  },
  "private": {
    "林夕": { "情绪": "紧张", "手持": "手机" },
    "陈博士": { "秘密": "知道林夕的真实身份" }
  }
}
```

Agent 通过 `state.read` 读取这些信息来保持场景一致性。private 层实现认知隔离——林夕不知道陈博士的秘密。

### 6.4 记忆系统深入

四层记忆各有不同更新频率和用途：

| 层 | 文件 | 内容 | 更新频率 |
|----|------|------|---------|
| project | `memory/project.md` | 剧情进度、下一阶段方向、伏笔清单 | 每轮 |
| reference | `memory/reference.md` | 文件位置索引、角色卡路径 | 几乎不变 |
| feedback | `memory/feedback.md` | 用户偏好、踩过的坑、禁忌 | 偶尔 |
| user | `memory/user.md` | 用户角色设定 | 低频 |

自动摘要：每 10 轮（可配置）自动调用 LLM 生成剧情摘要，追加到 project.md，防止记忆膨胀。

手动编辑记忆：直接编辑 markdown 文件即可，下次 Agent run 会自动读取。

### 6.5 状态引擎与领域工具

状态优先原则：Agent 应**先通过工具改变状态，再根据状态变化叙事**，而非先叙事再补状态。

```
✅ 正确：state.write(地点, 车内) → 叙事"林夕坐进车里"
❌ 错误：叙事"林夕坐进车里" → state.write(地点, 车内)
```

领域工具带校验，防止状态漂移：
- 不存在的角色不能受伤
- 钱包 id 错误会打回（列出可用钱包）
- 未结束的场景不能推进时间

工具报错具体可读，Agent loop 会自动重试修正。

---

## 7. 高级配置与参数优化

### 7.1 模型参数调优

在 Profile YAML 中配置：

```yaml
model:
  provider: openai          # openai / claude / gemini
  model: deepseek-chat
  temperature: 0.85         # 创造性（0.7-0.9 适合 RP）
  maxTokens: 4096           # 单次最大输出
```

参数建议：
- **temperature**：叙事 RP 用 0.8-0.9；逻辑严密场景用 0.6-0.7
- **maxTokens**：正文 + 选项至少 4096；多 Agent 协作场景 8192
- **maxSteps**：工具循环上限，简单 RP 用 8-10；多 Critic 流水线用 15-20

### 7.2 上下文策略

```yaml
context:
  historyLimit: 20          # 带入的历史轮数（太多吃 token，太少易失忆）
  injectAssets:
    character: "${character}"
    worldbook: "${worldbook}"
  injectFiles:
    - "styles/${style}.md"
    - "memory/project.md"
    - "memory/reference.md"
```

优化技巧：
- 角色卡和世界书**不要全量注入**，让 Agent 用 `character.read` / `worldbook.search` 按需查
- 文风文件放在 `injectFiles` 里（通常 1000-2000 字）
- `historyLimit` 根据模型上下文窗口调整（DeepSeek 64K 可设 30-40）

### 7.3 Skill 渐进式加载

把大段设定/文风拆成多个 Skill 文件，按需加载，省 token：

```
data/plugins/agent-rp/styles/
  default.md          # 基础去八股（默认加载）
  hardboiled.md       # 硬汉派
  dark-fantasy.md     # 黑暗奇幻
  combat.md           # 战斗描写
  romance.md          # 情感描写
```

```
/rp style hardboiled   # 只加载硬汉派，卸载 default
/rp skill load combat  # 额外加载战斗描写
```

### 7.4 视角模式优化

两种视角模式的适用场景：

| 模式 | 控制 | 适合场景 |
|------|------|---------|
| actor | 用户控制主角，Agent 控制 NPC/环境 | 沉浸式 RP、恋爱模拟、冒险 |
| director | Agent 控制所有角色 | 群像剧、宏大叙事、快速推进剧情 |

---

## 8. 多 Agent 协作模式

### 8.1 多 Critic 审查流水线

源自社区实践的最高质量方案。使用 `multi-critic.yaml` 模板：

```
/rp profile multi-critic
/rp start 艾莉娅
```

工作流程：
```
GM 编写细纲
  → Critic-Realism（查逻辑一致性）    ┐
  → Critic-Character（防 OOC）         ├─ 并行审查
  → Critic-Detail（抓物理细节）        │
  → Critic-Style（杀八股）             ┘
GM 根据审查意见修改 → 输出成品
```

四个 Critic 各有独立上下文，只看到审查所需的信息（认知隔离）。

### 8.2 导演模式

使用 `director-mode.yaml` 模板，Agent 控制所有角色：

```
/rp profile director-mode
/rp start
```

适合群像剧——你给大方向，Agent 编排所有角色的行动和对话。

### 8.3 状态引擎模式

使用 `state-engine.yaml` 模板，适合复杂系统的长线沙盒：

```
/rp profile state-engine
/rp start
```

特性：
- 状态优先：先改状态再叙事
- 后台导演组子代理：`parallel-line`（幕后线候选）、`timeline-showrunner`（审计剧情停滞）
- 领域工具校验：防止状态漂移

### 8.4 独立角色模式（最高阶）

使用 `independent-character.yaml` 模板，实现真正的认知隔离：

```
/rp profile independent-character
/rp start
```

每个角色是独立的子代理，拥有：
- **独立记忆 namespace**（`char:alice` / `char:bob`，互不可见）
- **第一人称认知**（"你就是角色本人"，不知道 GM/剧情存在）
- **独立行动循环**（observe → recall → act → memorize → wait）

认知隔离效果：角色 A 注意到角色 B 今天穿得不一样，角色 B 对 A 的想法一无所知。除非他们聊过、观察过、记下来过。

### 8.5 群聊多 Bot 协同

在群聊中，多个 bot 各绑定不同 Profile，共享 workspace：

```
/rp bindbot 111111 GM         # bot 111111 演旁白
/rp bindbot 222222 艾莉娅      # bot 222222 演角色艾莉娅
/rp bindbot 333333 陈博士      # bot 333333 演角色陈博士
```

每个 bot 收到消息时用各自的 Profile 触发 Agent run，但共享同一个 workspace（通过 `workspace` 权限）。

解绑：`/rp unbindbot 222222`

---

## 9. 应用场景案例与最佳实践

### 9.1 案例：长线悬疑 RP

**场景**：一个持续数十轮的悬疑故事，需要严密的逻辑和伏笔管理。

**配置**：
```yaml
# 使用 multi-critic 模板，开启 4 个 Critic
/rp profile multi-critic
/rp start 侦探

# 优化记忆
# 手动编辑 memory/project.md，维护伏笔清单：
# - [伏笔] 第3轮出现的神秘电话（未揭晓）
# - [伏笔] 第7轮死者口袋里的钥匙（未揭晓）
```

**最佳实践**：
- 每隔 10 轮检查 `memory/project.md`，确保伏笔清单完整
- 用 Critic-Realism 审查逻辑一致性
- 长线 RP 中 `historyLimit` 设 30+，避免遗忘早期事件

### 9.2 案例：群像剧

**场景**：多个角色各有立场，互相博弈。

**配置**：
```yaml
# 使用独立角色模式
/rp profile independent-character

# 每个角色独立记忆，互不知道对方秘密
# Agent 布置场景后，角色自主行动
```

**最佳实践**：
- 用 `state.private` 存储各角色的秘密（认知隔离）
- 不要让 Agent 替角色做决定，用环境旁白引导
- 记忆植入：在关键剧情前，往角色记忆写入相关经历，引导其自然反应

### 9.3 案例：战斗系统 RP

**场景**：有骰子/属性/伤害计算的战斗。

**配置**：
```yaml
# 使用 state-engine 模板
/rp profile state-engine

# 在 Profile 中加入战斗领域工具
tools:
  - state.read
  - state.write
  - condition.apply    # 施加状态（受伤/中毒/增益）
  - economy.spend      # 消耗资源（法力/道具）
  - scene.finish       # 结束当前场景
```

**最佳实践**：
- 状态优先：先算伤害（condition.apply），再叙事
- 让工具校验防止"幽灵伤害"（不存在的角色不能受伤）

---

## 10. 问题排查与故障处理

### 10.1 Agent 不调用工具

**症状**：Agent 直接输出正文，不调 state.read / memory.recall 等。

**原因**：模型不够"听话"，或 Profile 的 systemPrompt 没强调工具使用。

**解决**：
- 在 systemPrompt 开头加："你必须按工作流程调用工具，不调用工具直接输出正文是违规的"
- 换一个工具调用更稳定的模型（推荐 DeepSeek）
- 降低 temperature 到 0.7

### 10.2 状态漂移

**症状**：Agent 叙事说角色在车里，但 state 里地点还是办公室。

**原因**：Agent 先叙事后补状态，或忘记更新状态。

**解决**：
- 在 systemPrompt 强调"先 state.write 改状态，再叙事"
- 使用 state-engine 模板（状态优先）
- 检查 Workspace 时间线，定位哪一步漏了状态更新

### 10.3 角色 OOC

**症状**：角色说了不符合人设的话。

**解决**：
- 开启 Critic-Character 子代理（default-rp 已内置）
- 在 `memory/project.md` 补充角色第一人称认知
- 用独立角色模式（namespace 隔离）

### 10.4 记忆膨胀导致 token 超限

**症状**：长对话后 memory/project.md 越来越大，触发 token 限制。

**解决**：
- 确认自动摘要已开启（每 10 轮摘要）
- 手动精简 project.md，只保留当前章节相关进度
- 把历史细节移到 `memory/reference.md`（不自动注入，需 recall 检索）

### 10.5 IM 消息过长被截断

**症状**：Agent 输出的正文太长，IM 平台截断。

**解决**：
- IM 适配器已自动分段（每段 < 800 字）
- 在 Profile 降低 maxTokens 到 2048
- 在 systemPrompt 要求"正文不超过 800 字"

### 10.6 查看调试信息

```
/rp status    # 查看当前会话状态
```

查看 Workspace 时间线（Agent 剧场前端），定位每次工具调用的输入输出。

查看日志：`data/plugins/agent-framework/runs/<run-id>/events.jsonl`

---

# 第三部分 · 高阶开发

## 11. 扩展开发框架

### 11.1 三种扩展点

| 扩展点 | 用途 | API |
|--------|------|-----|
| 工具扩展 | 注册自定义工具供 Agent 调用 | `ctx.agent.registerTool(toolDef)` |
| 界面扩展 | 注册自定义表现层适配器 | `ctx.surface.register(adapter)` |
| Agent 扩展 | 注册自定义 Agent Profile | `ctx.agent.registerAgent(def)` |

### 11.2 插件结构

一个 Agent 扩展插件的最小结构：

```
plugins/my-plugin/
├── plugin.json      # 插件清单（权限声明）
├── index.js         # 插件入口
└── README.md
```

`plugin.json`：
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "我的自定义 Agent 工具",
  "permissions": ["agent"],
  "main": "index.js"
}
```

---

## 12. 自定义 Agent 开发规范

### 12.1 Agent Profile YAML 格式

完整的 Profile 字段：

```yaml
name: my-agent                    # 唯一标识（英文）
displayName: 我的Agent             # 显示名
description: 一句话描述            # 简介
isDefault: false                  # 是否为默认方案（仅 default-rp 为 true）

systemPrompt: |                   # 核心指令（多行）
  你是一个...

tools:                            # 工具白名单（从注册表中选择）
  - state.read
  - state.write
  - memory.recall
  - custom.tool                   # 自定义工具

context:                          # 上下文策略
  historyLimit: 20                # 历史轮数
  injectAssets:                   # 启动注入的 ST 资产
    character: "${character}"     # 变量替换
    worldbook: "${worldbook}"
  injectFiles:                    # 启动注入的文件
    - "styles/${style}.md"
    - "memory/project.md"

subAgents:                        # 子代理（可选）
  - name: critic-realism
    trigger: after_draft          # 触发时机：after_draft / after_outline / manual
    parallel: true                # 是否并行

model:                            # 模型配置（可选）
  provider: openai
  model: deepseek-chat
  temperature: 0.85
  maxTokens: 4096

maxSteps: 12                      # 工具循环上限

commands:                         # 命令声明
  - name: start
    description: 开始会话
```

### 12.2 变量替换

Profile 中 `${variable}` 会在运行时替换：

| 变量 | 含义 |
|------|------|
| `${character}` | 当前角色卡名 |
| `${worldbook}` | 当前世界书名 |
| `${style}` | 当前文风名 |
| `${platform}` | 当前平台（qq / telegram 等） |
| `${chatId}` | 当前会话 ID |

### 12.3 子代理触发时机

| 触发时机 | 说明 |
|---------|------|
| `after_outline` | 大纲生成后触发（审查大纲） |
| `after_draft` | 草稿生成后触发（审查正文） |
| `manual` | 主 Agent 手动调用 `subagent.dispatch` 触发 |

---

## 13. 架构设计原则

### 13.1 状态驱动叙事

**原则**：叙事基于状态变化，而非气氛描述。

```
✅ 状态驱动：state.write(受伤, true) → 叙事"林夕捂住伤口，踉跄后退"
❌ 气氛驱动：叙事"林夕似乎受了伤" → （状态没变，下次可能矛盾）
```

### 13.2 认知隔离

**原则**：角色只知道自己经历过的事。

实现方式：
- 子代理有独立上下文（不看主 Agent 完整历史）
- 记忆按 namespace 隔离（`char:alice` 看不到 `char:bob` 的记忆）
- State 分 visible / private 层

### 13.3 可审计可回滚

**原则**：每次状态变更都记录在 Journal，可追溯。

- 所有工具调用写入 `events.jsonl`
- 关键节点创建 Checkpoint
- 失败的 run 不污染稳定层（Workspace 隔离）

### 13.4 渐进式加载

**原则**：不全量塞 prompt，按需加载。

- 角色卡/世界书用工具按需查（不 injectFiles 全量）
- 文风放 Skill 文件，`/rp style` 按需切换
- 记忆分四层，project 每轮注入，reference 需 recall

---

## 14. 代码编写指南与示例

### 14.1 注册自定义工具

```javascript
// plugins/my-plugin/index.js
import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class MyPlugin extends GatewayPlugin {
    static commands = [];

    async onLoad() {
        // 注册自定义工具到 Agent 框架
        this.ctx.agent.registerTool({
            name: 'weather.check',
            description: '查询当前场景的天气（供 Agent 保持天气一致性）',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: '地点名' }
                },
                required: ['location']
            },
            // 可选：参数校验钩子（不通过抛 RecoverableToolError）
            validate: (args, context) => {
                if (!args.location || args.location.trim() === '') {
                    return { ok: false, error: '地点不能为空' };
                }
                return { ok: true };
            },
            // 工具执行函数
            handler: async (args, context) => {
                const weather = await this._getWeather(args.location);
                return { location: args.location, weather };
            }
        });
    }

    async _getWeather(location) {
        // 你的天气查询逻辑
        return '晴，25°C';
    }
}
```

### 14.2 注册表现层适配器

```javascript
// plugins/my-plugin/index.js
async onLoad() {
    // 注册自定义界面适配器（如 Discord 富文本卡片）
    this.ctx.surface.register({
        name: 'discord-rich',
        surfaceType: 'discord',  // 自定义类型
        render: async (agentRunResult, ctx) => {
            // agentRunResult 是 AgentRunResult 实例
            const text = agentRunResult.getMainText();
            const options = agentRunResult.options;
            const state = agentRunResult.state.visible;

            // 构建 Discord embed 卡片
            const embed = {
                title: state.地点 || '未知地点',
                description: text,
                fields: options.map((opt, i) => ({
                    name: `选项${i + 1}`,
                    value: opt.text
                }))
            };

            await ctx.reply(JSON.stringify(embed));
        }
    });
}
```

### 14.3 注册自定义 Agent

```javascript
async onLoad() {
    // 动态注册 Agent Profile（而非放 YAML 文件）
    this.ctx.agent.registerAgent({
        name: 'dynamic-storyteller',
        displayName: '动态叙事者',
        systemPrompt: '你是一个动态生成的叙事 Agent...',
        tools: ['state.read', 'state.write', 'narrative.generate'],
        context: {
            historyLimit: 15,
            injectFiles: ['memory/project.md']
        },
        maxSteps: 8
    });
}
```

### 14.4 完整插件示例

```javascript
// plugins/combat-system/index.js
import { GatewayPlugin } from '../../server/plugin-sdk.js';

/**
 * 战斗系统插件
 * 为 Agent RP 提供骰子、伤害计算、状态效果等战斗工具
 */
export default class CombatSystemPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'combat',
            alias: ['战斗'],
            handler: 'handleCombat',
            description: '战斗系统管理',
        }
    ];

    async onLoad() {
        // 注册战斗工具
        this.ctx.agent.registerTool({
            name: 'combat.roll',
            description: '掷骰子。参数：dice(如"1d20")，modifier(修正值)',
            parameters: {
                type: 'object',
                properties: {
                    dice: { type: 'string', description: '骰子表达式，如 1d20 / 2d6' },
                    modifier: { type: 'number', description: '修正值' }
                },
                required: ['dice']
            },
            handler: async (args) => {
                const result = this._rollDice(args.dice, args.modifier || 0);
                return { dice: args.dice, rolls: result.rolls, total: result.total };
            }
        });

        this.ctx.agent.registerTool({
            name: 'combat.damage',
            description: '对角色施加伤害。参数：target(角色名)，amount(伤害值)，type(伤害类型)',
            parameters: {
                type: 'object',
                properties: {
                    target: { type: 'string' },
                    amount: { type: 'number' },
                    type: { type: 'string', description: 'physical / mental' }
                },
                required: ['target', 'amount']
            },
            validate: (args, context) => {
                // 校验目标角色是否存在
                const actors = context.session?.state?.visible?.在场角色 || [];
                if (!actors.includes(args.target)) {
                    return {
                        ok: false,
                        error: `角色 "${args.target}" 不在场，当前在场：${actors.join(', ')}`
                    };
                }
                return { ok: true };
            },
            handler: async (args, context) => {
                // 读取当前 HP，扣减，写回
                const state = context.session.state || {};
                const hp = state.private?.[args.target]?.HP ?? 100;
                const newHp = Math.max(0, hp - args.amount);

                return {
                    target: args.target,
                    damage: args.amount,
                    previousHP: hp,
                    currentHP: newHp,
                    defeated: newHp === 0
                };
            }
        });
    }

    async handleCombat(ctx) {
        const sub = ctx.args[0] || 'help';
        if (sub === 'help') {
            await ctx.reply(
                '战斗系统命令：\n' +
                '/combat status - 查看战斗状态\n' +
                '/combat reset - 重置战斗'
            );
        }
    }

    _rollDice(expr, modifier) {
        const match = expr.match(/(\d+)d(\d+)/);
        if (!match) return { rolls: [], total: modifier };
        const count = parseInt(match[1]);
        const sides = parseInt(match[2]);
        const rolls = [];
        for (let i = 0; i < count; i++) {
            rolls.push(Math.floor(Math.random() * sides) + 1);
        }
        return { rolls, total: rolls.reduce((a, b) => a + b, 0) + modifier };
    }
}
```

`plugin.json`：
```json
{
    "name": "combat-system",
    "version": "1.0.0",
    "description": "战斗系统：骰子、伤害、状态效果",
    "permissions": ["agent"],
    "main": "index.js"
}
```

---

## 15. 调试、测试与部署

### 15.1 调试

**查看 Agent 执行链**：
在 Agent 剧场前端查看时间线，或直接读 events.jsonl：

```bash
# 查看最近一次 run 的事件流
cat data/plugins/agent-framework/runs/<run-id>/events.jsonl
```

每行是一个 JSON 事件：
```json
{"seq":1,"type":"tool_call","payload":{"tool":"state.read","args":{},"result":{...}}}
{"seq":2,"type":"tool_call","payload":{"tool":"memory.recall","args":{"query":"伏笔"},"result":[...]}}
{"seq":3,"type":"draft","payload":{"text":"第七月的阳光..."}}
{"seq":4,"type":"checkpoint","payload":{"label":"before-commit"}}
{"seq":5,"type":"commit","payload":{"promoted":["output/main.md"]}}
```

**回滚到 Checkpoint**：
```javascript
// 通过 API 回滚（需开发管理界面）
workspaceManager.rollback(runId, checkpointId);
```

### 15.2 测试

项目使用 Node.js 内置测试框架（`node:test`）：

```bash
# 运行全部测试
cd d:\预设\sillytavern-gateway
npm test

# 运行特定测试
node --test test/agent-run-result.test.js
node --test test/workspace-manager.test.js
```

为你的扩展编写测试：

```javascript
// test/my-plugin.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('我的插件', () => {
    it('工具应正确掷骰', () => {
        const result = rollDice('1d20', 5);
        assert.ok(result.total >= 6 && result.total <= 25);
    });
});
```

### 15.3 部署

**Docker 部署**：
```bash
docker build -t agent-gateway .
docker run -d --name agent-gateway \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/assets:/app/assets \
  -v $(pwd)/.env:/app/.env \
  agent-gateway
```

**PM2 部署**：
```bash
npm install -g pm2
pm2 start index.js --name agent-gateway
pm2 save
pm2 startup
```

---

## 16. 性能优化与安全考量

### 16.1 性能优化

**Token 优化**：
- 用 Skill 渐进式加载，不全量注入（省 30-50% token）
- `historyLimit` 按模型窗口调整，不要盲目设大
- 记忆自动摘要，防止膨胀

**响应速度**：
- workspace 事件写入已批处理（100ms 缓冲）
- SSE 推送非阻塞，不等待 Agent run 完成
- 多 Critic 子代理并行执行

**长线 RP 维护**：
- 定期检查 `memory/project.md`，精简过期信息
- Workspace 有 Retention 策略（默认保留最近 20 次 run 完整数据）
- 用 `/rp stop` 正常结束会话，确保状态持久化

### 16.2 安全考量

**权限隔离**：
插件必须在 `plugin.json` 声明所需权限：

| 权限 | 风险 | 说明 |
|------|------|------|
| `agent` | medium | 使用 Agent 框架（注册工具/调度子代理） |
| `surface` | medium | 注册表现层适配器 |
| `workspace` | low | 跨插件共享 workspace |
| `llm` | medium | 调用 LLM |
| `fs` | medium | 文件读写（限定插件数据目录） |
| `assets` | low | ST 资产只读访问 |

**路径穿越防护**：
- Workspace 所有文件操作经 `_safeResolve` 校验，拒绝 `..` 和绝对路径
- 插件文件操作限定在 `data/plugins/<plugin-name>/` 下

---

# 第四部分 · 附录

## 17. 命令速查表

### `/rp` 命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `/rp start [角色卡名\|Profile名]` | 启动 RP 会话 | `/rp start` 或 `/rp start 艾莉娅` |
| `/rp stop` | 结束 RP 会话 | `/rp stop` |
| `/rp status` | 查看当前 RP 状态 | `/rp status` |
| `/rp style [文风名]` | 切换/查看文风 | `/rp style hardboiled` |
| `/rp mode [actor\|director]` | 切换视角模式 | `/rp mode director` |
| `/rp character [名称]` | 切换角色卡 | `/rp character 陈博士` |
| `/rp profile [Profile名]` | 切换 Agent Profile | `/rp profile multi-critic` |
| `/rp skill list` | 查看已加载 skill | `/rp skill list` |
| `/rp skill load <名称>` | 加载 skill | `/rp skill load combat` |
| `/rp skill unload <名称>` | 卸载 skill | `/rp skill unload combat` |
| `/rp skill clear` | 清空所有 skill | `/rp skill clear` |
| `/rp bindbot <botId> <profile>` | 群聊绑定 bot | `/rp bindbot 111 GM` |
| `/rp unbindbot <botId>` | 群聊解绑 bot | `/rp unbindbot 111` |
| `/rp help` | 显示帮助 | `/rp help` |

### 内置工具

| 工具 | 功能 | 参数 |
|------|------|------|
| `state.read` | 读取会话状态 | `{key?: string}` |
| `state.write` | 写入会话状态 | `{key: string, value: any}` |
| `state.list` | 列出所有状态键 | `{}` |
| `state.delete` | 删除状态键 | `{key: string}` |
| `memory.recall` | 检索记忆 | `{query: string, limit?: number}` |
| `memory.update` | 更新记忆文件 | `{type: "project"\|"reference"\|"feedback"\|"user", content: string}` |
| `memory.read` | 读取记忆文件 | `{type: string}` |
| `narrative.generate` | 生成正文 | `{prompt: string, style?: string}` |
| `character.read` | 读取角色卡 | `{field?: string}` |
| `worldbook.search` | 搜索世界书 | `{query: string}` |
| `file.read` | 读取工作区文件 | `{path: string}` |
| `file.write` | 写入工作区文件 | `{path: string, content: string}` |
| `file.list` | 列出工作区文件 | `{path?: string}` |
| `skill.load` | 加载 Skill | `{name: string}` |
| `skill.list` | 列出可用 Skill | `{}` |
| `subagent.dispatch` | 调度子代理 | `{agent: string, task: string, await?: boolean}` |
| `subagent.list` | 列出可用子代理 | `{}` |

---

## 18. API 接口文档

### 18.1 ctx.agent API

```javascript
// 注册自定义工具
ctx.agent.registerTool({
    name: string,
    description: string,
    parameters: object,       // JSON Schema
    validate?: (args, ctx) => { ok: boolean, error?: string },
    handler: (args, ctx) => Promise<any>
});

// 注册 Agent Profile
ctx.agent.registerAgent(definition: object);

// 调度子代理
const result = await ctx.agent.dispatch(subAgentName, task, options);

// 触发 Agent run
const { runId, result, text, steps } = await ctx.agent.run(
    profileName,    // Profile 名
    userMessage,    // 用户输入
    session,        // 会话状态
    ctx             // 插件上下文
);

// 获取框架状态
const status = ctx.agent.getStatus();
// { activeAgents, totalRuns, toolRegistry }
```

### 18.2 ctx.surface API

```javascript
// 注册表现层适配器
const unregister = ctx.surface.register({
    name: string,           // 唯一名
    surfaceType: string,    // 'im' / 'st' / 'native' / 自定义
    render: (agentRunResult, ctx) => Promise<any>
});

// 绑定会话主适配器
ctx.surface.bindPrimary(`${platform}:${chatId}`, adapterName);

// 分发 AgentRunResult
const results = await ctx.surface.dispatch(
    agentRunResult,
    ctx,
    { primarySurfaceType: 'im', bypassSurfaceTypes: ['native'] }
);

// 列出已注册适配器
const adapters = ctx.surface.getAdapters();
```

### 18.3 AgentRunResult 数据契约

```javascript
{
    runId: string,
    artifacts: [              // 产物
        { id: string, type: 'main'|'outline'|'draft', text: string }
    ],
    options: [                // 玩家选项
        { label: string, text: string, callbackId: string }
    ],
    state: {
        visible: object,      // 所有角色可见
        private: object       // 各角色私有（按角色名分组）
    },
    events: [                 // 事件流（用于时间线）
        { seq: number, type: 'tool_call'|'subagent'|'state_change'|'checkpoint'|'draft'|'commit', payload: object, timestamp: number }
    ],
    meta: {
        viewMode: 'actor'|'director',
        style: string,
        turn: number,
        referencedMemory: string
    }
}
```

### 18.4 HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/agents` | 列出所有 Agent Profile |
| GET | `/api/agents/:name` | 获取 Profile 详情 |
| POST | `/api/agents` | 创建/更新 Profile |
| DELETE | `/api/agents/:name` | 删除 Profile |
| POST | `/api/agents/:name/run` | 手动触发 Agent |
| POST | `/api/agents/from-default` | 从默认方案创建副本 |
| GET | `/api/agents/tools` | 列出已注册工具 |
| GET | `/api/agents/logs` | 获取执行日志 |
| GET | `/api/agent-theatre/stream` | SSE 订阅 AgentRunResult 流 |
| POST | `/api/agent-theatre/input` | 提交用户输入触发 run |
| GET | `/api/agent-theatre/events/:runId` | 查询历史事件 |

---

## 19. 进阶学习资源

### 19.1 项目内文档

| 文档 | 内容 |
|------|------|
| [AGENT_FRAMEWORK_GUIDE.md](file:///d:/预设/sillytavern-gateway/docs/AGENT_FRAMEWORK_GUIDE.md) | Agent 框架开发者完整指南 |
| [AGENT_PLATFORM_ARCHITECTURE.md](file:///d:/预设/sillytavern-gateway/docs/AGENT_PLATFORM_ARCHITECTURE.md) | 平台架构设计 + 关键功能实现建议 |
| [AGENT_PLATFORM_WHITEPAPER.md](file:///d:/预设/sillytavern-gateway/docs/AGENT_PLATFORM_WHITEPAPER.md) | 技术方案白皮书 |
| [AGENT_PLATFORM_PROTOTYPE.md](file:///d:/预设/sillytavern-gateway/docs/AGENT_PLATFORM_PROTOTYPE.md) | 原型设计 + 数据契约 + ST 接入步骤 |
| [PLUGIN_DEVELOPMENT_GUIDE.md](file:///d:/预设/sillytavern-gateway/docs/PLUGIN_DEVELOPMENT_GUIDE.md) | 插件开发通用指南 |
| [PLUGIN_SECURITY.md](file:///d:/预设/sillytavern-gateway/docs/PLUGIN_SECURITY.md) | 插件安全规范 |

### 19.2 模板速览

| 模板 | 适合场景 |
|------|---------|
| `default-rp.yaml` | 新手入门（开箱即用） |
| `simple-rp.yaml` | 基础 RP（无子代理） |
| `multi-critic.yaml` | 高质量创作（4 Critic 审查流水线） |
| `director-mode.yaml` | 群像剧（Agent 控制所有角色） |
| `state-engine.yaml` | 复杂系统沙盒（状态优先 + 后台导演组） |
| `independent-character.yaml` | 独立角色（认知隔离 + 第一人称） |

### 19.3 社区实践参考

本项目的设计大量借鉴了社区 Pi Agent 实践经验，深入理解可参考项目内的经验总结文件：
- 多 Agent 工作流（GM + 4 Critic + 记忆 + 状态）
- 独立角色模式（认知隔离 + 第一人称改写 + 记忆植入）
- 状态引擎（状态优先 + 领域工具 + 后台导演组 + 自我纠正）
- 渐进式加载 / 文风蒸馏 / 记忆管理

---

## 20. 社区支持与贡献

### 20.1 贡献方式

- **提交模板**：编写新的 Agent Profile YAML 模板，放入 `templates/`
- **开发工具插件**：注册自定义工具（战斗系统 / 经济系统 / 天气系统等）
- **开发界面适配器**：为新的聊天平台或前端注册表现层适配器
- **改进文档**：补充使用经验、修复文档错误

### 20.2 模板贡献规范

1. YAML 文件放入 `plugins/agent-framework/templates/`
2. 必须包含 `name`、`displayName`、`description`、`systemPrompt`、`tools`
3. 在 `description` 中说明适合场景
4. 如适用，标注来源灵感（如"源自社区多 Critic 实践"）

### 20.3 工具贡献规范

1. 工具名用 `域名.动作` 格式（如 `combat.roll`、`economy.spend`）
2. 必须有 `description`（给 LLM 看的，要清晰）
3. 复杂工具应提供 `validate` 钩子（防状态漂移）
4. handler 返回值要可序列化（会写入 Journal）

---

> **最后**：Agent RP 的核心不是 prompt 写得多精密，而是你愿意花多少时间去观察角色、理解状态、给它留出"做自己"的空间。好的 Agent 平台是脚手架，不是牢笼。
