/**
 * 自建推理管线 - LLM 客户端回归测试（P2-5/7/8）
 * 三 provider 请求构造、多模态 content、SSE 流式解析
 *
 * 全部使用本地 HTTP 服务器，不依赖外部网络与真实 API key。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { LLMClient, buildRequest, extractText, extractDelta, buildMultimodalContent, describeEmptyCompletion, buildToolsSpec, extractToolCalls, buildListModelsRequest, extractModelIds } from '../server/runtime/llm-client.js';

/** 起一个返回固定 SSE 流的本地服务器 */
function sseServer(chunks, { splitAt } = {}) {
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let payload = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        if (splitAt) {
            // 故意在中间切断，模拟跨 TCP 分片
            res.write(payload.slice(0, splitAt));
            setTimeout(() => { res.write(payload.slice(splitAt)); res.end(); }, 20);
        } else {
            res.write(payload);
            res.end();
        }
    });
    return new Promise(resolve => srv.listen(0, () => resolve({ srv, port: srv.address().port })));
}

describe('请求构造（三 provider）', () => {
    const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];

    test('OpenAI 兼容：messages 直传，含采样参数', () => {
        const r = buildRequest({ provider: 'openai', model: 'gpt-x', apiKey: 'k' }, msgs, { temperature: 0.5 });
        assert.strictEqual(r.body.model, 'gpt-x');
        assert.strictEqual(r.body.messages.length, 2);
        assert.strictEqual(r.body.temperature, 0.5);
        assert.match(r.headers.Authorization, /^Bearer k$/);
    });

    test('Claude：system 抽出为独立字段', () => {
        const r = buildRequest({ provider: 'claude', model: 'claude-x', apiKey: 'k' }, msgs, {});
        assert.ok(r.body.system, 'system 应单独成字段');
        assert.strictEqual(r.body.messages.length, 1, 'messages 中不应再含 system');
        assert.strictEqual(r.body.messages[0].role, 'user');
        assert.ok(r.headers['x-api-key'], 'Claude 用 x-api-key 头');
    });

    test('Gemini：role 映射 model，system 走 systemInstruction', () => {
        const r = buildRequest({ provider: 'gemini', model: 'gemini-x', apiKey: 'k' },
            [{ role: 'assistant', content: 'a' }, { role: 'system', content: 's' }], {});
        assert.strictEqual(r.body.contents[0].role, 'model', 'assistant 应映射为 model');
        assert.ok(r.body.systemInstruction);
    });

    test('Gemini 流式使用 alt=sse（与另两家同构）', () => {
        const r = buildRequest({ provider: 'gemini', model: 'g', apiKey: 'k' }, msgs, {}, true);
        assert.match(r.url, /streamGenerateContent/);
        assert.match(r.url, /alt=sse/);
    });

    test('自定义 baseUrl 生效（本地推理后端）', () => {
        const r = buildRequest({ provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama' }, msgs, {});
        assert.match(r.url, /^http:\/\/127\.0\.0\.1:11434\/v1/);
    });
});

describe('模型列表（buildListModelsRequest + extractModelIds）', () => {
    test('OpenAI 兼容：GET /models，Bearer 头', () => {
        const r = buildListModelsRequest({ provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-x' });
        assert.strictEqual(r.url, 'http://127.0.0.1:11434/v1/models');
        assert.strictEqual(r.headers.Authorization, 'Bearer sk-x');
    });

    test('OpenAI 默认 baseUrl 指向官方', () => {
        const r = buildListModelsRequest({ provider: 'openai', apiKey: 'k' });
        assert.strictEqual(r.url, 'https://api.openai.com/v1/models');
    });

    test('Claude：GET /v1/models，x-api-key + anthropic-version 头', () => {
        const r = buildListModelsRequest({ provider: 'claude', apiKey: 'k' });
        assert.match(r.url, /\/v1\/models/);
        assert.strictEqual(r.headers['x-api-key'], 'k');
        assert.strictEqual(r.headers['anthropic-version'], '2023-06-01');
    });

    test('Gemini：key 走 query 参数，不带 Authorization', () => {
        const r = buildListModelsRequest({ provider: 'gemini', apiKey: 'my key&' });
        assert.match(r.url, /\/v1beta\/models\?key=/);
        assert.ok(r.url.includes('my%20key%26'), 'key 应被 URL 编码');
        assert.strictEqual(r.headers.Authorization, undefined);
    });

    test('extractModelIds：openai/claude 取 data[].id', () => {
        assert.deepStrictEqual(
            extractModelIds('openai', { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
            ['gpt-4o', 'gpt-4o-mini'],
        );
        assert.deepStrictEqual(
            extractModelIds('claude', { data: [{ id: 'claude-sonnet-4-5' }] }),
            ['claude-sonnet-4-5'],
        );
    });

    test('extractModelIds：gemini 去掉 models/ 前缀', () => {
        assert.deepStrictEqual(
            extractModelIds('gemini', { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-pro' }] }),
            ['gemini-2.0-flash', 'gemini-pro'],
        );
    });

    test('extractModelIds：空/异常响应返回空数组', () => {
        assert.deepStrictEqual(extractModelIds('openai', {}), []);
        assert.deepStrictEqual(extractModelIds('gemini', { models: [{ name: '' }] }), []);
    });

    test('LLMClient.listModels 走本地服务器并解析（openai 兼容）', async () => {
        const srv = http.createServer((req, res) => {
            assert.match(req.url, /\/models$/);
            assert.strictEqual(req.headers.authorization, 'Bearer test-key');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'qwen-32b' }, { id: 'llama-70b' }] }));
        });
        await new Promise(r => srv.listen(0, r));
        const port = srv.address().port;
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' });
            const models = await client.listModels();
            assert.deepStrictEqual(models, ['qwen-32b', 'llama-70b']);
        } finally {
            srv.close();
        }
    });

    test('LLMClient.listModels 后端报错时抛带状态码', async () => {
        const srv = http.createServer((req, res) => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        });
        await new Promise(r => srv.listen(0, r));
        const port = srv.address().port;
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'bad' });
            await assert.rejects(() => client.listModels(), /HTTP 401/);
        } finally {
            srv.close();
        }
    });
});

