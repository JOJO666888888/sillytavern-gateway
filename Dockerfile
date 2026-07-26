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
COPY package.json package-lock.json* ./

# npm ci 需要 lock 文件；没有则退回 npm install。
# --omit=dev：本项目无 devDependencies，写上是为了将来加了也不会进镜像。
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev --no-audit --no-fund; \
    else \
        npm install --omit=dev --no-audit --no-fund; \
    fi \
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
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
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

# 运行时状态目录：先建好并交给 node 用户，避免挂载卷时因属主不符而无法写入。
# 注：若宿主机挂载的目录属主不是 uid 1000，容器内仍会写失败——
#     这是 Docker 卷权限的固有问题，部署文档里给了处理方法。
RUN mkdir -p config data logs assets data/media-cache data/chats data/plugins \
    && chown -R node:node /app

# 非 root 运行。node 镜像自带 uid/gid 1000 的 node 用户。
USER node

EXPOSE 3210

# 健康检查走网关自带的 /api/gateway/health（该端点豁免鉴权，专为探活设计）。
# 用 node 自身发请求，避免为此多装一个 curl。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||3210)+'/api/gateway/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 作为 init，确保 SIGTERM 能传到 node 触发优雅关闭
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
