# Gateway Manager 使用文档

> 脚本文件：`scripts/gateway-manager.sh`
> 适用版本：SillyTavern Multi-Platform Gateway v1.0.0+
> 仓库地址：https://github.com/JOJO666888888/sillytavern-gateway

---

## 1. 概述

`gateway-manager.sh` 是一个**自包含的 Bash 脚本**，为 SillyTavern 多平台网关提供一键安装、配置和管理能力。

它将网关的常见运维操作（安装、卸载、更新、启停、插件管理、平台管理、Termux 保活等）封装为统一的命令行入口，无需记忆复杂的 `npm` / `git` / `pm2` 指令组合，降低使用门槛。

### 适用场景

- **Termux（Android）**：在手机上部署网关，配合保活机制长期运行
- **Linux 服务器**：VPS / 云主机上部署网关作为常驻服务
- **WSL / Git Bash（Windows）**：在 Windows 环境下通过 Bash 运行网关
- **macOS**：本地开发或长期运行
- **快速试用**：在新机器上一键拉起网关体验功能

### 设计理念

- **零依赖**：脚本自包含，不依赖额外的 Python / Node 工具，只需系统自带的标准 Bash 工具
- **交互优先**：无参数运行即进入交互式主菜单，引导完成所有操作
- **幂等安全**：重复执行安装/更新不会破坏已有配置与数据
- **多平台兼容**：自动识别 Termux / Linux / macOS / WSL 环境，适配各自的包管理器与路径

---

## 2. 快速开始

### 下载并运行

```bash
# 下载脚本
curl -fsSL https://raw.githubusercontent.com/JOJO666888888/sillytavern-gateway/main/scripts/gateway-manager.sh -o gateway-manager.sh

# 赋予执行权限
chmod +x gateway-manager.sh

# 启动交互式主菜单
./gateway-manager.sh
```

> 如果系统没有 `curl`，可用 `wget` 替代：
> ```bash
> wget -qO gateway-manager.sh https://raw.githubusercontent.com/JOJO666888888/sillytavern-gateway/main/scripts/gateway-manager.sh
> chmod +x gateway-manager.sh
> ./gateway-manager.sh
> ```

### 直接运行指定命令

无需进入菜单，直接执行操作：

```bash
./gateway-manager.sh install     # 安装网关
./gateway-manager.sh start       # 启动网关
./gateway-manager.sh status      # 查看状态
```

---

## 3. 系统要求

### 必需依赖

| 依赖 | 最低版本 | 说明 |
|------|----------|------|
| **Node.js** | >= 18 | 网关运行时，脚本会自动检查版本 |
| **npm** | 随 Node.js 安装 | 用于安装依赖包 |
| **git** | 任意 | 用于克隆/更新仓库 |
| **curl** 或 **wget** | 任意 | 用于下载脚本与插件 |
| **Bash** | >= 4.0 | 脚本运行环境 |

### 支持的运行环境

| 环境 | 状态 | 备注 |
|------|------|------|
| Linux（x86_64 / ARM） | ✅ 完全支持 | 推荐部署环境 |
| macOS | ✅ 完全支持 | 需通过 Homebrew 安装 bash 4+ |
| Termux（Android） | ✅ 完全支持 | 支持保活机制 |
| WSL（Windows Subsystem for Linux） | ✅ 完全支持 | |
| Git Bash（Windows） | ⚠️ 部分支持 | 部分系统级操作（如服务管理）不可用 |

### 各环境依赖安装参考

**Termux：**
```bash
pkg install nodejs git curl
```

**Ubuntu / Debian：**
```bash
sudo apt update && sudo apt install -y nodejs npm git curl
```

**CentOS / RHEL / Fedora：**
```bash
sudo dnf install -y nodejs npm git curl
```

**macOS（Homebrew）：**
```bash
brew install node git curl
```

