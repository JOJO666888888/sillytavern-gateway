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

**或让它自动生成**，然后从日志取：

```bash
docker compose logs gateway | grep "鉴权 token"
```

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

**备份就是打包这几个目录**（尤其 `config/` 和 `data/`）。

### 卷权限问题

容器内以 uid 1000（`node` 用户）运行。若宿主机目录属主不同会写入失败：

```bash
# 症状：日志里 EACCES / permission denied
sudo chown -R 1000:1000 config data logs assets plugins
```

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

## 四、暴露到公网（谨慎）

默认端口只绑 `127.0.0.1`。网关持有你**全部平台的 bot token**，暴露公网前请想清楚。

确需远程访问时改 `docker-compose.yml`：

```yaml
ports:
  - "0.0.0.0:3210:3210"
```

并且必须：

1. **保持 `GATEWAY_REQUIRE_AUTH=true`**（默认值，别关）
2. **前置 HTTPS 反代**——否则 `X-Gateway-Token` 在网上明文传输
3. 用足够长的随机 token

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
- **非 root 运行**（uid 1000）。
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
多半是 token 不对。`docker compose logs gateway | grep "鉴权 token"` 取出来重填。

**日志里 EACCES / permission denied**
卷权限问题，见上面"卷权限问题"。

**改了 .env 没生效**
用 `docker compose up -d`（重建容器），不是 `restart`。

**QQ 连不上 NapCat**
容器内的 `127.0.0.1` 是容器自己。用 `ws://napcat:3001`（compose 内）或
`ws://host.docker.internal:8080`（宿主机上的 NapCat）。
