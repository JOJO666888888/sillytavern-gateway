import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';
import configManager from './utils/config.js';
import { gatewayCore } from './gateway-core.js';
import { sessionManager } from './session-manager.js';
import { OneBotAdapter } from './adapters/onebot-adapter.js';
import { TelegramAdapter } from './adapters/telegram-adapter.js';
import { DiscordAdapter } from './adapters/discord-adapter.js';
import { OutboundMessage } from './adapters/base-adapter.js';

const logger = createLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// CORS 支持（允许 SillyTavern 前端访问）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

/**
 * 初始化适配器
 */
function initAdapters() {
    const qqConfig = configManager.get('adapters.qq');
    const telegramConfig = configManager.get('adapters.telegram');
    const discordConfig = configManager.get('adapters.discord');

    // QQ OneBot 适配器
    const qqAdapter = new OneBotAdapter(qqConfig);
    gatewayCore.registerAdapter('qq', qqAdapter);

    // Telegram 适配器
    const telegramAdapter = new TelegramAdapter(telegramConfig);
    gatewayCore.registerAdapter('telegram', telegramAdapter);

    // Discord 适配器
    const discordAdapter = new DiscordAdapter(discordConfig);
    gatewayCore.registerAdapter('discord', discordAdapter);

    logger.info('所有适配器已初始化');
}

/**
 * 设置消息处理（自动回复逻辑）
 */
function setupMessageHandling() {
    gatewayCore.onMessage(async (message) => {
        logger.info(`处理消息: [${message.platform}] ${message.senderName}: ${message.content}`);

        // 记录到会话历史
        sessionManager.addMessage(message.platform, message.chatId, {
            role: 'user',
            content: message.content,
            name: message.senderName,
        });

        // 自动回复逻辑（如果启用）
        if (configManager.get('autoReply.enabled')) {
            await handleAutoReply(message);
        }

        // 触发外部处理（SillyTavern 扩展可以通过轮询或 WebSocket 获取）
        gatewayCore.emit('externalMessage', message);
    });
}

/**
 * 自动回复处理
 * 这里提供一个简单的回声回复作为示例
 * 实际使用时，SillyTavern 扩展会接管这个逻辑
 */
async function handleAutoReply(message) {
    // 检查是否是命令
    if (message.content.startsWith('/')) {
        await handleCommand(message);
        return;
    }

    // 默认：不自动回复，等待 SillyTavern 扩展处理
    // 扩展会轮询消息、注入聊天、触发 AI 生成、将回复发回网关
    // 服务器端只处理 / 开头的命令
    /*
    const delay = configManager.get('autoReply.responseDelay') || 500;
    await new Promise(resolve => setTimeout(resolve, delay));

    const reply = new OutboundMessage({
        platform: message.platform,
        chatId: message.chatId,
        chatType: message.chatType,
        content: `你说了: ${message.content}`,
        replyToId: message.messageId,
    });

    gatewayCore.sendMessage(reply);
    */
}

/**
 * 处理命令
 */
async function handleCommand(message) {
    const parts = message.content.split(' ');
    const command = parts[0].toLowerCase();

    let response = '';

    switch (command) {
        case '/status':
        case '/状态':
            const status = gatewayCore.getStatus();
            response = Object.entries(status.adapters)
                .map(([name, s]) => `${name}: ${s.state}`)
                .join('\n');
            break;

        case '/help':
        case '/帮助':
            response = [
                '可用命令:',
                '/status - 查看网关状态',
                '/clear - 清空当前会话历史',
                '/help - 显示帮助',
            ].join('\n');
            break;

        case '/clear':
        case '/清空':
            sessionManager.clearHistory(message.platform, message.chatId);
            response = '会话历史已清空';
            break;

        default:
            response = `未知命令: ${command}，使用 /help 查看可用命令`;
    }

    if (response) {
        const reply = new OutboundMessage({
            platform: message.platform,
            chatId: message.chatId,
            chatType: message.chatType,
            content: response,
        });
        gatewayCore.sendMessage(reply);
    }
}

