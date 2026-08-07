# Agent 剧场 完整前端渲染引擎（R2）实现文档

> 版本：v1.0 ｜ 日期：2026-08-07 ｜ 模块：`public/agent-renderer.js` + `public/agent-compat.js`（增强） + `server/agent/regex-engine.js`（复用）
> 目标：实现与 SillyTavern 酒馆助手（JS-Slash-Runner）同等水平的前端渲染能力。

---

## 1. 概述

Agent 剧场此前仅支持**一套标准预设标签**（`<maintext>/<option>/<sum>/<stu>/<UpdateVariable>/<Analysis>/<mission>`），
不同角色卡作者自定义的标签无法渲染。R2 引入完整前端渲染引擎，参照酒馆助手
「**正则捕获标签 → 替换为 HTML/CSS → sanitize → 注入消息气泡**」的核心机制：

- **通道 A「正则 HTML 直通」**：角色卡/全局正则脚本在服务端 AI_OUTPUT 阶段把任意作者标签
  替换为 HTML（酒馆助手同机制，`markdownOnly` 仅影响显示、历史保留原文），前端白名单
  sanitize 后直接注入消息气泡。
- **通道 B「标签渲染」**：预设标签 + 通用标签注册表（`TagRegistry`），作者自定义
  `<foo>...</foo>` / `{{foo::...}}` / `【foo】...` 三种形态均可注册渲染器。
- 双通道**无缝切换**：文本含正则 HTML 输出时走通道 A，否则通道 B，无标签时纯文本保底。

---

## 2. 架构与核心逻辑

### 2.1 模块结构

```
public/agent-renderer.js     渲染引擎（ESM，浏览器挂 window.AgentRenderer，Node 可直接 import 测试）
├── sanitizeHtml()           白名单 HTML 清理器（无 DOM 依赖，正则实现）
├── hasHtmlMarker()          通道 A 判据（识别正则输出的 HTML 标记）
├── TagRegistry              通用标签注册表
│   ├── registerTag()        <name>内容</name> 块标签
│   ├── registerMacro()      {{name::参数}} 宏标签
│   └── registerLine()       【name】... 行级标签
├── renderText()             通道 B 渲染入口（块 → 宏 → 行 → 安全区拼接）
├── renderMessage()          消息渲染主入口（双通道分派）
├── resolveStatusPlaceholder()  <StatusPlaceHolderImpl/> 检测与剥离
└── renderMvuStatusBar()     MVU 状态栏 HTML（键值网格 + 来源标记）

public/agent-compat.js       增强：enhanceFloors 增加通道 A 直通（优先级最高），原文折叠共用
server/agent/regex-engine.js 复用：getRegexedString（AI_OUTPUT 替换）+ 角色卡内嵌正则导入
```

### 2.2 双通道渲染管线

```
主 Agent 输出（含任意作者标签 / 预设标签）
        │
        ▼
服务端 getRegexedString(mainText, AI_OUTPUT, { isMarkdown: true, scripts })
  ├─ 角色卡内嵌正则（importRegexFromCard 自动导入，source=character:名称）
  ├─ 全局正则
  └─ markdownOnly=true 脚本：把标签替换为 HTML（仅显示层，历史存原文）
        │
        ▼
displayText（stripForDisplay 剥离 MVU 内部块，保留正则 HTML 输出）
        │
        ▼
前端 renderMessage(text)
  ├─ hasHtmlMarker(text) ? ──→ 通道 A：sanitizeHtml → innerHTML 注入气泡（mode=html）
  └─ 否则 ────────────────→ 通道 B：renderText（预设 + 注册表 → mode=tags）
        无标签 → 纯文本转义换行（mode=plain）
```

### 2.3 白名单 sanitize（安全核心）

正则实现、无 DOM 依赖、Node 可测，四层防护：

1. **危险标签整体删除**（成对 + 自闭合）：`script / style / iframe / object / embed / link /
   meta / form / input / textarea / svg / math / video / audio` 等。
2. **事件属性剔除**：所有 `on*` 属性（onclick/onerror/onload…）。
3. **危险协议拒绝**：`javascript: / vbscript: / data:` URL；`href` 仅允许
   `http(s): / mailto: / tel: / # / /`。
4. **style 值白名单**：拒绝 `url() / expression() / @import / behavior / -moz-binding`，
   属性名仅允许布局/字体/颜色等常见 CSS。

