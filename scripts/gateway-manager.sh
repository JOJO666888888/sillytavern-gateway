#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# SillyTavern Gateway 一键管理脚本
# 支持: Termux / Linux / macOS / WSL / Git Bash
# 自包含，不依赖 jq/yq，JSON 解析用 node -e
# ═══════════════════════════════════════════════════════════

# ── 全局变量 ──
GATEWAY_REPO="https://github.com/JOJO666888888/sillytavern-gateway"
ENV_FILE="$HOME/.gateway_env"
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
SCRIPT_VERSION="1.1.1"
# 保存脚本启动时的原始参数，供更新后 exec 重启使用
CLI_ARGS=()

# ── 路径记忆：加载/保存环境文件 ──
load_env() {
    if [ -f "$ENV_FILE" ]; then
        # 安全加载：逐行读取，只接受已知 key
        while IFS='=' read -r key val; do
            [ -z "$key" ] && continue
            case "$key" in
                INSTALL_DIR) INSTALL_DIR="$val" ;;
                PLUGINS_DIR) PLUGINS_DIR="$val" ;;
                PORT)        PORT="$val" ;;
            esac
        done < "$ENV_FILE" 2>/dev/null
        # 如果加载到了 INSTALL_DIR，设置派生变量
        if [ -n "$INSTALL_DIR" ]; then
            CONFIG_DIR="$INSTALL_DIR/config"
            LOG_DIR="$INSTALL_DIR/logs"
            DATA_DIR="$INSTALL_DIR/data"
            PLUGINS_DIR="${PLUGINS_DIR:-$INSTALL_DIR/plugins}"
            PID_FILE="$CONFIG_DIR/gateway.pid"
        fi
    fi
}

save_env() {
    cat > "$ENV_FILE" << EOF
# SillyTavern Gateway 管理脚本环境文件
# 自动生成，请勿手动编辑
INSTALL_DIR=$INSTALL_DIR
PLUGINS_DIR=$PLUGINS_DIR
PORT=$PORT
EOF
    chmod 600 "$ENV_FILE" 2>/dev/null || true
}

# ── RP 主题色彩方案 ──
# 主色调：紫罗兰（魔法/神秘） | 辅助色：兰紫（梦幻） | 强调色：金橙（史诗/传奇）
C_PRI='\033[38;5;99m'     # 主色调  紫罗兰
C_SEC='\033[38;5;171m'    # 辅助色  兰紫
C_ACC='\033[38;5;214m'    # 强调色  金橙
C_OK='\033[38;5;42m'      # 成功    翡翠绿
C_WARN='\033[38;5;178m'   # 警告    琥珀金
C_ERR='\033[38;5;196m'    # 错误    绯红
C_DIM='\033[38;5;244m'    # 暗色    石板灰
C_BOLD='\033[1m'
C_RESET='\033[0m'

# ── RP 主题提示函数 ──
info()    { printf "${C_BOLD}${C_SEC}✦${C_RESET} ${C_SEC}%s${C_RESET}\n" "$*"; }
warn()    { printf "${C_BOLD}${C_WARN}⚠${C_RESET} ${C_WARN}%s${C_RESET}\n" "$*"; }
error()   { printf "${C_BOLD}${C_ERR}✖${C_RESET} ${C_ERR}%s${C_RESET}\n" "$*" >&2; }
success() { printf "${C_BOLD}${C_OK}✔${C_RESET} ${C_OK}%s${C_RESET}\n" "$*"; }
dim()     { printf "${C_DIM}%s${C_RESET}\n" "$*"; }

# ── RP ASCII 艺术标题（渐变 banner）──
show_banner() {
    local v="${SCRIPT_VERSION:-1.1.1}"
    echo ""
    printf "  ${C_PRI}⚔${C_RESET} ${C_ACC}✦${C_RESET}${C_DIM}══════════════════════════════════════${C_RESET}${C_ACC}✦${C_RESET} ${C_PRI}⚔${C_RESET}\n"
    printf "       ${C_BOLD}${C_PRI}◆${C_RESET}  ${C_BOLD}${C_SEC}SILLYTAVERN GATEWAY${C_RESET}  ${C_BOLD}${C_PRI}◆${C_RESET}\n"
    printf "        ${C_ACC}✦ 角色扮演叙事网关 · 一键管理 v${v} ✦${C_RESET}\n"
    printf "  ${C_PRI}⚔${C_RESET} ${C_ACC}✦${C_RESET}${C_DIM}══════════════════════════════════════${C_RESET}${C_ACC}✦${C_RESET} ${C_PRI}⚔${C_RESET}\n"
    echo ""
}

# ── RP 主题分隔线 ──
rp_divider() {
    printf "  ${C_DIM}─${C_RESET} ${C_ACC}✦${C_RESET} ${C_DIM}────────────────────────────────────${C_RESET} ${C_ACC}✦${C_RESET} ${C_DIM}─${C_RESET}\n"
}

# ── 金色高亮文本 ──
rp_hl() { printf "${C_BOLD}${C_ACC}%s${C_RESET}" "$*"; }

# ── 状态徽章 ──
rp_badge() {
    # rp_badge <状态>  → 状态: ok|warn|err|info
    case "$1" in
        ok)   printf "${C_BOLD}${C_OK}●${C_RESET} ${C_OK}%s${C_RESET}" "${2:-OK}" ;;
        warn) printf "${C_BOLD}${C_WARN}●${C_RESET} ${C_WARN}%s${C_RESET}" "${2:-警告}" ;;
        err)  printf "${C_BOLD}${C_ERR}●${C_RESET} ${C_ERR}%s${C_RESET}" "${2:-错误}" ;;
        info) printf "${C_BOLD}${C_SEC}●${C_RESET} ${C_SEC}%s${C_RESET}" "${2:-信息}" ;;
        *)    printf "%s" "$2" ;;
    esac
}

# ── 加载动画（spinner）：后台任务旋转指示器 ──
# 用法: rp_spin "正在下载" git clone <url> <dest>
# 成功时静默返回 0，失败时回放日志尾部并返回非零
rp_spin() {
    local msg="$1"; shift
    local out
    out="$(mktemp /tmp/rp-spin.XXXXXX 2>/dev/null || echo /tmp/rp-spin.log)"
    "$@" > "$out" 2>&1 &
    local pid=$!
    # 用数组避免 ${s:pos:1} 在 macOS bash3 按字节偏移导致的乱码
    local -a spin=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${C_SEC}%s${C_RESET} ${msg}..." "${spin[$((i % 10))]}"
        i=$((i + 1))
        sleep 0.1
    done
    printf "\r\033[K"
    wait "$pid"
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        tail -20 "$out" 2>/dev/null || true
    fi
    rm -f "$out" 2>/dev/null || true
    return "$rc"
}

# ── 进度条（写入当前行，需配合 \r 刷新）──
# 用法: progress_bar <已完成> <总量> [标签]
progress_bar() {
    local done="$1" total="$2" label="${3:-}"
    local pct=0
    if [ "${total:-0}" -gt 0 ] 2>/dev/null; then
        pct=$((done * 100 / total))
    fi
    [ "$pct" -gt 100 ] 2>/dev/null && pct=100
    local filled=$((pct / 4)) i
    local bar=""
    for ((i = 0; i < filled; i++)); do bar="${bar}${C_OK}▰${C_RESET}"; done
    for ((i = filled; i < 25; i++)); do bar="${bar}${C_DIM}▱${C_RESET}"; done
    printf "\r  ${C_ACC}▸${C_RESET} %s ${C_PRI}[%s]${C_RESET} ${C_SEC}%3d%%${C_RESET}  " "$label" "$bar" "$pct"
}

