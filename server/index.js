// dotenv 必须在所有其他模块之前加载，确保 process.env 包含 .env 中的变量
// 管理脚本（gateway-manager.sh）通过 .env 注入适配器配置和 runtime 开关，
// 不加载 .env 会导致这些配置完全不生效。
import 'dotenv/config';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';
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
import { createStShim } from './compat/st-shim.js';
import { TheatreBroadcaster } from './agent/theatre-broadcaster.js';
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

/**
 * 判断请求 Origin 是否允许跨域。
 *
 * 放行规则（任一命中即放行）：
 *   1) server.allowedOrigins 白名单里显式列出的 Origin
 *   2) localhost / 127.0.0.1 / [::1] 的任意端口（本机 ST 常见部署）
 *   3) 鉴权开启（requireAuth=true）时放行任意 Origin
 *
 * 第 3 条是关键：服务器部署时，用户从浏览器经公网 IP 访问 ST（Origin 形如
 * http://<公网IP>:8000），既非 localhost 也不在白名单，会被 CORS 拦掉，
 * 表现为 ST 面板 "Failed to fetch"——而且陷入死循环（连不上就没法在面板加白名单）。
 * 由于网关用 X-Gateway-Token 头鉴权（非 Cookie），恶意网页拿不到 token 就调不动
 * 任何 /api/* 写读接口（health 除外，本就公开），所以鉴权开启时放行 Origin 不引入
 * 实质风险，token 仍是真正的保护层。
 *
 * 鉴权关闭（requireAuth=false）时**不**走第 3 条，CORS 退回严格白名单，
 * 避免无鉴权的网关被任意网页 drive-by 调用。
 */
function isOriginAllowed(origin) {
    if (!origin) return false;
    const allowed = configManager.get('server.allowedOrigins') || [];
    if (allowed.includes(origin)) return true;
    try {
        const { hostname } = new URL(origin);
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    } catch (_) {
        return false;
    }
    // 鉴权开启时放行任意 Origin：token 头是真正的保护，CORS 不应阻挡合法跨域访问
    const requireAuth = configManager.get('server.requireAuth') !== false;
    return requireAuth;
}

// CORS：收敛为 Origin 反射白名单（非通配），并声明自定义鉴权头
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isOriginAllowed(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gateway-Token');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

/** 恒定时间比较两个 token，避免时序侧信道 */
function tokenEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch (_) {
        return false;
    }
}

// 鉴权中间件：所有 /api/* 需携带正确的 X-Gateway-Token。
// 例外：健康检查（前端探活用，先于配置 token）与 OPTIONS 预检。
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/gateway/health') return next();

    const requireAuth = configManager.get('server.requireAuth') !== false;
    if (!requireAuth) return next();

    const expected = configManager.get('server.authToken');
    if (!expected) {
        // requireAuth 开启但无 token（异常状态）→ 拒绝，避免裸奔
        return res.status(503).json({ success: false, error: '网关鉴权未就绪（authToken 缺失）' });
    }

    const provided = req.headers['x-gateway-token'] ||
        (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!tokenEquals(String(provided), String(expected))) {
        return res.status(401).json({
            success: false,
            error: '鉴权失败：缺少或错误的 X-Gateway-Token。请在 SillyTavern 网关面板填入正确的 token（网关启动控制台会明文打印）',
        });
    }
    next();
});

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

        // 非命令消息：记录到会话历史
        sessionManager.addMessage(message.platform, message.chatId, {
            role: 'user',
            content: message.content,
            name: message.senderName,
        });

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

