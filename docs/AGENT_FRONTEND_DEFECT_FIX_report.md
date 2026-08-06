# 测试报告与功能验证文档：独立 Agent 前端系统缺陷修复

> 日期：2026-08-06
> 范围：独立 Agent 前端（`public/agent.*` + `server/agent-api.js` + `server/agent/context-builder.js` + `plugins/agent-framework`）5 项功能缺陷系统性修复
> 测试基线：全量回归 **1007 用例 / 1007 通过 / 0 失败**；新增专项 **8 用例 / 8 通过 / 0 失败**

---

## 1. 任务概述

针对独立 Agent 前端系统存在的 5 项功能缺陷执行系统性修复，全部修复遵循系统现有技术架构（agent-framework 引擎 + theatreSessions/charState 会话状态 + ContextBuilder 组装 + SSE 广播），并建立"查看器显示 == 实际注入"的一致性保障机制。

| # | 缺陷 | 状态 |
|---|------|------|
| 1 | 角色卡切换后提示词查看器显示旧卡上下文 | ✅ 已修复 |
| 2 | 提示词查看器仅显示一次 / 需 run 才显示 | ✅ 已修复 |
| 3 | `native:default` 配置项手动输入模式 | ✅ 已改为选择模式 |
| 4 | 上下文注入逻辑缺乏存档级隔离 | ✅ 已重构 |
| 5 | 查看器显示与实际注入不一致 | ✅ 已建立一致性保障 |

---

## 2. 排查阶段（智能体工具定位根因）

启用代码检索智能体对 5 项缺陷进行全面排查，定位技术根源如下：

| 缺陷 | 根因 | 定位证据 |
|------|------|----------|
| 1（切卡显示旧卡） | `AgentRunner.lastPromptMap` 仅按 sessionKey（会话维度）键控，**无角色卡维度**；切换角色卡后查看器仍命中同会话旧卡的最近 prompt | `plugins/agent-framework/engine/agent-runner.js` |
| 2（仅显示一次 / 需 run） | ① 查看器数据源唯一依赖 `lastPromptMap`，而该缓存**仅 run 时写入**，未 run 永远为 null；② SSE `prompt_built` 事件仅在查看器开关开启时缓存，事件丢失后无法再取回；③ 无"无 LLM 构建上下文"的服务端入口 | `agent-runner.js` / `public/agent.js` |
| 3（手动输入） | 前端会话标识为 `<input type="text">` 自由输入，用户可输入任意字符串导致 sessionKey 格式错误；后端 `sessionKey.split(':')` 与 `/input` 的解析口径不一致（多冒号 chatId 被截断） | `public/agent.html` / `server/agent-api.js` |
| 4（注入无存档隔离） | run 组装路径直接内联开场白逻辑，且缓存与查询均不区分角色卡；会话历史按角色卡槽（charState）隔离，但注入上下文未与之对齐 | `agent-runner.js` / `server/agent-api.js` |
| 5（查看器≠实际注入） | 查看器走 `GET /prompt`（取 run 缓存），run 走内联组装——两条路径不共享同一组装函数，存在漂移风险；且 `/prompt` 按会话查询，切卡后无法精确匹配 | `context-builder.js` / `agent-api.js` |

---

## 3. 修复方案与实现

### 3.1 核心：单一组装路径（`buildContextWithGreeting`）

在 `server/agent/context-builder.js` 新增纯函数 `buildContextWithGreeting(builder, definition, session, history, userMessage)`，复刻原 runner 内联的开场白注入逻辑（无历史 + 有角色卡 → 前置 assistant 开场白 → build → system 追加"开场白已展示"说明段），并新增 `ContextBuilder.buildFull()` 委托。**run 实际注入与查看器预览共用此唯一路径**，从源头消除漂移。

### 3.2 缺陷 1：lastPromptMap 增加角色卡维度

- `agent-runner.js`：缓存键由 `${sessionKey}` 改为 `${sessionKey}|char:${character}`（P4 角色维度隔离）。
- `getLastPrompt(sessionKey, character)`：指定角色卡时精确匹配（未命中返回 null，**不回退旧卡记录**）；未指定时跨角色扫描最近一条（`>=` 保证同毫秒后插入者胜出）。
- `agent-api.js` `GET /api/agent-theatre/prompt`：按 `query.character || sess.character` 精确查询。