# ── 检测安装目录 ──
# 优先级: 环境文件 > 脚本父目录 > 当前目录
detect_install_dir() {
    # 1. 先从 ~/.gateway_env 加载（脚本可能从家目录运行）
    if [ -n "${INSTALL_DIR:-}" ] && [ -f "$INSTALL_DIR/package.json" ]; then
        return 0
    fi

    # 2. 脚本在 scripts/ 下，上级是项目根目录
    local script_dir
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    local parent="$(dirname "$script_dir")"
    if [ -f "$parent/package.json" ] && [ -f "$parent/server/index.js" ]; then
        INSTALL_DIR="$parent"
    elif [ -f "./package.json" ] && [ -f "./server/index.js" ]; then
        # 3. 当前目录
        INSTALL_DIR="$(pwd)"
    else
        INSTALL_DIR=""
    fi
    # 设置派生变量
    if [ -n "$INSTALL_DIR" ]; then
        CONFIG_DIR="$INSTALL_DIR/config"
        LOG_DIR="$INSTALL_DIR/logs"
        DATA_DIR="$INSTALL_DIR/data"
        PLUGINS_DIR="${PLUGINS_DIR:-$INSTALL_DIR/plugins}"
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

# ── Token 获取 ──
# 从 .env 环境变量优先读取，再从配置文件读取
get_auth_token() {
    if [ -z "${INSTALL_DIR:-}" ]; then detect_install_dir; fi
    [ -n "$INSTALL_DIR" ] || return 0

    # 1. 优先从 .env 读环境变量 GATEWAY_AUTH_TOKEN
    if [ -f "$INSTALL_DIR/.env" ]; then
        local env_token
        env_token="$(grep '^GATEWAY_AUTH_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'=' -f2- || true)"
        if [ -n "$env_token" ]; then
            echo "$env_token"
            return 0
        fi
    fi
    # 2. 从配置文件读
    [ -f "$CONFIG_DIR/gateway.json" ] || return 0
    json_get "$CONFIG_DIR/gateway.json" "server.authToken"
}

# 带重试的 token 获取（等待网关写入）
get_auth_token_retry() {
    local max_retries="${1:-15}"
    local i=0
    while [ $i -lt $max_retries ]; do
        # 先检查网关进程是否存活
        local pid=""
        [ -f "$PID_FILE" ] && pid="$(cat "$PID_FILE" 2>/dev/null)"
        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
            printf "\r\033[K"
            return 1  # 进程已死，不再等待
        fi
        local token
        token="$(get_auth_token)"
        if [ -n "$token" ]; then
            printf "\r\033[K"
            echo "$token"
            return 0
        fi
        progress_bar "$((i + 1))" "$max_retries" "等待 Token 生成"
        sleep 1
        i=$((i + 1))
    done
    printf "\r\033[K"
    return 1
}

# 确保 INSTALL_DIR 发现后，派生变量都正确设置
detect_install_helper() {
    if [ -n "${INSTALL_DIR:-}" ]; then
        CONFIG_DIR="${CONFIG_DIR:-$INSTALL_DIR/config}"
        LOG_DIR="${LOG_DIR:-$INSTALL_DIR/logs}"
        DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
        PLUGINS_DIR="${PLUGINS_DIR:-$INSTALL_DIR/plugins}"
        PID_FILE="${PID_FILE:-$CONFIG_DIR/gateway.pid}"
    fi
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
    local port="${1:-$PORT}"
    curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/api/gateway/health" 2>/dev/null || echo "000"
}

# 检查端口是否真正空闲（系统级别，不依赖 HTTP）
is_port_free() {
    local port="${1:-$PORT}"
    # 方式1: /proc 扫描（Linux/Termux）
    if [ -d /proc ]; then
        local found=0
        for f in /proc/*/fd/*; do
            [ -L "$f" ] || continue
            local link
            link="$(readlink "$f" 2>/dev/null || echo "")"
            case "$link" in
                *socket:*)
                    local inode
                    inode="${link#socket:}"
                    [ "$inode" = "$link" ] && continue
                    # 检查 TCP 是否监听该 inode
                    if grep -q "$inode" /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
                        # 检查端口匹配
                        local hex_port
                        hex_port=$(printf '%04X' "$port" 2>/dev/null || echo "")
                        if [ -n "$hex_port" ] && grep -q ":$hex_port " /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
                            found=1
                            break
                        fi
                    fi
                    ;;
            esac
        done
        [ "$found" -eq 0 ] && return 0
        return 1
    fi
    # 方式2: lsof
    if command -v lsof &>/dev/null; then
        lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q . && return 1
        return 0
    fi
    # 方式3: ss
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":$port " && return 1
        return 0
    fi
    # 方式4: netstat
    if command -v netstat &>/dev/null; then
        netstat -tlnp 2>/dev/null | grep -q ":$port " && return 1
        return 0
    fi
    # 都没有，用 bash 尝试绑定
    (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null
    if [ $? -eq 0 ]; then
        exec 3>&- 3<&-
        return 1  # 能连接说明端口被占
    fi
    return 0
}

# 找一个空闲端口，从 $1 开始（默认 3210），最多试 10 个
find_port() {
    local start="${1:-3210}"
    for ((p=start; p<start+10; p++)); do
        if is_port_free "$p"; then
            echo "$p"
            return 0
        fi
    done
    echo ""
    return 1
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
# macOS 的 sed -i 需要额外参数，封装一下
sed_inplace() {
    local pattern="$1" file="$2"
    if [ "$(uname -s)" = "Darwin" ]; then
        sed -i '' "$pattern" "$file" 2>/dev/null || true
    else
        sed -i "$pattern" "$file" 2>/dev/null || true
    fi
}

backup_config() {
    [ -z "${INSTALL_DIR:-}" ] && return 0  # 没有安装目录不算错误，跳过即可
    local ts
    ts="$(date '+%Y%m%d_%H%M%S')"
    mkdir -p "$CONFIG_DIR" 2>/dev/null || true
    local backup="$CONFIG_DIR/config-backup-${ts}.tar.gz"
    cd "$INSTALL_DIR" 2>/dev/null || return 0
    local files=()
    [ -d config ] && files+=("config")
    [ -f .env ] && files+=(".env")
    if [ ${#files[@]} -gt 0 ]; then
        tar czf "$backup" "${files[@]}" 2>/dev/null || true
        # 保留最近 5 个备份
        ls -t "$CONFIG_DIR"/config-backup-*.tar.gz 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
        info "配置已备份: $backup"
    else
        dim "  无需备份（config/ 和 .env 均不存在）"
    fi
    return 0  # 始终返回成功：没有文件可备份不是错误
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

# ── SillyTavern 扩展目录链接 ──
# 前端扩展必须在 ST 的 third-party/ 目录才能被加载
# 本函数自动检测 ST 安装路径并创建软链接
link_to_st_extensions() {
    local gateway_dir="$1"
    local ext_name="sillytavern-gateway"
    local st_dir=""
    local candidates=()

    echo ""
    info "检测 SillyTavern 安装路径..."

    # 按常见安装位置生成候选路径
    case "$OS_TYPE" in
        termux)
            candidates+=(
                "$HOME/SillyTavern"
                "$HOME/storage/shared/SillyTavern"
                "$PREFIX/share/SillyTavern"
            )
            ;;
        linux)
            candidates+=(
                "$HOME/SillyTavern"
                "$HOME/sillytavern"
                "/opt/SillyTavern"
                "/srv/SillyTavern"
            )
            ;;
        macos)
            candidates+=(
                "$HOME/SillyTavern"
                "/Applications/SillyTavern"
            )
            ;;
        windows-wsl|windows-gitbash)
            # Windows 上的常见路径（通过 /mnt/c 或 Windows 路径）
            candidates+=(
                "/mnt/c/SillyTavern"
                "/mnt/d/SillyTavern"
                "C:/SillyTavern"
                "D:/SillyTavern"
                "$HOME/SillyTavern"
            )
            ;;
    esac

    # 逐个检测候选路径
    for p in "${candidates[@]}"; do
        if [ -d "$p/public/scripts/extensions/third-party" ]; then
            st_dir="$p"
            break
        fi
    done

    # 如果没找到，询问用户
    if [ -z "$st_dir" ]; then
        warn "未自动找到 SillyTavern 安装目录"
        echo "  SillyTavern 前端扩展需要安装到 ST 的扩展目录才能显示面板："
        dim "  SillyTavern/public/scripts/extensions/third-party/"
        echo ""
        printf "请输入 SillyTavern 安装路径 (留空跳过，之后可手动链接): "
        read -r st_dir
        if [ -z "$st_dir" ]; then
            warn "跳过 ST 扩展链接"
            echo ""
            echo "  后续可手动创建链接："
            dim "  ln -s $gateway_dir <ST路径>/public/scripts/extensions/third-party/$ext_name"
            echo ""
            return 0
        fi
        if [ ! -d "$st_dir/public/scripts/extensions/third-party" ]; then
            error "路径不像 SillyTavern: $st_dir"
            dim "  应包含 public/scripts/extensions/third-party/ 子目录"
            echo ""
            echo "  后续可手动创建链接："
            dim "  ln -s $gateway_dir $st_dir/public/scripts/extensions/third-party/$ext_name"
            echo ""
            return 0
        fi
    fi

    local third_party_dir="$st_dir/public/scripts/extensions/third-party"
    local link_target="$third_party_dir/$ext_name"

    success "找到 SillyTavern: $st_dir"

    # 如果已经是链接或目录，检查是否指向正确
    if [ -L "$link_target" ] || [ -d "$link_target" ]; then
        local current_target=""
        if [ -L "$link_target" ]; then
            current_target="$(readlink -f "$link_target" 2>/dev/null || readlink "$link_target" 2>/dev/null || echo "")"
        fi
        if [ "$current_target" = "$gateway_dir" ] || [ "$(cd "$link_target" && pwd 2>/dev/null)" = "$gateway_dir" ]; then
            info "扩展链接已存在且指向正确，跳过"
            return 0
        fi
        warn "$link_target 已存在"
        printf "是否覆盖？(y/n) [n]: "
        local r; read -r r
        if [ "$r" != "y" ] && [ "$r" != "Y" ]; then
            info "跳过链接创建"
            return 0
        fi
        rm -rf "$link_target" 2>/dev/null || true
    fi

    # 创建软链接（或 Windows Junction）
    info "创建扩展链接: $link_target -> $gateway_dir"
    ln -s "$gateway_dir" "$link_target" 2>/dev/null
    if [ $? -eq 0 ]; then
        success "扩展链接已创建"
        dim "  重启 SillyTavern 或刷新浏览器后，面板将出现在顶部设置栏"
    else
        # Windows Git Bash 可能不支持 ln -s，提示手动操作
        warn "软链接创建失败（可能是权限不足或系统不支持）"
        echo ""
        echo "  请手动创建链接："
        if [ "$OS_TYPE" = "windows-wsl" ] || [ "$OS_TYPE" = "windows-gitbash" ]; then
            dim "  PowerShell (管理员):"
            dim "  New-Item -ItemType Junction -Path \"$link_target\" -Target \"$(echo "$gateway_dir" | sed 's|/mnt/c|C:|; s|/mnt/d|D:|')\""
            dim "  或 CMD (管理员):"
            dim "  mklink /J \"$link_target\" \"$(echo "$gateway_dir" | sed 's|/mnt/c|C:|; s|/mnt/d|D:|')\""
        else
            dim "  ln -s $gateway_dir $link_target"
        fi
        echo ""
        echo "  或直接把仓库 clone 到 ST 扩展目录："
        dim "  cd $third_party_dir && git clone $GATEWAY_REPO $ext_name"
    fi
    log_action "INFO" "ST 扩展链接: $link_target -> $gateway_dir"
    echo ""
}

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
        rp_spin "正在克隆仓库" git clone "$GATEWAY_REPO" "$dest" || { error "git clone 失败"; return 1; }
    fi

    cd "$dest"
    INSTALL_DIR="$dest"
    CONFIG_DIR="$dest/config"
    LOG_DIR="$dest/logs"
    DATA_DIR="$dest/data"
    PLUGINS_DIR="$dest/plugins"
    PID_FILE="$CONFIG_DIR/gateway.pid"

    rp_spin "正在安装依赖" npm install || { error "npm install 失败"; return 1; }

    # ── SillyTavern 扩展目录链接 ──
    # 前端扩展必须在 ST 的 third-party 目录才能被加载
    link_to_st_extensions "$dest"

    # 保存环境文件（路径记忆）
    save_env

    # ── 先写入最小 .env（仅时区），启动网关以生成鉴权 Token ──
    echo "TZ=Asia/Shanghai" > "$INSTALL_DIR/.env"

    info "首次启动网关..."
    start_gateway

    # 安装后把管理脚本复制到用户目录，方便日常使用
    local manager_link="$HOME/gateway-manager.sh"
    cp "$INSTALL_DIR/scripts/gateway-manager.sh" "$manager_link" 2>/dev/null && chmod +x "$manager_link"

    # ── 获取并显示鉴权 Token，引导用户填入 SillyTavern ──
    local token=""
    token="$(get_auth_token_retry 15)"
    echo ""
    printf "  ${C_PRI}╔════════════════════════════════════════════════════╗${C_RESET}\n"
    printf "  ${C_PRI}║${C_RESET}   ${C_BOLD}${C_SEC}◆ 鉴权 Token 获取与配置引导${C_RESET}\n"
    printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"
    echo ""
    if [ -n "$token" ]; then
        printf "  ${C_BOLD}${C_ACC}鉴权 Token:${C_RESET} %s\n" "$token"
        echo ""
        echo "  ┌─────────────────────────────────────────────────────┐"
        echo "  │  请按以下步骤将 Token 填入 SillyTavern:               │"
        echo "  │                                                      │"
        echo "  │  1. 打开 SillyTavern 浏览器页面                        │"
        echo "  │  2. 点击拼图图标 🧩 打开扩展面板                        │"
        echo "  │  3. 找到「Multi-Platform Gateway」并勾选启用            │"
        echo "  │  4. 顶部设置栏会出现网关图标，点击打开面板               │"
        printf "  │  5. 网关地址填: http://localhost:%-19s│\n" "$PORT"
        echo "  │  6. 鉴权 Token 填入上方显示的 Token                     │"
        echo "  │  7. 点击「连接」按钮                                    │"
        echo "  │                                                      │"
        echo "  │  ⚠ Token 是网关访问凭证，请勿泄露给他人                 │"
        echo "  └─────────────────────────────────────────────────────┘"
        echo ""
        warn "请现在完成上述操作，确认 Token 已填入 SillyTavern 后继续"
        echo ""
        printf "  已完成 Token 配置？(y)继续 / (n)跳过后续平台配置 [y]: "
        local confirmed; read -r confirmed
        confirmed="${confirmed:-y}"
        if [ "$confirmed" != "y" ] && [ "$confirmed" != "Y" ]; then
            echo ""
            info "跳过平台适配器配置，稍后可通过管理菜单配置"
            dim "  运行 ~/gateway-manager.sh → 选 9) 平台"
        fi
    else
        warn "未能自动获取 Token（网关可能需要更多时间启动）"
        echo ""
        dim "  手动获取 Token 的方式:"
        dim "    cd $dest && node scripts/show-token.js"
        dim "    或运行: ~/gateway-manager.sh token"
        dim "    或查看: $CONFIG_DIR/gateway.json 中 server.authToken"
        echo ""
        printf "  是否继续进行平台适配器配置？(y/n) [y]: "
        local cont; read -r cont
        cont="${cont:-y}"
        if [ "$cont" != "y" ] && [ "$cont" != "Y" ]; then
            confirmed="n"
        else
            confirmed="y"
        fi
    fi

    # ── 用户确认后，进行平台适配器和推理管线配置 ──
    if [ "${confirmed:-y}" = "y" ] || [ "${confirmed:-Y}" = "Y" ]; then
        guided_config

        # 如果有平台配置变更，重启网关使配置生效
        info "重启网关以加载平台配置..."
        restart_gateway || true
    fi

    # ── 安装完成总结 ──
    echo ""
    success "安装完成！"
    echo ""
    echo "  ┌─────────────────────────────────────────────┐"
    echo "  │  后续管理命令:                                │"
    echo "  │  ~/gateway-manager.sh          交互式菜单      │"
    echo "  │  ~/gateway-manager.sh status   查看状态       │"
    echo "  │  ~/gateway-manager.sh token    获取Token      │"
    echo "  │  ~/gateway-manager.sh restart  重启网关       │"
    echo "  │  ~/gateway-manager.sh --help   查看所有命令    │"
    echo "  └─────────────────────────────────────────────┘"
    echo ""
    dim "  网关面板: http://localhost:${PORT}"
    dim "  安装目录: $dest"
    dim "  管理脚本: $manager_link"
    echo ""
    dim "  在 SillyTavern 中: 扩展 -> 找到 Multi-Platform Gateway -> 勾选启用"
    dim "  顶部设置栏点击网关图标 -> 填入 http://localhost:${PORT} + Token"
    dim "  如果面板没出现: 确认扩展已链接到 ST 的 third-party/ 目录（安装时自动处理）"
    log_action "INFO" "安装完成到 $dest"
}

guided_config() {
    [ -z "${INSTALL_DIR:-}" ] && return 1
    local env_file="$INSTALL_DIR/.env"
    echo ""
    info "平台适配器配置 -- 按需启用，留空跳过"
    echo ""

    # 注意：TZ 已在启动网关前写入 .env，这里只追加平台配置

    # Telegram
    printf "启用 Telegram？(y/n) [n]: "
    local r; read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_TELEGRAM_ENABLED true "$env_file"
        printf "Telegram Bot Token: "; read -r token
        env_set_val GATEWAY_TELEGRAM_BOT_TOKEN "$token" "$env_file"
        success "Telegram 已配置"
    fi

    # QQ (OneBot)
    printf "启用 QQ (OneBot/NapCat)？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_QQ_ENABLED true "$env_file"
        printf "NapCat WS 地址 [ws://127.0.0.1:8080]: "; read -r ws
        ws="${ws:-ws://127.0.0.1:8080}"
        env_set_val GATEWAY_QQ_WS_URL "$ws" "$env_file"
        success "QQ 已配置"
    fi

    # Discord
    printf "启用 Discord？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_DISCORD_ENABLED true "$env_file"
        printf "Discord Bot Token: "; read -r token
        env_set_val GATEWAY_DISCORD_BOT_TOKEN "$token" "$env_file"
        success "Discord 已配置"
    fi

    # 飞书
    printf "启用飞书？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_FEISHU_ENABLED true "$env_file"
        printf "飞书 App ID: "; read -r feishu_appid
        env_set_val GATEWAY_FEISHU_APP_ID "$feishu_appid" "$env_file"
        printf "飞书 App Secret: "; read -r feishu_secret
        env_set_val GATEWAY_FEISHU_APP_SECRET "$feishu_secret" "$env_file"
        success "飞书已配置"
    fi

    # 钉钉
    printf "启用钉钉？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_DINGTALK_ENABLED true "$env_file"
        printf "钉钉 ClientId (AppKey): "; read -r dt_clientid
        env_set_val GATEWAY_DINGTALK_CLIENT_ID "$dt_clientid" "$env_file"
        printf "钉钉 ClientSecret (AppSecret): "; read -r dt_secret
        env_set_val GATEWAY_DINGTALK_CLIENT_SECRET "$dt_secret" "$env_file"
        success "钉钉已配置"
    fi

    # QQ官方
    printf "启用 QQ官方机器人？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_QQOFFICIAL_ENABLED true "$env_file"
        printf "QQ官方 AppID: "; read -r qqo_appid
        env_set_val GATEWAY_QQOFFICIAL_APP_ID "$qqo_appid" "$env_file"
        printf "QQ官方 AppSecret: "; read -r qqo_secret
        env_set_val GATEWAY_QQOFFICIAL_SECRET "$qqo_secret" "$env_file"
        success "QQ官方已配置"
    fi

    # 自建推理管线
    printf "启用自建推理管线（不依赖 ST 前端）？(y/n) [n]: "
    read -r r
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        env_set_val GATEWAY_RUNTIME_ENABLED true "$env_file"
        printf "LLM Provider [openai]: "; read -r provider
        provider="${provider:-openai}"
        env_set_val GATEWAY_LLM_PROVIDER "$provider" "$env_file"
        printf "API Key: "; read -r key
        env_set_val GATEWAY_LLM_API_KEY "$key" "$env_file"
        printf "模型 [gpt-4o-mini]: "; read -r model
        model="${model:-gpt-4o-mini}"
        env_set_val GATEWAY_LLM_MODEL "$model" "$env_file"
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

    # 备份（backup_config 始终返回 0，不会触发 set -e 退出）
    backup_config

    # 记录更新前 HEAD（用于回滚）
    git rev-parse HEAD > "$CONFIG_DIR/.pre-update-head" 2>/dev/null || true

    # 记录更新前的脚本路径和自身哈希，用于判断脚本是否被更新
    local self_path="$0"
    local self_hash_before=""
    if [ -f "$self_path" ]; then
        self_hash_before="$(md5sum "$self_path" 2>/dev/null | cut -d' ' -f1 || echo '')"
    fi

    # 更新
    rp_spin "正在拉取代码" git pull || { error "git pull 失败"; return 1; }
    rp_spin "正在安装依赖" npm install || { error "npm install 失败"; return 1; }

    # 如运行中则重启
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
        info "网关运行中，正在重启..."
        restart_gateway || true
    fi

    # 同步更新用户目录下的管理脚本副本
    local home_manager="$HOME/gateway-manager.sh"
    if [ -f "$INSTALL_DIR/scripts/gateway-manager.sh" ] && [ -f "$home_manager" ]; then
        cp "$INSTALL_DIR/scripts/gateway-manager.sh" "$home_manager" 2>/dev/null && chmod +x "$home_manager" || true
        dim "  已同步管理脚本到 $home_manager"
    fi

    success "更新完成"
    log_action "INFO" "网关已更新到 $(git rev-parse --short HEAD)"

    # 检查脚本自身是否被更新，若是则提示并自动重启脚本
    local self_hash_after=""
    if [ -f "$self_path" ]; then
        self_hash_after="$(md5sum "$self_path" 2>/dev/null | cut -d' ' -f1 || echo '')"
    fi
    if [ -n "$self_hash_before" ] && [ -n "$self_hash_after" ] && [ "$self_hash_before" != "$self_hash_after" ]; then
        echo ""
        warn "管理脚本自身已更新，正在重新启动脚本以加载新版本..."
        echo ""
        # 用 exec 替换当前进程，加载新版脚本
        # ${CLI_ARGS[@]+"${CLI_ARGS[@]}"} 兼容 set -u 下的空数组
        exec "$self_path" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}
    fi
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

# systemd 委托：服务器环境优先用 systemd 管理网关，避免 nohup 实例与 systemd
# 服务抢端口（历史故障：两者并存导致端口冲突、systemd 反复重启失败）。
# 无 systemd 的环境（如 Termux）仍走下方 nohup + PID 文件逻辑。

# 检测已安装的网关 systemd 服务名。兼容 sillytavern-gateway（实际服务名）与
# gateway（generate_systemd_unit 生成的默认名）。命中则设置 SYSTEMD_SERVICE_NAME 并返回 0。
SYSTEMD_SERVICE_NAME=""
detect_systemd_service() {
    [ "$OS_TYPE" = "termux" ] && return 1
    command -v systemctl >/dev/null 2>&1 || return 1
    local name
    for name in sillytavern-gateway gateway; do
        if systemctl cat -- "${name}.service" >/dev/null 2>&1; then
            SYSTEMD_SERVICE_NAME="$name"
            return 0
        fi
    done
    return 1
}

# 用 systemd 执行 start/stop/restart/status。已委托返回 0；无 systemd 服务返回 1
# （调用方据此回退到 nohup 逻辑）。检测到 systemd 服务后不再回退--失败要暴露而非悄悄 nohup。
try_systemd() {
    local action="$1"
    detect_systemd_service || return 1
    info "检测到 systemd 服务: $SYSTEMD_SERVICE_NAME，委托 systemctl $action"
    if [ "$action" = "status" ]; then
        systemctl status "$SYSTEMD_SERVICE_NAME" --no-pager 2>/dev/null || true
        return 0
    fi
    if [ "$(id -u)" -eq 0 ]; then
        systemctl "$action" "$SYSTEMD_SERVICE_NAME"
    else
        sudo systemctl "$action" "$SYSTEMD_SERVICE_NAME"
    fi
    return 0
}

start_gateway() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    cd "$INSTALL_DIR"

    # 依赖检查：确保 node_modules 存在且 dotenv 可用
    # （更新代码后可能新增了依赖，但用户还没跑 npm install）
    if [ ! -d "node_modules/dotenv" ]; then
        info "检测到缺失依赖，自动安装..."
        npm install 2>/dev/null || { warn "npm install 失败，部分功能可能不可用"; }
    fi

    # 检测是否已运行
    if [ -f "$PID_FILE" ]; then
        local pid
        pid="$(cat "$PID_FILE" 2>/dev/null)"
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            warn "网关已在运行 (PID: $pid)"
            return 0
        fi
    fi

    # 端口检测：系统级别
    if ! is_port_free "$PORT"; then
        # 端口被占 -- 是不是我们自己的进程在监听？
        local code
        code="$(check_port)"
        if [ "$code" != "000" ] && [ "$code" != "" ]; then
            # HTTP 有响应 -- 可能是之前的网关或别的服务
            warn "端口 ${PORT} 已被占用"
            dim "  检查是否已有网关进程: ps aux | grep server/index.js"
            dim "  或手动指定端口: 修改 .env 中的 GATEWAY_PORT"
        else
            # 被占但不是 HTTP -- 是别的程序
            warn "端口 ${PORT} 被其他程序占用"
        fi
        # 自动找空闲端口
        local new_port
        new_port="$(find_port $((PORT + 1)))"
        if [ -n "$new_port" ] && [ "$new_port" != "$PORT" ]; then
            info "自动切换到备用端口: $new_port"
            PORT="$new_port"
            # 写入 .env 让网关也用这个端口
            if [ -f "$INSTALL_DIR/.env" ]; then
                sed_inplace "/^GATEWAY_PORT=/d" "$INSTALL_DIR/.env"
                echo "GATEWAY_PORT=$PORT" >> "$INSTALL_DIR/.env"
            else
                echo "GATEWAY_PORT=$PORT" > "$INSTALL_DIR/.env"
            fi
            save_env  # 更新环境文件中的端口
        else
            error "无法找到可用端口"
            return 1
        fi
    fi

    mkdir -p "$LOG_DIR" "$CONFIG_DIR"

    info "启动网关 (端口: $PORT)..."
    nohup node server/index.js > "$LOG_DIR/gateway-stdout.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Termux 唤醒锁
    if [ "$OS_TYPE" = "termux" ] && command -v termux-wake-lock &>/dev/null; then
        termux-wake-lock 2>/dev/null || true
        info "已获取 Termux 唤醒锁"
    fi

    # 等待启动（带旋转动画）
    printf "  ${C_SEC}⠿${C_RESET} ${C_SEC}等待启动${C_RESET}..."
    local i=0
    local -a spin_chars=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local si=0
    while [ $i -lt 15 ]; do
        printf "\r  ${C_SEC}%s${C_RESET} ${C_SEC}等待启动${C_RESET}... ${C_DIM}(%d/15s)${C_RESET}" "${spin_chars[$((si % 10))]}" "$((i + 1))"
        si=$((si + 1))
        sleep 1
        local c
        c="$(check_port)"
        if [ "$c" != "000" ] && [ "$c" != "" ]; then
            printf "\r\033[K"
            success "网关已启动 (PID: $pid, 端口: $PORT)"
            save_env
            log_action "INFO" "网关启动 PID=$pid 端口=$PORT"
            return 0
        fi
        # 检查进程是否还活着
        if ! kill -0 "$pid" 2>/dev/null; then
            printf "\r\033[K"
            error "网关启动失败，进程已退出"
            dim "  查看日志: $LOG_DIR/gateway-stdout.log"
            rm -f "$PID_FILE"
            return 1
        fi
        i=$((i + 1))
    done
    printf "\r\033[K"

    warn "启动超时（15秒），网关可能仍在初始化中"
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
    # 等待端口释放（最多 8 秒）
    local i=0
    while [ $i -lt 8 ]; do
        if is_port_free "$PORT"; then
            break
        fi
        sleep 1
        i=$((i + 1))
    done
    if [ $i -ge 8 ]; then
        warn "端口 $PORT 仍未释放，尝试强制释放..."
        # 尝试杀掉残留进程
        local stale_pid
        stale_pid="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || echo "")"
        [ -n "$stale_pid" ] && kill -9 "$stale_pid" 2>/dev/null || true
        sleep 1
    fi
    start_gateway || { error "重启失败：网关启动失败"; return 1; }
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
    printf "  ${C_PRI}╔════════════════════════════════════════════════════╗${C_RESET}\n"
    printf "  ${C_PRI}║${C_RESET}   ${C_BOLD}${C_SEC}◆ SillyTavern Gateway 状态${C_RESET}\n"
    printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"

    if $running; then
        printf "  ${C_PRI}║${C_RESET}  状态: ${C_BOLD}${C_OK}● 运行中${C_RESET}  ${C_DIM}PID %s${C_RESET}\n" "$pid"
        # 运行时长
        local uptime=""
        if [ "$OS_TYPE" = "macos" ] || [ "$OS_TYPE" = "linux" ] || [ "$OS_TYPE" = "termux" ]; then
            local elapsed
            elapsed="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")"
            printf "  ${C_PRI}║${C_RESET}  ${C_DIM}运行时长:${C_RESET} ${C_SEC}%s${C_RESET}\n" "$elapsed"
        fi
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}端口:${C_RESET} ${C_ACC}%s${C_RESET}\n" "$PORT"
        # 版本
        local ver=""
        [ -f "$INSTALL_DIR/package.json" ] && ver="$(json_get "$INSTALL_DIR/package.json" "version")"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}版本:${C_RESET} ${C_SEC}%s${C_RESET}\n" "${ver:-未知}"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}目录:${C_RESET} ${C_DIM}%s${C_RESET}\n" "$INSTALL_DIR"

        # 平台连接状态
        local api_resp
        api_resp="$(api_call GET /api/gateway/status 2>/dev/null || echo "")"
        if [ -n "$api_resp" ] && [ "$api_resp" != "" ]; then
            printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"
            printf "  ${C_PRI}║${C_RESET}  ${C_ACC}◈ 平台连接状态${C_RESET}:\n"
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
                            const col=a.connected?'\x1b[38;5;42m':'\x1b[38;5;196m';
                            console.log('  \x1b[38;5;99m║\x1b[0m    '+name+': '+col+st+'\x1b[0m ('+en+')');
                        }
                    }catch{}
                });
            " 2>/dev/null || true
        fi
    else
        printf "  ${C_PRI}║${C_RESET}  状态: ${C_BOLD}${C_ERR}● 已停止${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}端口:${C_RESET} ${C_ACC}%s${C_RESET}\n" "$PORT"
        local ver=""
        [ -f "$INSTALL_DIR/package.json" ] && ver="$(json_get "$INSTALL_DIR/package.json" "version")"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}版本:${C_RESET} ${C_SEC}%s${C_RESET}\n" "${ver:-未知}"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}目录:${C_RESET} ${C_DIM}%s${C_RESET}\n" "$INSTALL_DIR"
    fi
    printf "  ${C_PRI}╚════════════════════════════════════════════════════╝${C_RESET}\n"
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
# 可选适配器管理（钉钉 / 飞书 / QQ官方）
# 这三个平台的 SDK 在 optionalDependencies 中，
# 默认 npm install 会装上，但某些环境（--no-optional）会跳过。
# ═══════════════════════════════════════════════════════════

# 可选适配器列表（所有支持的可选平台）
OPT_ADAPTER_PLATFORMS=("feishu" "dingtalk" "qqofficial")

# 获取适配器的 npm 包名（兼容 bash 3.x，不用关联数组）
get_adapter_pkg() {
    case "$1" in
        feishu)     echo "@larksuiteoapi/node-sdk" ;;
        dingtalk)   echo "dingtalk-stream" ;;
        qqofficial) echo "qq-official-bot" ;;
        *)          echo "" ;;
    esac
}

# 获取适配器的中文名
get_adapter_name() {
    case "$1" in
        feishu)     echo "飞书" ;;
        dingtalk)   echo "钉钉" ;;
        qqofficial) echo "QQ官方" ;;
        *)          echo "" ;;
    esac
}

# 检查某个可选适配器 SDK 是否已安装
# 用法: check_adapter_installed <platform>
# 返回: 0=已安装, 1=未安装
check_adapter_installed() {
    local platform="$1"
    local pkg
    pkg="$(get_adapter_pkg "$platform")"
    [ -z "$pkg" ] && return 1
    [ -z "${INSTALL_DIR:-}" ] && return 1
    # 检查 node_modules 目录是否存在该包
    local check_path="$INSTALL_DIR/node_modules/$pkg"
    [ -f "$check_path/package.json" ] && return 0
    # 兜底：尝试用 node 检测（兼容 symlink / pnpm 等结构）
    (cd "$INSTALL_DIR" && node -e "
        try { require.resolve('$pkg'); process.exit(0); }
        catch { process.exit(1); }
    " 2>/dev/null) && return 0
    return 1
}

# 扫描所有可选适配器，输出安装状态
# 用法: scan_optional_adapters  →  在 stdout 输出 "platform|pkg|name|installed(0/1)" 每行一个
scan_optional_adapters() {
    for p in "${OPT_ADAPTER_PLATFORMS[@]}"; do
        local pkg name
        pkg="$(get_adapter_pkg "$p")"
        name="$(get_adapter_name "$p")"
        local installed=1
        if check_adapter_installed "$p"; then installed=0; fi
        echo "${p}|${pkg}|${name}|${installed}"
    done
}

# 安装某个可选适配器 SDK（带进度提示与状态反馈）
# 用法: install_adapter <platform>
install_adapter() {
    local platform="$1"
    local pkg name
    pkg="$(get_adapter_pkg "$platform")"
    name="$(get_adapter_name "$platform")"
    [ -z "$pkg" ] && { error "未知平台: $platform"; return 1; }
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }

    echo ""
    info "安装 ${name} 适配器 SDK: $pkg"
    echo ""

    # 进度提示：步骤标记
    local step=1 total=3
    printf "  [%d/%d] 检查当前安装状态...\n" "$step" "$total"
    if check_adapter_installed "$platform"; then
        success "  → ${name} SDK 已安装，无需重复安装"
        return 0
    fi
    dim "  → 未安装，开始安装"
    step=$((step + 1))

    # 执行 npm install
    printf "  [%d/%d] 正在通过 npm 安装 %s...\n" "$step" "$total" "$pkg"
    dim "  → npm install $pkg （这可能需要几十秒，请耐心等待）"
    echo ""
    cd "$INSTALL_DIR"
    # 用 stderr 显示进度，stdout 捕获结果
    local npm_output npm_exit
    npm_output="$(npm install "$pkg" 2>&1)" && npm_exit=0 || npm_exit=$?

    step=$((step + 1))
    if [ "$npm_exit" -ne 0 ]; then
        printf "  [%d/%d] 安装失败\n" "$step" "$total"
        echo ""
        error "${name} 适配器 SDK 安装失败 (exit code: $npm_exit)"
        dim "  npm 输出（最后 10 行）:"
        echo "$npm_output" | tail -10 | while IFS= read -r line; do
            printf "    %s\n" "$line"
        done
        echo ""
        warn "  排查建议:"
        dim "  - 检查网络连接是否正常"
        dim "  - 尝试切换 npm 源: npm config set registry https://registry.npmmirror.com"
        dim "  - 手动安装: cd $INSTALL_DIR && npm install $pkg"
        log_action "ERROR" "安装适配器 $platform ($pkg) 失败"
        return 1
    fi

    # 验证安装
    if check_adapter_installed "$platform"; then
        printf "  [%d/%d] 安装成功，已验证\n" "$step" "$total"
        echo ""
        success "${name} 适配器 SDK 安装成功！"
        echo ""
        info "后续步骤:"
        dim "  1. 在平台管理中配置 ${name} 的凭据（App ID / Secret 等）"
        dim "  2. 启用 ${name} 平台"
        dim "  3. 重启网关使适配器生效"
        log_action "INFO" "安装适配器 $platform ($pkg) 成功"
        return 0
    else
        printf "  [%d/%d] 安装后验证失败\n" "$step" "$total"
        echo ""
        error "${name} SDK 安装命令执行完毕，但未检测到包目录"
        dim "  可能是 npm 使用了非标准结构（如 pnpm），请手动验证:"
        dim "  cd $INSTALL_DIR && node -e \"require.resolve('$pkg')\""
        return 1
    fi
}

# 一键安装所有未安装的可选适配器
install_all_missing_adapters() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }
    echo ""
    info "扫描未安装的可选适配器..."
    echo ""

    local missing=()
    for p in "${OPT_ADAPTER_PLATFORMS[@]}"; do
        local name
        name="$(get_adapter_name "$p")"
        if ! check_adapter_installed "$p"; then
            missing+=("$p")
            printf "  ❌ %s (%s) - 未安装\n" "$name" "$p"
        else
            printf "  ✅ %s (%s) - 已安装\n" "$name" "$p"
        fi
    done

    echo ""
    if [ ${#missing[@]} -eq 0 ]; then
        success "所有官方平台适配器均已安装"
        return 0
    fi

    warn "检测到 ${#missing[@]} 个未安装的适配器"
    printf "是否全部安装？(y/n) [y]: "
    local r; read -r r
    r="${r:-y}"
    if [ "$r" != "y" ] && [ "$r" != "Y" ]; then
        info "已取消"
        return 0
    fi

    echo ""
    local ok=0 fail=0
    for p in "${missing[@]}"; do
        if install_adapter "$p"; then
            ok=$((ok + 1))
        else
            fail=$((fail + 1))
        fi
        echo ""
    done

    echo ""
    info "批量安装完成: 成功 $ok 个, 失败 $fail 个"
    if [ "$fail" -gt 0 ]; then
        warn "有 $fail 个适配器安装失败，请查看上方错误信息"
    fi
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

        # ── 可选适配器 SDK 安装状态扫描 ──
        echo ""
        echo "  ── 官方平台适配器 SDK 状态 ──"
        local has_missing=false
        for p in "${OPT_ADAPTER_PLATFORMS[@]}"; do
            local name pkg
            name="$(get_adapter_name "$p")"
            pkg="$(get_adapter_pkg "$p")"
            if check_adapter_installed "$p"; then
                printf "  ✅ %-10s 已安装  (%s)\n" "$name" "$pkg"
            else
                printf "  ❌ %-10s 未安装  (%s)  [可用: 安装]\n" "$name" "$pkg"
                has_missing=true
            fi
        done
        echo ""

        echo "  1) 配置 Telegram"
        echo "  2) 配置 QQ (OneBot)"
        echo "  3) 配置 Discord"
        echo "  4) 配置飞书"
        echo "  5) 配置 QQ官方"
        echo "  6) 配置钉钉"
        echo "  7) 重连已断开平台"
        if [ "$has_missing" = "true" ]; then
            echo "  ── 适配器安装 ──"
            echo "  i) 安装飞书适配器"
            echo "  j) 安装钉钉适配器"
            echo "  k) 安装QQ官方适配器"
            echo "  a) 一键安装所有未安装适配器"
        fi
        echo "  q) 返回"
        printf "选择: "
        local choice; read -r choice
        case "$choice" in
            1) config_platform "telegram" "GATEWAY_TELEGRAM" ;;
            2) config_platform "qq" "GATEWAY_QQ" ;;
            3) config_platform "discord" "GATEWAY_DISCORD" ;;
            4) config_platform "feishu" "GATEWAY_FEISHU" ;;
            5) config_platform "qqofficial" "GATEWAY_QQOFFICIAL" ;;
            6) config_platform "dingtalk" "GATEWAY_DINGTALK" ;;
            7) reconnect_platforms ;;
            i|I) install_adapter "feishu" ;;
            j|J) install_adapter "dingtalk" ;;
            k|K) install_adapter "qqofficial" ;;
            a|A) install_all_missing_adapters ;;
            q|Q) break ;;
            *) warn "无效选择" ;;
        esac
    done
}

config_platform() {
    local platform="$1" env_prefix="$2"
    local env_file="$INSTALL_DIR/.env"

    printf "启用 $platform？(y/n): "
    local r; read -r r
    if [ "$r" != "y" ] && [ "$r" != "Y" ]; then
        info "跳过 $platform"
        return 0
    fi

    env_set_val "${env_prefix}_ENABLED" true "$env_file"

    # 根据平台提示输入对应凭据
    case "$platform" in
        telegram)
            printf "请输入 Bot Token: "; local v; read -r v
            [ -n "$v" ] && env_set_val "${env_prefix}_BOT_TOKEN" "$v" "$env_file"
            ;;
        qq)
            printf "请输入 NapCat WS 地址 [ws://127.0.0.1:8080]: "; local v; read -r v
            v="${v:-ws://127.0.0.1:8080}"
            env_set_val "${env_prefix}_WS_URL" "$v" "$env_file"
            printf "请输入 OneBot Access Token (可留空): "; local t; read -r t
            [ -n "$t" ] && env_set_val "${env_prefix}_ACCESS_TOKEN" "$t" "$env_file"
            ;;
        discord)
            printf "请输入 Bot Token: "; local v; read -r v
            [ -n "$v" ] && env_set_val "${env_prefix}_BOT_TOKEN" "$v" "$env_file"
            ;;
        feishu)
            printf "请输入飞书 App ID: "; local v; read -r v
            [ -n "$v" ] && env_set_val "${env_prefix}_APP_ID" "$v" "$env_file"
            printf "请输入飞书 App Secret: "; local s; read -r s
            [ -n "$s" ] && env_set_val "${env_prefix}_APP_SECRET" "$s" "$env_file"
            ;;
        qqofficial)
            printf "请输入 QQ官方 AppID: "; local v; read -r v
            [ -n "$v" ] && env_set_val "${env_prefix}_APP_ID" "$v" "$env_file"
            printf "请输入 QQ官方 AppSecret: "; local s; read -r s
            [ -n "$s" ] && env_set_val "${env_prefix}_SECRET" "$s" "$env_file"
            printf "请输入 QQ官方 Token (可留空): "; local t; read -r t
            [ -n "$t" ] && env_set_val "${env_prefix}_TOKEN" "$t" "$env_file"
            ;;
        dingtalk)
            printf "请输入钉钉 ClientId (AppKey): "; local v; read -r v
            [ -n "$v" ] && env_set_val "${env_prefix}_CLIENT_ID" "$v" "$env_file"
            printf "请输入钉钉 ClientSecret (AppSecret): "; local s; read -r s
            [ -n "$s" ] && env_set_val "${env_prefix}_CLIENT_SECRET" "$s" "$env_file"
            ;;
    esac

    success "$platform 配置已写入 .env，重启网关后生效"
    log_action "INFO" "配置平台 $platform"
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

# 检测系统可用的终端文本编辑器
# 优先级: $EDITOR > nano > vim > vi > micro > emacs > notepad
# 返回: 编辑器命令字符串（stdout）, 失败返回非0
detect_editor() {
    # 1. 环境变量 EDITOR（可能带参数如 "code -w"）
    if [ -n "${EDITOR:-}" ]; then
        local ed_bin="${EDITOR%% *}"
        if command -v "$ed_bin" &>/dev/null; then
            echo "$EDITOR"
            return 0
        fi
    fi
    # 2. 按优先级检测常见编辑器
    local editors=("nano" "vim" "vi" "micro" "emacs")
    for ed in "${editors[@]}"; do
        if command -v "$ed" &>/dev/null; then
            echo "$ed"
            return 0
        fi
    done
    # 3. Windows: notepad（Git Bash 环境）
    if [ "$OS_TYPE" = "windows-gitbash" ] || [ "$OS_TYPE" = "windows-wsl" ]; then
        if command -v notepad &>/dev/null; then
            echo "notepad"
            return 0
        fi
    fi
    return 1
}

# 显示编辑器操作提示（根据编辑器类型显示对应快捷键）
# 用法: show_editor_tips <editor_command>
show_editor_tips() {
    local editor="$1"
    local editor_name
    editor_name="$(basename "${editor%% *}")"

    echo ""
    echo "  ┌──────────────────────────────────────────────────────────┐"
    echo "  │              编辑器操作快捷键速查                         │"
    echo "  ├──────────────────────────────────────────────────────────┤"

    case "$editor_name" in
        nano)
            echo "  │  编辑器: nano                                             │"
            echo "  │                                                          │"
            echo "  │  保存并退出:  Ctrl+O → Enter → Ctrl+X                    │"
            echo "  │               （或直接 Ctrl+X → Y → Enter）               │"
            echo "  │  放弃编辑:    Ctrl+X → N （不保存退出）                   │"
            echo "  │  查找:        Ctrl+W → 输入内容 → Enter                   │"
            echo "  │               （继续找下一个: 再次 Ctrl+W → Enter）        │"
            echo "  │  替换:        Ctrl+\ → 输入查找内容 → Enter               │"
            echo "  │                    → 输入替换内容 → Enter                 │"
            echo "  │                    → Y 替换 / A 全部替换 / N 跳过         │"
            echo "  │                                                          │"
            echo "  │  基本导航:                                               │"
            echo "  │    方向键 ↑↓←→ 移动光标                                   │"
            echo "  │    Ctrl+Y / Ctrl+V  上一页 / 下一页                        │"
            echo "  │    Ctrl+A / Ctrl+E  行首 / 行末                           │"
            echo "  │    Home / End       文件头 / 文件尾                       │"
            ;;
        vim|vi)
            echo "  │  编辑器: vim/vi                                           │"
            echo "  │                                                          │"
            echo "  │  保存并退出:  :wq → Enter  （或 :x → Enter）              │"
            echo "  │  放弃编辑:    :q! → Enter （强制不保存退出）              │"
            echo "  │  查找:        /关键词 → Enter                              │"
            echo "  │               （n 找下一个 / N 找上一个）                  │"
            echo "  │  替换:        :%s/旧/新/g → Enter （全文替换）            │"
            echo "  │               :%s/旧/新/gc → Enter （逐个确认）           │"
            echo "  │                                                          │"
            echo "  │  基本导航:                                               │"
            echo "  │    h/j/k/l  左/下/上/右 （或方向键）                      │"
            echo "  │    gg / G    文件头 / 文件尾                              │"
            echo "  │    Ctrl+f / Ctrl+b  下翻页 / 上翻页                       │"
            echo "  │    0 / $     行首 / 行末                                  │"
            echo "  │    按 i 进入插入模式, Esc 回到命令模式                     │"
            ;;
        micro)
            echo "  │  编辑器: micro                                             │"
            echo "  │                                                          │"
            echo "  │  保存并退出:  Ctrl+S → Ctrl+Q                            │"
            echo "  │  放弃编辑:    Ctrl+Q （有改动时会提示是否保存）            │"
            echo "  │  查找:        Ctrl+F → 输入内容 → Enter                   │"
            echo "  │  替换:        Ctrl+F → 输入查找 → Enter                   │"
            echo "  │                    → Tab 切到替换框 → 输入 → Enter        │"
            echo "  │                                                          │"
            echo "  │  基本导航:                                               │"
            echo "  │    方向键 ↑↓←→ 移动光标                                   │"
            echo "  │    PageUp / PageDown  翻页                                │"
            echo "  │    Ctrl+Home / Ctrl+End  文件头 / 文件尾                  │"
            ;;
        emacs)
            echo "  │  编辑器: emacs                                             │"
            echo "  │                                                          │"
            echo "  │  保存并退出:  Ctrl+X → Ctrl+S (保存) → Ctrl+X → Ctrl+C   │"
            echo "  │  放弃编辑:    Ctrl+X → Ctrl+C （有改动时选不保存）         │"
            echo "  │  查找:        Ctrl+S → 输入内容                           │"
            echo "  │  替换:        Alt+% → 输入查找 → Enter → 输入替换 → Enter │"
            echo "  │                                                          │"
            echo "  │  基本导航:                                               │"
            echo "  │    方向键 ↑↓←→ 移动光标                                   │"
            echo "  │    Ctrl+V / Alt+V  下翻页 / 上翻页                        │"
            echo "  │    Ctrl+A / Ctrl+E  行首 / 行末                           │"
            ;;
        notepad)
            echo "  │  编辑器: notepad (Windows 记事本)                         │"
            echo "  │                                                          │"
            echo "  │  保存并退出:  Ctrl+S → 关闭窗口 (点× 或 Alt+F4)          │"
            echo "  │  放弃编辑:    直接关闭窗口 → 选「不保存」                 │"
            echo "  │  查找:        Ctrl+F → 输入内容 → Enter                   │"
            echo "  │  替换:        Ctrl+H → 输入查找/替换 → 替换/全部替换      │"
            echo "  │                                                          │"
            echo "  │  基本导航:                                               │"
            echo "  │    方向键 ↑↓←→ 移动光标                                   │"
            echo "  │    PageUp / PageDown  翻页                                │"
            echo "  │    Ctrl+Home / Ctrl+End  文件头 / 文件尾                  │"
            ;;
        *)
            echo "  │  编辑器: $editor_name                                     │"
            echo "  │                                                          │"
            echo "  │  请参考该编辑器的文档了解操作快捷键。                      │"
            echo "  │  通用提示:                                               │"
            echo "  │    大多数编辑器用 Ctrl+S 保存, Esc 或 Ctrl+Q 退出         │"
            ;;
    esac

    echo "  └──────────────────────────────────────────────────────────┘"
    echo ""
}

# 用系统终端编辑器编辑文件
# 用法: edit_skill <file_path>
edit_skill() {
    local file="$1"
    [ -z "$file" ] && { error "未指定文件"; return 1; }
    [ -f "$file" ] || { error "文件不存在: $file"; return 1; }

    # 检测可用编辑器
    local editor
    editor="$(detect_editor)"
    if [ -z "$editor" ]; then
        error "未检测到可用的终端文本编辑器"
        echo ""
        warn "请安装 nano 或 vim，或设置 EDITOR 环境变量:"
        dim "  Debian/Ubuntu: sudo apt install nano"
        dim "  CentOS/RHEL:  sudo dnf install nano"
        dim "  macOS:         brew install nano"
        dim "  Termux:        pkg install nano"
        echo ""
        dim "  或设置环境变量: export EDITOR=nano"
        return 1
    fi

    # 显示操作提示
    echo ""
    info "即将用 ${editor} 编辑: $(basename "$file")"
    show_editor_tips "$editor"
    echo "  按 Enter 打开编辑器（编辑完成后关闭编辑器即可返回）..."
    read -r

    # 启动编辑器
    log_action "INFO" "编辑 skill: $file (编辑器: $editor)"
    # shellcheck disable=SC2086
    $editor "$file"
    local ed_exit=$?

    if [ "$ed_exit" -eq 0 ]; then
        echo ""
        success "编辑完成，已返回管理菜单"
    else
        echo ""
        warn "编辑器退出码: $ed_exit （文件可能已保存，请确认）"
    fi
    log_action "INFO" "编辑器退出: $file (exit=$ed_exit)"
}

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
        echo "  n) 新建 skill  e) 编辑  v) 查看  d) 删除  q) 返回"
        printf "选择: "
        local choice; read -r choice

        case "$choice" in
            n|N) create_skill ;;
            e|E)
                if [ ${#skills[@]} -eq 0 ]; then
                    warn "暂无 skill 文件，请先新建"
                else
                    printf "编号: "; local n; read -r n
                    if [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#skills[@]}" ]; then
                        local f="${skills[$((n - 1))]}"
                        edit_skill "$f"
                    else
                        warn "无效编号"
                    fi
                fi
                ;;
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
    log_action "INFO" "创建 skill $name ($type)"
    echo ""
    printf "是否立即编辑该文件？(y/n) [y]: "
    local r; read -r r
    r="${r:-y}"
    if [ "$r" = "y" ] || [ "$r" = "Y" ]; then
        edit_skill "$target_file"
    else
        dim "  后续编辑: 在 Skill 管理中选「e) 编辑」"
    fi
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
# 自建推理管线（Runtime）配置
# ═══════════════════════════════════════════════════════════

# 从 .env 读取指定变量值（精确匹配 KEY=value 行）
env_get_val() {
    local key="$1" file="${2:-$INSTALL_DIR/.env}"
    [ -f "$file" ] || return 0
    grep "^${key}=" "$file" 2>/dev/null | head -1 | cut -d'=' -f2- || echo ""
}

# 向 .env 写入或更新键值对（存在则替换，不存在则追加）
env_set_val() {
    local key="$1" val="$2" file="${3:-$INSTALL_DIR/.env}"
    [ -f "$file" ] || touch "$file"
    if grep -q "^${key}=" "$file" 2>/dev/null; then
        # macOS sed 不支持 -i 不带后缀，用临时文件替代
        local tmp
        tmp="$(mktemp 2>/dev/null || echo "/tmp/.env_tmp_$$")"
        sed "s|^${key}=.*|${key}=${val}|" "$file" > "$tmp" 2>/dev/null
        mv "$tmp" "$file"
    else
        echo "${key}=${val}" >> "$file"
    fi
}

# 从 .env 删除指定键
env_del_val() {
    local key="$1" file="${2:-$INSTALL_DIR/.env}"
    [ -f "$file" ] || return 0
    local tmp
    tmp="$(mktemp 2>/dev/null || echo "/tmp/.env_tmp_$$")"
    sed "/^${key}=/d" "$file" > "$tmp" 2>/dev/null
    mv "$tmp" "$file"
}

cmd_runtime() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }

    local env_file="$INSTALL_DIR/.env"
    [ -f "$env_file" ] || echo "TZ=Asia/Shanghai" > "$env_file"

    while true; do
        # 读取当前状态
        local rt_enabled
        rt_enabled="$(env_get_val GATEWAY_RUNTIME_ENABLED "$env_file")"
        local rt_status="未启用"
        [ "$rt_enabled" = "true" ] && rt_status="已启用"

        local llm_provider llm_model llm_apikey llm_baseurl
        llm_provider="$(env_get_val GATEWAY_LLM_PROVIDER "$env_file")"
        llm_model="$(env_get_val GATEWAY_LLM_MODEL "$env_file")"
        llm_apikey="$(env_get_val GATEWAY_LLM_API_KEY "$env_file")"
        llm_baseurl="$(env_get_val GATEWAY_LLM_BASE_URL "$env_file")"

        # 尝试从运行中网关获取实时状态
        local api_status=""
        local health
        health="$(check_port)"
        if [ "$health" = "200" ]; then
            local api_resp
            api_resp="$(api_call GET /api/runtime/status 2>/dev/null || echo "")"
            if echo "$api_resp" | grep -q '"enabled":true' 2>/dev/null; then
                api_status=" (网关运行中: 已生效)"
            elif echo "$api_resp" | grep -q '"enabled":false' 2>/dev/null; then
                api_status=" (网关运行中: 未生效，需重启)"
            fi
        fi

        echo ""
        printf "  ${C_PRI}╔══════════════════════════════════════╗${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}      ${C_BOLD}${C_SEC}◆ 自建推理管线配置${C_RESET}\n"
        printf "  ${C_PRI}╠══════════════════════════════════════╣${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}  状态: ${C_ACC}%s${C_RESET}${C_SEC}%s${C_RESET}\n" "$rt_status" "$api_status"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}LLM Provider:${C_RESET} ${C_SEC}%s${C_RESET}\n" "${llm_provider:-未设置}"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}LLM Model:${C_RESET}    ${C_SEC}%s${C_RESET}\n" "${llm_model:-未设置}"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}LLM Base URL:${C_RESET} ${C_SEC}%s${C_RESET}\n" "${llm_baseurl:-默认}"
        if [ -n "$llm_apikey" ]; then
            local masked_key="***${llm_apikey: -4}"
            printf "  ${C_PRI}║${C_RESET}  ${C_DIM}LLM API Key:${C_RESET}  ${C_SEC}%s${C_RESET}\n" "$masked_key"
        else
            printf "  ${C_PRI}║${C_RESET}  ${C_DIM}LLM API Key:${C_RESET}  ${C_WARN}未设置${C_RESET}\n"
        fi
        printf "  ${C_PRI}╠══════════════════════════════════════╣${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}1${C_RESET}) 启用推理管线\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}2${C_RESET}) 禁用推理管线\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}3${C_RESET}) 配置 LLM\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}4${C_RESET}) 查看运行状态\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}0${C_RESET}) 返回\n"
        printf "  ${C_PRI}╚══════════════════════════════════════╝${C_RESET}\n"
        printf "  ${C_ACC}➤ 选择: ${C_RESET}"

        local choice
        read -r choice

        case "$choice" in
            1)
                env_set_val GATEWAY_RUNTIME_ENABLED true "$env_file"
                success "自建推理管线已启用（写入 .env）"
                # 如果 LLM 未配置，提示配置
                if [ -z "$llm_model" ] || [ -z "$llm_apikey" ]; then
                    warn "LLM 配置不完整，建议立即配置（选 3）"
                fi
                # 检查网关是否运行中，提示重启
                if [ "$health" = "200" ]; then
                    info "网关正在运行，需重启使配置生效"
                    printf "立即重启？(y/n) [y]: "
                    read -r reply
                    if [ "$reply" != "n" ] && [ "$reply" != "N" ]; then
                        restart_gateway || warn "重启失败，请手动重启"
                    fi
                fi
                log_action "INFO" "Runtime 已启用"
                ;;
            2)
                env_set_val GATEWAY_RUNTIME_ENABLED false "$env_file"
                success "自建推理管线已禁用（写入 .env）"
                if [ "$health" = "200" ]; then
                    info "网关正在运行，需重启使配置生效"
                    printf "立即重启？(y/n) [y]: "
                    read -r reply
                    if [ "$reply" != "n" ] && [ "$reply" != "N" ]; then
                        restart_gateway || warn "重启失败，请手动重启"
                    fi
                fi
                log_action "INFO" "Runtime 已禁用"
                ;;
            3)
                echo ""
                printf "LLM Provider [openai]: "
                read -r provider
                provider="${provider:-openai}"
                env_set_val GATEWAY_LLM_PROVIDER "$provider" "$env_file"

                printf "API Base URL (留空用默认): "
                read -r baseurl
                if [ -n "$baseurl" ]; then
                    env_set_val GATEWAY_LLM_BASE_URL "$baseurl" "$env_file"
                fi

                printf "API Key: "
                read -r apikey
                if [ -n "$apikey" ]; then
                    env_set_val GATEWAY_LLM_API_KEY "$apikey" "$env_file"
                fi

                printf "模型名 [gpt-4o-mini]: "
                read -r model
                model="${model:-gpt-4o-mini}"
                env_set_val GATEWAY_LLM_MODEL "$model" "$env_file"

                success "LLM 配置已写入 .env"
                log_action "INFO" "Runtime LLM 配置已更新"
                ;;
            4)
                echo ""
                if [ "$health" = "200" ]; then
                    info "网关运行中，查询 runtime 状态..."
                    local resp
                    resp="$(api_call GET /api/runtime/status 2>/dev/null || echo "")"
                    if [ -n "$resp" ]; then
                        echo "$resp" | node -e "
                            try {
                                const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
                                console.log('  enabled: ' + d.enabled);
                                if (d.assets) {
                                    console.log('  角色卡: ' + d.assets.characters);
                                    console.log('  世界书: ' + d.assets.worldbooks);
                                    console.log('  预设:   ' + d.assets.presets);
                                    console.log('  存档:   ' + d.assets.archives);
                                }
                                if (d.profiles !== undefined) console.log('  Profiles: ' + d.profiles);
                                if (d.message) console.log('  消息: ' + d.message);
                            } catch(e) { console.log('  (解析失败)'); }
                        " 2>/dev/null
                    else
                        warn "无法获取 runtime 状态"
                    fi
                else
                    warn "网关未运行，无法查询 API 状态"
                    info "当前 .env 配置: runtime=$rt_status, model=$llm_model"
                fi
                echo ""
                printf "按回车继续..."
                read -r
                ;;
            0|q|Q) break ;;
            *) warn "无效选择" ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════
# Agent 方案配置管理
# ═══════════════════════════════════════════════════════════

# ── 辅助函数 ──

# 返回 agents 数据目录路径，不存在则创建
agent_dir() {
    local d="$DATA_DIR/plugins/agent-framework/agents"
    mkdir -p "$d" 2>/dev/null
    echo "$d"
}

# 返回模板目录路径
agent_template_dir() {
    echo "$INSTALL_DIR/plugins/agent-framework/templates"
}

# 从 YAML 文本提取顶层字段值（简易解析，不处理嵌套）
agent_yaml_extract_field() {
    local yaml_text="$1" field="$2"
    echo "$yaml_text" | while IFS= read -r line; do
        # 跳过空行和注释
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        # 匹配 field: value 格式（非缩进行）
        if [[ "$line" =~ ^${field}:[[:space:]]*(.*)$ ]]; then
            local val="${BASH_REMATCH[1]}"
            # 去掉引号
            val="${val#\"}"; val="${val%\"}"
            val="${val#\'}"; val="${val%\'}"
            echo "$val"
            return
        fi
    done
}

# 统计 YAML 中 tools 段下的列表项数
agent_yaml_count_tools() {
    local yaml_text="$1"
    local in_tools=0 count=0
    # 注意：用 here-string 而非管道，避免 while 进入子 shell 导致 count 变更丢失
    while IFS= read -r line; do
        if [[ "$line" =~ ^tools: ]]; then
            in_tools=1
            continue
        fi
        if [ "$in_tools" = "1" ]; then
            # 遇到非缩进行，tools 段结束
            case "$line" in
                [[:space:]]*|[[:space:]]#*) ;;
                "") continue ;;
                *) break ;;
            esac
            [[ "$line" =~ ^[[:space:]]+-[[:space:]]*(.+) ]] && count=$((count + 1))
        fi
    done <<< "$yaml_text"
    echo "$count"
}

# 统计 YAML 中 subAgents 段下的列表项数
agent_yaml_count_subagents() {
    local yaml_text="$1"
    local in_sub=0 count=0
    # 注意：用 here-string 而非管道，避免 while 进入子 shell 导致 count 变更丢失
    while IFS= read -r line; do
        if [[ "$line" =~ ^subAgents: ]]; then
            in_sub=1
            continue
        fi
        if [ "$in_sub" = "1" ]; then
            case "$line" in
                [[:space:]]*|[[:space:]]#*) ;;
                "") continue ;;
                *) break ;;
            esac
            [[ "$line" =~ ^[[:space:]]+-[[:space:]]*name: ]] && count=$((count + 1))
        fi
    done <<< "$yaml_text"
    echo "$count"
}

# 基础校验：检查 name 字段存在且非空
agent_validate() {
    local yaml_text="$1"
    local name
    name="$(agent_yaml_extract_field "$yaml_text" "name")"
    if [ -z "$name" ]; then
        error "YAML 校验失败：缺少必需字段 'name'"
        return 1
    fi
    # 校验 name 格式
    if ! echo "$name" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
        error "YAML 校验失败：name 仅允许字母数字及 . _ -，且以字母数字开头"
        return 1
    fi
    return 0
}

# 从 YAML 文本提取 name 字段
agent_get_name() {
    agent_yaml_extract_field "$1" "name"
}

# 从 YAML 文本提取 displayName 字段
agent_get_display_name() {
    agent_yaml_extract_field "$1" "displayName"
}

# 从 YAML 文本提取 description 字段
agent_get_description() {
    agent_yaml_extract_field "$1" "description"
}

# 检查 YAML 中 isDefault 是否为 true
agent_is_default() {
    local val
    val="$(agent_yaml_extract_field "$1" "isDefault")"
    [ "$val" = "true" ]
}

# 读取 agent YAML 文件内容
agent_read_file() {
    local name="$1" f
    f="$(agent_dir)/${name}.yaml"
    [ -f "$f" ] || { warn "Agent 文件不存在: $f"; return 1; }
    cat "$f"
}

# 写入 agent YAML 文件
agent_write_file() {
    local name="$1" content="$2"
    local d
    d="$(agent_dir)"
    echo "$content" > "$d/${name}.yaml"
}

# 删除 agent YAML 文件
agent_delete_file() {
    local name="$1" f
    f="$(agent_dir)/${name}.yaml"
    [ -f "$f" ] || { warn "Agent 文件不存在: $name"; return 1; }
    rm -f "$f"
}

# 网关是否运行中
agent_gateway_running() {
    [ "$(check_port)" = "200" ]
}

# 通过 API 保存 agent（热加载）
agent_api_save() {
    local yaml_text="$1"
    if agent_gateway_running; then
        local resp
        resp="$(api_call POST /api/agents "{\"yaml\":$(echo "$yaml_text" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(d)))" 2>/dev/null)}" 2>/dev/null || echo "")"
        if echo "$resp" | grep -q '"success":true' 2>/dev/null; then
            return 0
        else
            warn "API 热加载失败（文件已保存，重启网关后生效）"
            return 1
        fi
    fi
    return 0
}

# 通过 API 删除 agent（热加载）
agent_api_delete() {
    local name="$1"
    if agent_gateway_running; then
        api_call DELETE "/api/agents/$(encodeURIComponent "$name")" >/dev/null 2>&1 || true
    fi
}

# URL 编码（用于 API 路径中的 agent name）
encodeURIComponent() {
    node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$1" 2>/dev/null || echo "$1"
}

# 列出内置模板
agent_list_templates() {
    local tdir
    tdir="$(agent_template_dir)"
    [ -d "$tdir" ] || { warn "模板目录不存在: $tdir"; return 1; }
    echo ""
    info "可用 Agent 模板"
    echo ""
    local idx=1
    for f in "$tdir"/*.yaml; do
        [ -f "$f" ] || continue
        local fname tname tdesc
        fname="$(basename "$f" .yaml)"
        tname="$(agent_yaml_extract_field "$(cat "$f")" "name")"
        tdesc="$(agent_yaml_extract_field "$(cat "$f")" "description")"
        [ -z "$tdesc" ] && tdesc="(无描述)"
        echo "  $idx) ${tname:-$fname}"
        dim "     $tdesc"
        idx=$((idx + 1))
    done
}

# ── 菜单功能函数 ──

# 列出所有 Agent
agent_menu_list() {
    echo ""
    if agent_gateway_running; then
        info "Agent 列表（来自运行中网关）"
        echo ""
        local resp
        resp="$(api_call GET /api/agents 2>/dev/null || echo "")"
        if [ -z "$resp" ] || echo "$resp" | grep -q '"error"' 2>/dev/null; then
            warn "无法获取 Agent 列表（Agent 框架可能未启用）"
            echo ""
            printf "按回车继续..."
            read -r
            return 1
        fi
        echo "$resp" | node -e "
            let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                try {
                    const data = JSON.parse(d);
                    const agents = data.agents || [];
                    if (!agents.length) { console.log('  (暂无 Agent)'); return; }
                    agents.forEach((a,i) => {
                        const def = a.isDefault ? ' [默认]' : '';
                        const tc = a.tools ? a.tools.length : 0;
                        const sc = a.subAgents ? a.subAgents.length : 0;
                        console.log('  ' + (i+1) + ') ' + a.name + def + '  工具:' + tc + '  子代理:' + sc);
                        if (a.description) console.log('     ' + a.description);
                    });
                } catch(e) { console.log('  (解析失败)'); }
            });
        " 2>/dev/null
    else
        info "Agent 列表（本地文件）"
        echo ""
        local d
        d="$(agent_dir)"
        local idx=1 found=0
        for f in "$d"/*.yaml; do
            [ -f "$f" ] || continue
            local content tname tdesc tc sc def
            content="$(cat "$f")"
            tname="$(agent_get_name "$content")"
            tdesc="$(agent_get_description "$content")"
            [ -z "$tdesc" ] && tdesc="(无描述)"
            if agent_is_default "$content"; then def=" [默认]"; else def=""; fi
            tc="$(agent_yaml_count_tools "$content")"
            sc="$(agent_yaml_count_subagents "$content")"
            echo "  $idx) ${tname:-$(basename "$f" .yaml)}${def}  工具:${tc}  子代理:${sc}"
            dim "     $tdesc"
            idx=$((idx + 1))
            found=1
        done
        [ "$found" = "0" ] && echo "  (暂无 Agent)"
    fi
    echo ""
    printf "按回车继续..."
    read -r
}

# 查看 Agent YAML 全文
agent_menu_view() {
    local name="$1"
    if [ -z "$name" ]; then
        printf "Agent 名称: "
        read -r name
    fi
    [ -z "$name" ] && return 1

    local content
    if agent_gateway_running; then
        content="$(api_call GET "/api/agents/$(encodeURIComponent "$name")" 2>/dev/null || echo "")"
        if [ -z "$content" ] || echo "$content" | grep -q '"error"' 2>/dev/null; then
            # API 失败，回退到文件
            content="$(agent_read_file "$name" 2>/dev/null || echo "")"
        fi
    else
        content="$(agent_read_file "$name" 2>/dev/null || echo "")"
    fi

    if [ -z "$content" ]; then
        warn "Agent 不存在: $name"
        return 1
    fi

    echo ""
    dim "─── Agent: $name ───"
    echo "$content"
    echo ""
    printf "按回车继续..."
    read -r
}

# 从模板创建新 Agent
agent_menu_from_template() {
    local tdir
    tdir="$(agent_template_dir)"
    [ -d "$tdir" ] || { error "模板目录不存在"; return 1; }

    # 列出模板
    echo ""
    info "选择模板"
    echo ""
    local templates=()
    local idx=1
    for f in "$tdir"/*.yaml; do
        [ -f "$f" ] || continue
        local tname tdesc
        tname="$(agent_yaml_extract_field "$(cat "$f")" "name")"
        tdesc="$(agent_yaml_extract_field "$(cat "$f")" "description")"
        [ -z "$tdesc" ] && tdesc="(无描述)"
        echo "  $idx) ${tname:-$(basename "$f" .yaml)}"
        dim "     $tdesc"
        templates+=("$f")
        idx=$((idx + 1))
    done

    if [ ${#templates[@]} -eq 0 ]; then
        warn "无可用模板"
        return 1
    fi

    printf "选择模板编号: "
    local choice; read -r choice
    if ! [ "$choice" -ge 1 ] 2>/dev/null || [ "$choice" -gt "${#templates[@]}" ]; then
        warn "无效选择"
        return 1
    fi

    local tmpl_file="${templates[$((choice - 1))]}"
    local tmpl_content
    tmpl_content="$(cat "$tmpl_file")"

    # 输入新 Agent name
    echo ""
    printf "新 Agent 名称 (字母数字开头，可用 . _ -): "
    local new_name; read -r new_name
    if ! echo "$new_name" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
        warn "名称格式不合法"
        return 1
    fi

    # 检查是否已存在
    local target
    target="$(agent_dir)/${new_name}.yaml"
    if [ -f "$target" ]; then
        warn "Agent 已存在: $new_name"
        if ! confirm_action "覆盖？"; then return 1; fi
    fi

    # 替换 name、displayName，移除 isDefault
    local modified
    modified="$(echo "$tmpl_content" | sed \
        -e "s/^name:.*/name: $new_name/" \
        -e "s/^isDefault:.*/isDefault: false/" \
    )"

    # 用编辑器打开让用户微调
    local editor
    editor="$(detect_editor 2>/dev/null || echo "")"
    local tmp_file="/tmp/agent_${new_name}_$$.yaml"
    echo "$modified" > "$tmp_file"

    if [ -n "$editor" ]; then
        agent_show_editor_hints "$editor"
        echo ""
        info "用 $editor 编辑 Agent YAML（模板已预填）"
        printf "按回车打开编辑器..."
        read -r
        $editor "$tmp_file" 2>/dev/null || warn "编辑器退出异常"
    else
        warn "未检测到编辑器，将直接保存模板内容"
    fi

    # 读取编辑后的内容
    local final_content
    final_content="$(cat "$tmp_file")"
    rm -f "$tmp_file"

    # 校验
    if ! agent_validate "$final_content"; then
        warn "校验失败，内容未保存"
        return 1
    fi

    local final_name
    final_name="$(agent_get_name "$final_content")"

    # 保存
    agent_write_file "$final_name" "$final_content"
    success "Agent 已保存: $final_name"
    agent_api_save "$final_content"
    log_action "INFO" "创建 Agent: $final_name（从模板）"
}

# 空白新建 Agent
agent_menu_new() {
    echo ""
    printf "Agent 名称 (字母数字开头，可用 . _ -): "
    local name; read -r name
    if ! echo "$name" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
        warn "名称格式不合法"
        return 1
    fi

    local target
    target="$(agent_dir)/${name}.yaml"
    if [ -f "$target" ]; then
        warn "Agent 已存在: $name"
        if ! confirm_action "覆盖？"; then return 1; fi
    fi

    # 生成最小模板
    local template="name: $name
displayName: $name
description: 新建 Agent

systemPrompt: |
  你是一个 Agent。

tools:
  - state.read
  - state.write
  - memory.recall

context:
  historyLimit: 20

maxSteps: 10
"

    local editor
    editor="$(detect_editor 2>/dev/null || echo "")"
    local tmp_file="/tmp/agent_${name}_$$.yaml"
    echo "$template" > "$tmp_file"

    if [ -n "$editor" ]; then
        agent_show_editor_hints "$editor"
        echo ""
        info "用 $editor 编辑 Agent YAML"
        printf "按回车打开编辑器..."
        read -r
        $editor "$tmp_file" 2>/dev/null || warn "编辑器退出异常"
    else
        warn "未检测到编辑器，将直接保存默认模板"
    fi

    local final_content
    final_content="$(cat "$tmp_file")"
    rm -f "$tmp_file"

    if ! agent_validate "$final_content"; then
        warn "校验失败，内容未保存"
        return 1
    fi

    local final_name
    final_name="$(agent_get_name "$final_content")"
    agent_write_file "$final_name" "$final_content"
    success "Agent 已保存: $final_name"
    agent_api_save "$final_content"
    log_action "INFO" "创建 Agent: $final_name"
}

# 编辑 Agent
agent_menu_edit() {
    local name="$1"
    if [ -z "$name" ]; then
        printf "Agent 名称: "
        read -r name
    fi
    [ -z "$name" ] && return 1

    # 读取当前内容
    local content
    content="$(agent_read_file "$name" 2>/dev/null || echo "")"
    if [ -z "$content" ]; then
        # 尝试 API
        if agent_gateway_running; then
            content="$(api_call GET "/api/agents/$(encodeURIComponent "$name")" 2>/dev/null || echo "")"
            if echo "$content" | grep -q '"error"' 2>/dev/null; then
                warn "Agent 不存在: $name"
                return 1
            fi
        else
            warn "Agent 不存在: $name"
            return 1
        fi
    fi

    local editor
    editor="$(detect_editor 2>/dev/null || echo "")"
    if [ -z "$editor" ]; then
        error "未检测到可用的文本编辑器"
        return 1
    fi

    local tmp_file="/tmp/agent_${name}_$$.yaml"
    echo "$content" > "$tmp_file"

    agent_show_editor_hints "$editor"
    echo ""
    info "用 $editor 编辑 Agent: $name"
    printf "按回车打开编辑器..."
    read -r
    $editor "$tmp_file" 2>/dev/null || warn "编辑器退出异常"

    local final_content
    final_content="$(cat "$tmp_file")"
    rm -f "$tmp_file"

    if ! agent_validate "$final_content"; then
        warn "校验失败，内容未保存"
        return 1
    fi

    local final_name
    final_name="$(agent_get_name "$final_content")"

    # 如果 name 变了，删除旧文件
    if [ "$final_name" != "$name" ]; then
        agent_delete_file "$name" 2>/dev/null || true
        if agent_gateway_running; then
            api_call DELETE "/api/agents/$(encodeURIComponent "$name")" >/dev/null 2>&1 || true
        fi
        info "Agent 名称已变更: $name → $final_name"
    fi

    agent_write_file "$final_name" "$final_content"
    success "Agent 已保存: $final_name"
    agent_api_save "$final_content"
    log_action "INFO" "编辑 Agent: $final_name"
}

# 删除 Agent
agent_menu_delete() {
    local name="$1"
    if [ -z "$name" ]; then
        printf "Agent 名称: "
        read -r name
    fi
    [ -z "$name" ] && return 1

    if agent_is_default "$(agent_read_file "$name" 2>/dev/null || echo "")"; then
        warn "这是默认 Agent，删除后可能影响系统行为"
    fi

    if ! confirm_action "删除 Agent \"$name\"？"; then
        return 1
    fi

    agent_delete_file "$name" 2>/dev/null || true
    if agent_gateway_running; then
        api_call DELETE "/api/agents/$(encodeURIComponent "$name")" >/dev/null 2>&1 || true
    fi
    success "Agent 已删除: $name"
    log_action "WARN" "删除 Agent: $name"
}

# 复制 Agent
agent_menu_duplicate() {
    printf "源 Agent 名称: "
    local src; read -r src
    [ -z "$src" ] && return 1

    local content
    content="$(agent_read_file "$src" 2>/dev/null || echo "")"
    if [ -z "$content" ]; then
        warn "Agent 不存在: $src"
        return 1
    fi

    printf "新 Agent 名称: "
    local dst; read -r dst
    if ! echo "$dst" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
        warn "名称格式不合法"
        return 1
    fi

    local target
    target="$(agent_dir)/${dst}.yaml"
    if [ -f "$target" ]; then
        warn "Agent 已存在: $dst"
        if ! confirm_action "覆盖？"; then return 1; fi
    fi

    # 替换 name，移除 isDefault
    local modified
    modified="$(echo "$content" | sed \
        -e "s/^name:.*/name: $dst/" \
        -e "s/^isDefault:.*/isDefault: false/" \
    )"

    agent_write_file "$dst" "$modified"
    success "Agent 已复制: $src → $dst"
    agent_api_save "$modified"
    log_action "INFO" "复制 Agent: $src → $dst"
}

# 导入 YAML 文件
agent_menu_import() {
    printf "YAML 文件路径: "
    local src_path; read -r src_path
    [ -z "$src_path" ] && return 1
    [ -f "$src_path" ] || { warn "文件不存在: $src_path"; return 1; }

    local content
    content="$(cat "$src_path")"

    if ! agent_validate "$content"; then
        return 1
    fi

    local name
    name="$(agent_get_name "$content")"

    local target
    target="$(agent_dir)/${name}.yaml"
    if [ -f "$target" ]; then
        warn "Agent 已存在: $name"
        if ! confirm_action "覆盖？"; then return 1; fi
    fi

    agent_write_file "$name" "$content"
    success "Agent 已导入: $name"
    agent_api_save "$content"
    log_action "INFO" "导入 Agent: $name（来源: $src_path）"
}

# 导出 Agent
agent_menu_export() {
    local name="$1"
    if [ -z "$name" ]; then
        printf "Agent 名称: "
        read -r name
    fi
    [ -z "$name" ] && return 1

    local content
    content="$(agent_read_file "$name" 2>/dev/null || echo "")"
    if [ -z "$content" ]; then
        warn "Agent 不存在: $name"
        return 1
    fi

    printf "导出路径 [./${name}.yaml]: "
    local dst_path; read -r dst_path
    dst_path="${dst_path:-./${name}.yaml}"

    cp "$(agent_dir)/${name}.yaml" "$dst_path"
    success "Agent 已导出: $name → $dst_path"
}

# 子代理配置
agent_menu_subagents() {
    local name="$1"
    if [ -z "$name" ]; then
        printf "Agent 名称: "
        read -r name
    fi
    [ -z "$name" ] && return 1

    local content f
    f="$(agent_dir)/${name}.yaml"
    content="$(cat "$f" 2>/dev/null || echo "")"
    if [ -z "$content" ]; then
        warn "Agent 不存在: $name"
        return 1
    fi

    # 检查是否有 subAgents 段
    if ! echo "$content" | grep -q "^subAgents:"; then
        info "Agent $name 当前无子代理配置"
        printf "添加子代理？(y/n) [n]: "
        local r; read -r r
        [ "$r" != "y" ] && [ "$r" != "Y" ] && return 0
        # 追加 subAgents 段
        local sub_name
        printf "子代理 Agent 名称: "; read -r sub_name
        [ -z "$sub_name" ] && return 1
        echo "" >> "$f"
        echo "subAgents:" >> "$f"
        echo "  - name: $sub_name" >> "$f"
        echo "    trigger: after_draft" >> "$f"
        echo "    parallel: false" >> "$f"
        success "子代理已添加: $sub_name"
        agent_api_save "$(cat "$f")"
        log_action "INFO" "Agent $name 添加子代理: $sub_name"
        return 0
    fi

    # 显示当前子代理
    echo ""
    info "Agent $name 的子代理配置"
    echo ""
    echo "$content" | awk '/^subAgents:/{found=1;next} /^[a-zA-Z]/{found=0} found{print}'

    echo ""
    echo "  a) 添加子代理"
    echo "  r) 删除子代理"
    echo "  0) 返回"
    printf "选择: "
    local choice; read -r choice

    case "$choice" in
        a|A)
            local sub_name sub_trigger sub_parallel
            printf "子代理 Agent 名称: "; read -r sub_name
            [ -z "$sub_name" ] && return 1
            printf "触发方式 (after_draft/manual) [after_draft]: "; read -r sub_trigger
            sub_trigger="${sub_trigger:-after_draft}"
            printf "并行执行？(y/n) [n]: "; read -r sub_parallel
            local par="false"
            [ "$sub_parallel" = "y" ] || [ "$sub_parallel" = "Y" ] && par="true"

            # 在 subAgents 段末尾追加
            local new_content
            new_content="$(echo "$content" | awk -v sn="$sub_name" -v st="$sub_trigger" -v sp="$par" '
                /^subAgents:/ { in_sub=1; print; next }
                /^[a-zA-Z]/ && in_sub { in_sub=0 }
                in_sub { lines[NR]=$0; next }
                { if (in_sub_was==1 && !in_sub) {
                    print "  - name: " sn
                    print "    trigger: " st
                    print "    parallel: " sp
                    in_sub_was=0
                  }
                  print
                }
                /^subAgents:/ { in_sub_was=1 }
                END { if (in_sub) {
                    for (i in lines) print lines[i]
                    print "  - name: " sn
                    print "    trigger: " st
                    print "    parallel: " sp
                  }
                }
            ')"
            # 简化处理：直接追加到文件末尾的 subAgents 段
            # 找到 subAgents 段的最后一行，在其后插入
            local tmp
            tmp="$(mktemp 2>/dev/null || echo "/tmp/agent_sub_$$")"
            echo "$content" > "$tmp"
            # 在 subAgents 段的最后一个子代理后追加新子代理
            sed -i "/^subAgents:/,/^[a-zA-Z]/{
                /^[a-zA-Z]/i\\  - name: $sub_name\\n    trigger: $sub_trigger\\n    parallel: $par
            }" "$tmp" 2>/dev/null || {
                # sed 方式失败，用 node 处理
                node -e "
                    const fs=require('fs');
                    let c=fs.readFileSync('$tmp','utf8');
                    const lines=c.split('\n');
                    let out=[];
                    let inSub=false;
                    let lastSubIdx=-1;
                    for(let i=0;i<lines.length;i++){
                        out.push(lines[i]);
                        if(lines[i].match(/^subAgents:/)) inSub=true;
                        else if(inSub && lines[i].match(/^[a-zA-Z]/)) inSub=false;
                        else if(inSub && lines[i].match(/^\s+- name:/)) lastSubIdx=out.length-1;
                    }
                    // 在最后一个子代理后插入
                    if(lastSubIdx>=0){
                        out.splice(lastSubIdx+1,0,'  - name: $sub_name','    trigger: $sub_trigger','    parallel: $par');
                    }
                    fs.writeFileSync('$tmp',out.join('\n'));
                " 2>/dev/null
            }
            cp "$tmp" "$f"
            rm -f "$tmp"
            success "子代理已添加: $sub_name"
            agent_api_save "$(cat "$f")"
            log_action "INFO" "Agent $name 添加子代理: $sub_name"
            ;;
        r|R)
            printf "要删除的子代理名称: "; local del_name; read -r del_name
            [ -z "$del_name" ] && return 1
            # 用 node 精确删除指定子代理块
            local tmp
            tmp="$(mktemp 2>/dev/null || echo "/tmp/agent_sub_$$")"
            node -e "
                const fs=require('fs');
                let c=fs.readFileSync('$f','utf8');
                const lines=c.split('\n');
                let out=[];
                let inSub=false;
                let skip=false;
                for(let i=0;i<lines.length;i++){
                    if(lines[i].match(/^subAgents:/)){inSub=true;out.push(lines[i]);continue;}
                    if(inSub && lines[i].match(/^[a-zA-Z]/))inSub=false;
                    if(inSub && lines[i].match(/^\s+- name:\s*$del_name\s*$/)){
                        skip=true;
                        continue;
                    }
                    if(skip){
                        if(lines[i].match(/^\s+- name:/)||lines[i].match(/^[a-zA-Z]/)){
                            skip=false;
                        } else {
                            continue;
                        }
                    }
                    out.push(lines[i]);
                }
                fs.writeFileSync('$tmp',out.join('\n'));
            " "$del_name" 2>/dev/null
            cp "$tmp" "$f"
            rm -f "$tmp"
            success "子代理已删除: $del_name"
            agent_api_save "$(cat "$f")"
            log_action "INFO" "Agent $name 删除子代理: $del_name"
            ;;
        0|q|Q) return 0 ;;
    esac
}

