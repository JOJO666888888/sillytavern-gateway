# astrbot-port Skill（随仓库分发的副本）

> 本文件是 `astrbot-port` skill 的仓库副本。由于 `.claude/` 被 `.gitignore` 排除，
> skill 的可执行副本（`.claude/skills/astrbot-port/SKILL.md`）不进版本库。
> 克隆本仓库后，若想在 Claude Code 里用这个 skill，执行：
>
> ```bash
> mkdir -p .claude/skills/astrbot-port
> # 去掉本文件顶部这段说明后，把正文存为 SKILL.md：
> cp docs/skills/astrbot-port.md .claude/skills/astrbot-port/SKILL.md
> ```
>
> 之后在会话里 `/astrbot-port` 或直接让 Claude "移植这个 AstrBot 插件" 即可触发。
> 正文（含 YAML frontmatter）如下，可原样作为 `SKILL.md`：

---

name: astrbot-port
description: 把 AstrBot (Python) 插件移植成本网关的 JS 插件。当用户要移植/翻译/迁移一个 AstrBot 插件、或给出 AstrBot 插件源码要求跑在本网关时使用。

---

# AstrBot 插件移植

把 AstrBot（Python）插件翻译成本网关（sillytavern-gateway）的 JS 插件。借助 `server/compat` 兼容层，移植是**逐行翻译**而非架构重写。

## 何时用

- 用户给出 AstrBot 插件源码（`main.py` / `metadata.yaml` / `_conf_schema.json`），要求跑在本网关
- 用户说"移植/迁移/翻译这个 AstrBot 插件"
- 用户想把 AstrBot 生态的某类能力（定时、agent、消息处理）搬过来

## 移植流程

1. **读源码**：识别 `Star` 子类、`@filter.command`/`@filter.llm_tool`/`@filter.event_message_type`、handler 是否为生成器（`yield`）、`_conf_schema.json` 配置、用到哪些消息组件。
2. **建目录**：`plugins/<name>/`，写 `plugin.json`（见下）。
3. **翻译 `index.js`**：按下方对照表逐符号翻译，`export default class X extends Star`。
4. **声明权限**：调 LLM → `"llm"`；主动发消息到别的会话 → `"gateway.send"`；拦截入站消息 → `"gateway.inbound"`；读会话历史 → `"sessions"`。
5. **验证**：`node --check plugins/<name>/index.js`，再跑 `node --test --test-force-exit "test/*.test.js"` 确认没破坏别的。
6. **默认 `enabled: false`**：让用户审阅后再启用。

## 逐符号翻译对照表

| AstrBot (Python) | 本网关 (JS) |
|---|---|
| `from astrbot.api.star import Star` | `import { Star } from '../../server/compat/index.js'` |
| `import astrbot.api.message_components as Comp` | `import { Plain, Image, At, Reply } from '../../server/compat/index.js'` |
| `class Foo(Star):` | `export default class Foo extends Star {` |
| `def __init__(self, context, config):` | 不用写；配置经 `this.getConfig(key)` 读 |
| `async def initialize(self):` | `async initialize() {` |
| `async def terminate(self):` | `async terminate() {` |
| `@filter.command("hi", alias={'嗨'})` | `static commands = [defineCommand('hi', { alias: ['嗨'], handler: 'hi', description: '...' })]` |
| `@filter.llm_tool("查天气")` + `async def f(self, event, city: str)` | `static get llm_tools() { return [defineLLMTool('f', '查天气', {type:'object', properties:{city:{type:'string'}}, required:['city']}, 'f')] }` + `async f({ city }) { ... return result }` |
| `@filter.event_message_type(...)` / 监听消息 | `static listeners = [{ event: 'message', filter: {}, handler: 'onMsg' }]` |
| `@filter.regex(r"...")` | 无装饰器；在 handler 里 `if (!/.../.test(event.message_str)) return;` |
| `async def handler(self, event):` (生成器) | `async *handler(event) {` （兼容层自动 drain） |
| `yield event.plain_result("x")` | `yield event.plain_result('x')` |
| `yield event.image_result(url)` | `yield event.image_result(url)` |
| `yield event.chain_result([Comp.Plain("x"), Comp.Image.fromURL(u)])` | `yield event.chain_result([new Plain('x'), Image.fromURL(u)])` |
| `event.message_str` | `event.message_str` |
| `event.get_sender_name()` / `get_sender_id()` | 同名 |
| `event.get_group_id()` / `get_message_type()` | 同名 |
| `event.is_private_chat()` / `is_admin()` | 同名 |
| `event.send("x")` | `await event.send('x')` |
| `event.stop_event()` | `event.stop_event()` |
| `Comp.Plain(text)` | `new Plain(text)` |
| `Comp.Image.fromURL(u)` / `.fromFileSystem(p)` | `Image.fromURL(u)` / `Image.fromFileSystem(p)` |
| `Comp.At(qq)` | `new At(qq)` |
| `Comp.Reply(id)` | `new Reply(id)` |
| `self.context.send_message(session, chain)` | `this.context.send_message(session, chain)` |
| `self.context.get_using_provider()` | `await this.context.get_using_provider()`（需 llm 权限） |
| LLM 调用 / agent 循环 | `ctx.llm.runTools(messages, this.tools, (n,a)=>this.executeTool(n,a), {maxSteps})` |
| `_conf_schema.json` | `plugin.json` 的 `config` 字段 |
| `self.config["key"]` / `self.config.key` | `this.getConfig('key')` |
| `self.config.save_config()` | `this.setConfig(key, value)`（自动持久化） |
| `logger` / `self.logger` | `this.logger` |

