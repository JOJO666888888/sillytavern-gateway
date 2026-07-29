#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# SillyTavern Gateway 一键管理脚本
# 支持: Termux / Linux / macOS / WSL / Git Bash
# 自包含，不依赖 jq/yq，JSON 解析用 node -e
# ═══════════════════════════════════════════════════════════

# ── 全局变量 ──
GATEWAY_REPO="https://github.com/JOJO666888888/sillytavern-gateway"
INSTALL_DIR=""
PID_FILE=""
CONFIG_DIR=""
LOG_DIR=""
DATA_DIR=""
PLUGINS_DIR=""
PORT=3210
OS_TYPE=""
DISTRO=""
PKG_MANAGER=""
SCRIPT_VERSION="1.0.0"

# ── 颜色输出 ──
info()    { printf '\033[36m[INFO]\033[0m %s\n' "$*"; }
warn()    { printf '\033[33m[WARN]\033[0m %s\n' "$*"; }
error()   { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }
success() { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
dim()     { printf '\033[2m%s\033[0m\n' "$*"; }

# ── 检测安装目录 ──
detect_install_dir() {
    local script_dir
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    # 脚本在 scripts/ 下，上级是项目根目录
    local parent="$(dirname "$script_dir")"
    if [ -f "$parent/package.json" ] && [ -f "$parent/server/index.js" ]; then
        INSTALL_DIR="$parent"
    else
        # 尝试当前目录
        if [ -f "./package.json" ] && [ -f "./server/index.js" ]; then
            INSTALL_DIR="$(pwd)"
        else
            INSTALL_DIR=""
        fi
    fi
    if [ -n "$INSTALL_DIR" ]; then
        CONFIG_DIR="$INSTALL_DIR/config"
        LOG_DIR="$INSTALL_DIR/logs"
        DATA_DIR="$INSTALL_DIR/data"
        PLUGINS_DIR="$INSTALL_DIR/plugins"
        PID_FILE="$CONFIG_DIR/gateway.pid"
    fi
}

# ── 环境检测 ──
detect_os() {
    if [ -n "${PREFIX:-}" ] && echo "$PREFIX" | grep -q "com.termux"; then
        OS_TYPE="termux"
    elif [ -f "/proc/version" ] && grep -qi microsoft /proc/version 2>/dev/null; then
        OS_TYPE="windows-wsl"
    elif [ -n "${MSYSTEM:-}" ]; then
        OS_TYPE="windows-gitbash"
    elif [ "$(uname -s)" = "Darwin" ]; then
        OS_TYPE="macos"
    elif [ "$(uname -s)" = "Linux" ]; then
        OS_TYPE="linux"
    else
        OS_TYPE="unknown"
    fi
}

detect_distro() {
    DISTRO=""
    if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release 2>/dev/null || true
        DISTRO="${ID:-unknown}"
    fi
}

get_package_manager() {
    case "$OS_TYPE" in
        termux) PKG_MANAGER="pkg" ;;
        macos)  PKG_MANAGER="brew" ;;
        linux)
            case "$DISTRO" in
                debian|ubuntu|linuxmint|raspbian) PKG_MANAGER="apt" ;;
                fedora|rhel|centos|rocky|alma)   PKG_MANAGER="dnf" ;;
                arch|manjaro)                     PKG_MANAGER="pacman" ;;
                alpine)                           PKG_MANAGER="apk" ;;
                *)                                PKG_MANAGER="" ;;
            esac
            ;;
        *) PKG_MANAGER="" ;;
    esac
}

detect_deps() {
    local missing=()
    # Node.js >= 18
    if command -v node &>/dev/null; then
        local node_ver
        node_ver="$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")"
        if [ "$node_ver" -lt 18 ]; then
            warn "Node.js 版本过低: $(node --version)，需要 >= 18"
            missing+=("node>=18")
        fi
    else
        missing+=("node")
    fi
    # npm
    command -v npm &>/dev/null || missing+=("npm")
    # git
    command -v git &>/dev/null || missing+=("git")
    # curl 或 wget
    if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
        missing+=("curl/wget")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        warn "缺少依赖: ${missing[*]}"
        local install_hint=""
        case "$PKG_MANAGER" in
            pkg)  install_hint="pkg install nodejs git curl" ;;
            apt)  install_hint="sudo apt update && sudo apt install -y nodejs npm git curl" ;;
            dnf)  install_hint="sudo dnf install -y nodejs npm git curl" ;;
            pacman) install_hint="sudo pacman -S nodejs npm git curl" ;;
            apk)  install_hint="sudo apk add nodejs npm git curl" ;;
            brew) install_hint="brew install node git curl" ;;
            *)    install_hint="请手动安装: ${missing[*]}" ;;
        esac
        if [ -n "$install_hint" ]; then
            dim "  安装命令: $install_hint"
        fi
        return 1
    fi
    return 0
}

# ── JSON 工具（用 node -e，不依赖 jq）──
json_get() {
    local file="$1" key="$2"
    node -e "
        try {
            const d = JSON.parse(require('fs').readFileSync('$file', 'utf8'));
            const keys = '$key'.split('.');
            let v = d;
            for (const k of keys) v = v?.[k];
            console.log(v ?? '');
        } catch { console.log(''); }
    " 2>/dev/null
}

