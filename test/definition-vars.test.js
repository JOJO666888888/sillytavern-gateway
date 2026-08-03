/**
 * Meta.style 语义统一测试（任务 3）
 *
 * 统一语义：meta.style = session.style > context.injectAssets 变量名 > 顶层 definition.style
 * 守护：
 *   - extractDefinitionVar 提取逻辑
 *   - AgentRunner 构造的 meta.style 优先级（经最小冒烟 run）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractDefinitionVar } from '../server/agent/context-builder.js';
import { AgentRunner } from '../plugins/agent-framework/engine/agent-runner.js';
import { silentLogger } from './helpers.js';

describe('extractDefinitionVar', () => {
    test('${style} 占位符返回变量名本身', () => {
        const def = { context: { injectAssets: { style: '${style}' } } };
        assert.strictEqual(extractDefinitionVar(def, 'style'), 'style');
    });

    test('普通字符串值原样返回', () => {
        const def = { context: { injectAssets: { style: '文风A' } } };
        assert.strictEqual(extractDefinitionVar(def, 'style'), '文风A');
    });

    test('未声明或空值返回空串', () => {
        assert.strictEqual(extractDefinitionVar({ context: { injectAssets: {} } }, 'style'), '');
        assert.strictEqual(extractDefinitionVar({}, 'style'), '');
        assert.strictEqual(extractDefinitionVar(null, 'style'), '');
    });

    test('支持其它变量（character/worldbook）', () => {
        const def = { context: { injectAssets: { character: '${character}' } } };
        assert.strictEqual(extractDefinitionVar(def, 'character'), 'character');
    });
});

describe('AgentRunner meta.style 优先级', () => {
    /** 最小 runner：ctx.llm 直接返回最终文本，不触发工具/子代理 */
    function buildRunner() {
        const toolRegistry = {
            getDeclarations: () => [],
            createExecutor: () => async () => '',
        };
        const runner = new AgentRunner({
            toolRegistry,
            subagentDispatcher: { dispatch: async () => ({}), dispatchParallel: async () => [] },
            stateManager: { flush: () => {} },
            memoryEngine: {},
            contextBuilder: { build: () => [{ role: 'user', content: 'x' }] },
            workspaceManager: null,
            logger: silentLogger,
        });
        return runner;
    }

    async function runOnce(def, session) {
        const runner = buildRunner();
        const ctx = {
            llm: { runTools: async () => ({ text: '正文', steps: 0 }) },
            platform: 'test',
            chatId: 'c1',
        };
        const out = await runner.run(def, session, [], 'hi', ctx);
        return out.result.meta;
    }

    test('session.style 优先于顶层 definition.style', async () => {
        const meta = await runOnce({ name: 'a', style: '顶层文风' }, { style: '会话文风' });
        assert.strictEqual(meta.style, '会话文风');
    });

    test('无 session.style 时回退到 injectAssets 变量名', async () => {
        const def = { name: 'a', context: { injectAssets: { style: '${style}' } } };
        const meta = await runOnce(def, {});
        assert.strictEqual(meta.style, 'style');
    });

    test('session.style 优先于 injectAssets 变量名', async () => {
        const def = { name: 'a', context: { injectAssets: { style: '${style}' } } };
        const meta = await runOnce(def, { style: '会话文风' });
        assert.strictEqual(meta.style, '会话文风');
    });

    test('仅顶层 definition.style 时（deprecated 兼容）仍生效', async () => {
        const meta = await runOnce({ name: 'a', style: '顶层文风' }, {});
        assert.strictEqual(meta.style, '顶层文风');
    });

    test('全部缺省时为空串', async () => {
        const meta = await runOnce({ name: 'a' }, {});
        assert.strictEqual(meta.style, '');
    });
});
