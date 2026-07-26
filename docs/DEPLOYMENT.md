# Docker 部署

```bash
git clone https://github.com/JOJO666888888/sillytavern-gateway.git
cd sillytavern-gateway
cp .env.example .env      # 填入你的 bot token
docker compose up -d
```

网关跑在 `http://127.0.0.1:3210`。在 SillyTavern 网关面板填入这个地址和鉴权 token 即可。

---

## 一、拿到鉴权 token

网关默认强制鉴权（防止任意网页 drive-by 调用你的本地端口）。两种方式：

**推荐：自己指定**，在 `.env` 里写

```bash
GATEWAY_AUTH_TOKEN=换成你自己的一长串随机字符
```

生成一个：`openssl rand -hex 24`

**或让它自动生成**，首次启动后取出来：

```bash
docker compose exec gateway npm run token --silent
```

> 别去日志里找。日志管道会把长十六进制串脱敏成 `<redacted-hex>`——
> 这样你贴日志求助时不会连凭据一起贴出去，代价是 token 在日志里看不见。
> 上面这条命令直接读配置，是取回 token 的正规途径。
> （宿主机上也可以直接看 `config/gateway.json` 的 `server.authToken`。）

> 用环境变量提供 token 时，它**不会**被写进 `config/gateway.json`。
> 这是有意为之——`config/` 是挂载卷，凭据写进去等于落盘。

---

## 二、目录与数据

compose 会在项目目录下创建这些挂载卷：

| 目录 | 内容 | 丢了会怎样 |
|------|------|-----------|
| `config/` | 网关配置 | token 重新生成，需重新填进 ST 面板 |
| `data/` | 会话历史、聊天存档、插件配置、媒体缓存 | **对话记录全丢** |
| `logs/` | 日志 | 只影响排障 |
| `assets/` | 角色卡 / 世界书 / 预设（自建管线用） | 需重新拷贝 |
| `plugins/` | 插件 | 需重装 |
| `napcat/` | QQ 登录态与 OneBot 配置（仅 `--profile napcat`） | 要重新扫码登录并重配 OneBot |

**备份前先停容器**：

```bash
docker compose stop
tar czf backup-$(date +%F).tgz config data assets plugins napcat
docker compose start
```

热备份（不停容器）大概率也没事，但会话文件正好在写的那一瞬间被打包进去时会拿到半个
文件。停一下最省心。

### 卷权限（一般无需手动处理）

容器以 root 启动 entrypoint，决定好运行身份后降权，再执行 node。身份的取法按优先级：

1. **你指定的 `PUID` / `PGID`**
2. **`config/` 目录现有的属主** —— 跟随宿主机身份，此时**完全不会**改动任何宿主机目录的属主
3. 都取不到（属主是 root，通常是 Docker 刚自动创建了空目录）→ 回落到 uid 1000，并 chown

第 2 条是为了不去动你的工作副本：`plugins/` 受 git 跟踪，`assets/` 是你手工拷角色卡的地方，
把它们 chown 成 1000 之后，uid 不是 1000 的用户 `git pull` 会报
`unable to unlink old 'plugins/xxx': Permission denied`，往 assets 拷文件也会 EACCES。

多用户机器、或 uid 不是 1000 的账号，建议显式指定：

```bash
# .env
PUID=1001
PGID=1001
```

（`id -u` / `id -g` 可以查到自己的。）

### 内置插件与挂载

`./plugins` 被挂载后会**覆盖**镜像里的插件目录。entrypoint 会在启动时把缺失的
内置插件（regex-filter / option-splitter / message-to-image 等）补进去，
同时**不动**你已装的第三方插件和你对内置插件的修改。

想恢复某个被改坏的内置插件：删掉 `plugins/<名字>/` 再重启容器，它会被重新补入。

---

## 三、常见接线

### 网关 + 宿主机上的 SillyTavern

ST 跑在宿主机时，网关**不需要**主动连它（是 ST 前端来连网关）。只需让 ST 页面能跨域访问：

