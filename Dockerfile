# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# SillyTavern Multi-Platform Gateway
#
# 基础镜像选 node:22-slim（Debian）而非 alpine，理由：
#   - alpine 用 musl libc，discord.js / puppeteer-core 等生态在 musl 下
#     偶发兼容问题，排查成本高于省下的那点体积
#   - message-to-image 插件需要系统 Chromium 与中文字体，Debian 源里现成
#   - slim 已经足够小（~80MB），不值得为 alpine 冒兼容风险
#
# 可选依赖（飞书 / QQ官方 / 钉钉 SDK）默认**装**：
#   镜像构建是一次性成本，而用户启用某平台时若还要进容器 npm install，
#   就违背了"一键部署"的目的。puppeteer-core 属于插件级依赖，不在此安装。
# ─────────────────────────────────────────────────────────────

# ============ 构建阶段：只装依赖，利用层缓存 ============
FROM node:22-slim AS deps

WORKDIR /app

# 先只拷贝依赖清单——源码改动不会使这层缓存失效
COPY package.json package-lock.json ./

# 一律用 npm ci（不退回 npm install）：
# 只有它能保证镜像里的依赖树和 lock 文件逐字一致。而且 lock 与 package.json
# 不同步时它会**直接失败**，而不是像 npm install 那样默默改写 lock 装一套新的
# —— 这正是我们要的：不同步就该在构建期炸掉，而不是发到生产才发现。
# --omit=dev：本项目无 devDependencies，写上是为了将来加了也不会进镜像。
# 可选依赖（三个平台 SDK）不 omit，见文件头说明。
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force


# ============ 运行阶段 ============
FROM node:22-slim AS runtime

# tini：作为 PID 1 正确转发信号并回收僵尸进程。
#   没有它，容器内 node 是 PID 1，收不到默认的 SIGTERM 处理，
#   docker stop 会等满超时后被 SIGKILL —— 那会绕过网关的优雅关闭
#   （sessionManager.stop() 落盘会话、pluginManager.shutdown()），造成数据丢失。
# ca-certificates：出站 HTTPS（各平台 API、LLM API）需要根证书。
# 中文字体：message-to-image 插件渲染中文，缺字体会得到一堆豆腐块。
#   仅装 fonts-wqy-zenhei（~15MB），够用且比 noto-cjk 全量小很多。
# gosu：entrypoint 以 root 修正挂载卷属主后，用它干净地降权到 node
#   （不用 su/sudo，它们会引入额外的信号转发与 TTY 问题）
# tzdata：让 TZ 环境变量真正生效，否则日志时间戳恒为 UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        gosu \
        tzdata \
        ca-certificates \
        fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # 容器内必须绑 0.0.0.0，否则端口映射进来也访问不到。
    # 安全性由两层保证：① 鉴权默认开启（server.requireAuth）
    # ② compose 里宿主端口默认只绑 127.0.0.1（见 docker-compose.yml）
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=3210

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# 拷贝源码（.dockerignore 已排除 node_modules 与 config/data/logs/assets）
COPY . .

# 内置插件另存一份"原始副本"到挂载点之外。
# 因为 compose 会把宿主机 ./plugins 挂到 /app/plugins 上，直接盖住镜像里的内容；
# entrypoint 启动时据此把缺失的内置插件补回挂载卷（见 docker-entrypoint.sh）。
# 注意这里**不做** `chown -R node:node /app`：
# 那会改写 node_modules 里每个文件的元数据，使该层被完整复制一份，
# 镜像凭空大出一倍的依赖体积。运行期需要写的目录只有下面这几个状态目录，
# 而它们又都是挂载卷、属主由 entrypoint 在启动时修正。
# 应用代码本身只需可读，默认权限已满足。
RUN mkdir -p /opt/gateway \
    && cp -a plugins /opt/gateway/plugins-default \
    && mkdir -p config data logs assets data/media-cache data/chats data/plugins \
    && chown -R node:node config data logs assets plugins /opt/gateway

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 注意：这里**不写 USER node**。
# 容器需以 root 启动，让 entrypoint 先修正挂载卷属主、补齐内置插件，
# 再用 gosu 降权到 node 执行真正的进程。最终运行身份仍是非 root。

EXPOSE 3210

# 健康检查走网关自带的 /api/gateway/health（该端点豁免鉴权，专为探活设计）。
# 用 node 自身发请求，避免为此多装一个 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||3210)+'/api/gateway/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 作为 init 转发信号 → entrypoint 修卷/播种/降权 → node 进程
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