json_set() {
    local file="$1" key="$2" value="$3"
    node -e "
        const fs = require('fs');
        let d = {};
        try { d = JSON.parse(fs.readFileSync('$file', 'utf8')); } catch {}
        const keys = '$key'.split('.');
        let obj = d;
        for (let i = 0; i < keys.length - 1; i++) {
            if (!obj[keys[i]]) obj[keys[i]] = {};
            obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = $value;
        fs.writeFileSync('$file', JSON.stringify(d, null, 4), 'utf8');
    " 2>/dev/null
}

# ── HTTP API 调用 ──
get_auth_token() {
    if [ -z "${INSTALL_DIR:-}" ]; then detect_install_dir; fi
    [ -n "$INSTALL_DIR" ] && [ -f "$CONFIG_DIR/gateway.json" ] || return 0
    json_get "$CONFIG_DIR/gateway.json" "server.authToken"
}

api_call() {
    local method="$1" path="$2" data="${3:-}"
    local token
    token="$(get_auth_token)"
    if [ -n "$data" ]; then
        curl -s -X "$method" "http://localhost:${PORT}${path}" \
            -H "X-Gateway-Token: ${token}" \
            -H "Content-Type: application/json" \
            -d "$data" 2>/dev/null || echo ""
    else
        curl -s -X "$method" "http://localhost:${PORT}${path}" \
            -H "X-Gateway-Token: ${token}" 2>/dev/null || echo ""
    fi
}

# ── 端口检测 ──
check_port() {
    curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/api/gateway/health" 2>/dev/null || echo "000"
}

# ── 日志记录 ──
log_action() {
    local level="$1" msg="$2"
    [ -z "${LOG_DIR:-}" ] && return 0
    mkdir -p "$LOG_DIR"
    local log_file="$LOG_DIR/manager.log"
    local ts
    ts="$(date '+%Y-%m-%d %H:%M:%S')"
    printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" >> "$log_file"
    # 轮转：超 1MB 截断为最后 500 行
    if [ -f "$log_file" ]; then
        local size
        size=$(wc -c < "$log_file" 2>/dev/null || echo 0)
        if [ "$size" -gt 1048576 ]; then
            tail -500 "$log_file" > "${log_file}.tmp" && mv "${log_file}.tmp" "$log_file"
        fi
    fi
}

# ── 操作确认 ──
confirm_action() {
    local prompt="$1"
    echo ""
    warn "⚠ $prompt"
    printf "输入 YES 确认执行: "
    local reply
    read -r reply
    [ "$reply" = "YES" ]
}

# ── 配置备份/恢复 ──
backup_config() {
    [ -z "${INSTALL_DIR:-}" ] && return 1
    local ts
    ts="$(date '+%Y%m%d_%H%M%S')"
    local backup="$CONFIG_DIR/config-backup-${ts}.tar.gz"
    cd "$INSTALL_DIR"
    local files=()
    [ -d config ] && files+=("config")
    [ -f .env ] && files+=(".env")
    if [ ${#files[@]} -gt 0 ]; then
        tar czf "$backup" "${files[@]}" 2>/dev/null
        # 保留最近 5 个备份
        ls -t "$CONFIG_DIR"/config-backup-*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
        info "配置已备份: $backup"
    fi
}

restore_config() {
    local backup_file="$1"
    [ -f "$backup_file" ] || { error "备份文件不存在: $backup_file"; return 1; }
    [ -z "${INSTALL_DIR:-}" ] && return 1
    cd "$INSTALL_DIR"
    tar xzf "$backup_file" 2>/dev/null
    success "配置已恢复: $backup_file"
}

# ═══════════════════════════════════════════════════════════
# 核心操作
# ═══════════════════════════════════════════════════════════

# ── 安装 ──
cmd_install() {
    info "开始安装 SillyTavern Gateway"
    detect_os; detect_distro; get_package_manager
    info "系统: $OS_TYPE ${DISTRO:+($DISTRO)}"
    if ! detect_deps; then
        error "依赖不满足，请先安装缺失组件后重试"
        return 1
    fi

    printf "安装目录 [默认: ~/sillytavern-gateway]: "
    local dest
    read -r dest
    dest="${dest:-$HOME/sillytavern-gateway}"

    if [ -d "$dest/.git" ]; then
        warn "目录已存在且是 git 仓库: $dest"
        printf "是否更新现有仓库？(y/n): "
        local reply; read -r reply
        if [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
            cd "$dest"
            git pull
        else
            error "安装取消"
            return 1
        fi
    else
        info "正在克隆仓库..."
        git clone "$GATEWAY_REPO" "$dest" || { error "git clone 失败"; return 1; }
    fi

    cd "$dest"
    INSTALL_DIR="$dest"
    CONFIG_DIR="$dest/config"
    LOG_DIR="$dest/logs"
    DATA_DIR="$dest/data"
    PLUGINS_DIR="$dest/plugins"
    PID_FILE="$CONFIG_DIR/gateway.pid"

    info "安装依赖..."
    npm install || { error "npm install 失败"; return 1; }

    # 引导配置
    guided_config

    # 首次启动
    info "首次启动网关..."
    start_gateway

    # 安装后把管理脚本复制到用户目录，方便日常使用
    local manager_link="$HOME/gateway-manager.sh"
    cp "$INSTALL_DIR/scripts/gateway-manager.sh" "$manager_link" 2>/dev/null && chmod +x "$manager_link"

    # 显示 token
    local token
    sleep 2
    token="$(get_auth_token)"
    echo ""
    success "安装完成！"
    echo ""
    if [ -n "$token" ]; then
        info "鉴权 Token: $token"
        echo ""
    else
        warn "未能自动获取 Token，请查看日志: $LOG_DIR/gateway-stdout.log"
        dim "  或运行: cd $dest && node scripts/show-token.js"
    fi
    echo "  ┌─────────────────────────────────────────────┐"
    echo "  │  后续管理命令:                                │"
    echo "  │  ~/gateway-manager.sh          交互式菜单      │"
    echo "  │  ~/gateway-manager.sh status   查看状态       │"
    echo "  │  ~/gateway-manager.sh restart  重启网关       │"
    echo "  │  ~/gateway-manager.sh --help   查看所有命令    │"
    echo "  └─────────────────────────────────────────────┘"
    echo ""
    dim "  网关面板: http://localhost:${PORT}"
    dim "  安装目录: $dest"
    dim "  管理脚本: $manager_link"
    echo ""
    dim "  在 SillyTavern 中: 扩展 -> SillyTavern-Multiplatform-Gateway"
    dim "  填入地址 http://localhost:${PORT} 和上面的 Token 即可连接"
    log_action "INFO" "安装完成到 $dest"
}

guided_config() {
    [ -z "${INSTALL_DIR:-}" ] && return 1
    local env_file="$INSTALL_DIR/.env"
    echo ""
    info "引导配置 -- 按需启用平台，留空跳过"
    echo ""

    # 写入时区
    echo "TZ=Asia/Shanghai" > "$env_file"

    # Telegram
    printf "启用 Telegram？(y/n) [n]: "
    local r; read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        echo "GATEWAY_TELEGRAM_ENABLED=true" >> "$env_file"
        printf "Telegram Bot Token: "; read -r token
        echo "GATEWAY_TELEGRAM_BOT_TOKEN=$token" >> "$env_file"
        success "Telegram 已配置"
    fi

    # QQ (OneBot)
    printf "启用 QQ (OneBot/NapCat)？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        echo "GATEWAY_QQ_ENABLED=true" >> "$env_file"
        printf "NapCat WS 地址 [ws://127.0.0.1:8080]: "; read -r ws
        ws="${ws:-ws://127.0.0.1:8080}"
        echo "GATEWAY_QQ_WS_URL=$ws" >> "$env_file"
        success "QQ 已配置"
    fi

    # Discord
    printf "启用 Discord？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        echo "GATEWAY_DISCORD_ENABLED=true" >> "$env_file"
        printf "Discord Bot Token: "; read -r token
        echo "GATEWAY_DISCORD_BOT_TOKEN=$token" >> "$env_file"
        success "Discord 已配置"
    fi

    # 自建推理管线
    printf "启用自建推理管线（不依赖 ST 前端）？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        echo "GATEWAY_RUNTIME_ENABLED=true" >> "$env_file"
        printf "LLM Provider [openai]: "; read -r provider
        provider="${provider:-openai}"
        echo "GATEWAY_LLM_PROVIDER=$provider" >> "$env_file"
        printf "API Key: "; read -r key
        echo "GATEWAY_LLM_API_KEY=$key" >> "$env_file"
        printf "模型 [gpt-4o-mini]: "; read -r model
        model="${model:-gpt-4o-mini}"
        echo "GATEWAY_LLM_MODEL=$model" >> "$env_file"
        success "自建推理管线已配置"
    fi

    echo ""
    info "配置已写入: $env_file"
    log_action "INFO" "引导配置完成"
}

# ── 卸载 ──
cmd_uninstall() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    info "卸载 SillyTavern Gateway"
    echo ""
    warn "将删除以下内容:"
    dim "  安装目录: $INSTALL_DIR"
    dim "  配置目录: $CONFIG_DIR"
    dim "  数据目录: $DATA_DIR"
    dim "  日志目录: $LOG_DIR"
    echo ""

    if ! confirm_action "此操作不可逆！确定卸载？"; then
        info "卸载已取消"
        return 0
    fi

    # 停止进程
    stop_gateway 2>/dev/null || true

    # 备份
    local ts
    ts="$(date '+%Y%m%d_%H%M%S')"
    local backup="$HOME/gateway-uninstall-backup-${ts}.tar.gz"
    cd "$INSTALL_DIR"
    tar czf "$backup" config/ .env data/ 2>/dev/null || true
    info "已创建备份: $backup"

    # 询问是否保留配置
    printf "保留配置文件？(y/n) [y]: "
    local keep; read -r keep
    keep="${keep:-y}"

    if [ "$keep" = "y" ] || [ "$keep" = "Y" ]; then
        info "保留 config/ 和 .env，删除其余文件"
        # 保留 config 和 .env，删除其余
        local tmp_config="$HOME/gateway-config-preserve-$$"
        cp -r "$CONFIG_DIR" "$tmp_config" 2>/dev/null || true
        local env_preserved=""
        [ -f "$INSTALL_DIR/.env" ] && env_preserved="$INSTALL_DIR/.env.preserved.$$" && cp "$INSTALL_DIR/.env" "$env_preserved" 2>/dev/null || true
        rm -rf "$INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
        mv "$tmp_config" "$CONFIG_DIR" 2>/dev/null || true
        [ -n "$env_preserved" ] && mv "$env_preserved" "$INSTALL_DIR/.env" 2>/dev/null || true
    else
        rm -rf "$INSTALL_DIR"
    fi

    success "卸载完成"
    log_action "WARN" "网关已卸载，备份: $backup"
}

# ── 更新 ──
cmd_update() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    cd "$INSTALL_DIR"
    info "检查更新..."
    git fetch origin 2>/dev/null || { error "git fetch 失败"; return 1; }

    local local_head remote_head
    local_head="$(git rev-parse HEAD)"
    remote_head="$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/master 2>/dev/null || echo '')"

    if [ -z "$remote_head" ]; then
        error "无法获取远程 HEAD"
        return 1
    fi

    if [ "$local_head" = "$remote_head" ]; then
        success "已是最新版本"
        return 0
    fi

    info "发现新版本，更新内容:"
    git log --oneline "HEAD..origin/main" 2>/dev/null | head -20 || true
    echo ""

    if ! confirm_action "执行更新？"; then
        info "更新已取消"
        return 0
    fi

    # 备份
    backup_config

    # 记录更新前 HEAD（用于回滚）
    git rev-parse HEAD > "$CONFIG_DIR/.pre-update-head" 2>/dev/null || true

    # 更新
    info "拉取代码..."
    git pull || { error "git pull 失败"; return 1; }
    info "安装依赖..."
    npm install || { error "npm install 失败"; return 1; }

    # 如运行中则重启
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
        info "网关运行中，正在重启..."
        restart_gateway
    fi

    success "更新完成"
    log_action "INFO" "网关已更新到 $(git rev-parse --short HEAD)"
}

# ── 回滚 ──
cmd_rollback() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    cd "$INSTALL_DIR"

    local pre_update_head="$CONFIG_DIR/.pre-update-head"
    if [ ! -f "$pre_update_head" ]; then
        error "没有找到更新前记录，无法回滚"
        return 1
    fi

    local target_head
    target_head="$(cat "$pre_update_head")"
    warn "将回滚到: $target_head"

    if ! confirm_action "执行回滚？"; then
        info "回滚已取消"
        return 0
    fi

    # 恢复配置
    local latest_backup
    latest_backup="$(ls -t "$CONFIG_DIR"/config-backup-*.tar.gz 2>/dev/null | head -1)"
    if [ -n "$latest_backup" ]; then
        restore_config "$latest_backup"
    fi

    # git reset
    git reset --hard "$target_head" || { error "git reset 失败"; return 1; }
    npm install 2>/dev/null || true

    rm -f "$pre_update_head"
    success "已回滚到 $target_head"
    log_action "WARN" "回滚到 $target_head"
}

# ═══════════════════════════════════════════════════════════
# 进程管理
# ═══════════════════════════════════════════════════════════

start_gateway() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    cd "$INSTALL_DIR"

    # 检测是否已运行
    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE" 2>/dev/null)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            warn "网关已在运行 (PID: $pid)"
            return 0
        fi
    fi
    # 端口检测
    local code
    code="$(check_port)"
    if [ "$code" != "000" ] && [ "$code" != "" ]; then
        warn "端口 ${PORT} 已被占用，网关可能已在运行"
        return 0
    fi

    mkdir -p "$LOG_DIR" "$CONFIG_DIR"

    info "启动网关..."
    nohup node server/index.js > "$LOG_DIR/gateway-stdout.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Termux 唤醒锁
    if [ "$OS_TYPE" = "termux" ] && command -v termux-wake-lock &>/dev/null; then
        termux-wake-lock 2>/dev/null || true
        info "已获取 Termux 唤醒锁"
    fi

    # 等待启动
    info "等待启动..."
    local i=0
    while [ $i -lt 10 ]; do
        sleep 1
        local c
        c="$(check_port)"
        if [ "$c" != "000" ] && [ "$c" != "" ]; then
            success "网关已启动 (PID: $pid, 端口: $PORT)"
            log_action "INFO" "网关启动 PID=$pid"
            return 0
        fi
        # 检查进程是否还活着
        if ! kill -0 "$pid" 2>/dev/null; then
            error "网关启动失败，进程已退出"
            dim "  查看日志: $LOG_DIR/gateway-stdout.log"
            rm -f "$PID_FILE"
            return 1
        fi
        i=$((i + 1))
    done

    warn "启动超时（10秒），网关可能仍在初始化中"
    dim "  查看日志: $LOG_DIR/gateway-stdout.log"
    log_action "WARN" "网关启动超时"
}