```bash
# .env —— ST 不在 localhost 时才需要
GATEWAY_ALLOWED_ORIGINS=http://192.168.1.10:8000
```

### 网关 + QQ（NapCat）

**方式 A：一起用 compose 拉起**

```bash
docker compose --profile napcat up -d
docker compose logs -f napcat     # 扫码登录
```

```bash
# .env
GATEWAY_QQ_ENABLED=true
GATEWAY_QQ_WS_URL=ws://napcat:3001   # 走容器网络，用服务名
NAPCAT_ACCOUNT=你的QQ号
```

**方式 B：NapCat 已在宿主机上跑**

```bash
GATEWAY_QQ_WS_URL=ws://host.docker.internal:8080
```

（compose 已配好 `host.docker.internal`，Linux 上也能用。）

### 自建推理管线（不用一直开着 ST 页面）

```bash
GATEWAY_RUNTIME_ENABLED=true
GATEWAY_LLM_PROVIDER=openai
GATEWAY_LLM_API_KEY=sk-...
GATEWAY_LLM_MODEL=gpt-4o-mini
```

本地模型（Ollama 在宿主机）：

```bash
GATEWAY_LLM_BASE_URL=http://host.docker.internal:11434/v1
GATEWAY_LLM_MODEL=qwen2.5:14b
```

把 ST 里的角色卡/世界书/预设拷进 `assets/characters/`、`assets/worldbooks/`、`assets/presets/`，
详见 [NATIVE_RUNTIME.md](./NATIVE_RUNTIME.md)。

---

## 四、从别的设备访问

默认端口只绑 `127.0.0.1`，只有网关所在这台机器能连。

**不要手改 `docker-compose.yml`** —— 它受 git 跟踪，下次 `git pull` 会冲突或把你的改动
盖回去（症状是"昨天还能连，今天连不上"）。改 `.env` 里的 `GATEWAY_BIND_ADDR` 即可。

### 局域网（手机在家连一下）

```bash
# .env
GATEWAY_BIND_ADDR=192.168.1.10          # 填你这台机器的**局域网网卡地址**
GATEWAY_ALLOWED_ORIGINS=http://192.168.1.10:8000   # ST 页面地址，跨域要用
```

```bash
docker compose up -d      # 改了 .env 要 up -d 重建，restart 不重读
```

**别图省事填 `0.0.0.0`。** 在有公网 IP 的 VPS 上、或家用路由做过端口转发/DMZ 的情况下，
`0.0.0.0` 就是公网暴露。绑具体网卡地址能把风险限制在这块网卡上。

### 公网（谨慎）

网关持有你**全部平台的 bot token** 和 LLM API key，想清楚再做。

```bash
# .env
GATEWAY_BIND_ADDR=0.0.0.0
```

必须同时做到：

1. **保持 `GATEWAY_REQUIRE_AUTH=true`**（默认值，别关）
2. **前置 HTTPS 反代**——否则 `X-Gateway-Token` 在网上明文传输
3. 用足够长的随机 token

> ⚠️ **ufw / firewalld 管不住 Docker 发布的端口。**
>
> Docker 的端口发布走 `nat/PREROUTING` + `FORWARD` 链，而 ufw 管的是 `INPUT`。
> 所以「我开了 ufw 只放行 443」的机器，在 `GATEWAY_BIND_ADDR=0.0.0.0` 之后
> 3210 是**对全网敞开**的，而 `ufw status` 里什么都看不出来。
>
> 要真正收口，规则得加在 `DOCKER-USER` 链上：
>
> ```bash
> # 只允许 1.2.3.4 访问 3210，其余全丢（-I 插在链首）
> sudo iptables -I DOCKER-USER -p tcp --dport 3210 ! -s 1.2.3.4 -j DROP
> ```
>
> 更稳妥的做法是别开 `0.0.0.0`：绑回环 + 反代，或者干脆走 WireGuard/Tailscale。

有些场景（如飞书媒体转发 `GATEWAY_FEISHU_MEDIA_BASE_URL`）需要平台服务器能拉取网关的
`/media/:id`。该路由不在 `/api/*` 下、不需要鉴权，但 id 是不可猜的随机值。

