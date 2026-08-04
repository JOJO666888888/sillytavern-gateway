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
app.use(express.json());

// 开发服务 CORS：允许所有来源（本机开发工具，鉴权可选）。
// 页面内所有 API 请求由前端自行携带 X-Gateway-Token（若主网关开启了鉴权）。
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gateway-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

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

    // 2. LLM 服务（runtime.llm 配置）
    let llmService = null;
    const runtimeCfg = configManager.get('runtime') || {};
    if (runtimeCfg.llm?.model) {
        llmService = createLLMService(configManager);
        logger.info('🤖 LLM 服务已就绪');
    } else {
        logger.warn('⚠️ runtime.llm.model 未配置，Agent run 将失败。请在 config/gateway.json 的 runtime.llm 中设置 provider/apiKey/model');
    }

    // 3. Agent 路由（与主网关共用同一实现：agents / agent-theatre / ai-modify / /agent 静态页）
    registerAgentApi(app, {
        getPluginManager: () => pluginManager,
        getLlmService: () => llmService,
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
