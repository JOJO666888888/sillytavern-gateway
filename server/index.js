// dotenv 必须在所有其他模块之前加载，确保 process.env 包含 .env 中的变量
// 管理脚本（gateway-manager.sh）通过 .env 注入适配器配置和 runtime 开关，
// 不加载 .env 会导致这些配置完全不生效。
import 'dotenv/config';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { createLogger, getRecentLogs } from './utils/logger.js';
import { createCorsMiddleware, createGatewayAuthMiddleware } from './utils/auth-middleware.js';
import configManager from './utils/config.js';
import { gatewayCore } from './gateway-core.js';
import { sessionManager } from './session-manager.js';
import { OneBotAdapter } from './adapters/onebot-adapter.js';
import { TelegramAdapter } from './adapters/telegram-adapter.js';
import { DiscordAdapter } from './adapters/discord-adapter.js';
import { FeishuAdapter } from './adapters/feishu-adapter.js';
import { QQOfficialAdapter } from './adapters/qqofficial-adapter.js';
import { DingTalkAdapter } from './adapters/dingtalk-adapter.js';
import { OutboundMessage } from './adapters/base-adapter.js';
import { PluginManager } from './plugin-manager.js';
import { mediaStore } from './media/media-store.js';
import { NativeRuntime } from './runtime/pipeline.js';
import { LLMClient } from './runtime/llm-client.js';
import { registerRuntimeCommands } from './runtime/runtime-commands.js';
import { createLLMService } from './llm-service.js';
import { TheatreBroadcaster } from './agent/theatre-broadcaster.js';
import { registerAgentApi } from './agent-api.js';
import multer from 'multer';

const logger = createLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

const app = express();
app.use(express.json());

// 文件上传中间件（资产导入用）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// 插件管理器
let pluginManager = null;
// 自建推理管线（P2）：启用后网关自己组装 prompt 调 LLM，无需挂 ST 前端
let nativeRuntime = null;
// Agent 剧场事件广播器（SSE）：单例，进程级
const theatreBroadcaster = new TheatreBroadcaster();
// 插件 LLM 服务（runtime.llm 配置后供 agent run / 兼容桥 使用）
let llmService = null;

// CORS：收敛为 Origin 反射白名单（非通配），并声明自定义鉴权头（P0-4 抽至共享模块）
app.use(createCorsMiddleware(configManager));

// 鉴权中间件：所有 /api/* 需携带正确的 X-Gateway-Token（P0-4 抽至共享模块，
// 与独立 Agent 服务共用同一策略）。例外：健康检查与 OPTIONS 预检。
app.use(createGatewayAuthMiddleware(configManager));

/**
 * 适配器注册表 —— 新增平台只需在此加一行（配置驱动）。
 * key = 平台名（与 config.adapters.<key> 对应），value = 适配器类。
 * 新平台步骤：
 *   1. 在 server/adapters/ 实现继承 PlatformAdapter 的适配器类
 *   2. 在 config.js DEFAULT_CONFIG.adapters 加默认配置
 *   3. 在此表加一行
 * 详见 docs/ADDING_PLATFORMS.md
 */
const ADAPTER_REGISTRY = {
    qq: OneBotAdapter,
    telegram: TelegramAdapter,
    discord: DiscordAdapter,
    feishu: FeishuAdapter,
    qqofficial: QQOfficialAdapter,
    dingtalk: DingTalkAdapter,
};

/**
 * 初始化适配器（遍历注册表，配置驱动）
 */
function initAdapters() {
    for (const [name, AdapterClass] of Object.entries(ADAPTER_REGISTRY)) {
        try {
            const cfg = configManager.get(`adapters.${name}`) || {};
            gatewayCore.registerAdapter(name, new AdapterClass(cfg));
        } catch (error) {
            logger.error(`适配器 ${name} 初始化失败: ${error.message}`);
        }
    }
    logger.info(`适配器已初始化: ${Object.keys(ADAPTER_REGISTRY).join(', ')}`);
}

