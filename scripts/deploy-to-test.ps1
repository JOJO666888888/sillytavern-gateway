# deploy-to-test.ps1
#
# 用途：把开发目录（默认 d:\预设\sillytavern-gateway）的代码完整覆盖到测试目录
#       （默认 D:\QQbot\sillytavern-gateway），清空测试目录中的旧代码/冗余文件，
#       停止开发目录的 Agent 独立服务（4321）与测试目录旧网关进程，
#       仅启动测试目录的最新网关系统，并执行部署验证。
#
# 环境说明：
#   - 开发目录：纯净源码库（无 config / data / assets / node_modules）
#   - 测试目录：实际运行环境（含 config、data、assets 资产资源、node_modules）
#   - 部署 = 用开发目录最新代码覆盖测试目录代码，保留测试目录的运行时数据与资产
#
# 特性：
#   - 可重复执行（幂等）：每次全量同步代码，测试目录旧代码/冗余文件被清除
#   - 保留项：node_modules / .git / data / assets / config / logs
#     （资产与运行时数据不会因部署丢失）
#   - 端口：测试网关默认 3210（与旧网关同端口，先停旧网关再启新网关），
#     可用 -TargetPort 覆盖
#   - 验证：页面 200、LLM 端点可用、开发 Agent(4321) 已停止、旧网关已替换
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-to-test.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-to-test.ps1 -TargetPort 3211
#
# 成功验证标准（脚本自动检查并输出）：
#   1) http://127.0.0.1:<TargetPort>/agent 返回 200
#   2) http://127.0.0.1:<TargetPort>/api/agent-theatre/llm-config 返回 200（带鉴权头，新代码端点）
#   3) 端口 4321（开发 Agent 服务）无监听
#   4) 端口 3210 旧网关进程已停止，测试网关为唯一监听者

param(
    [string]$Source = 'D:\预设\sillytavern-gateway',
    [string]$Target = 'D:\QQbot\sillytavern-gateway',
    [int]$TargetPort = 3210
)

$ErrorActionPreference = 'Stop'
$DEV_AGENT_PORT = 4321   # 开发目录 Agent 独立服务端口（部署后必须停止）
$OLD_GATEWAY_PORT = 3210 # 测试目录旧网关端口（部署前停止，避免新旧并存）

function Test-PortListen([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Stop-PortProcess([int]$Port, [string]$Label) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $procId = $c.OwningProcess
        Write-Host "  停止 $Label (PID $procId, 端口 $Port)"
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '=============================================='
Write-Host '  SillyTavern Gateway 部署到测试目录'
Write-Host "  源目录 : $Source"
Write-Host "  目标目录: $Target"
Write-Host "  测试端口: $TargetPort"
Write-Host '=============================================='

# ---- 1. 校验源目录 ----
Write-Host ''
Write-Host '==== 1. 校验源目录 ===='
if (-not (Test-Path $Source)) { throw "源目录不存在: $Source" }
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "源目录缺少 package.json，不是有效项目: $Source" }
Write-Host '  源目录有效 ✓'

# ---- 2. 停止开发目录 Agent 独立服务（4321）----
Write-Host ''
Write-Host '==== 2. 停止开发目录 Agent 独立服务 ===='
if (Test-PortListen $DEV_AGENT_PORT) {
    Stop-PortProcess $DEV_AGENT_PORT '开发 Agent 服务'
    Start-Sleep -Seconds 2
    if (Test-PortListen $DEV_AGENT_PORT) {
        Write-Warning '  警告: 4321 端口仍有进程监听，请手动检查。'
    } else {
        Write-Host '  开发 Agent 服务已停止 ✓'
    }
} else {
    Write-Host '  4321 端口无监听（开发 Agent 服务未运行）✓'
}

# ---- 3. 停止测试目录旧网关进程（3210 / TargetPort）----
Write-Host ''
Write-Host '==== 3. 停止测试目录旧网关进程 ===='
$stopPorts = @($OLD_GATEWAY_PORT) + @($TargetPort) | Sort-Object -Unique
foreach ($p in $stopPorts) {
    if (Test-PortListen $p) {
        Stop-PortProcess $p "旧测试网关(端口 $p)"
        Start-Sleep -Seconds 1
    }
}
Write-Host '  测试目录旧网关已停止（避免新旧网关并存）✓'

# ---- 4. 清空测试目录旧代码/冗余文件（保留运行时数据与资产）----
Write-Host ''
Write-Host '==== 4. 清空测试目录冗余文件 ===='
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target -Force | Out-Null }
$keep = @('node_modules', '.git', 'data', 'assets', 'config', 'logs')
Get-ChildItem -Path $Target -Force | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
    Write-Host "  删除 $($_.Name)"
    Remove-Item -Recurse -Force $_.FullName
}
Write-Host "  冗余文件已清除（保留 $($keep -join ' / ')）✓"

# ---- 5. 复制开发目录代码（Copy-Item，明确排除运行时目录）----
# 说明：不用 robocopy——其 /XD 排除对中文路径偶发失效会误复制 node_modules（近万文件）导致卡死。
Write-Host ''
Write-Host '==== 5. 复制源代码（Copy-Item）===='
$excludeDirs = @('node_modules', '.git', 'data', 'config', 'assets', 'logs')
Get-ChildItem -Path $Source -Force | Where-Object { $excludeDirs -notcontains $_.Name } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $Target -Recurse -Force
}
Write-Host '  代码复制完成 ✓'

