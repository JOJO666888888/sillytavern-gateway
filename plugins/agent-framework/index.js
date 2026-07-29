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
import { ContextBuilder } from '../../server/agent/context-builder.js';

// 工具
import { createStateTools } from './tools/state-tools.js';
import { createMemoryTools } from './tools/memory-tools.js';
import { createNarrativeTools } from './tools/narrative-tools.js';
import { createFileTools } from './tools/file-tools.js';
import { createSkillTools } from './tools/skill-tools.js';
import { createSubAgentTools } from './tools/subagent-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data', 'plugins', 'agent-framework');

export default class AgentFrameworkPlugin extends GatewayPlugin {
    // 命令：/agent run|list|status|edit|help
    static commands = [{
        name: 'agent',
        description: 'Agent 框架命令',
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

        // 2. 初始化引擎组件
        this.agentLoader = new AgentLoader(agentsDir);
        this.agentLoader.loadAll();

        this.toolRegistry = new ToolRegistry();
        this.stateManager = new StateManager(DATA_DIR);
        this.memoryEngine = new MemoryEngine(DATA_DIR, {
            summaryInterval: this.getConfig('summaryInterval') ?? 10,
        });
        this.contextBuilder = new ContextBuilder({ dataDir: DATA_DIR });
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
            logger: this.logger,
        });

        // 3. 注册内置工具
        this.toolRegistry.registerAll(createStateTools(this.stateManager), 'framework');
        this.toolRegistry.registerAll(createMemoryTools(this.memoryEngine), 'framework');
        this.toolRegistry.registerAll(createNarrativeTools(), 'framework');
        this.toolRegistry.registerAll(createFileTools(DATA_DIR), 'framework');
        this.toolRegistry.registerAll(createSkillTools(DATA_DIR), 'framework');
        this.toolRegistry.registerAll(createSubAgentTools(this.subagentDispatcher), 'framework');

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
        };

        // 5. Agent 会话状态（哪些会话处于 Agent 模式）
        this._agentSessions = new Map(); // key: "platform:chatId" -> { agentName, turnCount }

        this.logger.info('Agent 框架已加载，工具数: ' + this.toolRegistry.tools.size);
    }

    async onUnload() {
        this._agentSessions.clear();
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
        // 从定义的 context.injectAssets 中提取变量名
        const inject = definition.context?.injectAssets || {};
        const val = inject[varName];
        if (val && val.startsWith('${') && val.endsWith('}')) {
            return val.slice(2, -1); // 返回变量名本身
        }
        return val || '';
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
        const lines = ['📊 Agent 框架状态', ''];
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
        ctx.reply('请在网关面板的 Agent 框架区块中编辑 Agent YAML 定义，或直接编辑 data/plugins/agent-framework/agents/ 目录下的 .yaml 文件。');
    }

    async _cmdHelp(ctx) {
        ctx.reply([
            'Agent 框架帮助',
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
