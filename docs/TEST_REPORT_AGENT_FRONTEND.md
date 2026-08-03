# 测试报告：Agent 专用前端（模块 B）改造

> 日期：2026-08-03
> 范围：ST 网关设置页面剥离 / "agent 框架"→"agent 设置"命名 / Agent 配置整合 / 自定义前端 URL 配置与验证 / 用户体验引导
> 关联提交：模块 B 改造（独立页 `public/agent.{html,css,js}` + `server/agent-frontend.js` + `test/agent-frontend.test.js`）

---

## 1. 测试范围

| # | 需求项 | 测试内容 |
|---|--------|----------|
| 1 | 剥离 ST 设置页面 agent 内容 | ST 面板不再含 Agent 框架/剧场区块；独立页 `/agent` 承载全部 agent 功能；路由独立、无相互干扰 |
| 2 | "agent 框架"→"agent 设置"命名 + 图标去重 | plugin.json displayName、界面文本、内部可见字符串统一；图标不再与自建推理管线重复 |
| 3 | Agent 配置整合 | 引擎/前端/IM 三组折叠面板；统一加载（GET）/保存（POST `/api/plugins/agent-framework/config`） |
| 4 | 自定义前端 URL | 格式校验（协议/主机/端口）、可访问性检测、访问按钮、错误提示、保存拦截 |
| 5 | 用户体验引导 | 帮助图标、使用说明弹窗、首次引导（localStorage 标记）、入口按钮醒目 |

## 2. 测试用例与结果（28 例专项 + 全量回归）

### 2.1 URL 格式校验（`validateAgentFrontendUrl`，纯函数）

| 用例 | 输入 | 预期 | 结果 |
|------|------|------|------|
| 空值 | `''` / 空白 / `undefined` / `null` | 无效 | ✅ |
| 无协议头 | `127.0.0.1:3210/agent` | 无效，提示含 `http://` | ✅ |
| 非法协议 | `javascript:alert(1)` | 无效（拒绝 XSS 向量） | ✅ |
| 非法协议 | `file:///etc/passwd` | 无效（拒绝本地文件读取） | ✅ |
| 非法协议 | `data:text/html,...` | 无效 | ✅ |
| 非法协议 | `ftp://...` | 无效 | ✅ |
| 仅协议无主机 | `http://` / `https://` | 无效 | ✅ |
| 端口越界 | 端口 `0` / `70000` / 非数字 | 无效 | ✅ |
| 主机含空格/控制字符 | 主机名带 `\s`/`\u0000` | 无效 | ✅ |
| 合法 URL | `http://127.0.0.1:3210/agent`、`https://example.com:8443/path` | 有效，返回 protocol/hostname/port | ✅ |

### 2.2 可访问性检测（`checkAgentFrontendReachable`，mock fetch）

| 用例 | mock 响应 | 预期 | 结果 |
|------|-----------|------|------|
| 2xx | `200` | `ok:true, status:200` | ✅ |
| 3xx（重定向跟随） | `302` | `ok:true, status:302` | ✅ |
| 4xx（页面存在即可访问） | `404` | `ok:true, status:404` | ✅ |
| 5xx（服务异常） | `500` | `ok:false, error` 含"服务异常" | ✅ |
| 连接拒绝 | fetch 抛 `ECONNREFUSED` | `ok:false`，提示"拒绝连接（服务未启动或端口未监听）" | ✅ |
| 域名无法解析 | fetch 抛 `ENOTFOUND` | `ok:false`，提示"域名无法解析" | ✅ |
| 超时 | fetch 挂起至 `AbortError` | `ok:false`，提示"连接超时" | ✅ |
| 非本机地址 | `https://example.com` | 额外 `warning` 字段提醒可信性 | ✅ |
| 本机地址 | `http://localhost:...` | 无 warning | ✅ |

### 2.3 路由处理函数（`createAgentFrontendValidateHandler`）

| 用例 | 输入 | 预期 | 结果 |
|------|------|------|------|
| 正常请求 | `{ url }` | `res.json` 返回统一结构 | ✅ |
| 异常兜底 | handler 抛错 | `res.status(500)` 可读错误 | ✅ |

### 2.4 边界条件（需求 6）

| 场景 | 处理 | 结果 |
|------|------|------|
| 保存时 URL 非法（前端 `^https?://` 校验） | 阻止保存 + 提示 | ✅ |
| URL 留空 | 「访问」回退 `${serverUrl}/agent` | ✅ |
| 首次打开独立页 | 自动弹出使用说明弹窗 + 写 `gateway_agent_guide_done` | ✅ |
| "不再提示"勾选 | 写入 localStorage，后续不再弹窗 | ✅ |
| 独立页网关 Token 为空 | API 请求不带 token；SSE 走 query token | ✅ |

### 2.5 全量回归

| 项 | 结果 |
|---|---|
| `npm test`（node --test --test-force-exit） | **779 pass / 0 fail**（751 既有 + 28 新增，无回归） |
| `node --check`（9 个改动 JS） | 全部通过 |
| grep 残留（`gateway_agent_body`/`gateway_theatre_body`/`bindAgentEvents`/`tryAgentAutoLoad`/`panel-agent-theatre.js` 于 panel.html 与根 index.js） | 0 匹配 |
| 图标去重（`fa-robot` 使用方） | 自建推理管线唯一保留；独立页 Agent 设置用 `fa-sitemap` |

## 3. 问题修复情况

| 问题 | 处理 |
|------|------|
| 规格偏差：响应契约初版不符（4xx 语义、`data.ok`） | 重写 `server/agent-frontend.js` 为统一 `{ok, status?, error?}` 契约，前端按契约消费 |
| ST 桥清除残留：RP_TUTORIAL 3.2"ST 兼容前端桥"章节未删净 | 本轮清除该章节，并重编号 3.3→3.2、3.4→3.3 |
| FRAMEWORK_GUIDE 13.4"Agent 专用前端"描述过时（panel.html 剧场） | 更新为独立页 `/agent` 说明 |
| IM 集成组原为可编辑字段 | 改为只读命令速查（后端无 `/api/agents/status` 端点，避免引入不存在的依赖） |

## 4. 兼容性说明

- 目标浏览器：现代 Chrome/Edge/Firefox（独立页使用原生 `EventSource` + `fetch` + `AbortController`，无框架依赖）。
- 独立页不依赖 SillyTavern 上下文（`getContext` 无关），可在任意浏览器直连网关。
- 网关面板（ST 抽屉）剥离后仅保留网关核心配置 +「Agent 前端」入口按钮，不影响 IM 适配器配置与正则配置。

## 5. 遗留与建议

- `panel-agent-theatre.js` / `GET /agent-theatre.js`（server/index.js）为历史遗留（已标注废弃，无引用方），建议后续清理。
- `public/agent.js` 前端 URL 校验与 `server/agent-frontend.js` 为双实现（浏览器/Node 双环境，未抽共享），改动时需同步。
- 独立页连接配置使用独立 localStorage 键（`gateway_agent_url`/`gateway_agent_token`），未与 ST 面板存储键互通。
