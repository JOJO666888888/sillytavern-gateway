# 网关程序改进需求文档

> 本文档基于开发 `option-splitter`（选项拆分发送）插件时遇到的实际局限，归纳出对 SillyTavern 多平台网关本身的改进建议。
> 所有建议均以「让插件开发者无需修改网关源码即可实现功能」为出发点，按优先级与实施难度分级。
> 文档同时适用于网关维护者评估改进方向，以及插件开发者了解当前架构边界。

---

## 一、背景与问题陈述

### 1.1 触发场景

`option-splitter` 插件需要实现：AI 回复到达后，先把「正文」作为一条消息发出，再逐条补发「选项」（Galgame 式交互）。补发的选项消息必须：

1. 走出站通道（经适配器真正发送到平台）
2. 不被本插件自己的过滤器再次拦截（避免无限递归）
3. 不被 15 秒去重窗口误杀（多个选项内容可能相同）
4. 可被其它过滤器（如 `regex-filter`）正常清洗

在实现过程中，发现网关当前架构存在 4 类局限，迫使插件采用「标记属性递归守卫」「异步 setTimeout 补发」「空正文返回 null 丢弃」等 workaround，增加了插件复杂度，也留下了隐蔽的故障路径。

### 1.2 改进目标

- 让「补发衍生消息」成为一等公民，无需 hack
- 让插件配置 UI 由 `plugin.json` 声明式驱动，无需手改 `panel.html`
- 让过滤器链具备显式的「来源标识」与「放行语义」
- 让去重机制可被插件按场景豁免

---

## 二、当前架构局限（证据基线）

### 2.1 `sendDirect()` 不绕过过滤器链

**位置**：`server/gateway-core.js` 的 `sendDirect(message)` 方法。

**现状**：

```javascript
async sendDirect(message) {
    this.addMessageLog('outbound', message);
    return await this.dispatchOutbound(message); // 仍调用 applyOutboundFilters
}
```

`dispatchOutbound` 内部第一步即 `applyOutboundFilters(message)`，与 `sendMessage()` 走的是同一条过滤路径（仅跳过队列）。

**影响**：插件无法用 `sendDirect` 补发「已经处理过的衍生消息」。`option-splitter` 不得不给补发消息打 `_optionSplitterPassthrough = true` 标记，在自己的过滤器入口检测该标记并放行。这种模式：

- 是插件私有约定，无法跨插件协作（其它插件不知道这个标记的含义）
- 标记属性会随消息对象一路传递到适配器，污染出站数据
- 若有多个插件都补发衍生消息，每个都要发明自己的标记，过滤器入口会堆积一堆 `if (msg._xxxPassthrough)` 判断

### 2.2 15 秒去重窗口不可豁免

**位置**：`server/gateway-core.js` 的 `dispatchOutbound` 方法。

**现状**：以 `platform + chatId + content` 计算哈希，15 秒内相同哈希的消息被静默丢弃。

**影响**：当 AI 输出多个内容完全相同的选项（如 `>选项一：沉默`、`>选项二：沉默`，文案相同），`option-splitter` 补发时第二条会被去重吞掉，用户看到选项数量减少。插件无任何 API 可标记「这条是有意重复的，请放行」。

### 2.3 插件配置 UI 必须手改 `panel.html`

**位置**：`panel.html` + `index.js` 前端扩展。

**现状**：`plugin.json` 已声明 `config` schema（字段名、类型、默认值、描述），但前端面板并未消费该 schema。每个插件的配置 UI 都要在 `panel.html` 里手写一段 HTML、在 `index.js` 里手写 `loadXxxConfig / saveXxxConfig / bindXxxEvents` 三件套，并在 `initGatewayPanel()` 和 `refreshPanelData()` 里挂载。

**影响**：

- 用户「从 GitHub 安装插件」后，插件功能可用，但**没有配置界面**（除非网关主仓库同步合并了对应的面板代码）。这违背了「热插拔」的承诺。
- 第三方插件作者无法独立交付完整体验，必须向网关主仓库提 PR 改 `panel.html`，破坏了插件生态的解耦。
- 同一段配置逻辑（开关、数字输入、文本输入）在面板里反复手写，维护成本高。