/** 上传资产文件（角色卡/世界书/预设） */
app.post('/api/runtime/assets/:type', upload.single('file'), (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { type } = req.params;
    if (!['characters', 'worldbooks', 'presets'].includes(type)) {
        return res.status(400).json({ success: false, error: '类型必须是 characters / worldbooks / presets' });
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

/** 删除一个已导入资产（角色卡/世界书/预设） */
app.delete('/api/runtime/assets/:type/:name', (req, res) => {
    if (!nativeRuntime) return res.status(400).json({ success: false, error: '自建推理管线未启用' });
    const { type, name } = req.params;
    if (!['characters', 'worldbooks', 'presets'].includes(type)) {
        return res.status(400).json({ success: false, error: '类型必须是 characters / worldbooks / presets' });
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
        const result = nativeRuntime.syncFromSillyTavern(stPath);
        logger.info(`从 ST 同步资产完成: 角色卡 ${result.characters} / 世界书 ${result.worldbooks} / 预设 ${result.presets}`);
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

app.get('/api/agents', (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.json({ agents: [], error: 'Agent框架未启用' });
    res.json({ agents: af.agentLoader.list() });
});

app.get('/api/agents/tools', (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.json({ tools: [] });
    res.json({ tools: af.toolRegistry.list() });
});

app.get('/api/agents/logs', (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.json({ logs: [] });
    res.json({ logs: af.agentRunner.getLogs(50) });
});

app.get('/api/agents/:name', (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.status(404).json({ error: 'Agent框架未启用' });
    const def = af.agentLoader.get(req.params.name);
    if (!def) return res.status(404).json({ error: 'Agent不存在' });
    res.json(def);
});

app.post('/api/agents', async (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
    try {
        const { yaml } = req.body;
        if (!yaml) return res.status(400).json({ error: '缺少yaml字段' });
        const def = af.agentLoader.save(req.body.name || '', yaml);
        res.json({ success: true, agent: def });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/agents/:name', (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
    af.agentLoader.delete(req.params.name);
    res.json({ success: true });
});

app.post('/api/agents/:name/run', async (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
    // 这里只返回提示，实际执行通过 IM 命令 /agent run
    res.json({ success: true, message: `请在IM中发送 /agent run ${req.params.name} 来启动Agent` });
});

/**
 * POST /api/agents/from-default - 从默认方案创建副本（SubTask 6.6）
 *
 * 复制 default-rp.yaml 为新 Profile，自动改名并去除 isDefault 标记。
 * 同时把默认记忆模板与文风复制到 agent-rp 数据目录（若不存在），
 * 保证新副本开箱即用。
 *
 * 请求体：{ name: string, displayName?: string }
 * 响应：{ success: true, agent: def }
 */
app.post('/api/agents/from-default', async (req, res) => {
    const af = pluginManager?.loader.getPlugin('agent-framework');
    if (!af) return res.status(503).json({ error: 'Agent框架未启用' });

    try {
        const newName = (req.body?.name || '').trim();
        if (!newName) return res.status(400).json({ error: '缺少 name 字段' });
        // 校验 name 合法性（避免路径穿越）
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(newName)) {
            return res.status(400).json({ error: 'name 仅允许字母数字及 . _ -，且以字母数字开头' });
        }
        // 不允许覆盖默认方案
        if (newName === 'default-rp') {
            return res.status(400).json({ error: '不能覆盖默认方案，请使用其他名称' });
        }

        const fsMod = (await import('fs')).default;
        const pathMod = (await import('path')).default;
        const { fileURLToPath } = await import('url');

        // 定位 default-rp.yaml 模板源
        const templatesDir = pathMod.join(
            pathMod.dirname(fileURLToPath(import.meta.url)),
            '..', 'plugins', 'agent-framework', 'templates',
        );
        const srcPath = pathMod.join(templatesDir, 'default-rp.yaml');
        if (!fsMod.existsSync(srcPath)) {
            return res.status(404).json({ error: '默认方案模板 default-rp.yaml 不存在' });
        }

        let yamlText = fsMod.readFileSync(srcPath, 'utf-8');

        // 替换 name 字段（首行 name: default-rp）
        yamlText = yamlText.replace(/^name:\s*default-rp\s*$/m, `name: ${newName}`);

        // 移除 isDefault: true 标记（副本不应是默认方案）
        yamlText = yamlText.replace(/^isDefault:\s*true\s*$/m, '# isDefault: true  # 副本不作为默认方案');

        // 可选：替换 displayName
        const displayName = (req.body?.displayName || '').trim();
        if (displayName) {
            if (/^displayName:\s*.+$/m.test(yamlText)) {
                yamlText = yamlText.replace(/^displayName:\s*.+$/m, `displayName: ${displayName}`);
            } else {
                yamlText = yamlText.replace(/^(name:\s*.+)$/m, `$1\ndisplayName: ${displayName}`);
            }
        }

        // 通过 agentLoader.save 保存（会写入 agents 目录并更新内存）
        const def = af.agentLoader.save(newName, yamlText);
        logger.info(`[api] 从默认方案创建副本: ${newName}`);

        res.json({ success: true, agent: def });
    } catch (e) {
        res.status(400).json({ error: e.message });
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

// ==================== ST 兼容前端桥（Task 3） ====================
//
// 让真实 SillyTavern 前端直连网关：模拟 ST 的 /api/* 契约，复用 assets/ 资产
// 与 Agent 引擎。路由处理函数由 createStShim 工厂构造，依赖运行时实例。
//
// 注意：这些路由放在 /api/* 鉴权中间件之后，自动复用 X-Gateway-Token 鉴权。
// 不需要单独的鉴权逻辑。

/**
 * 取 agent-framework 插件暴露的 agent 服务（含 run 方法）。
 * agent-framework 已 onLoad 时返回 _agentService，否则返回 null。
 * @returns {object|null}
 */
function getAgentService() {
    const af = pluginManager?.loader?.getPlugin('agent-framework');
    return af?._instance?._agentService || null;
}

/**
 * 取 ST 兼容桥使用的资产目录。优先用 nativeRuntime.dirs（与自建管线一致），
 * 否则回退到仓库根的 assets/ + data/chats/。
 * @returns {{characters:string, worldbooks:string, presets:string, chats:string}}
 */
function getStAssetDirs() {
    if (nativeRuntime) return nativeRuntime.dirs;
    return {
        characters: path.join(REPO_ROOT, 'assets', 'characters'),
        worldbooks: path.join(REPO_ROOT, 'assets', 'worldbooks'),
        presets: path.join(REPO_ROOT, 'assets', 'presets'),
        chats: path.join(REPO_ROOT, 'data', 'chats'),
    };
}

// 构造 ST shim 处理函数（懒构造：首次请求时按当前依赖重新构造，
// 避免在 nativeRuntime / agentService 还未就绪时固化依赖）
function getStShim() {
    return createStShim({
        dirs: getStAssetDirs(),
        nativeRuntime,
        agentService: getAgentService(),
        llmService,
        configManager,
        logger,
    });
}

// —— ST 兼容路由（参考 SillyTavern 实际请求路径） ——
app.get('/api/characters', (req, res) => getStShim().listCharacters(req, res));
app.get('/api/characters/:name', (req, res) => getStShim().getCharacter(req, res));
app.post('/api/characters', (req, res) => getStShim().writeCharacter(req, res));
// ST 部分版本用 /api/character/get-single，这里一并支持
app.get('/api/character/get-single', (req, res) => {
    req.params = { name: req.query.name || req.query.ch_name || '' };
    getStShim().getCharacter(req, res);
});

app.get('/api/chats/:characterName', (req, res) => getStShim().listChats(req, res));
app.get('/api/chats/:characterName/:fileId', (req, res) => getStShim().readChat(req, res));
app.post('/api/chats/:characterName/:fileId', (req, res) => getStShim().writeChat(req, res));
// ST 用 /api/chats/get 拉取聊天，/api/chats/rename 重命名，这里映射到 readChat
app.get('/api/chats/get', (req, res) => {
    req.params = { characterName: req.query.file_name || '', fileId: req.query.chatId || req.query.file_name || '' };
    getStShim().readChat(req, res);
});

app.get('/api/presets', (req, res) => getStShim().listPresets(req, res));
app.get('/api/presets/:name', (req, res) => getStShim().getPreset(req, res));

app.get('/api/worldinfo', (req, res) => getStShim().listWorldbooks(req, res));
app.get('/api/worldinfo/:name', (req, res) => getStShim().getWorldbook(req, res));
app.get('/api/worldinfo/get', (req, res) => {
    req.params = { name: req.query.name || '' };
    getStShim().getWorldbook(req, res);
});

app.post('/api/generate', (req, res) => getStShim().generate(req, res));

app.get('/api/settings', (req, res) => getStShim().getSettings(req, res));
app.get('/csrf-token', (req, res) => getStShim().getCsrfToken(req, res));

// ==================== Agent 剧场 API（Task 4） ====================
//
// SSE 端点 + 输入端点 + 事件查询，供面板内置的 "Agent 剧场" 页面消费。
// 推送 AgentRunResult 流，不走轮询。

/**
 * Agent 剧场会话状态（按 sessionKey 维护），用于 /state 端点回显当前会话状态。
 * 注意：这是面板级临时状态，进程重启后丢失；权威状态在 workspace 与 sessions 目录。
 * @type {Map<string, {profile:string, lastRunId?:string, lastResult?:object, turn:number}>}
 */
const theatreSessions = new Map();

/**
 * 解析 theatre 请求的 sessionKey：优先用 query.session，否则用 body.session，
 * 默认 'native:default'。
 * @param {object} req
 * @returns {string}
 */
function _theatreSessionKey(req) {
    return (req.query && req.query.session)
        || (req.body && req.body.session)
        || 'native:default';
}

/** GET /api/agent-theatre/stream - SSE 订阅 AgentRunResult 流 */
app.get('/api/agent-theatre/stream', (req, res) => {
    const sessionKey = _theatreSessionKey(req);
    theatreBroadcaster.addClient(res, sessionKey);
});

/** POST /api/agent-theatre/input - 接收用户输入，触发 ctx.agent.run */
app.post('/api/agent-theatre/input', async (req, res) => {
    const sessionKey = _theatreSessionKey(req);
    const body = req.body || {};
    const { input, profile, callbackId, character, worldbook, style } = body;

    if (!input && !callbackId) {
        return res.status(400).json({ success: false, error: '需要 input 或 callbackId' });
    }

    const agentService = getAgentService();
    if (!agentService || typeof agentService.run !== 'function') {
        return res.status(503).json({ success: false, error: 'agent-framework 插件未加载' });
    }
    if (!llmService) {
        return res.status(503).json({ success: false, error: 'runtime.llm 未配置，无法触发 Agent run' });
    }

    // 维护会话状态
    const sess = theatreSessions.get(sessionKey) || { profile: profile || 'default-rp', turn: 0 };
    if (profile) sess.profile = profile;
    sess.turn += 1;
    sess.lastInput = input || callbackId;
    theatreSessions.set(sessionKey, sess);

    // 选项回调：callbackId 形如 "select:option:1"，转成 "选择选项1: <text>" 作为 input
    let actualInput = input || '';
    if (!actualInput && callbackId) {
        actualInput = `[选项回调] ${callbackId}`;
    }

    // 解析 sessionKey -> platform:chatId
    const [platform, chatId] = sessionKey.split(':');

    try {
        // 触发 Agent run
        const runResult = await agentService.run(
            sess.profile,
            actualInput,
            {
                platform: platform || 'native',
                chatId: chatId || 'theatre',
                character: character || sess.character || '',
            },
            {
                llm: llmService,
                history: sess.history || [],
                character: character || sess.character,
                worldbook: worldbook || sess.worldbook,
                style: style || sess.style,
            },
        );

        sess.lastRunId = runResult.runId;
        sess.lastResult = runResult.result?.toJSON?.() || null;
        sess.profile = sess.profile; // 保持
        // 把本轮结果文本作为 assistant 消息加入历史，便于下一轮续写
        const mainText = runResult.result?.getMainText?.() || runResult.text || '';
        sess.history = sess.history || [];
        if (actualInput) sess.history.push({ role: 'user', content: actualInput });
        if (mainText) sess.history.push({ role: 'assistant', content: mainText });
        // 限制历史长度，避免内存膨胀
        if (sess.history.length > 40) sess.history = sess.history.slice(-40);

        // 广播完整结果 + 状态给所有订阅者
        theatreBroadcaster.broadcastResult(sessionKey, {
            runId: runResult.runId,
            result: sess.lastResult,
            text: mainText,
        });
        theatreBroadcaster.broadcastState(sessionKey, sess.lastResult?.state || {});

        res.json({
            success: true,
            runId: runResult.runId,
            text: mainText,
            result: sess.lastResult,
        });
    } catch (e) {
        logger.error(`[theatre] Agent run 失败: ${e.message}`);
        res.status(500).json({ success: false, error: e.message });
    }
});

/** GET /api/agent-theatre/events/:runId - 查询历史事件（调 workspace-manager.getEvents） */
app.get('/api/agent-theatre/events/:runId', (req, res) => {
    const { runId } = req.params;
    const afterSeq = parseInt(req.query.afterSeq) || 0;
    const limit = parseInt(req.query.limit) || 100;
    const af = pluginManager?.loader?.getPlugin('agent-framework');
    const wm = af?._instance?.workspaceManager;
    if (!wm || typeof wm.getEvents !== 'function') {
        return res.status(503).json({ success: false, error: 'workspace-manager 不可用' });
    }
    try {
        const events = wm.getEvents(runId, { afterSeq, limit });
        res.json({ success: true, runId, events });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

/** GET /api/agent-theatre/state - 当前会话状态 */
app.get('/api/agent-theatre/state', (req, res) => {
    const sessionKey = _theatreSessionKey(req);
    const sess = theatreSessions.get(sessionKey);
    if (!sess) {
        return res.json({
            success: true,
            session: sessionKey,
            active: false,
            message: '会话尚未开始',
        });
    }
    res.json({
        success: true,
        session: sessionKey,
        active: true,
        profile: sess.profile,
        turn: sess.turn,
        lastRunId: sess.lastRunId,
        lastResult: sess.lastResult,
    });
});

/**
 * GET /agent-theatre.js - 公开提供 panel-agent-theatre.js 脚本（无需鉴权）。
 *
 * panel.html 在 "Agent 剧场" 区块展开时动态注入此脚本。
 * 放在 /api/* 之外，绕过鉴权中间件（脚本本身无敏感数据）。
 */
app.get('/agent-theatre.js', (req, res) => {
    const file = path.join(REPO_ROOT, 'panel-agent-theatre.js');
    if (!fs.existsSync(file)) {
        return res.status(404).send('// panel-agent-theatre.js not found');
    }
    res.type('application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(file).pipe(res);
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