describe('多模态 content 转换', () => {
    const parts = [{ type: 'text', text: '看图' }, { type: 'image', url: 'http://x/a.png' }];

    test('OpenAI → image_url', () => {
        const c = buildMultimodalContent('openai', parts);
        assert.strictEqual(c[1].type, 'image_url');
        assert.strictEqual(c[1].image_url.url, 'http://x/a.png');
    });

    test('OpenAI base64 → data URI', () => {
        const c = buildMultimodalContent('openai', [{ type: 'image', base64: 'QUJD', mimeType: 'image/png' }]);
        assert.match(c[0].image_url.url, /^data:image\/png;base64,QUJD$/);
    });

    test('Claude → image.source(base64)', () => {
        const c = buildMultimodalContent('claude', [{ type: 'image', base64: 'QUJD', mimeType: 'image/png' }]);
        assert.strictEqual(c[0].source.type, 'base64');
        assert.strictEqual(c[0].source.media_type, 'image/png');
        assert.strictEqual(c[0].source.data, 'QUJD');
    });

    test('Gemini → inline_data', () => {
        const c = buildMultimodalContent('gemini', [{ type: 'image', base64: 'QUJD', mimeType: 'image/png' }]);
        assert.strictEqual(c[0].inline_data.data, 'QUJD');
    });

    test('buildRequest 透传多模态 content', () => {
        const r = buildRequest({ provider: 'openai', model: 'm' },
            [{ role: 'user', content: parts }], {});
        assert.ok(Array.isArray(r.body.messages[0].content));
        assert.strictEqual(r.body.messages[0].content[1].type, 'image_url');
    });

    test('Claude 多模态时 system 仍取纯文本', () => {
        const r = buildRequest({ provider: 'claude', model: 'm' }, [
            { role: 'system', content: [{ type: 'text', text: '系统提示' }] },
            { role: 'user', content: parts },
        ], {});
        assert.strictEqual(typeof r.body.system, 'string');
        assert.match(r.body.system, /系统提示/);
    });
});