### 2.4 过滤器优先级为隐式约定

**位置**：`addOutboundFilter(fn, { priority })`。

**现状**：priority 数字升序，但数字本身没有语义。`option-splitter` 设 5、`regex-filter` 设 10，是开发者口头约定「先拆分再清洗」。新插件不知道该选什么数字，容易撞车。

**影响**：当多个第三方插件同时介入出站链，priority 冲突时行为不可预测，且无 API 查询当前已注册的过滤器及其顺序。

### 2.5 衍生消息缺乏「血缘」标识

**现状**：补发的选项消息与原始 AI 回复之间没有结构化的关联字段。`OutboundMessage` 只有 `platform / chatId / chatType / content / mediaUrls / replyToId / metadata`，`metadata` 未被网关核心消费。

**影响**：

- 无法做「选项是哪条正文衍生的」追溯
- 适配器无法对衍生消息采取差异化策略（如 Telegram 把选项作为对正文的回复）
- 日志里看不到衍生关系，排障困难

---

## 三、改进需求

### 需求 R1：提供「绕过过滤器链」的发送通道

**优先级**：P0（最高）
**分类**：API 增强

**需求描述**：

新增一个发送方法，允许插件补发的消息**只经过适配器**，不再经过任何出站过滤器（或仅经过显式指定的过滤器子集）。

**建议 API**：

```javascript
// 方案 A：独立方法
gateway.sendBypassFilters(message, options = {})

// 方案 B：在现有方法加选项
gateway.sendDirect(message, { bypassFilters: true })
gateway.sendMessage(message, { bypassFilters: true })
```

**语义**：

- `bypassFilters: true` 时，`dispatchOutbound` 跳过 `applyOutboundFilters`，直接进入去重 → 分片 → 适配器发送
- 仍记录到消息日志（`addMessageLog('outbound', message)`），保证可观测性
- 仍受去重窗口约束（除非配合 R2）

**收益**：消除 `_optionSplitterPassthrough` 标记属性 hack，消除过滤器入口的私有序列判断。

**兼容性**：默认 `bypassFilters: false`，不影响现有插件行为。

---

### 需求 R2：去重窗口支持「有意重复」标记

**优先级**：P0
**分类**：API 增强

**需求描述**：

允许插件在消息上声明「这条是有意重复的，请跳过去重检查」。

**建议 API**：

```javascript
// 方案 A：消息字段
message.metadata = message.metadata || {};
message.metadata.skipDedup = true;

// 方案 B：发送选项
gateway.sendDirect(message, { skipDedup: true });
```

**语义**：

- `skipDedup: true` 时，`dispatchOutbound` 的去重检查跳过该消息
- 仍走过滤器链与适配器
- 日志中标记 `dedupSkipped: true` 便于审计

**收益**：`option-splitter` 可放心补发内容相同的选项，不会丢消息。

**替代方案**：若不想暴露 `skipDedup`，可改为「去重哈希纳入一个 `dedupKey` 字段」，插件给每条衍生消息设递增的 `dedupKey`，让哈希天然不同。但这种方案要求每条衍生消息都设，不如 `skipDedup` 直观。

---

### 需求 R3：插件配置 UI 声明式驱动（schema-driven panel）

**优先级**：P0
**分类**：架构改进 / 前端

**需求描述**：

`plugin.json` 的 `config` 字段已声明字段名、类型、默认值、描述。前端面板应消费该 schema，**自动**为每个已安装插件渲染配置抽屉，无需手改 `panel.html`。

**建议实现**：

1. 后端新增接口 `GET /api/plugins/:name/schema`，返回 `plugin.json` 的 `config` 字段（或合并 `plugin.json` 与运行时元信息）
2. 前端 `loadPluginList()` 渲染每个插件项时，若该插件有 `config` schema，自动追加「配置」按钮
3. 点击「配置」时，根据 schema 动态生成表单：
   - `boolean` → `toggle-switch`
   - `number` → `<input type="number">`，支持 `min/max/step`
   - `string` → `<input type="text">`
   - `array` → 逗号分隔输入框（或动态增删的标签输入）
   - `enum`（schema 扩展）→ `<select>`
   - 每个字段渲染 `description` 为 hint
