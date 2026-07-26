/**
 * 自建推理管线 - LLM 客户端回归测试（P2-5/7/8）
 * 三 provider 请求构造、多模态 content、SSE 流式解析
 *
 * 全部使用本地 HTTP 服务器，不依赖外部网络与真实 API key。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import {
    LLMClient, buildRequest, extractText, extractDelta, buildMultimodalContent,
} from '../server/runtime/llm-client.js';

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
