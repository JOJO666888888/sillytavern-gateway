# Agent 前端修复报告：Profile 保存 / 上下文注入 / 提示词查看器 / 开场白

> 日期：2026-08-04 · 项目：sillytavern-gateway · 测试基线：873/873 通过

---

## 一、问题 1：保存 Profile 报"缺少 name 字段"

### 问题现象

将 Profile 的 systemPrompt 中"选项格式"段落修改为包含 `<user>`、`<options>` 标签与 `>选项一：...` 顶格行后，保存报 `Agent 定义缺少 name 字段`，尽管 YAML 首行明确包含 `name: default-rp`。

### 根因（已复现）

1. **YAML 解析器双重回退的静默破坏**：`agent-loader.js` 的 `parseYAML` 采用「js-yaml 优先，失败静默回退手写 `simpleYAMLParse`」。当用户把多行文本**顶格粘贴**进 `systemPrompt: |` 块时：
   - js-yaml 报缩进错误（`can not read a block mapping entry (6:7)`）
   - 回退的手写解析器对 `|` 块要求严格缩进（`blockIndent = indent + 2`），顶格行立即 break 块
   - 后续行被当作**顶层键/列表**解析，一旦出现 `- ` 开头行（如"视角模式"的 `- actor（扮演视角）...`），顶层对象被改造成数组 → 之前解析的 `name` 等字段全部丢失 → 报"缺少 name 字段"

2. 手写解析器对多行字符串、缩进错乱零容错，错误信息误导（"缺少 name"而非"YAML 格式错误"）。

### 解决方案

- **后端严格模式**（`agent-loader.js`）：`parseYAML` 返回结构化结果 `{ok, data, error, fallback, jsYamlError}`；`save()` 中**只要 js-yaml 解析失败即抛明确错误**（含行号与上下文），不再静默回退导致数据损坏：
  ```
  YAML 解析失败，请检查缩进与格式: can not read a block mapping entry ... (6:7)
  ```
- **前端 `toYaml` 规范化**（`agent.js`）：多行字符串一律输出为 YAML 字面块 `|` 语法（后续行缩进 +1 层），从源头避免生成的 YAML 被误判为顶层列表。

### 验证

- 缩进正确的选项格式（含 `<options>`/`>选项` 文本）→ 保存成功，systemPrompt 完整
- 顶格粘贴 → 报明确 YAML 错误（含行号），不再误导为"缺少 name"

---

## 二、问题 2：世界书/角色卡内容未正确注入上下文

### 根因（真实资产实测发现 3 个问题）

| 问题 | 实测证据 |
|---|---|
| **真实 V3 角色卡 description/personality/scenario/mesExample 为空**，人物设定全在 `character_book` 内嵌世界书，注入逻辑未处理内嵌世界书 → system 中角色内容零贡献 | 3 张真实卡（含 `1软萌魔王的后宫征服计划(被).png`）均 `characterBook: 有`、描述字段全空 |
| **特殊字符文件名匹配失败**（中文/括号/连字符/全角问号，如 `------------师妹的系统目标是我？.json`） | 无扩展名名称无法命中 |
| **大小写扩展名不兼容**（`.PNG` 无法命中 `.png` 判定） | 代码静态分析 |

**附带根因（关键）**：`/api/agent-theatre/input` 路由此前把 `character`/`worldbook`/`style`/`history` 只放入 ctx 参数，而 `agentService.run` 并不读取 → **剧场流的世界书/角色卡注入完全落空**。

### 解决方案

- `context-builder.js`：
  - `_loadCharacterCard`/`_loadWorldbook` 扩展名判定改 `path.extname().toLowerCase()`；未精确命中时按 basename 大小写不敏感目录扫描回退（`_findAssetFile`）
  - `_injectAssets` 处理角色卡内嵌 `character_book`：`normalizeLorebook` + `activateEntries` 关键词激活注入（与 NativeRuntime pipeline 语义一致）
- `agent-api.js`：input 路由把 `character/worldbook/style/history/greetingIndex` 正确透传至 session 参数并存储（`sess.character/worldbook/style/greetingIndex`）

### 验证

- 特殊字符角色卡名（无扩展名）→ 命中 `chara_card_v3`；特殊字符世界书名 → 命中 14 条；`.PNG` 大写 → 命中
- `ContextBuilder.build` 端到端：system 长度 44257 → 69889，包含【角色内嵌世界书】+【世界书】

---

## 三、问题 3：提示词查看器组件

### 功能