4. 表单读写统一走 `GET/POST /api/plugins/:name/config`
5. 抽屉样式复用现有 `.gateway-collapsible` / `.gateway-section` 标准

**schema 扩展建议**（向后兼容）：

```json
{
  "config": {
    "enabled": {
      "type": "boolean",
      "default": true,
      "description": "是否启用选项拆分",
      "ui": { "group": "基本", "order": 1 }
    },
    "optionDelay": {
      "type": "number",
      "default": 800,
      "description": "选项间发送间隔（毫秒）",
      "ui": { "group": "时序", "order": 2, "min": 0, "step": 100, "unit": "ms" }
    },
    "applyToPlatforms": {
      "type": "array",
      "default": [],
      "description": "仅对这些平台生效",
      "ui": { "group": "过滤", "order": 5, "inputMode": "csv", "placeholder": "qq,telegram" }
    }
  }
}
```

**收益**：

- 真正实现「从 GitHub 安装插件即可获得配置 UI」的热插拔承诺
- 第三方插件作者无需向网关主仓库提 PR
- 配置 UI 风格自动统一，降低维护成本

**迁移路径**：

- 已有的 `regex-filter` 手写面板可保留（作为「定制 UI」特例），或迁移到 schema 驱动
- 新增 `plugin.json` 的 `configUi: 'auto' | 'custom' | 'none'` 字段，默认 `auto`；`regex-filter` 设 `custom` 继续用现有面板

---

### 需求 R4：过滤器链显式命名与查询

**优先级**：P1
**分类**：架构改进 / API 增强

**需求描述**：

为过滤器引入语义化优先级与可查询的注册表，避免数字撞车。

**建议 API**：

```javascript
// 注册时声明语义化阶段
gateway.addOutboundFilter(fn, {
    name: 'option-splitter',
    phase: 'pre-extract',   // 语义阶段
    priority: 50,           // 阶段内细排序
});

// 查询当前链
const chain = gateway.getOutboundFilterChain();
// [{ name: 'option-splitter', phase: 'pre-extract', priority: 50 }, ...]
```

**约定的阶段（phase）**：

| 阶段            | 语义                       | 典型插件         |
| --------------- | -------------------------- | ---------------- |
| `pre-extract`   | 拆分 / 结构化提取          | option-splitter  |
| `transform`     | 文本清洗（正则、标签移除） | regex-filter     |
| `post-process`  | 收尾（限流、签名、翻译）   | 未来插件         |
| `terminal`      | 最后处理（仅一个）         | 网关内置         |

**收益**：

- 新插件按语义选 `phase`，不必猜数字
- 调试时可 `getOutboundFilterChain()` 看清当前顺序
- 网关可在日志里打印过滤器链，便于排障

**兼容性**：`phase` 为可选字段，未提供时归入 `transform` 默认阶段，按 `priority` 排序。现有 `regex-filter` 无需改动。

---

### 需求 R5：衍生消息血缘标识

**优先级**：P1
**分类**：架构改进

**需求描述**：

`OutboundMessage` 增加结构化的「衍生关系」字段，让补发消息能追溯到源消息。

**建议字段**：

```javascript
class OutboundMessage {
    constructor({ ..., derivedFrom, derivationTag } = {}) {
        ...
        this.derivedFrom = derivedFrom || null;    // 源消息的 ID（见 R6）
        this.derivationTag = derivationTag || null; // 衍生类型标记，如 'option:1'
    }
}
```

**语义**：

- `derivedFrom`：源出站消息的 ID（要求 R6 提供消息 ID）
- `derivationTag`：插件自定义的衍生类型，如 `option-splitter:option:2`
- 网关核心不解释这两个字段，但会：
  - 写入消息日志，便于追溯
  - 暴露给适配器（适配器可选择消费，如 Telegram 把衍生消息作为对源消息的回复）

**收益**：

- 消除 `_optionSplitterPassthrough` 这类私有标记属性
- 适配器可基于 `derivedFrom` 实现更自然的 UI（选项作为正文的回复出现）
- 日志可串联「正文 → 选项1 → 选项2」的因果链