stop_gateway() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }

    if [ ! -f "$PID_FILE" ]; then
        warn "PID 文件不存在，网关可能未运行"
        # 尝试按端口找进程
        return 0
    fi

    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -z "$pid" ]; then
        warn "PID 文件为空"
        rm -f "$PID_FILE"
        return 0
    fi

    if ! kill -0 "$pid" 2>/dev/null; then
        warn "进程 $pid 不存在"
        rm -f "$PID_FILE"
        return 0
    fi

    info "停止网关 (PID: $pid)..."
    kill -TERM "$pid" 2>/dev/null || true

    # 等待 5 秒
    local i=0
    while [ $i -lt 5 ]; do
        sleep 1
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        i=$((i + 1))
    done

    # 如还活着，强杀
    if kill -0 "$pid" 2>/dev/null; then
        warn "进程未响应 SIGTERM，发送 SIGKILL..."
        kill -9 "$pid" 2>/dev/null || true
    fi

    # Termux 释放唤醒锁
    if [ "$OS_TYPE" = "termux" ] && command -v termux-wake-unlock &>/dev/null; then
        termux-wake-unlock 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    success "网关已停止"
    log_action "INFO" "网关停止"
}

restart_gateway() {
    info "重启网关..."
    stop_gateway 2>/dev/null || true
    sleep 1
    start_gateway
}