# 工具列表
agent_menu_tools() {
    echo ""
    if agent_gateway_running; then
        info "已注册工具（来自运行中网关）"
        echo ""
        local resp
        resp="$(api_call GET /api/agents/tools 2>/dev/null || echo "")"
        if [ -n "$resp" ] && ! echo "$resp" | grep -q '"error"' 2>/dev/null; then
            echo "$resp" | node -e "
                let d='';
                process.stdin.on('data',c=>d+=c);
                process.stdin.on('end',()=>{
                    try {
                        const tools = JSON.parse(d).tools || [];
                        if(!tools.length){console.log('  (无注册工具)');return;}
                        tools.forEach(t=>{
                            console.log('  '+t.name+'  ['+(t.source||'?')+']');
                            if(t.description)console.log('    '+t.description);
                        });
                    } catch(e){console.log('  (解析失败)');}
                });
            " 2>/dev/null
        else
            warn "无法获取工具列表（Agent 框架可能未启用）"
        fi
    else
        info "内置工具列表（网关未运行，显示静态列表）"
        echo ""
        echo "  ── 状态工具 ──"
        echo "    state.read     读取会话状态"
        echo "    state.write    写入会话状态"
        echo "    state.list     列出状态键名"
        echo "    state.delete   删除状态键"
        echo "  ── 记忆工具 ──"
        echo "    memory.recall  检索四层记忆"
        echo "    memory.update  更新记忆文件"
        echo "    memory.read    读取记忆文件"
        echo "  ── 叙事工具 ──"
        echo "    narrative.generate  调用LLM生成正文"
        echo "  ── 文件工具 ──"
        echo "    file.read      读取工作区文件"
        echo "    file.write     写入工作区文件"
        echo "    file.list      列出工作区目录"
        echo "  ── Skill 工具 ──"
        echo "    skill.load     加载 skill 文件"
        echo "    skill.list     列出 skill 文件"
        echo "  ── 子代理工具 ──"
        echo "    subagent.dispatch  调度子代理"
        echo "    subagent.list      列出可用子代理"
        echo "  ── 外部注册（需 agent-rp 插件）──"
        echo "    character.read   读取角色卡"
        echo "    worldbook.search 搜索世界书"
    fi
    echo ""
    printf "按回车继续..."
    read -r
}