> **Node.js 版本过低？** 建议使用 [nvm](https://github.com/nvm-sh/nvm)（Node Version Manager）安装和管理 Node.js：
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
> nvm install 20
> nvm use 20
> ```

---

## 4. 命令一览表

| 命令 | 说明 |
|------|------|
| `./gateway-manager.sh` | 启动交互式主菜单 |
| `./gateway-manager.sh install` | 安装网关 |
| `./gateway-manager.sh uninstall` | 卸载网关 |
| `./gateway-manager.sh update` | 检查并更新 |
| `./gateway-manager.sh start` | 启动网关 |
| `./gateway-manager.sh stop` | 停止网关 |
| `./gateway-manager.sh restart` | 重启网关 |
| `./gateway-manager.sh status` | 查看运行状态 |
| `./gateway-manager.sh plugins` | 插件管理 |
| `./gateway-manager.sh platforms` | 平台管理 |
| `./gateway-manager.sh skills` | Skill 管理 |
| `./gateway-manager.sh keepalive` | Termux 保活设置 |
| `./gateway-manager.sh rollback` | 回滚上次更新 |
| `./gateway-manager.sh --help` | 显示帮助 |

### 命令速查

```text
用法: ./gateway-manager.sh [命令]

无参数运行将进入交互式主菜单。

可用命令:
  install      安装网关（交互式引导配置各平台）
  uninstall    卸载网关（保留配置与数据，可手动清除）
  update       检查远程更新并拉取最新代码
  start        启动网关服务（后台运行）
  stop         停止网关服务
  restart      重启网关服务
  status       查看网关运行状态、PID、端口占用
  plugins      进入插件管理子菜单
  platforms    进入平台管理子菜单
  skills       进入 Skill 管理子菜单
  keepalive    配置 Termux 保活（wake-lock / cron / bashrc / job-scheduler）
  rollback     回滚到上次更新前的版本
  --help       显示本帮助信息
```

---

## 5. 各功能详细说明

### 5.1 安装（install）

```
./gateway-manager.sh install
```

安装流程：

1. **环境检查**：验证 Node.js 版本、git、npm 是否满足要求
2. **克隆仓库**：从 GitHub 拉取项目代码（若目录已存在则跳过，改为更新）
3. **安装依赖**：执行 `npm install`
4. **交互式配置**：逐个引导配置各平台（QQ / Telegram / Discord / 飞书 / QQ 官方 / 钉钉）
   - 询问是否启用该平台
   - 引导输入必要的 Token / 密钥
   - 敏感信息写入 `.env`（不会落盘到 `config/gateway.json`）
5. **写入 .env**：自动将配置写入 `.env` 文件
6. **首次启动**：自动启动网关并显示鉴权 `authToken`
7. **完成提示**：告知后续操作（填入 SillyTavern 面板、设置保活等）

> **安全提示**：Bot Token、API Key 等敏感信息通过环境变量注入，**不会**被写入 `config/gateway.json`（该文件是挂载卷，写入等于落盘）。重启即生效，不会被文件中的旧值干扰。

### 5.2 卸载（uninstall）

```
./gateway-manager.sh uninstall
```

卸载流程：

1. 停止正在运行的网关进程
2. 询问是否删除项目目录
3. **默认保留** `config/`、`data/`、`logs/` 目录（防止误删数据）
4. 可选择完全清除（需二次确认）

> 卸载后若想重新安装，直接运行 `install` 即可，保留的数据会被复用。

### 5.3 更新（update）

```
./gateway-manager.sh update
```

更新流程：

1. 检查本地与远程版本差异
2. 如有更新，**自动备份当前版本**（用于回滚）
3. `git stash` 暂存本地修改（如有）
4. `git pull` 拉取最新代码
5. `npm install` 更新依赖
6. 自动重启网关服务

> 更新前会自动创建备份快照，可通过 `rollback` 命令回退。

### 5.4 启动 / 停止 / 重启

```bash
./gateway-manager.sh start     # 后台启动网关
./gateway-manager.sh stop      # 停止网关
./gateway-manager.sh restart   # 重启网关（等同于 stop + start）
```

- 网关以后台进程方式运行，PID 记录在 `logs/gateway.pid`
- 启动时自动检查端口（默认 `3210`）是否被占用
- 标准输出重定向到 `logs/gateway-stdout.log`
- 支持 `--foreground` 参数前台运行（调试用）

### 5.5 查看状态（status）

```
./gateway-manager.sh status
```

输出信息包括：

- 运行状态（运行中 / 已停止 / 异常）
- 进程 PID
- 监听端口
- 各平台适配器连接状态
- 内存占用
- 运行时长
- 最近错误日志（如有）

### 5.6 插件管理（plugins）

```
./gateway-manager.sh plugins
```

进入插件管理子菜单，支持以下操作：

| 操作 | 说明 |
|------|------|
| 查看已装插件 | 列出 `plugins/` 目录下所有插件及其启用状态 |
| 安装插件 | 从 GitHub 安装（输入 `用户名/仓库名`） |
| 启用插件 | 将插件从 `plugins-disabled/` 移回 `plugins/` |
| 禁用插件 | 将插件移至 `plugins-disabled/`（不删除文件） |
| 卸载插件 | 彻底删除插件目录 |
| 更新插件 | 对从 GitHub 安装的插件执行 `git pull` |

**从 GitHub 安装插件示例：**

```
请输入插件仓库地址（格式：用户名/仓库名）:
> JOJO666888888/sillytavern-gateway-option-splitter
```

脚本会自动：
1. 克隆仓库到 `plugins/option-splitter/`
2. 检查是否存在 `package.json` 并安装依赖
3. 验证 `plugin.json` 格式
4. 重启网关使插件生效

> 插件开发规范详见 [docs/PLUGIN_DEVELOPMENT_GUIDE.md](../docs/PLUGIN_DEVELOPMENT_GUIDE.md)

### 5.7 平台管理（platforms）

```
./gateway-manager.sh platforms
```

进入平台管理子菜单，支持以下操作：

| 操作 | 说明 |
|------|------|
| 查看连接状态 | 实时显示各平台适配器的连接状态（已连接/断开/重连中） |
| 修改配置 | 交互式修改各平台参数（Token、地址、白名单等） |
| 启用/禁用平台 | 切换平台适配器的启用状态 |
| 断线重连 | 手动触发指定平台的重连 |
| 测试发送 | 向指定平台发送测试消息 |

**支持的平台：**

- QQ（OneBot v11 / NapCat / Lagrange）
- Telegram
- Discord
- 飞书 / Lark
- QQ 官方机器人
- 钉钉

### 5.8 Skill 管理（skills）

```
./gateway-manager.sh skills
```

用于管理网关的 Skill（技能）模块，包括查看、安装、启用、禁用和卸载 Skill。

### 5.9 Termux 保活（keepalive）

```
./gateway-manager.sh keepalive
```

> 此功能仅在 Termux 环境下可用。

Termux 环境下 Android 系统会积极回收后台进程，需要保活机制确保网关持续运行。脚本提供四种保活手段：

| 手段 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **wake-lock** | 获取 CPU 唤醒锁，防止系统休眠 | 简单直接，效果立竿见影 | 增加耗电 |
| **cron** | 定时（每 5 分钟）检查并重启网关 | 可靠，系统级调度 | 需要 `cronie` 包 |
| **bashrc** | 每次打开 Termux 会话时检查并启动 | 零依赖，随用随启 | 需要手动打开 Termux |
| **job-scheduler** | 利用 Android 的 JobScheduler API | 系统级，省电 | 需要 `termux-job-scheduler` 插件 |

**推荐组合：cron + wake-lock**

```bash
./gateway-manager.sh keepalive
# 选择 "wake-lock" -> 获取唤醒锁
# 选择 "cron" -> 安装 cronie 并设置定时任务
```

这样既能防止系统休眠（wake-lock），又能在网关意外退出时自动重启（cron 定时检查）。

**保活状态查看：**

```bash
./gateway-manager.sh keepalive
# 选择 "查看当前保活状态"
```

输出各手段的启用情况与运行状态。

### 5.10 回滚（rollback）

```
./gateway-manager.sh rollback
```

回滚到上次 `update` 之前的版本：

1. 检查是否存在备份快照
2. 停止当前网关
3. 恢复备份的代码与依赖
4. 重启网关
5. 清理已使用的备份（可选）

> 仅保留一份备份，再次 `update` 会覆盖旧备份。如需保留特定版本，建议手动 `git tag`。

---

## 6. 使用示例

### 示例 1：Termux 全新安装

在 Android 手机上从零部署网关：

```bash
# 1. 安装依赖
pkg install nodejs git

# 2. 下载管理脚本
curl -fsSL https://raw.githubusercontent.com/JOJO666888888/sillytavern-gateway/main/scripts/gateway-manager.sh -o gateway-manager.sh
chmod +x gateway-manager.sh

# 3. 安装网关（交互式配置）
./gateway-manager.sh install
# 按提示配置 Telegram botToken：
#   - 是否启用 Telegram？(y/n) -> y
#   - 输入 Bot Token -> 1234567890:ABCdef...
#   - 是否启用其他平台？-> n
# 安装完成后会显示 authToken，记下来

# 4. 设置保活（防止 Android 杀后台）
./gateway-manager.sh keepalive
# 选择 cron + wake-lock 组合

# 5. 查看运行状态
./gateway-manager.sh status
```

### 示例 2：Linux 服务器更新

在 VPS 上更新到最新版本：

```bash
# 检查并更新
./gateway-manager.sh update

# 查看更新后状态
./gateway-manager.sh status

# 如果更新后出现问题，回滚
./gateway-manager.sh rollback
```

### 示例 3：安装插件

从 GitHub 安装选项拆分插件：

```bash
./gateway-manager.sh plugins
# 选择 "安装插件"
# 输入：JOJO666888888/sillytavern-gateway-option-splitter
# 脚本自动克隆、安装依赖、重启网关
```

或直接使用交互菜单：

```bash
./gateway-manager.sh
# 主菜单 -> 插件管理 -> 安装插件
# 输入仓库地址
```

### 示例 4：平台配置修改

修改 Telegram 的 `requireMention` 设置：

```bash
./gateway-manager.sh platforms
# 选择 "修改配置"
# 选择 "Telegram"
# 选择 "requireMention" -> 修改为 false
# 保存并重启生效
```

### 示例 5：WSL 环境部署

在 Windows 的 WSL 中部署：

```bash
# 确保 WSL 已安装 Node.js 18+
node --version

# 下载并安装
curl -fsSL https://raw.githubusercontent.com/JOJO666888888/sillytavern-gateway/main/scripts/gateway-manager.sh -o gateway-manager.sh
chmod +x gateway-manager.sh
./gateway-manager.sh install

# WSL 中不需要保活，直接启动
./gateway-manager.sh start
```

---

## 7. 故障排除

### 端口被占用

**现象**：启动时报错 `EADDRINUSE: address already in use 0.0.0.0:3210`

**解决**：

```bash
# 查看占用 3210 端口的进程
lsof -i :3210        # Linux / macOS
netstat -ano | grep 3210   # Windows / Termux

# 方案一：结束占用进程
kill -9 <PID>

# 方案二：修改网关端口
# 编辑 .env 文件，设置 GATEWAY_PORT=3211
# 或运行：
./gateway-manager.sh platforms
# -> 修改配置 -> 网关服务 -> 端口

# 方案三：重启网关（脚本会自动处理旧进程）
./gateway-manager.sh restart
```

### 权限不足

**现象**：报错 `Permission denied` 或 `EACCES`

**解决**：

```bash
# 方案一：赋予脚本执行权限
chmod +x gateway-manager.sh

# 方案二：检查项目目录权限
chown -R $(whoami) sillytavern-gateway/

# 方案三：Termux 中避免使用 sudo（Termux 无 root）
# 确保在 home 目录下操作
cd ~
```

### Node.js 版本过低

**现象**：报错 `ERR_OSSL_EVP_UNSUPPORTED` 或语法错误

**原因**：Node.js 版本低于 18，不支持项目使用的 ESM 特性或加密 API。

**解决**：

```bash
# 使用 nvm 升级 Node.js
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node --version   # 确认 >= 18

# 重新安装依赖
cd sillytavern-gateway
rm -rf node_modules
npm install
```

### 网络超时

**现象**：`git clone` / `npm install` 卡住或超时

**解决**：

```bash
# 方案一：配置 npm 镜像源（国内用户）
npm config set registry https://registry.npmmirror.com

# 方案二：配置 git 代理
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# 方案三：增加 npm 超时时间
npm config set fetch-timeout 600000
npm config set fetch-retries 5

# 方案四：使用离线方式
# 在网络良好的机器上安装好依赖后，打包整个目录传到目标机器
```

### authToken 丢失

**现象**：SillyTavern 面板连接网关报 401 鉴权失败，忘记之前生成的 Token。

**解决**：

```bash
# 方法一：通过脚本查看
./gateway-manager.sh status
# 状态信息中会显示当前 authToken

# 方法二：通过 npm 命令查看
npm run token

# 方法三：直接查看配置文件
cat config/gateway.json | grep authToken

# 方法四：重新指定 Token
# 编辑 .env 文件，设置：
# GATEWAY_AUTH_TOKEN=你的新Token
# 然后重启
./gateway-manager.sh restart
```

> **注意**：如果 Token 是通过环境变量（`.env`）设置的，它**不会**出现在 `config/gateway.json` 中，需查看 `.env` 文件或运行 `npm run token`。

### 其他常见问题

#### 网关启动后立即退出

```bash
# 查看标准输出日志
cat logs/gateway-stdout.log

# 查看详细日志
cat logs/gateway-*.log | tail -50

# 前台运行查看实时输出
./gateway-manager.sh start --foreground
```

#### 插件加载失败

```bash
# 检查插件目录结构
ls plugins/<插件名>/
# 应包含 plugin.json 和 index.js

# 验证 plugin.json 格式
cat plugins/<插件名>/plugin.json

# 禁用问题插件
./gateway-manager.sh plugins
# -> 禁用插件 -> 选择对应插件
```

#### Git pull 冲突

```bash
# 更新时自动 stash 本地修改，如仍冲突：
cd sillytavern-gateway
git stash
git pull
git stash pop   # 恢复本地修改，手动解决冲突

# 或放弃本地修改强制更新
git reset --hard origin/main
npm install
```

---

## 8. 日志位置

| 日志类型 | 文件路径 | 说明 |
|----------|----------|------|
| 操作日志 | `logs/manager.log` | 管理脚本自身的操作记录（安装/更新/启停等） |
| 网关日志 | `logs/gateway-*.log` | 网关服务运行日志（按日期轮转） |
| 网关标准输出 | `logs/gateway-stdout.log` | 网关进程的 stdout/stderr 输出 |
| 进程 PID | `logs/gateway.pid` | 当前网关进程的 PID（用于停止/重启） |

### 查看日志

```bash
# 实时查看网关日志
tail -f logs/gateway-stdout.log

# 查看最近 100 行日志
tail -n 100 logs/gateway-*.log

# 查看管理脚本操作记录
cat logs/manager.log

# 搜索错误信息
grep -i "error" logs/gateway-*.log
```

### 日志级别

网关使用 Winston 日志库，支持以下级别（从高到低）：

- `error`：错误，需要关注
- `warn`：警告，可能影响功能
- `info`：常规信息（默认级别）
- `debug`：调试信息
- `silly`：最详细的日志

> **安全提示**：日志中的敏感信息（如 Token、API Key）会被自动脱敏为 `<redacted-hex>`，可安全分享日志用于排查问题。

---

## 附录

### 相关文档

| 文档 | 说明 |
|------|------|
| [项目 README](../README.md) | 项目总览与快速开始 |
| [部署指南](../docs/DEPLOYMENT.md) | Docker 部署完整说明 |
| [插件开发指南](../docs/PLUGIN_DEVELOPMENT_GUIDE.md) | 插件开发规范 |
| [插件安全](../docs/PLUGIN_SECURITY.md) | 插件安全机制 |
| [添加新平台](../docs/ADDING_PLATFORMS.md) | 平台适配器开发 |
| [自建推理管线](../docs/NATIVE_RUNTIME.md) | 无需 ST 页面的运行模式 |

### 环境变量参考

完整的环境变量配置说明见 [.env.example](../.env.example)。

### 反馈与支持

- **问题反馈**：[GitHub Issues](https://github.com/JOJO666888888/sillytavern-gateway/issues)
- **仓库地址**：https://github.com/JOJO666888888/sillytavern-gateway
