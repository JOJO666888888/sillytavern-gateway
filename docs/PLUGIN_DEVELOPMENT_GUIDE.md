# SillyTavern Gateway 插件开发规范指南

> 本指南面向希望为 SillyTavern Multi-Platform Gateway 编写插件的开发者（含 AI 辅助编程）。
> 按照本指南，你可以从零开发一个可运行、可分发、带前端配置界面的插件。
>
> 适用版本：Gateway 插件系统 v1.x（`GatewayPlugin` SDK）

---

## 目录

1. [概述](#1-概述)
2. [快速开始：5 分钟写出第一个插件](#2-快速开始5-分钟写出第一个插件)
3. [插件目录结构](#3-插件目录结构)
4. [plugin.json 完整参考](#4-pluginjson-完整参考)
5. [GatewayPlugin 基类 API](#5-gatewayplugin-基类-api)
6. [命令（Commands）](#6-命令commands)
7. [事件监听器（Listeners）](#7-事件监听器listeners)
8. [出站消息过滤器（Outbound Filters）](#8-出站消息过滤器outbound-filters)
9. [PluginContext（ctx）上下文 API](#9-plugincontextctx上下文-api)
10. [配置系统与持久化](#10-配置系统与持久化)
11. [前端配置界面规范（抽屉式标准格式）](#11-前端配置界面规范抽屉式标准格式)
12. [安装、分发与插件市场](#12-安装分发与插件市场)
13. [完整实战示例：定时问候插件](#13-完整实战示例定时问候插件)
14. [最佳实践与常见陷阱](#14-最佳实践与常见陷阱)
15. [附录：API 速查表](#15-附录api-速查表)

---

## 1. 概述

### 1.1 什么是网关插件

网关插件是运行在 **Gateway 服务端**（Node.js）的可插拔模块，用于扩展网关的消息处理能力。一个插件可以做以下任意组合的事情：

| 能力 | 说明 | 典型场景 |
|------|------|----------|
| **命令** | 响应 `/xxx` 格式的聊天命令 | `/roll 2d6` 掷骰、`/help` 帮助 |
| **事件监听** | 监听各平台入站消息并处理 | 关键词自动回复、消息审计 |
| **出站过滤** | 加工/清洗 AI 回复后再发到平台 | 正则提取正文、移除元数据标签 |
| **定时任务** | 按 cron 表达式周期执行 | 每日早报、定时提醒 |

### 1.2 核心架构

```
平台消息 (QQ/Telegram/Discord)
        │
  Gateway Core (消息总线)
        │
        ├─→ CommandRouter   ──→ 匹配 /command ──→ 插件命令处理器
        │
        ├─→ EventPipeline   ──→ 按 priority 分发 ──→ 插件监听器
        │
        └─→ OutboundFilter  ──→ AI 回复出站时 ──→ 插件过滤器链
```

- **命令** 优先于监听器：消息以 `/` 开头且命中已注册命令时，直接交给命令处理器，不再进入事件管线。
- **监听器** 按 `priority` 升序执行（数字越小越先），任一插件可调用 `ctx.stopPropagation()` 中断后续分发。
- **出站过滤器** 在 AI 回复真正发送到平台前依次执行，可修改内容或丢弃消息。

### 1.3 技术约定

- 运行时：**Node.js 18+，ESM（`import`/`export`）**，插件代码使用 `.js` 扩展名。
- 插件必须 **默认导出** 一个继承自 `GatewayPlugin` 的类。
- 插件通过 **相对路径** 引入 SDK：`import { GatewayPlugin } from '../../server/plugin-sdk.js';`

---

## 2. 快速开始：5 分钟写出第一个插件

### 第 1 步：创建插件目录

在网关根目录的 `plugins/` 下新建文件夹（文件夹名建议与插件 `name` 一致）：

```
plugins/
└── my-hello/
    ├── plugin.json
    └── index.js
```

### 第 2 步：编写 plugin.json

```json
{
    "name": "my-hello",
    "displayName": "我的问候插件",
    "version": "1.0.0",
    "author": "你的名字",
    "description": "一个演示用的问候插件",
    "main": "index.js",
    "priority": 100,
    "enabled": true,
    "dependencies": [],
    "permissions": [],
    "config": {
        "greeting": { "type": "string", "default": "你好", "description": "自定义问候语" }
    }
}
```

### 第 3 步：编写 index.js

```javascript
import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class MyHelloPlugin extends GatewayPlugin {
    // 声明命令：/hello [名字]
    static commands = [
        {
            name: 'hello',
            alias: ['你好', '嗨'],
            handler: 'handleHello',          // 处理方法名（字符串）
            description: '打个招呼',
            usage: '/hello [名字]',
        },
    ];

    async onLoad() {
        this.logger.info('我的问候插件已加载！');
    }

    async onUnload() {
        this.logger.info('我的问候插件已卸载');
    }

    // 命令处理器，接收 ctx 上下文
    async handleHello(ctx) {
        const name = ctx.args[0] || ctx.senderName || '世界';
        const greeting = this.getConfig('greeting') || '你好';
        return ctx.reply(`${greeting}, ${name}! 👋`);
    }
}
```

### 第 4 步：启动网关验证

```bash
npm start
```

在任意已连接平台发送 `/hello 小明`，机器人回复 `你好, 小明! 👋` 即成功。
发送 `/help` 可看到你的命令已出现在列表中。

> 仓库内 `plugins/example-hello/`、`plugins/example-dice/` 是两个可直接参考的官方示例。

---

## 3. 插件目录结构

```
plugins/<插件名>/
├── plugin.json        # 【必需】插件元数据与配置 schema
├── index.js           # 【必需】插件入口（默认导出 GatewayPlugin 子类）
├── lib/               # 【可选】拆分的业务逻辑模块
│   └── utils.js
└── README.md          # 【可选】插件说明（分发时建议提供）
```

**加载规则**（由 `plugin-loader.js` 实现）：

1. 扫描 `plugins/` 下的每个 **子目录**。
2. 目录必须包含 `plugin.json`，否则跳过。
3. `plugin.json` 必须有 `name` 字段，否则跳过并告警。
4. 动态 `import` `main` 指定的入口文件（默认 `index.js`），取 **默认导出**。
5. 校验默认导出必须继承 `GatewayPlugin`，否则拒绝加载。
6. 实例化并注入 `pluginConfig` 与 `services`，调用 `onLoad()`。

> ⚠️ 入口文件 **必须有默认导出**（`export default class ...`）。只导出命名导出会导致加载失败。

---

## 4. plugin.json 完整参考

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `name` | string | ✅ | - | 插件唯一标识（小写短横线命名，如 `regex-filter`）。决定配置文件名 `data/plugins/<name>.json` |
| `displayName` | string | - | name | 展示名称（支持中文） |
| `version` | string | - | `0.0.0` | 语义化版本号 |
| `author` | string | - | `unknown` | 作者 |
| `description` | string | - | - | 一句话描述，显示在插件列表 |
| `main` | string | - | `index.js` | 入口文件名 |
| `priority` | number | - | `100` | 监听器默认优先级（数字越小越先执行） |
| `enabled` | boolean | - | `true` | 初始是否启用（用户可在面板中开关） |
| `dependencies` | string[] | - | `[]` | 依赖的其他插件 name（预留字段） |
| `permissions` | string[] | - | `[]` | 声明所需权限（如 `["config"]`，预留字段） |
| `config` | object | - | `{}` | 配置项 schema，见下 |

### 4.1 config 配置 schema

`config` 中每个键描述一个配置项，供文档、默认值生成与前端渲染使用：

```json
"config": {
    "greeting": {
        "type": "string",
        "default": "你好",
        "description": "自定义问候语"
    },
    "maxRetry": {
        "type": "number",
        "default": 3,
        "description": "最大重试次数"
    },
    "enableLog": {
        "type": "boolean",
        "default": true,
        "description": "是否记录日志"
    },
    "rules": {
        "type": "array",
        "default": [],
        "description": "规则列表"
    }
}
```

支持的 `type`：`string` / `number` / `boolean` / `array` / `object`。

> 📌 `config` 只是 **声明**，实际运行时配置存储在 `data/plugins/<name>.json`。
> 首次加载时若没有持久化配置，`getConfig()` 返回空对象——**请在 `onLoad()` 中用 `setConfig()` 初始化默认值**（参考 [10.3](#103-默认值初始化模式)）。

---

## 5. GatewayPlugin 基类 API

所有插件必须继承 `GatewayPlugin`（来自 `server/plugin-sdk.js`）。

### 5.1 静态注册表

通过 **静态属性** 声明命令、监听器、定时任务。`handler` 填 **方法名字符串**，框架会在实例上查找同名方法调用。

```javascript
export default class MyPlugin extends GatewayPlugin {
    static commands = [
        { name: 'roll', alias: ['r', '骰'], handler: 'handleRoll', description: '掷骰子', usage: '/roll [NdM]' },
    ];

    static listeners = [
        { event: 'message', filter: { platform: 'qq' }, handler: 'onQQMessage', priority: 50 },
    ];

    static schedules = [
        { cron: '0 9 * * *', handler: 'dailyReport', description: '每日 9 点报告' },
    ];
}
```

### 5.2 生命周期钩子

| 钩子 | 时机 | 典型用途 |
|------|------|----------|
| `async onLoad()` | 插件加载时 | 注册出站过滤器、初始化默认配置、建立外部连接 |
| `async onUnload()` | 插件卸载/重载前 | 清理定时器、注销过滤器、释放资源 |

```javascript
async onLoad() {
    this._ensureDefaults();
    this.logger.info('插件已加载');
}

async onUnload() {
    if (this._timer) clearInterval(this._timer);
    this.logger.info('插件已卸载');
}
```

### 5.3 实例属性与方法

| 成员 | 说明 |
|------|------|
| `this.meta` | 插件元数据（`name`/`displayName`/`version` 等，由 plugin.json 注入） |
| `this.logger` | 日志器，用法 `this.logger.info/warn/error/debug(...)`，自动带 `plugin:<name>` 前缀 |
| `this._services` | 网关服务引用（`gateway`/`sessionManager`/`configManager`），高级用法 |
| `this.getConfig(key?)` | 读取插件私有配置；不传 key 返回全部配置的副本 |
| `this.setConfig(key, value)` | 写入配置并 **自动持久化** 到 `data/plugins/<name>.json` |
| `this.enabled` | 是否已启用（只读） |

---

## 6. 命令（Commands）

### 6.1 命令格式

用户在平台发送 `/命令名 参数1 参数2 ...` 触发。框架自动：

- 按空格切分参数，存入 `ctx.args`（数组，不含命令名本身）。
- 命令名与别名 **不区分大小写**。
- 命中命令后 **不会** 再进入事件管线。
- 未知 `/xxx` 命令不拦截，消息继续流转（可被监听器处理）。

### 6.2 内置命令

系统预置了以下命令，你的插件命令名 **不要与之冲突**：

| 命令 | 别名 | 说明 |
|------|------|------|
| `/help [命令名]` | `/帮助` | 列出所有命令 / 查看单个命令详情 |
| `/status` | `/状态` | 查看网关各平台连接状态 |
| `/clear` | `/清空` | 清空当前会话历史 |

### 6.3 命令处理器

```javascript
async handleRoll(ctx) {
    const input = ctx.args[0] || '';        // 第一个参数
    const reason = ctx.args.slice(1).join(' '); // 其余参数拼成原因

    if (!input) {
        return ctx.reply('用法: /roll [NdM] [原因]');  // 参数校验
    }
    // ... 业务逻辑
    return ctx.reply(`🎲 结果: ...`);
}
```

> 💡 命令执行出错时，框架会自动捕获异常并回复 `命令执行出错: <错误信息>`，但仍建议在处理器内做参数校验，给出友好提示。

### 6.4 子命令模式（推荐复杂命令使用）

参考 `regex-filter` 的 `/regex <list|add|remove|...>`：

```javascript
async handleRegex(ctx) {
    const sub = (ctx.args[0] || 'list').toLowerCase();
    switch (sub) {
        case 'list':  return this._cmdList(ctx);
        case 'add':   return this._cmdAdd(ctx);
        case 'help':
        default:      return this._cmdHelp(ctx);
    }
}
```

---

## 7. 事件监听器（Listeners）

### 7.1 注册

```javascript
static listeners = [
    {
        event: 'message',              // 事件类型，'message' 或 '*'（全部）
        filter: { platform: 'qq' },    // 过滤条件，空对象 = 监听所有
        handler: 'onMessage',          // 处理方法名
        priority: 100,                 // 优先级，越小越先执行
    },
];
```

### 7.2 过滤条件（filter）

`filter` 的键对应入站消息字段，支持：

| 写法 | 含义 |
|------|------|
| `{}` | 匹配所有消息 |
| `{ platform: 'qq' }` | 仅 QQ 平台 |
| `{ platform: ['qq', 'telegram'] }` | 数组 = 匹配其一 |
| `{ chatType: 'group' }` | 仅群聊（`private`/`group`） |
| `{ chatId: '123456' }` | 仅指定会话 |
| `{ senderId: 'abc' }` | 仅指定发送者 |
| `{ platform: '*' }` | `*` 或 `null`/`undefined` 表示该字段不限 |

可用过滤字段：`platform`、`chatType`、`chatId`、`senderId` 等（对应 `InboundMessage` 属性）。

### 7.3 优先级与传播控制

- 多个监听器按 `priority` **升序** 执行（默认 100，也可在 plugin.json 用 `priority` 提供默认值）。
- 处理器中调用 `ctx.reply()` 会标记消息为「已处理」，但 **不阻止** 后续监听器。
- 调用 `ctx.stopPropagation()` 会 **立即中断** 管线，后续监听器不再执行。

```javascript
async onMessage(ctx) {
    if (!ctx.content.includes('关键词')) return;   // 不感兴趣，直接返回
    await ctx.reply('检测到关键词！');
    ctx.stopPropagation();                          // 阻止其他插件继续处理
}
```

> ⚠️ 仅做日志/统计的监听器 **不要** 调用 `reply` 或 `stopPropagation`，让消息继续流转（参考 `example-hello` 的 `onAnyMessage`，并把 priority 设大一些如 200）。

---

## 8. 出站消息过滤器（Outbound Filters）

用于加工 **AI 回复**（出站消息）后再发送到平台。这是解决「SillyTavern 输出含大量元数据标签」的标准方案。

### 8.1 注册与注销

在 `onLoad()` 中通过 `this._services.gateway.addOutboundFilter()` 注册，**务必在 `onUnload()` 中注销**：

```javascript
constructor(options) {
    super(options);
    this._removeFilter = null;   // 保存注销函数
}

async onLoad() {
    const gateway = this._services.gateway;
    if (gateway && gateway.addOutboundFilter) {
        this._removeFilter = gateway.addOutboundFilter(
            (msg) => this.filterOutbound(msg),
            { name: 'my-filter', priority: 10 }   // priority 越小越先执行
        );
    }
}

async onUnload() {
    if (this._removeFilter) {
        this._removeFilter();       // 调用返回的函数即可注销
        this._removeFilter = null;
    }
}
```

### 8.2 过滤器函数约定

```javascript
/**
 * @param {OutboundMessage} message - 出站消息（含 platform/chatId/content 等）
 * @returns {OutboundMessage|null} 修改后的消息；返回 null 表示丢弃该消息
 */
filterOutbound(message) {
    if (!message || !message.content) return message;

    // 例：移除 <think>...</think> 思考过程
    message.content = message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // 内容为空时可选择丢弃
    if (!message.content) return null;

    return message;
}
```

- 返回 **修改后的消息对象**（直接改 `message.content` 即可）。
- 返回 **`null`** 表示丢弃这条消息（不发送）。
- 过滤器抛异常会被框架捕获并记录日志，**不会中断** 消息发送（原样发出）。
- 多个过滤器按 `priority` 升序串成链，前一个的输出是后一个的输入。

> 📖 完整实现参考内置插件 `plugins/regex-filter/index.js`（提取规则 + 移除规则 + fallback + 平台白名单）。

---

## 9. PluginContext（ctx）上下文 API

命令处理器和监听器都会收到一个 `ctx` 对象，封装了消息信息与操作方法。

### 9.1 消息信息字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `ctx.platform` | string | 来源平台（`qq`/`telegram`/`discord`） |
| `ctx.chatId` | string | 会话 ID |
| `ctx.chatType` | string | `private`（私聊）/ `group`（群聊） |
| `ctx.senderId` | string | 发送者 ID |
| `ctx.senderName` | string | 发送者昵称 |
| `ctx.content` | string | 消息文本内容 |
| `ctx.messageId` | string | 消息 ID |
| `ctx.args` | string[] | 命令参数数组（仅命令处理器有值） |
| `ctx.commandName` | string | 触发的命令名（仅命令处理器有值） |
| `ctx.message` | object | 原始 `InboundMessage` 对象 |

### 9.2 回复与发送

```javascript
// 回复到当前会话（默认引用回复当前消息）
await ctx.reply('你好！');
await ctx.reply('带媒体', { mediaUrls: ['https://.../img.jpg'] });

// 私聊回复指定用户
await ctx.replyPrivate('用户ID', '悄悄话');

// 发送到任意平台/会话
await ctx.send('telegram', '会话ID', '跨平台消息', { chatType: 'group' });
```

### 9.3 会话与配置

```javascript
ctx.getHistory(10);        // 获取当前会话最近 10 条历史（0=全部）
ctx.clearHistory();        // 清空当前会话历史

ctx.getConfig('adapters.qq.enabled');  // 读取网关全局配置（路径式）
ctx.getAdapters();                     // 获取所有适配器状态
ctx.getSessions();                     // 获取所有会话列表
```

### 9.4 控制流

```javascript
ctx.stopPropagation();   // 阻止消息继续传递给后续插件（并标记已处理）
ctx.handled;             // 消息是否已被处理（只读）
```

---

## 10. 配置系统与持久化

### 10.1 存储位置

每个插件的运行时配置独立存储在：

```
data/plugins/<插件name>.json
```

例如 `regex-filter` 的配置在 `data/plugins/regex-filter.json`。

### 10.2 读写与自动持久化

```javascript
// 读取
const patterns = this.getConfig('extractPatterns') || [];
const all = this.getConfig();              // 全部配置副本

// 写入（自动写盘，无需手动保存）
this.setConfig('fallbackToOriginal', true);
this.setConfig('extractPatterns', [...]);
```

`setConfig()` 会 **立即持久化** 到磁盘，插件重载后配置不丢失。

### 10.3 默认值初始化模式

首次加载时没有持久化配置，**必须** 在 `onLoad()` 中初始化默认值（这是项目标准做法）：

```javascript
async onLoad() {
    this._ensureDefaults();
    // ...
}

_ensureDefaults() {
    if (!this.getConfig('rules')) {
        this.setConfig('rules', [
            { name: 'default', enabled: true, pattern: '...' },
        ]);
    }
    if (this.getConfig('trimWhitespace') === undefined) {
        this.setConfig('trimWhitespace', true);
    }
}
```

> ⚠️ 对 `boolean` 配置用 `=== undefined` 判断，避免把用户显式设置的 `false` 误判为「未设置」而覆盖。

### 10.4 配置 REST API

网关为每个插件自动暴露配置接口（前端配置界面即基于此）：

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/plugins/:name/config` | 读取插件配置，返回 `{ success, config }` |
| POST | `/api/plugins/:name/config` | 更新配置（请求体为完整配置 JSON），并同步到运行中的插件实例 |

其他管理接口：

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/plugins` | 列出所有插件 |
| GET | `/api/plugins/:name` | 插件详情（含 meta/commands/listeners/config） |
| POST | `/api/plugins/:name/enable` | 启用 |
| POST | `/api/plugins/:name/disable` | 禁用 |
| POST | `/api/plugins/:name/reload` | 重载（改代码后无需重启网关） |
| DELETE | `/api/plugins/:name` | 卸载 |
| POST | `/api/plugins/install/github` | 从 GitHub 安装 |

---

## 11. 前端配置界面规范（抽屉式标准格式）

> **本项目约定：所有带前端配置的插件，其配置区块一律采用「抽屉式」折叠结构**——
> 默认收起仅显示标题栏，点击标题展开完整配置，再点收起。避免多个插件配置长期占用面板空间。
> 正则过滤器（`regex-filter`）即按此标准实现，新插件请参照执行。

### 11.1 标准 HTML 结构

在 `panel.html` 中为插件添加一个配置区块，**严格使用以下三个 class**：

```html
<!-- <插件名> 设置（抽屉式：点击标题展开/收起） -->
<div class="gateway-section gateway-collapsible" id="gateway_<name>_section">
    <!-- 标题栏：gateway-collapse-toggle + data-toggle 指向内容区 id -->
    <div class="gateway-section-title gateway-collapse-toggle" data-toggle="gateway_<name>_body">
        <!-- 箭头图标：展开时自动旋转 90° -->
        <i class="fa-solid fa-chevron-right gateway-collapse-arrow"></i>
        <i class="fa-solid fa-<图标>"></i> <插件显示名>
        <!-- 标题栏右侧可放刷新等按钮（点击按钮不会触发折叠） -->
        <button id="gateway_<name>_refresh" class="menu_button gateway-refresh-btn" title="刷新">
            <i class="fa-solid fa-rotate"></i>
        </button>
    </div>

    <!-- 内容区：默认 display:none 收起 -->
    <div id="gateway_<name>_body" class="gateway-collapse-body" style="display:none;">
        <!-- 在这里放配置表单、规则列表、保存按钮等 -->
        <button id="gateway_<name>_save" class="menu_button gateway-save-btn">
            <i class="fa-solid fa-floppy-disk"></i> 保存配置
        </button>
    </div>
</div>
```

**三个关键 class（由 `index.js` 的通用处理器统一驱动，无需为每个插件单独写折叠逻辑）：**

| Class | 作用 |
|-------|------|
| `.gateway-collapse-toggle` | 可点击的标题栏，`data-toggle` 属性填内容区的元素 id |
| `.gateway-collapse-arrow` | 箭头图标，展开时自动加 `.expanded` 类旋转 90° |
| `.gateway-collapse-body` | 可折叠的内容区，初始 `style="display:none;"` 表示默认收起 |

### 11.2 通用折叠处理器（已内置，勿重复实现）

`index.js` 的 `bindPanelEvents()` 中已有通用处理器，自动接管所有 `.gateway-collapse-toggle`：

```javascript
$('.gateway-collapse-toggle').on('click', function (e) {
    // 排除标题栏内的按钮/输入框/开关等，避免误触发折叠
    if ($(e.target).closest('button, input, select, textarea, label, a').length) return;
    const targetId = $(this).data('toggle');
    $(`#${targetId}`).stop(true, true).slideToggle(150);
    $(this).find('.gateway-collapse-arrow').toggleClass('expanded');
});
```

> ✅ 你只需按 11.1 的 HTML 结构写区块，折叠交互自动生效。
> ❌ 不要自己再绑定标题栏点击事件，会与通用处理器冲突。

### 11.3 配置加载与保存（前端 ↔ 后端）

参照 `index.js` 中 `loadRegexConfig()` / 正则保存逻辑，模式如下：

```javascript
// 加载：GET /api/plugins/<name>/config，填充到表单
async function loadMyPluginConfig() {
    $('#gateway_myplugin_section').show();   // 区块本身始终可见（仅内容折叠）
    try {
        const data = await apiRequest('/api/plugins/my-plugin/config');
        const config = data.config || {};
        // ... 把 config 填充到各输入框 / 渲染规则列表
    } catch (_) {
        // 网关未连接：显示离线提示，但保留界面可编辑
        $('#gateway_myplugin_offline_hint').show();
    }
}

// 保存：POST /api/plugins/<name>/config，提交完整配置
async function saveMyPluginConfig() {
    const config = { /* 从表单收集 */ };
    await apiRequest('/api/plugins/my-plugin/config', {
        method: 'POST',
        body: JSON.stringify(config),
    });
    toastr.success('配置已保存');
}
```

**离线可用性约定**：配置界面应 **始终可见**（区块不被隐藏），网关未连接时仅显示提示条，允许用户继续编辑/测试，连接后点保存生效。正则过滤器即按此约定实现。

---

## 12. 安装、分发与插件市场

### 12.1 本地安装

把插件目录整个放入 `plugins/`，重启网关（或调用 `/api/plugins/:name/reload`）：

```
plugins/
└── my-plugin/
    ├── plugin.json
    └── index.js
```

### 12.2 从 GitHub 安装

在面板「插件管理」→「从 GitHub 安装插件」填入仓库地址，或调用 API：

```bash
curl -X POST http://127.0.0.1:3210/api/plugins/install/github \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://github.com/user/my-plugin" }'
```

支持的地址格式：

- `https://github.com/user/repo`（整个仓库作为一个插件）
- `https://github.com/user/repo/tree/main/subfolder`（仓库子目录作为插件）
- `user/repo`（简写）

安装器会自动下载 ZIP、解压、定位 `plugin.json`（最多向下找 2 层）、复制到 `plugins/` 并加载。

### 12.3 发布到插件市场（推荐）

将你的插件仓库打上 GitHub topic **`sillytavern-gateway-plugin`**，即可被面板的「搜索社区插件」检索到：

```bash
# 在 GitHub 仓库 Settings → Topics 添加
sillytavern-gateway-plugin
```

搜索接口：`GET /api/plugins/marketplace/search?q=<关键词>`。

### 12.4 分发清单

发布前请确认：

- [ ] `plugin.json` 的 `name` 全局唯一，`displayName`/`description` 填写完整
- [ ] 入口文件有 **默认导出** 且继承 `GatewayPlugin`
- [ ] `onUnload()` 正确清理资源（过滤器、定时器、连接）
- [ ] 配置默认值在 `onLoad()` 中初始化
- [ ] 附带 README 说明命令用法与配置项
- [ ] 前端配置区块（如有）遵循 [抽屉式标准格式](#11-前端配置界面规范抽屉式标准格式)

---

## 13. 完整实战示例：定时问候插件

综合演示 **命令 + 监听器 + 配置 + 出站过滤器** 的完整插件。

### plugin.json

```json
{
    "name": "greeter",
    "displayName": "智能问候",
    "version": "1.0.0",
    "author": "demo",
    "description": "新人入群欢迎 + /greet 命令 + 出站内容加小尾巴",
    "main": "index.js",
    "priority": 100,
    "enabled": true,
    "permissions": ["config"],
    "config": {
        "welcomeText": { "type": "string", "default": "欢迎新朋友！", "description": "入群欢迎语" },
        "suffix": { "type": "string", "default": "", "description": "出站消息后缀（为空则不添加）" }
    }
}
```

### index.js

```javascript
import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class GreeterPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'greet',
            alias: ['问候'],
            handler: 'handleGreet',
            description: '向某人打招呼',
            usage: '/greet <名字>',
        },
    ];

    static listeners = [
        {
            event: 'notice',                    // 监听通知事件（如入群）
            filter: {},
            handler: 'onNotice',
            priority: 100,
        },
    ];

    constructor(options) {
        super(options);
        this._removeFilter = null;
    }

    async onLoad() {
        this._ensureDefaults();

        // 注册出站过滤器：给出站消息加后缀
        const gateway = this._services.gateway;
        if (gateway?.addOutboundFilter) {
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.appendSuffix(msg),
                { name: 'greeter-suffix', priority: 90 }   // 在正则过滤(10)之后执行
            );
        }
        this.logger.info('智能问候插件已加载');
    }

    async onUnload() {
        if (this._removeFilter) {
            this._removeFilter();
            this._removeFilter = null;
        }
        this.logger.info('智能问候插件已卸载');
    }

    _ensureDefaults() {
        if (this.getConfig('welcomeText') === undefined) {
            this.setConfig('welcomeText', '欢迎新朋友！');
        }
        if (this.getConfig('suffix') === undefined) {
            this.setConfig('suffix', '');
        }
    }

    // /greet <名字>
    async handleGreet(ctx) {
        const name = ctx.args[0];
        if (!name) return ctx.reply('用法: /greet <名字>');
        return ctx.reply(`${this.getConfig('welcomeText')} @${name}`);
    }

    // 入群欢迎
    async onNotice(ctx) {
        if (ctx.message?.noticeType !== 'group_increase') return;
        await ctx.reply(this.getConfig('welcomeText'));
        // 不调用 stopPropagation，允许其他插件继续处理
    }

    // 出站加后缀
    appendSuffix(message) {
        const suffix = this.getConfig('suffix');
        if (suffix && message?.content) {
            message.content = `${message.content}\n${suffix}`;
        }
        return message;
    }
}
```

---

## 14. 最佳实践与常见陷阱

### ✅ 最佳实践

1. **命令名加前缀防冲突**：如 `/greet` 太通用，可用 `/myplugin-greet` 或在子命令下组织。
2. **监听器只做必要的事**：日志型监听器把 `priority` 设大（如 200），不 `reply`、不 `stopPropagation`。
3. **出站过滤器务必可逆注销**：保存 `addOutboundFilter` 返回的函数，在 `onUnload()` 调用。
4. **配置读写用 `getConfig`/`setConfig`**：不要直接碰 `this._pluginConfig`，否则不会持久化。
5. **正则等用户输入先校验**：`new RegExp(pattern)` 包在 try/catch 中，给出友好错误。
6. **用 `this.logger` 记录关键路径**：便于在 `logs/` 中排查问题。
7. **前端配置遵循抽屉式标准**：见 [第 11 节](#11-前端配置界面规范抽屉式标准格式)。

### ❌ 常见陷阱

| 陷阱 | 后果 | 正确做法 |
|------|------|----------|
| 只写命名导出，没有 `export default` | 插件加载失败 | 必须默认导出类 |
| 类没有 `extends GatewayPlugin` | 校验不通过被拒绝加载 | 继承基类 |
| `handler` 填了不存在的方法名 | 命令/监听触发时告警无响应 | 方法名与类中方法严格一致 |
| 在 `onLoad` 之外注册过滤器且不注销 | 重载后过滤器叠加执行多次 | 保存注销函数，`onUnload` 调用 |
| 用 `if (!this.getConfig('flag'))` 判断 boolean | 用户设的 `false` 被当未设置覆盖 | 用 `=== undefined` 判断 |
| 命令处理器里 `throw` 未捕获的错误 | 用户收到生硬报错 | 参数校验前置，返回友好提示 |
| 监听器对每条消息都 `reply` | 刷屏 / 死循环 | 严格条件判断 + 必要时 `stopPropagation` |
| 前端自己绑定标题栏点击做折叠 | 与通用处理器冲突导致双重切换 | 只用标准 class，复用通用处理器 |

---

## 15. 附录：API 速查表

### 15.1 插件类（继承 GatewayPlugin）

```text
static commands  = [{ name, alias[], handler, description, usage }]
static listeners = [{ event, filter{}, handler, priority }]
static schedules = [{ cron, handler, description }]

async onLoad()                    // 加载钩子
async onUnload()                  // 卸载钩子
this.meta                         // 元数据 {name, displayName, version, ...}
this.logger.info/warn/error/debug // 日志
this.getConfig(key?)              // 读配置
this.setConfig(key, value)        // 写配置（自动持久化）
this._services.gateway            // 网关核心（addOutboundFilter 等）
```

### 15.2 上下文 ctx

```text
// 信息
ctx.platform / ctx.chatId / ctx.chatType / ctx.senderId
ctx.senderName / ctx.content / ctx.messageId / ctx.message
ctx.args[] / ctx.commandName      // 命令专用

// 动作
await ctx.reply(text, {replyToId?, mediaUrls?})
await ctx.replyPrivate(userId, text)
await ctx.send(platform, chatId, text, {chatType?})
ctx.getHistory(limit?) / ctx.clearHistory()
ctx.getConfig('path.to.key')      // 网关全局配置
ctx.getAdapters() / ctx.getSessions()
ctx.stopPropagation()             // 中断管线
```

### 15.3 出站过滤器

```text
const off = gateway.addOutboundFilter(fn, {name, priority})
// fn(message) => message | null   (null = 丢弃)
off()                              // 注销
```

### 15.4 REST API

```text
GET    /api/plugins                       列出插件
GET    /api/plugins/:name                 插件详情
POST   /api/plugins/:name/enable          启用
POST   /api/plugins/:name/disable         禁用
POST   /api/plugins/:name/reload          重载
DELETE /api/plugins/:name                 卸载
GET    /api/plugins/:name/config          读配置
POST   /api/plugins/:name/config          写配置
POST   /api/plugins/install/github        GitHub 安装
GET    /api/plugins/marketplace/search    市场搜索
```

---

## 参考实现

| 插件 | 路径 | 学习重点 |
|------|------|----------|
| Hello World | `plugins/example-hello/` | 最小命令 + 监听器 + 配置 |
| 掷骰子 | `plugins/example-dice/` | 多命令 + 参数解析 |
| 正则过滤器 | `plugins/regex-filter/` | 出站过滤器 + 子命令 + 前端抽屉式配置界面 |

> 有疑问时，先读 `server/plugin-sdk.js`、`server/plugin-context.js` 的源码注释——那是最权威的 API 定义。