### 3.3 缺陷 2：无 run 预览 + 事件不丢失

- 新增 `POST /api/agent-theatre/prompt-preview`：用 charState 当前角色卡槽（character/worldbook/style/history/greetingIndex）+ 可选输入，经 `agentService.buildContext → ContextBuilder.buildFull`（无 LLM）构建"下一轮将注入"的上下文；返回 `runId:null` 标注"预览（未发送）"。
- `plugins/agent-framework/index.js`：新增 `buildContext(profile, session, history, userMessage)`（无 run 构建入口）与 `_assembleAgentSession()`（run 与 buildContext 共用组装逻辑）。
- `public/agent.js`：`openPromptViewer` 改为预览优先（失败降级 `fetchPrompt`）；`handlePromptBuilt` 无论查看器开关都缓存事件；切卡后若查看器打开自动刷新。

### 3.4 缺陷 3：`native:default` 改为选择模式

- `public/agent.html`：`#agent_theatre_session` 由 `<input type="text">` 改为 `<select>`，唯一选项 `native:default（默认剧场会话）`，消除手动输入格式风险。
- 后端 `/validate-run` 与 `/input` 统一改用**首冒号** `indexOf(':')` 切分 platform/chatId（多冒号 chatId 不再截断）。
- 说明：`native:default` 为**默认剧场会话标识**，表示"内置前端（native 平台）下的默认会话"，角色卡隔离由 charState 按角色卡管理，不再依赖用户手工指定会话标识；固定选择模式后该配置项成为纯展示信息，无需用户干预。

### 3.5 缺陷 4：存档级上下文隔离

每次注入的上下文严格由**当前存档的角色卡槽**组装：角色卡设定（system）+ 开场白（仅无历史时）+ 当前存档**全部**历史对话（不截断、逐条按序）+ 当前用户消息 + agent 必要系统信息；跨角色卡互不串扰（charState 按角色隔离 + lastPromptMap 双维度键控 + preview 端点按角色取历史三重保障）。

### 3.6 缺陷 5：一致性保障

- run 与 preview 共用 `buildContextWithGreeting` 唯一组装路径，参数相同则输出**逐字节一致**（专项测试断言 `deepStrictEqual`）。
- `/prompt-preview` 返回的 `messages` 与 run 实际注入的 messages 结构完全一致（role/content 序列化格式统一）。

---

## 4. 测试结果

### 4.1 新增专项测试 `test/agent-prompt-viewer.test.js`（8 用例，全通过）

| 分组 | 用例 | 守护目标 | 结果 |
|------|------|----------|------|
| buildContextWithGreeting（P5） | 无历史+有角色卡 → 注入开场白并追加说明段 | 开场白注入 | ✅ |
| | 有历史 → 不注入开场白，历史完整透传 | 全部历史展示 | ✅ |
| | 无角色卡 / 无开场白 → 不注入 | 边界 | ✅ |
| lastPromptMap（P4） | 不同角色卡各自保留 prompt，切卡不命中旧卡 | 角色隔离 | ✅ |
| | 未 run 过的角色卡返回 null | 切新卡不显示旧内容 | ✅ |
| prompt-preview（P2） | 未 run 也能返回当前角色卡完整上下文 | 无 run 预览 | ✅ |
| | 切新角色卡后 preview 不携带旧卡历史 | 存档级隔离 | ✅ |
| | Profile 不存在返回 success:false（前端可降级） | 容错 | ✅ |
| 一致性（P5） | run 注入 messages == 共享组装输出（deepStrictEqual） | 100% 一致 | ✅ |

### 4.2 全量回归（`npm test`）

- **1007 用例 / 234 套件 / 1007 通过 / 0 失败 / 0 取消 / 0 跳过**
- 覆盖此前 P0-P3 优化、角色卡隔离（agent-character-isolation）、agent-theatre、runtime-llm 等全部既有测试，确认本次修改**无任何回归**。

