import { createLogger } from '../utils/logger.js';

const logger = createLogger('llm');

/**
 * LLM 客户端 —— provider 抽象
 *
 * 支持三类后端：
 *   - openai：OpenAI 及所有「OpenAI 兼容」后端（DeepSeek、本地 vLLM/Ollama 的 /v1 等）
 *   - claude：Anthropic Messages API
 *   - gemini：Google Generative Language API
 *
 * 只依赖 fetch，无第三方 SDK。请求构造与响应解析分离，便于单测。
 */

/**
 * 把统一的多模态 parts 转成各 provider 的 content 格式。
 *
 * 统一 part 格式（由 pipeline 产生）：
 *   { type: 'text',  text: string }
 *   { type: 'image', base64?: string, url?: string, mimeType?: string }
 *
 * @param {string} provider
 * @param {Array<object>} parts
 * @returns {*} provider 特定的 content（Gemini 返回 parts 数组）
 */
export function buildMultimodalContent(provider, parts) {
    const p = (provider || 'openai').toLowerCase();

    if (p === 'claude') {
        return parts.map(part => {
            if (part.type === 'text') return { type: 'text', text: part.text };
            // Anthropic 优先 base64；给了 url 则用 url source
            if (part.base64) {
                return {
                    type: 'image',
                    source: { type: 'base64', media_type: part.mimeType || 'image/jpeg', data: part.base64 },
                };
            }
            return { type: 'image', source: { type: 'url', url: part.url } };
        });
    }

    if (p === 'gemini') {
        return parts.map(part => {
            if (part.type === 'text') return { text: part.text };
            if (part.base64) {
                return { inline_data: { mime_type: part.mimeType || 'image/jpeg', data: part.base64 } };
            }
            return { file_data: { mime_type: part.mimeType || 'image/jpeg', file_uri: part.url } };
        });
    }

    // OpenAI 兼容：image_url 支持 http URL 或 data: URI
    return parts.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        const url = part.base64
            ? `data:${part.mimeType || 'image/jpeg'};base64,${part.base64}`
            : part.url;
        return { type: 'image_url', image_url: { url } };
    });
}

/** 消息的 content 是否为多模态 parts 数组 */
function isMultimodal(content) {
    return Array.isArray(content);
}

/** 取消息的纯文本表示（多模态时拼接其 text 部分） */
function contentToText(content) {
    if (!isMultimodal(content)) return content || '';
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

/**
 * 构造请求（不发送）——便于测试与排障
 *
 * messages[].content 可以是字符串，也可以是统一多模态 parts 数组
 * （见 buildMultimodalContent）。
 *
 * @param {object} cfg - { provider, baseUrl, apiKey, model }
 * @param {Array<{role,content}>} messages
 * @param {object} sampling
 * @param {boolean} stream
 * @returns {{url: string, headers: object, body: object}}
 */
export function buildRequest(cfg, messages, sampling = {}, stream = false) {
    const provider = (cfg.provider || 'openai').toLowerCase();
    const model = cfg.model || '';

    if (provider === 'claude') {
        // Anthropic：system 单独成字段，其余消息只能是 user/assistant
        const systemParts = messages.filter(m => m.role === 'system').map(m => contentToText(m.content));
        const rest = messages.filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: isMultimodal(m.content) ? buildMultimodalContent('claude', m.content) : m.content,
            }));
        return {
            url: `${cfg.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': cfg.apiKey || '',
                'anthropic-version': '2023-06-01',
            },
            body: {
                model,
                system: systemParts.join('\n\n') || undefined,
                messages: rest,
                max_tokens: sampling.max_tokens ?? 1024,
                temperature: sampling.temperature,
                top_p: sampling.top_p,
                stream: stream || undefined,
            },
        };
    }

    if (provider === 'gemini') {
        // Gemini：contents[].parts[].text，role 只有 user/model；system 走 systemInstruction
        const systemParts = messages.filter(m => m.role === 'system').map(m => contentToText(m.content));
        const contents = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: isMultimodal(m.content) ? buildMultimodalContent('gemini', m.content) : [{ text: m.content }],
        }));
        const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
        // 流式用 alt=sse，使三家 provider 的流格式统一为 SSE
        const method = stream ? 'streamGenerateContent' : 'generateContent';
        const sseParam = stream ? '&alt=sse' : '';
        return {
            url: `${base}/v1beta/models/${model}:${method}?key=${encodeURIComponent(cfg.apiKey || '')}${sseParam}`,
            headers: { 'Content-Type': 'application/json' },
            body: {
                contents,
                systemInstruction: systemParts.length ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
                generationConfig: {
                    temperature: sampling.temperature,
                    topP: sampling.top_p,
                    maxOutputTokens: sampling.max_tokens,
                },
            },
        };
    }

    // openai 兼容
    return {
        url: `${cfg.baseUrl || 'https://api.openai.com/v1'}/chat/completions`,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey || ''}`,
        },
        body: {
            model,
            messages: messages.map(m => (
                isMultimodal(m.content)
                    ? { role: m.role, content: buildMultimodalContent('openai', m.content) }
                    : m
            )),
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            max_tokens: sampling.max_tokens,
            frequency_penalty: sampling.frequency_penalty,
            presence_penalty: sampling.presence_penalty,
            stream: stream || undefined,
        },
    };
}

