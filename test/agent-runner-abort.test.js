/**
 * AgentRunner abort 能力测试（P2 停止生成）
 *
 * 守护：run 执行中可调用 runner.abort(runId) 触发 AbortController，
 * LLM 工具循环在 step 边界检查 signal.aborted 后抛错中断，
 * run 返回 aborted:true 的结果（而非抛错），activeRuns 最终清空。
 *
 * 直接 mock llm（不经过 llm-client）：llm 需要自行检查 options.signal.aborted，
 * 模拟真实 llm-client 在 step 边界的 abort 行为。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { AgentRunner } from '../plugins/agent-framework/engine/agent-runner.js';

const DEFINITION = {
    name: 'test-agent',
    displayName: '测试 Agent',
    description: 'abort 测试',
    tools: [],
    maxSteps: 10,
    model: { temperature: 0.8, maxTokens: 4096 },
};

function makeRunner(llm) {
    return new AgentRunner({
        contextBuilder: {
            build: () => [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
        },
        toolRegistry: {
            getDeclarations: () => [],
            createExecutor: () => async () => 'ok',
        },
        stateManager: { flush: () => {} },
        logger: { info: () => {}, error: () => {}, warn: () => {} },
    });
}

/** 模拟 llm-client 的 runToolsStream：延迟后检查 signal.aborted（模拟 step 边界检查） */
function slowLlm(delayMs = 50) {
    return {
        runToolsStream: async (messages, tools, executor, options) => {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            if (options.signal?.aborted) throw new Error('aborted');
            return { text: '正常结果', steps: 1 };
        },
    };
}

describe('AgentRunner - abort（P2 停止生成）', () => {
    test('run 中 abort 返回 aborted:true 且 activeRuns 清空', async () => {
        const llm = slowLlm();
        const runner = makeRunner(llm);
        const p = runner.run(DEFINITION, {}, [], '你好', { llm });

        // 等 run 启动并注册到 activeRuns
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.strictEqual(runner.activeRuns.size, 1);
        const runId = Array.from(runner.activeRuns.keys())[0];

        const ok = runner.abort(runId);
        assert.strictEqual(ok, true);

        const result = await p;
        assert.strictEqual(result.aborted, true);
        assert.strictEqual(result.runId, runId);
        assert.strictEqual(runner.activeRuns.size, 0);
    });

    test('abort 后结果文本为"已停止生成"而非报错', async () => {
        const llm = slowLlm(40);
        const runner = makeRunner(llm);
        const p = runner.run(DEFINITION, {}, [], '你好', { llm });
        await new Promise(resolve => setTimeout(resolve, 10));
        const runId = Array.from(runner.activeRuns.keys())[0];
        runner.abort(runId);

        const result = await p;
        assert.strictEqual(result.aborted, true);
        assert.match(result.text, /已停止生成/);
        // 中止不算执行错误：error 字段保留原始中止消息，但 text 是停止提示
        assert.ok(result.error);
    });

    test('abort 不存在的 run 返回 false', () => {
        const runner = makeRunner({ runToolsStream: async () => ({ text: 'x', steps: 0 }) });
        assert.strictEqual(runner.abort('not-exist'), false);
    });

    test('run 正常完成后 abort 返回 false（activeRuns 已清空）', async () => {
        const llm = {
            runToolsStream: async () => ({ text: '正常结果', steps: 1 }),
        };
        const runner = makeRunner(llm);
        const result = await runner.run(DEFINITION, {}, [], '你好', { llm });
        assert.strictEqual(result.aborted, undefined);
        assert.strictEqual(result.text, '正常结果');
        assert.strictEqual(runner.activeRuns.size, 0);
        assert.strictEqual(runner.abort(result.runId), false);
    });

    test('abort 重复调用幂等（第二次仍返回 true 但不重复触发）', async () => {
        const llm = slowLlm(60);
        const runner = makeRunner(llm);
        const p = runner.run(DEFINITION, {}, [], '你好', { llm });
        await new Promise(resolve => setTimeout(resolve, 10));
        const runId = Array.from(runner.activeRuns.keys())[0];

        assert.strictEqual(runner.abort(runId), true);
        assert.strictEqual(runner.abort(runId), true); // 已 abort 的 controller 再次 abort 不抛错

        const result = await p;
        assert.strictEqual(result.aborted, true);
    });

    test('非流式 llm（仅 runTools）同样支持 abort', async () => {
        const llm = {
            runTools: async (messages, tools, executor, options) => {
                await new Promise(resolve => setTimeout(resolve, 50));
                if (options.signal?.aborted) throw new Error('aborted');
                return { text: '正常结果', steps: 1 };
            },
        };
        const runner = makeRunner(llm);
        const p = runner.run(DEFINITION, {}, [], '你好', { llm });
        await new Promise(resolve => setTimeout(resolve, 10));
        const runId = Array.from(runner.activeRuns.keys())[0];
        runner.abort(runId);

        const result = await p;
        assert.strictEqual(result.aborted, true);
        assert.match(result.text, /已停止生成/);
    });
});