---

## 五、日常运维

```bash
docker compose logs -f gateway        # 看日志
docker compose restart gateway        # 重启
docker compose down                   # 停止（数据保留在挂载卷里）
docker compose up -d --build          # 更新代码后重建

docker compose ps                     # 看健康状态（healthy/unhealthy）
```

改了 `.env` 需要 `docker compose up -d` 重建容器才生效（`restart` 不会重新读 env_file）。

---

## 六、镜像里有什么

- **基础镜像 `node:22-slim`**（Debian）而非 alpine：alpine 的 musl libc 在
  discord.js / puppeteer 生态偶有兼容问题，排查成本高于省下的体积。
- **tini 作为 PID 1**：确保 `docker stop` 的 SIGTERM 能传到 node，触发优雅关闭
  （落盘会话、卸载插件）。没有它会等满超时被 SIGKILL，**丢数据**。
- **中文字体 `fonts-wqy-zenhei`**：`message-to-image` 插件渲染中文用，
  缺字体会得到一堆豆腐块。
- **可选平台 SDK 默认已装**（飞书 / QQ官方 / 钉钉），启用对应平台不需要再进容器装东西。
- **非 root 运行**：以 root 启动 entrypoint（决定身份、补内置插件）后，
  用 gosu 降权执行 node 进程。运行 uid 见上面「卷权限」。
- **unzip**：从 GitHub 装插件时要用它解压，bookworm-slim 不自带。
- **资源上限**：compose 给网关设了 `mem_limit` / `pids_limit`（可在 `.env` 调）。
  插件是在网关主进程里执行的，没有配额时一个坏插件撑爆的是宿主机内存。
- **tzdata**：使 `TZ` 环境变量真正生效，否则日志时间戳恒为 UTC。
- `puppeteer-core` 与 Chromium **未安装** —— `message-to-image` 插件需要它，
  但会让镜像大三四百 MB。需要该插件时自建镜像加装，或改用宿主机部署。

---

## 七、排障

**容器起来了但连不上**
```bash
docker compose ps            # STATUS 是否 healthy
docker compose logs gateway  # 看有没有报错
```
确认 `.env` 里没把 `GATEWAY_HOST` 改成 `127.0.0.1`——容器内必须是 `0.0.0.0`，
否则端口映射进来也访问不到（compose 里已强制设为 `0.0.0.0`）。

**面板一直显示未连接**
多半是 token 不对。`docker compose exec gateway npm run token --silent` 取出来重填。

**日志里 EACCES / permission denied**
见上面「卷权限」一节。最省事的解法是在 `.env` 里设 `PUID` / `PGID` 为你自己的
uid/gid（`id -u` / `id -g`），让容器跟随你的身份跑。用 `--user` 覆盖了运行身份时
entrypoint 不会做任何属主修正，需要自己 chown。

**改了 .env 没生效**
用 `docker compose up -d`（重建容器），不是 `restart`。

**QQ 连不上 NapCat**
先分清是"地址写错"还是"NapCat 那边根本没开监听"：

1. 地址：容器内的 `127.0.0.1` 是容器自己。用 `ws://napcat:3001`（compose 内）或
   `ws://host.docker.internal:8080`（宿主机上的 NapCat）。
2. 监听：`docker compose exec napcat sh -c 'cat /app/napcat/config/onebot11.json'`，
   看 `websocketServers` 里有没有 `enable: true` 的 3001。compose 已经设了
   `MODE: ws` 让镜像启动时套用官方 ws 模板；若你之前手动改过配置文件，
   模板不会覆盖它，需要去 WebUI（http://127.0.0.1:6099）里自己打开正向 WebSocket。

**每次重启 NapCat 都要重新扫码**
检查 `./napcat/qq` 里有没有东西。登录态在容器里的路径是 `/app/.config/QQ`
（镜像里 napcat 用户的 HOME 就是 `/app`）——挂错路径的话 QQ 写到的是容器内
临时层，重建即丢。
