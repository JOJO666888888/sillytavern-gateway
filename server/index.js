import express from 'express';
import http from 'http';
import path from 'path';
import { exec } from 'child_process';
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
const REPO_ROOT = path.join(__dirname, '..');

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

        // 优先交给插件系统处理（命令路由 + 事件管线）
        // 命令必须在记录会话历史之前处理，避免 /help 等命令文本污染 AI 上下文
        if (pluginManager) {
            const handled = await pluginManager.handleMessage(message);
            if (handled) {
                return; // 插件已处理（命令执行完毕），不记录历史、不转发到 ST
            }
        }

        // 非命令消息：记录到会话历史
        sessionManager.addMessage(message.platform, message.chatId, {
            role: 'user',
            content: message.content,
            name: message.senderName,
        });

        // 触发外部处理（SillyTavern 扩展轮询）
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
 * 下载插件开发规范指南
 * 供前端"编写参考"区块调用, 返回 docs/PLUGIN_DEVELOPMENT_GUIDE.md 文件
 */
app.get('/api/gateway/docs/plugin-guide', (req, res) => {
    const guidePath = path.join(__dirname, '..', 'docs', 'PLUGIN_DEVELOPMENT_GUIDE.md');
    res.download(guidePath, 'PLUGIN_DEVELOPMENT_GUIDE.md', (error) => {
        if (error && !res.headersSent) {
            res.status(404).json({ success: false, error: '指南文件不存在: ' + error.message });
        }
    });
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
 * 手动同步命令列表到所有平台
 */
app.post('/api/gateway/sync-commands', async (req, res) => {
    if (!pluginManager) {
        return res.status(500).json({ success: false, error: '插件系统未初始化' });
    }
    const commands = pluginManager.commandRouter.getCommandsForSync();
    await gatewayCore.syncAllCommands(commands);
    res.json({ success: true, message: `已同步 ${commands.length} 个命令到所有已连接平台` });
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

// ==================== 自动更新 API ====================

/**
 * 在仓库根目录执行 git 命令
 */
function runGit(args) {
    return new Promise((resolve, reject) => {
        exec(`git ${args}`, { cwd: REPO_ROOT, timeout: 30000 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error((stderr || error.message).trim()));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

/**
 * 检查更新: 对比本地 HEAD 与 origin/main 的差异
 */
app.get('/api/gateway/update/check', async (req, res) => {
    try {
        await runGit('fetch origin main');
        const currentCommit = (await runGit('rev-parse HEAD')).substring(0, 7);
        const latestCommit = (await runGit('rev-parse origin/main')).substring(0, 7);
        const behindBy = parseInt(await runGit('rev-list HEAD...origin/main --count')) || 0;

        res.json({
            success: true,
            hasUpdate: behindBy > 0,
            currentCommit,
            latestCommit,
            behindBy,
        });
    } catch (error) {
        res.json({ success: false, error: `检查更新失败: ${error.message}` });
    }
});

/**
 * 应用更新: git pull --ff-only, 若 package.json 变动则自动 npm install
 */
app.post('/api/gateway/update/apply', async (req, res) => {
    try {
        // 1. 检查工作目录是否干净
        const status = await runGit('status --porcelain');
        if (status) {
            return res.json({ success: false, error: '工作目录有未提交的更改，请先提交或撤销后再更新' });
        }

        // 2. Fast-forward pull
        const pullResult = await runGit('pull --ff-only origin main');

        // 3. 检查 package.json 是否变动
        const changed = await runGit('diff HEAD@{1} HEAD --name-only');
        const changedFiles = changed.split('\n').filter(Boolean);
        const pkgChanged = changedFiles.includes('package.json');

        let extraMessage = '';
        if (pkgChanged) {
            try {
                await new Promise((resolve, reject) => {
                    exec('npm install --no-audit --no-fund', { cwd: REPO_ROOT, timeout: 120000 }, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                extraMessage = '，依赖已自动更新';
            } catch (_) {
                extraMessage = '，但依赖更新失败，请手动执行 npm install';
            }
        }

        res.json({
            success: true,
            message: `更新成功${extraMessage}。请重启网关服务以应用更改。`,
            changedFiles,
            needRestart: true,
        });
    } catch (error) {
        res.json({ success: false, error: `更新失败: ${error.message}` });
    }
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
