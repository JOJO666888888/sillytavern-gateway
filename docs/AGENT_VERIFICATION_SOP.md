# 智能体验证与同步标准化流程（SOP）

> **适用场景**：智能体完成代码修改任务后，必须按本流程执行验证、同步和部署操作。
> **核心原则**：先验证再同步，先同步再部署；每一步都有明确的通过标准，未通过不得进入下一步。
> **版本**：v1.1 ｜ **最后更新**：2026-08-06
> **同步状态**：已按当前 dev 源码实现逐项核验；不一致项与修改明细见 `docs/AGENT_VERIFICATION_SOP_report.md`

---

## 0. 前置知识：三份代码副本

本项目存在三份代码副本，智能体必须始终清楚当前操作的是哪一份：

| 副本 | 路径 | 用途 | 特征 |
|------|------|------|------|
| **dev 源码** | `d:\预设\sillytavern-gateway` | 开发编辑、git 版本控制 | 纯净源码，无 config/data/assets/node_modules |
| **运行实例** | `D:\QQbot\sillytavern-gateway` | 实际运行的网关服务 | 含 config/data/assets/node_modules，端口 3210 |
| **ST 部署副本** | `D:\SillTavern\public\scripts\extensions\third-party\sillytavern-gateway` | SillyTavern 前端加载的扩展面板 | 含完整代码（server/test 等），前端入口 |

**关键规则**：
- 所有代码修改**先在 dev 源码完成**，再同步到其他两份副本
- 运行实例的 `config/`、`data/`、`assets/`、`node_modules/` 是运行时数据，**不得删除或覆盖**
- ST 部署副本的面板文件（`index.js`、`panel.html`、`style.css`）是用户直接看到的 UI，必须与 dev 源码一致

---

## 1. 任务完成后的结果验证

### 1.1 功能测试

#### 1.1.1 单元测试（必执行）

```powershell
cd D:\QQbot\sillytavern-gateway
npm test
```

**通过标准**：
- `ℹ fail 0` — 零失败
- 允许的已知 flaky 测试：无（所有测试必须通过）
- 若 `agent-api.test.js` 偶发"连接被拒 / 临时端口占用"错误（该组测试每次启动临时 HTTP 服务），重跑一次；连续两次失败则判定为回归

#### 1.1.2 ⚠️ 测试安全须知

> **真机事故**：`npm test` 中的 `security-config.test.js` 和 `plugin-system.test.js` 的 `after()` 钩子会清理测试产生的 `config/` 和 `logs/` 目录。历史上曾有用相对路径 `fs.rmSync('data')` 删除 `data/` 的 bug（已修复），但运行测试前仍须确认：

- `data/` 目录在测试后必须仍然存在且文件数量不变
- `config/gateway.json` 在测试后可能被删除（由 `security-config.test.js` 清理），需通过 API 恢复（见 [4.2](#42-config-丢失)）
- **绝对不要**在运行实例目录中连续多次跑 `npm test` 而不检查 `data/` 完整性

#### 1.1.3 API 端到端验证

根据修改的模块选择对应的验证项：

**A. 资产同步类（修改了 sync/import/export 逻辑时必执行）**

```powershell
$token = "<从 config/gateway.json 的 server.authToken 获取>"
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

# 1. 错误路径校验：不存在的 ST 路径应返回 400
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:3210/api/runtime/sync-from-st" `
        -Method POST -Headers $headers -Body '{"stPath":"D:\\QQbot"}' -ErrorAction Stop
    "FAIL: 未拒绝错误路径"
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 400) { "PASS: 错误路径被 400 拒绝" } else { "FAIL: 意外状态码 $code" }
}

# 2. 正确路径同步：应返回 200 且各项计数 > 0
$r = Invoke-RestMethod -Uri "http://127.0.0.1:3210/api/runtime/sync-from-st" `
    -Method POST -Headers $headers -Body '{"stPath":"D:\\SillTavern"}'
"角色卡 $($r.characters) / 世界书 $($r.worldbooks) / 预设 $($r.presets) / 存档 $($r.chats)"
```

**通过标准**：
- 错误路径返回 400
- 正确路径返回 200，且修改涉及的资产类型计数 > 0
- `data/chats/` 目录下 .jsonl 文件数与 API 返回的 `chats` 计数一致

**B. 资产导入类（修改了 upload/import 逻辑时必执行）**

```powershell
# 验证白名单包含所有资产类型（资产列表由 GET /api/runtime/status 返回 assets 字段：
# characters / worldbooks / presets / archives 四类）
$headers = @{ Authorization = "Bearer $token" }
$status = Invoke-RestMethod -Uri "http://127.0.0.1:3210/api/runtime/status" `
    -Method GET -Headers $headers
