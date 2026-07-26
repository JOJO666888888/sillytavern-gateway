#!/bin/sh
set -e

# ─────────────────────────────────────────────────────────────
# 容器入口：解决 bind mount 的两个经典陷阱，然后降权运行
#
# 陷阱一：挂载会**覆盖**镜像里的同名目录
#   compose 挂了 ./plugins:/app/plugins。若宿主机 ./plugins 不存在（用户只下载了
#   compose 文件而没 clone 仓库），Docker 会创建一个空目录并盖住镜像里的
#   /app/plugins —— 5 个内置插件凭空消失。
#   对策：镜像里另存一份原始插件到 /opt/gateway/plugins-default，
#   启动时把挂载卷里**缺失的**插件补进去（已存在的不动，不覆盖用户改动）。
#
# 陷阱二：挂载目录的属主是宿主机的，Dockerfile 里的 chown 对它无效
#   宿主机目录通常属 root，而容器内以 uid 1000 运行 → 写入 EACCES。
#   对策：以 root 启动，修正这些目录属主后再用 gosu 降权到 node。
#   （所以 Dockerfile 里没有 USER node —— 降权在这里做。）
# ─────────────────────────────────────────────────────────────

APP_USER=node
APP_UID=1000
APP_GID=1000
STATE_DIRS="/app/config /app/data /app/logs /app/assets /app/plugins"
PLUGIN_SEED=/opt/gateway/plugins-default

seed_plugins() {
    [ -d "$PLUGIN_SEED" ] || return 0
    mkdir -p /app/plugins
    for src in "$PLUGIN_SEED"/*/; do
        [ -d "$src" ] || continue
        name=$(basename "$src")
        if [ ! -d "/app/plugins/$name" ]; then
            cp -a "$src" "/app/plugins/$name"
            echo "[entrypoint] 已补入内置插件: $name"
        fi
    done
}

fix_ownership() {
    for d in $STATE_DIRS; do
        mkdir -p "$d"
        # 只在属主不对时递归 chown：大目录（如 data/media-cache）每次全量 chown
        # 会显著拖慢启动
        owner=$(stat -c '%u' "$d" 2>/dev/null || echo 0)
        if [ "$owner" != "$APP_UID" ]; then
            echo "[entrypoint] 修正目录属主: $d"
            chown -R "$APP_UID:$APP_GID" "$d" || \
                echo "[entrypoint] 警告: 无法 chown $d（只读挂载？），若后续报 EACCES 请在宿主机执行 chown -R 1000:1000"
        fi
    done
}

if [ "$(id -u)" = "0" ]; then
    seed_plugins
    fix_ownership
    # 降权到 node 用户执行真正的命令
    exec gosu "$APP_USER" "$@"
else
    # 已经是非 root（用户用 docker run --user 覆盖了）：
    # 不能 chown，也不强行播种到可能无权限的目录，尽力而为
    echo "[entrypoint] 以非 root ($(id -u)) 运行，跳过属主修正"
    seed_plugins 2>/dev/null || true
    exec "$@"
fi