# 运行日志
agent_menu_logs() {
    echo ""
    if ! agent_gateway_running; then
        warn "网关未运行，无法获取运行日志"
        printf "按回车继续..."
        read -r
        return 1
    fi

    info "Agent 运行日志（最近 10 条）"
    echo ""
    local resp
    resp="$(api_call GET /api/agents/logs 2>/dev/null || echo "")"
    if [ -n "$resp" ] && ! echo "$resp" | grep -q '"error"' 2>/dev/null; then
        echo "$resp" | node -e "
            let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                try {
                    let logs = JSON.parse(d).logs || [];
                    if(!logs.length){console.log('  (暂无执行记录)');return;}
                    logs=logs.slice(-10).reverse();
                    logs.forEach(l=>{
                        const status = l.success ? 'OK' : 'FAIL';
                        const dur = l.duration ? (l.duration/1000).toFixed(1)+'s' : '-';
                        const steps = l.steps!=null ? l.steps : '-';
                        console.log('  '+l.agent+'  ['+status+']  '+dur+'  步数:'+steps);
                    });
                } catch(e){console.log('  (解析失败)');}
            });
        " 2>/dev/null
    else
        warn "无法获取日志"
    fi
    echo ""
    printf "按回车继续..."
    read -r
}

# 显示编辑器操作提示
agent_show_editor_hints() {
    local editor="$1"
    echo ""
    echo "  ┌──────────────────────────────────────────┐"
    echo "  │  编辑器操作提示 ($editor)                  │"
    echo "  ├──────────────────────────────────────────┤"
    case "$editor" in
        nano*)
            echo "  │  保存退出: Ctrl+O → 回车 → Ctrl+X       │"
            echo "  │  放弃退出: Ctrl+X → N                    │"
            echo "  │  查找:     Ctrl+W                        │"
            echo "  │  替换:     Ctrl+\\                        │"
            echo "  │  行首/尾:  Ctrl+A / Ctrl+E               │"
            ;;
        vim*|vi*)
            echo "  │  保存退出: :wq → 回车                     │"
            echo "  │  放弃退出: :q! → 回车                     │"
            echo "  │  查找:     /关键词 → 回车                  │"
            echo "  │  替换:     :s/旧/新/g → 回车              │"
            echo "  │  插入模式: i (按 Esc 回到命令模式)        │"
            ;;
        *)
            echo "  │  请参考该编辑器的快捷键文档               │"
            ;;
    esac
    echo "  └──────────────────────────────────────────┘"
}

