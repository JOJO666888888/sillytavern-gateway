# SillyTavern Multi-Platform Gateway — 项目交接文档

> **用途**：供新 AI 编码助手快速全面了解本项目架构、代码组织、设计决策、已知问题和开发约定。
> **最后更新**：2026-07-19
> **GitHub**：https://github.com/JOJO666888888/sillytavern-gateway

---

## 1. 项目概述

**SillyTavern Multi-Platform Gateway** 是一个将 SillyTavern（AI 角色扮演前端）与多个即时通讯平台（QQ/Telegram/Discord）桥接的网关系统。它让用户可以通过手机上的 IM 应用与 SillyTavern 中的 AI 角色对话，AI 回复自动转发回 IM 平台。

**核心能力**：
- 多平台适配器（QQ OneBot v11、Telegram Bot API、Discord Bot）
- 插件系统（命令路由 + 事件管线 + 出站过滤器链）
- AI 自动回复闭环（IM 消息 → ST 注入 → AI 生成 → 回复转发）
- SillyTavern 前端集成（顶级设置面板 + 抽屉式配置）
- GitHub 插件市场 + 一键安装

**外部依赖**（见 `package.json`）：
- `discord.js` v14、`node-telegram-bot-api`、`ws`（OneBot WebSocket）
- `express`（HTTP API 服务）、`eventemitter3`（消息总线）
- `winston`（日志）、`uuid`

**运行环境**：Node.js ≥ 18，ES Module（`"type": "module"`），Windows/Linux/macOS

---

## 2. 目录结构

```
sillytavern-gateway/
├── index.js              # 🔑 SillyTavern 前端扩展入口（1396行）
├── manifest.json         # ST 扩展注册清单
├── package.json          # Node 项目元数据（ESM）
├── style.css             # ST 前端面板样式（880行）
├── panel.html            # 网关管理面板 HTML（277行）
├── settings.html         # ST 扩展设置页 HTML（100行）
├── window.html           # 独立弹出窗口 HTML
├── test-loader.js        # 扩展加载测试
├── README.md             # 用户安装指南
├── PROJECT_HANDOFF.md    # 👈 本文档
│
├── config/
│   └── gateway.json      # 网关全局配置（端口、适配器参数、队列设置）
│
├── data/
│   ├── plugins/           # 插件配置持久化目录（每个插件一个 .json）
│   │   └── regex-filter.json
│   └── sessions.json     # 会话历史持久化（自动生成）
│
├── docs/
│   └── PLUGIN_DEVELOPMENT_GUIDE.md  # 插件开发规范指南（718行）
│
├── logs/
│   ├── combined.log      # Winston 聚合日志
│   └── error.log         # 错误日志
│
├── plugins/              # 插件目录（每个子目录一个插件）
│   ├── regex-filter/     # 🔑 正则过滤器插件（内置）
│   │   ├── plugin.json   #   配置 schema 定义 + 默认值
│   │   └── index.js      #   插件实现（450行）
│   ├── example-hello/    # 示例：简单 Hello World 插件
│   └── example-dice/     # 示例：掷骰子插件
│
└── server/               # 🔑 网关后端（独立 Node 进程）
    ├── index.js           #   服务入口：Express + 适配器初始化 + API 路由（317行）
    ├── gateway-core.js    #   消息总线核心：适配器管理 + 入/出站路由 + 队列 + 去重（388行）
    ├── message-queue.js   #   消息队列：可靠投递 + 指数退避重试（168行）
    ├── session-manager.js #   会话管理：platform+chatId → 对话历史（304行）
    ├── plugin-manager.js  #   插件生命周期：加载/卸载/启用/禁用/GitHub安装/REST API（640行）
    ├── plugin-loader.js   #   插件发现与动态加载（227行）
    ├── plugin-sdk.js      #   插件基类 GatewayPlugin + 辅助函数（183行）
    ├── plugin-context.js  #   插件上下文 ctx：reply/send/getHistory/stopPropagation（219行）
    ├── command-router.js  #   命令路由器：/command 解析 → handler（216行）
    ├── event-pipeline.js  #   事件管线：按 priority 分发消息到监听器（156行）
    │
    ├── adapters/
    │   ├── base-adapter.js    # 适配器基类 + InboundMessage/OutboundMessage + 重连策略（241行）
    │   ├── onebot-adapter.js  # QQ OneBot v11 适配器（496行）
    │   ├── telegram-adapter.js# Telegram Bot 适配器（352行）
    │   └── discord-adapter.js # Discord Bot 适配器（348行）
    │
    ├── protocols/
    │   └── onebot-v11.js      # OneBot v11 协议解析 + API 封装（342行）
    │
    └── utils/
        ├── config.js          # 配置管理器：加载/保存/深度合并（176行）
        ├── logger.js          # Winston 日志工厂（49行）
        └── reconnect.js       # 指数退避重连策略（116行）
```

