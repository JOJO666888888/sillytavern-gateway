/**
 * Agent 独立 API 路由注册（Agent 服务独立化部署）
 *
 * 把 Agent 相关 REST/SSE 路由抽成可复用模块，主网关（server/index.js）与
 * 独立 Agent 服务（server/agent-server.js）共用同一实现，保证行为一致。
 *
 * 包含路由：
 *   - GET/POST/DELETE /api/agents*        Agent 框架管理（列表/工具/日志/增删/运行提示/模板复制）
 *   - GET  /api/agent-theatre/stream      SSE 订阅 AgentRunResult 流
 *   - POST /api/agent-theatre/input       Agent 剧场输入（触发 ctx.agent.run，含 P0 rerun + P2 run_state 广播）
 *   - POST /api/agent-theatre/abort       P2 中止当前 run
 *   - POST /api/agent-theatre/validate-run   保存 Profile 并验证可运行性
 *   - GET  /api/agent-theatre/events/:runId  查询历史事件（workspaceManager.getEvents）
 *   - GET  /api/agent-theatre/state       当前会话状态回显
 *   - POST/GET /api/agent-theatre/ai-modify/*   AI 辅助修改 Profile（plan/apply/undo/history）
 *   - POST /api/agent-frontend/validate   Agent 前端 URL 校验
 *   - express.static + GET /agent         Agent 自定义前端静态页面（public/）
 *
 * 依赖注入（deps）：
 *   - getPluginManager()   -> () => pluginManager 或 null（运行时动态取值）
 *   - getLlmService()      -> () => llmService 或 null（运行时动态取值）
 *   - theatreBroadcaster   -> TheatreBroadcaster 实例（SSE 广播）
 *   - configManager        -> 配置管理器
 *   - logger               -> 日志器
 *   - repoRoot             -> 仓库根目录绝对路径
 *   - staticDir            -> public 静态目录绝对路径
 *
 * 本模块内部维护（ESM 单例，主服务与独立服务各自是独立进程，互不共享）：
 *   - theatreSessions：Agent 剧场会话状态 Map（面板级临时状态，进程重启后丢失）
 *   - aiModifyHistory：AI 辅助修改的快照历史 Map
 *   - getReadyAgentFramework / getAgentService / _theatreSessionKey 辅助函数
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { createAiModifierHandlers, createProfileStore } from './ai-modifier.js';
import { createAgentFrontendValidateHandler } from './agent-frontend.js';

/** AI 辅助修改的快照历史：profileName -> [yamlSnapshot, ...]（最多保留 MAX_HISTORY 步） */
const aiModifyHistory = new Map();

/**
 * Agent 剧场会话状态（按 sessionKey 维护），用于 /state 端点回显当前会话状态。
 * 注意：这是面板级临时状态，进程重启后丢失；权威状态在 workspace 与 sessions 目录。
 * @type {Map<string, {profile:string, lastRunId?:string, lastResult?:object, turn:number}>}
 */
const theatreSessions = new Map();

/**
 * 注册 Agent 相关 API 到 Express app（主网关与独立 Agent 服务共用）。
 *
 * @param {import('express').Express} app
 * @param {object} deps - 依赖注入（见文件头注释）
 */
