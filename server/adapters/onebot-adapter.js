import WebSocket from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { PlatformAdapter, ConnectionState, InboundMessage, OutboundMessage } from './base-adapter.js';
import { parseEvent, OneBotAPI, contentToSegments } from '../protocols/onebot-v11.js';

/**
 * QQ OneBot v11 适配器
 * 支持正向 WebSocket（连接 NapCat/Lagrange 的 WS 服务端）
 * 和反向 WebSocket（作为 WS 服务端等待 OneBot 实现连入）
 */
export class OneBotAdapter extends PlatformAdapter {
    constructor(config = {}) {
        super('qq', config);

        this.ws = null;
        this.wss = null;  // 反向 WS 服务端
        this.selfId = null;
        this.heartbeatTimer = null;
        this.pendingApiCalls = new Map(); // echo -> {resolve, reject, timer}
        this.recentMessages = new Map();  // messageId -> timestamp (去重用)
        this.dedupWindow = config.messageDedupWindow || 30000;

        // 定期清理去重缓存
        this.dedupCleanupTimer = setInterval(() => this.cleanupDedupCache(), 60000);
    }

    /**
     * 建立连接
     */
    async connect() {
        if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
            return;
        }

        this.setState(ConnectionState.CONNECTING);

        if (this.config.mode === 'reverse') {
            await this.startReverseWebSocket();
        } else {
            await this.connectForwardWebSocket();
        }
    }

    /**
     * 正向 WebSocket - 连接到 NapCat/Lagrange 的 WS 服务端
     */
    async connectForwardWebSocket() {
        const wsUrl = this.config.wsUrl || 'ws://127.0.0.1:8080';
        this.logger.info(`正在连接 OneBot WebSocket: ${wsUrl}`);

        return new Promise((resolve, reject) => {
            const headers = {};
            if (this.config.accessToken) {
                headers['Authorization'] = `Bearer ${this.config.accessToken}`;
            }

            try {
                this.ws = new WebSocket(wsUrl, { headers });

                this.ws.on('open', () => {
                    this.logger.info('OneBot WebSocket 连接成功');
                    this.setState(ConnectionState.CONNECTED);
                    this.startHeartbeat();
                    this.fetchLoginInfo();
                    resolve();
                });

                this.ws.on('message', (data) => {
                    this.handleWebSocketMessage(data.toString());
                });

                this.ws.on('close', (code, reason) => {
                    this.logger.warn(`WebSocket 关闭: code=${code}, reason=${reason}`);
                    this.stopHeartbeat();
                    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
                        this.handleDisconnect(`WebSocket 关闭 (${code})`);
                    }
                });

                this.ws.on('error', (error) => {
                    this.logger.error(`WebSocket 错误: ${error.message}`);
                    this.emit('error', error);
                    if (this.state === ConnectionState.CONNECTING) {
                        reject(error);
                        this.handleDisconnect(error.message);
                    }
                });

                // 连接超时
                const timeout = setTimeout(() => {
                    if (this.state === ConnectionState.CONNECTING) {
                        this.ws?.close();
                        reject(new Error('连接超时 (10s)'));
                        this.handleDisconnect('连接超时');
                    }
                }, 10000);

                this.ws.on('open', () => clearTimeout(timeout));
            } catch (error) {
                this.logger.error(`创建 WebSocket 失败: ${error.message}`);
                reject(error);
            }
        });
    }

    /**
     * 反向 WebSocket - 作为服务端等待 OneBot 实现连入
     */
    async startReverseWebSocket() {
        const port = this.config.reversePort || 8081;
        this.logger.info(`启动反向 WebSocket 服务端，监听端口: ${port}`);

        return new Promise((resolve, reject) => {
            this.wss = new WebSocket.Server({ port });

            this.wss.on('listening', () => {
                this.logger.info(`反向 WebSocket 服务端已启动: ws://0.0.0.0:${port}`);
                this.setState(ConnectionState.CONNECTED);
                resolve();
            });

            this.wss.on('connection', (ws, req) => {
                // 验证 Access Token
                if (this.config.accessToken) {
                    const auth = req.headers['authorization'];
                    if (auth !== `Bearer ${this.config.accessToken}` && auth !== `Token ${this.config.accessToken}`) {
                        this.logger.warn('反向 WS 连接鉴权失败，拒绝连接');
                        ws.close(4001, 'Unauthorized');
                        return;
                    }
                }

                this.logger.info('OneBot 客户端已连入');
                this.ws = ws;
                this.setState(ConnectionState.CONNECTED);
                this.startHeartbeat();

                ws.on('message', (data) => {
                    this.handleWebSocketMessage(data.toString());
                });

                ws.on('close', (code, reason) => {
                    this.logger.warn(`OneBot 客户端断开: code=${code}`);
                    this.stopHeartbeat();
                    this.handleDisconnect(`客户端断开 (${code})`);
                });

                ws.on('error', (error) => {
                    this.logger.error(`客户端连接错误: ${error.message}`);
                });
            });

            this.wss.on('error', (error) => {
                this.logger.error(`反向 WS 服务端错误: ${error.message}`);
                reject(error);
            });
        });
    }

    /**
     * 断开连接
     */
    async disconnect() {
        this.stopHeartbeat();

        if (this.ws) {
            this.ws.close(1000, 'Normal closure');
            this.ws = null;
        }

        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }

        // 清理待处理的 API 调用
        for (const [echo, { reject, timer }] of this.pendingApiCalls) {
            clearTimeout(timer);
            reject(new Error('连接已关闭'));
        }
        this.pendingApiCalls.clear();

        this.setState(ConnectionState.DISCONNECTED);
    }

    /**
     * 发送消息
     * @param {OutboundMessage} message
     * @returns {Promise<boolean>}
     */
    async send(message) {
        if (!this.isConnected()) {
            throw new Error('OneBot 未连接');
        }

        const segments = contentToSegments(message.content, message.mediaUrls, message.replyToId);

        let apiRequest;
        if (message.chatType === 'private') {
            apiRequest = OneBotAPI.sendPrivateMsg(parseInt(message.chatId), segments);
        } else {
            apiRequest = OneBotAPI.sendGroupMsg(parseInt(message.chatId), segments);
        }

        const response = await this.callApi(apiRequest);
        return response.retcode === 0;
    }

    /**
     * 调用 OneBot API
     * @param {object} request - API 请求对象
     * @param {number} timeout - 超时时间 (ms)
     * @returns {Promise<object>} API 响应
     */
    callApi(request, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket 未连接'));
                return;
            }

            const echo = uuidv4();
            request.echo = echo;

            const timer = setTimeout(() => {
                this.pendingApiCalls.delete(echo);
                reject(new Error(`API 调用超时: ${request.action}`));
            }, timeout);

            this.pendingApiCalls.set(echo, { resolve, reject, timer });

            this.ws.send(JSON.stringify(request));
            this.logger.debug(`API 调用: ${request.action} (echo: ${echo})`);
        });
    }

    /**
     * 处理 WebSocket 消息
     * @param {string} rawData
     */
    handleWebSocketMessage(rawData) {
        try {
            const data = JSON.parse(rawData);
            const event = parseEvent(data);

            if (!event) return;

            switch (event.type) {
                case 'api_response':
                    this.handleApiResponse(event);
                    break;
                case 'message':
                    this.handleMessageEvent(event);
                    break;
                case 'meta_event':
                    this.handleMetaEvent(event);
                    break;
                case 'notice':
                    this.logger.debug(`通知事件: ${event.noticeType}`);
                    break;
                case 'request':
                    this.logger.debug(`请求事件: ${event.requestType}`);
                    break;
                default:
                    this.logger.debug(`未知事件类型: ${event.type}`);
            }
        } catch (error) {
            this.logger.error(`解析消息失败: ${error.message}`);
        }
    }

    /**
     * 处理 API 响应
     */
    handleApiResponse(event) {
        const pending = this.pendingApiCalls.get(event.echo);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingApiCalls.delete(event.echo);

            if (event.retcode === 0) {
                pending.resolve(event);
            } else {
                pending.resolve(event); // 仍然 resolve，让调用者判断
            }
        }
    }

    /**
     * 处理消息事件
     */
    handleMessageEvent(event) {
        // 消息去重
        const msgKey = `${event.messageId}`;
        if (this.isDuplicate(msgKey)) {
            this.logger.debug(`重复消息已忽略: ${msgKey}`);
            return;
        }
        this.markMessage(msgKey);

        // 忽略自己发送的消息
        if (event.userId === this.selfId) {
            return;
        }

        // 转换为标准入站消息
        const inboundMsg = new InboundMessage({
            platform: 'qq',
            messageId: String(event.messageId),
            chatId: String(event.messageType === 'private' ? event.userId : event.groupId),
            chatType: event.messageType === 'private' ? 'private' : 'group',
            senderId: String(event.userId),
            senderName: event.sender?.card || event.sender?.nickname || String(event.userId),
            content: event.content,
            mediaUrls: event.mediaUrls,
            timestamp: (event.time || 0) * 1000 || Date.now(),
            mentioned: event.mentioned,
            raw: event.raw,
        });

        this.emit('message', inboundMsg);
    }

    /**
     * 处理元事件（心跳、生命周期）
     */
    handleMetaEvent(event) {
        if (event.metaEventType === 'lifecycle') {
            if (event.subType === 'connect') {
                this.selfId = event.selfId;
                this.logger.info(`OneBot 连接成功，Bot ID: ${this.selfId}`);
            }
        } else if (event.metaEventType === 'heartbeat') {
            // 收到心跳，连接正常
            this.logger.debug('收到心跳');
        }
    }

    /**
     * 获取登录信息
     */
    async fetchLoginInfo() {
        try {
            const response = await this.callApi(OneBotAPI.getLoginInfo());
            if (response.retcode === 0 && response.data) {
                this.selfId = response.data.user_id;
                this.logger.info(`登录成功: ${response.data.nickname} (${this.selfId})`);
            }
        } catch (error) {
            this.logger.warn(`获取登录信息失败: ${error.message}`);
        }
    }

    /**
     * 启动心跳
     */
    startHeartbeat() {
        this.stopHeartbeat();
        const interval = this.config.heartbeatInterval || 30000;

        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                // OneBot v11 标准心跳（发送空 JSON 或 ping）
                try {
                    this.ws.ping();
                    this.logger.debug('心跳已发送');
                } catch (error) {
                    this.logger.warn(`心跳发送失败: ${error.message}`);
                }
            }
        }, interval);

        this.logger.info(`心跳已启动，间隔: ${interval}ms`);
    }

    /**
     * 停止心跳
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * 消息去重检查
     */
    isDuplicate(messageId) {
        return this.recentMessages.has(messageId);
    }

    /**
     * 标记消息已处理
     */
    markMessage(messageId) {
        this.recentMessages.set(messageId, Date.now());
    }

    /**
     * 清理去重缓存
     */
    cleanupDedupCache() {
        const now = Date.now();
        for (const [id, timestamp] of this.recentMessages) {
            if (now - timestamp > this.dedupWindow) {
                this.recentMessages.delete(id);
            }
        }
    }

    /**
     * 停止适配器（清理所有资源）
     */
    async stop() {
        if (this.dedupCleanupTimer) {
            clearInterval(this.dedupCleanupTimer);
        }
        await super.stop();
    }
}

export default OneBotAdapter;