describe('响应解析', () => {
    test('OpenAI 非流式', () => {
        assert.strictEqual(extractText('openai', { choices: [{ message: { content: '回复' } }] }), '回复');
    });

    test('Claude 非流式', () => {
        assert.strictEqual(extractText('claude', { content: [{ type: 'text', text: '回复' }] }), '回复');
    });

    test('Gemini 非流式', () => {
        assert.strictEqual(
            extractText('gemini', { candidates: [{ content: { parts: [{ text: '回复' }] } }] }),
            '回复',
        );
    });

    test('增量提取：OpenAI / Claude / Gemini', () => {
        assert.strictEqual(extractDelta('openai', { choices: [{ delta: { content: 'a' } }] }), 'a');
        assert.strictEqual(extractDelta('claude', { type: 'content_block_delta', delta: { text: 'b' } }), 'b');
        assert.strictEqual(extractDelta('gemini', { candidates: [{ content: { parts: [{ text: 'c' }] } }] }), 'c');
    });

    test('Claude 非文本事件不产生增量', () => {
        assert.strictEqual(extractDelta('claude', { type: 'message_start' }), '');
    });
});

describe('流式生成（真实 SSE 服务器）', () => {
    test('增量回调 + 返回完整文本', async () => {
        const { srv, port } = await sseServer([
            { choices: [{ delta: { content: '你' } }] },
            { choices: [{ delta: { content: '好' } }] },
            { choices: [{ delta: { content: '世界' } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const deltas = [];
            const full = await client.generateStream([{ role: 'user', content: 'hi' }], {}, d => deltas.push(d));

            assert.strictEqual(full, '你好世界');
            assert.deepStrictEqual(deltas, ['你', '好', '世界']);
        } finally { srv.close(); }
    });

    test('跨 TCP 分片的半行 SSE 正确重组', async () => {
        const { srv, port } = await sseServer(
            [{ choices: [{ delta: { content: '分片内容' } }] }],
            { splitAt: 10 }, // 从事件行中间切断
        );
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const full = await client.generateStream([{ role: 'user', content: 'x' }], {});
            assert.strictEqual(full, '分片内容');
        } finally { srv.close(); }
    });

    test('未配置 model 时抛出清晰错误', async () => {
        const client = new LLMClient({ provider: 'openai' });
        await assert.rejects(() => client.generateStream([], {}), /model 未配置/);
    });

    test('HTTP 错误状态抛出含状态码的错误', async () => {
        const srv = http.createServer((req, res) => { res.writeHead(401); res.end('unauthorized'); });
        await new Promise(r => srv.listen(0, r));
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'm' });
            await assert.rejects(() => client.generateStream([{ role: 'user', content: 'x' }], {}), /401/);
        } finally { srv.close(); }
    });
});

describe('空回复的诊断（推理模型 max_tokens 被思维链吃光）', () => {
    /**
     * 真机复现：deepseek 系推理模型把思维链和正文算在同一个 max_tokens 预算里。
     * 用 max_tokens=60 连打 5 次，3 次正文为空、finish_reason=length、
     * reasoning_tokens 正好等于 completion_tokens。
     * 而 ST 预设常把 max_tokens 设成 300 —— 对推理模型就是抛硬币。
     * 只报"LLM 返回空内容"的话，用户不可能猜到要去调大 max_tokens。
     */
    test('思维链吃光预算时给出可操作提示', () => {
        const msg = describeEmptyCompletion('openai', {
            choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '嗯…' } }],
            usage: { completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 60 } },
        });
        assert.match(msg, /max_tokens/);
        assert.match(msg, /思维链/);
        assert.match(msg, /60/, '应带上实际用掉的 token 数');
    });

    test('普通截断（非推理模型）也给提示，但不提思维链', () => {
        const msg = describeEmptyCompletion('openai', {
            choices: [{ finish_reason: 'length', message: { content: '' } }],
            usage: { completion_tokens: 100 },
        });
        assert.match(msg, /max_tokens/);
        assert.doesNotMatch(msg, /思维链/);
    });

    test('内容过滤单独识别', () => {
        const msg = describeEmptyCompletion('openai', {
            choices: [{ finish_reason: 'content_filter', message: { content: '' } }],
        });
        assert.match(msg, /过滤/);
    });

    test('说不出所以然时返回空串，不硬编造原因', () => {
        assert.strictEqual(describeEmptyCompletion('openai', { choices: [{ finish_reason: 'stop', message: { content: '' } }] }), '');
        assert.strictEqual(describeEmptyCompletion('openai', {}), '');
        assert.strictEqual(describeEmptyCompletion('claude', { choices: [{ finish_reason: 'length' }] }), '');
    });

    test('流式路径传入的精简结构也能判断', () => {
        // generateStream 只留得下 finish_reason 与 usage，没有 message
        const msg = describeEmptyCompletion('openai', {
            choices: [{ finish_reason: 'length' }],
            usage: { completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 60 } },
        });
        assert.match(msg, /思维链/);
    });
});