get_status() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }

    local running=false
    local pid=""
    if [ -f "$PID_FILE" ]; then
        pid="$(cat "$PID_FILE" 2>/dev/null)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            running=true
        fi
    fi

    echo ""
    printf "  ╔══════════════════════════════════════╗\n"
    printf "  ║     SillyTavern Gateway 状态          ║\n"
    printf "  ╠══════════════════════════════════════╣\n"

    if $running; then
        printf "  ║  状态: \033[32m● 运行中\033[0m  PID: %-12s║\n" "$pid"
        # 运行时长
        local uptime=""
        if [ "$OS_TYPE" = "macos" ] || [ "$OS_TYPE" = "linux" ] || [ "$OS_TYPE" = "termux" ]; then
            local elapsed
            elapsed="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")"
            printf "  ║  运行时长: %-28s║\n" "$elapsed"
        fi
        printf "  ║  端口: %-31s║\n" "$PORT"
        # 版本
        local ver=""
        [ -f "$INSTALL_DIR/package.json" ] && ver="$(json_get "$INSTALL_DIR/package.json" "version")"
        printf "  ║  版本: %-31s║\n" "${ver:-未知}"
        printf "  ║  目录: %-31s║\n" "$INSTALL_DIR"

        # 平台连接状态
        local api_resp
        api_resp="$(api_call GET /api/gateway/status 2>/dev/null || echo "")"
        if [ -n "$api_resp" ] && [ "$api_resp" != "" ]; then
            echo "  ╠══════════════════════════════════════╣"
            echo "  ║  平台连接状态:                        ║"
            echo "$api_resp" | node -e "
                let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    try{
                        const s=JSON.parse(d);
                        const adapters=s.adapters||{};
                        for(const[name,a]of Object.entries(adapters)){
                            const st=a.connected?'✅已连接':'❌未连接';
                            const en=a.enabled?'启用':'禁用';
                            console.log('  ║  '+name+': '+st+' ('+en+')');
                        }
                    }catch{}
                });
            " 2>/dev/null || true
        fi
    else
        printf "  ║  状态: \033[31m● 已停止\033[0m                 ║\n"
        printf "  ║  端口: %-31s║\n" "$PORT"
        local ver=""
        [ -f "$INSTALL_DIR/package.json" ] && ver="$(json_get "$INSTALL_DIR/package.json" "version")"
        printf "  ║  版本: %-31s║\n" "${ver:-未知}"
        printf "  ║  目录: %-31s║\n" "$INSTALL_DIR"
    fi
    printf "  ╚══════════════════════════════════════╝\n"
    echo ""
}

