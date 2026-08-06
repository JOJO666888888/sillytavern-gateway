# AGENT_VERIFICATION_SOP 文档验证与同步报告

> 验证对象：`docs/AGENT_VERIFICATION_SOP.md`
> 验证日期：2026-08-06 ｜ 验证方式：文档逐项对照 dev 源码实现（`d:\预设\sillytavern-gateway`）＋ 运行实例（`D:\QQbot\sillytavern-gateway`）＋ ST 副本（`D:\SillTavern\...\sillytavern-gateway`）
> 结论：**发现 4 项不一致，其中 2 项内容错误已修正、1 项文档管理缺口已补齐、1 项流程状态需提示**；文档版本已升至 v1.1 并完成三副本同步。

---

## 1. 核验范围与方法

| 核验项 | 方法 |
|---|---|
| 文档结构与格式 | 章节编号 / 表格 / 代码块 / 命令示例完整性 |
| 术语与路径 | 三副本路径、端口、端点名、脚本名逐字对照实际文件 |
| 流程与实际实现一致性 | `server/index.js` / `server/agent-api.js` 端点源码；`scripts/deploy-to-test.ps1`；`package.json` scripts；测试 `after()` 清理钩子；git 仓库状态 |
| 内容完整性 | 对照 package.json 脚本、部署脚本成功验证标准、历史教训记录 |

## 2. 核验通过项（与实现一致）

| # | SOP 表述 | 实现证据 |
|---|---|---|
| 1 | 三副本路径（dev / 运行实例 / ST 副本） | 三目录均存在且结构一致 |
| 2 | `npm test` = `node --test --test-force-exit test/*.test.js` | `package.json` scripts.test 一致 |
| 3 | `npm run token` 读取 authToken | `package.json` scripts.token → `scripts/show-token.js` 存在 |
| 4 | `POST /api/runtime/sync-from-st`：错误路径 400、正确路径 200 且返回四类计数 | `server/index.js` L391-412：缺失 stPath/路径不存在/缺 `data/default-user` 均 400；成功返回 `characters/worldbooks/presets/chats` 计数 |
| 5 | `GET/POST /api/gateway/config`（config 丢失恢复） | `server/index.js` L203/L211 存在，掩码回传保护已实现 |
| 6 | `security-config.test.js` / `plugin-system.test.js` 的 `after()` 清理 `config/` + `logs/`（不含 `data/`） | 两测试文件 after 钩子仅 `rmSync(config|logs)`，且基于 `__dirname` 绝对路径双保险 |
| 7 | `deploy-to-test.ps1` 行为（停 4321 → 停 3210 → 复制保留 node_modules/.git/data/assets/config/logs → npm install → 启动 → 4 项验证） | 脚本头注释与实现一致；4 项验证含 `/agent` 200、`/api/agent-theatre/llm-config` 200（端点存在于 `agent-api.js` L883）、4321 停止、3210 唯一监听 |
| 8 | Node.js >= 20 | `package.json` engines.node |
| 9 | dev 为 git 仓库、单人 main 分支开发 | `git rev-parse --is-inside-work-tree` = true |
| 10 | 性能标准（npm test < 10s 等） | 实测 `npm test` 约 4.5s（990 用例） |

## 3. 发现的不一致项与处理

### 不一致 #1（内容错误，已修正）：资产列表端点过时
- **位置**：SOP 1.1.3 **B. 资产导入类**
- **原文**：`GET /api/runtime/assets` 返回四类资产。
- **实际**：`server/index.js` 中**不存在** `GET /api/runtime/assets` 端点。资产列表由 `GET /api/runtime/status`（L275-285，返回 `assets` 字段含 characters/worldbooks/presets/archives）提供；`/api/runtime/assets/:type` 仅 POST（上传）与 DELETE（删除）。
- **修改**：改为 `GET /api/runtime/status`，并注明需 `runtime.enabled=true` 才返回 assets；补充轻量替代 `GET /api/agent-theatre/assets`（无需 runtime）。

### 不一致 #2（内容错误，已修正）："bad port 错误"无事实依据
- **位置**：SOP 1.1.1 通过标准。
- **原文**：`若出现 agent-api.test.js 的 bad port 错误，重跑一次`。
- **实际**：全测试目录 grep 无 `bad port` / `EADDRINUSE` 相关内容；agent-api 测试每次启动**临时 HTTP 服务**（`withServer` 用 `server.listen(0)` 随机端口）。
- **修改**：改为准确表述——`agent-api.test.js` 偶发"连接被拒 / 临时端口占用"时可重跑一次；连续两次失败判定回归。

### 不一致 #3（文档管理缺口，已补齐）：无版本/同步状态头
- **位置**：文档头部。
- **实际**：文档无版本、更新日期与同步状态声明，不符合项目文档管理规范（其它 docs 均带版本/适用说明头）。
- **修改**：新增头部 `版本 v1.1 ｜ 最后更新 2026-08-06 ｜ 同步状态` 并指向本报告。

### 不一致 #4（流程状态提示，非文档错误）：SOP 文档此前仅存在于 dev，且运行/ST 副本落后于 dev
- **实际**：`AGENT_VERIFICATION_SOP.md` 此前仅存在于 dev（`docs/` 未同步）；且运行实例与 ST 副本缺失本会话新增文件（`server/utils/auth-middleware.js`、`plugins/agent-framework/tools/character-tools.js`、`server/agent/option-utils.js`、`test/p3-optimizations.test.js`、`test/agent-character-isolation.test.js` 等）与多处修改。
- **处理**：本次已将更新后的 SOP 同步至运行实例与 ST 副本的 `docs/`（三副本 MD5 一致）。
- **提示**：代码层面的三副本一致需按 SOP 3.1 执行 `scripts\deploy-to-test.ps1` 并手动同步前端文件（ST 副本），本次**未执行部署**（避免在未获指令时改动运行实例）。

## 4. 同步修改明细

| 文件 | 副本 | 修改内容 |
|---|---|---|
| `docs/AGENT_VERIFICATION_SOP.md` | dev | ① 新增版本/最后更新/同步状态头；② 修正 1.1.1 bad port 表述；③ 修正 1.1.3 B 端点为 `/api/runtime/status`（含 runtime 前提与轻量替代） |
| `docs/AGENT_VERIFICATION_SOP.md` | 运行实例 `D:\QQbot\...` | 与 dev 逐字一致（MD5 相同） |
| `docs/AGENT_VERIFICATION_SOP.md` | ST 副本 `D:\SillTavern\...` | 与 dev 逐字一致（MD5 相同） |
| `docs/AGENT_VERIFICATION_SOP_report.md` | dev（本次新建） | 本报告 |

## 5. 三副本一致性验证

```
d:\预设\sillytavern-gateway\docs\AGENT_VERIFICATION_SOP.md   → MD5 3E4F3BB588582...
D:\QQbot\sillytavern-gateway\docs\AGENT_VERIFICATION_SOP.md → MD5 3E4F3BB588582...（一致）
D:\SillTavern\...\docs\AGENT_VERIFICATION_SOP.md           → MD5 3E4F3BB588582...（一致）
```

## 6. 结论与建议

- 文档内容现已与系统实现**逐项一致**，版本 v1.1 完成三副本同步，符合项目文档管理规范。
- 建议：① 下一次发布前执行 `deploy-to-test.ps1` 将 dev 最新代码部署至运行实例，并手动同步 ST 副本前端文件；② 将本 SOP 纳入后续智能体任务的强制前置阅读项。
