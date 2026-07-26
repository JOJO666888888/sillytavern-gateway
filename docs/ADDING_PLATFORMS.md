# 接入更多平台指南（QQ 官方 / 微信 / 飞书 / 钉钉 …）

> 结论先行：**可以扩展**。网关采用适配器模式，新增平台不改核心，只需实现一个继承
> `PlatformAdapter` 的类、加一段默认配置、在注册表里加一行。本文给出各平台的可行性
> 评估、推荐接入顺序，以及一个可直接照抄的适配器模板。参考 AstrBot 的平台矩阵：
> https://docs.astrbot.app/platform/qqofficial.html

---

## 一、可行性评估

| 平台 | 官方/协议 | 接入方式 | 媒体 | 难度 | 风险 | 建议 |
|------|-----------|----------|------|------|------|------|
| **飞书 / Lark** | ✅ 官方开放平台 | 事件订阅(长连接/Webhook) + 消息 API | 图片/文件/富文本卡片 | 中 | 低 | ✅ **已接入**（长连接模式，见下） |
| **QQ 官方机器人** | ✅ 官方开放平台 | WebSocket 网关 + REST API | 图片/语音/富媒体（需素材上传接口） | 中 | 低（官方合规） | ✅ **已接入**（群/单聊/频道，见下） |
| **钉钉** | ✅ 官方开放平台 | Stream 模式(长连接) / Webhook + API | 图片/富文本/卡片 | 中 | 低 | ⭐ 推荐。Stream 模式无需公网 IP |
| **Slack** | ✅ 官方 | Socket Mode / Events API | 图片/文件/Block Kit | 中 | 低 | 可选，海外团队 |
| **KOOK(开黑啦)** | ✅ 官方 | WebSocket + API | 图片/卡片 | 中 | 低 | 可选，游戏社群 |
| **企业微信** | ✅ 官方 | 回调 + API | 图片/文件 | 中 | 低 | 可选，企业内部 |
| **WhatsApp** | ✅ 官方 Cloud API | Webhook + API | 图片/语音/文件 | 中 | 低（需 Meta 审核） | 可选，海外 |
| **个人微信** | ❌ 无官方开放 | 第三方(wechaty/gewechat/hook) | 依实现 | 高 | ⚠️ **高（封号风险，违反微信协议）** | 不建议生产使用；如需，明确告知用户风险 |

**关键说明**

- **QQ 官方机器人 ≠ 当前的 QQ(OneBot)**。当前 `qq` 适配器走 OneBot v11（NapCat/Lagrange 等第三方实现，用的是个人 QQ 号，存在风控风险）。QQ 官方机器人是腾讯官方开放平台，合规但能力受官方限制（如主动消息受限、需要审核上架）。两者可**并存**为两个适配器（如 `qq` 和 `qqofficial`）。
- **个人微信**没有任何官方开放接口，所有第三方方案都靠 hook/协议逆向，**封号风险高且违反用户协议**，不建议作为生态主打；若确要接，应作为"实验性/自担风险"选项。
- 飞书/钉钉的**长连接模式(Stream)无需公网 IP**，和 Telegram 的 polling 一样适合个人部署；QQ 官方、Webhook 类平台若用 Webhook 则需要公网可达地址（或内网穿透）。

---

## 一·五、飞书（已接入）快速上手

飞书适配器已随网关内置（`server/adapters/feishu-adapter.js`），采用**长连接模式**，无需公网 IP。

**步骤**

1. 安装官方 SDK（可选依赖，未装不影响网关启动）：

   ```bash
   npm install @larksuiteoapi/node-sdk
   ```

