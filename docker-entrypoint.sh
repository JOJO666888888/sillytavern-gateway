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
#   宿主机目录通常属 root，而容器内以非 root 运行 → 写入 EACCES。
#
#   这里**不**无脑 chown -R 1000。plugins/ 和 assets/ 是 bind mount，
#   chown 直接改的是宿主机 inode：plugins/ 受 git 跟踪，被改成 uid 1000 之后，
#   uid 不是 1000 的用户再 git pull 会报
#   `unable to unlink old 'plugins/xxx': Permission denied`，仓库彻底卡住；
#   assets/ 被改属主后用户往里拷角色卡也会 EACCES，而文档还写着"一般无需手动处理"。
#
#   对策：先决定"以哪个 uid 运行"，优先级为
#       PUID/PGID 环境变量  >  挂载卷现有属主  >  镜像默认的 1000
#   跟随宿主属主时根本不需要 chown，宿主机目录的属主一个字节都不会被动。
#   只有属主是 root（Docker 自动创建空目录的情形）才回落到 1000 并 chown。
# ─────────────────────────────────────────────────────────────

APP_USER=node
APP_UID=1000
APP_GID=1000
# 纯运行时状态：容器独占，属主不对就直接修，不会影响用户的工作副本
RUNTIME_DIRS="/app/config /app/data /app/logs"
# 用户的工作副本：可能是 git 仓库 / 手工拷贝的资产，只在确实写不进去时才动
SHARED_DIRS="/app/assets /app/plugins"
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

# 决定运行身份。目标是"尽量跟随宿主机属主"，从而完全不需要 chown 宿主目录。
resolve_identity() {
    if [ -n "$PUID" ] || [ -n "$PGID" ]; then
        APP_UID=${PUID:-$APP_UID}
        APP_GID=${PGID:-$APP_GID}
        echo "[entrypoint] 按 PUID/PGID 运行: ${APP_UID}:${APP_GID}"
        return 0
    fi

    # 取 config 的属主作为参考：它是纯运行时目录，最能代表"宿主机上谁在管这套数据"
    if [ -d /app/config ]; then
        owner=$(stat -c '%u' /app/config 2>/dev/null || echo 0)
        group=$(stat -c '%g' /app/config 2>/dev/null || echo 0)
        # 属主为 root 通常意味着 Docker 刚自动创建了这个空目录，不是用户的真实身份，
        # 此时回落到镜像默认的 1000（并在下面 chown）。
        if [ "$owner" != "0" ]; then
            APP_UID=$owner
            APP_GID=$group
            echo "[entrypoint] 跟随挂载卷属主运行: ${APP_UID}:${APP_GID}（不改宿主机目录属主）"
        fi
    fi
}

# 把容器内的 node 用户改成目标 uid/gid，这样它天然能写宿主机上那些目录
align_user() {
    cur_uid=$(id -u "$APP_USER" 2>/dev/null || echo '')
    cur_gid=$(id -g "$APP_USER" 2>/dev/null || echo '')
    [ -n "$cur_uid" ] || return 0

    if [ "$cur_gid" != "$APP_GID" ]; then
        groupmod -o -g "$APP_GID" "$APP_USER" 2>/dev/null || true
    fi
    if [ "$cur_uid" != "$APP_UID" ]; then
        usermod -o -u "$APP_UID" -g "$APP_GID" "$APP_USER" 2>/dev/null || true
        # 内置插件的原始副本要跟着走，否则播种进挂载卷后属主不对
        chown -R "$APP_UID:$APP_GID" /opt/gateway 2>/dev/null || true
    fi
}

fix_runtime_dirs() {
    for d in $RUNTIME_DIRS; do
        mkdir -p "$d"
        # 只在属主不对时递归 chown：大目录（如 data/media-cache）每次全量 chown
        # 会显著拖慢启动
        owner=$(stat -c '%u' "$d" 2>/dev/null || echo 0)
        if [ "$owner" != "$APP_UID" ]; then
            echo "[entrypoint] 修正目录属主: $d"
            chown -R "$APP_UID:$APP_GID" "$d" || \
                echo "[entrypoint] 警告: 无法 chown $d（只读挂载？），若后续报 EACCES 请在宿主机执行 chown -R ${APP_UID}:${APP_GID} $(basename "$d")"
        fi
    done
}

# assets/plugins：只在目标用户**确实写不进去**时才 chown，并把动了什么说清楚。
# 这样 uid 匹配的正常情况下，用户的 git 工作副本完全不受影响。
fix_shared_dirs() {
    for d in $SHARED_DIRS; do
        mkdir -p "$d"
        if gosu "$APP_UID:$APP_GID" test -w "$d" 2>/dev/null; then
            continue
        fi
        echo "[entrypoint] $d 对 uid ${APP_UID} 不可写，正在修正属主"
        echo "[entrypoint]   注意：这会改写宿主机上该目录的属主。若它是你的 git 工作副本，"
        echo "[entrypoint]   请改用 PUID=\$(id -u) PGID=\$(id -g) 让容器跟随你的身份运行。"
        chown -R "$APP_UID:$APP_GID" "$d" || \
            echo "[entrypoint] 警告: 无法 chown $d（只读挂载？）"
    done
}

if [ "$(id -u)" = "0" ]; then
    resolve_identity
    align_user
    seed_plugins
    fix_runtime_dirs
    fix_shared_dirs
    # 降权执行真正的命令
    exec gosu "$APP_UID:$APP_GID" "$@"
else
    # 已经是非 root（用户用 docker run --user 覆盖了）：
    # 不能 chown，也不强行播种到可能无权限的目录，尽力而为
    echo "[entrypoint] 以非 root ($(id -u)) 运行，跳过属主修正"
    seed_plugins 2>/dev/null || true
    exec "$@"
fi
