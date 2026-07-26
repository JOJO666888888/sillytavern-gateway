import { PlatformAdapter, ConnectionState, InboundMessage, MediaAsset, MediaType } from './base-adapter.js';

/**
 * 钉钉（DingTalk）机器人适配器
 *
 * 采用官方 **Stream 模式**（长连接，免公网 IP），与 Telegram polling / 飞书长连接
 * 同类，适合个人部署。SDK：`dingtalk-stream`。依赖可选，未安装不影响网关启动。
 * 安装：`npm install dingtalk-stream`
 *
 * ⚠️ 钉钉回复机制：每条上行消息带一个 `sessionWebhook`（临时回复地址，有时效，
 *   约 1.5 小时 / 有限次数）。适配器缓存每个会话最近的 sessionWebhook 用于回复；
 *   过期后需等待用户再次发言（钉钉主动推送需另配自定义机器人 webhook，不在此实现）。
 *
 * 参考：https://open.dingtalk.com/document/ | AstrBot dingtalk 适配器
 */
export class DingTalkAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('dingtalk', config);
        this.client = null;
        this.DWClient = null;
        // chatId -> { webhook, ts }
        this._sessionWebhooks = new Map();
        this._webhookTtl = 80 * 60 * 1000; // 约 80 分钟，略小于官方 1.5h 窗口
    }

    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) return;

        if (!this.config.clientId || !this.config.clientSecret) {
            throw new Error('钉钉 clientId(AppKey) / clientSecret(AppSecret) 未配置');
        }

        this.setState(ConnectionState.CONNECTING);

        let mod;
        try {
            mod = await import('dingtalk-stream');
        } catch (e) {
            throw new Error('未安装钉钉 SDK，请执行: npm install dingtalk-stream');
        }
        const { DWClient, TOPIC_ROBOT, EventAck } = mod.default?.DWClient ? mod.default : mod;
        this.DWClient = DWClient;
        this._EventAck = EventAck;
        this._TOPIC_ROBOT = TOPIC_ROBOT || '/v1.0/im/bot/messages/get';

        this.client = new DWClient({
            clientId: String(this.config.clientId),
            clientSecret: String(this.config.clientSecret),
        });

        // 注册机器人消息回调
        this.client.registerCallbackListener(this._TOPIC_ROBOT, (res) => {
            // 先 ack 再处理：SDK 内部只是 EventEmitter.emit，**回调的返回值会被丢弃**，
            // 必须显式调用 socketCallBackResponse。不 ack 的话钉钉服务端会认为
            // 消息未送达，每 60s 重推一次同一条消息 —— 表现为"同一句话被回复很多遍"。
            this._ack(res);
            try {
                this._onMessage(res);
            } catch (err) {
                this.logger.error(`处理钉钉消息失败: ${err.message}`);
            }
        });

        await this.client.connect();

        this.logger.info('钉钉 Stream 长连接已建立');
        this.setState(ConnectionState.CONNECTED);
        this.emit('connected');
    }

    async disconnect() {
        try {
            if (this.client?.disconnect) await this.client.disconnect();
            else if (this.client?.close) this.client.close();
        } catch (e) {
            this.logger.warn(`关闭钉钉连接出错: ${e.message}`);
        } finally {
            this.client = null;
            this._sessionWebhooks.clear();
        }
        this.setState(ConnectionState.DISCONNECTED);
    }

    /** 回执一条 Stream 推送，告诉钉钉服务端"收到了，别重推" */
    _ack(res) {
        const messageId = res?.headers?.messageId;
        if (!messageId || typeof this.client?.socketCallBackResponse !== 'function') return;
        try {
            this.client.socketCallBackResponse(messageId, {
                status: this._EventAck?.SUCCESS || 'SUCCESS',
                message: 'OK',
            });
        } catch (err) {
            this.logger.warn(`钉钉消息回执失败: ${err.message}`);
        }
    }

    /**
     * 处理钉钉机器人消息回调
     * res.data 为 JSON 字符串，含 msgtype / text / conversationId / sessionWebhook 等
     */
    _onMessage(res) {
        let data = res?.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (_) { return; }
        }
        if (!data) return;

        // 会话标识：单聊用 senderStaffId，群聊用 conversationId
        const isGroup = data.conversationType === '2';
        const chatId = String(isGroup ? data.conversationId : (data.senderStaffId || data.senderId || data.conversationId));
        const chatType = isGroup ? 'group' : 'private';

        // 会话白名单
        if (this.config.allowedChats?.length > 0 && !this.config.allowedChats.includes(chatId)) {
            return;
        }

        // 缓存本次会话的临时回复地址
        if (data.sessionWebhook) {
            this._sessionWebhooks.set(chatId, { webhook: data.sessionWebhook, ts: Date.now() });
            this._cleanWebhooks();
        }

        // 群聊中钉钉默认只在 @机器人 时推送；isInAtList/atUsers 可辅助判定
        const mentioned = isGroup
            ? (Array.isArray(data.atUsers) && data.atUsers.some(u => u.dingtalkId === data.chatbotUserId)) || true
            : true;

        const { text, media } = this._parseMessage(data);
        if (!text && media.length === 0) return;

        const inbound = new InboundMessage({
            platform: 'dingtalk',
            messageId: String(data.msgId || ''),
            chatId,
            chatType,
            senderId: String(data.senderStaffId || data.senderId || ''),
            senderName: data.senderNick || '钉钉用户',
            content: text,
            media,
            mentioned,
            timestamp: parseInt(data.createAt) || Date.now(),
            raw: data,
        });

        this.emit('message', inbound);
    }

    /** 解析钉钉消息内容与媒体 */
    _parseMessage(data) {
        const media = [];
        let text = '';

        switch (data.msgtype) {
            case 'text':
                text = (data.text?.content || '').trim();
                break;
            case 'richText': {
                const items = data.content?.richText || [];
                text = items.map(i => i.text || '').join(' ').trim();
                // 富文本里可能含图片(downloadCode)，钉钉需二次换取，暂记占位
                if (items.some(i => i.type === 'picture' || i.downloadCode)) text += ' [图片]';
                break;
            }
            case 'picture': {
                const code = data.content?.downloadCode;
                media.push(new MediaAsset({ type: MediaType.IMAGE, platform: 'dingtalk', fileId: code || '' }));
                text = '[图片]';
                break;
            }
            case 'audio': {
                media.push(new MediaAsset({
                    type: MediaType.VOICE, platform: 'dingtalk',
                    fileId: data.content?.downloadCode || '', duration: data.content?.duration || 0,
                }));
                text = data.content?.recognition || '[语音]';
                break;
            }
            case 'file':
                media.push(new MediaAsset({
                    type: MediaType.FILE, platform: 'dingtalk',
                    fileId: data.content?.downloadCode || '', name: data.content?.fileName || '',
                }));
                text = `[文件: ${data.content?.fileName || ''}]`;
                break;
            default:
                text = data.text?.content || `[${data.msgtype || '未知'}]`;
        }
        return { text, media };
    }

    /**
     * 发送消息（通过会话的临时 sessionWebhook 被动回复）
     * @param {import('./base-adapter.js').OutboundMessage} message
     */
    async send(message) {
        if (!this.isConnected()) throw new Error('钉钉未连接');

        const chatId = String(message.chatId);
        const ctx = this._sessionWebhooks.get(chatId);
        if (!ctx || (Date.now() - ctx.ts) >= this._webhookTtl) {
            throw new Error('钉钉回复窗口已过期（需用户再次发言获取新的 sessionWebhook）');
        }

        // 组装消息体：有图片则用 markdown 嵌入，否则纯文本
        let body;
        const imageUrls = (message.media || [])
            .filter(m => m.type === MediaType.IMAGE && (m.url || m.localPath))
            .map(m => m.url || m.localPath);

        if (imageUrls.length > 0) {
            const imgMd = imageUrls.map(u => `![img](${u})`).join('\n');
            body = {
                msgtype: 'markdown',
                markdown: { title: '回复', text: `${message.content || ''}\n\n${imgMd}` },
            };
        } else {
            body = { msgtype: 'text', text: { content: message.content || '' } };
        }

        const resp = await fetch(ctx.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            throw new Error(`钉钉回复失败 HTTP ${resp.status}`);
        }
        const result = await resp.json().catch(() => ({}));
        if (result.errcode && result.errcode !== 0) {
            throw new Error(`钉钉回复失败: ${result.errmsg || result.errcode}`);
        }
        return true;
    }

    _cleanWebhooks() {
        const cutoff = Date.now() - this._webhookTtl;
        for (const [k, v] of this._sessionWebhooks) {
            if (v.ts < cutoff) this._sessionWebhooks.delete(k);
        }
    }

    async verify() {
        if (this.isConnected()) {
            return { ok: true, state: this.state, message: '已连接' };
        }
        if (!this.config.clientId || !this.config.clientSecret) {
            return { ok: false, state: this.state, message: 'clientId / clientSecret 未配置' };
        }
        try {
            await import('dingtalk-stream');
            return { ok: false, state: this.state, message: '凭据已填写，请启用并启动后查看连接状态' };
        } catch (e) {
            return { ok: false, state: this.state, message: '未安装 SDK: npm install dingtalk-stream' };
        }
    }
}

export default DingTalkAdapter;