2. 在[飞书开放平台](https://open.feishu.cn/)创建企业自建应用，获取 **App ID / App Secret**；
   开通「机器人」能力，订阅事件 **接收消息 `im.message.receive_v1`**，权限至少包含
   `im:message`、`im:message:send_as_bot`（发消息）与读取消息权限。
   事件订阅方式选择「**长连接**」。

3. 在网关面板「平台配置 → 🐦 飞书」填入 App ID / App Secret、选择区域（飞书国内 / Lark 海外），
   打开开关保存；或直接编辑 `config/gateway.json` 的 `adapters.feishu`。

4. 点面板上飞书的「验证连接」确认凭据有效；保存后自动启动。

**能力与边界（v1）**

- ✅ 私聊 / 群聊文本收发；群聊 `requireMention` @机器人 才响应；机器人自身消息回环防护。
- ✅ 出站图片（自动上传取 image_key 后发送）；其它出站媒体退化为「占位+URL」文本。
- ✅ 入站图片/语音/文件识别为 `MediaAsset`；配置 `mediaBaseUrl`（网关公网基址）后自动下载入库供跨平台转发。
- ⚠️ 暂仅支持长连接模式；`mode=webhook` 会明确报错提示改用长连接（不做静默假连接）。
- ⚠️ 富文本卡片出站、主动消息模板等高级能力为后续项。

---

## 一·六、QQ 官方机器人（已接入）快速上手

腾讯官方开放平台机器人（`server/adapters/qqofficial-adapter.js`），**与现有 `qq`(OneBot) 并存**。
`qq` 用第三方 OneBot 实现（个人号，有风控风险）；`qqofficial` 是官方合规机器人，能力受官方限制。

**步骤**

1. 安装 SDK：`npm install qq-official-bot`
2. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，获取 **AppID / AppSecret**（Token 可选），
   开通所需场景（群/单聊/频道）并配置。
3. 面板「平台配置 → 🐧 QQ官方」填 AppID / AppSecret，按需勾选沙箱，保存启用；
   或编辑 `config/gateway.json` 的 `adapters.qqofficial`（可细调 `enableGroup/enableC2C/enableGuild`）。

**能力与边界**

- ✅ 群 @ 消息 / 单聊(C2C) / 频道消息；群与频道消息**由 @ 触发**（官方 intent 决定），故 `mentioned` 恒真。
- ✅ 出站文本；出站图片经 SDK 上传后发送。
- ⚠️ **被动回复窗口**：官方要求回复引用收到的消息，且有约 **5 分钟 / 5 条**窗口。适配器已自动缓存
  最近消息事件做被动回复；窗口外的**主动推送受官方严格限制**（需审核/模板），可能失败。
- ⚠️ 主动群发、富媒体模板等高级能力为后续项。

---

## 二、接入的三个改动点

网关已把接入成本降到最低。新增一个平台只需三步：

### 1. 实现适配器类（`server/adapters/<平台>-adapter.js`）

继承 `PlatformAdapter`，实现 `connect / disconnect / send`，把平台消息转成统一的
`InboundMessage`（含 `MediaAsset` 媒体），把 `OutboundMessage` 转成平台格式发出。

### 2. 加默认配置（`server/utils/config.js` 的 `DEFAULT_CONFIG.adapters`）

```js
adapters: {
  // ...现有 qq / telegram / discord
  feishu: {
    enabled: false,
    appId: '',
    appSecret: '',
    requireMention: true,
  },
}
```

### 3. 注册（`server/index.js` 的 `ADAPTER_REGISTRY`）

```js
const ADAPTER_REGISTRY = {
  qq: OneBotAdapter,
  telegram: TelegramAdapter,
  discord: DiscordAdapter,
  feishu: FeishuAdapter,   // ← 加这一行
};
```

完成。命令同步、消息队列、会话管理、插件过滤链、入站队列、媒体缓存都自动适用。

---

## 三、适配器模板（可直接照抄）

```js
import { PlatformAdapter, ConnectionState, InboundMessage, OutboundMessage, MediaAsset, MediaType } from './base-adapter.js';

export class FeishuAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('feishu', config);
        this.client = null;
    }

    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) return;
        if (!this.config.appId || !this.config.appSecret) throw new Error('飞书 appId/appSecret 未配置');

        this.setState(ConnectionState.CONNECTING);
        try {
            // 1. 建立长连接 / 订阅事件（各平台 SDK 不同）
            //    this.client = new LarkClient({...});
            //    绑定消息事件 → this._onPlatformMessage(evt)
            //    绑定断线事件 → this.handleDisconnect(reason)   ← 交给基类自愈重连
            // 2. 连接成功：
            this.setState(ConnectionState.CONNECTED);
            this.emit('connected');
        } catch (error) {
            // 失败直接抛出即可：基类 start() 会 handleDisconnect，
            // reconnect 策略会自动续接下一次重连（无需自己写重试）
            this.setState(ConnectionState.ERROR);
            throw error;
        }
    }

    async disconnect() {
        try { await this.client?.close?.(); } finally { this.client = null; }
        this.setState(ConnectionState.DISCONNECTED);
    }

    /** 平台事件 → 统一 InboundMessage */
    _onPlatformMessage(evt) {
        // 群聊 @机器人 判定：this.config.requireMention 时需检查是否 @bot
        const media = [];
        if (evt.image) media.push(MediaAsset.image(evt.image.url));
        if (evt.audio) media.push(MediaAsset.voice(evt.audio.url, { duration: evt.audio.duration }));

        const msg = new InboundMessage({
            platform: 'feishu',
            messageId: evt.messageId,
            chatId: evt.chatId,
            chatType: evt.isGroup ? 'group' : 'private',
            senderId: evt.senderId,
            senderName: evt.senderName,
            content: evt.text || '',
            media,                       // 用带类型的 MediaAsset，勿用裸 URL
            mentioned: evt.mentionedBot,
            timestamp: evt.timestamp || Date.now(),
            raw: evt,
        });
        this.emit('message', msg);       // 交给网关核心 → 插件 → 入站队列
    }

    /** 统一 OutboundMessage → 平台发送 */
    async send(message) {
        if (!this.isConnected()) throw new Error('飞书未连接');  // 抛错触发队列重试
        // 文本
        if (message.content) {
            await this.client.sendText(message.chatId, message.content);
        }
        // 媒体：message.media 是 MediaAsset[]，按类型分别调用平台上传/发送接口
        for (const m of (message.media || [])) {
            if (m.type === MediaType.IMAGE) await this.client.sendImage(message.chatId, m.url);
            else await this.client.sendFile(message.chatId, m.url, m.name);
        }
        return true;   // 返回 false 或抛错都会触发队列重试
    }

    /** 可选：把命令同步到平台原生命令菜单（Telegram setMyCommands / Discord slash 类似） */
    async syncCommands(commands) { return false; }

    /** 可选：凭据校验（面板"验证"按钮） */
    async verify() {
        return { ok: this.isConnected(), state: this.state, message: this.isConnected() ? '已连接' : '未连接' };
    }
}
```

### 前端面板配置

前端 `panel.html` 目前为 qq/tg/dc 三个平台手写了配置区块。新增平台的配置 UI 有两条路：
- **短期**：在 `panel.html` 仿照现有区块加一段（字段 id 用 `gateway_panel_<prefix>_*`），并在 `index.js` 的 `savePanelConfig`/`loadPanelConfig`/`PLATFORM_PREFIX` 里补映射。
- **推荐(P2)**：把平台配置也做成 schema 驱动（复用已为插件实现的 schema→表单渲染），彻底免手写。这属于后续优化项。

后端 REST（`/api/gateway/adapters/<name>/start|stop|verify`）无需改动，注册表加一行后自动可用。

---

## 四、必须处理的平台差异（避免踩坑）

| 关注点 | 说明 |
|--------|------|
| **群聊 @ 判定** | 各平台 @ 表达不同（QQ官方 at、飞书 mention、钉钉 atUsers）。统一填到 `InboundMessage.mentioned`，配合 `config.requireMention` |
| **公网可达** | Webhook 类平台需要公网地址接收回调；长连接/Stream 类（飞书、钉钉、Slack Socket Mode）无需 |
| **媒体上传** | 多数官方平台不接受"外链 URL 直接发"，需先调**素材上传接口**拿 media_id 再发。适配器 `send()` 里处理；跨平台转发时先用 `mediaStore` 落地成稳定 URL 再上传 |
| **主动消息限制** | QQ 官方、企业微信等对"主动推送"有严格限制（需模板/时间窗），不像 Telegram 可随意发。会话闭环设计需考虑 |
| **限流** | 每个平台限流规则不同。当前队列是全局粗粒度，P1 已加 per-chat 有序与超时；平台级令牌桶属后续优化 |
| **富文本/卡片** | 飞书/钉钉/Slack 的卡片是核心体验，`OutboundMessage.metadata` 可承载平台特定结构，适配器 `send()` 消费 |

---

## 五、推荐落地顺序

1. **飞书** 或 **钉钉**（官方、长连接免公网、文档好、封号无风险）——作为"官方平台"接入的样板。
2. **QQ 官方机器人**——覆盖国内最大用户面，与现有 OneBot 版并存。
3. 其余（Slack / KOOK / 企业微信 / WhatsApp）按需求补。
4. **个人微信**——仅在明确告知封号风险后作为实验性选项，不建议默认启用。

> 每接一个平台，配合把它的媒体处理接进 `MediaAsset` + `mediaStore`（本次 P1 已建好地基），即可获得跨平台媒体转发、语音/图片进多模态管线的能力。
