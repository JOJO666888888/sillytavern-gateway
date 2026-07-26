import { PlatformAdapter, ConnectionState, InboundMessage, MediaAsset, MediaType } from './base-adapter.js';

/**
 * QQ 官方机器人适配器（腾讯 QQ 开放平台，非 OneBot）
 *
 * 与现有 `qq`(OneBot/NapCat) 适配器并存：
 *   - `qq`         = 第三方 OneBot 实现，用个人 QQ 号，有风控风险；
 *   - `qqofficial` = 腾讯官方开放平台机器人，合规，但能力受官方限制。
 *
 * 采用社区维护的官方 API SDK `qq-official-bot`（统一支持 群/单聊C2C/频道），
 * 通过 WebSocket 网关长连接，SDK 内部管理 access_token 刷新与重连。
 * 依赖可选：未安装不影响网关启动。安装：`npm install qq-official-bot`
 *
 * ⚠️ 关键约束——被动回复窗口：
 *   QQ 官方要求回复必须引用收到的消息（msg_id），且有时间窗（约 5 分钟 / 5 条）。
 *   因本网关出站与入站解耦，适配器缓存每个会话最近一次消息事件用于被动回复；
 *   窗口外的“主动推送”受官方严格限制（需审核/模板），可能失败。
 *
 * 参考：https://bot.q.qq.com/wiki/ | AstrBot qqofficial 适配器
 */