/**
 * 设置消息处理（通过插件系统分发）
 */
function setupMessageHandling() {
    gatewayCore.onMessage(async (message) => {
        logger.info(`处理消息: [${message.platform}] ${message.senderName}: ${message.content}`);

        // 优先交给插件系统处理（命令路由 + 事件管线）
        // 命令必须在记录会话历史之前处理，避免 /help 等命令文本污染 AI 上下文
        // 包裹 try/catch：插件管线自身崩溃不得阻断自建推理管线回复用户
        if (pluginManager) {
            let handled = false;
            try {
                handled = await pluginManager.handleMessage(message);
            } catch (error) {
                logger.error(`[plugin] 消息处理异常（已跳过，继续走推理管线）: ${error.message}`);
            }
            if (handled) {
                return; // 插件已处理（命令执行完毕），不记录历史、不转发到 ST
            }
        }

        // ⭐ 自建推理管线（P2）：启用后由网关自己生成回复，不再依赖 ST 浏览器前端
        if (nativeRuntime) {
            try {
                const reply = await nativeRuntime.generate(message.platform, message.chatId, message.content, {
                    now: Date.now(),
                    media: message.media,   // 多模态：入站图片一并送入模型
                });
                gatewayCore.sendMessage(new OutboundMessage({
                    platform: message.platform,
                    chatId: message.chatId,
                    chatType: message.chatType,
                    content: reply,
                }));
            } catch (error) {
                logger.error(`[runtime] 生成失败: ${error.message}`);
                // 明确告知用户，而不是静默无响应
                gatewayCore.sendMessage(new OutboundMessage({
                    platform: message.platform,
                    chatId: message.chatId,
                    chatType: message.chatType,
                    content: `⚠️ 生成失败：${error.message}`,
                }));
            }
            return; // 已由自建管线处理，不再走 ST 前端通道
        }

        // 非命令消息：记录到会话历史（仅非 runtime 模式）。
        // P2-4：runtime 模式下历史以 ChatArchive（data/chats/*.jsonl）为权威
        // （nativeRuntime.generate 内部会落 user+assistant），不再写 sessions.json，
        // 避免同一对话两份存储漂移（完整合并留路线图）。
        sessionManager.addMessage(message.platform, message.chatId, {
            role: 'user',
            content: message.content,
            name: message.senderName,
        });

        // 放入入站待处理队列（完整内容 + 唯一 ID + ack 语义），供 ST 前端可靠消费
        gatewayCore.enqueueInbound(message);

        // 兼容：仍触发事件，供其它监听者使用
        gatewayCore.emit('externalMessage', message);
    });
}

// 命令处理已由插件系统的 CommandRouter 接管（内置 /help, /status, /clear）

// ==================== 媒体缓存对外服务 ====================
// 提供稳定 URL 供各平台拉取媒体（QQ 时效URL/本地渲染图/跨平台转发）。
// 不在 /api/* 下，故不需要鉴权（平台服务端需匿名拉取）；id 为不可猜的随机值。
app.get('/media/:id', mediaStore.handler());

// ==================== API 路由 ====================

/**
 * 获取网关状态
 */
app.get('/api/gateway/status', (req, res) => {
    res.json(gatewayCore.getStatus());
});

/**
 * 拉取最近网关日志（前端"网关日志"页 + 错误弹窗轮询）。
 * 查询参数：since=seq（只返回 seq 更大的条目，用于增量轮询/去重）；
 *           limit=N（默认 200，上限 500）；level=error|warn|info（可选过滤）。
 * 受 /api/* 全局 token 鉴权保护；日志条目经 redactSecrets 脱敏，不含密钥。
 */