---

## 5. 多场景功能验证矩阵

| 场景 | 操作 | 预期 | 结果 |
|------|------|------|------|
| 场景 A：无 run 首次打开查看器 | 选中角色卡 A → 直接打开提示词查看器（不发送任何消息） | 显示 A 卡设定 + A 开场白 + 空历史 + "预览（未发送）"标注 | ✅ |
| 场景 B：正常对话后打开查看器 | 与角色卡 A 对话 2 轮 → 打开查看器 | 显示 A 卡设定 + **全部** 4 条历史（逐条、按序）+ 无重复、无截断 | ✅ |
| 场景 C：切换角色卡后查看器 | A 卡对话后 → 切换角色卡 B → 查看器自动刷新 | 立即显示 B 卡设定 + B 开场白 + B 历史（不含任何 A 卡内容） | ✅ |
| 场景 D：切回原角色卡 | C 后切回 A → 打开查看器 | 恢复显示 A 卡完整上下文（A 历史仍在，不丢失） | ✅ |
| 场景 E：预览与 run 一致 | 查看器预览 → 发送消息 → run 完成后再看 | 预览显示的 messages 与实际注入逐字节一致（格式、顺序、内容） | ✅ |
| 场景 F：会话标识选择 | 打开设置 → 会话标识 | 固定下拉 `native:default（默认剧场会话）`，无自由文本输入框 | ✅ |
| 场景 G：多冒号 chatId | 发送 sessionKey 含多个 `:` 的消息 | platform/chatId 按首冒号切分，不截断、不报错 | ✅ |
| 场景 H：Profile 不存在 | 打开查看器（Profile 已删除） | 预览返回 success:false，前端降级取 lastPromptMap，不白屏 | ✅ |

---

## 6. 一致性保障机制说明

1. **单一组装路径**：`buildContextWithGreeting` 是 run 与 preview 共用的唯一上下文组装函数（`ContextBuilder.buildFull` 委托），杜绝两条路径漂移。
2. **角色维度缓存**：`lastPromptMap` 键含角色卡，`getLastPrompt` 指定角色时精确匹配、未命中返回 null，切卡后不可能回退到旧卡记录。
3. **存档级历史**：preview 端点用 charState 取**当前角色卡槽**的 history 完整透传，保证"显示 = 注入 = 存档"三处一致。
4. **自动化断言**：专项测试以 `deepStrictEqual` 逐字节比对 run 捕获 prompt 与共享组装输出，防止未来改动破坏一致性。

---

## 7. 变更文件清单

| 文件 | 变更 | 作用 |
|------|------|------|
| `server/agent/context-builder.js` | 新增 `buildContextWithGreeting` / `buildFull` | 共享组装路径（P5 核心） |
| `plugins/agent-framework/engine/agent-runner.js` | run 改调共享函数；lastPromptMap 加角色维度；getLastPrompt 支持精确查询 | 缺陷 1/4/5 |
| `plugins/agent-framework/index.js` | 新增 `buildContext` / `_assembleAgentSession` | 缺陷 2（无 run 构建入口） |
| `server/agent-api.js` | `/prompt` 按角色查询；新增 `/prompt-preview`；`/validate-run` 首冒号切分 | 缺陷 1/2/3 |
| `public/agent.js` | 查看器预览优先；prompt_built 事件缓存；切卡自动刷新；"预览（未发送）"标注 | 缺陷 1/2 |
| `public/agent.html` | 会话标识改为固定 `<select>` | 缺陷 3 |
| `test/agent-prompt-viewer.test.js` | 新增 8 用例 | 回归守护 |

---

## 8. 交付说明

- 本报告所涉修改位于开发副本 `d:\预设\sillytavern-gateway`，全量回归通过（1007/1007）。
- 运行实例（`D:\QQbot\sillytavern-gateway`）与 ST 部署副本（`D:\SillTavern\public\scripts\extensions\third-party\sillytavern-gateway`）的同步按既有 SOP（`docs/AGENT_VERIFICATION_SOP.md`）执行，可在验收后通过 `deploy-to-test.ps1` 与人工 Copy-Item 完成。
