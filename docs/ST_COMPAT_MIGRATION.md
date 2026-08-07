# SillyTavern 前端生态 → Agent 剧场 迁移指南

> 面向**角色卡作者**与**玩家**：如何把已在 SillyTavern（含酒馆助手 / MVU）环境中运行的角色卡，无缝迁入 Agent 剧场（`/agent` 页面）游玩。
> 适用版本：agent 剧场（public/agent.* + server/agent-api.js）+ ST 兼容层（server/agent/mvu-engine.js + public/agent-compat.*）。

---

## 1. 一句话说明

Agent 剧场内置了 **MVU 兼容运行时** 与 **前端卡渲染层**，角色卡无需安装酒馆助手 / MVU / ST-Prompt-Template 三个插件，`<maintext>`、`<option>`、`<sum>`、`<stu>`、`<UpdateVariable>` 等格式开箱即用。

## 2. 角色卡作者迁移清单

### 2.1 需要保留的（原样可用）
| 格式/功能 | 说明 |
|---|---|
| `<maintext>...</maintext>` 正文标签 | 渲染为正文卡 |
| `<option>...</option>` 选项标签（`X. 文本` 或 `>选项X：文本`） | 并入选项区，可点击发送 |
| `<sum>...</sum>` 小总结 | 自动累积为「编年史」，支持读档 |
| `<stu>...</stu>` 状态栏文本 | 渲染为美化状态栏卡（`N/100` 自动进度条） |
| `<UpdateVariable>` 差分块 | 三种语法（JSON Patch / `set\|old→new\|()` / `_.set`）自动应用 |
| `{{get_message_variable::path}}` / `{{format_message_variable::stat_data}}` | 在「变量列表」世界书条目中自动展开 |
| `<StatusPlaceHolderImpl/>` 占位符 | 显示层自动隐藏 |

### 2.2 需要删除 / 更换的
| 原做法（ST/酒馆助手） | Agent 剧场替代 |
|---|---|
| 安装酒馆助手 + MVU + ST-Prompt-Template 三个插件 | 无需安装 |
| 局部正则（`<StatusPlaceHolderImpl/>` 替换为 HTML） | 无需正则；剧场原生渲染状态栏卡 |
| 前端卡直接调用 `getCurrentMessageId()` / `getChatMessages()` / `triggerSlash('/setinput …')` 等酒馆助手 iframe API | **不执行卡内 JS**；改为声明 `<maintext>/<option>/<stu>/<sum>` 标签 + CSS 样式（见 §4 差异说明） |
| `[initvar]初始` 世界书条目自动初始化变量 | 在剧场「🧪 变量 → 初始化 / 覆盖变量」弹窗粘贴初始变量 JSON 一次 |
| 读档 `/branch-create <楼层>` | 「💾 读档」弹窗选择带 `<sum>` 的楼层，截断会话回到该处 |

### 2.3 推荐的「变量列表」世界书条目（原样可迁）
```yaml
---
<status_current_variable>
{{format_message_variable::stat_data}}
</status_current_variable>
```

### 2.4 推荐的「变量输出格式」条目（原样可迁）
`<UpdateVariable>` + `<Analysis>` + `<JSONPatch>`（RFC 6902 子集：replace / delta / insert / remove / move），`move` 的 `to` 字段同样支持。示例：
```yaml
format: |-
  <UpdateVariable>
  <Analysis>$(EN, ≤80 words)</Analysis>
  <JSONPatch>
  [
    { "op": "replace", "path": "/角色/络络/好感度", "value": 68 },
    { "op": "delta",   "path": "/角色/络络/好感度", "value": 2 },
    { "op": "insert",  "path": "/物品栏/-", "value": "盾牌" },
    { "op": "move",    "from": "/角色/络络/心情", "to": "/角色/心情备份" }
  ]
  </JSONPatch>
  </UpdateVariable>
```

## 3. 前端功能入口一览

| 入口 | 功能 |
|---|---|
| 右下角 📱 悬浮按钮（小手机） | 拖拽/点击展开面板，含「编年史 / 变量 / 思维链」页签 + 底部「阅读 / 读档 / 变量」快捷按钮 |
| 编年史页签 | 每楼 `<sum>` 自动累积，编号显示，localStorage 持久化（按角色隔离） |
| 变量页签 / 🧪 变量 | 查看 stat_data 树；「初始化 / 覆盖变量」弹窗可粘贴初始 JSON（对应 `[initvar]初始`） |
| 思维链页签 | 展示每楼 `<Analysis>` 与 `<UpdateVariable>` 内容 |
| 💾 读档 | 列出带 `<sum>` 的楼层，选择后截断会话（本地楼层 + 服务端历史）回到该处 |
| 📖 阅读 | 全屏阅读模式：按楼层展示 `<maintext>` 与 `<mission>`，首行缩进排版 |
| 楼层「查看原文」 | 前端卡模式下折叠原始文本，可随时展开 |

## 4. 与 SillyTavern / 酒馆助手 的关键差异（务必知晓）

1. **卡内 JS 不执行**。酒馆助手用 iframe 沙箱执行角色卡里的 JavaScript（`getChatMessages`、`triggerSlash`、`Mvu.getMvuData` 等）。Agent 剧场不提供 JS 执行通道——这是安全与架构的选择。**替代范式**：让 AI 输出数据标签（`<maintext>/<option>/<stu>/<sum>/<UpdateVariable>`），剧场负责渲染。纯「数据卡」完全兼容；依赖 JS 交互的卡需按 §2.2 改造。
2. **变量初始化**：无 `[initvar]` 自动初始化通道，首次游玩前需手动「初始化变量」一次（粘贴初始 JSON）。未初始化时 `{{format_message_variable::stat_data}}` 输出为空，属预期。
3. **读档语义**：ST 是「分支」；剧场是「截断回该楼」——截断之后的楼层与服务端历史被移除，不可恢复，读档前请留意。
4. **正则美化卡**（`[LOVE_DATA]` 行 + 局部正则）暂未提供正则渲染通道（P2 路线图）；此类卡的数据行会以原文显示。
5. **显示与上下文分离**：`<UpdateVariable>` 块从显示层剥离，但保留在历史中供模型读取（与 ST 行为一致）。

## 5. 已知限制与路线图（P2）

- `[LOVE_DATA]` 正则美化状态栏：提供前端正则渲染通道。
- 大总结（编年史范围压缩）、第二 API（多 API 分工）：服务端生成接口预留。
- 标题页面 / 开局创建：首轮引导表单。
- `{{isMobile}}`：当前固定 false（移动端 UA 判定待接入）。
- 前端卡渲染为「标签 + 原生 DOM」，不支持 iframe 沙箱卡内脚本执行。

## 6. 验证建议（作者自测清单）

1. 用一张纯「数据标签卡」（maintext/option/sum/stu/UpdateVariable）跑通 3 轮：正文卡、选项点击、状态栏进度条、编年史累积。
2. 粘贴初始变量 JSON 后发一轮含 `<UpdateVariable>` 的回复 → 变量查看器数值变化。
3. 读档：选一个旧 `<sum>` 楼层截断 → 楼层与服务端历史同时回到该处。
