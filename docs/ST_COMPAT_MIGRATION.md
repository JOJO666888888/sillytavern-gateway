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
| 右下角 📱 悬浮按钮（小手机） | 拖拽/点击展开面板，含「编年史 / 变量 / 脚本」页签 + 底部「阅读 / 读档 / 变量 / 脚本」快捷按钮 |
| 编年史页签 | 服务端「编年史子代理」每轮实时生成的剧情总结（服务端同步，localStorage 仅缓存） |
| 变量页签 / 🧪 变量 | 查看 stat_data 树与变更历史（子代理/标签来源标记）；「初始化 / 覆盖变量」弹窗可粘贴初始 JSON（对应 `[initvar]初始`） |
| 脚本页签 / 🛠 脚本 | 对标酒馆助手脚本库：全局/角色脚本分类、新建/导入/编辑/保存/运行/按钮触发/版本回滚/执行日志（详见 §5） |
| 💾 读档 | 列出带 `<sum>` 的楼层，选择后截断会话（本地楼层 + 服务端历史）回到该处 |
| 📖 阅读 | 全屏阅读模式：按楼层展示 `<maintext>` 与 `<mission>`，首行缩进排版 |
| 楼层「查看原文」 | 前端卡模式下折叠原始文本，可随时展开 |

## 4. 与 SillyTavern / 酒馆助手 的关键差异（务必知晓）

1. **卡内 JS 通过「脚本库」执行（对标酒馆助手）**。酒馆助手用 iframe 沙箱执行角色卡脚本；Agent 剧场提供**服务端 Node vm 沙箱** + 酒馆助手兼容 API 桥（`getChatMessages` / `triggerSlash` / `eventOn` / `getVariables` / `Mvu.*` / `generateRaw` 等）。角色卡 `extensions.tavern_helper.scripts` 在角色加载时**自动同步导入**到小手机脚本库（见 §5）；**首次导入默认禁用，需在小手机脚本 tab 手动启用后才参与事件执行**（安全设计）。纯「数据标签卡」不依赖脚本，完全兼容。
2. **变量初始化**：无 `[initvar]` 自动初始化通道，首次游玩前需手动「初始化变量」一次（粘贴初始 JSON）。未初始化时 `{{format_message_variable::stat_data}}` 输出为空，属预期。
3. **读档语义**：ST 是「分支」；剧场是「截断回该楼」——截断之后的楼层与服务端历史被移除，不可恢复，读档前请留意。
4. **正则美化卡**（`[LOVE_DATA]` 行 + 局部正则）暂未提供正则渲染通道（P2 路线图）；此类卡的数据行会以原文显示。
5. **显示与上下文分离**：`<UpdateVariable>` 块从显示层剥离，但保留在历史中供模型读取（与 ST 行为一致）。

## 5. 脚本库（对标酒馆助手 Tavern-Helper）

Agent 剧场内置**酒馆助手脚本库兼容层**，支持将酒馆助手脚本生态无缝迁移：

- **存储与分类**：`data/agent-scripts.json`。全局脚本库（所有聊天生效）+ 角色脚本库（绑定角色卡）。数据形态与酒馆助手 ScriptTree 完全一致（`type/enabled/name/id/content/info/button/data/export_with`）。
- **角色卡自动同步**：角色卡 `extensions.tavern_helper.scripts`（旧字段 `TavernHelper_scripts` 自动兼容）在角色加载时自动导入到角色脚本库；同 id 脚本覆盖更新（保留你的启用状态、按钮与版本历史），新脚本追加。**首次导入默认禁用**——在小手机脚本 tab 勾选启用后才参与每轮事件执行。
- **执行时机**：① 手动/脚本按钮运行；② 每轮对话后触发 `GENERATION_ENDED` / `MESSAGE_RECEIVED` 事件；③ 角色卡加载触发 `CHARACTER_LOADED`（脚本用 `eventOn(tavern_events.MESSAGE_RECEIVED, ...)` 等实现"每 N 楼自动总结"等后台功能）。
- **API 兼容**：脚本内可直接使用 `getChatMessages/getLastMessageId/setChatMessages/deleteChatMessages`、`getVariables/replaceVariables/updateVariablesWith/insertOrAssignVariables/insertVariables/deleteVariable`（`chat` 作用域 = MVU stat_data）、`Mvu.getMvuData/replaceMvuData/parseMessage`、`eventOn/eventOnce/eventEmit/getButtonEvent`、`triggerSlash`（`/pass /echo /wait /getvar /setvar`）、`generate/generateRaw`（需主 LLM 配置；`custom_api` 需自带 apiKey）、`initializeGlobal/waitGlobalInitialized`、内置 `_`（安全 lodash 子集）与 `$`（jQuery 桩）。
- **编辑/版本**：小手机脚本 tab 支持新建/导入（文本或酒馆助手导出 JSON）/编辑/保存/运行/按钮触发/删除，每次保存自动留版本快照（最多 20 个），可回滚。
- **安全边界（重要）**：脚本在服务端 `vm` 沙箱执行，**请只运行你信任的脚本**（与酒馆助手 iframe 同源执行同级信任模型）。角色卡脚本默认禁用即为此设计。沙箱不注入宿主构造器与原生 lodash、受控定时器（脚本结束自动清理）、`custom_api` 不借用主 API Key；`_.set/_.unset` 过滤 `__proto__/constructor/prototype` 防原型污染。

## 6. 已知限制与路线图（P2）

- `[LOVE_DATA]` 正则美化状态栏：提供前端正则渲染通道。
- 大总结（编年史范围压缩）、第二 API（多 API 分工）：服务端生成接口预留。
- 标题页面 / 开局创建：首轮引导表单。
- `{{isMobile}}`：当前固定 false（移动端 UA 判定待接入）。
- 脚本 `setInterval` 仅脚本执行期间有效（每次事件重跑后清理）；`$.ajax` 等 DOM/网络 jQuery API 在服务端沙箱不可用。
- 楼层思考面板（`<Analysis>` 思维链展示）保留在楼层内；小手机原「思维链查看器」已移除，由脚本库替换。

## 7. 验证建议（作者自测清单）

1. 用一张纯「数据标签卡」（maintext/option/sum/stu/UpdateVariable）跑通 3 轮：正文卡、选项点击、状态栏进度条、编年史累积。
2. 粘贴初始变量 JSON 后发一轮含 `<UpdateVariable>` 的回复 → 变量查看器数值变化。
3. 读档：选一个旧 `<sum>` 楼层截断 → 楼层与服务端历史同时回到该处。
4. 脚本：在小手机脚本 tab 新建一个脚本（如 `eventOn(tavern_events.MESSAGE_RECEIVED, d => console.log('收到新消息', d.message_id))`），启用后跑一轮对话 → 执行日志出现输出；再尝试「从角色卡同步」导入卡内 `tavern_helper.scripts`。