$assets = $status.assets
# 确认 $assets 包含 characters / worldbooks / presets / archives 四类
# 注意：/api/runtime/status 需 runtime.enabled=true 才返回 assets（未启用仅返回 enabled:false）；
# 轻量三类列表（角色卡/世界书/预设，无需 runtime）可用 GET /api/agent-theatre/assets
```

**C. 前端面板类（修改了 panel.html 或 index.js 时必执行）**

- 在 SillyTavern 中打开网关面板，确认新按钮/选项可见
- 验证文件上传 accept 属性包含正确的扩展名（`.png,.json,.jsonl`）
- 验证事件绑定（如 `gateway_rt_import_chat`）在点击时触发

#### 1.1.4 进程验证

```powershell
# 确认网关进程正在运行且加载的是新代码
netstat -ano | findstr :3210
# 记录 PID，与启动时的 PID 比对
```

**关键陷阱**：端口 3210 上可能存在旧进程。修改代码后必须**先停旧进程再启新进程**，否则 API 请求会打到旧代码上。验证方法：

```powershell
# 获取 3210 端口的监听 PID
$pid = (Get-NetTCPConnection -LocalPort 3210 -State Listen).OwningProcess
# 确认该 PID 的启动时间晚于代码修改时间
(Get-Process -Id $pid).StartTime
```

### 1.2 性能测试

| 指标 | 标准 | 工具 |
|------|------|------|
| 网关启动时间 | < 5s（从 `node server/index.js` 到 `HTTP API 服务已启动`） | 日志时间戳差值 |
| API 响应延迟 | 同步 API < 10s（60 个存档），资产列表 < 500ms | `Measure-Command` |
| npm test 执行时间 | < 10s | npm test 输出的 `duration_ms` |
| 内存占用 | 空闲状态 < 200MB | `Get-Process node` 的 `WorkingSet64` |

### 1.3 兼容性测试

| 维度 | 检查项 | 标准 |
|------|--------|------|
| **操作系统** | Windows 行尾兼容性 | 测试代码的 `stripComments` 使用 `split(/\r?\n/)`；生产代码不依赖行尾格式 |
| **路径编码** | 中文路径/文件名 | 含中文的角色名、存档名能正确同步和加载 |
| **Node.js 版本** | >= 20 | `package.json` 的 `engines.node` 要求 |
| **ST 版本兼容** | 面板 API 调用 | `apiRequest` 封装兼容 ST 的 fetch 拦截机制 |
| **资产格式** | ST JSONL 存档格式 | 首行元数据 + 消息行，`ChatArchive` 类能正确解析 |
| **三副本一致性** | 关键文件内容完全相同 | 修改涉及的文件在三份副本中 `diff` 结果为空 |

---

## 2. 开发环境(dev)源码同步

### 2.1 代码提交规范

```powershell
cd d:\预设\sillytavern-gateway

# 1. 查看变更
git status
git diff

# 2. 暂存（明确指定文件，不用 git add -A）
git add server/index.js server/runtime/pipeline.js index.js panel.html

# 3. 提交（遵循项目历史风格）
git commit -m "$(cat <<'EOF'
<类型>: <简述>