**项目中实际生效的两个组件**：
1. **后端服务**（`server/index.js`）— 独立 Node 进程，运行在 `http://127.0.0.1:3210`
2. **ST 前端扩展**（`index.js` + `manifest.json`）— 必须放在 ST 的 `public/scripts/extensions/third-party/sillytavern-gateway/` 目录中

---

## 3. 核心数据流

### 3.1 消息入站流程（IM → ST）

```
手机 IM App 发送消息
    │
    ▼
平台适配器 (discord/telegram/onebot)
    │ .emit('message', InboundMessage)
    ▼
GatewayCore.handleInbound()
    │ ├─ addMessageLog('inbound', msg)
    │ ├─ this.emit('message', msg)
    │ └─ 遍历 messageHandlers
    │
    ▼
setupMessageHandling() 注册的处理器
    │ ├─ sessionManager.addMessage()  ← 记录会话历史
    │ └─ pluginManager.handleMessage()
    │       ├─ /command? → commandRouter.handle() → 插件处理器
    │       └─ 未处理? → eventPipeline.dispatch() → 插件监听器
    │
    ▼ (插件未处理 = 需要 ST AI 回复)
GatewayCore.emit('externalMessage', msg)
    │
    ▼
ST 前端扩展轮询 (fetchGatewayStatus)
    │ ├─ 检查 forwardingEnabled + autoReplyEnabled
    │ ├─ 检查 forwardCutoffTs 时间截断
    │ └─ processIncomingMessages()
    │       ├─ 去重 (processedMessageIds Set)
    │       ├─ sendMessageAsUser() 注入 ST 聊天
    │       └─ context.generate() 触发 AI
    │
    ▼
GENERATION_ENDED 事件
    └─ 提取 lastMessage.mes → apiRequest('/api/gateway/send', ...)
```

### 3.2 消息出站流程（ST → IM）

```
ST 前端: POST /api/gateway/send {platform, chatId, chatType, content}
    │
    ▼
GatewayCore.sendMessage() → messageQueue.enqueue()
    │
    ▼
MessageQueue.processQueue()
    │ (按间隔处理, 失败则指数退避重试 max 3 次)
    │
    ▼
GatewayCore.dispatchOutbound()
    │ ├─ applyOutboundFilters()  ← 🔑 出站过滤器链（正则插件在此）
    │ ├─ 适配器未连接? → throw Error（触发队列重试）
    │ ├─ 出站去重检查 (_recentOutbound, 15s 窗口)
    │ └─ adapter.send()
    │
    ▼
平台适配器.send() → Discord/Telegram/OneBot API
```

### 3.3 AI 回复闭环完整流程

```
[QQ/DC/TG] 用户发消息
  → 适配器接收入站
  → gateway-core 处理
  → pluginManager (命令/管线) → 未处理
  → externalMessage 事件
  → ST 前端轮询倒计时
  → 注入 ST 聊天 (sendMessageAsUser)
  → context.generate() 触发 AI
  → GENERATION_ENDED 捕获 AI 回复
  → /api/gateway/send 发送到网关
  → 消息队列 (可靠投递 + 重试)
  → dispatchOutbound (过滤 + 去重)
  → adapter.send() 发送到原平台
```

---

## 4. 前端扩展架构 (`index.js`)

### 4.1 引导策略

不与 ST 内部路径耦合，统一使用：
- `globalThis.SillyTavern.getContext()` — 官方稳定 API
- `import('/script.js')` — 获取暴露到全局的 `sendMessageAsUser` 等函数
- `import.meta.url` — 自动检测扩展文件夹名

### 4.2 关键全局变量

```javascript
const DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:3210',
    autoConnect: true,
    pollInterval: 3000,
    autoReplyEnabled: true,
    forwardingEnabled: false,  // 🔑 默认游玩模式（不转发消息）
};

let forwardCutoffTs = Date.now();        // 时间截断戳（刷新后重置）
let pendingReplyTarget = null;           // {platform, chatId, chatType}
let processedMessageIds = new Set();     // 去重集合（会话级别）
```