# ── 交互式主菜单 ──
agent_interactive_menu() {
    while true; do
        echo ""
        printf "  ${C_PRI}╔══════════════════════════════════════╗${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}       ${C_BOLD}${C_SEC}Agent 方案配置管理${C_RESET}\n"
        printf "  ${C_PRI}╠══════════════════════════════════════╣${C_RESET}\n"

        # 显示 Agent 列表概览
        local d
        d="$(agent_dir)"
        local agent_files=()
        local idx=1
        for f in "$d"/*.yaml; do
            [ -f "$f" ] || continue
            local content tname def tc sc
            content="$(cat "$f")"
            tname="$(agent_get_name "$content")"
            if agent_is_default "$content"; then def=" ${C_ACC}[默认]${C_RESET}"; else def=""; fi
            tc="$(agent_yaml_count_tools "$content")"
            sc="$(agent_yaml_count_subagents "$content")"
            printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}%d)${C_RESET} ${C_SEC}%-14s${C_RESET}%s ${C_DIM}工具:${C_RESET}${C_ACC}%-2s${C_RESET} ${C_DIM}子代理:${C_RESET}${C_ACC}%-2s${C_RESET}\n" \
                "$idx" "${tname:-$(basename "$f" .yaml)}" "$def" "$tc" "$sc"
            agent_files+=("$tname")
            idx=$((idx + 1))
        done
        [ ${#agent_files[@]} -eq 0 ] && printf "  ${C_PRI}║${C_RESET}  ${C_WARN}(暂无 Agent)${C_RESET}\n"

        printf "  ${C_PRI}╠══════════════════════════════════════╣${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}n${C_RESET}) 新建    ${C_BOLD}${C_ACC}t${C_RESET}) 从模板   ${C_BOLD}${C_ACC}c${C_RESET}) 复制\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}e${C_RESET}) 编辑    ${C_BOLD}${C_ACC}v${C_RESET}) 查看     ${C_BOLD}${C_ACC}d${C_RESET}) 删除\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}i${C_RESET}) 导入    ${C_BOLD}${C_ACC}x${C_RESET}) 导出     ${C_BOLD}${C_ACC}s${C_RESET}) 子代理\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}l${C_RESET}) 日志    ${C_BOLD}${C_ACC}T${C_RESET}) 工具\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_BOLD}${C_ACC}0${C_RESET}) 返回\n"
        printf "  ${C_PRI}╚══════════════════════════════════════╝${C_RESET}\n"
        printf "  ${C_ACC}➤ 选择: ${C_RESET}"

        local choice; read -r choice

        case "$choice" in
            n|N) agent_menu_new ;;
            t) agent_menu_from_template ;;
            c) agent_menu_duplicate ;;
            e|E)
                if [ ${#agent_files[@]} -eq 0 ]; then
                    warn "暂无 Agent"
                else
                    printf "编号或名称: "; local n; read -r n
                    local target_name=""
                    if [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#agent_files[@]}" ]; then
                        target_name="${agent_files[$((n - 1))]}"
                    else
                        target_name="$n"
                    fi
                    agent_menu_edit "$target_name"
                fi
                ;;
            v|V)
                if [ ${#agent_files[@]} -eq 0 ]; then
                    warn "暂无 Agent"
                else
                    printf "编号或名称: "; local n; read -r n
                    local target_name=""
                    if [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#agent_files[@]}" ]; then
                        target_name="${agent_files[$((n - 1))]}"
                    else
                        target_name="$n"
                    fi
                    agent_menu_view "$target_name"
                fi
                ;;
            d|D)
                if [ ${#agent_files[@]} -eq 0 ]; then
                    warn "暂无 Agent"
                else
                    printf "编号或名称: "; local n; read -r n
                    local target_name=""
                    if [ "$n" -ge 1 ] 2>/dev/null && [ "$n" -le "${#agent_files[@]}" ]; then
                        target_name="${agent_files[$((n - 1))]}"
                    else
                        target_name="$n"
                    fi
                    agent_menu_delete "$target_name"
                fi
                ;;
            i) agent_menu_import ;;
            x) agent_menu_export ;;
            s) agent_menu_subagents ;;
            l) agent_menu_logs ;;
            T) agent_menu_tools ;;
            0|q|Q) break ;;
            *)
                # 数字选择 → 查看对应 Agent
                if [ "$choice" -ge 1 ] 2>/dev/null && [ "$choice" -le "${#agent_files[@]}" ]; then
                    agent_menu_view "${agent_files[$((choice - 1))]}"
                else
                    warn "无效选择"
                fi
                ;;
        esac
    done
}

# ── 主入口 ──
cmd_agents() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }

    # 解析 CLI 快捷命令
    local subcmd="${2:-}"
    case "$subcmd" in
        list)       agent_menu_list; return ;;
        tools)      agent_menu_tools; return ;;
        new)        agent_menu_new; return ;;
        logs)       agent_menu_logs; return ;;
        templates)  agent_list_templates; return ;;
        edit)       agent_menu_edit "${3:-}"; return ;;
        view)       agent_menu_view "${3:-}"; return ;;
        delete)     agent_menu_delete "${3:-}"; return ;;
        export)     agent_menu_export "${3:-}"; return ;;
    esac

    # 无子命令 → 交互菜单
    agent_interactive_menu
}

# ═══════════════════════════════════════════════════════════
# 鉴权 Token 获取
# ═══════════════════════════════════════════════════════════

# 显示网关鉴权 Token（独立选项，方便用户随时获取）
# 优先级: .env 中 GATEWAY_AUTH_TOKEN > config/gateway.json 中 server.authToken
# 若网关运行中但 token 尚未写入，会用重试机制等待
cmd_show_token() {
    [ -z "${INSTALL_DIR:-}" ] && { error "未检测到安装目录"; return 1; }

    echo ""
    printf "  ${C_PRI}╔════════════════════════════════════════════════════╗${C_RESET}\n"
    printf "  ${C_PRI}║${C_RESET}   ${C_BOLD}${C_SEC}◆ 网关鉴权 Token 获取${C_RESET}\n"
    printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"

    local token=""
    local token_source=""

    # 1. 尝试直接获取（.env 优先，再配置文件）
    token="$(get_auth_token)"
    if [ -n "$token" ]; then
        # 判断来源
        if [ -f "$INSTALL_DIR/.env" ] && grep -q "^GATEWAY_AUTH_TOKEN=" "$INSTALL_DIR/.env" 2>/dev/null; then
            token_source="环境变量 (.env: GATEWAY_AUTH_TOKEN)"
        else
            token_source="配置文件 (config/gateway.json: server.authToken)"
        fi
    fi

    # 2. 如果没取到，检查网关是否运行中 —— 运行中可能 token 尚未落盘
    if [ -z "$token" ]; then
        local running=false
        if [ -f "$PID_FILE" ]; then
            local pid
            pid="$(cat "$PID_FILE" 2>/dev/null)"
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                running=true
            fi
        fi

        if [ "$running" = "true" ]; then
            info "网关运行中，正在等待 Token 写入..."
            token="$(get_auth_token_retry 10)"
            if [ -n "$token" ]; then
                token_source="配置文件 (网关运行中已写入)"
            fi
        fi
    fi

    # 3. 输出结果
    if [ -n "$token" ]; then
        printf "  ${C_PRI}║${C_RESET}  状态: ${C_BOLD}${C_OK}✅ 已获取${C_RESET}\n"
        printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}   ${C_ACC}◈ Token 凭证${C_RESET}:\n"
        printf "  ${C_BOLD}${C_ACC}  %s${C_RESET}\n" "$token"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}来源:${C_RESET} %s\n" "${token_source:0:36}"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}端口:${C_RESET} ${C_ACC}%s${C_RESET}\n" "$PORT"
        printf "  ${C_PRI}║${C_RESET}  ${C_DIM}连接地址:${C_RESET} ${C_SEC}http://localhost:${PORT}${C_RESET}\n"
        printf "  ${C_PRI}╚════════════════════════════════════════════════════╝${C_RESET}\n"
        echo ""
        info "在 SillyTavern 中使用:"
        dim "  1. 打开 SillyTavern → 扩展 → Multi-Platform Gateway"
        dim "  2. 网关地址填: http://localhost:${PORT}"
        dim "  3. 鉴权 Token 填上方显示的 Token"
        dim "  4. 点击「连接」"
        echo ""
        warn "⚠ Token 是网关的访问凭证，请勿泄露给他人"
        log_action "INFO" "用户获取了鉴权 Token"
    else
        printf "  ${C_PRI}║${C_RESET}  状态: ${C_BOLD}${C_ERR}❌ 未获取${C_RESET}\n"
        printf "  ${C_PRI}╚════════════════════════════════════════════════════╝${C_RESET}\n"
        echo ""
        error "未能获取鉴权 Token"
        echo ""
        warn "可能原因与解决方案:"
        echo ""
        dim "  1. 网关尚未启动 → 首次启动会自动生成 Token"
        dim "     解决: 选菜单 4) 启动网关，或运行: $0 start"
        echo ""
        dim "  2. 配置文件不存在 → 需要启动一次网关才会生成"
        dim "     配置文件位置: $CONFIG_DIR/gateway.json"
        echo ""
        dim "  3. 鉴权已关闭 (requireAuth=false) → 无需 Token"
        dim "     检查: config/gateway.json 中 server.requireAuth"
        echo ""
        dim "  4. 手动查看 Token 的方法:"
        dim "     cd $INSTALL_DIR && node scripts/show-token.js"
        dim "     或查看: $CONFIG_DIR/gateway.json 中的 server.authToken"
        echo ""
        log_action "WARN" "获取 Token 失败"
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════
# 交互式 CLI
# ═══════════════════════════════════════════════════════════

show_help() {
    cat << 'EOF'
SillyTavern Gateway 管理工具 v1.1.1

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
  token           获取鉴权 Token
  plugins         插件管理
  platforms       平台管理（含适配器一键安装）
  skills          Skill 管理（含编辑功能）
  agents          Agent 方案配置管理（创建/编辑/删除/模板/导入导出/子代理）
                  子命令: list|new|edit|view|delete|export|tools|logs|templates
  runtime         自建推理管线配置（启用/禁用/LLM配置）
  log             查看日志（网关输出/管理日志/保活日志）
  keepalive       Termux 保活设置
  rollback        回滚上次更新
  check-restart   检查并自动重启（供 cron/bashrc 调用）
  --help          显示此帮助

示例:
  ./gateway-manager.sh                    # 交互式菜单
  ./gateway-manager.sh install            # 安装
  ./gateway-manager.sh start              # 启动
  ./gateway-manager.sh token              # 获取鉴权 Token
  ./gateway-manager.sh runtime            # 配置自建推理管线
  ./gateway-manager.sh log                # 查看日志
  ./gateway-manager.sh platforms          # 平台管理（可安装飞书/钉钉/QQ官方适配器）
  ./gateway-manager.sh skills             # Skill 管理（可编辑文档）
  ./gateway-manager.sh agents             # Agent 方案管理菜单
  ./gateway-manager.sh agents list        # 列出所有 Agent 方案
  ./gateway-manager.sh agents new         # 从模板新建 Agent
  ./gateway-manager.sh agents edit <name> # 编辑指定 Agent

详细文档: scripts/gateway-manager.README.md
EOF
}

main_menu() {
    local first_show=1
    while true; do
        # 获取状态
        local running=false
        local pid=""
        if [ -f "$PID_FILE" ] 2>/dev/null; then
            pid="$(cat "$PID_FILE" 2>/dev/null)"
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                running=true
            fi
        fi

        # 首次进入展示完整 RP banner
        if [ "$first_show" = "1" ]; then
            show_banner
            first_show=0
        fi

        echo ""
        printf "  ${C_PRI}╔════════════════════════════════════════════════════╗${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}   ${C_BOLD}${C_SEC}◆ SillyTavern Gateway${C_RESET} ${C_ACC}管理工具${C_RESET} ${C_DIM}v${SCRIPT_VERSION}${C_RESET}\n"
        printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"
        if $running; then
            printf "  ${C_PRI}║${C_RESET}  状态: ${C_BOLD}${C_OK}● 运行中${C_RESET} ${C_DIM}(PID %s)${C_RESET}\n" "$pid"
        else
            printf "  ${C_PRI}║${C_RESET}  状态: ${C_BOLD}${C_ERR}● 已停止${C_RESET}\n"
        fi
        printf "  ${C_PRI}╠════════════════════════════════════════════════════╣${C_RESET}\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_ACC}⚔ 生命周期${C_RESET}   [1]安装  [2]更新  [3]卸载\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_SEC}⚡ 运行    ${C_RESET}   [4]启动  [5]停止  [6]重启\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_OK}◈ 扩展    ${C_RESET}   [7]状态  [8]插件  [9]平台\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_SEC}✦ 内容    ${C_RESET}  [10]Skill [11]保活 [12]日志\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_ACC}◆ 系统    ${C_RESET}  [13]回滚 [14]systemd [15]Token\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_WARN}† 高级    ${C_RESET}  [16]Runtime [17]Agent\n"
        printf "  ${C_PRI}║${C_RESET}  ${C_ERR}✖ 退出    ${C_RESET}   [0]退出\n"
        printf "  ${C_PRI}╚════════════════════════════════════════════════════╝${C_RESET}\n"
        printf "  ${C_ACC}➤ 选择: ${C_RESET}"

        local choice
        read -r choice
        case "$choice" in
            1) cmd_install ;;
            2) cmd_update ;;
            3) cmd_uninstall ;;
            4) start_gateway || warn "启动失败" ;;
            5) stop_gateway || warn "停止失败" ;;
            6) restart_gateway || warn "重启失败" ;;
            7) get_status ;;
            8) manage_plugins ;;
            9) manage_platforms ;;
            10) manage_skills ;;
            11) setup_keepalive ;;
            12) show_logs ;;
            13) cmd_rollback ;;
            14) generate_systemd_unit ;;
            15) cmd_show_token ;;
            16) cmd_runtime ;;
            17) cmd_agents ;;
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
    # 保存原始参数（供 cmd_update 中 exec 重启脚本使用）
    CLI_ARGS=("$@")

    # 初始化
    detect_os
    detect_distro
    get_package_manager
    load_env           # 先从 ~/.gateway_env 加载路径记忆
    detect_install_dir  # 再从脚本位置/当前目录检测
    detect_install_helper  # 确保 PLUGINS_DIR 等派生变量正确

    local cmd="${1:-}"
    case "$cmd" in
        install)     cmd_install ;;
        uninstall)   cmd_uninstall ;;
        update)      cmd_update ;;
        start)       try_systemd start   || start_gateway ;;
        stop)        try_systemd stop    || stop_gateway ;;
        restart)     try_systemd restart || restart_gateway ;;
        status)      try_systemd status  || get_status ;;
        token)       cmd_show_token ;;
        log)         show_logs ;;
        runtime)     cmd_runtime ;;
        plugins)     manage_plugins ;;
        platforms)   manage_platforms ;;
        skills)      manage_skills ;;
        agents)      cmd_agents "$@" ;;
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