/**
 * 从各 provider 的响应中提取文本
 * @param {string} provider
 * @param {object} data
 * @returns {string}
 */
export function extractText(provider, data) {
    const p = (provider || 'openai').toLowerCase();
    if (p === 'claude') {
        const blocks = data?.content || [];
        return blocks.map(b => b.text || '').join('').trim();
    }
    if (p === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return parts.map(x => x.text || '').join('').trim();
    }
    return (data?.choices?.[0]?.message?.content || '').trim();
}

/**
 * 解释"为什么回复是空的"，给出可操作的提示。
 *
 * 推理模型（DeepSeek-R1 系、o1/o3、QwQ、GLM-Zero…）把思维链和正文算在同一个
 * max_tokens 预算里。ST 预设常把 max_tokens 设成 300~1000，对普通模型够用，
 * 但推理模型可能把预算**全部**花在思维链上，正文一个字都没输出——
 * 服务端返回 200、finish_reason=length、content 为空字符串。
 * 实测同一请求连打 5 次，3 次正文为空，是不稳定复现的。
 *
 * 这时候只报"LLM 返回空内容"等于什么都没说，用户不可能猜到要去调大 max_tokens。
 *
 * @param {string} provider
 * @param {object} data - 非流式响应体；流式则传 { choices:[{finish_reason}], usage }
 * @returns {string} 附加说明（无法判断时返回空串）
 */
export function describeEmptyCompletion(provider, data) {
    const p = (provider || 'openai').toLowerCase();
    if (p === 'claude' || p === 'gemini') return '';

    const choice = data?.choices?.[0] || {};
    const usage = data?.usage || {};
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    const reasoningText = choice.message?.reasoning_content || '';
    const isReasoning = reasoningTokens > 0 || reasoningText.length > 0;

    if (choice.finish_reason === 'length' && isReasoning) {
        const used = usage.completion_tokens ?? '?';
        return `：模型把 max_tokens 预算(${used})全用在思维链上了，正文没输出。`
            + '这是推理模型的典型表现——请调大预设里的 max_tokens（建议 ≥1500），'
            + '或换非推理模型。';
    }
    if (choice.finish_reason === 'length') {
        return '：max_tokens 太小，正文还没开始就被截断了，请调大。';
    }
    if (choice.finish_reason === 'content_filter') {
        return '：被服务端内容过滤拦截了。';
    }
    if (isReasoning) {
        return '：只返回了思维链、没有正文，通常是 max_tokens 不够，请调大。';
    }
    return '';
}

/**
 * 从一条 SSE data 事件中提取增量文本
 * @param {string} provider
 * @param {object} evt - 已 JSON.parse 的事件对象
 * @returns {string} 增量文本（无则空串）
 */
export function extractDelta(provider, evt) {
    const p = (provider || 'openai').toLowerCase();
    if (p === 'claude') {
        // content_block_delta: { delta: { type:'text_delta', text } }
        if (evt?.type === 'content_block_delta') return evt.delta?.text || '';
        return '';
    }
    if (p === 'gemini') {
        const parts = evt?.candidates?.[0]?.content?.parts || [];
        return parts.map(x => x.text || '').join('');
    }
    return evt?.choices?.[0]?.delta?.content || '';
}