### 4.3 双模式开关

- **游玩模式**（`forwardingEnabled: false`，默认）— 不转发任何消息
- **网关模式**（`forwardingEnabled: true`）— 转发入站消息并自动回复

`forwardCutoffTs` 在页面加载和切换到网关模式时重置，确保刷新后老消息不会涌入。

### 4.4 面板注入

- `panel.html` 注入到 ST 扩展面板（`#extensions_panel` 容器内）
- 使用 `renderExtensionTemplateAsync()` 异步渲染
- 面板注入后再绑定事件（因为 DOM 尚未存在）
- 模式开关在面板头部下方，游玩灰/网关绿配色

### 4.5 正则配置前端

- 抽屉式折叠（`.gateway-collapsible`），点击标题展开/收起
- 箭头通过 `.open` 类旋转 90°
- **自动保存**：添加/删除/切换规则后立即调用 `saveRegexConfig()` 写回后端
- 组号字段（1=第一个捕获组，0=整个匹配，非"生效次数"）

---

## 5. 后端架构

### 5.1 启动流程 (`server/index.js`)

```
startServer()
  ├─ initAdapters()          # 注册 qq/telegram/discord 适配器到 gatewayCore
  ├─ new PluginManager(...)  # 加载插件、注册命令和监听器
  │   └─ pluginManager.init()
  │       ├─ loader.loadAll() → 扫描 plugins/ → 动态 import
  │       └─ registerPlugin() → commandRouter + eventPipeline
  ├─ setupMessageHandling()  # 注册入站消息处理器
  ├─ gatewayCore.start()     # 启动适配器 + 消息队列
  └─ server.listen(PORT)     # HTTP API
```

### 5.2 GatewayCore (`gateway-core.js`)

**职责**：消息总线 + 路由引擎，全系统最核心的模块。

关键方法：
| 方法 | 说明 |
|------|------|
| `registerAdapter(name, adapter)` | 绑定适配器事件（message/connected/disconnected/error） |
| `handleInbound(platform, msg)` | 入站消息入口 → 记录日志 → 触发 handler 链 |
| `sendMessage(msg)` | 将出站消息放入队列 |
| `dispatchOutbound(msg)` | 过滤 → 去重 → 路由到适配器 → send |
| `addOutboundFilter(fn, opts)` | 注册出站过滤器（返回取消函数） |
| `applyOutboundFilters(msg)` | 按 priority 依次执行出站过滤器链 |

**出站去重**：`_recentOutbound` Map，key=`"平台|chatId|内容哈希"`，15秒内重复则跳过。

**消息日志**：`messageLog` 保留最近 200 条（`getStatus()` 返回最近 20 条给前端轮询）。

### 5.3 MessageQueue (`message-queue.js`)

- 队列最大 100 条，满时丢弃最早
- 处理间隔 100ms
- 重试：失败后 exponent=`retryDelay * retryCount`（2s, 4s, 6s），最多 3 次
- 需要 `sendHandler` 抛出异常才会重试（return false 也会触发 `throw new Error('发送返回 false')`）

### 5.4 配置系统 (`utils/config.js`)

- 默认配置在代码中定义（`DEFAULT_CONFIG`）
- 运行时从 `config/gateway.json` 加载
- 用户配置深度合并到默认配置上
- 支持点分隔路径：`configManager.get('adapters.qq.wsUrl')`
- `configManager.update(partial)` 支持部分更新并自动保存

### 5.5 会话管理 (`session-manager.js`)

- Key: `"platform:chatId"`（如 `"discord:1234567890"`）
- 每条消息记录 `{role, content, name, timestamp}`
- 每会话最多 50 条历史（可配置）
- 30 秒定期持久化到 `data/sessions.json`

---

## 6. 插件系统架构

### 6.1 插件开发模型

```javascript
import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class MyPlugin extends GatewayPlugin {
    static commands = [
        { name: 'hello', alias: ['你好'], handler: 'handleHello', description: '打招呼' },
    ];
    static listeners = [
        { event: 'message', filter: { platform: 'qq' }, handler: 'onMessage', priority: 50 },
    ];

    async onLoad() { /* 注册出站过滤器等 */ }
    async onUnload() { /* 清理 */ }

    async handleHello(ctx) {
        await ctx.reply('Hello!');       // 回复到当前会话
        await ctx.replyPrivate(uid, ''); // 私聊回复
        ctx.stopPropagation();           // 阻止后续插件
        ctx.clearHistory();              // 清空会话历史
    }
}
```