白名单标签（div/span/table/p/b/strong/i/em/u/s/del/code/pre/blockquote/h1-h6/ul/ol/li/img/a/button/…）
保留并清理属性（`class / style / title / data-*` 放开，其余按标签收敛）；
**未知标签（含连字符名，如 `<custom-tag>`）转义为纯文本**，杜绝 XSS 注入面。

### 2.4 TagRegistry 通用标签注册表

不依赖一套标准预设标签。三种注册形态，作者/用户可动态扩展：

```js
// 块标签：<skill>火球术</skill>
AgentRenderer.registerTag('skill', (inner) =>
    '<div class="skill">🎴 ' + AgentRenderer.escapeHtml(inner) + '</div>');

// 宏标签：{{getvar::好感度}}
AgentRenderer.registerMacro('getvar', (param) =>
    '<span class="var">' + AgentRenderer.escapeHtml(param) + '</span>');

// 行标签：【状态】好感度 80（@@consume 前缀：该行被消费，从原文移除）
AgentRenderer.registerLine(/^【状态】\s*(.+)$/, (m) =>
    '@@consume<div class="line-status">📊 ' + AgentRenderer.escapeHtml(m[1]) + '</div>');
```

渲染输出以「安全区哨兵」包裹，最终拼接时**可信 HTML 直通、其余文本转义**，
既保证作者自定义渲染器的表现力，又保证普通文本永不丢失/永不被注入。

预设标签（`<maintext>/<mission>/<sum>`）已默认注册，行为与既有兼容层一致。

### 2.5 StatusPlaceHolderImpl 与 MVU 状态面板

- `<StatusPlaceHolderImpl/>` 是 MVU 变量的**通用正则捕获标签**：
  - 作者可在角色卡正则中 `find: <StatusPlaceHolderImpl\s*/?>` → `replace: <div class="自定义状态栏">…</div>`，
    服务端 AI_OUTPUT 阶段即完成替换，正文以通道 A 渲染作者自定义状态栏。
  - 未配置正则时，前端 `resolveStatusPlaceholder()` 剥离占位符（不显示在正文），
    状态面板由 `renderMvuStatusBar(stat_data)` 渲染 MVU 键值网格（含变量处理子代理
    `via=processor` 来源标记），面板位置由 agent.html 中的 `<StatusPlaceHolderImpl/>` 组件确定。
- 状态面板渲染链路（R1 已落地）：`/input` 变量处理子代理 → `variables.stat_data` 广播 →
  前端 `renderMvuStatePanel` / `renderMvuStatusBar` 可视化。

---

## 3. 与酒馆助手（JS-Slash-Runner）对照

| 环节 | 酒馆助手 | Agent 剧场 R2 |
|---|---|---|
| 正则脚本来源 | 角色卡/世界书/全局 `RegexScriptData` | 角色卡内嵌 `extensions.regex_scripts` + 全局，`importRegexFromCard` 自动导入 |
| 替换时机 | AI_OUTPUT 阶段 `getRegexedString` | 同（服务端复用同一机制） |
| 显示层隔离 | `markdownOnly`，历史存原文 | 同（`markdownOnly` 仅影响显示） |
| HTML 注入 | ST markdown + DOMPurify sanitize | 白名单 sanitize（正则实现，等效防护） |
| 任意标签支持 | 作者正则任意替换 | 通道 A（正则）+ 通道 B（注册表）双保险 |
| 状态占位 | MVU `<StatusPlaceHolderImpl/>` | 同（正则替换 / 状态面板渲染双路径） |
| 渲染宿主 | srcdoc iframe | 原生 DOM（决策：不移植 iframe） |

---

## 4. 部署与使用说明

### 4.1 部署

无构建、无新依赖。文件已就位：

- `public/agent-renderer.js` —— 已由 `agent.html` 以 `<script type="module">` 引入（DOMContentLoaded 前挂载 `window.AgentRenderer`）。
- `public/agent-compat.js` —— 已增强通道 A 直通。
- `server/agent/regex-engine.js` —— 既有能力，无需改动。

重启网关服务即可生效。浏览器无需缓存清理（静态资源）。

### 4.2 角色卡作者：用正则注册自定义标签

角色卡 `extensions.regex_scripts` 中按 SillyTavern 格式声明（Agent 剧场 UI：
设置 → 正则脚本 → 「从角色卡导入」/「导入全部角色卡」自动导入）：

```json
[
  {
    "scriptName": "技能卡渲染",
    "findRegex": "<skill>([\\s\\S]*?)</skill>",
    "replaceString": "<div class=\"skill-card\">🎴 $1</div>",
    "placement": [2],
    "markdownOnly": true
  }
]
```