## 三类插件移植配方

### A. 命令型（`@filter.command`）
```js
static commands = [defineCommand('hello', { handler: 'hello', description: '打招呼' })];
async *hello(event) {
    yield event.plain_result(`你好 ${event.get_sender_name()}`);
}
```

### B. Agent / 工具型（`@filter.llm_tool`）
```js
static get llm_tools() {
    return [defineLLMTool('search', '联网搜索', {
        type: 'object', properties: { q: { type: 'string' } }, required: ['q'],
    }, 'search')];
}
async search({ q }) { /* 真实实现 */ return { results: [] }; }

// 用命令触发 agent 循环
static commands = [defineCommand('ask', { handler: 'ask' })];
async ask(ctx) {
    const { text } = await ctx.llm.runTools(
        [{ role: 'user', content: ctx.args.join(' ') }],
        this.tools,
        (n, a) => this.executeTool(n, a),
        { maxSteps: 5 },
    );
    return ctx.reply(text);
}
```
→ 需 `"permissions": ["llm"]`

### C. 消息处理 / 拦截型
AstrBot 里在消息进入时做预处理/拦截的插件，对应本网关的**入站过滤器**（更强，能改写/拦截每条消息）：
```js
// plugin.json: "permissions": ["gateway.inbound"]
async initialize() {
    this._services.gateway.addInboundFilter((msg) => {
        if (isSpam(msg)) return null;            // 返回 null = 拦截
        msg.content = redact(msg.content);       // 改写
        return msg;
    }, { priority: 50 });
}
```
只读不拦截的可用 `static listeners`（在命令路由后跑，只能 `stopPropagation`）。

## 已知不支持项与降级

| AstrBot 特性 | 本网关处理 |
|---|---|
| `event.send_streaming(...)` | 降级为普通发送（网关无流式出站） |
| `event.send_typing()` | 无操作（仅日志；网关无 typing 信令） |
| `Comp.Face` / `Comp.Poke` / `Comp.Node` | 不支持，忽略或改用文本 |
| `@filter.permission_type` | 用 `defineCommand('x', { adminOnly: true })` |
| `@filter.regex` | handler 内手动 `event.message_str.match(...)` |
| `self.context.get_all_stars()` | 有简化版（返回插件元数据列表） |
| 平台专有 API（`get_group`、`react`） | 不支持；用 `ctx.send` / `event.send` |

## plugin.json 模板
```json
{
    "name": "<kebab-name>",
    "displayName": "<中文名>",
    "version": "1.0.0",
    "author": "<原作者> (移植)",
    "description": "<描述>（从 AstrBot 移植）",
    "main": "index.js",
    "enabled": false,
    "permissions": ["llm"],
    "config": { "key": { "type": "string", "default": "", "description": "..." } }
}
```

## 参考
- 兼容层源码：`server/compat/astrbot-shim.js`
- 活样板：`plugins/example-astrbot-port/index.js`
- 完整指南：`docs/PLUGIN_DEVELOPMENT_GUIDE.md` 第 16 节
