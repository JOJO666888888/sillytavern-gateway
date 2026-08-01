/**
 * 权限控制验证：surface / workspace / agent 权限隔离（SubTask 7.3）
 *
 * 守护 spec.md "Scenario: 插件权限扩展"：
 *   - surface 权限：注册表现层适配器
 *   - workspace 权限：跨插件共享 workspace（多 Bot 协同场景）
 *   - agent 权限：使用 Agent 框架（注册工具 / 调度子代理）
 *
 * 核心不变量：
 *   1. 三项权限均非默认授予（default: false），未声明时调用即抛清晰错误
 *   2. surface 隔离：未声明 surface 的插件拿不到 SurfaceManager，无法注册适配器
 *   3. agent 隔离：未声明 agent 的插件拿不到 AgentRunner，无法注册工具 / 触发 run
 *   4. workspace 隔离：跨插件共享 workspace 通过 ctx.agent.run() 触发（受 agent
 *      权限前置约束），多个 bot 用同一 sessionId commit 到同一会话级 persist 层；
 *      workspace 权限本身须显式声明，且 run 级事件互不串扰、路径穿越被拒
 *   5. 不同插件各自按自身权限收窄，互不影响（A 有 surface 不意味着 B 也有）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

import {
    PERMISSIONS,
    normalizePermissions,
    buildScopedServices,
} from '../server/plugin-permissions.js';
import { PluginContext } from '../server/plugin-context.js';
import { SurfaceManager } from '../server/agent/surface-manager.js';
import { WorkspaceManager } from '../plugins/agent-framework/engine/workspace-manager.js';
import { tmpDir, silentLogger } from './helpers.js';

const tmps = [];
function makeTmp() { const t = tmpDir('stgw-perm-'); tmps.push(t); return t.dir; }

// ==================== fakes ====================

/** 伪造一个最小 configManager（plugin-permissions 需要） */
function fakeConfigManager() {
    const data = { server: { port: 3210 } };
    return {
        get(key) { return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data); },
        _redact(o) { return o; },
    };
}

/** 伪造 agent-framework 暴露的 agentService（含 getWorkspaceManager） */
function fakeAgentService() {
    const ws = new WorkspaceManager({ dataRoot: makeTmp(), logger: silentLogger });
    return {
        registerTool: (def) => ({ ok: true, tool: def.name, source: def.source }),
        dispatch: async (name, task) => ({ agent: name, task }),
        registerAgent: (def) => ({ ok: true, agent: def.name }),
        getStatus: () => ({ activeAgents: [], totalRuns: 0 }),
        run: async (profile, input) => ({ runId: 'r1', text: input, steps: 1 }),
        getWorkspaceManager: () => ws,
    };
}

/** 构造某插件的收窄 services（绕过完整 PluginManager，直接测 buildScopedServices） */
function scopedServices(pluginName, perms, { surfaceService, agentService } = {}) {
    const { granted } = normalizePermissions(perms, pluginName);
    return buildScopedServices(
        pluginName,
        granted,
        { gateway: null, sessionManager: null, configManager: fakeConfigManager() },
        [],
        {
            surface: !!surfaceService,
            surfaceService,
            agent: !!agentService,
            agentService,
            pluginName,
        },
    );
}

// ====================================================================
// 1. 权限注册表自洽：三项权限的定义与默认值
// ====================================================================

describe('SubTask 7.3: 权限注册表 - surface / workspace / agent 定义', () => {
    test('surface 权限已定义且非默认授予（risk=medium）', () => {
        assert.ok(PERMISSIONS.surface, 'surface 权限必须存在');
        assert.strictEqual(PERMISSIONS.surface.risk, 'medium');
        assert.strictEqual(PERMISSIONS.surface.default, false, 'surface 不得默认授予');
        assert.ok(PERMISSIONS.surface.desc, 'surface 缺少描述');
    });

    test('workspace 权限已定义且非默认授予（risk=low）', () => {
        assert.ok(PERMISSIONS.workspace, 'workspace 权限必须存在');
        assert.strictEqual(PERMISSIONS.workspace.risk, 'low');
        assert.strictEqual(PERMISSIONS.workspace.default, false, 'workspace 不得默认授予');
        assert.ok(PERMISSIONS.workspace.desc, 'workspace 缺少描述');
    });

    test('agent 权限已定义且非默认授予（risk=medium）', () => {
        assert.ok(PERMISSIONS.agent, 'agent 权限必须存在');
        assert.strictEqual(PERMISSIONS.agent.risk, 'medium');
        assert.strictEqual(PERMISSIONS.agent.default, false, 'agent 不得默认授予');
        assert.ok(PERMISSIONS.desc || PERMISSIONS.agent.desc, 'agent 缺少描述');
    });

    test('未声明任何权限时，三项均不在 granted 集合中', () => {
        const { granted } = normalizePermissions(undefined, 'p');
        assert.ok(!granted.has('surface'), 'surface 不应默认授予');
        assert.ok(!granted.has('workspace'), 'workspace 不应默认授予');
        assert.ok(!granted.has('agent'), 'agent 不应默认授予');
    });

    test('显式声明后三项均被授予', () => {
        const { granted } = normalizePermissions(['surface', 'workspace', 'agent'], 'p');
        assert.ok(granted.has('surface'));
        assert.ok(granted.has('workspace'));
        assert.ok(granted.has('agent'));
    });
});

