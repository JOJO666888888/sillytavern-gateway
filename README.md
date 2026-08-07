# SillyTavern Multi-Platform Gateway

一个为 SillyTavern 设计的多平台聊天网关插件，通过统一网关架构连接 QQ（OneBot v11）、Telegram、Discord、飞书、QQ 官方机器人、钉钉等平台，实现跨平台消息收发与 AI 角色互动。

> 新增官方平台（飞书 / QQ 官方 / 钉钉）的接入方式、可行性评估与适配器模板见 [docs/ADDING_PLATFORMS.md](docs/ADDING_PLATFORMS.md)。这些平台的 SDK 为**可选依赖**，未安装不影响网关启动；启用对应平台前按文档执行一次 `npm install`。

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
- **Agent 平台化**：表现层抽象（一套引擎驱动 IM / ST / Native 三界面）+ Workspace/Journal（可审计可回滚）+ 开箱即用初始方案，详见 [Agent 平台化能力](#agent-平台化能力) 与 [docs/AGENT_FRAMEWORK_GUIDE.md](docs/AGENT_FRAMEWORK_GUIDE.md)

## 架构设计

```
SillyTavern 前端 (Extension UI)
        │
   ST Extension API (getContext / SlashCommand)
        │
  Gateway Core (消息总线 + 路由 + 会话管理 + 消息队列)
        │
  ┌─────┬───────┬──────────┬───────┬──────────┬──────────┐
  │     │       │          │       │          │          │
 QQ    TG     Discord    飞书   QQ官方     钉钉     自建推理管线
(OneBot)(Bot API)(discord.js)(Lark SDK)(qq-official)(dingtalk) (NativeRuntime)
  │     │       │          │       │          │
NapCat Telegram Discord   飞书   QQ官方     钉钉
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
├── manifest.json               # SillyTavern 扩展元数据
├── index.js                    # ST 扩展前端逻辑（面板注入/AI 自动回复/角色路由）
├── panel.html                  # 网关管理面板 HTML
├── style.css                   # ST 前端面板样式
├── window.html                 # 独立弹出窗口 HTML
├── package.json                # 依赖配置与 scripts
├── 启动网关.bat                 # Windows 一键启动脚本
├── docker-entrypoint.sh        # Docker 容器入口脚本
├── Dockerfile                  # Docker 镜像构建（node:22-slim）
├── docker-compose.yml          # Docker Compose 编排
├── .env.example                # 环境变量配置模板
│
├── server/                     # 后端网关服务（核心）
│   ├── index.js                # 服务入口 + REST API 路由
│   ├── gateway-core.js         # 消息总线 + 路由引擎
│   ├── session-manager.js      # 跨平台会话管理
│   ├── message-queue.js        # 消息队列（可靠投递 + 重试 + 死信）
│   ├── command-router.js       # 命令路由器（/command 分发）
│   ├── event-pipeline.js       # 事件管线（优先级 + stopPropagation）
│   ├── plugin-manager.js       # 插件生命周期管理 + REST API
│   ├── plugin-sdk.js           # 插件开发 SDK 基类 (GatewayPlugin)
│   ├── llm-service.js          # 插件 LLM 调用服务
│   ├── scheduler-service.js    # 定时任务服务
│   ├── agent-server.js         # Agent 独立服务入口（端口 4321）
│   ├── ai-modifier.js          # AI 修改配置（YAML 热重载）
│   ├── adapters/               # 平台适配器
│   │   ├── base-adapter.js     # 适配器基类
│   │   ├── onebot-adapter.js   # QQ OneBot v11
│   │   ├── telegram-adapter.js # Telegram Bot API
│   │   ├── discord-adapter.js  # Discord.js
│   │   ├── feishu-adapter.js   # 飞书/Lark
│   │   ├── qqofficial-adapter.js # QQ 官方机器人
│   │   └── dingtalk-adapter.js # 钉钉
│   ├── protocols/
│   │   └── onebot-v11.js       # OneBot v11 协议解析/封装
│   ├── agent/                  # Agent 表现层抽象
│   │   ├── pipeline.js         # 多阶段流水线引擎
│   │   ├── surface-manager.js  # 表现层管理器（IM/ST/Native）
│   │   └── theatre-broadcaster.js # SSE 事件广播器
│   ├── runtime/                # 自建推理管线（NativeRuntime）
│   │   ├── pipeline.js         # 管线主逻辑（prompt 组装 -> LLM）
│   │   ├── llm-client.js       # LLM 客户端（OpenAI/Claude/Gemini）
│   │   ├── card-loader.js      # 角色卡加载器（V1/V2/V3）
│   │   ├── worldbook-engine.js # 世界书引擎
│   │   ├── preset-engine.js    # 预设引擎
│   │   └── macro-engine.js     # 宏替换引擎
│   └── utils/
│       ├── config.js           # 配置管理（gateway.json 读写 + 脱敏）
│       ├── env-config.js       # 环境变量映射层
│       ├── logger.js           # 日志系统 (Winston)
│       ├── auth-middleware.js  # CORS + X-Gateway-Token 鉴权
│       └── reconnect.js        # 指数退避重连策略
│
├── plugins/                    # 插件系统（内置 + 第三方）
│   ├── agent-framework/        # Agent 框架核心（YAML 工作流 + 工具 + 记忆）
│   ├── agent-rp/               # Agent RP IM 适配器
│   ├── regex-filter/           # 正则过滤器
│   ├── message-to-image/       # 消息转图片
│   ├── option-splitter/        # 选项拆分（交互按钮）
│   ├── multimodal-bridge/      # 多模态桥接
│   ├── web-search/             # 联网搜索
│   ├── group-manager/          # 群聊管理
│   └── example-*/              # 示例插件
│
├── scripts/                    # 运维脚本
│   ├── gateway-manager.sh      # 全平台一键管理脚本（Linux/macOS/Termux）
│   ├── show-token.js           # 打印鉴权 token
│   ├── validate-st-assets.js   # ST 资产验证
│   └── deploy-to-test.ps1      # PowerShell 部署脚本
│
├── public/                     # Agent 独立前端
│   ├── agent.html              # Agent 剧场页面
│   ├── agent.js                # Agent 前端逻辑
│   └── agent.css               # Agent 前端样式
│
├── docs/                       # 文档目录
├── test/                       # 测试套件（900+ 用例）
├── config/                     # 配置目录（自动生成）
├── data/                       # 数据目录（自动生成）
└── logs/                       # 日志目录（自动生成）
```

## 快速开始

### 方式零：Docker（最省事）

```bash
cp .env.example .env      # 填入 bot token
docker compose up -d
docker compose exec gateway npm run token --silent   # 取鉴权 token
```

网关跑在 `http://127.0.0.1:3210`，在 SillyTavern 网关面板填入地址与上面这个 token 即可。
完整说明（卷/权限/接 NapCat/公网暴露/排障）见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

> 注：Docker 方式跑的是**后端网关服务**。若要用 SillyTavern 里的网关面板，
> 前端扩展仍需放进 ST 的 `third-party` 目录（见下）；
> 若启用[自建推理管线](docs/NATIVE_RUNTIME.md)则连 ST 页面都不用开。

### 环境要求

- Node.js >= 20
- Git
- SillyTavern >= 1.10.0（如需使用 ST 扩展面板功能）

### ⚠️ 重要：先理解本项目的两个组件与安装位置

本项目由两部分组成，**安装位置要求不同**，请务必先看清楚：

| 组件 | 包含内容 | 作用 | 安装位置要求 |
|------|----------|------|--------------|
| **后端网关服务** | `server/` 目录 | 独立 Node.js 程序，负责连接各平台、消息路由 | **可放在任意目录** |
| **前端 ST 扩展** | `manifest.json`、`index.js`、`panel.html`、`style.css` | 在 SillyTavern 中提供顶级设置面板 | **必须在 SillyTavern 扩展目录内** |

> 🔑 **关键点**：SillyTavern **只会**从下面这个目录扫描并加载第三方扩展：
>
> ```
> SillyTavern/public/scripts/extensions/third-party/
> ```
>
> 如果扩展不在这个目录里（或没有链接指向它），SillyTavern 就加载不到，**顶级设置面板不会显示**。这是最常见的安装问题——很多人把项目 clone 到了别的目录，却没有放进 `third-party/`。
>
> 扩展的**目录名必须是 `sillytavern-gateway`**（SillyTavern 以目录名作为扩展标识）。

### 方式一（推荐）：直接克隆到扩展目录，前后端一体

最简单的做法：把整个仓库**直接 clone 进 SillyTavern 的 `third-party` 扩展目录**。这样前端扩展和后端服务在同一处——SillyTavern 能加载面板，你也能在同一目录启动后端服务。

> 下面命令中的 SillyTavern 路径请替换为你的实际安装路径。

**Windows（PowerShell）**：

```powershell
# 1. 进入 SillyTavern 第三方扩展目录
cd "C:\SillyTavern\public\scripts\extensions\third-party"

# 2. 克隆仓库（目录名自动为 sillytavern-gateway）
git clone https://github.com/JOJO666888888/sillytavern-gateway.git

# 3. 进入目录并安装依赖
cd sillytavern-gateway
npm install

# 4. 启动后端网关服务
npm start
```

**Windows（CMD / Git Bash）**：

```bash
cd /d C:\SillyTavern\public\scripts\extensions\third-party
git clone https://github.com/JOJO666888888/sillytavern-gateway.git
cd sillytavern-gateway
npm install
npm start
```

**Linux / macOS**：

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/JOJO666888888/sillytavern-gateway.git
cd sillytavern-gateway
npm install
npm start
```

服务默认监听 `0.0.0.0:3210`（全网卡，便于服务器/远程部署时从浏览器直连；如只在本机使用想限缩到回环，可改 `config/gateway.json` 的 `server.host` 为 `127.0.0.1`）。首次启动会自动生成默认配置文件 `config/gateway.json` 与一个鉴权 token。

> **🔑 token 在哪看？** 首次启动时，控制台会用框线明文打印网关鉴权 Token，直接复制即可；也可在 `config/gateway.json` 的 `server.authToken` 查看，或运行 `npm run token`。网关默认开启鉴权--若想首次连接更省事，可在 SillyTavern 网关面板用「启用网关鉴权」开关关闭（仅限可信网络）。

### 方式二：已克隆到其它目录 → 链接到扩展目录

如果你已经把仓库 clone 到了别处（例如 `D:\myprojects\sillytavern-gateway`），**不必重新 clone**，把它**链接**或**复制**进 `third-party` 目录即可。推荐用链接：以后 `git pull` 更新代码会自动生效，无需重复复制。

**Windows（PowerShell，目录联接 Junction，无需管理员权限）**：

```powershell
New-Item -ItemType Junction -Path "C:\SillyTavern\public\scripts\extensions\third-party\sillytavern-gateway" -Target "D:\myprojects\sillytavern-gateway"
```

**Windows（CMD，符号链接，需以管理员身份运行）**：

```cmd
mklink /D "C:\SillyTavern\public\scripts\extensions\third-party\sillytavern-gateway" "D:\myprojects\sillytavern-gateway"
```

**Linux / macOS（软链接）**：

```bash
ln -s /path/to/sillytavern-gateway ~/SillyTavern/public/scripts/extensions/third-party/sillytavern-gateway
```

> 链接建好后，仍需 `cd` 进入**真实项目目录**执行 `npm install` 和 `npm start` 来启动后端服务。

### 方式三：一键启动脚本（推荐新手）

如果你不想手动敲命令，项目提供了两个一键脚本，自动完成依赖检查、端口清理、更新拉取和后台启动。

#### Windows -- `启动网关.bat`

将 `启动网关.bat` 放在网关根目录或其上级目录（如 `D:\预设\` 或 `D:\SillyTavern\`），双击即可。

**脚本功能**：
1. 检查 Node.js >= 20 和 npm 是否安装
2. 自动检测网关目录（支持脚本同级、子目录、ST 扩展路径等多种位置）
3. 检查目录写入权限（提前发现 Program Files 等保护目录问题）
4. 清理占用 3210 端口的旧进程
5. 可选拉取 Git 更新（非 Git 仓库自动跳过）
6. 检查并安装 npm 依赖
7. 后台最小化窗口启动网关

**手动指定路径**：如果自动检测失败，编辑 `.bat` 文件顶部的用户配置区：

```batch
REM 去掉 REM 前缀，填入实际路径:
set "GATEWAY_PATH=D:\SillyTavern\public\scripts\extensions\third-party\sillytavern-gateway"
```

**检测覆盖的路径**（按顺序）：

| 检测步骤 | 说明 |
|---------|------|
| Step 0 | 用户手动配置的 `GATEWAY_PATH` |
| Step 1 | 脚本所在目录即为网关根目录 |
| Step 2 | 脚本同级有 `sillytavern-gateway\` 子目录 |
| Step 3 | 脚本位于网关子目录中（上溯 4 级） |
| Step 4 | 向下搜索子目录（2 层深度） |
| Step 5 | 常见 SillyTavern 扩展路径 |

#### Linux / macOS / Termux -- `gateway-manager.sh`

```bash
# 赋予执行权限（首次）
chmod +x scripts/gateway-manager.sh

# 交互式管理菜单（安装/启动/停止/配置/插件管理）
./scripts/gateway-manager.sh

# 或直接启动
./scripts/gateway-manager.sh start

# 查看状态
./scripts/gateway-manager.sh status

# 停止
./scripts/gateway-manager.sh stop
```

**支持的操作系统**：
- Ubuntu / Debian（apt）
- CentOS / RHEL / Rocky / AlmaLinux（dnf）
- Arch / Manjaro（pacman）
- Alpine（apk）
- macOS（brew）
- Termux（pkg，Android）
- WSL / Git Bash

**跨平台兼容性**：

| 特性 | Ubuntu | CentOS | macOS | Termux | WSL |
|------|--------|--------|-------|--------|-----|
| 包管理器检测 | apt | dnf | brew | pkg | apt |
| systemd 服务 | 支持 | 支持 | 不适用 | 不适用 | 支持 |
| 端口检测 | /proc + ss | /proc + ss | lsof | /proc | /proc + ss |
| 路径处理 | $HOME | $HOME | $HOME | $PREFIX | /mnt/* |
| sed 兼容 | GNU | GNU | BSD (已适配) | GNU | GNU |

> macOS 注意事项：`md5sum` 命令在 macOS 上不可用（使用 `md5` 替代），脚本更新后的自动热重载在 macOS 上不可用，需手动重新运行。macOS 暂不支持 launchd 开机自启。

#### Docker -- `docker compose`

```bash
cp .env.example .env      # 填入配置
docker compose up -d      # 后台启动
docker compose logs -f    # 查看日志
```

### 启用扩展并验证

1. **重启 SillyTavern**（或在浏览器按 `Ctrl + F5` 强制刷新页面）
2. 打开 SillyTavern 的 **扩展** 面板（拼图图标 🧩），找到 **Multi-Platform Gateway**，勾选启用
3. 启用后顶部设置栏会出现网关图标，点击打开面板
4. 在面板中填入网关地址。**本机部署**填 `http://127.0.0.1:3210`；**网关在服务器、你在本机浏览器访问**则填 `http://<服务器IP>:3210`（网关默认绑定 `0.0.0.0` 允许外部访问）。填入控制台打印的鉴权 Token，点击 **连接**，可用 **验证全部** 检查各平台连接状态

> **❓ 连接失败 / "Failed to fetch"？** 浏览器里的请求到不了网关，常见原因：①网关没启动；②地址或端口不对；③网关绑定了 `127.0.0.1` 导致跨机访问被拒（改成 `0.0.0.0`）；④Token 没填或填错（会返回 401 鉴权失败）。面板报错会给出具体原因。

> **❓ 重启后顶级面板仍不显示？**
> - 确认扩展目录名为 `sillytavern-gateway`，且位于 `public/scripts/extensions/third-party/` 之下
> - 确认目录内存在 `manifest.json`、`index.js`、`style.css`
> - 确认已在 SillyTavern 扩展列表中勾选启用本扩展
> - 尝试 `Ctrl + F5` 强制刷新以清除浏览器缓存

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

> 完整的分系统安装命令、链接方式与故障排查见上方 [快速开始](#快速开始)。此处仅为要点摘要。

1. 将 `sillytavern-gateway` 文件夹放入（或链接到）SillyTavern 的**第三方扩展目录**：

   ```
   SillyTavern/public/scripts/extensions/third-party/sillytavern-gateway/
   ```

   > ⚠️ 注意是 `extensions/third-party/` 下的 `sillytavern-gateway` 目录，**不是** `extensions/gateway/`。放错位置会导致顶级面板不显示。

2. 重启 SillyTavern（或 `Ctrl + F5` 强制刷新）

3. 在扩展菜单（拼图图标 🧩）中找到 **Multi-Platform Gateway** 并勾选启用

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

### 启动脚本问题排查

**Q: 双击 `启动网关.bat` 闪退**
- 右键编辑 `.bat` 文件，检查是否有 `chcp 65001` 残留（已修复版本不应有）
- 确认文件编码为 GBK（非 UTF-8），否则中文显示乱码
- 在 CMD 中手动运行 `.bat` 查看完整错误信息

**Q: `启动网关.bat` 提示"未找到网关程序"**
- 脚本自动检测覆盖 6 种路径模式（见上方"方式三"表格）
- 若仍失败，编辑 `.bat` 顶部 `GATEWAY_PATH` 手动指定路径
- 确认目标目录下存在 `server\index.js`

**Q: `启动网关.bat` 提示"无法写入网关目录"**
- 网关安装在 `C:\Program Files\` 等系统保护目录时会触发
- 解决方案：以管理员身份运行脚本，或将网关移动到非保护目录

**Q: `gateway-manager.sh` 在 macOS 上报 `md5sum: command not found`**
- macOS 使用 `md5` 而非 `md5sum`，脚本已容错处理（仅影响更新后自动热重载）
- 手动重新运行脚本即可

**Q: `gateway-manager.sh` 权限不足**
- 执行 `chmod +x scripts/gateway-manager.sh` 赋予执行权限
- 系统级操作（安装依赖、systemd 服务）需要 `sudo`

**Q: npm install 很慢或失败**
- 使用国内镜像：`npm config set registry https://registry.npmmirror.com`
- 检查网络连接和代理设置
- 删除 `node_modules` 和 `package-lock.json` 后重试

## Agent 平台化能力

网关内置一套 Agent 平台化能力（`plugins/agent-framework/` + `plugins/agent-rp/` + `server/agent/`），把"引擎产出"与"界面渲染"解耦，一套 Agent 引擎驱动三套界面，并借鉴 TauriTavern 的 Workspace-as-Truth 抑制长期 RP 的状态漂移。完整设计与开发指南见 [docs/AGENT_FRAMEWORK_GUIDE.md](docs/AGENT_FRAMEWORK_GUIDE.md)，架构设计见 [docs/AGENT_PLATFORM_ARCHITECTURE.md](docs/AGENT_PLATFORM_ARCHITECTURE.md)。

### 表现层抽象（Presentation Surface）

Agent 引擎不再直接 `ctx.reply(text)`，而是产出结构化的 `AgentRunResult`（artifacts / options / state / events / meta），由表现层适配器决定如何渲染：

| 界面 | 适配器 | 能力 |
|------|--------|------|
| **IM 增强** | `agent-rp`（`/rp start`） | 正文分段 + `>选项X：` 交互按钮（复用 option-splitter）+ 实时状态图（复用 message-to-image）+ 群聊多 Bot 协同 |
| **Agent 专用前端** | 独立页 `/agent`（`public/agent.*`） | 不依赖 SillyTavern 的独立 Agent 剧场：SSE 实时正文流 + 状态面板 + 事件时间线 + 提示词查看器 + 聊天记录管理 + AI 修改 Profile（YAML 热重载） |

插件通过 `ctx.surface.register(adapter)` 注册适配器（需声明 `surface` 权限），一个会话可绑定一个主适配器 + 多个旁路适配器。

### Workspace + Journal（可审计可回滚）

所有 Agent 变更先写 run 级 workspace（`data/plugins/agent-framework/runs/<run-id>/`），追加 append-only 事件流到 `events.jsonl`（seq 单调递增），关键节点自动 checkpoint；run 成功 `commit` 才 promote 产物到会话级稳定层，失败 / 取消不污染。支持 `rollback` 从 checkpoint 恢复，时间线 UI 可查看完整工具调用链定位"幽灵事实"。

写入性能优化：`appendEvent` 按内存缓冲批处理（100 次 ~3ms），seq 内存计数器不重读文件。

### 权限隔离

| 权限 | 说明 | 默认 |
|------|------|------|
| `agent` | 使用 Agent 框架（注册工具 / 调度子代理 / 触发 run） | 否 |
| `surface` | 注册表现层适配器 | 否 |
| `workspace` | 跨插件共享 workspace（多 Bot 协同） | 否 |

三项权限均非默认授予，未声明时调用即抛清晰错误；不同插件各自按自身权限收窄，互不影响。

### 开箱即用

`/rp start` 一条命令即可开玩（默认 GM + 可选 Critic + 四层记忆 + 去八股文风）。进阶模板（multi-critic / director-mode / state-engine）与独立角色模式见 `plugins/agent-framework/templates/`。

## 开发指南

### 插件开发

网关内置完整的插件系统，支持命令、事件监听、出站过滤、定时任务与前端配置界面。

📖 **完整插件开发规范指南**：[docs/PLUGIN_DEVELOPMENT_GUIDE.md](docs/PLUGIN_DEVELOPMENT_GUIDE.md)

该指南覆盖从 `plugin.json` / `index.js` 结构、`GatewayPlugin` SDK API、命令/监听器/出站过滤器，到配置持久化、**抽屉式前端配置界面标准格式**、GitHub 分发与插件市场的全流程，可直接据此（或借助 AI 辅助编程）开发插件。内置示例参见 `plugins/example-hello/`、`plugins/example-dice/`、`plugins/regex-filter/`。

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
| 运行时 | Node.js 20+ (ESM) |
| HTTP 服务 | Express |
| WebSocket | ws |
| QQ 协议 | OneBot v11 |
| Telegram | node-telegram-bot-api |
| Discord | discord.js v14 |
| 飞书 | @larksuiteoapi/node-sdk（可选） |
| 钉钉 | dingtalk-stream（可选） |
| 日志 | Winston |
| 事件总线 | EventEmitter3 |
| YAML 解析 | js-yaml |
| 容器化 | Docker (node:22-slim) + docker-compose |
| CI/CD | GitHub Actions (Node 20/22 矩阵测试) |
| 测试 | Node.js 内置 test runner (900+ 用例) |

## 贡献指南

### 开发环境搭建

```bash
git clone https://github.com/JOJO666888888/sillytavern-gateway.git
cd sillytavern-gateway
npm install
npm test          # 确保所有测试通过
npm run dev       # 开发模式（热重载）
```

### npm scripts 速查

| 命令 | 说明 |
|------|------|
| `npm start` | 启动主网关服务（端口 3210） |
| `npm run dev` | 开发模式（文件变更自动重启） |
| `npm run agent` | 启动 Agent 独立服务（端口 4321） |
| `npm run agent:dev` | Agent 开发模式 |
| `npm test` | 运行全部测试 |
| `npm run test:watch` | 测试监听模式 |
| `npm run token` | 打印网关鉴权 token |

### 提交规范

1. Fork 仓库并创建功能分支
2. 确保新代码有对应测试覆盖
3. 运行 `npm test` 确认全部通过
4. 提交 Pull Request，描述变更内容和动机

### 文档

- [插件开发指南](docs/PLUGIN_DEVELOPMENT_GUIDE.md)
- [Agent 框架指南](docs/AGENT_FRAMEWORK_GUIDE.md)
- [自建推理管线文档](docs/NATIVE_RUNTIME.md)
- [部署指南](docs/DEPLOYMENT.md)
- [新增平台适配器](docs/ADDING_PLATFORMS.md)

## 致谢

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) - 适配器架构与消息总线设计参考
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) - 多平台网关与会话管理参考
- [NapCat](https://github.com/NapNeko/NapCatQQ) - QQ OneBot v11 实现
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) - LLM 前端

## License

MIT