app.get('/api/gateway/logs', (req, res) => {
    const since = parseInt(req.query.since, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const level = req.query.level;
    res.json({ success: true, ...getRecentLogs({ since, limit, level }) });
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
    // 脱敏：绝不明文返回 Bot Token 等敏感字段
    res.json(configManager.getRedacted());
});

/**
 * 更新配置
 */
app.post('/api/gateway/config', (req, res) => {
    try {
        // 内存里改成了，但没落盘就不算成功——只读挂载 / 磁盘满的时候，
        // 报 success 会让用户以为存好了，直到重启才发现改动全没了。
        const persisted = configManager.update(req.body);
        if (!persisted) {
            return res.status(500).json({
                success: false,
                error: `配置已在内存中生效，但写入磁盘失败：${configManager.lastSaveError || '未知原因'}。重启后改动会丢失。`,
            });
        }
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
 * 获取待处理入站消息（ST 前端可靠消费通道，替代被截断的 recentMessages）
 */
app.get('/api/gateway/inbound/pending', (req, res) => {
    const limit = parseInt(req.query.limit) || 0;
    res.json({ success: true, messages: gatewayCore.getPendingInbound(limit) });
});

/**
 * 确认已处理的入站消息（前端处理完后回 ack，网关据此移除）
 */
app.post('/api/gateway/inbound/ack', (req, res) => {
    const ids = req.body?.ids;
    const removed = gatewayCore.ackInbound(ids || []);
    res.json({ success: true, removed });
});

// ==================== 自建推理管线 API ====================

/** 运行时状态与资产列表 */
app.get('/api/runtime/status', (req, res) => {
    if (!nativeRuntime) {
        return res.json({ success: true, enabled: false, message: '自建推理管线未启用（config.runtime.enabled=false）' });
    }
    res.json({
        success: true, enabled: true,
        assets: nativeRuntime.listAssets(),
        dirs: nativeRuntime.dirs,
        profiles: nativeRuntime.profiles.list().length,
    });
});

/** 会话 Profile 列表 */
app.get('/api/runtime/profiles', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    res.json({ success: true, profiles: nativeRuntime.profiles.list() });
});

/** 更新某会话 Profile（切换角色/预设/世界书/存档） */
app.post('/api/runtime/profiles/:platform/:chatId', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { platform, chatId } = req.params;
    const p = nativeRuntime.profiles.update(platform, chatId, req.body || {});
    res.json({ success: true, profile: p });
});

/** 删除某会话 Profile（移除其角色/预设/世界书绑定；聊天记录保留） */
app.delete('/api/runtime/profiles/:platform/:chatId', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { platform, chatId } = req.params;
    const ok = nativeRuntime.profiles.delete(platform, chatId);
    if (ok) logger.info(`会话绑定已删除: ${platform}:${chatId}`);
    res.json({ success: ok, profiles: nativeRuntime.profiles.list() });
});

/** 预览 prompt 组装结果（不调用 LLM，便于调试） */
app.post('/api/runtime/preview', async (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { platform, chatId, input } = req.body || {};
    try {
        const { messages, sampling } = await nativeRuntime.prepare(platform, chatId, input || '');
        res.json({ success: true, messages, sampling });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/** 上传资产文件（角色卡/世界书/预设/存档） */
app.post('/api/runtime/assets/:type', upload.single('file'), (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { type } = req.params;
    if (!['characters', 'worldbooks', 'presets', 'chats'].includes(type)) {
        return res.status(400).json({ success: false, error: '类型必须是 characters / worldbooks / presets / chats' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: '未收到文件' });
    try {
        const result = nativeRuntime.importAsset(type, req.file.originalname, req.file.buffer);
        logger.info(`资产已导入: ${type}/${result.name}`);
        res.json({ success: true, ...result, assets: nativeRuntime.listAssets() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/** 删除一个已导入资产（角色卡/世界书/预设/存档） */
app.delete('/api/runtime/assets/:type/:name', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { type, name } = req.params;
    if (!['characters', 'worldbooks', 'presets', 'chats'].includes(type)) {
        return res.status(400).json({ success: false, error: '类型必须是 characters / worldbooks / presets / chats' });
    }
    try {
        nativeRuntime.deleteAsset(type, name);
        logger.info(`资产已删除: ${type}/${name}`);
        res.json({ success: true, assets: nativeRuntime.listAssets() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/** 列出某世界书/预设的可切换条目（含启用状态） */
app.get('/api/runtime/assets/:type/:name/entries', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { type, name } = req.params;
    if (!['worldbooks', 'presets'].includes(type)) {
        return res.status(400).json({ success: false, error: '条目仅支持 worldbooks / presets' });
    }
    try {
        const entries = nativeRuntime.listEntries(type, name);
        res.json({ success: true, entries });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/** 设置某世界书/预设的条目启用状态（整体替换禁用列表） */
app.post('/api/runtime/assets/:type/:name/entries', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { type, name } = req.params;
    if (!['worldbooks', 'presets'].includes(type)) {
        return res.status(400).json({ success: false, error: '条目仅支持 worldbooks / presets' });
    }
    const { disabled } = req.body || {};
    if (!Array.isArray(disabled)) {
        return res.status(400).json({ success: false, error: '请求体需为 { disabled: [条目id...] }' });
    }
    try {
        nativeRuntime.setDisabledEntries(type, name, disabled);
        logger.info(`条目覆盖已更新: ${type}/${name} (禁用 ${disabled.length} 项)`);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/** 从 SillyTavern 目录一键同步资产 */
app.post('/api/runtime/sync-from-st', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { stPath } = req.body || {};
    if (!stPath) return res.status(400).json({ success: false, error: '请提供 SillyTavern 安装路径' });
    try {
        if (!fs.existsSync(stPath)) {
            return res.status(400).json({ success: false, error: `路径不存在: ${stPath}` });
        }
        // 关键校验：必须含 data/default-user，否则同步会静默 0/0/0 且难以察觉
        if (!fs.existsSync(path.join(stPath, 'data', 'default-user'))) {
            return res.status(400).json({
                success: false,
                error: `路径下未找到 data/default-user 目录，请填写 SillyTavern 根目录（如 D:\\SillTavern，包含 data\\default-user\\characters 的那一层）`,
            });
        }
        const result = nativeRuntime.syncFromSillyTavern(stPath);
        logger.info(`从 ST 同步资产完成: 角色卡 ${result.characters} / 世界书 ${result.worldbooks} / 预设 ${result.presets} / 存档 ${result.chats}${result.missing?.length ? `，缺失目录: ${result.missing.join('/')}` : ''}`);
        res.json({ success: true, ...result, assets: nativeRuntime.listAssets() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * 拉取 LLM 可用模型列表（面板"获取模型"按钮用）。
 * 用请求体里的 provider/baseUrl/apiKey；apiKey 为掩码或空时回退已保存的真 key。
 * 该路由在全局 /api/* 鉴权中间件下，自动受 token 保护；apiKey 不进日志。
 */
app.post('/api/runtime/llm/models', async (req, res) => {
    const body = req.body || {};
    const saved = configManager.get('runtime.llm') || {};
    const provider = body.provider || saved.provider || 'openai';
    const baseUrl = body.baseUrl || saved.baseUrl || '';
    // apiKey：优先用面板输入；掩码/空则回退已保存真 key（后端返回给前端的是脱敏串）
    let apiKey = body.apiKey || '';
    if (!apiKey || /^\*+$/.test(apiKey) || apiKey.includes('***')) apiKey = saved.apiKey || '';
    try {
        const models = await new LLMClient({ provider, baseUrl, apiKey, timeout: 20000 }).listModels();
        logger.info(`拉取模型列表成功 (${provider}): ${models.length} 个`);
        res.json({ success: true, models });
    } catch (error) {
        logger.warn(`拉取模型列表失败 (${provider}): ${error.message}`);
        res.status(400).json({ success: false, error: error.message });
    }
});

// ==================== Agent 框架 API ====================
//
// 已抽离到 server/agent-api.js（registerAgentApi），主网关与独立 Agent 服务
// （server/agent-server.js）共用同一实现。见文件底部 registerAgentApi(app, deps) 调用。

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
 * 是否跑在容器里。
 *
 * 容器部署下 git 自更新那一整套不成立：.dockerignore 排除了 .git，镜像里也没装
 * git，所以 runGit 必然失败。而前端把「检查更新」挂在 SillyTavern 启动流程上，
 * 用户每开一次 ST 就吃一次看不懂的 git 报错。
 * 即便硬把 .git 和 git 塞进镜像也是错的——容器里 git pull 改的是镜像层里的源码，
 * 重建容器即丢；正确姿势是宿主机 git pull 后 docker compose up -d --build。
 */
const IN_DOCKER = process.env.GATEWAY_IN_DOCKER === '1' || fs.existsSync('/.dockerenv');

const DOCKER_UPDATE_HINT = '容器部署不支持在线更新。请在宿主机的仓库目录执行：'
    + 'git pull && docker compose up -d --build';

/**
 * 检查更新: 对比本地 HEAD 与 origin/main 的差异
 */
app.get('/api/gateway/update/check', async (req, res) => {
    if (IN_DOCKER) {
        // 用 hasUpdate:false + supported:false 而不是 success:false，
        // 让前端能安静地隐藏更新入口，而不是每次都弹一个错误提示
        return res.json({ success: true, supported: false, hasUpdate: false, message: DOCKER_UPDATE_HINT });
    }
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
    if (IN_DOCKER) {
        return res.status(400).json({ success: false, supported: false, error: DOCKER_UPDATE_HINT });
    }
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

// ==================== Agent 独立 API（server/agent-api.js） ====================
//
// Agent 框架 / 剧场 / AI 修改 / 前端 URL 校验 / /agent 静态页 路由统一由
// registerAgentApi 注册（主网关与独立 Agent 服务 server/agent-server.js 共用同一实现）。
// 依赖动态取值：pluginManager / llmService 在 startServer() 中才赋值，
// 这里传 getter，路由处理时实时读取最新值，无需改动其余行为。

const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
registerAgentApi(app, {
    getPluginManager: () => pluginManager,
    // 惰性创建：保存 LLM 配置后 resetLlmService() 失效缓存，下次调用自动重建（无需重启）
    getLlmService: () => {
        if (llmService) return llmService;
        if (configManager.get('runtime')?.llm?.model) {
            llmService = createLLMService(configManager);
            logger.info('🤖 LLM 服务已就绪（惰性重建）');
        }
        return llmService;
    },
    resetLlmService: () => { llmService = null; },
    theatreBroadcaster,
    configManager,
    logger,
    repoRoot: REPO_ROOT,
    staticDir: PUBLIC_DIR,
});

// ==================== 启动服务 ====================

const PORT = configManager.get('server.port') || 3210;
const HOST = configManager.get('server.host') || '127.0.0.1';

const server = http.createServer(app);

// 监听错误：端口被占用等，给出可操作的中文提示而非裸调用栈。
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        logger.error(`端口 ${PORT} 已被占用，无法启动网关。可能已有另一个网关实例在运行。`);
        logger.error(`解决：1) 停止旧实例后再启动；2) 或修改 config/gateway.json 的 server.port 换个端口。`);
    } else {
        logger.error(`HTTP 服务启动失败: ${err.message}`);
    }
    process.exit(1);
});

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
        // 把 theatreBroadcaster 注入插件系统，供 agent-framework 注册
        // native 表现层适配器（把 AgentRunResult 广播给 Agent 剧场前端）。
        theatreBroadcaster,
    });
    await pluginManager.init();
    pluginManager.registerRoutes(app);

    // 初始化自建推理管线（默认关闭；开启后无需挂 SillyTavern 前端）
    const runtimeCfg = configManager.get('runtime') || {};
    if (runtimeCfg.enabled) {
        try {
            nativeRuntime = new NativeRuntime({ config: runtimeCfg });
            registerRuntimeCommands(pluginManager.commandRouter, nativeRuntime);
            const assets = nativeRuntime.listAssets();
            logger.info(`🚀 自建推理管线已启用（无需 ST 前端）。资产: 角色卡 ${assets.characters.length} / 世界书 ${assets.worldbooks.length} / 预设 ${assets.presets.length} / 存档 ${assets.archives.length}`);
            if (!runtimeCfg.llm?.model) {
                logger.warn('⚠️ runtime.llm.model 未配置，生成会失败。请在 config/gateway.json 的 runtime.llm 中设置 provider/apiKey/model');
            }
            if (assets.characters.length === 0) {
                logger.warn('⚠️ 未发现角色卡。请把 ST 角色卡(.png/.json)放入 assets/characters/');
            }
        } catch (error) {
            logger.error(`自建推理管线初始化失败: ${error.message}`);
            nativeRuntime = null;
        }
    }

    // 初始化 LLM 服务（供 ST 兼容桥 / Agent 剧场触发 agent run 用）。
    // 只要 runtime.llm 配了 model 就创建，不依赖 runtime.enabled 开关。
    if (runtimeCfg.llm?.model) {
        llmService = createLLMService(configManager);
        logger.info('🤖 LLM 服务已就绪（供 ST 兼容桥 / Agent 剧场使用）');
    }

    // 设置消息处理
    setupMessageHandling();

    // 启动网关
    await gatewayCore.start();

    // 打印鉴权与绑定提示。刻意放在 server.listen 之前：端口被占用时
    // listen 会抛 EADDRINUSE，若信息写在 listen 回调里就永远打不出来，
    // 用户连不上也看不到 token，无从排查。
    const requireAuth = configManager.get('server.requireAuth') !== false;
    if (requireAuth) {
        const token = configManager.get('server.authToken') || '';
        logger.info(`🔐 API 鉴权已开启。请在 SillyTavern 网关面板填入 token。`);
        if (token) {
            // 明文打印 token，方便首次连接时直接复制。
            // 刻意用 console.log 而非 logger：winston 的 redactSecrets 会把
            // ≥32 位十六进制串（token 正是此形态）打码成 <redacted-hex>，
            // 那样用户根本看不见 token、无从填入。这里仅此一行绕过脱敏，
            // 其余日志仍走脱敏管道。贴日志求助时请手动删掉这一行。
            const box = '═'.repeat(Math.max(0, token.length + 16));
            console.log(`\n  ╔${box}╗`);
            console.log(`  ║  🔑 网关鉴权 Token（复制填入 SillyTavern 网关面板）  ║`);
            console.log(`  ║  ${token}  ║`);
            console.log(`  ╚${box}╝\n`);
        } else {
            logger.warn('authToken 缺失：API 将返回 503。请检查 config/gateway.json 写权限，或用环境变量 GATEWAY_AUTH_TOKEN 指定。');
        }
    } else {
        logger.warn('⚠️ API 鉴权已关闭（server.requireAuth=false）。任何能访问本端口的进程/设备均可调用网关 API（含 Bot Token 与会话数据），仅建议在完全可信网络使用。');
    }
    if (HOST === '0.0.0.0' || (HOST !== '127.0.0.1' && HOST !== 'localhost')) {
        logger.warn(`⚠️ 网关绑定在 ${HOST}（对外可达）。请确保已开启鉴权并置于可信网络，否则 Bot Token 与会话数据存在暴露风险。`);
    }

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
    theatreBroadcaster.shutdown();
    if (pluginManager) await pluginManager.shutdown();
    await gatewayCore.stop();
    sessionManager.stop();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在关闭...');
    theatreBroadcaster.shutdown();
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