<详细说明：修改了什么、为什么修改、影响范围>
EOF
)"
```

**提交类型**：`fix`（修复）、`feat`（新功能）、`refactor`（重构）、`test`（测试）、`docs`（文档）

**禁止事项**：
- 不提交 `config/gateway.json`（含 token 等凭据）
- 不提交 `data/`（含用户聊天存档）
- 不提交 `node_modules/`
- 不用 `git add -A` 或 `git add .`（防止误提交敏感文件）

### 2.2 版本控制规范

- **分支**：在 `main` 分支上直接开发（项目当前为单人开发模式）
- **不自动 push**：仅在用户明确要求时执行 `git push`
- **不自动 commit**：仅在用户明确要求时执行 `git commit`
- **不修改 git config**：不执行 `git config --global` 等命令
- **不强制 push**：不执行 `git push --force`，尤其不 push 到 main

### 2.3 dev 源码自检清单

提交前确认：
- [ ] `npm test` 全部通过
- [ ] 无 `console.log` 调试残留（用 `logger.info/debug` 代替）
- [ ] 无硬编码的 token / API key / 绝对路径
- [ ] 新增的 `fs.rmSync` 使用绝对路径（基于 `__dirname`），不得使用相对路径
- [ ] 测试清理钩子不包含 `data/` 目录

---

## 3. ST 部署副本同步

### 3.1 部署脚本执行（dev → 运行实例）

使用项目内置部署脚本：

```powershell
cd d:\预设\sillytavern-gateway
powershell -ExecutionPolicy Bypass -File scripts\deploy-to-test.ps1
```

**脚本自动完成**：
1. 校验源目录有效性
2. 停止开发目录 Agent 服务（端口 4321）
3. 停止测试目录旧网关（端口 3210）
4. 清空测试目录冗余文件（保留 `node_modules/.git/data/assets/config/logs`）
5. 复制源代码到测试目录
6. 设置测试网关端口
7. 安装依赖（`npm install`）
8. 启动测试网关
9. 部署验证（4 项检查）

**部署后验证标准**（脚本自动检查）：
- [PASS] `/agent` 页面返回 200
- [PASS] `/api/agent-theatre/llm-config` 返回 200（证明新代码部署成功）
- [PASS] 开发 Agent 服务（4321）已停止
- [PASS] 测试网关为 3210 端口唯一监听者

### 3.2 ST 部署副本手动同步

部署脚本只覆盖**运行实例**。ST 部署副本（前端面板）需手动同步：

```powershell
$dev = "d:\预设\sillytavern-gateway"
$st  = "D:\SillTavern\public\scripts\extensions\third-party\sillytavern-gateway"

# 同步前端文件（用户直接看到的 UI）
Copy-Item "$dev\index.js"     "$st\index.js"     -Force
Copy-Item "$dev\panel.html"   "$st\panel.html"   -Force
Copy-Item "$dev\style.css"    "$st\style.css"    -Force
Copy-Item "$dev\manifest.json" "$st\manifest.json" -Force

# 如果修改了 server/ 或 test/ 下的文件，也需要同步
# Copy-Item "$dev\server\runtime\pipeline.js" "$st\server\runtime\pipeline.js" -Force
# ...其他修改的文件
```

**注意**：`Copy-Item` 可能被安全白名单拦截（`PathNotAllowed`）。此时改用 `SearchReplace` 工具逐文件修改目标副本。

### 3.3 环境配置检查

部署后检查运行实例的环境完整性：

```powershell
$target = "D:\QQbot\sillytavern-gateway"

# 1. config 完整性
Test-Path "$target\config\gateway.json"
# 若 False，需通过 API 恢复（见 4.2）

# 2. data 完整性
Test-Path "$target\data\chats"
(Get-ChildItem "$target\data\chats" -Filter *.jsonl -ErrorAction SilentlyContinue | Measure-Object).Count

# 3. assets 完整性
(Get-ChildItem "$target\assets\characters" -ErrorAction SilentlyContinue | Measure-Object).Count
(Get-ChildItem "$target\assets\worldbooks" -ErrorAction SilentlyContinue | Measure-Object).Count
(Get-ChildItem "$target\assets\presets" -ErrorAction SilentlyContinue | Measure-Object).Count

# 4. node_modules 完整性
Test-Path "$target\node_modules\express"
```

### 3.4 三副本一致性验证

```powershell
$dev = "d:\预设\sillytavern-gateway"
$run = "D:\QQbot\sillytavern-gateway"
$st  = "D:\SillTavern\public\scripts\extensions\third-party\sillytavern-gateway"

# 对本次修改的每个文件，验证三副本内容一致
$files = @("server\index.js", "server\runtime\pipeline.js", "index.js", "panel.html")
foreach ($f in $files) {
    $h1 = (Get-FileHash "$dev\$f" -Algorithm MD5).Hash
    $h2 = (Get-FileHash "$run\$f" -Algorithm MD5).Hash
    $h3 = (Get-FileHash "$st\$f"  -Algorithm MD5).Hash
    if ($h1 -eq $h2 -and $h2 -eq $h3) {
        Write-Host "  [OK] $f"
    } else {
        Write-Host "  [MISMATCH] $f : dev=$h1 run=$h2 st=$h3"
    }
}
```

---

## 4. 异常情况处理机制及回滚策略

### 4.1 进程管理异常

**现象**：修改代码后 API 行为未变化（打到旧进程）

**排查步骤**：
1. `netstat -ano | findstr :3210` — 确认端口监听者 PID
2. `(Get-Process -Id <PID>).StartTime` — 确认启动时间是否晚于代码修改时间
3. 若为旧进程：停止它，重新启动

```powershell
# 精确停止 3210 端口的监听进程
Get-NetTCPConnection -LocalPort 3210 -State Listen | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force
}
Start-Sleep -Seconds 2