### 6.2 插件生命周期

```
发现 → 加载 → onLoad() → 注册命令/监听器 → 运行
                                           │
                    重载 ←── 禁用 ←────────┘
                     │
                    卸载 → onUnload() → 清理
```

### 6.3 关键类

| 类 | 文件 | 职责 |
|----|------|------|
| `GatewayPlugin` | `plugin-sdk.js` | 插件基类，提供 meta/commands/listeners/schedules 声明 + getConfig/setConfig |
| `PluginLoader` | `plugin-loader.js` | 扫描 plugins/ → 动态 import → 验证继承 → 实例化 → onLoad |
| `PluginManager` | `plugin-manager.js` | 生命周期管理 + 配置持久化 + REST API + GitHub 安装 |
| `CommandRouter` | `command-router.js` | `/command` 解析 → 按名称/别名查找 → 执行 handler (含内置 /help, /status, /clear) |
| `EventPipeline` | `event-pipeline.js` | 按 priority 排序 → 逐 listener 分发 → stopPropagation 中断 |
| `PluginContext` | `plugin-context.js` | ctx 对象：reply/send/getHistory/clearHistory/stopPropagation |

### 6.4 出站过滤器链

与命令/监听器不同，出站过滤器链是独立的机制：
```javascript
// 插件在 onLoad() 中注册
gateway.addOutboundFilter((msg) => {
    // 修改 msg.content 或 return null 丢弃消息
    return msg;
}, { name: 'my-filter', priority: 10 });
```
- 按 priority 排序，低值先执行
- 返回 `null` = 丢弃该消息
- 返回修改后的消息 = 继续传递
- 这是正则过滤器插件的核心机制

### 6.5 插件配置持久化

- 保存路径：`data/plugins/{pluginName}.json`
- 插件通过 `this.setConfig(key, value)` 写入，自动调用 `savePluginConfig` 持久化
- 加载时 `loadPluginConfig` 从文件读取并注入到 `_pluginConfig`

### 6.6 GitHub 插件安装

支持格式：
- `https://github.com/user/repo`
- `https://github.com/user/repo/tree/main/subfolder`
- `user/repo`（简写）

流程：下载 ZIP → 解压 → 递归查找 plugin.json → 复制到 plugins/ → 加载

---

## 7. 平台适配器

### 7.1 基类 (`base-adapter.js`)

```
ConnectionState: DISCONNECTED → CONNECTING → CONNECTED
                                   ↓              ↓
                              ERROR          DISCONNECTED
                                                  ↓
                                            RECONNECTING → CONNECTED

InboundMessage:  platform, messageId, chatId, chatType, senderId, senderName,
                 content, mediaUrls, timestamp, mentioned, replyToId, raw

OutboundMessage: platform, chatId, chatType, content, mediaUrls, replyToId, metadata
```

`ReconnectStrategy`：指数退避（初始 5s，最大 60s，倍率 2x，25% 随机抖动），无限制重试。

### 7.2 QQ OneBot 适配器

- 协议：OneBot v11（WebSocket）
- 支持正向 WS（连接 NapCat/Lagrange）和反向 WS（作为服务端等待连接）
- 内置：心跳（30s）、API 调用超时（30s）、消息去重（30s 窗口）
- `chatType`：`'private'` 或 `'group'`

### 7.3 Telegram 适配器

- 使用 `node-telegram-bot-api`
- 支持 Long Polling（默认）和 Webhook
- 群组中 `requireMention` 控制是否需要 @bot
- `allowedUsers` 白名单
- `chatType`：`'private'` 或 `'group'`

### 7.4 Discord 适配器 ⚠️

**最复杂的适配器，有多项特殊处理**：

- 使用 `discord.js` v14
- `chatType`：`'private'`（DM）或 `'channel'`（频道）
- 频道消息 `chatId` = 频道 ID，DM 消息 `chatId` = 用户 ID
- `requireMention`：群聊中需 @bot 或回复 bot 消息才响应
- `allowedChannels` / `allowedUsers` 白名单