**与 R1 的关系**：若 R1 提供 `bypassFilters`，则 `derivationTag` 不再承担「递归守卫」职责，仅用于血缘追溯，职责更单一。

---

### 需求 R6：出站消息全局唯一 ID

**优先级**：P1
**分类**：架构改进

**需求描述**：

每条出站消息在 `addMessageLog` 时分配一个网关内唯一的 ID，供日志、衍生关系、客户端引用。

**建议实现**：

```javascript
// gateway-core.js
addMessageLog(direction, message) {
    if (!message.id) message.id = `${Date.now()}-${crypto.randomUUID()}`;
    this.messageLog.push({ id: message.id, direction, ...message, ts: Date.now() });
}
```

**收益**：

- R5 的 `derivedFrom` 有稳定引用
- 消息日志 API 可按 ID 查询
- 未来 webhook / 事件订阅可基于 ID 做幂等

---

### 需求 R7：过滤器返回值的扩展语义

**优先级**：P2
**分类**：API 增强

**需求描述**：

当前过滤器返回 `message`（放行/修改）或 `null`（丢弃）。建议扩展为可返回「衍生消息集合」。

**建议 API**：

```javascript
// 过滤器可返回
return {
    primary: modifiedMessage | null,    // 主消息（原消息的变身）
    derived: [msg1, msg2, ...],         // 衍生消息（由网关负责补发）
    bypassFiltersForDerived: true,      // 衍生消息是否绕过过滤器链（默认 false）
};
```

**语义**：

- 网关收到 `derived` 后，按顺序补发，间隔可由消息的 `metadata.sendDelay` 控制
- `bypassFiltersForDerived: true` 时衍生消息不回过滤器链（等价于 R1 的语义，但更声明式）
- 网关负责调度，插件不必自己 `setTimeout` + `sendDirect`

**收益**：

- `option-splitter` 的 `_sendOptions` 整段异步逻辑可删除，改为过滤器直接返回 `{ primary: mainText, derived: options, bypassFiltersForDerived: true }`
- 衍生消息的发送时机、错误处理由网关统一负责，更可靠
- 衍生消息自动获得 `derivedFrom`（基于 R6），无需插件手设

**兼容性**：返回 `message` 或 `null` 的旧写法继续有效（等价于 `{ primary: <返回值>, derived: [] }`）。

---

### 需求 R8：插件生命周期事件增强

**优先级**：P2
**分类**：API 增强

**需求描述**：

补全插件生命周期钩子，覆盖配置变更、过滤器链变更等场景。

**建议钩子**：

```javascript
class GatewayPlugin {
    // 配置被 REST API 修改后触发（当前是直接改 _pluginConfig，无回调）
    onConfigChange(newConfig, oldConfig) {}

    // 过滤器链发生变更时触发（任何插件增删过滤器）
    onFilterChainChange(chain) {}

    // 适配器连接状态变化时触发
    onAdapterStateChange(platform, newState) {}
}
```

**收益**：

- 插件可在配置变更后即时重新初始化（如 `applyToPlatforms` 改了，无需重载插件）
- 调试更容易：过滤器链变化可被观察

**当前痛点**：`option-splitter` 改了 `applyToPlatforms` 后，因过滤器闭包每次都读 `getConfig`，恰好能生效；但若插件在 `onLoad` 时缓存了配置，就会失效。`onConfigChange` 提供统一回调点。

---

### 需求 R9：插件配置 schema 校验

**优先级**：P2
**分类**：架构改进

**需求描述**：

`plugin.json` 的 `config` schema 应被网关在加载时校验，并在 `POST /api/plugins/:name/config` 时按 schema 校验请求体。

**建议实现**：

- 加载时校验 schema 自身合法性（类型字段必填、default 与 type 一致）
- 配置写入时按 schema 校验：类型不符、超出 `min/max`、非法 enum 值 → 返回 400
- 缺失字段自动补 default

**收益**：

- 防止前端误传非法配置导致插件崩溃
- 配合 R3 的 schema 驱动 UI，前端表单可基于 schema 做客户端校验

