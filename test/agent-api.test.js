/**
 * Agent 独立 API 路由测试（registerAgentApi）
 *
 * 用 express + 注入 mock deps（mock pluginManager 的 getPlugin 返回假
 * agent-framework 实例、mock llmService）调用 registerAgentApi，验证路由注册
 * 与关键行为。参考 test/agent-frontend.test.js 的模式。
 *
 * 覆盖：
 *   - GET /api/agents 返回列表 / 框架未启用时返回可读错误
 *   - GET /api/agents/tools 返回工具列表
 *   - GET /api/agents/:name 命中返回定义、未命中返回 404
 *   - GET /api/agent-theatre/state 无会话时返回 inactive
 *   - POST /api/agent-theatre/input 正常 run 流程 / agent 服务缺失时返回 503
 *   - POST /api/agent-frontend/validate 空 body 返回 ok:false
 *   - GET /agent 静态页返回 200（staticDir 指向真实 public 目录）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerAgentApi } from '../server/agent-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

/** 构造注入依赖：返回一个可用的 agent-framework mock 插件实例 */
function makeDeps(overrides = {}) {
    const fakeAgentFramework = {
        _loaded: true,
        agentLoader: {
            list: () => [{ name: 'default-rp', displayName: '默认方案', tools: [] }],
            get: (name) => (name === 'default-rp' ? { name: 'default-rp', displayName: '默认方案' } : null),
            save: (name, yaml) => ({ name, displayName: name, savedYaml: yaml }),
            delete: () => {},
            agentsDir: path.join(REPO_ROOT, 'data', 'plugins', 'agent-framework', 'agents'),
        },
        toolRegistry: {
            list: () => [{ name: 'state.read', description: '读取状态' }],
        },
        agentRunner: {
            getLogs: () => [{ ts: Date.now(), level: 'info', message: 'test log' }],
        },
        workspaceManager: {
            getEvents: () => [],
        },
        _agentService: {
            run: async () => ({ runId: 'run-1', aborted: false, text: 'ok', result: null }),
            abortRun: () => true,
            getStatus: () => ({ activeAgents: [] }),
        },
    };

    const pluginManager = {
        loader: {
            getPlugin: (name) => (name === 'agent-framework' ? fakeAgentFramework : null),
        },
    };

    return {
        getPluginManager: () => pluginManager,
        getLlmService: () => ({ chat: async () => '{}' }),
        theatreBroadcaster: {
            addClient: () => {},
            broadcastRunState: () => {},
            broadcastResult: () => {},
            broadcastState: () => {},
            shutdown: () => {},
        },
        configManager: { get: () => ({}) },
        logger: console,
        repoRoot: REPO_ROOT,
        staticDir: path.join(REPO_ROOT, 'public'),
        ...overrides,
    };
}

/** 启动一个临时 HTTP 服务，跑完自动关闭；回调收到 base URL */
async function withServer(deps, fn) {
    const app = express();
    app.use(express.json());
    registerAgentApi(app, deps);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
        await fn(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('registerAgentApi - Agent 框架 API', () => {
    test('GET /api/agents 返回 agent 列表', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agents`);
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.ok(Array.isArray(body.agents));
            assert.strictEqual(body.agents.length, 1);
            assert.strictEqual(body.agents[0].name, 'default-rp');
        });
    });

    test('GET /api/agents 在框架未启用时返回空列表 + 可读错误', async () => {
        // 插件存在但 _loaded=false（等价于插件被禁用）
        const deps = makeDeps({
            getPluginManager: () => ({
                loader: {
                    getPlugin: () => ({ _loaded: false, agentLoader: undefined }),
                },
            }),
        });
        await withServer(deps, async (base) => {
            const resp = await fetch(`${base}/api/agents`);
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.deepStrictEqual(body.agents, []);
            assert.match(body.error, /未启用/);
        });
    });

    test('GET /api/agents/tools 返回工具列表', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agents/tools`);
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.ok(Array.isArray(body.tools));
            assert.strictEqual(body.tools.length, 1);
            assert.strictEqual(body.tools[0].name, 'state.read');
        });
    });

    test('GET /api/agents/:name 命中返回定义、未命中返回 404', async () => {
        await withServer(makeDeps(), async (base) => {
            const hit = await fetch(`${base}/api/agents/default-rp`);
            assert.strictEqual(hit.status, 200);
            const def = await hit.json();
            assert.strictEqual(def.name, 'default-rp');

            const miss = await fetch(`${base}/api/agents/not-exist`);
            assert.strictEqual(miss.status, 404);
            const missBody = await miss.json();
            assert.match(missBody.error, /不存在/);
        });
    });
});

describe('registerAgentApi - Agent 剧场 API', () => {
    test('GET /api/agent-theatre/state 无会话时返回 inactive', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/state`);
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.active, false);
            assert.strictEqual(body.session, 'native:default');
        });
    });

    test('POST /api/agent-theatre/input 正常触发 run 并返回 runId', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '你好' }),
            });
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.runId, 'run-1');
            assert.strictEqual(body.text, 'ok');
        });
    });

    test('POST /api/agent-theatre/input 在 agent 服务缺失时返回 503', async () => {
        // pluginManager 无 agent-framework 插件
        const deps = makeDeps({
            getPluginManager: () => ({ loader: { getPlugin: () => null } }),
        });
        await withServer(deps, async (base) => {
            const resp = await fetch(`${base}/api/agent-theatre/input`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: '你好' }),
            });
            assert.strictEqual(resp.status, 503);
            const body = await resp.json();
            assert.strictEqual(body.success, false);
            assert.match(body.error, /未加载/);
        });
    });
});

describe('registerAgentApi - 前端校验与静态页', () => {
    test('POST /api/agent-frontend/validate 空 body 返回 ok:false', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/api/agent-frontend/validate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            assert.strictEqual(resp.status, 200);
            const body = await resp.json();
            assert.strictEqual(body.ok, false);
            assert.match(body.error, /不能为空/);
        });
    });

    test('GET /agent 返回 200 与 agent.html 页面（staticDir 指向真实 public 目录）', async () => {
        await withServer(makeDeps(), async (base) => {
            const resp = await fetch(`${base}/agent`);
            assert.strictEqual(resp.status, 200);
            const contentType = resp.headers.get('content-type') || '';
            assert.match(contentType, /text\/html/);
            const html = await resp.text();
            assert.ok(html.length > 0, 'agent.html 内容不应为空');
            assert.match(html, /<!DOCTYPE html>/i);
        });
    });

    test('GET /agent 在 staticDir 下无 agent.html 时返回 404', async () => {
        // 指向一个不含 agent.html 的目录
        const deps = makeDeps({ staticDir: path.join(REPO_ROOT, 'server') });
        await withServer(deps, async (base) => {
            const resp = await fetch(`${base}/agent`);
            assert.strictEqual(resp.status, 404);
        });
    });
});
