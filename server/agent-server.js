/**
 * Agent 独立服务入口（Agent Standalone）
 *
 * 让 Agent 模块脱离主网关独立运行：只启动插件系统 + LLM 服务 + Agent 路由
 * （server/agent-api.js），不启动任何平台适配器（不调 initAdapters、
 * 不 gatewayCore.start 平台连接），也不挂 SillyTavern 前端。
 *
 * 启动后可通过浏览器访问独立 Agent 自定义前端：
 *   http://127.0.0.1:4321/agent
 *
 * 配置：
 *   - 端口：环境变量 AGENT_PORT，默认 4321（避开主网关默认 3210）
 *   - 绑定：环境变量 AGENT_HOST，默认 127.0.0.1
 *   - 插件/LLM 配置与主网关一致：读取 config/gateway.json（runtime.llm 等）
 *
 * 与主网关（server/index.js）共用同一套 Agent 路由实现（registerAgentApi），
 * 行为完全一致；各自是独立进程，theatreSessions / aiModifyHistory 等面板级
 * 临时状态互不共享（进程重启后丢失，权威状态仍在 workspace 与 sessions 目录）。
 */

// dotenv 必须在所有其他模块之前加载，确保 process.env 包含 .env 中的变量
import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';
import { createCorsMiddleware, createGatewayAuthMiddleware } from './utils/auth-middleware.js';
import configManager from './utils/config.js';
import { gatewayCore } from './gateway-core.js';
import { sessionManager } from './session-manager.js';
import { PluginManager } from './plugin-manager.js';
import { createLLMService } from './llm-service.js';
import { TheatreBroadcaster } from './agent/theatre-broadcaster.js';
import { registerAgentApi } from './agent-api.js';

const logger = createLogger('agent-server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// 独立端口：env AGENT_PORT 优先，默认 4321（避开主网关 3210）
const PORT = parseInt(process.env.AGENT_PORT || '4321', 10);
const HOST = process.env.AGENT_HOST || '127.0.0.1';

const app = express();
// 413 修复：独立 Agent 服务与主网关共用同一 JSON 解析策略。
// express.json() 默认 limit 100kb，大聊天存档保存会 413；调大到 50mb。
app.use(express.json({ limit: '50mb' }));

// P0-4 安全修复：独立 Agent 服务与主网关共用同一套 CORS 白名单 + X-Gateway-Token 鉴权。
// 此前该服务无任何鉴权、CORS 全开，任意可访问该端口者都能调用全部 /api/*（含保存 LLM Key、删 Profile、删聊天）。
app.use(createCorsMiddleware(configManager));
app.use(createGatewayAuthMiddleware(configManager));

// Agent 剧场事件广播器（SSE）：单例，进程级
const theatreBroadcaster = new TheatreBroadcaster();

async function startAgentServer() {
    logger.info('========================================');
    logger.info('  Agent 独立服务（Agent Standalone）');
    logger.info('========================================');

    // 1. 插件系统：注入与主网关相同的服务（不启动平台适配器）
    const pluginManager = new PluginManager({
        gateway: gatewayCore,
        sessionManager,
        configManager,
        theatreBroadcaster,
    });
    await pluginManager.init();
    pluginManager.registerRoutes(app);

    // 2. LLM 服务（runtime.llm 配置）——惰性创建：配置 model 后才实例化。
    //    前端保存 LLM 配置后 resetLlmService() 失效缓存，下次调用自动重建（无需重启）。
    let llmService = null;
    const getLlmService = () => {
        const runtimeCfg = configManager.get('runtime') || {};
        if (!runtimeCfg.llm?.model) return null;
        if (!llmService) {
            llmService = createLLMService(configManager);
            logger.info('🤖 LLM 服务已就绪');
        }
        return llmService;
    };
    if (!(configManager.get('runtime') || {}).llm?.model) {
        logger.warn('⚠️ runtime.llm.model 未配置，Agent run 将失败。请在页面设置中配置 LLM，或编辑 config/gateway.json 的 runtime.llm');
    }

    // 3. Agent 路由（与主网关共用同一实现：agents / agent-theatre / ai-modify / /agent 静态页）
    registerAgentApi(app, {
        getPluginManager: () => pluginManager,
        getLlmService: () => getLlmService(),
        resetLlmService: () => { llmService = null; },
        theatreBroadcaster,
        configManager,
        logger,
        repoRoot: REPO_ROOT,
        staticDir: PUBLIC_DIR,
    });

    // 4. 启动 HTTP
    const server = http.createServer(app);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            logger.error(`端口 ${PORT} 已被占用。解决：停止占用进程，或用 AGENT_PORT=xxxx 换端口。`);
        } else {
            logger.error(`HTTP 服务启动失败: ${err.message}`);
        }
        process.exit(1);
    });
    server.listen(PORT, HOST, () => {
        logger.info(`Agent 独立服务已启动: http://${HOST}:${PORT}`);
        logger.info(`Agent 可视化前端: http://${HOST}:${PORT}/agent`);
    });

    return server;
}

// 优雅关闭
process.on('SIGINT', async () => {
    logger.info('正在关闭 Agent 独立服务...');
    theatreBroadcaster.shutdown();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    logger.info('收到终止信号，正在关闭 Agent 独立服务...');
    theatreBroadcaster.shutdown();
    process.exit(0);
});

startAgentServer().catch((e) => {
    logger.error(`启动失败: ${e.message}`);
    process.exit(1);
});