export function registerAgentApi(app, deps) {
    const {
        getPluginManager,
        getLlmService,
        theatreBroadcaster,
        configManager, // eslint-disable-line no-unused-vars —— 保留在 deps 签名中以与主网关调用保持一致
        logger,
        repoRoot,
        staticDir,
    } = deps;

    /**
     * 获取"已就绪"的 agent-framework 插件实例。
     *
     * 注意：插件被禁用时 loader.getPlugin() 仍会返回实例（onLoad 未执行，
     * _loaded=false），其 agentLoader/toolRegistry/agentRunner 均为 undefined。
     * 面板端点若直接访问 af.agentLoader.list() 会抛 TypeError -> HTTP 500。
     * 这里统一判空返回 null，让端点走现有的 !af 分支返回可读的 JSON 错误。
     *
     * @returns {object|null} 已就绪的插件实例，未启用/未就绪返回 null
     */
    function getReadyAgentFramework() {
        const af = getPluginManager()?.loader?.getPlugin('agent-framework');
        if (!af || !af._loaded || !af.agentLoader) return null;
        return af;
    }

    /**
     * 取 agent-framework 插件暴露的 agent 服务（含 run 方法）。
     * agent-framework 已 onLoad 时返回 _agentService，否则返回 null。
     * @returns {object|null}
     */
    function getAgentService() {
        const af = getPluginManager()?.loader?.getPlugin('agent-framework');
        return af?._agentService || null;
    }

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

    // ==================== Agent 框架 API ====================

    app.get('/api/agents', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.json({ agents: [], error: 'Agent框架未启用' });
        res.json({ agents: af.agentLoader.list() });
    });

    app.get('/api/agents/tools', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.json({ tools: [] });
        res.json({ tools: af.toolRegistry.list() });
    });

    app.get('/api/agents/logs', (req, res) => {
        const af = getPluginManager()?.loader.getPlugin('agent-framework');
        if (!af) return res.json({ logs: [] });
        res.json({ logs: af.agentRunner.getLogs(50) });
    });

    app.get('/api/agents/:name', (req, res) => {
        const af = getReadyAgentFramework();
        if (!af) return res.status(404).json({ error: 'Agent框架未启用' });
        const def = af.agentLoader.get(req.params.name);
        if (!def) return res.status(404).json({ error: 'Agent不存在' });
        res.json(def);
    });

    app.post('/api/agents', async (req, res) => {
        const af = getReadyAgentFramework();
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
        const af = getReadyAgentFramework();
        if (!af) return res.status(503).json({ error: 'Agent框架未启用' });
        af.agentLoader.delete(req.params.name);
        res.json({ success: true });
    });

    app.post('/api/agents/:name/run', async (req, res) => {
        const af = getReadyAgentFramework();
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
        const af = getReadyAgentFramework();
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

            // 定位 default-rp.yaml 模板源（与主网关同仓库：<repoRoot>/plugins/agent-framework/templates）
            const templatesDir = path.join(repoRoot, 'plugins', 'agent-framework', 'templates');
            const srcPath = path.join(templatesDir, 'default-rp.yaml');
            if (!fs.existsSync(srcPath)) {
                return res.status(404).json({ error: '默认方案模板 default-rp.yaml 不存在' });
            }

            let yamlText = fs.readFileSync(srcPath, 'utf-8');

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

    // ==================== Agent 剧场 API（Task 4） ====================
    //
    // SSE 端点 + 输入端点 + 事件查询，供面板内置的 "Agent 剧场" 页面消费。
    // 推送 AgentRunResult 流，不走轮询。

    /** GET /api/agent-theatre/stream - SSE 订阅 AgentRunResult 流 */
    app.get('/api/agent-theatre/stream', (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        theatreBroadcaster.addClient(res, sessionKey);
    });

    /** POST /api/agent-theatre/input - 接收用户输入，触发 ctx.agent.run */
    app.post('/api/agent-theatre/input', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const body = req.body || {};
        const { input, profile, callbackId, character, worldbook, style, rerun } = body;

        if (!input && !callbackId && !rerun) {
            return res.status(400).json({ success: false, error: '需要 input 或 callbackId' });
        }

        const agentService = getAgentService();
        if (!agentService || typeof agentService.run !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载' });
        }
        if (!getLlmService()) {
            return res.status(503).json({ success: false, error: 'runtime.llm 未配置，无法触发 Agent run' });
        }

        // 维护会话状态
        const sess = theatreSessions.get(sessionKey) || { profile: profile || 'default-rp', turn: 0 };
        if (profile) sess.profile = profile;

        // 重跑：复用上一轮输入
        if (rerun) {
            if (!sess.lastInput) {
                return res.status(400).json({ success: false, error: '没有上一轮输入可重跑' });
            }
        }

        sess.turn += 1;
        // 非 rerun 时才更新 lastInput
        if (!rerun) {
            sess.lastInput = input || callbackId;
        }
        theatreSessions.set(sessionKey, sess);

        // 选项回调：callbackId 形如 "select:option:1"，转成 "选择选项1: <text>" 作为 input
        let actualInput = '';
        if (rerun) {
            // 重跑时复用上一轮的 actualInput 推导
            const lastInput = sess.lastInput;
            // 判断 lastInput 是 callbackId 还是普通 input（callbackId 通常以 select: 开头）
            if (typeof lastInput === 'string' && lastInput.startsWith('select:')) {
                actualInput = `[选项回调] ${lastInput}`;
            } else {
                actualInput = lastInput || '';
            }
        } else {
            actualInput = input || '';
            if (!actualInput && callbackId) {
                actualInput = `[选项回调] ${callbackId}`;
            }
        }

        // 解析 sessionKey -> platform:chatId
        const [platform, chatId] = sessionKey.split(':');

        // P2: run 执行前标记 running（供 /abort 端点判断是否有进行中的 run）并广播 run_state
        sess.running = true;
        sess.lastRunId = null;
        theatreSessions.set(sessionKey, sess);
        theatreBroadcaster.broadcastRunState(sessionKey, null, 'running');

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
                    llm: getLlmService(),
                    history: sess.history || [],
                    character: character || sess.character,
                    worldbook: worldbook || sess.worldbook,
                    style: style || sess.style,
                },
            );

            // P2: run 结束，清理 running 标记并广播终态（runner 被中止时返回 aborted:true）
            sess.running = false;
            theatreBroadcaster.broadcastRunState(sessionKey, runResult.runId, runResult.aborted ? 'aborted' : 'completed');

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
            // P2: 异常兜底：清理 running 标记并广播 error 终态
            sess.running = false;
            theatreBroadcaster.broadcastRunState(sessionKey, null, 'error');
            logger.error(`[theatre] Agent run 失败: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /**
     * POST /api/agent-theatre/abort - 停止当前正在执行的 run（P2）。
     *
     * run 执行中（LLM 工具循环）调用 agentService.abortRun(runId) 触发 AbortController，
     * runner 返回 aborted:true 结果，/input 路由随后广播 run_state=aborted。
     */
    app.post('/api/agent-theatre/abort', async (req, res) => {
        const sessionKey = _theatreSessionKey(req);
        const sess = theatreSessions.get(sessionKey);
        if (!sess || !sess.running) {
            return res.json({ success: false, error: '当前没有正在执行的 run' });
        }
        const agentService = getAgentService();
        if (!agentService || typeof agentService.abortRun !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载或不支持 abort' });
        }
        // 定位当前 run：优先 sess.lastRunId（run 完成后回传）；执行中 runId 尚未回传时，
        // 从 activeRuns 取该会话正在运行的 run（单会话单 run 架构下安全）
        let runId = sess.lastRunId;
        if (!runId) {
            const status = (typeof agentService.getStatus === 'function') ? agentService.getStatus() : null;
            const active = status?.activeAgents || [];
            if (active.length > 0) runId = active[active.length - 1].runId;
        }
        if (!runId) {
            return res.json({ success: false, error: '当前没有正在执行的 run' });
        }
        const ok = agentService.abortRun(runId);
        if (!ok) {
            return res.json({ success: false, error: 'run 不存在或已结束' });
        }
        theatreBroadcaster.broadcastRunState(sessionKey, runId, 'aborting');
        res.json({ success: true, runId, state: 'aborting' });
    });

    /** POST /api/agent-theatre/validate-run - 保存 Profile 并验证可运行性 */
    app.post('/api/agent-theatre/validate-run', async (req, res) => {
        const body = req.body || {};
        const { name, yaml, probeInput } = body;

        if (!name || !yaml) {
            return res.status(400).json({ success: false, error: '需要 name 和 yaml' });
        }

        const af = getReadyAgentFramework();
        if (!af) {
            return res.status(503).json({ success: false, error: 'Agent框架未启用' });
        }
        const agentService = getAgentService();
        if (!agentService || typeof agentService.run !== 'function') {
            return res.status(503).json({ success: false, error: 'agent-framework 插件未加载' });
        }
        if (!getLlmService()) {
            return res.status(503).json({ success: false, error: 'runtime.llm 未配置' });
        }

        try {
            // 步骤 1：保存（解析校验 + 热重载）
            const def = af.agentLoader.save(name, yaml);

            // 步骤 2：用探测输入跑一次
            const input = probeInput || '你好';
            const sessionKey = _theatreSessionKey(req);
            const [platform, chatId] = sessionKey.split(':');
            const runResult = await agentService.run(
                name,
                input,
                {
                    platform: platform || 'native',
                    chatId: chatId || 'validate',
                },
                {
                    llm: getLlmService(),
                    history: [],
                },
            );

            const mainText = runResult.result?.getMainText?.() || runResult.text || '';
            res.json({
                success: true,
                saved: true,
                runId: runResult.runId,
                text: mainText,
                result: runResult.result?.toJSON?.() || null,
            });
        } catch (e) {
            logger.error(`[theatre] validate-run 失败: ${e.message}`);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    /** GET /api/agent-theatre/events/:runId - 查询历史事件（调 workspace-manager.getEvents） */
    app.get('/api/agent-theatre/events/:runId', (req, res) => {
        const { runId } = req.params;
        const afterSeq = parseInt(req.query.afterSeq) || 0;
        const limit = parseInt(req.query.limit) || 100;
        const af = getReadyAgentFramework();
        const wm = af?.workspaceManager;
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

    /**
     * GET /api/agent-theatre/assets - 轻量资产列表（角色卡 / 世界书 / 预设）
     *
     * 独立于 NativeRuntime：不要求 runtime.enabled，直接扫描 assets 目录返回名称列表，
     * 供 Agent 前端（角色卡/世界书选择器）在主网关与独立 Agent 服务两种模式下都能用。
     * 目录路径与 NativeRuntime 一致（config.runtime.*Dir，默认 assets/...）。
     */
    app.get('/api/agent-theatre/assets', (req, res) => {
        const runtimeCfg = configManager.get('runtime') || {};
        const dirs = {
            characters: path.resolve(repoRoot, runtimeCfg.charactersDir || 'assets/characters'),
            worldbooks: path.resolve(repoRoot, runtimeCfg.worldbooksDir || 'assets/worldbooks'),
            presets: path.resolve(repoRoot, runtimeCfg.presetsDir || 'assets/presets'),
        };
        const listJson = (dir) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => path.basename(f, '.json'));
        };
        const listCards = (dir) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir)
                .filter((f) => f.endsWith('.json') || f.endsWith('.png'))
                .map((f) => path.basename(f, path.extname(f)));
        };
        res.json({
            success: true,
            assets: {
                characters: listCards(dirs.characters),
                worldbooks: listJson(dirs.worldbooks),
                presets: listJson(dirs.presets),
            },
            dirs,
        });
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

    // ==================== AI 辅助修改 Profile（自然语言改配置） ====================
    //
    // 让无编程经验的用户用大白话修改 Agent Profile YAML。流程：
    //   1. /plan   调 LLM 生成结构化修改方案（不落盘），前端预览
    //   2. /apply  用户确认后写入，写入前先把当前 YAML 快照入栈（可撤销）
    //   3. /undo   从快照栈弹出最近一份覆盖回去
    //   4. /history 查询可撤销步数
    //
    // 处理逻辑封装在 server/ai-modifier.js，依赖通过工厂注入，便于单元测试。

    const aiModifierStore = createProfileStore({
        getAgentFramework: () => getPluginManager()?.loader?.getPlugin('agent-framework'),
    });
    const aiModifierHandlers = createAiModifierHandlers({
        getLlmService: () => getLlmService(),
        readCurrentYaml: aiModifierStore.readCurrentYaml,
        writeYaml: aiModifierStore.writeYaml,
        history: aiModifyHistory,
        logger,
    });

    /** POST /api/agent-theatre/ai-modify/plan - 生成修改方案（不实际应用） */
    app.post('/api/agent-theatre/ai-modify/plan', aiModifierHandlers.plan);

    /** POST /api/agent-theatre/ai-modify/apply - 应用修改（先快照当前 YAML） */
    app.post('/api/agent-theatre/ai-modify/apply', aiModifierHandlers.apply);

    /** POST /api/agent-theatre/ai-modify/undo - 撤销上次修改 */
    app.post('/api/agent-theatre/ai-modify/undo', aiModifierHandlers.undo);

    /** GET /api/agent-theatre/ai-modify/history - 查询撤销历史计数 */
    app.get('/api/agent-theatre/ai-modify/history', aiModifierHandlers.history);

    // ==================== Agent 前端 URL 校验 API ====================
    //
    // 供独立 Agent 前端页面（public/agent.html）"验证"按钮调用。
    // 注册在 /api/* 全局鉴权中间件之后，自动受 X-Gateway-Token 保护。
    // 逻辑抽在 server/agent-frontend.js（纯函数 + 可注入 fetch），
    // 见 test/agent-frontend.test.js。
    app.post('/api/agent-frontend/validate', createAgentFrontendValidateHandler({}));

    // ==================== Agent 前端静态页面（公开，无需鉴权） ====================
    //
    // public/agent.{html,css,js} 是独立 Agent 前端（Agent 设置 + Agent 剧场），
    // 通过 /agent 访问。页面本身不需要鉴权（公开静态页，不含敏感数据）；
    // 页面内所有 API 请求由前端自行携带 X-Gateway-Token。
    app.use(express.static(staticDir));
    app.get('/agent', (req, res) => {
        const file = path.join(staticDir, 'agent.html');
        if (!fs.existsSync(file)) {
            return res.status(404).send('agent.html not found');
        }
        res.sendFile(file);
    });

    logger.info('Agent API 已注册（agents / agent-theatre / agent-frontend / /agent 静态页）');
}

export default { registerAgentApi };
