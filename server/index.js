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
import { PluginManager } from './plugin-manager.js';

const logger = createLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// 插件管理器
let pluginManager = null;

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
 * 设置消息处理（通过插件系统分发）
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

        // 优先交给插件系统处理（命令路由 + 事件管线）
        if (pluginManager) {
            const handled = await pluginManager.handleMessage(message);
            if (handled) {
                return; // 插件已处理，不再走默认逻辑
            }
        }

        // 插件未处理的消息 → 触发外部处理（SillyTavern 扩展轮询）
        gatewayCore.emit('externalMessage', message);
    });
}

// 命令处理已由插件系统的 CommandRouter 接管（内置 /help, /status, /clear）

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
 * 验证指定适配器连接（凭据校验/连通性测试）
 * 注意: 必须注册在 /api/gateway/adapters/:name/:action 之前, 否则会被 :action 拦截
 */
app.post('/api/gateway/adapters/:name/verify', async (req, res) => {
    const { name } = req.params;
    const adapter = gatewayCore.getAdapter(name);

    if (!adapter) {
        return res.status(404).json({ success: false, ok: false, error: `适配器 ${name} 不存在` });
    }

    try {
        const result = await adapter.verify();
        res.json({ success: result.ok, name, ...result });
    } catch (error) {
        res.json({ success: false, ok: false, name, state: adapter.state, message: error.message });
    }
});

/**
 * 验证所有适配器连接
 */
app.post('/api/gateway/verify', async (req, res) => {
    const results = {};
    for (const [name, adapter] of gatewayCore.adapters) {
        try {
            results[name] = await adapter.verify();
        } catch (error) {
            results[name] = { ok: false, state: adapter.state, message: error.message };
        }
    }
    res.json({ success: true, results });
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

    // 初始化插件系统
    pluginManager = new PluginManager({
        gateway: gatewayCore,
        sessionManager,
        configManager,
    });
    await pluginManager.init();
    pluginManager.registerRoutes(app);

    // 设置消息处理
    setupMessageHandling();

    // 启动网关
    await gatewayCore.start();

    // 启动 HTTP 服务
    server.listen(PORT, HOST, () => {
        logger.info(`HTTP API 服务已启动: http://${HOST}:${PORT}`);
        logger.info(`API 文档: http://${HOST}:${PORT}/api/gateway/health`);
        logger.info(`插件管理: http://${HOST}:${PORT}/api/plugins`);
    });
}

// 优雅关闭
process.on('SIGINT', async () => {
    logger.info('正在关闭...');
    if (pluginManager) await pluginManager.shutdown();
    await gatewayCore.stop();
    sessionManager.stop();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在关闭...');
    if (pluginManager) await pluginManager.shutdown();
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
