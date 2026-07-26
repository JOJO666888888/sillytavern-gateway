# 测试套件

用 Node 内置的 `node:test`（Node 18+），**无需任何额外依赖**。

```bash
npm test          # 跑全部测试
npm run test:watch  # 改动即重跑
```

> `--test-force-exit` 是必需的：插件系统与会话管理器会启动常驻定时器，
> 否则测试跑完后事件循环不结束、进程挂住。

## 这些测试守护什么

每个文件对应之前修复过的一类真实缺陷。**它们的价值不在覆盖率数字，而在于
"这个 bug 不会再回来"**——每条测试的注释里都写了它防的是哪个历史问题。

| 文件 | 守护的不变量 | 对应修复 |
|------|-------------|---------|
| `reconnect.test.js` | 回调持续失败时**自动续接**重连 | P1-A（历史 bug：Telegram/Discord 首次重连失败后永久"静默死亡"） |
| `message-queue.test.js` | 同会话有序、超时不锁死、死信、背压 | P1-B（历史 bug：重试把消息推队尾导致对话颠倒；单条挂起锁死全平台） |
| `gateway-core.test.js` | 入站队列**不截断**、ack 语义、过滤器按插件回收 | P1-C/D/E（历史 bug：走 messageLog 导致长消息被截到 100 字符） |
| `protocol-onebot.test.js` | 数组段文本**不转义**、`&#44;` 反解码、媒体按类型映射 | P1-D（历史 bug：QQ 端 Markdown 显示为 `&#91;` 乱码；含逗号图片 URL 失效） |
| `security-config.test.js` | 原型污染防护、敏感字段脱敏、掩码回传保护 | P0（历史漏洞：无鉴权 API + `deepMerge` 可污染 `Object.prototype`） |
| `runtime-assets.test.js` | 角色卡 PNG(V2/V3/zTXt) 解析、世界书激活、存档读写 | P2-1/2/3 |
| `runtime-prompt.test.js` | ST `prompt_order` 还原、token 估算与截断 | P2-4/9/10 |
| `runtime-llm.test.js` | 三 provider 请求构造、多模态、SSE 流式 | P2-5/7/8 |
| `plugin-system.test.js` | **禁用插件真正生效**、幂等、schema 默认值 | P1-E（历史 bug：禁用后出站过滤器仍在跑） |

## 设计原则

- **不依赖网络**：流式测试起本地 HTTP 服务器，不碰真实 LLM API。
- **不依赖浏览器**：不测 puppeteer 渲染（那需要 Chrome，放在手工验证）。
- **不留垃圾**：临时文件用 `os.tmpdir()`；会创建 `config/`、`data/` 的测试在
  `after()` 里清理。
- **测行为不测实现**：断言的是"用户能观察到的结果"，重构内部实现不应导致测试失败。

## 加新测试

放一个 `test/xxx.test.js`，用 `node:test` 的 `describe`/`test`：

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('模块名', () => {
    test('应该做什么', () => {
        assert.strictEqual(actual, expected, '失败时的解释');
    });
});
```

修 bug 时**先写一个能复现它的测试**，再修——这样这个 bug 永远不会回来。

## 当前未覆盖（诚实说明）

- **平台适配器的真实收发**：需要真实 bot 凭据，无法在 CI 中测。适配器的
  纯逻辑部分（CQ 编解码）已覆盖。
- **puppeteer 图片渲染**：需要 Chrome/Chromium。
- **ST 前端扩展**（`index.js`）：需要浏览器 + SillyTavern 运行环境。
- **端到端消息闭环**：需要同时有平台连接和 LLM。