export class QQOfficialAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('qqofficial', config);
        this.bot = null;
        // chatId -> { event, ts } 最近消息事件，用于被动回复（TTL 见 _replyTtl）
        this._replyCtx = new Map();
        this._replyTtl = 4.5 * 60 * 1000; // 略小于官方 5 分钟窗口
    }

    /** 根据配置组装 intents */
    _intents() {
        const c = this.config;
        const intents = [];
        if (c.enableGroup !== false) intents.push('GROUP_AT_MESSAGE_CREATE');
        if (c.enableC2C !== false) intents.push('C2C_MESSAGE_CREATE');
        if (c.enableGuild !== false) {
            intents.push('GUILD_MESSAGES', 'PUBLIC_GUILD_MESSAGES', 'DIRECT_MESSAGE');
        }
        // 保底：至少订阅群 @ 消息
        if (intents.length === 0) intents.push('GROUP_AT_MESSAGE_CREATE');
        return intents;
    }

    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) return;

        if (!this.config.appId || !this.config.secret) {
            throw new Error('QQ 官方机器人 appId / secret(AppSecret) 未配置');
        }

        this.setState(ConnectionState.CONNECTING);

        let Bot;
        try {
            const mod = await import('qq-official-bot');
            Bot = mod.Bot || mod.default?.Bot || mod.default;
        } catch (e) {
            throw new Error('未安装 QQ 官方机器人 SDK，请执行: npm install qq-official-bot');
        }
        if (typeof Bot !== 'function') {
            throw new Error('qq-official-bot SDK 接口异常（未找到 Bot 构造器）');
        }

        this.bot = new Bot({
            appid: String(this.config.appId),
            secret: String(this.config.secret),
            token: this.config.token ? String(this.config.token) : undefined,
            sandbox: !!this.config.sandbox,
            intents: this._intents(),
            logLevel: 'warn',
            maxRetry: 10,
        });

        // 统一消息事件
        this.bot.on('message', (e) => {
            try { this._onMessage(e); } catch (err) { this.logger.error(`处理QQ官方消息失败: ${err.message}`); }
        });

        // SDK 若暴露连接错误事件则接入自愈重连
        if (typeof this.bot.on === 'function') {
            this.bot.on('error', (err) => this.logger.error(`QQ官方 SDK 错误: ${err?.message || err}`));
        }

        await this.bot.start();

        this.logger.info('QQ 官方机器人已连接');
        this.setState(ConnectionState.CONNECTED);
        this.emit('connected');
    }

    async disconnect() {
        try {
            if (this.bot?.stop) await this.bot.stop();
            else if (this.bot?.close) this.bot.close();
        } catch (e) {
            this.logger.warn(`关闭QQ官方连接出错: ${e.message}`);
        } finally {
            this.bot = null;
            this._replyCtx.clear();
        }
        this.setState(ConnectionState.DISCONNECTED);
    }

    /**
     * 处理消息事件 → 统一 InboundMessage
     * e.message_type: 'group' | 'private'(C2C) | 'guild' | 'direct'
     */
    _onMessage(e) {
        const msgType = e.message_type;
        let chatId, chatType;

        switch (msgType) {
            case 'group':
                chatId = e.group_id || e.group_openid;
                chatType = 'group';
                break;
            case 'private': // C2C 单聊
                chatId = e.user_id || e.sender?.user_id || e.sender?.user_openid;
                chatType = 'private';
                break;
            case 'guild': // 频道
                chatId = e.channel_id;
                chatType = 'channel';
                break;
            case 'direct': // 频道私信
                chatId = e.guild_id || e.channel_id;
                chatType = 'private';
                break;
            default:
                return;
        }
        if (!chatId) return;
        chatId = String(chatId);

        // 会话白名单
        if (this.config.allowedChats?.length > 0 && !this.config.allowedChats.includes(chatId)) {
            return;
        }

        // 缓存回复上下文（被动回复窗口内使用）
        this._replyCtx.set(chatId, { event: e, ts: Date.now() });
        this._cleanReplyCtx();

        // 内容与媒体
        const { text, media } = this._parseMessage(e);
        if (!text && media.length === 0) return;

        // 群/频道消息由 @ 触发（GROUP_AT_MESSAGE_CREATE），故 mentioned 恒真；单聊亦视为定向
        const inbound = new InboundMessage({
            platform: 'qqofficial',
            messageId: String(e.message_id || e.id || ''),
            chatId,
            chatType,
            senderId: String(e.sender?.user_id || e.user_id || ''),
            senderName: e.sender?.user_openid || e.sender?.nickname || String(e.user_id || 'QQ用户'),
            content: text,
            media,
            mentioned: true,
            timestamp: (e.timestamp ? new Date(e.timestamp).getTime() : Date.now()) || Date.now(),
            raw: e,
        });

        this.emit('message', inbound);
    }

    /** 解析消息内容与媒体 */
    _parseMessage(e) {
        const media = [];
        let text = '';

        // 优先用结构化 message 段
        const segs = Array.isArray(e.message) ? e.message : null;
        if (segs) {
            for (const seg of segs) {
                if (seg.type === 'text') text += seg.text || seg.data?.text || '';
                else if (seg.type === 'image') {
                    const url = seg.url || seg.data?.url || seg.file || '';
                    if (url) media.push(new MediaAsset({ type: MediaType.IMAGE, url, platform: 'qqofficial' }));
                    text += '[图片] ';
                } else if (seg.type === 'at') {
                    // @ 段：官方 SDK 通常已按 removeAt 处理，这里忽略
                }
            }
        } else {
            text = e.raw_message || e.content || '';
        }

        // 附件形式的媒体
        for (const att of (e.attachments || [])) {
            if (att.url) {
                const isImg = (att.content_type || '').startsWith('image');
                media.push(new MediaAsset({
                    type: isImg ? MediaType.IMAGE : MediaType.FILE,
                    url: att.url, platform: 'qqofficial', name: att.filename || '',
                }));
            }
        }

        return { text: text.trim(), media };
    }

    /**
     * 发送消息
     * @param {import('./base-adapter.js').OutboundMessage} message
     */
    async send(message) {
        if (!this.isConnected() || !this.bot) throw new Error('QQ 官方机器人未连接');

        const chatId = String(message.chatId);
        const ctx = this._replyCtx.get(chatId);
        const fresh = ctx && (Date.now() - ctx.ts) < this._replyTtl;

        // 构造发送内容：文本 + 图片段
        const outSegments = [];
        if (message.content) outSegments.push({ type: 'text', text: message.content });
        for (const m of (message.media || [])) {
            if (m.type === MediaType.IMAGE && (m.url || m.localPath)) {
                outSegments.push({ type: 'image', file: m.url || m.localPath });
            }
        }
        if (outSegments.length === 0) return true;

        // 优先被动回复（引用最近消息，符合官方要求且成功率高）
        if (fresh && typeof ctx.event.reply === 'function') {
            await ctx.event.reply(outSegments.length === 1 && outSegments[0].type === 'text'
                ? message.content
                : outSegments);
            return true;
        }

        // 窗口外：尝试主动推送（官方对主动消息有严格限制，可能失败）
        const payload = outSegments.length === 1 && outSegments[0].type === 'text' ? message.content : outSegments;
        if (message.chatType === 'group' && this.bot.sendGroupMessage) {
            await this.bot.sendGroupMessage(chatId, payload);
        } else if (message.chatType === 'channel' && this.bot.sendGuildMessage) {
            await this.bot.sendGuildMessage(chatId, payload);
        } else if (this.bot.sendPrivateMessage) {
            await this.bot.sendPrivateMessage(chatId, payload);
        } else {
            throw new Error('无可用发送通道（被动回复窗口已过期，且主动推送不可用）');
        }
        return true;
    }

    _cleanReplyCtx() {
        const cutoff = Date.now() - this._replyTtl;
        for (const [k, v] of this._replyCtx) {
            if (v.ts < cutoff) this._replyCtx.delete(k);
        }
    }

    async verify() {
        if (this.isConnected()) {
            return { ok: true, state: this.state, message: '已连接' };
        }
        if (!this.config.appId || !this.config.secret) {
            return { ok: false, state: this.state, message: 'appId / secret 未配置' };
        }
        // 未连接时无法在不建立会话的情况下轻量校验，给出配置存在性反馈
        try {
            await import('qq-official-bot');
            return { ok: false, state: this.state, message: '凭据已填写，请启用并启动后查看连接状态' };
        } catch (e) {
            return { ok: false, state: this.state, message: '未安装 SDK: npm install qq-official-bot' };
        }
    }
}

export default QQOfficialAdapter;