# 重新启动
cd D:\QQbot\sillytavern-gateway
Start-Process -FilePath 'node' -ArgumentList 'server/index.js' `
    -WorkingDirectory $PWD -WindowStyle Hidden `
    -RedirectStandardOutput 'logs\gateway.out.log' `
    -RedirectStandardError 'logs\gateway.err.log'
```

**验证**：等待 `HTTP API 服务已启动` 日志出现后，用 API 请求验证新行为。

### 4.2 config 丢失

**原因**：`npm test` 的 `security-config.test.js` `after()` 钩子会删除 `config/` 目录（预期行为，用于清理测试产生的配置）。

**恢复方法**（运行中的网关仍持有配置内存副本）：

```powershell
$token = "<已知的 authToken>"
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

# 1. GET 当前配置（脱敏的，token 显示为 ***xxxx）
$cfg = Invoke-RestMethod -Uri "http://127.0.0.1:3210/api/gateway/config" -Method GET -Headers $headers

# 2. POST 回去触发 save()（脱敏掩码受保护，真实 token 不会被覆盖）
$body = $cfg | ConvertTo-Json -Depth 10 -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:3210/api/gateway/config" -Method POST -Headers $headers -Body $body

# 3. 验证文件已恢复
Test-Path "D:\QQbot\sillytavern-gateway\config\gateway.json"
```

**前提**：网关进程仍在运行。若网关已停止且 config 文件已丢失，需手动重建 config 或重新部署。

### 4.3 data 目录被误删

**原因**：历史 bug（已修复）— 测试用相对路径 `fs.rmSync('data')` 删除了运行时数据。

**恢复方法**：
1. 确认 `data/` 目录状态：`Test-Path "D:\QQbot\sillytavern-gateway\data"`
2. 重建目录：`New-Item -ItemType Directory -Path "D:\QQbot\sillytavern-gateway\data\chats" -Force`
3. 从 ST 重新同步：`POST /api/runtime/sync-from-st {"stPath":"D:\\SillTavern"}`
4. 验证文件数：`(Get-ChildItem "D:\QQbot\sillytavern-gateway\data\chats" -Filter *.jsonl).Count`

**注意**：`sessions.json`（会话持久化）若被删除无法恢复，用户需重新 `/new` 创建会话。

### 4.4 回滚策略

**场景 A：代码修改导致功能回归**

```powershell
# 1. 停止当前网关
Get-NetTCPConnection -LocalPort 3210 -State Listen | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force
}

# 2. git 回滚到上一个提交
cd d:\预设\sillytavern-gateway
git log --oneline -5          # 确认回滚目标
git checkout <commit-hash> -- <文件路径>

# 3. 重新部署
powershell -ExecutionPolicy Bypass -File scripts\deploy-to-test.ps1
```

**场景 B：部署后网关无法启动**

```powershell
# 1. 查看错误日志
Get-Content "D:\QQbot\sillytavern-gateway\logs\gateway.err.log" -Tail 20

# 2. 常见原因排查
#    - 端口被占：netstat -ano | findstr :3210
#    - config 损坏：检查 config/gateway.json 是否为合法 JSON
#    - 依赖缺失：cd D:\QQbot\sillytavern-gateway; npm install

# 3. 紧急回滚：用 git stash 保存当前修改，恢复上一个可运行版本
git stash
powershell -ExecutionPolicy Bypass -File scripts\deploy-to-test.ps1
```

**场景 C：npm test 破坏了运行时数据**

```powershell
# 1. 确认 data/ 是否存在
Test-Path "D:\QQbot\sillytavern-gateway\data"

# 2. 若被删除，重建目录并重新同步
New-Item -ItemType Directory -Path "D:\QQbot\sillytavern-gateway\data\chats" -Force
# 通过 API 重新同步（见 4.3）

# 3. 确认 config/ 是否存在
Test-Path "D:\QQbot\sillytavern-gateway\config\gateway.json"
# 若被删除，通过 API 恢复（见 4.2）

# 4. 重新运行 npm test 验证测试修复生效
cd D:\QQbot\sillytavern-gateway; npm test
```

---

## 5. 质量检查点

每个检查点必须全部通过才能进入下一阶段：

### CP1：代码修改完成

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 语法正确 | `node -c server/index.js`（或 `node --check`） | 无错误 |
| 无敏感信息泄露 | `grep -rn "sk-\|token\|apiKey" server/ --include="*.js"` | 仅在配置读取处出现 |
| 无调试残留 | `grep -rn "console\.log" server/ --include="*.js"` | 无结果（用 logger 代替） |
| 新增 rmSync 用绝对路径 | 检查 `fs.rmSync` 调用 | 第一个参数为变量或 `path.join(__dirname, ...)` |