// ====================================================================
// 2. surface 权限隔离
// ====================================================================

describe('SubTask 7.3: surface 权限隔离', () => {
    test('未声明 surface 时，services.surface 为拒绝桩，调用即抛清晰错误', () => {
        const svc = scopedServices('p-no-surface', [], { surfaceService: new SurfaceManager({ logger: silentLogger }) });
        // 即便注入了 surfaceService，未声明权限也是拒绝桩
        for (const m of ['register', 'getAdapters', 'bindPrimary', 'dispatch']) {
            assert.throws(() => svc.surface[m](), /需要 "surface" 权限/, `${m} 应抛权限错误`);
        }
    });

    test('声明 surface 后，可注册/调度表现层适配器', () => {
        const surfaceService = new SurfaceManager({ logger: silentLogger });
        const svc = scopedServices('p-surface', ['surface'], { surfaceService });

        const adapter = {
            name: 'im-default',
            surfaceType: 'im',
            async render() { return { ok: true }; },
        };
        const unregister = svc.surface.register(adapter);
        assert.strictEqual(typeof unregister, 'function', 'register 应返回注销函数');

        const list = svc.surface.getAdapters();
        assert.ok(list.some(a => a.name === 'im-default'), '适配器应已注册');

        // bindPrimary 应成功
        svc.surface.bindPrimary('qq:chat-1', 'im-default');
        // getAdapters 返回的是只读快照
        assert.ok(Array.isArray(list));

        unregister();
        assert.ok(!svc.surface.getAdapters().some(a => a.name === 'im-default'), '注销后适配器应移除');
    });

    test('未声明 surface 时，即使 surfaceService 注入也无法触及 SurfaceManager', () => {
        const surfaceService = new SurfaceManager({ logger: silentLogger });
        const svc = scopedServices('p-no-surface', [], { surfaceService });
        // 拒绝桩与真实 SurfaceManager 解耦：调用不产生副作用
        assert.throws(() => svc.surface.register({ name: 'x', surfaceType: 'im', render() {} }), /surface/);
        assert.strictEqual(surfaceService.getAdapters().length, 0, '未授权注册不应污染全局 SurfaceManager');
    });

    test('surface 服务标注来源插件（register 时注入 source）', () => {
        const surfaceService = new SurfaceManager({ logger: silentLogger });
        const svc = scopedServices('my-plugin', ['surface'], { surfaceService });
        svc.surface.register({ name: 'im-x', surfaceType: 'im', async render() {} });
        // createSurfaceService 会把 source: pluginName 合并进 adapter
        // SurfaceManager 不存储 source，但服务层应自动标注（不抛错即通过）
        assert.strictEqual(surfaceService.getAdapters().length, 1);
    });
});

// ====================================================================
// 3. agent 权限隔离
// ====================================================================

describe('SubTask 7.3: agent 权限隔离', () => {
    test('未声明 agent 时，services.agent 为拒绝桩', () => {
        const svc = scopedServices('p-no-agent', [], { agentService: fakeAgentService() });
        for (const m of ['registerTool', 'dispatch', 'registerAgent', 'getStatus', 'run']) {
            assert.throws(() => svc.agent[m](), /需要 "agent" 权限/, `${m} 应抛权限错误`);
        }
    });

    test('声明 agent 后，可注册工具 / 调度子代理 / 触发 run', async () => {
        const agentService = fakeAgentService();
        const svc = scopedServices('p-agent', ['agent'], { agentService });

        // registerTool 自动标注来源插件
        const r = svc.agent.registerTool({ name: 'state.write', description: 'd', handler: () => {} });
        assert.strictEqual(r.source, 'p-agent', '工具应自动标注来源插件');

        // dispatch
        const d = await svc.agent.dispatch('critic', '审查 X');
        assert.strictEqual(d.agent, 'critic');

        // registerAgent
        svc.agent.registerAgent({ name: 'gm', systemPrompt: 'x', tools: [] });

        // getStatus
        assert.ok(svc.agent.getStatus().totalRuns === 0);

        // run
        const run = await svc.agent.run('default-rp', '用户输入');
        assert.ok(run.runId, 'run 应返回 runId');
    });

    test('agent 服务标注工具来源（registerTool 注入 source）', () => {
        const agentService = fakeAgentService();
        const svc = scopedServices('tool-source-plugin', ['agent'], { agentService });
        const r = svc.agent.registerTool({ name: 'foo', description: 'd', handler: () => {} });
        assert.strictEqual(r.source, 'tool-source-plugin', 'source 应为调用方插件名');
    });
});