generate_systemd_unit() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    local unit_file="$INSTALL_DIR/gateway.service"
    cat > "$unit_file" << EOF
[Unit]
Description=SillyTavern Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) server/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    success "systemd unit 文件已生成: $unit_file"
    dim "  安装命令: sudo cp $unit_file /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now gateway"
}

# ═══════════════════════════════════════════════════════════
# 插件管理
# ═══════════════════════════════════════════════════════════

list_plugins() {
    [ -z "${PLUGINS_DIR:-}" ] && { error "未检测到插件目录"; return 1; }
    echo ""
    info "已安装插件:"
    echo ""
    printf "  %-25s %-10s %-10s\n" "名称" "版本" "状态"
    printf "  %-25s %-10s %-10s\n" "-------------------------" "----------" "----------"
    for dir in "$PLUGINS_DIR"/*/; do
        [ -d "$dir" ] || continue
        local name ver enabled
        name="$(basename "$dir")"
        if [ -f "$dir/plugin.json" ]; then
            ver="$(json_get "$dir/plugin.json" "version")"
            enabled="$(json_get "$dir/plugin.json" "enabled")"
        fi
        ver="${ver:-?}"
        if [ "$enabled" = "true" ]; then
            enabled="✅ 启用"
        elif [ "$enabled" = "false" ]; then
            enabled="❌ 禁用"
        else
            enabled="--"
        fi
        printf "  %-25s %-10s %-10s\n" "$name" "$ver" "$enabled"
    done
    echo ""
}

install_plugin() {
    printf "GitHub 仓库地址 (如 JOJO666888888/sillytavern-gateway-option-splitter): "
    local repo
    read -r repo
    [ -z "$repo" ] && { warn "未输入地址"; return 1; }

    local plugin_name
    plugin_name="$(basename "$repo")"
    # 去除可能的 .git 后缀
    plugin_name="${plugin_name%.git}"

    local target="$PLUGINS_DIR/$plugin_name"
    if [ -d "$target" ]; then
        warn "插件已存在: $plugin_name"
        printf "是否更新？(y/n): "
        local r; read -r r
        if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
            cd "$target" && git pull
        fi
        return 0
    fi

    info "安装插件: $plugin_name"
    git clone "https://github.com/$repo" "$target" || { error "克隆失败"; return 1; }

    # 如有 package.json，安装依赖
    if [ -f "$target/package.json" ]; then
        info "安装插件依赖..."
        cd "$target" && npm install 2>/dev/null || true
    fi

    success "插件已安装: $plugin_name"
    printf "是否启用？(y/n) [y]: "
    local r; read -r r
    r="${r:-y}"
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        enable_plugin "$plugin_name"
    fi
    log_action "INFO" "安装插件 $plugin_name"
}

enable_plugin() {
    local name="$1"
    [ -z "$name" ] && { error "请指定插件名"; return 1; }
    local file="$PLUGINS_DIR/$name/plugin.json"
    [ -f "$file" ] || { error "插件不存在: $name"; return 1; }
    json_set "$file" "enabled" "true"
    success "插件已启用: $name"
    log_action "INFO" "启用插件 $name"
}

disable_plugin() {
    local name="$1"
    [ -z "$name" ] && { error "请指定插件名"; return 1; }
    local file="$PLUGINS_DIR/$name/plugin.json"
    [ -f "$file" ] || { error "插件不存在: $name"; return 1; }
    json_set "$file" "enabled" "false"
    success "插件已禁用: $name"
    log_action "INFO" "禁用插件 $name"
}

uninstall_plugin() {
    local name="$1"
    [ -z "$name" ] && { error "请指定插件名"; return 1; }
    local target="$PLUGINS_DIR/$name"
    [ -d "$target" ] || { error "插件不存在: $name"; return 1; }

    if ! confirm_action "删除插件 $name 及其数据？"; then
        info "已取消"
        return 0
    fi

    rm -rf "$target"
    # 同时删除数据目录
    [ -d "$DATA_DIR/plugins/$name" ] && rm -rf "$DATA_DIR/plugins/$name"
    success "插件已卸载: $name"
    log_action "WARN" "卸载插件 $name"
}

manage_plugins() {
    [ -z "${PLUGINS_DIR:-}" ] && { error "未检测到插件目录"; return 1; }
    while true; do
        list_plugins
        echo "  a) 安装插件  e) 启用  d) 禁用  r) 卸载  q) 返回"
        printf "选择: "
        local choice; read -r choice
        case "$choice" in
            a|A) install_plugin ;;
            e|E)
                printf "插件名: "; local n; read -r n
                enable_plugin "$n" ;;
            d|D)
                printf "插件名: "; local n; read -r n
                disable_plugin "$n" ;;
            r|R)
                printf "插件名: "; local n; read -r n
                uninstall_plugin "$n" ;;
            q|Q) break ;;
            *) warn "无效选择" ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════
# 平台管理
# ═══════════════════════════════════════════════════════════

manage_platforms() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    while true; do
        echo ""
        info "平台管理"
        # 获取状态
        local api_resp
        api_resp="$(api_call GET /api/gateway/status 2>/dev/null || echo "")"
        if [ -n "$api_resp" ] && [ "$api_resp" != "" ]; then
            echo "$api_resp" | node -e "
                let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    try{
                        const s=JSON.parse(d);
                        const adapters=s.adapters||{};
                        console.log('');
                        console.log('  平台          启用        连接');
                        console.log('  -----------   --------    --------');
                        for(const[name,a]of Object.entries(adapters)){
                            const en=a.enabled?'✅':'❌';
                            const co=a.connected?'✅已连接':'❌断开';
                            console.log('  '+name.padEnd(14)+en+'          '+co);
                        }
                    }catch(e){console.log('  (无法解析状态)')}
                });
            " 2>/dev/null || echo "  (网关未运行或无法获取状态)"
        else
            echo "  (网关未运行，无法获取平台状态)"
        fi
        echo ""
        echo "  1) 配置 Telegram"
        echo "  2) 配置 QQ (OneBot)"
        echo "  3) 配置 Discord"
        echo "  4) 配置飞书"
        echo "  5) 配置 QQ官方"
        echo "  6) 配置钉钉"
        echo "  7) 重连已断开平台"
        echo "  q) 返回"
        printf "选择: "
        local choice; read -r choice
        case "$choice" in
            1) config_platform "telegram" "GATEWAY_TELEGRAM" "botToken" ;;
            2) config_platform "qq" "GATEWAY_QQ" "wsUrl" ;;
            3) config_platform "discord" "GATEWAY_DISCORD" "botToken" ;;
            4) config_platform "feishu" "GATEWAY_FEISHU" "appId" ;;
            5) config_platform "qqofficial" "GATEWAY_QQOFFICIAL" "appId" ;;
            6) config_platform "dingtalk" "GATEWAY_DINGTALK" "clientId" ;;
            7) reconnect_platforms ;;
            q|Q) break ;;
            *) warn "无效选择" ;;
        esac
    done
}

config_platform() {
    local platform="$1" env_prefix="$2" token_field="$3"
    local env_file="$INSTALL_DIR/.env"

    printf "启用 $platform？(y/n): "
    local r; read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        # 更新 .env
        sed -i "/${env_prefix}_ENABLED=/d" "$env_file" 2>/dev/null || true
        echo "${env_prefix}_ENABLED=true" >> "$env_file"

        printf "请输入 ${token_field}: "
        local val; read -r val
        if [ -n "$val" ]; then
            sed -i "/${env_prefix}_$(echo "$token_field" | tr '[:lower:]' '[:upper:]')=/d" "$env_file" 2>/dev/null || true
            echo "${env_prefix}_$(echo "$token_field" | tr '[:lower:]' '[:upper:]')=$val" >> "$env_file"
        fi
        success "$platform 配置已更新，重启网关生效"
        log_action "INFO" "配置平台 $platform"
    fi
}

reconnect_platforms() {
    local api_resp
    api_resp="$(api_call GET /api/gateway/status 2>/dev/null || echo "")"
    if [ -z "$api_resp" ]; then
        error "网关未运行"
        return 1
    fi
    # 找出断开的平台并尝试重连
    echo "$api_resp" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{
                const s=JSON.parse(d);
                const adapters=s.adapters||{};
                for(const[name,a]of Object.entries(adapters)){
                    if(a.enabled && !a.connected){
                        console.log(name);
                    }
                }
            }catch{}
        });
    " 2>/dev/null | while read -r p; do
        info "重连平台: $p"
        api_call POST "/api/gateway/adapters/$p/connect" >/dev/null 2>&1 || true
    done
    success "重连指令已发送"
}

# ═══════════════════════════════════════════════════════════
# Skill 管理
# ═══════════════════════════════════════════════════════════

manage_skills() {
    [ -z "${DATA_DIR:-}" ] && { error "未检测到数据目录"; return 1; }
    while true; do
        echo ""
        info "Skill 管理 (文风/知识/规则文件)"
        echo ""

        local skills=()
        local idx=1
        # 扫描所有插件的 skills/ 和 styles/ 目录
        for plugin_dir in "$DATA_DIR"/plugins/*/; do
            [ -d "$plugin_dir" ] || continue
            local pname
            pname="$(basename "$plugin_dir")"
            for subdir in skills styles; do
                local dir="$plugin_dir$subdir"
                [ -d "$dir" ] || continue
                for f in "$dir"/*.md; do
                    [ -f "$f" ] || continue
                    local fname
                    fname="$(basename "$f")"
                    echo "  $idx) [$pname/$subdir] $fname"
                    skills+=("$f")
                    idx=$((idx + 1))
                done
            done
        done

        if [ ${#skills[@]} -eq 0 ]; then
            echo "  (暂无 skill 文件)"
        fi

        echo ""
        echo "  n) 新建 skill  v) 查看  d) 删除  q) 返回"
        printf "选择: "
        local choice; read -r choice

        case "$choice" in
            n|N) create_skill ;;
            v|V)
                printf "编号: "; local n; read -r n
                if [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#skills[@]}" ]; then
                    local f="${skills[$((n - 1))]}"
                    echo ""
                    dim "─── $f ───"
                    cat "$f"
                    echo ""
                else
                    warn "无效编号"
                fi
                ;;
            d|D)
                printf "编号: "; local n; read -r n
                if [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#skills[@]}" ]; then
                    local f="${skills[$((n - 1))]}"
                    if confirm_action "删除 $(basename "$f")？"; then
                        rm -f "$f"
                        success "已删除"
                        log_action "WARN" "删除 skill $f"
                    fi
                else
                    warn "无效编号"
                fi
                ;;
            q|Q) break ;;
            *) warn "无效选择" ;;
        esac
    done
}

create_skill() {
    printf "选择类型:\n  1) 文风\n  2) 知识\n  3) 规则\n选择: "
    local type; read -r type
    printf "文件名 (不含.md): "
    local name; read -r name
    [ -z "$name" ] && { warn "未输入文件名"; return 1; }

    # 选择插件目录
    local target_plugin=""
    for d in "$DATA_DIR"/plugins/*/; do
        [ -d "$d" ] || continue
        target_plugin="$(basename "$d")"
        break
    done
    if [ -z "$target_plugin" ]; then
        # 没有插件数据目录，创建一个通用的
        target_plugin="agent-rp"
    fi

    local target_dir="$DATA_DIR/plugins/$target_plugin/skills"
    mkdir -p "$target_dir"
    local target_file="$target_dir/$name.md"

    case "$type" in
        1) # 文风模板
            cat > "$target_file" << 'TEMPLATE'
