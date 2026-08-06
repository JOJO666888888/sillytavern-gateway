@echo off
setlocal enabledelayedexpansion
title SillyTavern Gateway 一键启动

REM ============================================================
REM 一键启动脚本（sillytavern-gateway 根目录）
REM 功能：检测远程更新 -> 有更新则拉取（失败跳过）-> 启动项目
REM 用法：双击运行
REM 注意：块内 echo 一律使用全角括号（），避免 cmd 解析半角括号导致脚本崩溃
REM ============================================================

echo ========================================
echo   SillyTavern Gateway 一键启动
echo ========================================
echo.

REM ---- 0. 检查 Node.js ----
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js
    echo 请安装 Node.js 18 或以上版本: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM ---- 检查 Node.js 版本（需要 v18+）----
set "NODE_MAJOR=0"
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
set "NODE_MAJOR=!NODE_VER:v=!"
if !NODE_MAJOR! lss 18 (
    echo [错误] Node.js 版本过低（当前 !NODE_VER!.x），需要 v18 以上。
    echo 下载地址: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo Node.js !NODE_VER!.x  OK
echo.

REM ---- 1. 定位项目目录（本脚本应位于 sillytavern-gateway 根目录）----
set "GW_DIR=%~dp0"
if "!GW_DIR:~-1!"=="\" set "GW_DIR=!GW_DIR:~0,-1!"
if not exist "!GW_DIR!\server\index.js" (
    echo [错误] 未找到 server\index.js。
    echo 请确认本脚本位于 sillytavern-gateway 项目根目录下。
    echo.
    pause
    exit /b 1
)
echo [1/5] 项目目录: !GW_DIR!
echo.

REM ---- 2. 清理占用 3210 端口的旧进程 ----
echo [2/5] 清理端口 3210...
set "OLD_PID="
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3210" ^| findstr "LISTENING"') do (
    set "OLD_PID=%%p"
)
if defined OLD_PID (
    echo     停止旧进程 PID=!OLD_PID!...
    taskkill /PID !OLD_PID! /F >nul 2>&1
    ping -n 2 127.0.0.1 >nul
    echo     已停止。
) else (
    echo     端口空闲。
)
echo.

REM ---- 3. 检测远程仓库更新（任何失败都跳过更新，直接启动）----
echo [3/5] 检测远程更新...
pushd "!GW_DIR!"
if exist ".git" (
    git fetch origin main >nul 2>&1
    if errorlevel 1 (
        echo     [警告] 无法连接远程仓库（可能无网络），跳过更新，直接启动。
    ) else (
        set "AHEAD=0"
        for /f "delims=" %%c in ('git rev-list HEAD...origin/main --count 2^>nul') do set "AHEAD=%%c"
        if "!AHEAD!"=="0" (
            echo     已是最新版本，无需更新。
        ) else (
            echo     检测到 !AHEAD! 个新提交，正在拉取更新...
            git pull origin main >nul 2>&1
            if errorlevel 1 (
                echo     [警告] 拉取更新失败（可能存在本地修改），跳过更新，直接启动。
            ) else (
                echo     更新成功。
            )
        )
    )
) else (
    echo     非 Git 仓库，跳过更新检测。
)
popd
echo.

REM ---- 4. 检查依赖 ----
echo [4/5] 检查依赖...
if not exist "!GW_DIR!\node_modules" (
    echo     首次运行，正在安装依赖（可能需要几分钟）...
    pushd "!GW_DIR!"
    call npm install
    set "NPM_ERR=!errorlevel!"
    popd
    if !NPM_ERR! neq 0 (
        echo     [错误] 依赖安装失败。
        echo     排查: 1）检查网络  2）执行 npm config set registry https://registry.npmmirror.com
        echo.
        pause
        exit /b 1
    )
    echo     依赖安装完成。
) else (
    echo     依赖已存在。
)
echo.

REM ---- 5. 启动项目 ----
echo [5/5] 启动 SillyTavern Gateway...
echo.
echo     HTTP API : http://127.0.0.1:3210
echo     Agent 前端: http://127.0.0.1:3210/agent
echo     日志文件 : !GW_DIR!\logs\output.log
echo ========================================
echo.

if not exist "!GW_DIR!\logs" mkdir "!GW_DIR!\logs" >nul 2>&1

pushd "!GW_DIR!"
start "SillyTavern Gateway Core" /min cmd /c "node server\index.js 2>>logs\output.log & echo. & echo [Gateway stopped] & pause"
popd

echo 网关已在后台最小化窗口运行。
echo 日志: !GW_DIR!\logs\output.log
echo.

REM ---- 询问是否保持本窗口 ----
:ASK_KEEP
set "KEEP="
set /p "KEEP=是否保持本窗口开启（Y=保持 N=关闭）: "
if /i "!KEEP!"=="Y" goto :KEEP_WINDOW
if /i "!KEEP!"=="N" goto :CLOSE_WINDOW
echo 请输入 Y 或 N。
goto :ASK_KEEP

:KEEP_WINDOW
echo.
echo 窗口保持开启，输入 exit 可关闭本窗口。
cmd /k
goto :EOF

:CLOSE_WINDOW
echo 再见。
exit /b 0