### CP2：单元测试通过

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| npm test | `cd D:\QQbot\sillytavern-gateway; npm test` | `fail 0` |
| data 完整性 | `Test-Path data\chats` | True，文件数不变 |
| 打包安全扫描 | `npm test` 中 packaging.test.js | 无 "相对路径递归删除" 失败 |

### CP3：API 验证通过

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| 网关进程 | `netstat -ano \| findstr :3210` | 有监听，PID 启动时间晚于代码修改 |
| 错误路径拒绝 | `POST /api/runtime/sync-from-st {"stPath":"D:\\QQbot"}` | 400 |
| 正确路径同步 | `POST /api/runtime/sync-from-st {"stPath":"D:\\SillTavern"}` | 200，各项计数 > 0 |
| 文件落盘 | `Get-ChildItem data\chats -Filter *.jsonl` | 文件数 = API 返回的 chats 计数 |

### CP4：三副本同步完成

| 检查项 | 方法 | 通过标准 |
|--------|------|----------|
| dev → 运行实例 | `deploy-to-test.ps1` | 4 项验证全 PASS |
| dev → ST 副本 | 文件 hash 比对 | 三副本 MD5 一致 |
| config 恢复 | `Test-Path config\gateway.json` | True |
| 前端面板 | 在 ST 中打开网关面板 | 新功能/按钮可见可交互 |

---

## 6. 成功验证标准（最终汇总）

任务完成的**充要条件**（全部满足）：

1. **`npm test` 零失败** — `ℹ pass N / ℹ fail 0`
2. **API 端到端验证通过** — 修改涉及的接口行为符合预期
3. **进程验证通过** — 3210 端口的监听进程启动时间晚于最后一次代码修改
4. **三副本一致性** — 修改的文件在 dev / 运行实例 / ST 副本中内容完全相同
5. **运行时数据完整** — `data/chats/` 文件数不变，`config/gateway.json` 存在且 token 不变
6. **部署验证通过** — `deploy-to-test.ps1` 的 4 项检查全 PASS

---

## 7. 工具速查

| 工具/命令 | 用途 | 关键参数 |
|-----------|------|----------|
| `npm test` | 单元测试 | `--test --test-force-exit test/*.test.js` |
| `deploy-to-test.ps1` | dev → 运行实例部署 | `-Source`, `-Target`, `-TargetPort` |
| `npm run token` | 获取当前 authToken | 读取 `config/gateway.json` |
| `Invoke-RestMethod` | API 调用 | `-Headers @{Authorization="Bearer $token"}` |
| `Get-NetTCPConnection` | 端口/进程检查 | `-LocalPort 3210 -State Listen` |
| `Get-FileHash` | 文件一致性比对 | `-Algorithm MD5` |
| `SearchReplace` (Trae) | 跨副本文件修改 | 当 `Copy-Item` 被安全策略拦截时使用 |

---

## 8. 历史教训记录

> 以下问题均源自真机事故，新智能体必须引以为戒。

| # | 事故 | 根因 | 修复 | 影响 |
|---|------|------|------|------|
| 1 | `npm test` 删除 `data/` | `plugin-system.test.js` 用相对路径 `fs.rmSync('data')` | 改为绝对路径 + 排除 `data/` | 聊天存档、会话历史全丢 |
| 2 | `npm test` 删除 `config/` | `security-config.test.js` after() 钩子清理（预期行为） | 部署后通过 API 恢复 | token 丢失，需重新填面板 |
| 3 | API 验证打到旧进程 | 杀错 PID，新进程因端口占用启动失败 | 精确杀 3210 监听者后重启 | 验证结果误导 |
| 4 | 同步 0/0/0 | 前端预填相对路径默认值 `../../../../..` | 改为空字符串 + 0 结果警告 | 用户误以为同步成功 |
| 5 | `stripComments` 误报 | Windows `\r\n` 行尾，`split('\n')` 残留 `\r` | 改为 `split(/\r?\n/)` | 安全扫描测试假阳性 |
| 6 | 同步后 ENOENT | 目录被测试删除，`copyFileSync` 找不到目标 | 同步前 `mkdirSync(dir, {recursive:true})` | 同步失败 |
| 7 | 三副本不一致 | 只改了运行实例，ST 副本未同步 | 标准化三副本同步流程 | 用户看到旧面板 |