describe('思维链不会漏进正文', () => {
    test('delta 里只有 reasoning_content 时提取到空串', () => {
        // 实测流式响应：推理阶段 delta 是 { content: null, reasoning_content: "我们" }
        assert.strictEqual(extractDelta('openai', {
            choices: [{ delta: { content: null, reasoning_content: '我们' } }],
        }), '');
    });

    test('正文阶段正常提取', () => {
        assert.strictEqual(extractDelta('openai', {
            choices: [{ delta: { content: '你好', reasoning_content: null } }],
        }), '你好');
    });

    test('非流式：只取 content，不把 reasoning_content 当回复', () => {
        assert.strictEqual(extractText('openai', {
            choices: [{ message: { content: '', reasoning_content: '思考过程不该被当成回复' } }],
        }), '');
    });
});

describe('工具调用 - tools 规格构造（三 provider）', () => {
    const tools = [{
        name: 'search', description: '联网搜索',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    }];

    test('openai: tools[].function', () => {
        const spec = buildToolsSpec('openai', tools);
        assert.strictEqual(spec.tools[0].type, 'function');
        assert.strictEqual(spec.tools[0].function.name, 'search');
        assert.deepStrictEqual(spec.tools[0].function.parameters.required, ['q']);
    });

    test('claude: tools[].input_schema', () => {
        const spec = buildToolsSpec('claude', tools);
        assert.strictEqual(spec.tools[0].name, 'search');
        assert.deepStrictEqual(spec.tools[0].input_schema.required, ['q']);
    });

    test('gemini: tools[0].functionDeclarations', () => {
        const spec = buildToolsSpec('gemini', tools);
        assert.strictEqual(spec.tools[0].functionDeclarations[0].name, 'search');
    });

    test('无工具时返回空对象（不污染 body）', () => {
        assert.deepStrictEqual(buildToolsSpec('openai', []), {});
        assert.deepStrictEqual(buildToolsSpec('openai', undefined), {});
    });

    test('buildRequest 合并 sampling.tools', () => {
        const r = buildRequest({ provider: 'openai', model: 'm' }, [{ role: 'user', content: 'x' }], { tools });
        assert.strictEqual(r.body.tools[0].function.name, 'search');
    });
});

describe('工具调用 - tool_calls 提取（三 provider）', () => {
    test('openai: message.tool_calls，arguments 解析为对象', () => {
        const calls = extractToolCalls('openai', {
            choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"天气"}' } }] } }],
        });
        assert.deepStrictEqual(calls, [{ id: 'c1', name: 'search', arguments: { q: '天气' } }]);
    });

    test('openai: arguments 非法 JSON 降级为空对象', () => {
        const calls = extractToolCalls('openai', {
            choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 's', arguments: '不是json' } }] } }],
        });
        assert.deepStrictEqual(calls[0].arguments, {});
    });

    test('claude: content 里的 tool_use block', () => {
        const calls = extractToolCalls('claude', {
            content: [{ type: 'text', text: '让我查一下' }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }],
        });
        assert.deepStrictEqual(calls, [{ id: 't1', name: 'search', arguments: { q: 'x' } }]);
    });

    test('gemini: functionCall，合成稳定 id', () => {
        const calls = extractToolCalls('gemini', {
            candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] } }],
        });
        assert.strictEqual(calls[0].name, 'search');
        assert.deepStrictEqual(calls[0].arguments, { q: 'x' });
    });

    test('无工具调用返回空数组', () => {
        assert.deepStrictEqual(extractToolCalls('openai', { choices: [{ message: { content: '普通回复' } }] }), []);
    });
});

