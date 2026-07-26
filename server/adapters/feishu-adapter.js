import { Readable } from 'stream';
import { PlatformAdapter, ConnectionState, InboundMessage, MediaAsset, MediaType } from './base-adapter.js';
import { mediaStore } from '../media/media-store.js';

/**
 * 飞书 / Lark 官方平台适配器
 *
 * 采用官方开放平台 SDK（@larksuiteoapi/node-sdk）的**长连接模式**（WSClient），
 * 无需公网 IP，适合个人部署（与 Telegram polling 类似）。SDK 内部自动管理
 * tenant_access_token 刷新与长连接重连。
 *
 * 依赖为可选：SDK 未安装时不影响网关启动（仅本适配器在 connect 时报错）。
 * 安装：在项目根执行 `npm install @larksuiteoapi/node-sdk`
 *
 * 参考：https://open.feishu.cn/document/ | AstrBot lark 适配器设计
 */
export class FeishuAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('feishu', config);
        this.lark = null;         // 动态导入的 SDK 命名空间
        this.client = null;       // API 客户端
        this.wsClient = null;     // 长连接客户端
        this.botOpenId = null;    // 机器人自身 open_id（用于精确 @ 判定）
        this.botName = '';
    }

    /** 域名映射：feishu(国内) / lark(海外) */
    _domain() {
        const d = (this.config.domain || 'feishu').toLowerCase();
        if (this.lark?.Domain) {
            return d === 'lark' ? this.lark.Domain.Lark : this.lark.Domain.Feishu;
        }
        return d === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    }

    /**
     * 建立连接
     */
    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) return;

        if (!this.config.appId || !this.config.appSecret) {
            throw new Error('飞书 appId / appSecret 未配置');
        }
        if (this.config.mode === 'webhook') {
            // 诚实声明：webhook 模式尚未实现，避免像“连上了却收不到消息”的静默假象
            throw new Error('飞书 webhook 模式尚未实现，请使用长连接模式（mode=websocket，无需公网 IP）');
        }

        this.setState(ConnectionState.CONNECTING);

        // 动态导入官方 SDK（未安装时给出清晰指引，不拖垮网关）
        try {
            const mod = await import('@larksuiteoapi/node-sdk');
            this.lark = (mod.default && mod.default.Client) ? mod.default : mod;
        } catch (e) {
            throw new Error('未安装飞书 SDK，请在项目根执行: npm install @larksuiteoapi/node-sdk');
        }

        const lark = this.lark;
        const domain = this._domain();

        // API 客户端（发送消息、上传素材、查询 bot 信息）
        this.client = new lark.Client({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            appType: lark.AppType?.SelfBuild,
            domain,
        });

        // 查询机器人自身 open_id，用于群聊精确 @ 判定
        await this._fetchBotInfo();

        // 事件分发器：注册“接收消息”事件
        const eventDispatcher = new lark.EventDispatcher({
            encryptKey: this.config.encryptKey || undefined,
            verificationToken: this.config.verificationToken || undefined,
        }).register({
            'im.message.receive_v1': async (data) => {
                try {
                    await this._onMessageEvent(data);
                } catch (err) {
                    this.logger.error(`处理飞书消息失败: ${err.message}`);
                }
                return { code: 0 };
            },
        });

        // 长连接客户端（内部自动重连；SDK 管理连接生命周期）
        this.wsClient = new lark.WSClient({
            appId: this.config.appId,
            appSecret: this.config.appSecret,
            domain,
        });

        await this.wsClient.start({ eventDispatcher });

        this.logger.info(`飞书长连接已建立${this.botName ? ` (机器人: ${this.botName})` : ''}`);
        this.setState(ConnectionState.CONNECTED);
        this.emit('connected');
    }

    /** 查询机器人信息（open_id / 名称），失败不致命 */
    async _fetchBotInfo() {
        try {
            const resp = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
            const bot = resp?.bot || resp?.data?.bot || resp;
            this.botOpenId = bot?.open_id || null;
            this.botName = bot?.app_name || '';
        } catch (e) {
            this.logger.warn(`获取飞书机器人信息失败（@判定将退化为启发式）: ${e.message}`);
        }
    }

    /**
     * 断开连接
     */
    async disconnect() {
        try {
            // SDK WSClient 无统一 stop API，尽力关闭
            if (this.wsClient?.stop) await this.wsClient.stop();
            else if (this.wsClient?.close) this.wsClient.close();
        } catch (e) {
            this.logger.warn(`关闭飞书长连接出错: ${e.message}`);
        } finally {
            this.wsClient = null;
            this.client = null;
        }
        this.setState(ConnectionState.DISCONNECTED);
    }

    /**
     * 处理接收到的消息事件 → 统一 InboundMessage
     * @param {object} data - im.message.receive_v1 事件体 { sender, message }
     */
    async _onMessageEvent(data) {
        const message = data?.message;
        const sender = data?.sender;
        if (!message || !sender) return;

        // 机器人自己发的消息不处理（回环防护）
        const senderOpenId = sender.sender_id?.open_id || '';
        if (this.botOpenId && senderOpenId === this.botOpenId) return;

        const chatId = message.chat_id;
        const isGroup = message.chat_type === 'group';
        const chatType = isGroup ? 'group' : 'private';

        // 会话白名单
        if (this.config.allowedChats?.length > 0 && !this.config.allowedChats.includes(chatId)) {
            this.logger.debug(`会话 ${chatId} 不在白名单，忽略`);
            return;
        }

        // @ 判定：群聊中检查是否 @ 了机器人
        const mentions = Array.isArray(message.mentions) ? message.mentions : [];
        const mentioned = this.botOpenId
            ? mentions.some(m => m.id?.open_id === this.botOpenId)
            : mentions.length > 0; // 无 botOpenId 时退化为启发式

        if (isGroup && this.config.requireMention && !mentioned) {
            return; // 群聊未 @ bot，忽略
        }

        // 解析内容 + 媒体
        const { text, media } = await this._parseContent(message);

        if (!text && media.length === 0) return;

        const inbound = new InboundMessage({
            platform: 'feishu',
            messageId: message.message_id,
            chatId,
            chatType,
            senderId: senderOpenId,
            senderName: sender.sender_id?.user_id || senderOpenId || '飞书用户',
            content: text,
            media,
            mentioned: mentioned || !isGroup,
            timestamp: parseInt(message.create_time) || Date.now(),
            raw: data,
        });

        this.emit('message', inbound);
    }

    /**
     * 解析飞书消息内容（按 message_type）
     * @returns {Promise<{text: string, media: MediaAsset[]}>}
     */
    async _parseContent(message) {
        const type = message.message_type;
        let raw = {};
        try { raw = JSON.parse(message.content || '{}'); } catch (_) { raw = {}; }

        const media = [];
        let text = '';

        switch (type) {
            case 'text': {
                text = raw.text || '';
                // 去除 @ 占位符（@_user_1 等），替换为对应名称或移除
                for (const m of (message.mentions || [])) {
                    if (m.key) text = text.split(m.key).join(m.name ? `@${m.name}` : '');
                }
                // 去掉指向机器人自己的 @，避免污染上下文
                if (this.botName) text = text.split(`@${this.botName}`).join('');
                text = text.replace(/\s+/g, ' ').trim();
                break;
            }
            case 'post': {
                // 富文本：尽力提取纯文本
                text = this._extractPostText(raw);
                break;
            }
            case 'image': {
                media.push(new MediaAsset({
                    type: MediaType.IMAGE, platform: 'feishu',
                    fileId: raw.image_key || '',
                }));
                text = '[图片]';
                break;
            }
            case 'audio': {
                media.push(new MediaAsset({
                    type: MediaType.VOICE, platform: 'feishu',
                    fileId: raw.file_key || '', duration: raw.duration || 0,
                }));
                text = '[语音]';
                break;
            }
            case 'media': // 视频
            case 'video': {
                media.push(new MediaAsset({
                    type: MediaType.VIDEO, platform: 'feishu', fileId: raw.file_key || '',
                }));
                text = '[视频]';
                break;
            }
            case 'file': {
                media.push(new MediaAsset({
                    type: MediaType.FILE, platform: 'feishu',
                    fileId: raw.file_key || '', name: raw.file_name || '',
                }));
                text = `[文件: ${raw.file_name || ''}]`;
                break;
            }
            default:
                text = `[${type}]`;
        }

        // 尽力下载入站媒体到缓存，供跨平台转发/多模态使用（失败不致命）
        for (const asset of media) {
            if (asset.fileId) {
                try {
                    await this._resolveInboundMedia(message.message_id, asset);
                } catch (e) {
                    this.logger.debug(`下载飞书媒体失败: ${e.message}`);
                }
            }
        }

        return { text, media };
    }

    /** 递归提取 post 富文本中的文本片段 */
    _extractPostText(post) {
        const parts = [];
        const walk = (node) => {
            if (!node) return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (typeof node === 'object') {
                if (node.tag === 'text' && node.text) parts.push(node.text);
                if (node.tag === 'a' && node.text) parts.push(node.text);
                for (const k of Object.keys(node)) {
                    if (k !== 'tag' && k !== 'text') walk(node[k]);
                }
            }
        };
        walk(post);
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * 把入站媒体（image_key / file_key）下载并落地到 mediaStore，
     * 赋值 asset.localPath + 生成可对外访问的稳定 URL。
     */
    async _resolveInboundMedia(messageId, asset) {
        const type = asset.type === MediaType.IMAGE ? 'image' : 'file';
        const fileKey = asset.fileId;
        const resp = await this.client.im.messageResource.get({
            path: { message_id: messageId, file_key: fileKey },
            params: { type },
        });
        // SDK 返回可写出的响应，尽力拿到 Buffer
        let buf = null;
        if (resp?.getReadableStream) {
            const stream = resp.getReadableStream();
            const chunks = [];
            for await (const c of stream) chunks.push(c);
            buf = Buffer.concat(chunks);
        } else if (Buffer.isBuffer(resp)) {
            buf = resp;
        }
        if (buf) {
            const id = mediaStore.registerBuffer
                ? mediaStore.registerBuffer(buf)
                : null;
            if (id && this.config.mediaBaseUrl) {
                asset.url = `${this.config.mediaBaseUrl}/media/${id}`;
            }
        }
    }

    /**
     * 发送消息
     * @param {import('./base-adapter.js').OutboundMessage} message
     * @returns {Promise<boolean>}
     */
    async send(message) {
        if (!this.isConnected() || !this.client) throw new Error('飞书未连接');

        // 文本
        if (message.content) {
            await this.client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: message.chatId,
                    msg_type: 'text',
                    content: JSON.stringify({ text: message.content }),
                },
            });
        }

        // 媒体：图片上传后发送 image_key；其它类型尽力，失败则退化为文本链接
        for (const asset of (message.media || [])) {
            try {
                if (asset.type === MediaType.IMAGE) {
                    const imageKey = await this._uploadImage(asset);
                    if (imageKey) {
                        await this.client.im.message.create({
                            params: { receive_id_type: 'chat_id' },
                            data: {
                                receive_id: message.chatId,
                                msg_type: 'image',
                                content: JSON.stringify({ image_key: imageKey }),
                            },
                        });
                        continue;
                    }
                }
                // 其它媒体或上传失败：发送可访问 URL 作为兜底
                const url = asset.url || asset.localPath;
                if (url) {
                    await this.client.im.message.create({
                        params: { receive_id_type: 'chat_id' },
                        data: {
                            receive_id: message.chatId,
                            msg_type: 'text',
                            content: JSON.stringify({ text: `${asset.placeholder()} ${url}` }),
                        },
                    });
                }
            } catch (e) {
                this.logger.warn(`飞书媒体发送失败(${asset.type}): ${e.message}`);
            }
        }

        return true;
    }

    /** 上传图片到飞书获取 image_key（从 url/localPath 取字节） */
    async _uploadImage(asset) {
        let stream = null;
        if (asset.url) {
            const resp = await fetch(asset.url);
            if (!resp.ok) throw new Error(`拉取图片失败 HTTP ${resp.status}`);
            stream = Readable.fromWeb(resp.body);
        } else if (asset.localPath) {
            const fs = await import('fs');
            stream = fs.createReadStream(asset.localPath);
        }
        if (!stream) return null;

        const res = await this.client.im.image.create({
            data: { image_type: 'message', image: stream },
        });
        return res?.image_key || res?.data?.image_key || null;
    }

    /**
     * 凭据校验（面板"验证"按钮）
     */
    async verify() {
        if (this.isConnected()) {
            return { ok: true, state: this.state, message: `已连接${this.botName ? ` (${this.botName})` : ''}` };
        }
        if (!this.config.appId || !this.config.appSecret) {
            return { ok: false, state: this.state, message: 'appId / appSecret 未配置' };
        }
        // 尝试用 SDK 拉取 bot 信息验证凭据
        try {
            const mod = await import('@larksuiteoapi/node-sdk');
            const lark = (mod.default && mod.default.Client) ? mod.default : mod;
            const client = new lark.Client({
                appId: this.config.appId, appSecret: this.config.appSecret,
                appType: lark.AppType?.SelfBuild, domain: this._domain(),
            });
            const resp = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
            const name = resp?.bot?.app_name || resp?.data?.bot?.app_name || '';
            return { ok: true, state: this.state, message: `凭据有效${name ? ` (${name})` : ''}` };
        } catch (e) {
            if (String(e.message).includes('SDK') || e.code === 'ERR_MODULE_NOT_FOUND') {
                return { ok: false, state: this.state, message: '未安装飞书 SDK: npm install @larksuiteoapi/node-sdk' };
            }
            return { ok: false, state: this.state, message: `凭据校验失败: ${e.message}` };
        }
    }
}

export default FeishuAdapter;
