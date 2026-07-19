# SillyTavern Multi-Platform Gateway

一个为 SillyTavern 设计的多平台聊天网关插件，通过统一网关架构连接 QQ（OneBot v11）、Telegram、Discord 三大平台，实现跨平台消息收发与 AI 角色互动。

## 功能特性

- **多平台统一接入**：通过适配器模式支持 QQ、Telegram、Discord，新增平台只需实现 `PlatformAdapter` 接口
- **QQ OneBot v11 支持**：兼容 NapCat、Lagrange.OneBot 等主流实现，支持正向/反向 WebSocket
- **稳定连接保障**：指数退避重连、心跳检测、消息去重，解决原 sillytavern-qq-gateway 连接不稳定的问题
- **统一消息模型**：所有平台消息标准化为 `InboundMessage` / `OutboundMessage`，屏蔽平台差异
- **消息队列**：失败自动重试，确保消息可靠投递
- **会话管理**：跨平台会话隔离、对话历史缓存、可选持久化
- **长文本自动分段**：根据各平台字符限制自动切割（QQ 4500 / Telegram 4096 / Discord 2000）
- **REST API**：完整的 HTTP API 供外部集成
- **SillyTavern 扩展**：提供设置面板、状态监控、消息控制台、斜杠命令

## 架构设计

```
SillyTavern 前端 (Extension UI)
        │
   ST Extension API (getContext / SlashCommand)
        │
  Gateway Core (消息总线 + 路由 + 会话管理)
        │
  ┌─────┼─────────────┐
  │     │             │
QQ适配器  Telegram适配器  Discord适配器
(OneBot)  (Bot API)    (Discord.js)
  │     │             │
NapCat   Telegram     Discord
```

### 核心设计原则

| 原则 | 说明 |
|------|------|
| 统一消息模型 | 所有平台消息转换为标准格式，上层逻辑无需关心平台细节 |
| 适配器可插拔 | 新增平台只需继承 `PlatformAdapter` 基类并实现 `connect/disconnect/send` |
| 连接自治 | 每个适配器独立管理 WebSocket/长连接、心跳、重连 |
| 消息可靠投递 | 消息队列 + 重试机制，确保不丢消息 |

## 项目结构

```
sillytavern-gateway/
├── manifest.json              # SillyTavern 扩展元数据
├── index.js                   # ST 扩展前端逻辑
├── style.css                  # 扩展样式
├── settings.html              # 设置面板模板
├── window.html                # 控制台窗口模板
├── package.json               # 依赖配置
├── server/                    # 后端网关服务
│   ├── index.js               # 服务入口 + REST API
│   ├── gateway-core.js        # 消息总线 + 路由引擎
│   ├── session-manager.js     # 跨平台会话管理
│   ├── message-queue.js       # 消息队列（可靠投递）
│   ├── adapters/
│   │   ├── base-adapter.js    # 适配器基类（接口定义）
│   │   ├── onebot-adapter.js  # QQ OneBot v11 适配器
│   │   ├── telegram-adapter.js# Telegram Bot API 适配器
│   │   └── discord-adapter.js # Discord.js 适配器
│   ├── protocols/
│   │   └── onebot-v11.js      # OneBot v11 协议解析/封装
│   └── utils/
│       ├── logger.js          # 日志系统 (Winston)
│       ├── config.js          # 配置管理
│       └── reconnect.js       # 指数退避重连策略
├── config/                    # 配置文件目录（自动生成）
│   └── gateway.json           # 网关配置
├── data/                      # 数据目录（自动生成）
│   └── sessions.json          # 会话持久化
└── logs/                      # 日志目录（自动生成）
```

## 快速开始

### 环境要求

- Node.js >= 18
- SillyTavern >= 1.10.0（如需使用 ST 扩展功能）

### 安装

```bash
# 克隆项目
git clone https://github.com/JOJO666888888/sillytavern-gateway.git
cd sillytavern-gateway

# 安装依赖
npm install
```

### 启动网关服务

```bash
npm start
```

服务默认运行在 `http://127.0.0.1:3210`。

首次启动会自动生成默认配置文件 `config/gateway.json`。

## 平台配置

### QQ（OneBot v11）

#### 前置条件

1. 部署 [NapCat](https://github.com/NapNeko/NapCatQQ) 或 [Lagrange.OneBot](https://github.com/LagrangeDev/Lagrange.Core)
2. 在 NapCat WebUI 中启用 **正向 WebSocket**，默认地址 `ws://127.0.0.1:8080`

#### 配置

编辑 `config/gateway.json`：

```json
{
  "adapters": {
    "qq": {
      "enabled": true,
      "mode": "websocket",
      "wsUrl": "ws://127.0.0.1:8080",
      "accessToken": "",
      "heartbeatInterval": 30000,
      "reconnectInterval": 5000,
      "maxReconnectInterval": 60000,
      "messageDedupWindow": 30000
    }
  }
}
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mode` | `websocket`（正向）或 `reverse`（反向） | `websocket` |
| `wsUrl` | 正向模式下 NapCat 的 WS 地址 | `ws://127.0.0.1:8080` |
| `reversePort` | 反向模式下本插件监听端口 | `8081` |
| `accessToken` | OneBot Access Token（可选） | 空 |
| `heartbeatInterval` | 心跳间隔 (ms) | `30000` |
| `messageDedupWindow` | 消息去重窗口 (ms) | `30000` |

### Telegram

#### 前置条件

1. 在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 创建机器人，获取 Bot Token

#### 配置

```json
{
  "adapters": {
    "telegram": {
      "enabled": true,
      "botToken": "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz",
      "mode": "polling",
      "allowedUsers": [],
      "requireMention": true
    }
  }
}
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mode` | `polling`（无需公网IP）或 `webhook` | `polling` |
| `allowedUsers` | 白名单用户 ID，空=允许所有 | `[]` |
| `requireMention` | 群组中是否需要 @bot 才响应 | `true` |

### Discord

#### 前置条件

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications)
2. 创建 Application → Bot → 复制 Token
3. 开启 **Message Content Intent**
4. 使用 OAuth2 URL 邀请 Bot 到你的服务器