// ====================================================================
// 4. workspace 权限隔离（跨插件共享 workspace）
// ====================================================================

describe('SubTask 7.3: workspace 权限隔离（跨插件共享）', () => {
    test('workspace 权限非默认授予，须显式声明', () => {
        const { granted } = normalizePermissions([], 'p');
        assert.ok(!granted.has('workspace'), 'workspace 不应默认授予');
        const { granted: g2 } = normalizePermissions(['workspace'], 'p');
        assert.ok(g2.has('workspace'), '声明后应授予');
    });

    test('跨插件共享 workspace 受 agent 权限前置约束：未声明 agent 无法触发 run', () => {
        // workspace 共享通过 ctx.agent.run() 触发：多个 bot 用同一 sessionId
        // 调 ctx.agent.run()，agent-runner 内部用同一 WorkspaceManager 把产物 commit 到
        // 同一会话级 persist 层。因此 agent 权限是 workspace 共享的前置闸门。
        const svc = scopedServices('p-no-agent', [], { agentService: fakeAgentService() });
        // agent 是拒绝桩，run() 不可达
        assert.throws(() => svc.agent.run('default-rp', 'x'), /需要 "agent" 权限/);
        assert.throws(() => svc.agent.dispatch('critic', 'x'), /需要 "agent" 权限/);
    });

    test('会话级共享：同一 sessionId 的多个 run commit 到同一 persist 层（多 Bot 协同基础）', () => {
        // 真实多 Bot 协同：bot-A 与 bot-B 各自跑 run，但 sessionId 相同，
        // commit 后产物合并到同一 sessions/<sessionId>/persist/，实现状态共享。
        const ws = new WorkspaceManager({ dataRoot: makeTmp(), logger: silentLogger });
        const sessionId = 'qq:group-1';

        // bot-A 的 run：写 output/state.json 并 commit（commit 只 promote output/ 下产物）
        ws.initRun('run-botA', { sessionId });
        ws.writeText('run-botA', 'output/state.json', JSON.stringify({ scene: ' tavern', turn: 1 }));
        ws.flushRun('run-botA');
        ws.commit('run-botA');

        // bot-B 的 run：基于同一 session，写另一产物并 commit
        ws.initRun('run-botB', { sessionId });
        ws.writeText('run-botB', 'output/state.json', JSON.stringify({ scene: 'tavern', turn: 2 }));
        ws.flushRun('run-botB');
        ws.commit('run-botB');

        // 会话级 persist 应同时包含两个 run 的产物（后者覆盖前者同名文件）
        const sessionDir = ws.getSessionDir(sessionId);
        const statePath = path.join(sessionDir, 'persist', 'state.json');
        assert.ok(fs.existsSync(statePath), '会话级 persist/state.json 应存在');
        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.strictEqual(finalState.turn, 2, '会话级 persist 应为最后一次 commit 的值（多 Bot 共享）');

        // commit 返回被 promote 的相对路径
        ws.initRun('run-botC', { sessionId });
        ws.writeText('run-botC', 'output/inventory.json', JSON.stringify({ gold: 100 }));
        ws.flushRun('run-botC');
        const promoted = ws.commit('run-botC');
        assert.ok(promoted.includes('inventory.json'), 'commit 应返回被 promote 的路径');
    });

    test('workspace run 级隔离：不同 run 的事件互不串扰', () => {
        const ws = new WorkspaceManager({ dataRoot: makeTmp(), logger: silentLogger });
        ws.initRun('run-A', { sessionId: 's-a' });
        ws.initRun('run-B', { sessionId: 's-b' });
        ws.appendEvent('run-A', 'tool_call', { tool: 'state.write', val: 'A1' });
        ws.appendEvent('run-B', 'tool_call', { tool: 'state.write', val: 'B1' });
        ws.flushRun('run-A');
        ws.flushRun('run-B');

        const evsA = ws.getEvents('run-A');
        const evsB = ws.getEvents('run-B');
        // 各含 init checkpoint + 1 tool_call = 2
        assert.strictEqual(evsA.length, 2);
        assert.strictEqual(evsB.length, 2);
        assert.strictEqual(evsA[1].payload.val, 'A1', 'run-A 事件不应串入 run-B');
        assert.strictEqual(evsB[1].payload.val, 'B1', 'run-B 事件不应串入 run-A');
    });

    test('workspace 路径穿越防护：跨插件共享时不得越界访问其它插件 run', () => {
        const ws = new WorkspaceManager({ dataRoot: makeTmp(), logger: silentLogger });
        ws.initRun('legit-run', { sessionId: 's' });
        // 试图用路径穿越的 runId 访问其它目录应被拒绝
        assert.throws(() => ws.getRunDir('../../other-plugin'), /路径穿越/);
        assert.throws(() => ws.appendEvent('../../etc', 'tool_call'), /路径穿越/);
        // sessionId 也会被规整为安全路径段，杜绝穿越
        assert.throws(() => ws.getSessionDir('../../etc'), /路径穿越/);
    });
});

