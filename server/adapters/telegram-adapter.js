import TelegramBot from 'node-telegram-bot-api';
import { PlatformAdapter, ConnectionState, InboundMessage, OutboundMessage } from './base-adapter.js';

/**
 * Telegram Bot 适配器
 * 支持 Long Polling（无需公网IP）和 Webhook 两种模式
 */
export class TelegramAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('telegram', config);
        this.bot = null;
        this.botInfo = null;
    }

    /**
     * 建立连接
     */
    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
            return;
        }

        if (!this.config.botToken) {
            throw new Error('Telegram Bot Token 未配置');
        }

        this.setState(ConnectionState.CONNECTING);
        this.logger.info('正在连接 Telegram Bot API...');

        try {
            const polling = this.config.mode !== 'webhook';

            this.bot = new TelegramBot(this.config.botToken, {
                polling: polling ? {
                    interval: 300,
                    autoStart: true,
                    params: {
                        timeout: 30,
                        allowed_updates: ['message', 'edited_message', 'callback_query'],
                    },
                } : false,
            });

            // 获取 Bot 信息
            this.botInfo = await this.bot.getMe();
            this.logger.info(`Telegram Bot 已连接: @${this.botInfo.username} (${this.botInfo.first_name})`);

            // 注册消息处理器
            this.setupMessageHandlers();

            // 注册错误处理
            this.bot.on('polling_error', (error) => {
                this.logger.error(`Polling 错误: ${error.message}`);
                if (error.code === 'ETELEGRAM' && error.response?.statusCode === 401) {
                    this.handleDisconnect('Token 无效');
                }
            });

            this.bot.on('webhook_error', (error) => {
                this.logger.error(`Webhook 错误: ${error.message}`);
            });

            this.setState(ConnectionState.CONNECTED);
            this.emit('connected');
        } catch (error) {
            this.logger.error(`Telegram 连接失败: ${error.message}`);
            this.setState(ConnectionState.ERROR);
            throw error;
        }
    }

    /**
     * 设置消息处理器
     */
    setupMessageHandlers() {
        // 处理普通消息
        this.bot.on('message', (msg) => {
            this.handleTelegramMessage(msg);
        });

        // 处理编辑的消息
        this.bot.on('edited_message', (msg) => {
            this.logger.debug(`消息已编辑: ${msg.message_id}`);
        });

        // 处理回调查询（按钮点击）
        this.bot.on('callback_query', (query) => {
            this.handleCallbackQuery(query);
        });
    }

    /**
     * 处理 Telegram 消息
     * @param {object} msg - Telegram 消息对象
     */
    handleTelegramMessage(msg) {
        // 忽略频道消息和系统消息
        if (msg.channel_post || msg.left_chat_member || msg.new_chat_members) {
            return;
        }

        const chat = msg.chat;
        const from = msg.from;

        if (!from) return;

        // 白名单检查
        if (this.config.allowedUsers?.length > 0) {
            if (!this.config.allowedUsers.includes(String(from.id))) {
                this.logger.debug(`用户 ${from.id} 不在白名单中，忽略`);
                return;
            }
        }

        // 群组中检查是否需要 @
        let mentioned = false;
        let content = '';

        if (chat.type === 'group' || chat.type === 'supergroup') {
            if (this.config.requireMention) {
                // 检查是否 @了 bot
                const entities = msg.entities || [];
                const botUsername = this.botInfo?.username?.toLowerCase();

                mentioned = entities.some(entity =>
                    entity.type === 'mention' &&
                    msg.text?.substring(entity.offset, entity.offset + entity.length).toLowerCase() === `@${botUsername}`
                );

                // 也检查 reply_to_message 是否回复了 bot
                if (msg.reply_to_message?.from?.id === this.botInfo?.id) {
                    mentioned = true;
                }

                if (!mentioned) {
                    return; // 群组中未 @ bot，忽略
                }

                // 移除 @mention 部分
                content = this.removeMention(msg.text || '', botUsername);
            } else {
                content = msg.text || '';
            }
        } else {
            // 私聊直接处理
            content = msg.text || '';
            mentioned = true;
        }

        // 提取媒体
        const mediaUrls = this.extractMedia(msg);

        // 处理非文本消息
        if (!content && !mediaUrls.length) {
            if (msg.sticker) content = '[贴纸]';
            else if (msg.voice) content = '[语音消息]';
            else if (msg.video) content = '[视频]';
            else if (msg.document) content = `[文件: ${msg.document.file_name}]`;
            else if (msg.location) content = '[位置分享]';
            else if (msg.contact) content = `[联系人: ${msg.contact.first_name}]`;
            else return;
        }

        // 转换为标准入站消息
        const inboundMsg = new InboundMessage({
            platform: 'telegram',
            messageId: String(msg.message_id),
            chatId: String(chat.id),
            chatType: chat.type === 'private' ? 'private' : 'group',
            senderId: String(from.id),
            senderName: from.first_name + (from.last_name ? ` ${from.last_name}` : ''),
            content: content.trim(),
            mediaUrls,
            timestamp: msg.date * 1000,
            mentioned,
            replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : '',
            raw: msg,
        });

        this.emit('message', inboundMsg);
    }

    /**
     * 处理回调查询
     */
    handleCallbackQuery(query) {
        this.logger.debug(`回调查询: ${query.data}`);
        // 可以在这里处理按钮交互
        this.bot.answerCallbackQuery(query.id);
    }

    /**
     * 发送消息
     * @param {OutboundMessage} message
     * @returns {Promise<boolean>}
     */
    async send(message) {
        if (!this.bot) {
            throw new Error('Telegram Bot 未初始化');
        }

        const chatId = message.chatId;

        try {
            // 发送文本消息
            if (message.content) {
                const options = {
                    parse_mode: 'Markdown',
                };

                if (message.replyToId) {
                    options.reply_to_message_id = message.replyToId;
                }

                // 分段发送长文本
                const segments = this.splitMessage(message.content, 4096);
                for (const segment of segments) {
                    try {
                        await this.bot.sendMessage(chatId, segment, options);
                    } catch (error) {
                        // Markdown 解析失败时，回退到纯文本
                        if (error.message.includes('parse')) {
                            delete options.parse_mode;
                            await this.bot.sendMessage(chatId, segment, options);
                        } else {
                            throw error;
                        }
                    }

                    // 分段间延迟
                    if (segments.length > 1) {
                        await this.delay(300);
                    }
                }
            }

            // 发送图片
            for (const url of message.mediaUrls) {
                try {
                    await this.bot.sendPhoto(chatId, url);
                } catch (error) {
                    this.logger.warn(`图片发送失败: ${error.message}`);
                }
            }

            return true;
        } catch (error) {
            this.logger.error(`Telegram 消息发送失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 断开连接
     */
    async disconnect() {
        if (this.bot) {
            try {
                this.bot.stopPolling();
                this.bot.removeAllListeners();
            } catch (error) {
                this.logger.warn(`停止 polling 时出错: ${error.message}`);
            }
            this.bot = null;
        }
        this.botInfo = null;
        this.setState(ConnectionState.DISCONNECTED);
    }

    /**
     * 验证连接：
     *   - 已连接：直接返回 bot 信息
     *   - 未连接：用临时 bot 实例调用 getMe() 校验 Token 有效性（不启动轮询）
     */
    async verify() {
        if (this.isConnected() && this.botInfo) {
            return {
                ok: true,
                state: this.state,
                message: `已连接: @${this.botInfo.username} (${this.botInfo.first_name})`,
                detail: { username: this.botInfo.username, name: this.botInfo.first_name },
            };
        }

        if (!this.config.botToken) {
            return { ok: false, state: this.state, message: 'Bot Token 未配置' };
        }

        let tempBot = null;
        try {
            tempBot = new TelegramBot(this.config.botToken, { polling: false });
            const me = await tempBot.getMe();
            return {
                ok: true,
                state: this.state,
                message: `Token 有效: @${me.username} (${me.first_name})`,
                detail: { username: me.username, name: me.first_name },
            };
        } catch (error) {
            return { ok: false, state: this.state, message: `验证失败: ${error.message}` };
        } finally {
            try {
                if (tempBot) {
                    tempBot.stopPolling();
                    tempBot.removeAllListeners();
                }
            } catch (_) { /* 忽略清理错误 */ }
        }
    }

    /**
     * 提取消息中的媒体URL
     */
    extractMedia(msg) {
        const urls = [];

        if (msg.photo && msg.photo.length > 0) {
            // 获取最大尺寸的图片
            const photo = msg.photo[msg.photo.length - 1];
            urls.push(`tg://photo/${photo.file_id}`);
        }

        if (msg.audio) {
            urls.push(`tg://audio/${msg.audio.file_id}`);
        }

        if (msg.voice) {
            urls.push(`tg://voice/${msg.voice.file_id}`);
        }

        return urls;
    }

    /**
     * 同步命令列表到 Telegram
     * 调用 Bot API setMyCommands，使用户在聊天框输入 "/" 时弹出命令列表
     *
     * @param {Array<{name: string, description: string}>} commands - 网关命令列表
     * @returns {Promise<boolean>}
     */
    async syncCommands(commands) {
        if (!this.bot) {
            this.logger.warn('Telegram Bot 未初始化，无法同步命令');
            return false;
        }

        try {
            // Telegram 命令名限制：小写字母+数字+下划线，最长 32 字符
            const tgCommands = [];
            const seen = new Set();

            for (const cmd of commands) {
                // 转换命令名：只保留 a-z 0-9 _，其余替换为下划线
                let name = cmd.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                name = name.replace(/^_+/, '').substring(0, 32);

                if (!name || seen.has(name)) continue;
                seen.add(name);

                // 描述截断到 256 字符
                const desc = (cmd.description || cmd.name).substring(0, 256);
                tgCommands.push({ command: name, description: desc });
            }

            // Telegram 限制最多 100 个命令
            const trimmed = tgCommands.slice(0, 100);

            // 私聊补全
            await this.bot.setMyCommands(trimmed, { scope: { type: 'all_private_chats' } });
            this.logger.info(`已同步 ${trimmed.length} 个命令到 Telegram（私聊补全）`);

            // 群聊补全（部分客户端支持）
            try {
                await this.bot.setMyCommands(trimmed, { scope: { type: 'all_group_chats' } });
                this.logger.debug('已同步命令到 Telegram 群聊补全');
            } catch (_) {
                // 群聊 scope 可能不支持，忽略
            }

            return true;
        } catch (error) {
            this.logger.error(`同步命令到 Telegram 失败: ${error.message}`);
            return false;
        }
    }

    /**
     * 移除消息中的 @mention
     */
    removeMention(text, botUsername) {
        if (!text || !botUsername) return text || '';
        const mentionRegex = new RegExp(`@${botUsername}\\s*`, 'gi');
        return text.replace(mentionRegex, '').trim();
    }

    /**
     * 延迟工具
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default TelegramAdapter;
