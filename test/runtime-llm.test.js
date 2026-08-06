/**
 * 自建推理管线 - LLM 客户端回归测试（P2-5/7/8）
 * 三 provider 请求构造、多模态 content、SSE 流式解析
 *
 * 全部使用本地 HTTP 服务器，不依赖外部网络与真实 API key。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { LLMClient, buildRequest, extractText, extractDelta, extractReasoningDelta, buildMultimodalContent, describeEmptyCompletion, describeTruncation, buildToolsSpec, extractToolCalls, buildListModelsRequest, extractModelIds, extractToolCallsDelta, finalizeToolCalls } from '../server/runtime/llm-client.js';

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

    test('OpenAI 缺省 max_tokens 回退到推理模型安全值（不传 undefined）', () => {
        // 真机事故：openai buildRequest 原直接传 sampling.max_tokens，未给默认值；
        // 预设未指定时为 undefined，部分本地后端拒绝 undefined 或推理模型吃光小预算。
        const r = buildRequest({ provider: 'openai', model: 'm' }, msgs, {});
        assert.ok(r.body.max_tokens && r.body.max_tokens >= 4096,
            `推理模型需足够 max_tokens，实际: ${r.body.max_tokens}`);
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

    test('思维链增量经 onReasoning 透传，不污染正文 onDelta', async () => {
        // DeepSeek 等推理模型流式形态：推理阶段 delta.content=null + reasoning_content，
        // 正文阶段 reasoning_content=null + content
        const { srv, port } = await sseServer([
            { choices: [{ delta: { content: null, reasoning_content: '首先' } }] },
            { choices: [{ delta: { content: null, reasoning_content: '考虑' } }] },
            { choices: [{ delta: { content: '答案', reasoning_content: null } }] },
            { choices: [{ delta: { content: '是42', reasoning_content: null } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const textDeltas = [];
            const reasoningDeltas = [];
            const reasoningFulls = [];
            const full = await client.generateStream(
                [{ role: 'user', content: 'hi' }],
                {},
                d => textDeltas.push(d),
                (delta, fullReasoning) => {
                    reasoningDeltas.push(delta);
                    reasoningFulls.push(fullReasoning);
                },
            );

            assert.strictEqual(full, '答案是42');
            assert.deepStrictEqual(textDeltas, ['答案', '是42'], '正文增量只含 content，思维链不得漏进正文');
            assert.deepStrictEqual(reasoningDeltas, ['首先', '考虑'], 'onReasoning 应收全部增量');
            assert.deepStrictEqual(reasoningFulls, ['首先', '首先考虑'], 'full 应累积完整思维链');
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

describe('半截截断诊断（正文非空但触达 max_tokens 上限）', () => {
    /**
     * 与 describeEmptyCompletion 互补：这里正文已经输出了一部分、但没输出完
     * （finish_reason=length / stop_reason=max_tokens / MAX_TOKENS）。
     * 体验优先原则下绝不能静默返回半截回复——必须能被诊断、提醒调大下限。
     */
    test('describeTruncation 识别 openai 长度截断并带思维链占比', () => {
        const msg = describeTruncation('openai', {
            choices: [{ finish_reason: 'length', message: { content: '半截正文…' } }],
            usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 3000 } },
        });
        assert.match(msg, /截断/);
        assert.match(msg, /4096/, '应带上实际用掉的 token 数');
        assert.match(msg, /思维链/);
        assert.match(msg, /max_tokens/);
    });

    test('finish_reason=stop 不误报截断', () => {
        assert.strictEqual(describeTruncation('openai', { choices: [{ finish_reason: 'stop' }] }), '');
        assert.strictEqual(describeTruncation('openai', {}), '');
    });

    test('claude stop_reason=max_tokens 识别', () => {
        assert.match(describeTruncation('claude', { stop_reason: 'max_tokens' }), /截断/);
        assert.strictEqual(describeTruncation('claude', { stop_reason: 'end_turn' }), '');
    });

    test('gemini finishReason=MAX_TOKENS 识别', () => {
        assert.match(describeTruncation('gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }), /截断/);
        assert.strictEqual(describeTruncation('gemini', { candidates: [{ finishReason: 'STOP' }] }), '');
    });

    test('generate 对半截正文不抛错、原样返回（仅记 WARN 不阻断）', async () => {
        const { srv, port } = await scriptedServer([{
            choices: [{ finish_reason: 'length', message: { content: '被截断的半截回复' } }],
            usage: { completion_tokens: 4096 },
        }]);
        try {
            const client = new LLMClient({
                provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`,
                apiKey: 'k', model: 'm', timeout: 5000,
            });
            const text = await client.generate([{ role: 'user', content: 'hi' }], { max_tokens: 4096 });
            assert.strictEqual(text, '被截断的半截回复', '半截正文应原样返回，不得当空回复抛错');
        } finally {
            srv.close();
        }
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

    test('extractReasoningDelta：openai 兼容取 reasoning_content，claude/gemini 返回空串', () => {
        assert.strictEqual(extractReasoningDelta('openai', {
            choices: [{ delta: { content: null, reasoning_content: '我们' } }],
        }), '我们');
        // 正文增量不含思维链
        assert.strictEqual(extractReasoningDelta('openai', {
            choices: [{ delta: { content: '正文', reasoning_content: null } }],
        }), '');
        // 无增量时返回空串
        assert.strictEqual(extractReasoningDelta('openai', { choices: [{ delta: {} }] }), '');
        // claude / gemini 本期无 reasoning 透传协议
        assert.strictEqual(extractReasoningDelta('claude', { type: 'content_block_delta', delta: { text: 'x' } }), '');
        assert.strictEqual(extractReasoningDelta('gemini', { candidates: [{ content: { parts: [{ text: 'x' }] } }] }), '');
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
    test('非流式 generateWithTools 返回 reasoning 字段（openai 兼容）', async () => {
        const { srv, port } = await scriptedServer([
            { choices: [{ message: { content: '最终答案', reasoning_content: '我推理了一下' } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const result = await client.generateWithTools([{ role: 'user', content: 'x' }], [], {});
            assert.strictEqual(result.text, '最终答案');
            assert.strictEqual(result.reasoning, '我推理了一下');
        } finally { srv.close(); }
    });

    test('非流式 generateWithTools：claude 无 reasoning 字段返回空串', async () => {
        const { srv, port } = await scriptedServer([
            { content: [{ type: 'text', text: '回复' }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'claude', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const result = await client.generateWithTools([{ role: 'user', content: 'x' }], [], {});
            assert.strictEqual(result.text, '回复');
            assert.strictEqual(result.reasoning, '');
        } finally { srv.close(); }
    });

    test('runTools 累积全部回合思维链，结束后一次性上报（delta=full）', async () => {
        const { srv, port } = await scriptedServer([
            // 第 1 次：模型要求调用 search，且带思维链
            { choices: [{ message: { content: '', reasoning_content: '需要搜索', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '{"q":"天气"}' } }] } }] },
            // 第 2 次：最终答复，带第二段思维链
            { choices: [{ message: { content: '今天晴', reasoning_content: '结果已确认' } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const reasoningReports = [];
            const result = await client.runTools(
                [{ role: 'user', content: '天气如何' }],
                [{ name: 'search', description: '搜索', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
                () => '晴 30度',
                { onReasoning: (delta, full, turn) => reasoningReports.push({ delta, full, turn }) },
            );
            assert.strictEqual(result.text, '今天晴');
            assert.strictEqual(result.steps, 1);
            // 两段思维链拼接后一次性上报，delta=full，turn=实际步数
            assert.strictEqual(reasoningReports.length, 1);
            assert.strictEqual(reasoningReports[0].delta, '需要搜索结果已确认');
            assert.strictEqual(reasoningReports[0].full, '需要搜索结果已确认');
            assert.strictEqual(reasoningReports[0].turn, 1);
        } finally { srv.close(); }
    });

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

/** 起一个按请求次数返回不同 SSE 事件序列的本地服务器（模拟流式 agent 多轮） */
function sseScriptedServer(streams) {
    let i = 0;
    const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunks = streams[Math.min(i, streams.length - 1)];
        i++;
        const payload = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        res.write(payload);
        res.end();
    });
    return new Promise(resolve => srv.listen(0, () => resolve({ srv, port: srv.address().port })));
}

describe('工具调用 - 流式增量重建（extractToolCallsDelta + finalizeToolCalls）', () => {
    test('openai: 按 index 归并，name/arguments 分片拼接', () => {
        const acc = {};
        assert.strictEqual(
            extractToolCallsDelta('openai', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '' } }] } }] }, acc),
            true,
        );
        extractToolCallsDelta('openai', { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }, acc);
        extractToolCallsDelta('openai', { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"天气"}' } }] } }] }, acc);
        const calls = finalizeToolCalls('openai', acc);
        assert.deepStrictEqual(calls, [{ id: 'c1', name: 'search', arguments: { q: '天气' } }]);
    });

    test('openai: 多 index 并行工具互不串扰', () => {
        const acc = {};
        extractToolCallsDelta('openai', { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'a', function: { name: 'search', arguments: '{"q":' } },
            { index: 1, id: 'b', function: { name: 'lookup', arguments: '{"k":' } },
        ] } }] }, acc);
        extractToolCallsDelta('openai', { choices: [{ delta: { tool_calls: [
            { index: 0, function: { arguments: '"a"}' } },
            { index: 1, function: { arguments: '"b"}' } },
        ] } }] }, acc);
        const calls = finalizeToolCalls('openai', acc);
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(calls[0], { id: 'a', name: 'search', arguments: { q: 'a' } });
        assert.deepStrictEqual(calls[1], { id: 'b', name: 'lookup', arguments: { k: 'b' } });
    });

    test('openai: arguments 非法 JSON 降级为空对象', () => {
        const acc = {};
        extractToolCallsDelta('openai', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 's', arguments: '不是json' } }] } }] }, acc);
        assert.deepStrictEqual(finalizeToolCalls('openai', acc)[0].arguments, {});
    });

    test('claude: content_block_start + input_json_delta 重建', () => {
        const acc = {};
        extractToolCallsDelta('claude', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'search' } }, acc);
        extractToolCallsDelta('claude', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, acc);
        extractToolCallsDelta('claude', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"天气"}' } }, acc);
        // 文本 delta 不影响工具重建
        extractToolCallsDelta('claude', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '查一下' } }, acc);
        const calls = finalizeToolCalls('claude', acc);
        assert.deepStrictEqual(calls, [{ id: 't1', name: 'search', arguments: { q: '天气' } }]);
    });

    test('claude: 多 tool_use 并行按 index 归并', () => {
        const acc = {};
        extractToolCallsDelta('claude', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'search' } }, acc);
        extractToolCallsDelta('claude', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'lookup' } }, acc);
        extractToolCallsDelta('claude', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } }, acc);
        extractToolCallsDelta('claude', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"k":"y"}' } }, acc);
        const calls = finalizeToolCalls('claude', acc);
        assert.deepStrictEqual(calls, [
            { id: 'a', name: 'search', arguments: { q: 'x' } },
            { id: 'b', name: 'lookup', arguments: { k: 'y' } },
        ]);
    });

    test('gemini: 完整 functionCall 直接收集', () => {
        const acc = {};
        extractToolCallsDelta('gemini', { candidates: [{ content: { parts: [{ functionCall: { name: 'search', args: { q: '天气' } } }] } }] }, acc);
        const calls = finalizeToolCalls('gemini', acc);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].name, 'search');
        assert.deepStrictEqual(calls[0].arguments, { q: '天气' });
    });

    test('无工具调用返回 null；未知 provider 返回 false 且不收集', () => {
        assert.strictEqual(finalizeToolCalls('openai', {}), null);
        assert.strictEqual(finalizeToolCalls('claude', {}), null);
        assert.strictEqual(finalizeToolCalls('gemini', {}), null);
        const acc = {};
        assert.strictEqual(extractToolCallsDelta('ollama', { choices: [{ delta: { content: 'x' } }] }, acc), false);
        assert.deepStrictEqual(acc, {}, '未知 provider 不应写入累加器');
    });
});

describe('工具调用 - runToolsStream 流式 agent 循环（真实 SSE 服务器）', () => {
    const searchTool = { name: 'search', description: '搜索', parameters: { type: 'object', properties: { q: { type: 'string' } } } };

    test('流式工具调用 → 执行 → 回灌 → 最终答复，增量回调带 turn', async () => {
        const { srv, port } = await sseScriptedServer([
            // 第 1 次请求：流式返回 search 工具调用（分片）
            [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"天' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '气"}' } }] } }] },
            ],
            // 第 2 次请求：流式返回最终正文
            [
                { choices: [{ delta: { content: '今' } }] },
                { choices: [{ delta: { content: '天晴' } }] },
                { choices: [{ delta: { content: '，30度' } }] },
            ],
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const executed = [];
            const deltas = [];
            const result = await client.runToolsStream(
                [{ role: 'user', content: '天气如何' }],
                [searchTool],
                (name, args) => { executed.push({ name, args }); return '晴 30度'; },
                { maxSteps: 5, onDelta: (d, full, turn) => deltas.push({ d, turn }) },
            );
            assert.strictEqual(result.text, '今天晴，30度');
            assert.strictEqual(result.steps, 1);
            assert.deepStrictEqual(executed, [{ name: 'search', args: { q: '天气' } }]);
            // 工具回合惯例无正文，增量全部来自最终回合（turn=1）
            assert.deepStrictEqual(deltas.map(x => x.d), ['今', '天晴', '，30度']);
            assert.ok(deltas.every(x => x.turn === 1), '增量应来自最终回合');
            // 完整消息应含 assistant toolCalls 与 tool 结果
            const toolMsg = result.messages.find(m => m.role === 'tool');
            assert.strictEqual(toolMsg.content, '晴 30度');
        } finally { srv.close(); }
    });

    test('executor 抛错时回灌 error，不中断流式循环', async () => {
        const { srv, port } = await sseScriptedServer([
            [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'boom', arguments: '{}' } }] } }] },
            ],
            [
                { choices: [{ delta: { content: '工具失败了，我直接答复' } }] },
            ],
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const result = await client.runToolsStream(
                [{ role: 'user', content: 'x' }],
                [{ name: 'boom' }],
                () => { throw new Error('工具炸了'); },
            );
            assert.strictEqual(result.text, '工具失败了，我直接答复');
            const toolMsg = result.messages.find(m => m.role === 'tool');
            assert.match(toolMsg.content, /工具炸了/);
        } finally { srv.close(); }
    });

    test('流式思维链增量经 onReasoning 转发，带 turn 且不污染正文', async () => {
        const { srv, port } = await sseScriptedServer([
            // 第 1 次请求：工具调用回合，先推理后发工具
            [
                { choices: [{ delta: { content: null, reasoning_content: '先想想' } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":"天气"}' } }] } }] },
            ],
            // 第 2 次请求：最终正文回合，带第二段推理
            [
                { choices: [{ delta: { content: null, reasoning_content: '然后回答' } }] },
                { choices: [{ delta: { content: '今天晴' } }] },
            ],
        ]);
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            const reasoning = [];
            const textDeltas = [];
            const result = await client.runToolsStream(
                [{ role: 'user', content: '天气如何' }],
                [searchTool],
                () => '晴 30度',
                {
                    maxSteps: 5,
                    onDelta: (d, full, turn) => textDeltas.push({ d, turn }),
                    onReasoning: (delta, full, turn) => reasoning.push({ delta, full, turn }),
                },
            );
            assert.strictEqual(result.text, '今天晴');
            // 两段推理各自带正确 turn：工具回合 turn=0、最终回合 turn=1
            assert.deepStrictEqual(reasoning.map(r => r.delta), ['先想想', '然后回答']);
            assert.deepStrictEqual(reasoning.map(r => r.full), ['先想想', '然后回答'], 'full 为回合内累积（跨回合由上层展示端拼接）');
            assert.deepStrictEqual(reasoning.map(r => r.turn), [0, 1], 'turn 为实际工具回合序号');
            // 正文增量不含思维链
            assert.deepStrictEqual(textDeltas.map(x => x.d), ['今天晴']);
        } finally { srv.close(); }
    });

    test('未知 provider 整体降级为非流式 runTools（不触发流式回调）', async () => {
        const { srv, port } = await scriptedServer([
            { choices: [{ message: { content: '非流式答复' } }] },
        ]);
        try {
            const client = new LLMClient({ provider: 'custom', baseUrl: `http://127.0.0.1:${port}`, model: 'm' });
            let deltaCb = false;
            const result = await client.runToolsStream(
                [{ role: 'user', content: 'x' }],
                [],
                () => 'x',
                { maxSteps: 3, onDelta: () => { deltaCb = true; } },
            );
            assert.strictEqual(result.text, '非流式答复');
            assert.strictEqual(deltaCb, false, '降级路径不应触发流式回调');
        } finally { srv.close(); }
    });

    test('流式回合失败：该回合降级 generateWithTools 兜底，整体仍收敛', async () => {
        let calls = 0;
        const srv = http.createServer((req, res) => {
            calls++;
            if (calls === 1) {
                // 第一次流式请求：HTTP 500 → generateWithToolsStream 抛错
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'server boom' }));
            } else {
                // 第二次兜底非流式请求：返回最终答复
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: '兜底答复' } }] }));
            }
        });
        await new Promise(r => srv.listen(0, r));
        try {
            const client = new LLMClient({ provider: 'openai', baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'm' });
            const result = await client.runToolsStream(
                [{ role: 'user', content: 'x' }],
                [],
                () => 'x',
            );
            assert.strictEqual(result.text, '兜底答复', '流式失败后应降级非流式并拿到答复');
            assert.strictEqual(calls, 2, '应发起两次请求：一次流式失败 + 一次兜底');
        } finally { srv.close(); }
    });
});