# 文风设定: <名称>

## 描写风格
- 叙事视角：第三人称限定
- 语言密度：中等
- 情感基调：待定

## 对话规则
- 角色语言风格：
- 对话与叙述比例：3:7

## 场景描写
- 环境细节：
- 氛围营造：

## 禁忌
- 避免的描写方式：
TEMPLATE
            ;;
        2) # 知识模板
            cat > "$target_file" << 'TEMPLATE'
# 知识: <名称>

## 背景设定

## 人物关系

## 地点

## 物品

## 事件时间线
TEMPLATE
            ;;
        3) # 规则模板
            cat > "$target_file" << 'TEMPLATE'
# 规则: <名称>

## 核心规则

## 判定流程

## 例外情况
TEMPLATE
            ;;
        *) warn "无效类型"; return 1 ;;
    esac

    success "已创建: $target_file"
    dim "  编辑文件: nano $target_file"
    log_action "INFO" "创建 skill $name ($type)"
}

# ═══════════════════════════════════════════════════════════
# Termux 保活
# ═══════════════════════════════════════════════════════════

setup_keepalive() {
    if [ "$OS_TYPE" != "termux" ]; then
        warn "保活功能仅适用于 Termux 环境"
        info "Linux 服务器建议使用 systemd:"
        generate_systemd_unit
        return 0
    fi

    info "Termux 保活设置"
    echo ""
    echo "  当前状态:"
    # wake-lock
    if command -v termux-wake-lock &>/dev/null; then
        echo "  [1] termux-wake-lock 唤醒锁 (可用)"
    else
        echo "  [1] termux-wake-lock 唤醒锁 (不可用，需安装 termux-api)"
    fi
    # cron
    if crontab -l 2>/dev/null | grep -q "gateway-manager.sh check-restart"; then
        echo "  [2] cron 定时检查 (已启用)"
    else
        echo "  [2] cron 定时检查 (未启用)"
    fi
    # bashrc
    if grep -q "gateway-manager.sh check-restart" "$HOME/.bashrc" 2>/dev/null; then
        echo "  [3] ~/.bashrc 启动钩子 (已启用)"
    else
        echo "  [3] ~/.bashrc 启动钩子 (未启用)"
    fi
    # job-scheduler
    if command -v termux-job-scheduler &>/dev/null; then
        echo "  [4] termux-job-scheduler (可用)"
    else
        echo "  [4] termux-job-scheduler (不可用，需安装 termux-api)"
    fi
    echo ""
    echo "  a) 启用 wake-lock"
    echo "  b) 启用/禁用 cron"
    echo "  c) 启用/禁用 bashrc 钩子"
    echo "  d) 启用 job-scheduler"
    echo "  e) 禁用所有保活"
    echo "  q) 返回"
    printf "选择: "
    local choice; read -r choice

    local script_path
    script_path="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

    case "$choice" in
        a|A)
            termux-wake-lock 2>/dev/null && success "唤醒锁已获取" || warn "获取失败"
            log_action "INFO" "启用 wake-lock"
            ;;
        b|B)
            if crontab -l 2>/dev/null | grep -q "gateway-manager.sh check-restart"; then
                # 移除
                crontab -l 2>/dev/null | grep -v "gateway-manager.sh check-restart" | crontab -
                success "cron 已禁用"
                log_action "INFO" "禁用 cron 保活"
            else
                # 添加
                (crontab -l 2>/dev/null; echo "*/5 * * * * $script_path check-restart >> $LOG_DIR/keepalive.log 2>&1") | crontab -
                success "cron 已启用（每5分钟检查）"
                log_action "INFO" "启用 cron 保活"
            fi
            ;;
        c|C)
            if grep -q "gateway-manager.sh check-restart" "$HOME/.bashrc" 2>/dev/null; then
                # 移除
                sed -i '/gateway-manager.sh check-restart/d' "$HOME/.bashrc" 2>/dev/null
                success "bashrc 钩子已禁用"
                log_action "INFO" "禁用 bashrc 保活"
            else
                # 添加
                cat >> "$HOME/.bashrc" << EOF
