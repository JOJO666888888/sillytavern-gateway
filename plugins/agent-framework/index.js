/**
 * Agent 框架插件
 *
 * 终端 Agent 框架：YAML 定义工作流、工具注册表、子代理调度、多阶段流水线。
 * 让用户在网关内实现多 Agent 创作流水线。
 *
 * 命令：
 *   /agent run <名称> [消息]  - 启动Agent并可选发送首条消息
 *   /agent list               - 列出所有Agent
 *   /agent status             - 查看框架状态
 *   /agent edit               - 编辑Agent定义
 *   /agent help               - 显示帮助
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { AgentLoader } from './engine/agent-loader.js';
import { ToolRegistry } from './engine/tool-registry.js';
import { AgentRunner } from './engine/agent-runner.js';
import { SubagentDispatcher } from './engine/subagent-dispatcher.js';
import { StateManager } from './engine/state-manager.js';
import { MemoryEngine } from './engine/memory-engine.js';
import { WorkspaceManager } from './engine/workspace-manager.js';
import { CollabBus } from './engine/collab-bus.js';
import { createEmbedder } from './engine/embedder.js';
import { ContextBuilder, extractDefinitionVar } from '../../server/agent/context-builder.js';

// 工具
import { createStateTools } from './tools/state-tools.js';
import { createMemoryTools } from './tools/memory-tools.js';
import { createNarrativeTools } from './tools/narrative-tools.js';
import { createFileTools } from './tools/file-tools.js';
import { createSkillTools } from './tools/skill-tools.js';
import { createSubAgentTools } from './tools/subagent-tools.js';
import { createCollabTools } from './tools/collab-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data', 'plugins', 'agent-framework');

export default class AgentFrameworkPlugin extends GatewayPlugin {
    // 命令：/agent run|list|status|edit|help
    static commands = [{
        name: 'agent',
        description: 'Agent 设置命令',
        handler: 'handleAgent',
        usage: '/agent <run|list|status|edit|help> [参数]',
    }];

    // 监听器：Agent 模式下拦截消息
    static listeners = [{
        event: 'message',
        priority: 40,
        handler: 'onMessage',
    }];

    async onLoad() {
        // 1. 确保数据目录存在
        const agentsDir = path.join(DATA_DIR, 'agents');
        const skillsDir = path.join(DATA_DIR, 'skills');
        const stylesDir = path.join(DATA_DIR, 'styles');
        const memoryDir = path.join(DATA_DIR, 'memory');
        for (const d of [agentsDir, skillsDir, stylesDir, memoryDir]) {
            fs.mkdirSync(d, { recursive: true });
        }

        // 1.1 首次启动引导：把 templates/ 下的默认方案模板复制到 agents/ 目录。
        // 仅在目标文件不存在时复制（不覆盖用户已自定义的版本）。
        this._seedDefaultTemplates(agentsDir);

        // 2. 初始化引擎组件
        this.agentLoader = new AgentLoader(agentsDir);
        this.agentLoader.loadAll();

        this.toolRegistry = new ToolRegistry();
        this.stateManager = new StateManager(DATA_DIR);
        // 记忆检索器：inverted（默认，零依赖）/ embedding（需 embedder，见 _buildRetrieverOptions）
        this.memoryEngine = new MemoryEngine(DATA_DIR, {
            summaryInterval: this.getConfig('summaryInterval') ?? 10,
            retriever: this.getConfig('memoryRetriever') || 'inverted',
            retrieverOptions: this._buildRetrieverOptions(),
        });
        this.contextBuilder = new ContextBuilder({ dataDir: DATA_DIR });
        this.workspaceManager = new WorkspaceManager({ dataRoot: DATA_DIR, logger: this.logger });
        // Phase 3 多 Agent 协作：进程内协作总线（run 级生命周期，run 结束清理）
        this.collabBus = new CollabBus();
        this.subagentDispatcher = new SubagentDispatcher({
            agentLoader: this.agentLoader,
            toolRegistry: this.toolRegistry,
            contextBuilder: this.contextBuilder,
            logger: this.logger,
        });
        this.agentRunner = new AgentRunner({
            toolRegistry: this.toolRegistry,
            subagentDispatcher: this.subagentDispatcher,
            stateManager: this.stateManager,
            memoryEngine: this.memoryEngine,
            contextBuilder: this.contextBuilder,
            workspaceManager: this.workspaceManager,
            collabBus: this.collabBus,
            logger: this.logger,
            // 流式 token 增量 → theatre-broadcaster 实时推送到 Agent 剧场 SSE 客户端
            onTokenDelta: (runId, delta, full, turn, sessionKey) =>
                this._broadcastTokenDelta(runId, delta, full, turn, sessionKey),
        });

        // 3. 注册内置工具
        this.toolRegistry.registerAll(createStateTools(this.stateManager), 'framework');
        this.toolRegistry.registerAll(createMemoryTools(this.memoryEngine), 'framework');
        this.toolRegistry.registerAll(createNarrativeTools(), 'framework');
        this.toolRegistry.registerAll(createFileTools(DATA_DIR), 'framework');
        this.toolRegistry.registerAll(createSkillTools(DATA_DIR), 'framework');
        this.toolRegistry.registerAll(createSubAgentTools(this.subagentDispatcher), 'framework');
        this.toolRegistry.registerAll(createCollabTools(this.collabBus), 'framework');

        // 4. 暴露 agent 服务（供其他插件通过 ctx.agent 访问）
        this._agentService = {
            registerTool: (toolDef) => this.toolRegistry.register(toolDef),
            dispatch: async (agentName, task, options) => {
                // 需要构建 session 和 ctx，这里简化
                return this.subagentDispatcher.dispatch(agentName, task, {}, null, options);
            },
            registerAgent: (agentDef) => {
                this.agentLoader.agents.set(agentDef.name, agentDef);
            },
            getStatus: () => this.agentRunner.getStatus(),
            getWorkspaceManager: () => this.workspaceManager,
            /**
             * 协作总线（Phase 3）：供其他插件编程式发布/订阅 run 内协作消息。
             * publish(msg) / request(topic, payload, opts) / subscribe(topic, handler) / unsubscribe(topic, handler)
             */
            collab: {
                publish: (msg) => this.collabBus.publish(msg),
                request: (topic, payload, opts) => this.collabBus.request(topic, payload, opts),
                subscribe: (topic, handler) => this.collabBus.subscribe(topic, handler),
                unsubscribe: (topic, handler) => this.collabBus.unsubscribe(topic, handler),
            },
            /**
             * 触发一次 Agent run，产出 AgentRunResult。
             *
             * 供 ctx.agent.run 调用（其他插件如 agent-rp 通过表现层适配器消费结果）。
             *
             * @param {string} profile - Agent 定义名（YAML 文件名，对应 agentLoader 的 key）
             * @param {string} input - 用户输入文本
             * @param {object} [session] - 会话状态（character/worldbook/style/turn/platform/chatId/id...）
             * @param {object} [ctx] - 插件上下文（用于取 ctx.llm / ctx.getHistory / ctx.workspace）
             * @returns {Promise<{runId:string, result:import('../../server/agent/run-result.js').AgentRunResult, text:string, steps:number, subAgentResults:Array, logs:object}>}
             */
            run: async (profile, input, session = {}, ctx = null) => {
                const definition = this.agentLoader.get(profile);
                if (!definition) {
                    throw new Error(`Agent profile "${profile}" 不存在，可用: ${this.agentLoader.list().map(a => a.name).join(', ') || '(空)'}`);
                }

                // 注入 LLM 到记忆引擎（runner 内部会用到）
                if (ctx?.llm && this.memoryEngine) {
                    this.memoryEngine.setLLM(ctx.llm);
                }

                // 拉取历史（优先用 ctx.getHistory，便于按 definition.context.historyLimit 收窄）
                const historyLimit = definition.context?.historyLimit || 20;
                const history = (typeof ctx?.getHistory === 'function')
                    ? (ctx.getHistory(historyLimit) || [])
                    : (session?.history || []);

                // 组装 agentSession：把传入的 session 补全为 runner 期望的形态
                const agentSession = {
                    id: session?.id || `${ctx?.platform || 'unknown'}:${ctx?.chatId || 'unknown'}`,
                    platform: ctx?.platform || session?.platform || 'unknown',
                    chatId: ctx?.chatId || session?.chatId || 'unknown',
                    character: session?.character || this._extractVar(definition, 'character') || '',
                    worldbook: session?.worldbook || this._extractVar(definition, 'worldbook') || '',
                    style: session?.style || this._extractVar(definition, 'style') || '',
                    turn: session?.turn ?? session?.turnCount ?? 0,
                    ...session,
                };

                return this.agentRunner.run(definition, agentSession, history, input, ctx);
            },
        };

        // 5. Agent 会话状态（哪些会话处于 Agent 模式）
        this._agentSessions = new Map(); // key: "platform:chatId" -> { agentName, turnCount }

        // 6. 注册 native 表现层适配器（SubTask 6.4）
        // 把 AgentRunResult 通过 theatre-broadcaster 广播给 Agent 剧场前端。
        // 适配器在 SurfaceManager 注册后，可被 ctx.surface.dispatch 作为旁路适配器调用，
        // 也可被其他插件（如 agent-rp）在 IM 端 run 时同步推送到面板。
        this._registerNativeSurface();

        this.logger.info('Agent 设置已加载，工具数: ' + this.toolRegistry.tools.size);
    }

    async onUnload() {
        this._agentSessions.clear();
        if (this._removeNativeSurface) {
            try { this._removeNativeSurface(); } catch (_) {}
            this._removeNativeSurface = null;
        }
        // 落盘 state 写缓冲，避免卸载时丢失状态
        if (this.stateManager?.dispose) {
            try { this.stateManager.dispose(); } catch (_) {}
        }
    }

    /**
     * 首次启动引导：把 templates/ 下的 Agent YAML 模板复制到 agents/ 目录。
     * 仅在目标文件不存在时复制，不覆盖用户已自定义的版本。
     * 包含：default-rp.yaml（默认方案）+ multi-critic/director-mode/state-engine/independent-character（进阶模板）。
     * @param {string} agentsDir - data/plugins/agent-framework/agents/
     * @private
     */
    _seedDefaultTemplates(agentsDir) {
        const templatesDir = path.join(__dirname, 'templates');
        if (!fs.existsSync(templatesDir)) return;
        const seeds = [
            'default-rp.yaml',
            'multi-critic.yaml',
            'director-mode.yaml',
            'state-engine.yaml',
            'independent-character.yaml',
        ];
        for (const fname of seeds) {
            const src = path.join(templatesDir, fname);
            const dst = path.join(agentsDir, fname);
            if (!fs.existsSync(src)) continue;
            if (fs.existsSync(dst)) continue; // 不覆盖用户版本
            try {
                fs.copyFileSync(src, dst);
                this.logger.info(`[agent-framework] 已播种默认模板: ${fname}`);
            } catch (e) {
                this.logger.warn(`[agent-framework] 播种模板 ${fname} 失败: ${e.message}`);
            }
        }
    }

    /**
     * 注册 native 表现层适配器（SubTask 6.4）。
     *
     * 适配器名：native-default，surfaceType: 'native'。
     * render 方法把 AgentRunResult 通过 theatre-broadcaster 广播给所有订阅该会话的 SSE 客户端
     * （Agent 剧场前端通过 EventSource 订阅 /api/agent-theatre/stream?session=<key>）。
     *
     * 注意：本适配器不主动发送消息到任何 IM 平台，仅作为旁路通道把引擎产出推送到面板。
     * IM 端的渲染由 agent-rp 注册的 im-default 适配器负责。
     *
     * @private
     */
    _registerNativeSurface() {
        try {
            const surface = this._services?.surface;
            const broadcaster = this._services?.theatreBroadcaster;
            if (!surface || typeof surface.register !== 'function') {
                this.logger.warn('[agent-framework] surface 服务不可用，跳过 native 适配器注册（请检查 plugin.json 是否声明 surface 权限）');
                return;
            }
            this._removeNativeSurface = surface.register({
                name: 'native-default',
                surfaceType: 'native',
                /**
                 * @param {import('../../server/agent/run-result.js').AgentRunResult} result
                 * @param {object} [ctx]
                 */
                render: async (result, ctx) => {
                    if (!broadcaster) return;
                    // 解析会话 key（与 theatre-broadcaster 的 sessionKey 约定一致：platform:chatId）
                    const platform = ctx?.platform || ctx?.message?.platform || 'native';
                    const chatId = ctx?.chatId || ctx?.message?.chatId || 'default';
                    const sessionKey = `${platform}:${chatId}`;
                    const payload = {
                        runId: result?.runId || '',
                        result: result?.toJSON?.() || null,
                        text: result?.getMainText?.() || '',
                    };
                    broadcaster.broadcastResult(sessionKey, payload);
                    if (result?.state) {
                        broadcaster.broadcastState(sessionKey, result.state);
                    }
                },
            });
            this.logger.info('[agent-framework] native 表现层适配器 native-default 已注册');
        } catch (e) {
            this.logger.warn(`[agent-framework] 注册 native 适配器失败: ${e.message}`);
        }
    }

    // /agent 命令路由
    async handleAgent(ctx) {
        const subCmd = (ctx.args[0] || 'help').toLowerCase();
        switch (subCmd) {
            case 'run': return this._cmdRun(ctx);
            case 'list': return this._cmdList(ctx);
            case 'status': return this._cmdStatus(ctx);
            case 'edit': return this._cmdEdit(ctx);
            case 'help': return this._cmdHelp(ctx);
            default: return ctx.reply('未知子命令。用法: /agent <run|list|status|edit|help>');
        }
    }

    // /agent run <name>
    async _cmdRun(ctx) {
        const agentName = ctx.args[1];
        if (!agentName) return ctx.reply('用法: /agent run <Agent名称>');

        const definition = this.agentLoader.get(agentName);
        if (!definition) return ctx.reply(`❌ Agent "${agentName}" 不存在。用 /agent list 查看可用Agent`);

        // 注册 Agent 会话
        const sessionKey = `${ctx.platform}:${ctx.chatId}`;
        this._agentSessions.set(sessionKey, {
            agentName,
            character: this._extractVar(definition, 'character') || '',
            worldbook: this._extractVar(definition, 'worldbook') || '',
            style: this._extractVar(definition, 'style') || '',
            platform: ctx.platform,
            chatId: ctx.chatId,
            turnCount: 0,
        });

        // 如果有首条消息，直接执行
        const userMsg = ctx.args.slice(2).join(' ');
        if (userMsg) {
            await this._executeAgent(ctx, agentName, userMsg);
        } else {
            ctx.reply(`✅ Agent "${agentName}" 已启动。发送消息开始对话。`);
        }
    }

    // 消息监听器：Agent 模式下拦截
    async onMessage(ctx) {
        const sessionKey = `${ctx.platform}:${ctx.chatId}`;
        const session = this._agentSessions.get(sessionKey);
        if (!session) return; // 未处于 Agent 模式

        ctx.stopPropagation();
        await this._executeAgent(ctx, session.agentName, ctx.content);
    }

    // 执行 Agent
    async _executeAgent(ctx, agentName, userMessage) {
        const definition = this.agentLoader.get(agentName);
        if (!definition) {
            ctx.reply(`❌ Agent "${agentName}" 定义已丢失`);
            return;
        }

        const sessionKey = `${ctx.platform}:${ctx.chatId}`;
        const session = this._agentSessions.get(sessionKey);
        session.turnCount++;

        // 注入 LLM 到记忆引擎
        this.memoryEngine.setLLM(ctx.llm);

        // 获取历史
        const history = ctx.getHistory(definition.context?.historyLimit || 20) || [];

        // 构建 session 对象
        const agentSession = {
            character: session.character,
            worldbook: session.worldbook,
            style: session.style,
            platform: ctx.platform,
            chatId: ctx.chatId,
        };

        // 执行
        const result = await this.agentRunner.run(definition, agentSession, history, userMessage, ctx);

        // 发送回复
        if (result.text) {
            ctx.reply(result.text);
        }

        // 自动摘要
        if (this.memoryEngine.shouldSummarize(session.turnCount)) {
            this.memoryEngine.generateSummary(history).catch(() => {});
        }

        // 记录子代理结果
        if (result.subAgentResults && result.subAgentResults.length > 0) {
            this.logger.info(`子代理执行完成: ${result.subAgentResults.length} 个`);
        }
    }

    _extractVar(definition, varName) {
        // 委托共享实现（语义与 agent-runner 的 meta.style 一致）
        return extractDefinitionVar(definition, varName);
    }

    /**
     * 构建记忆检索器选项（任务 2b 延伸：嵌入向量引擎启用）。
     * 仅当 memoryRetriever === 'embedding' 时注入 embedder：
     * - embedderMode 'local'（默认，零依赖）：字符 n-gram hashing，离线可用
     * - embedderMode 'api'：调用 OpenAI 兼容 /embeddings（embedderBaseUrl/embedderModel/embedderApiKey）
     * @private
     */
    _buildRetrieverOptions() {
        if ((this.getConfig('memoryRetriever') || 'inverted') !== 'embedding') return {};
        const mode = this.getConfig('embedderMode') || 'local';
        return {
            embedder: createEmbedder(mode, {
                baseUrl: this.getConfig('embedderBaseUrl') || '',
                apiKey: this.getConfig('embedderApiKey') || '',
                model: this.getConfig('embedderModel') || 'text-embedding-3-small',
            }),
        };
    }

    /**
     * 把 agent run 的流式 token 增量广播给订阅该会话的 Agent 剧场 SSE 客户端。
     * 广播器未就绪时静默跳过（流式仅为体验增强，不阻塞主流程）。
     * @private
     */
    _broadcastTokenDelta(runId, delta, full, turn, sessionKey) {
        const broadcaster = this._services?.theatreBroadcaster;
        if (!broadcaster || typeof broadcaster.broadcastTokenDelta !== 'function') return;
        try {
            broadcaster.broadcastTokenDelta(sessionKey, delta, runId);
        } catch (e) {
            this.logger.warn?.(`[agent-framework] token 增量广播失败: ${e.message}`);
        }
    }

    async _cmdList(ctx) {
        const agents = this.agentLoader.list();
        if (agents.length === 0) {
            return ctx.reply('暂无 Agent 定义。在 data/plugins/agent-framework/agents/ 目录创建 .yaml 文件。');
        }
        const lines = ['📦 Agent 列表', ''];
        for (const a of agents) {
            const tools = a.tools.length > 0 ? ` [${a.tools.length}工具]` : '';
            const subs = a.subAgents.length > 0 ? ` [${a.subAgents.length}子代理]` : '';
            lines.push(`  ${a.name} - ${a.displayName}${tools}${subs}`);
            if (a.description) lines.push(`    ${a.description}`);
        }
        ctx.reply(lines.join('\n'));
    }

    async _cmdStatus(ctx) {
        const status = this.agentRunner.getStatus();
        const tools = this.toolRegistry.list();
        const lines = ['📊 Agent 设置状态', ''];
        lines.push(`工具注册表: ${tools.length} 个工具`);
        lines.push(`活跃 Agent: ${status.activeAgents.length}`);
        lines.push(`总执行次数: ${status.totalRuns}`);
        if (status.activeAgents.length > 0) {
            lines.push('');
            lines.push('运行中:');
            for (const a of status.activeAgents) {
                lines.push(`  ${a.agent} (${Math.round(a.duration / 1000)}s)`);
            }
        }
        // 当前会话状态
        const sessionKey = `${ctx.platform}:${ctx.chatId}`;
        const session = this._agentSessions.get(sessionKey);
        if (session) {
            lines.push('');
            lines.push(`当前会话: Agent="${session.agentName}" 轮次=${session.turnCount}`);
        } else {
            lines.push('');
            lines.push('当前会话: 未启动 Agent');
        }
        ctx.reply(lines.join('\n'));
    }

    async _cmdEdit(ctx) {
        ctx.reply('请在独立 Agent 前端页面（网关面板 → Agent 前端，或直接访问 /agent）中编辑 Agent 定义，或直接编辑 data/plugins/agent-framework/agents/ 目录下的 .yaml 文件。');
    }

    async _cmdHelp(ctx) {
        ctx.reply([
            'Agent 设置帮助',
            '',
            '命令:',
            '  /agent run <名称> [消息]  - 启动Agent并可选发送首条消息',
            '  /agent list               - 列出所有Agent',
            '  /agent status              - 查看框架状态',
            '  /agent edit                - 编辑Agent定义',
            '  /agent help                - 显示此帮助',
            '',
            'Agent定义: data/plugins/agent-framework/agents/*.yaml',
            '工具数: ' + this.toolRegistry.tools.size,
        ].join('\n'));
    }
}