/**
 * 解析 SSE 流，逐事件回调。
 * 兼容三家 provider 的 `data: {...}` 行格式（Gemini 用 alt=sse 后同构）。
 * @param {ReadableStream} body - fetch 响应体
 * @param {(evt: object) => void} onEvent
 */
export async function parseSSEStream(body, onEvent) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        buffer += decoder.decode(Buffer.from(chunk), { stream: true });
        // SSE 以空行分隔事件；这里按行处理 data: 前缀即可覆盖三家格式
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return;
            try {
                onEvent(JSON.parse(payload));
            } catch (_) { /* 跳过不完整/非 JSON 行 */ }
        }
    }
}

/**
 * LLM 客户端
 */
export class LLMClient {
    /**
     * @param {object} config - { provider, baseUrl, apiKey, model, timeout }
     */
    constructor(config = {}) {
        this.config = config;
    }

    /**
     * 生成回复（非流式）
     * @param {Array<{role,content}>} messages
     * @param {object} sampling
     * @returns {Promise<string>}
     */
    async generate(messages, sampling = {}) {
        const cfg = this.config;
        if (!cfg.model) throw new Error('LLM model 未配置');
        if (!cfg.apiKey && (cfg.provider || 'openai') !== 'custom') {
            // 本地后端可能不需要 key，仅警告
            logger.debug('未配置 apiKey（若为本地后端可忽略）');
        }

        const { url, headers, body } = buildRequest(cfg, messages, sampling, false);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeout ?? 120000);
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`LLM 请求失败 HTTP ${resp.status}: ${errText.slice(0, 300)}`);
            }
            const data = await resp.json();
            const text = extractText(cfg.provider, data);
            if (!text) throw new Error(`LLM 返回空内容${describeEmptyCompletion(cfg.provider, data)}`);
            return text;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 流式生成：边收边回调增量，返回完整文本。
     * 用于降低感知延迟（可在自然边界渐进发送到 IM），也避免长响应卡在单次超时里。
     * @param {Array} messages
     * @param {object} sampling
     * @param {(delta: string, full: string) => void} [onDelta]
     * @returns {Promise<string>} 完整文本
     */
    async generateStream(messages, sampling = {}, onDelta) {
        const cfg = this.config;
        if (!cfg.model) throw new Error('LLM model 未配置');

        const { url, headers, body } = buildRequest(cfg, messages, sampling, true);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeout ?? 120000);
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`LLM 流式请求失败 HTTP ${resp.status}: ${errText.slice(0, 300)}`);
            }
            let full = '';
            // 流式下同样要能解释空回复：把最后一次出现的 finish_reason / usage 留下来，
            // 供 describeEmptyCompletion 判断是不是"思维链吃光了 max_tokens"
            let lastFinish = null;
            let lastUsage = null;
            await parseSSEStream(resp.body, (evt) => {
                const ch = evt?.choices?.[0];
                if (ch?.finish_reason) lastFinish = ch.finish_reason;
                if (evt?.usage) lastUsage = evt.usage;
                const delta = extractDelta(cfg.provider, evt);
                if (delta) {
                    full += delta;
                    if (onDelta) {
                        try { onDelta(delta, full); } catch (_) { /* 回调异常不影响收流 */ }
                    }
                }
            });
            if (!full) {
                const why = describeEmptyCompletion(cfg.provider, {
                    choices: [{ finish_reason: lastFinish }], usage: lastUsage,
                });
                throw new Error(`LLM 流式返回空内容${why}`);
            }
            return full;
        } finally {
            clearTimeout(timer);
        }
    }

    /** 简易连通性校验 */
    async verify() {
        try {
            const text = await this.generate([{ role: 'user', content: 'ping' }], { max_tokens: 8 });
            return { ok: true, message: `连通正常（示例返回 ${text.slice(0, 20)}...）` };
        } catch (e) {
            return { ok: false, message: e.message };
        }
    }
}

export default { LLMClient, buildRequest, extractText, extractDelta, parseSSEStream, buildMultimodalContent, describeEmptyCompletion };