# ---- 6. 设置测试网关端口（用 Node 改 JSON：避免 PowerShell Set-Content 写入 BOM 导致网关解析失败）----
Write-Host ''
Write-Host '==== 6. 设置测试网关端口 ===='
$cfgFile = Join-Path $Target 'config\gateway.json'
if (Test-Path $cfgFile) {
    node -e "const fs=require('fs');const p=process.argv[1];let s=fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');const c=JSON.parse(s);c.server=c.server||{};c.server.port=Number(process.argv[2]);fs.writeFileSync(p,JSON.stringify(c,null,2));console.log('  端口已写入 server.port='+c.server.port);" $cfgFile $TargetPort
    Write-Host "  已设置测试网关 server.port = $TargetPort ✓"
} else {
    Write-Warning '  未找到 config/gateway.json（首次启动将生成默认配置，端口由 GATEWAY_PORT 环境变量保证）'
}

# ---- 7. 安装依赖（增量补齐；依赖齐全时很快）----
Write-Host ''
Write-Host '==== 7. 安装依赖 ===='
Push-Location $Target
try {
    npm install --no-audit --no-fund 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Write-Warning "  npm install 退出码 $LASTEXITCODE（可尝试手动执行 npm install）" }
    else { Write-Host '  依赖就绪 ✓' }
} finally {
    Pop-Location
}

# ---- 8. 启动测试目录网关 ----
Write-Host ''
Write-Host '==== 8. 启动测试目录网关 ===='
$logsDir = Join-Path $Target 'logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir -Force | Out-Null }
$env:GATEWAY_PORT = "$TargetPort"   # env 覆盖优先级最高，与 config 保持一致
$outLog = Join-Path $logsDir 'gateway.out.log'
$errLog = Join-Path $logsDir 'gateway.err.log'
Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory $Target `
    -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-PortListen $TargetPort) { $ready = $true; break }
}
if (-not $ready) {
    $tail = if (Test-Path $errLog) { Get-Content $errLog -Tail 10 | Out-String } else { '(无错误日志)' }
    throw "测试网关未能在 $TargetPort 端口启动。错误日志末尾：`n$tail"
}
Write-Host "  测试网关已启动（端口 $TargetPort）✓"

# ---- 9. 部署验证 ----
Write-Host ''
Write-Host '==== 9. 部署验证 ===='
$pass = 0; $fail = 0

# 9.1 测试网关页面
try {
    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/agent" -UseBasicParsing -TimeoutSec 5
    Write-Host "  [PASS] /agent 页面 -> $($page.StatusCode)"
    $pass++
} catch { Write-Host "  [FAIL] /agent 页面: $_"; $fail++ }

# 9.2 新 LLM 端点（证明新代码部署成功；/api/* 受鉴权保护，带上 config 里的 authToken）
try {
    $authToken = ''
    if (Test-Path $cfgFile) {
        $cfgRead = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfgRead.server.authToken) { $authToken = $cfgRead.server.authToken }
    }
    $llmHeaders = @{ 'X-Gateway-Token' = $authToken }
    $llm = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/api/agent-theatre/llm-config" `
        -Headers $llmHeaders -UseBasicParsing -TimeoutSec 5
    Write-Host "  [PASS] /api/agent-theatre/llm-config -> $($llm.StatusCode)（新代码端点可用）"
    $pass++
} catch { Write-Host "  [FAIL] llm-config 端点: $_"; $fail++ }

# 9.3 开发 Agent 服务已停止
if (Test-PortListen $DEV_AGENT_PORT) {
    Write-Host "  [FAIL] 开发 Agent 服务(4321)仍在监听"
    $fail++
} else {
    Write-Host "  [PASS] 开发 Agent 服务(4321)已完全停止"
    $pass++
}

# 9.4 旧测试网关已替换（TargetPort 上仅有一个监听进程，按 PID 去重避免 IPv4/IPv6 双栈误报）
$listenerPids = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
$listenerPids = @($listenerPids)
if ($listenerPids.Count -eq 1) {
    Write-Host "  [PASS] 测试网关为唯一监听者（旧网关已替换，PID $($listenerPids[0])）"
    $pass++
} elseif ($listenerPids.Count -eq 0) {
    Write-Host "  [FAIL] $TargetPort 无监听进程"
    $fail++
} else {
    Write-Host "  [FAIL] $TargetPort 存在多个监听进程（新旧网关并存）: $($listenerPids -join ', ')"
    $fail++
}

Write-Host ''
Write-Host "==== 验证汇总: $pass 通过 / $fail 失败 ===="
Write-Host "测试网关   : http://127.0.0.1:$TargetPort"
Write-Host "Agent 前端 : http://127.0.0.1:$TargetPort/agent"
Write-Host ''
Write-Host '浏览器验证步骤：'
Write-Host "  1. 打开 http://127.0.0.1:$TargetPort/agent"
Write-Host '  2. 点击右上角 ⚙ 设置 → 连接配置，网关地址填：'
Write-Host "     http://127.0.0.1:$TargetPort"
Write-Host '  3. 保存连接后，LLM 配置区即可正常获取模型 / 保存配置（不再 404）'
Write-Host ''
if ($fail -gt 0) { exit 1 } else { exit 0 }