**⚠️ 重连机制（2026-07-19 修复）**：
- 原代码用 `once(Events.ClientReady)` 设置 `ready = true`——断连后不再触发，导致永远无法发送
- `ShardDisconnect` 调用 `handleDisconnect()` — 与 discord.js 内部重连竞态
- **修复后**：
  - `once(ClientReady)` 仅用于首次 `emit('connected')`
  - 新增 `on(ShardReady)` + `on(ShardResume)` → 恢复 `ready = true` 和 CONNECTED 状态
  - `ShardDisconnect` 仅设置 `ready = false`，不触发外部重连

**⚠️ 发送消息时 `chatType` 必传**：频道消息若缺少 `chatType`，后端默认填 `'private'`，导致用频道 ID 去 `client.users.fetch()` 查询失败。

---

## 8. API 端点汇总

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/gateway/status` | 网关状态（适配器 + 队列 + 最近消息） |
| GET | `/api/gateway/config` | 获取全局配置 |
| POST | `/api/gateway/config` | 更新全局配置 |
| POST | `/api/gateway/send` | 发送消息到平台 `{platform, chatId, chatType, content}` |
| GET | `/api/gateway/sessions` | 会话列表 |
| GET | `/api/gateway/sessions/:platform/:chatId/history` | 会话历史 |
| DELETE | `/api/gateway/sessions/:platform/:chatId/history` | 清空会话 |
| POST | `/api/gateway/adapters/:name/verify` | 验证适配器连接 |
| POST | `/api/gateway/adapters/:name/:action` | 启动/停止适配器（start/stop） |
| GET | `/api/gateway/health` | 健康检查 |
| GET | `/api/gateway/docs/plugin-guide` | 下载插件开发指南 |
| GET | `/api/plugins` | 列出所有插件 |
| GET | `/api/plugins/:name` | 插件详情 |
| POST | `/api/plugins/:name/enable` | 启用插件 |
| POST | `/api/plugins/:name/disable` | 禁用插件 |
| POST | `/api/plugins/:name/reload` | 重载插件 |
| GET | `/api/plugins/:name/config` | 获取插件配置 |
| POST | `/api/plugins/:name/config` | 更新插件配置 |
| DELETE | `/api/plugins/:name` | 卸载插件 |
| POST | `/api/plugins/install` | 从本地路径安装插件 |
| POST | `/api/plugins/install/github` | 从 GitHub 安装插件 |
| GET | `/api/plugins/marketplace/search?q=` | 搜索插件市场 |

---

## 9. 已知问题与修复记录

### 9.1 消息不受控批量转发（已修复 — commit `52eb67f`）

**症状**：进入 ST 时历史消息涌入，同一消息多次转发。

**根因**：`processedMessageIds` 不持久（页面刷新清空），无时间截断。

**修复**：新增 `forwardingEnabled`（默认 false = 游玩模式）+ `forwardCutoffTs` 时间截断。

### 9.2 正则规则自动消失（已修复 — commit `a547246`）

**症状**：添加的规则刷新后消失。

**根因**：添加只改内存不保存，面板重载时从后端拉取覆盖。

**修复**：增删改操作后立即自动调用 `saveRegexConfig()` 持久化。

### 9.3 Discord 出站失败 + 状态卡"重连中"（已修复 — commit `350f1c5`）

**症状**：入站正常，出站全部失败，状态一直显示重连中。

**三连根因**：
1. `once(ClientReady)` 只触发一次 → 断连后 `ready` 永远为 false
2. 前端未传 `chatType` → 频道消息被当 DM 处理
3. `dispatchOutbound` return false 不抛错 → 队列不重试

**修复**：ShardReady/ShardResume 恢复机制 + chatType 传递 + 抛错触发重试 + 出站去重。

---

## 10. 开发约定

### 10.1 代码风格

- ES Module（`import`/`export`），无 CommonJS
- 所有文件使用 UTF-8
- 类和函数使用 JSDoc 注释
- 日志使用 `createLogger('module-name')` 工厂

### 10.2 前端扩展规范

- 不静态导入 ST 内部模块路径（会因版本/安装位置变化而解析失败）
- 统一使用 `SillyTavern.getContext()` 和 `import('/script.js')`
- HTML 模板中 `<div>` 必须成对闭合，用 `node -e` 验证而非 PowerShell

### 10.3 插件开发规范

- 必须继承 `GatewayPlugin`
- 必须包含 `plugin.json`（含 name、main、priority 等字段）
- 命令用 `static commands` 声明，监听器用 `static listeners` 声明
- 生命周期：`onLoad()` 注册资源，`onUnload()` 清理资源
- 配置持久化：`this.setConfig(key, value)` 自动保存

### 10.4 验证与提交

```powershell
# JS 语法检查
node --check index.js
node --check server/gateway-core.js
node --check server/adapters/discord-adapter.js