---

### 需求 R10：插件隔离与错误边界

**优先级**：P2
**分类**：架构改进

**需求描述**：

单个过滤器的异常不应中断整条出站链。

**建议实现**：

```javascript
applyOutboundFilters(message) {
    for (const filter of this.filters) {
        try {
            const result = filter.fn(message);
            if (result === null) return null;
            if (result) message = result;
        } catch (err) {
            this.logger.error(`过滤器 ${filter.name} 异常: ${err.message}`, err);
            // 继续下一个过滤器，message 保持当前值
        }
    }
    return message;
}
```

**收益**：

- 某个第三方插件 bug 不会让所有出站消息卡死
- 错误可见（日志），但不致命

**当前现状**：需确认 `applyOutboundFilters` 是否已有 try/catch；若无，建议补上。

---

## 四、建议的实施路线

### 阶段一（P0，解锁热插拔承诺）

1. **R3** 插件配置 UI schema 驱动 —— 最高价值，直接兑现「从 GitHub 安装即有配置界面」
2. **R1** `bypassFilters` 发送通道 —— 消除递归守卫 hack
3. **R2** `skipDedup` 标记 —— 消除选项被去重吞掉的风险

完成后，`option-splitter` 可删除 `_optionSplitterPassthrough` 标记与 `_sendOptions` 的异步补发逻辑，改为：

```javascript
filterOutbound(message) {
    // ...提取选项...
    const derived = options.map((o, i) => {
        const m = new OutboundMessage({ ..., derivedFrom: message.id, derivationTag: `option:${i+1}` });
        m.metadata = { sendDelay: i === 0 ? initialDelay : optionDelay, skipDedup: true };
        return m;
    });
    return { primary: mainText || null, derived, bypassFiltersForDerived: true };
}
```

### 阶段二（P1，提升可观测性与可扩展性）

4. **R6** 出站消息全局 ID
5. **R5** 衍生消息血缘标识
6. **R4** 过滤器链语义化阶段

### 阶段三（P2，完善生态）

7. **R7** 过滤器返回衍生消息集合
8. **R8** 生命周期事件增强
9. **R9** 配置 schema 校验
10. **R10** 过滤器错误边界

---

## 五、非目标（明确不做）

- **不**让插件能修改网关核心配置（适配器凭据等），插件配置仍隔离在 `data/plugins/<name>.json`
- **不**让插件直接访问数据库或文件系统（保持现有 `permissions` 模型）
- **不**让前端面板支持任意自定义 JS（schema 驱动 UI 仅支持声明式字段，避免 XSS 与生态碎片化）

---

## 六、验收标准

实施 R1、R2、R3 后，`option-splitter` 插件应能做到：

1. ✅ 从 GitHub 安装后，**无需修改 `panel.html` 与 `index.js`**，即在面板出现配置抽屉
2. ✅ 补发选项消息时，**不使用任何标记属性**，不依赖私有序列判断
3. ✅ 多个内容相同的选项能全部送达，不被去重吞掉
4. ✅ 插件代码量减少（删除 `_sendOptions` 异步逻辑与递归守卫）
5. ✅ 网关消息日志中能看到「正文 → 选项1 → 选项2」的衍生关系

---

## 七、附：当前 workaround 清单（待改进后清除）

| Workaround                              | 用于解决          | 改进后可删除            |
| --------------------------------------- | ----------------- | ----------------------- |
| `_optionSplitterPassthrough` 消息标记属性 | 递归守卫          | R1 / R5 / R7            |
| 过滤器入口 `if (msg._xxx) return msg`   | 递归守卫          | R1 / R5 / R7            |
| `setTimeout` + `sendDirect` 异步补发    | 衍生消息发送      | R7                      |
| 返回 `null` 丢弃空正文                  | 无衍生消息 API    | R7                      |
| 手写 `panel.html` 抽屉与 JS 三件套      | 配置 UI           | R3                      |
| priority=5 vs 10 的口头约定             | 过滤器顺序        | R4                      |

---

*文档版本：v1.0 · 基于 option-splitter 插件开发经验 · 2026-07-23*