#### 配置

```json
{
  "adapters": {
    "discord": {
      "enabled": true,
      "botToken": "你的Discord Bot Token",
      "allowedChannels": [],
      "allowedUsers": [],
      "requireMention": true
    }
  }
}
```

## REST API

网关服务提供以下 HTTP API：

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/gateway/health` | 健康检查 |
| GET | `/api/gateway/status` | 获取所有适配器状态 |
| GET | `/api/gateway/config` | 获取当前配置 |
| POST | `/api/gateway/config` | 更新配置 |
| POST | `/api/gateway/send` | 发送消息 |
| GET | `/api/gateway/sessions` | 获取会话列表 |
| GET | `/api/gateway/sessions/:platform/:chatId/history` | 获取会话历史 |
| DELETE | `/api/gateway/sessions/:platform/:chatId/history` | 清空会话历史 |
| POST | `/api/gateway/adapters/:name/start` | 启动指定适配器 |
| POST | `/api/gateway/adapters/:name/stop` | 停止指定适配器 |

### 发送消息示例

```bash
curl -X POST http://127.0.0.1:3210/api/gateway/send \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "qq",
    "chatId": "123456789",
    "chatType": "group",
    "content": "Hello from SillyTavern!"
  }'
```

## SillyTavern 扩展安装

1. 将整个 `sillytavern-gateway` 文件夹复制到 SillyTavern 的扩展目录：
   ```
   SillyTavern/public/scripts/extensions/gateway/
   ```

2. 重启 SillyTavern

3. 在扩展菜单中找到 **"多平台网关"**

4. 在设置面板中配置网关服务地址（默认 `http://127.0.0.1:3210`）

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/gateway status` | 查看各平台连接状态 |
| `/gateway send <platform> <chatId> <message>` | 发送消息到指定平台 |
| `/gateway open` | 打开网关控制台窗口 |

## 解决 QQ 连接问题

本项目针对原 `sillytavern-qq-gateway` 的连接失败问题做了以下改进：

| 问题 | 解决方案 |
|------|----------|
| WebSocket 连接不稳定 | 指数退避重连（1s → 60s）+ 随机抖动避免惊群 |
| 心跳丢失导致断连 | 可配置心跳间隔（默认 30s），自动 ping 检测 |
| OneBot 协议版本不匹配 | 严格实现 v11 标准，兼容 NapCat/Lagrange |
| 鉴权失败 | 支持 Access Token Header 验证 |
| 消息重复 | 基于 message_id 的滑动窗口去重（默认 30s） |
| 消息丢失 | 消息队列 + 自动重试（最多 3 次） |

### 常见问题排查

**Q: 连接 NapCat 时报 "连接超时"**
- 确认 NapCat 已启动且 WebSocket 服务端已开启
- 检查 `wsUrl` 地址和端口是否正确
- 确认防火墙未阻止本地连接

**Q: 连接成功但收不到消息**
- 确认 NapCat 中已登录 QQ 账号
- 检查是否配置了 Access Token 但未在网关中填写
- 查看 `logs/combined.log` 中的详细日志

**Q: 频繁断线重连**
- 检查 NapCat 进程是否稳定运行
- 适当增大 `heartbeatInterval`（如 45000）
- 检查网络环境是否有 WebSocket 干扰

## 开发指南

### 添加新平台适配器

1. 在 `server/adapters/` 下创建新文件，如 `wechat-adapter.js`
2. 继承 `PlatformAdapter` 基类：

```javascript
import { PlatformAdapter, ConnectionState, InboundMessage, OutboundMessage } from './base-adapter.js';

export class WeChatAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('wechat', config);
    }

    async connect() {
        this.setState(ConnectionState.CONNECTING);
        // 实现连接逻辑...
        this.setState(ConnectionState.CONNECTED);
    }

    async disconnect() {
        // 实现断开逻辑...
        this.setState(ConnectionState.DISCONNECTED);
    }

    async send(message) {
        // 实现发送逻辑...
        return true;
    }
}
```

3. 在 `server/index.js` 中注册适配器
4. 在 `config/gateway.json` 中添加对应配置

### 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js 18+ (ESM) |
| HTTP 服务 | Express |
| WebSocket | ws |
| QQ 协议 | OneBot v11 |
| Telegram | node-telegram-bot-api |
| Discord | discord.js v14 |
| 日志 | Winston |
| 事件总线 | EventEmitter3 |

## 致谢

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) - 适配器架构与消息总线设计参考
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) - 多平台网关与会话管理参考
- [NapCat](https://github.com/NapNeko/NapCatQQ) - QQ OneBot v11 实现
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) - LLM 前端

## License

MIT