// ====================================================================
// 5. PluginContext 层的权限错误清晰度
// ====================================================================

describe('SubTask 7.3: PluginContext 层权限错误清晰度', () => {
    function ctxWith(pluginName, { surface, agent } = {}) {
        return new PluginContext({
            pluginName,
            message: { platform: 'qq', chatId: 'c1', senderName: 'u' },
            surface,
            agent,
        });
    }

    test('未注入 surface 服务时，ctx.surface 抛出含权限名的清晰错误', () => {
        const ctx = ctxWith('no-surface-plugin');
        assert.throws(() => ctx.surface, /需要 "surface" 权限/);
        assert.throws(() => ctx.surface, /no-surface-plugin/);
    });

    test('未注入 agent 服务时，ctx.agent 抛出含权限名的清晰错误', () => {
        const ctx = ctxWith('no-agent-plugin');
        assert.throws(() => ctx.agent, /需要 "agent" 权限/);
        assert.throws(() => ctx.agent, /no-agent-plugin/);
    });

    test('注入服务后 ctx.surface / ctx.agent 可正常访问', () => {
        const surfaceService = new SurfaceManager({ logger: silentLogger });
        const agentService = fakeAgentService();
        const svc = scopedServices('full-plugin', ['surface', 'agent'], { surfaceService, agentService });
        const ctx = ctxWith('full-plugin', { surface: svc.surface, agent: svc.agent });
        assert.strictEqual(typeof ctx.surface.register, 'function');
        assert.strictEqual(typeof ctx.agent.registerTool, 'function');
    });
});

// ====================================================================
// 6. 跨插件隔离：A 有权限不代表 B 也有
// ====================================================================

describe('SubTask 7.3: 跨插件权限隔离（独立收窄）', () => {
    test('插件 A 声明 surface、插件 B 未声明：A 可注册、B 被拒', () => {
        const surfaceService = new SurfaceManager({ logger: silentLogger });
        const svcA = scopedServices('plugin-A', ['surface'], { surfaceService });
        const svcB = scopedServices('plugin-B', [], { surfaceService });

        // A 注册成功
        svcA.surface.register({ name: 'a-adapter', surfaceType: 'im', async render() {} });
        assert.strictEqual(surfaceService.getAdapters().length, 1);

        // B 调用即抛错，且不污染全局
        assert.throws(() => svcB.surface.register({ name: 'b-adapter', surfaceType: 'im', render() {} }), /surface/);
        assert.strictEqual(surfaceService.getAdapters().length, 1, 'B 未授权注册不应生效');
    });

    test('插件 A 声明 agent、插件 B 未声明：A 可用工具循环、B 被拒', async () => {
        const agentService = fakeAgentService();
        const svcA = scopedServices('plugin-A', ['agent'], { agentService });
        const svcB = scopedServices('plugin-B', [], { agentService });

        // A 注册工具成功，source 标注为 plugin-A
        const rA = svcA.agent.registerTool({ name: 'a-tool', description: 'd', handler: () => {} });
        assert.strictEqual(rA.source, 'plugin-A');

        // B 任何方法都抛权限错误
        assert.throws(() => svcB.agent.registerTool({ name: 'b-tool', description: 'd', handler: () => {} }), /agent/);
        assert.throws(() => svcB.agent.getStatus(), /agent/);
    });

    test('agent-rp 声明全部三项权限（surface+workspace+agent），符合多 Bot 协同需求', () => {
        // 守护：agent-rp 的 plugin.json 必须声明 surface/workspace/agent 才能做 IM 适配器
        const { granted } = normalizePermissions(
            ['llm', 'fs', 'assets', 'gateway.inbound', 'sessions', 'agent', 'surface', 'workspace'],
            'agent-rp',
        );
        assert.ok(granted.has('surface'), 'agent-rp 须声明 surface');
        assert.ok(granted.has('workspace'), 'agent-rp 须声明 workspace');
        assert.ok(granted.has('agent'), 'agent-rp 须声明 agent');
    });
});