describe('工具调用 - 消息回灌（三 provider round-trip）', () => {
    const convo = [
        { role: 'user', content: '天气如何' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search', arguments: { q: '天气' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'search', content: '晴 30度' },
    ];

    test('openai: assistant.tool_calls + tool 消息', () => {
        const r = buildRequest({ provider: 'openai', model: 'm' }, convo, {});
        assert.strictEqual(r.body.messages[1].tool_calls[0].function.name, 'search');
        assert.strictEqual(r.body.messages[2].role, 'tool');
        assert.strictEqual(r.body.messages[2].tool_call_id, 'c1');
    });

    test('claude: tool_use + tool_result block', () => {
        const r = buildRequest({ provider: 'claude', model: 'm' }, convo, {});
        assert.strictEqual(r.body.messages[1].content[0].type, 'tool_use');
        assert.strictEqual(r.body.messages[2].content[0].type, 'tool_result');
        assert.strictEqual(r.body.messages[2].content[0].tool_use_id, 'c1');
    });

    test('gemini: functionCall + functionResponse', () => {
        const r = buildRequest({ provider: 'gemini', model: 'm' }, convo, {});
        assert.strictEqual(r.body.contents[1].parts[0].functionCall.name, 'search');
        assert.ok(r.body.contents[2].parts[0].functionResponse);
    });
});

/** 起一个按请求次数返回不同 JSON 的本地服务器（模拟 agent 多轮） */
function scriptedServer(responses) {
    let i = 0;
    const srv = http.createServer((req, res) => {
        const body = responses[Math.min(i, responses.length - 1)];
        i++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    return new Promise(resolve => srv.listen(0, () => resolve({ srv, port: srv.address().port })));
}

describe('工具调用 - runTools agent 循环（真实服务器）', () => {
    test('模型请求工具 → 执行 → 回灌 → 最终答复', async () => {
        const { srv, port } = await scriptedServer([
            // 第 1 次：模型要求调用 search
            { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"天气"}' } }] } }] },
            // 第 2 次：模型给出最终答复（无工具调用）
            { choices: [{ message: { content: '今天晴，30度' } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const executed = [];
            const result = await client.runTools(
                [{ role: 'user', content: '天气如何' }],
                [{ name: 'search', description: '搜索', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
                (name, args) => { executed.push({ name, args }); return '晴 30度'; },
            );
            assert.strictEqual(result.text, '今天晴，30度');
            assert.strictEqual(result.steps, 1);
            assert.deepStrictEqual(executed, [{ name: 'search', args: { q: '天气' } }]);
            // 完整消息应含 assistant 的 toolCalls 与 tool 结果
            const toolMsg = result.messages.find(m => m.role === 'tool');
            assert.strictEqual(toolMsg.content, '晴 30度');
        } finally { srv.close(); }
    });

    test('executor 抛错时把 error 回灌给模型，不中断循环', async () => {
        const { srv, port } = await scriptedServer([
            { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'boom', arguments: '{}' } }] } }] },
            { choices: [{ message: { content: '工具失败了，我直接答复' } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const result = await client.runTools(
                [{ role: 'user', content: 'x' }],
                [{ name: 'boom' }],
                () => { throw new Error('工具炸了'); },
            );
            assert.strictEqual(result.text, '工具失败了，我直接答复');
            const toolMsg = result.messages.find(m => m.role === 'tool');
            assert.match(toolMsg.content, /工具炸了/);
        } finally { srv.close(); }
    });

    test('达到 maxSteps 上限仍未收敛：兜底再问一次拿最终文本', async () => {
        // 每次都返回工具调用，永不收敛
        const { srv, port } = await scriptedServer([
            { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'loop', arguments: '{}' } }] } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            // maxSteps=2：2 轮工具后兜底 generate。但服务器只会返回工具调用的 JSON，
            // 兜底 generate 提取 text 为空会抛错——用它验证兜底路径确实被走到。
            await assert.rejects(
                () => client.runTools([{ role: 'user', content: 'x' }], [{ name: 'loop' }], () => 'again', { maxSteps: 2 }),
                /空内容/,
            );
        } finally { srv.close(); }
    });
});