# SillyTavern Gateway 保活
if ! curl -s -o /dev/null http://localhost:${PORT}/api/gateway/health 2>/dev/null; then
    bash "$script_path" check-restart
fi
EOF
                success "bashrc 钩子已启用"
                log_action "INFO" "启用 bashrc 保活"
            fi
            ;;
        d|D)
            if command -v termux-job-scheduler &>/dev/null; then
                termux-job-scheduler --job-id 1 --period-ms 300000 --script "$script_path check-restart" 2>/dev/null
                success "job-scheduler 已启用（每5分钟）"
                log_action "INFO" "启用 job-scheduler 保活"
            else
                warn "termux-job-scheduler 不可用，请安装: pkg install termux-api"
            fi
            ;;
        e|E)
            termux-wake-unlock 2>/dev/null || true
            crontab -l 2>/dev/null | grep -v "gateway-manager.sh check-restart" | crontab - 2>/dev/null || true
            sed -i '/gateway-manager.sh check-restart/d' "$HOME/.bashrc" 2>/dev/null || true
            success "所有保活已禁用"
            log_action "WARN" "禁用所有保活"
            ;;
        q|Q) return 0 ;;
        *) warn "无效选择" ;;
    esac
}

check_and_restart() {
    # 被 cron/bashrc 调用，静默检查并重启
    local code
    code="$(check_port)"
    if [ "$code" = "000" ] || [ -z "$code" ]; then
        # 网关未运行，尝试启动
        detect_install_dir
        [ -z "$INSTALL_DIR" ] && return 1
        cd "$INSTALL_DIR"
        nohup node server/index.js >> "$LOG_DIR/gateway-stdout.log" 2>&1 &
        echo "$!" > "$PID_FILE"
        sleep 3
        local c2
        c2="$(check_port)"
        if [ "$c2" != "000" ] && [ -n "$c2" ]; then
            echo "[$(date)] 网关已自动重启 (PID: $(cat "$PID_FILE"))" >> "$LOG_DIR/keepalive.log"
        else
            echo "[$(date)] 网关自动重启失败" >> "$LOG_DIR/keepalive.log"
        fi
    fi
}