# HTML div 平衡检查
node -e "const fs=require('fs');const c=fs.readFileSync('panel.html','utf8');const open=(c.match(/<div/g)||[]).length;const close=(c.match(/<\/div>/g)||[]).length;console.log(open===close?'BALANCED':'UNBALANCED',open,'/',close);"

# Git 推送（需要代理）
git config --local http.proxy http://127.0.0.1:10808
git push origin main
git config --local --unset http.proxy
```

---

## 11. 部署架构

```
┌─────────────────────────────────────────────────────────┐
│  用户手机 / PC                                          │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐               │
│  │   QQ    │  │ Telegram │  │ Discord  │               │
│  └────┬────┘  └────┬─────┘  └────┬─────┘               │
└───────┼────────────┼─────────────┼──────────────────────┘
        │            │             │
        ▼            ▼             ▼
┌───────────────────────────────────────────────┐
│  网关后端 (server/index.js :3210)             │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐     │
│  │ OneBot   │ │ Telegram  │ │ Discord  │     │
│  │ Adapter  │ │ Adapter   │ │ Adapter  │     │
│  └────┬─────┘ └─────┬─────┘ └────┬─────┘     │
│       └──────────────┼────────────┘           │
│               ┌──────▼──────┐                 │
│               │ GatewayCore │                 │
│               └──────┬──────┘                 │
│               ┌──────▼──────┐                 │
│               │ REST API    │                 │
│               └──────┬──────┘                 │
└──────────────────────┼────────────────────────┘
                       │ HTTP (localhost)
┌──────────────────────┼────────────────────────┐
│  SillyTavern (浏览器)                          │
│  ┌───────────────────▼──────────────────┐     │
│  │  index.js (ST 前端扩展)              │     │
│  │  - 轮询 /api/gateway/status          │     │
│  │  - 注入消息到 ST 聊天                │     │
│  │  - 捕获 AI 回复转发回网关            │     │
│  └──────────────────────────────────────┘     │
│  ┌──────────────────────────────────────┐     │
│  │  SillyTavern AI 后端                 │     │
│  │  (OpenAI / Claude / 本地模型)        │     │
│  └──────────────────────────────────────┘     │
└───────────────────────────────────────────────┘
```

**安装要求**：
- 后端服务可放任意目录（`npm install && npm start`）
- ST 前端扩展必须在 `{ST目录}/public/scripts/extensions/third-party/sillytavern-gateway/`
- 可用目录 Junction（Windows `mklink /J`）避免复制
- 两个组件通过 `localhost:3210` HTTP 通信

---

## 12. 生态演进路线图（暂未执行）

早在 2026-07 进行过 AstrBot 生态对标分析，识别出的能力缺口：

**基础设施层**：独立 WebUI、Docker 部署、进程守护、配置热更新
**能力层**：多 LLM 直连、Agent 工具调用、多模态、知识库 RAG、权限控制
**生态层**：插件市场、更多平台适配器、插件脚手架、i18n

**8 个必须配套插件**：LLM 直连、权限管理、多模态桥接、角色路由、群管理、联网搜索、定时任务、日志统计

详见计划文件：`C:\Users\duhao\AppData\Roaming\QoderCN\SharedClientCache\cache\plans\ST_Multi-Platform_Gateway_bb443621.md`

---

## 13. 快速排查指南

| 问题 | 排查路径 |
|------|---------|
| 扩展面板不显示 | 确认扩展在 `third-party/` 下；检查 `manifest.json` 的 `js`/`css` 路径 |
| 前端无法连接网关 | 检查 `serverUrl` 设置；确认后端 `node server/index.js` 在运行 |
| 消息不转发 | 检查面板模式开关是否在"网关模式"；`autoReplyEnabled` 是否开启 |
| 平台"重连中" | Discord：检查 bot token 是否有效；OneBot：检查 WS 地址和 NapCat 状态 |
| 正则规则消失 | 确认网关已连接（需连接才能保存）；检查 `data/plugins/regex-filter.json` |
| 出站消息未送达 | 查看 `logs/combined.log`；检查队列状态 `/api/gateway/status` 中的 `queue.stats` |
| Git 推送失败 | 先设置代理 `git config --local http.proxy http://127.0.0.1:10808` |