- 顶栏新增「📜 提示词」按钮，打开全屏浮层查看器（`agent_prompt_viewer`）
- **分类展示**：按 role 分组；system 按 `\n\n` 分段并启发式打标签（角色卡/世界书 / 记忆/文风 / 系统提示）；等宽字体、`<details>` 折叠、可滚动
- **实时更新**：SSE `prompt_built` 事件自动刷新 + run 完成/失败后主动刷新 + 手动刷新按钮；显示最近构建时间
- 空状态引导："暂无提示词记录，触发一次 Agent run 后自动出现"

### 后端支撑

- `GET /api/agent-theatre/prompt?session=...`：返回最近一次 build 的完整 messages（`agent-runner.js` 的 `lastPromptMap` 捕获，构建先于 LLM 调用，失败时也有记录）
- `prompt_built` SSE 广播（`theatre-broadcaster.js` `broadcastPromptBuilt`）

---

## 四、问题 4：角色卡开场白机制（SillyTavern 一致）

### 功能

1. **多开场白切换**：聊天区右下角 `‹ ›` 箭头 + 「开场白 2/3」指示器（`agent_greeting_*`），切换 `greetingIndex` 并实时预览
2. **自动加载**：切换角色卡时 `GET /api/agent-theatre/greetings` 获取开场白列表（first_message + alternate_greetings），有则显示「开场白」角标预览气泡
3. **注入**：history 为空 + 有角色卡时，开场白作为首条 `assistant` 消息注入（`agent-runner.js`），system 注明"开场白已展示"；有历史不重复注入
4. **发送携带**：`sendInput` body 携带 `greetingIndex`

### 后端支撑

- `card-loader.js` `normalizeCard` 归一化 `firstMessage`/`first_message`/`alternateGreetings`
- `context-builder.js` 公开 `loadCard`/`getGreetingList`/`selectGreeting`（取模循环、越界安全）
- `GET /api/agent-theatre/greetings?session=...&character=...`

---

## 五、重试机制改造：同楼层翻页

### 目标

用户一句话 = 一个楼层，楼层内多份重试回复可翻页切换（对齐 SillyTavern）。

### 实现

- **楼层数据**：`theatre.floors = [{ userMsg, pages:[...], currentPage }]`；localStorage 新格式 `{v:2, floors}`，旧 `[{role,content}]` 自动转换
- **重试**：点击重试 → 复用最后一个楼层开启"草稿页"，SSE 流式写入草稿，run 完成 commit 为 pages 新页并切到最新页
- **翻页**：楼层气泡右上 `‹ ›` + 「1/3」指示器切换 `currentPage`，局部更新气泡文本
- **异常处理**：aborted/error 丢弃草稿页；发送失败回滚楼层（仅保留用户消息）；completed 兜底 commit 防重复追加
- **流式兼容**：流式中间态不新建气泡，更新既有楼层草稿页

---

## 六、测试结果

| 检查项 | 结果 |
|---|---|
| 全量测试 `node --test --test-force-exit --test-concurrency=2 test/*.test.js` | **873 通过 / 0 失败**（基线 839 + 新增 34） |
| `node --check`（全部改动文件） | 全部通过 |
| 真实资产回归（`test/context-builder-assets.test.js`） | 通过（无 skip） |
| 前端 ES5 合规（无 `.finally`/箭头函数/`let`/`const`/模板字符串） | 通过 |

**新增测试（34 个）**：
- `test/context-builder-assets.test.js`（新增，25）：角色卡加载 5、世界书加载 3、build 端到端 2、真实资产回归 2、开场白字段 2、greeting 选择 2、Runner 开场白注入 4、Runner 提示词捕获 5
- `test/agent-api.test.js`（+7）：`/prompt` 3、`/greetings` 3、input 透传守护 1
- `test/agent-theatre.test.js`（+2）：`prompt_built` SSE 广播 2

## 七、改动文件清单

| 文件 | 改动 |
|---|---|
| `plugins/agent-framework/engine/agent-loader.js` | parseYAML 结构化返回 + save 严格报错 |
| `server/agent/context-builder.js` | 容错资产加载 + 内嵌 character_book 注入 + 开场白公开方法 |
| `server/runtime/card-loader.js` | firstMessage/alternate_greetings 归一化 |
| `plugins/agent-framework/engine/agent-runner.js` | lastPromptMap/onPromptBuilt + 开场白注入 |
| `plugins/agent-framework/index.js` | prompt/greetings 接线 |
| `server/agent/theatre-broadcaster.js` | broadcastPromptBuilt |
| `server/agent-api.js` | /prompt、/greetings 端点 + input 透传修复 |
| `public/agent.html` / `agent.css` / `agent.js` | 提示词查看器 + 开场白 + 楼层翻页重试 |
| `test/*` | 新增 34 个测试 |