说明：
- `placement: [2]` = AI_OUTPUT；`markdownOnly: true` = 仅显示层替换，提示词/历史保留原文。
- `$1/$<name>`/`{{match}}` 替换变量均支持。
- 替换目标应为**白名单标签**（div/span/table/…）以保证样式稳定；脚本/事件属性会被自动清除。

### 4.3 用户/开发者：前端注册表扩展

在控制台或脚本中：

```js
AgentRenderer.registerTag('物品', (inner) => '<div class="item">🧰 ' + AgentRenderer.escapeHtml(inner) + '</div>');
```

支持块 / 宏 / 行三种形态；handler 抛错不影响其他内容渲染（单标签降级）。

### 4.4 错误处理与优雅降级

| 异常场景 | 处理 |
|---|---|
| 正则编译失败 | 服务端跳过该脚本（`parseRegex` 容错） |
| 正则输出非法/危险 HTML | sanitize 清理；清理后为空 → 降级通道 B |
| 标签格式错误/未闭合 | 不崩溃，原样转义保留 |
| handler 抛错 | 单标签降级，其余内容正常 |
| sanitize 异常 | 返回空串 → 纯文本保底 |
| 超长文本（>100KB 检测截断） | 防灾难性回溯，渲染有界 |

---

## 5. 测试报告

### 5.1 测试文件

`test/render-engine.test.js` —— 36 用例，全量回归 **1109 通过 / 0 失败**
（基线 1073 + 新增 36）。

### 5.2 用例清单与结果

| 分组 | 用例数 | 覆盖内容 | 结果 |
|---|---|---|---|
| sanitize 白名单 | 6 | 危险标签剥离（成对/自闭合）、on* 事件、危险协议、style 注入、未知标签转义、异常输入 | ✅ 全部通过 |
| 双通道渲染 | 7 | hasHtmlMarker 判据、通道 A 直通、XSS 自动清理、通道 B 预设标签、混合内容不丢原文、空输入、plainText | ✅ 全部通过 |
| TagRegistry 注册表 | 4 | 自定义块/宏/行标签、handler 抛错降级 | ✅ 全部通过 |
| StatusPlaceHolderImpl | 3 | 检测/剥离、renderMvuStatusBar（含 via 标记）、flattenVars 数组路径 | ✅ 全部通过 |
| 边界条件 | 5 | 未闭合标签、嵌套、重复标签、100KB 超长输入、escapeHtml 全转义 | ✅ 全部通过 |
| 特殊字符 | 4 | 中文/emoji/全角、HTML 实体、标签内特殊字符、XSS 组合攻击 | ✅ 全部通过 |
| 性能 | 3 | 2000 标签 sanitize、1000 标签渲染、混合复杂场景 | ✅ 全部通过 |
| 集成（服务端正则→前端） | 4 | 自定义标签→HTML 替换、通道 A 渲染、恶意 replaceString 拦截、parseRegex/validateRegex | ✅ 全部通过 |

### 5.3 性能实测

| 场景 | 耗时 |
|---|---|
| 2000 个 HTML 标签 sanitize | ~1.5ms（上限 2000ms） |
| 1000 个预设标签渲染 | ~3.5ms（上限 2000ms） |
| 复杂场景（混合 HTML + 标签 + 长文本） | ~0.8ms（上限 2000ms） |
| 100KB 超长输入 | <2ms |

### 5.4 安全验证要点

- `<script>alert(1)</script>`、`<style>`、`<iframe>`、`<object>`、`<embed>` 全部清除（含内部内容）。
- `onclick/onerror/onmouseover` 等事件属性剥离。
- `javascript: / data: / vbscript:` URL 拒绝；`href` 仅允许安全协议。
- style 中 `url() / expression() / @import / behavior` 拒绝。
- 正则 `replaceString` 注入脚本被 sanitize 拦截，正文内容保留。

---

## 6. 兼容性说明

- 预设标签（`<maintext>/<option>/<sum>/<stu>/<UpdateVariable>/<Analysis>/<mission>`）行为不变。
- 读档 / 编年史 / 变量查看器 / 思维链查看器 / 小手机等既有功能不受影响（数据层不变）。
- 关闭「前端卡」开关（`agent_compat_prefs`）时通道 A/B 一并关闭，回到纯文本楼层。
- 渲染引擎为 ES Module：Node 直接 `import` 测试；浏览器经 module 脚本挂载 `window.AgentRenderer`，
  经典脚本（agent.js/agent-compat.js）运行时调用，无加载时序冲突。