# ═══════════════════════════════════════════════════════════
# 交互式 CLI
# ═══════════════════════════════════════════════════════════

show_help() {
    cat << 'EOF'
SillyTavern Gateway 管理工具 v1.0.0

用法: gateway-manager.sh [命令]

命令:
  (无参数)        启动交互式主菜单
  install         安装网关
  uninstall       卸载网关
  update          检查并更新
  start           启动网关
  stop            停止网关
  restart         重启网关
  status          查看运行状态
  plugins         插件管理
  platforms       平台管理
  skills          Skill 管理
  keepalive       Termux 保活设置
  rollback        回滚上次更新
  check-restart   检查并自动重启（供 cron/bashrc 调用）
  --help          显示此帮助

示例:
  ./gateway-manager.sh                    # 交互式菜单
  ./gateway-manager.sh install            # 安装
  ./gateway-manager.sh start              # 启动
  ./gateway-manager.sh plugins            # 插件管理

详细文档: scripts/gateway-manager.README.md
EOF
}

main_menu() {
    while true; do
        # 获取状态
        local status_icon="● 已停止"
        local status_color="\033[31m"
        if [ -f "$PID_FILE" ] 2>/dev/null; then
            local pid
            pid="$(cat "$PID_FILE" 2>/dev/null)"
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                status_icon="● 运行中 (PID $pid)"
                status_color="\033[32m"
            fi
        fi

        echo ""
        printf "  ╔══════════════════════════════════════╗\n"
        printf "  ║   SillyTavern Gateway 管理工具 v%-5s ║\n" "$SCRIPT_VERSION"
        printf "  ╠══════════════════════════════════════╣\n"
        printf "  ║  状态: ${status_color}%-22s\033[0m║\n" "$status_icon"
        printf "  ╠══════════════════════════════════════╣\n"
        printf "  ║  1) 安装      2) 更新      3) 卸载   ║\n"
        printf "  ║  4) 启动      5) 停止      6) 重启   ║\n"
        printf "  ║  7) 状态      8) 插件      9) 平台   ║\n"
        printf "  ║ 10) Skill     11) 保活     12) 日志  ║\n"
        printf "  ║ 13) 回滚      14) systemd           ║\n"
        printf "  ║  0) 退出                              ║\n"
        printf "  ╚══════════════════════════════════════╝\n"
        printf "  选择: "

        local choice
        read -r choice
        case "$choice" in
            1) cmd_install ;;
            2) cmd_update ;;
            3) cmd_uninstall ;;
            4) start_gateway ;;
            5) stop_gateway ;;
            6) restart_gateway ;;
            7) get_status ;;
            8) manage_plugins ;;
            9) manage_platforms ;;
            10) manage_skills ;;
            11) setup_keepalive ;;
            12) show_logs ;;
            13) cmd_rollback ;;
            14) generate_systemd_unit ;;
            0|q|Q)
                echo "再见！"
                break
                ;;
            *) warn "无效选择: $choice" ;;
        esac
    done
}

show_logs() {
    [ -z "${LOG_DIR:-}" ] && { error "未检测到日志目录"; return 1; }
    echo ""
    echo "  1) 管理日志 (manager.log)"
    echo "  2) 网关标准输出 (gateway-stdout.log)"
    echo "  3) 保活日志 (keepalive.log)"
    echo "  q) 返回"
    printf "选择: "
    local choice; read -r choice
    local target=""
    case "$choice" in
        1) target="$LOG_DIR/manager.log" ;;
        2) target="$LOG_DIR/gateway-stdout.log" ;;
        3) target="$LOG_DIR/keepalive.log" ;;
        q|Q) return 0 ;;
        *) warn "无效选择"; return 0 ;;
    esac
    if [ -f "$target" ]; then
        info "显示最后 50 行: $target"
        tail -50 "$target"
        echo ""
        dim "  完整日志: $target"
    else
        warn "日志文件不存在: $target"
    fi
}

# ═══════════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════════

main() {
    # 初始化
    detect_os
    detect_distro
    get_package_manager
    detect_install_dir

    local cmd="${1:-}"
    case "$cmd" in
        install)     cmd_install ;;
        uninstall)   cmd_uninstall ;;
        update)      cmd_update ;;
        start)       start_gateway ;;
        stop)        stop_gateway ;;
        restart)     restart_gateway ;;
        status)      get_status ;;
        plugins)     manage_plugins ;;
        platforms)   manage_platforms ;;
        skills)      manage_skills ;;
        keepalive)   setup_keepalive ;;
        rollback)    cmd_rollback ;;
        check-restart) check_and_restart ;;
        --help|-h)   show_help ;;
        "")          main_menu ;;
        *)
            error "未知命令: $cmd"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