// ==================== API 路由 ====================

/**
 * 获取网关状态
 */
app.get('/api/gateway/status', (req, res) => {
    res.json(gatewayCore.getStatus());
});

/**
 * 获取配置
 */
app.get('/api/gateway/config', (req, res) => {
    res.json(configManager.getAll());
});

/**
 * 更新配置
 */
app.post('/api/gateway/config', (req, res) => {
    try {
        configManager.update(req.body);
        res.json({ success: true, message: '配置已更新' });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * 发送消息
 */
app.post('/api/gateway/send', async (req, res) => {
    try {
        const { platform, chatId, chatType, content, mediaUrls, replyToId } = req.body;

        if (!platform || !chatId || !content) {
            return res.status(400).json({ success: false, error: '缺少必要参数' });
        }

        const message = new OutboundMessage({
            platform,
            chatId,
            chatType: chatType || 'private',
            content,
            mediaUrls: mediaUrls || [],
            replyToId: replyToId || '',
        });

        gatewayCore.sendMessage(message);
        res.json({ success: true, message: '消息已加入发送队列' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取会话列表
 */
app.get('/api/gateway/sessions', (req, res) => {
    res.json(sessionManager.listSessions());
});

/**
 * 获取会话历史
 */
app.get('/api/gateway/sessions/:platform/:chatId/history', (req, res) => {
    const { platform, chatId } = req.params;
    const limit = parseInt(req.query.limit) || 0;
    const history = sessionManager.getHistory(platform, chatId, limit);
    res.json({ success: true, history });
});

/**
 * 清空会话历史
 */
app.delete('/api/gateway/sessions/:platform/:chatId/history', (req, res) => {
    const { platform, chatId } = req.params;
    sessionManager.clearHistory(platform, chatId);
    res.json({ success: true, message: '会话历史已清空' });
});

/**
 * 启动/停止指定适配器
 */
app.post('/api/gateway/adapters/:name/:action', async (req, res) => {
    const { name, action } = req.params;
    const adapter = gatewayCore.getAdapter(name);

    if (!adapter) {
        return res.status(404).json({ success: false, error: `适配器 ${name} 不存在` });
    }

    try {
        if (action === 'start') {
            await adapter.start();
            res.json({ success: true, message: `${name} 已启动` });
        } else if (action === 'stop') {
            await adapter.stop();
            res.json({ success: true, message: `${name} 已停止` });
        } else {
            res.status(400).json({ success: false, error: `未知操作: ${action}` });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 健康检查
 */
app.get('/api/gateway/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
    });
});

// ==================== 启动服务 ====================

const PORT = configManager.get('server.port') || 3210;
const HOST = configManager.get('server.host') || '127.0.0.1';

const server = http.createServer(app);

async function startServer() {
    logger.info('========================================');
    logger.info('  SillyTavern Gateway 多平台聊天网关');
    logger.info('========================================');

    // 初始化适配器
    initAdapters();

    // 设置消息处理
    setupMessageHandling();

    // 启动网关
    await gatewayCore.start();

    // 启动 HTTP 服务
    server.listen(PORT, HOST, () => {
        logger.info(`HTTP API 服务已启动: http://${HOST}:${PORT}`);
        logger.info(`API 文档: http://${HOST}:${PORT}/api/gateway/health`);
    });
}

// 优雅关闭
process.on('SIGINT', async () => {
    logger.info('正在关闭...');
    await gatewayCore.stop();
    sessionManager.stop();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在关闭...');
    await gatewayCore.stop();
    sessionManager.stop();
    server.close();
    process.exit(0);
});

// 启动
startServer().catch(error => {
    logger.error(`启动失败: ${error.message}`);
    process.exit(1);
});

export { app, server };
