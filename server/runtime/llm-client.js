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
 * 把统一工具声明转成各 provider 的 tools 规格。
 *
 * 统一工具声明（插件/调用方提供）：
 *   { name: string, description?: string, parameters?: object(JSON Schema) }
 *
 * @param {string} provider
 * @param {Array<object>} tools
 * @returns {object} provider 特定的 { tools, ... } 片段（合并进 body）
 */
export function buildToolsSpec(provider, tools) {
    if (!Array.isArray(tools) || tools.length === 0) return {};
    const p = (provider || 'openai').toLowerCase();

    if (p === 'claude') {
        return {
            tools: tools.map(t => ({
                name: t.name,
                description: t.description || '',
                input_schema: t.parameters || { type: 'object', properties: {} },
            })),
        };
    }

    if (p === 'gemini') {
        return {
            tools: [{
                functionDeclarations: tools.map(t => ({
                    name: t.name,
                    description: t.description || '',
                    parameters: t.parameters || { type: 'object', properties: {} },
                })),
            }],
        };
    }

    // openai 兼容
    return {
        tools: tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.parameters || { type: 'object', properties: {} },
            },
        })),
    };
}

/**
 * 把一条统一消息（可能含 tool_calls / 为 tool 结果）转成 openai 兼容格式。
 * 统一消息补充约定（在 {role, content} 之外）：
 *   assistant 发起工具调用：{ role:'assistant', content:'', toolCalls:[{id,name,arguments}] }
 *   工具执行结果：          { role:'tool', toolCallId, name, content }
 * @param {object} m
 * @returns {object}
 */
function toOpenAIMessage(m) {
    if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
            })),
        };
    }
    return isMultimodal(m.content)
        ? { role: m.role, content: buildMultimodalContent('openai', m.content) }
        : m;
}

/**
 * 把一条统一消息转成 Claude 格式。
 * tool_calls → assistant 消息里的 tool_use block；tool 结果 → user 消息里的 tool_result block。
 * @param {object} m
 * @returns {object}
 */
function toClaudeMessage(m) {
    if (m.role === 'tool') {
        return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') }],
        };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
        }
        return { role: 'assistant', content: blocks };
    }
    return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: isMultimodal(m.content) ? buildMultimodalContent('claude', m.content) : m.content,
    };
}

/**
 * 把一条统一消息转成 Gemini content。
 * tool_calls → model 的 functionCall part；tool 结果 → user 的 functionResponse part。
 * @param {object} m
 * @returns {object}
 */
function toGeminiContent(m) {
    if (m.role === 'tool') {
        // Gemini 的 functionResponse.response 需为对象；非对象包一层
        let response = m.content;
        if (typeof response === 'string') {
            try { response = JSON.parse(response); } catch (_) { response = { result: response }; }
        }
        return {
            role: 'user',
            parts: [{ functionResponse: { name: m.name, response } }],
        };
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls) {
            parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
        }
        return { role: 'model', parts };
    }
    return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: isMultimodal(m.content) ? buildMultimodalContent('gemini', m.content) : [{ text: m.content }],
    };
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
            .map(m => toClaudeMessage(m));
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
                ...buildToolsSpec('claude', sampling.tools),
            },
        };
    }

    if (provider === 'gemini') {
        // Gemini：contents[].parts[].text，role 只有 user/model；system 走 systemInstruction
        const systemParts = messages.filter(m => m.role === 'system').map(m => contentToText(m.content));
        const contents = messages.filter(m => m.role !== 'system').map(m => toGeminiContent(m));
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
                ...buildToolsSpec('gemini', sampling.tools),
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
            messages: messages.map(m => toOpenAIMessage(m)),
            temperature: sampling.temperature,
            top_p: sampling.top_p,
            max_tokens: sampling.max_tokens,
            frequency_penalty: sampling.frequency_penalty,
            presence_penalty: sampling.presence_penalty,
            stream: stream || undefined,
            ...buildToolsSpec('openai', sampling.tools),
        },
    };
}

/**
 * 从各 provider 的响应中提取 tool_calls（模型想调用哪些工具）。
 * 统一返回：[{ id, name, arguments(object) }]，无工具调用则返回 []。
 * @param {string} provider
 * @param {object} data
 * @returns {Array<{id: string, name: string, arguments: object}>}
 */
export function extractToolCalls(provider, data) {
    const p = (provider || 'openai').toLowerCase();

    if (p === 'claude') {
        const blocks = data?.content || [];
        return blocks
            .filter(b => b.type === 'tool_use')
            .map(b => ({ id: b.id, name: b.name, arguments: b.input || {} }));
    }

    if (p === 'gemini') {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return parts
            .filter(x => x.functionCall)
            .map((x, i) => ({
                // Gemini 不给调用 id，用 name+序号合成一个稳定 id
                id: `${x.functionCall.name}-${i}`,
                name: x.functionCall.name,
                arguments: x.functionCall.args || {},
            }));
    }

    // openai 兼容
    const calls = data?.choices?.[0]?.message?.tool_calls || [];
    return calls.map(c => {
        let args = {};
        try { args = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch (_) { args = {}; }
        return { id: c.id, name: c.function?.name, arguments: args };
    });
}

/**
 * 构造"列出可用模型"请求（不发送）--供面板下拉选择。
 * 与 buildRequest 同风格的纯函数，便于单测。
 * @param {object} cfg - { provider, baseUrl, apiKey }
 * @returns {{url: string, headers: object}}
 */
export function buildListModelsRequest(cfg) {
    const provider = (cfg.provider || 'openai').toLowerCase();
    if (provider === 'claude') {
        // Anthropic 的 /v1/models 需要 x-api-key + anthropic-version
        return {
            url: `${cfg.baseUrl || 'https://api.anthropic.com'}/v1/models?limit=1000`,
            headers: {
                'x-api-key': cfg.apiKey || '',
                'anthropic-version': '2023-06-01',
            },
        };
    }
    if (provider === 'gemini') {
        const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
        return {
            url: `${base}/v1beta/models?key=${encodeURIComponent(cfg.apiKey || '')}`,
            headers: {},
        };
    }
    // openai 兼容（DeepSeek / Ollama / vLLM 等都走 /v1/models）
    return {
        url: `${cfg.baseUrl || 'https://api.openai.com/v1'}/models`,
        headers: { 'Authorization': `Bearer ${cfg.apiKey || ''}` },
    };
}

/**
 * 从"列出模型"响应中提取模型 id 列表（统一为 string[]）。
 * @param {string} provider
 * @param {object} data
 * @returns {string[]}
 */
export function extractModelIds(provider, data) {
    const p = (provider || 'openai').toLowerCase();
    if (p === 'gemini') {
        const arr = data?.models || [];
        return arr.map(m => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
    }
    // openai 与 claude 的列表响应都是 { data: [{ id }, ...] }
    const arr = data?.data || [];
    return arr.map(m => m.id).filter(Boolean);
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
     * 拉取后端可用模型列表（供面板下拉选择，不消耗对话额度）。
     * @returns {Promise<string[]>}
     */
    async listModels() {
        const cfg = this.config;
        const { url, headers } = buildListModelsRequest(cfg);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeout ?? 20000);
        try {
            const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`获取模型列表失败 HTTP ${resp.status}: ${errText.slice(0, 300)}`);
            }
            const data = await resp.json();
            return extractModelIds(cfg.provider, data);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 单轮工具调用：把 tools 交给模型，返回它的文本 + 想调用的工具列表。
     * 不自动执行工具——由调用方（runTools 或插件）决定如何执行并回灌结果。
     * @param {Array} messages - 统一消息（可含之前轮次的 tool_calls / tool 结果）
     * @param {Array} tools - 统一工具声明 [{ name, description, parameters }]
     * @param {object} sampling
     * @returns {Promise<{text: string, toolCalls: Array<{id,name,arguments}>, raw: object}>}
     */
    async generateWithTools(messages, tools = [], sampling = {}) {
        const cfg = this.config;
        if (!cfg.model) throw new Error('LLM model 未配置');

        const { url, headers, body } = buildRequest(cfg, messages, { ...sampling, tools }, false);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeout ?? 120000);
        try {
            const resp = await fetch(url, {
                method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
            });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                throw new Error(`LLM 请求失败 HTTP ${resp.status}: ${errText.slice(0, 300)}`);
            }
            const data = await resp.json();
            return {
                text: extractText(cfg.provider, data),
                toolCalls: extractToolCalls(cfg.provider, data),
                raw: data,
            };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 工具调用 agent 循环：模型请求工具 → 执行 → 回灌结果 → 再问模型，直到模型给出
     * 最终文本（无工具调用）或达到 maxSteps 上限。
     *
     * @param {Array} messages - 初始统一消息（通常含 system + user）
     * @param {Array} tools - 统一工具声明 [{ name, description, parameters }]
     * @param {(name: string, args: object) => Promise<any>|any} executor
     *        执行单个工具，返回结果（对象/字符串皆可，会被序列化回灌给模型）
     * @param {object} [options] - { maxSteps?: number(默认5), sampling?: object }
     * @returns {Promise<{text: string, steps: number, messages: Array}>}
     *          text=最终回复；steps=实际工具轮数；messages=含全过程的完整消息数组
     */
    async runTools(messages, tools, executor, options = {}) {
        const maxSteps = options.maxSteps ?? 5;
        const sampling = options.sampling || {};
        const convo = [...messages];

        for (let step = 0; step < maxSteps; step++) {
            const { text, toolCalls } = await this.generateWithTools(convo, tools, sampling);

            if (!toolCalls.length) {
                // 模型给出最终答复，结束
                return { text, steps: step, messages: convo };
            }

            // 记录本轮 assistant 的工具调用
            convo.push({ role: 'assistant', content: text || '', toolCalls });

            // 逐个执行工具，把结果作为 tool 消息回灌
            for (const call of toolCalls) {
                let result;
                try {
                    result = await executor(call.name, call.arguments);
                } catch (e) {
                    result = { error: e.message };
                }
                const content = typeof result === 'string' ? result : JSON.stringify(result ?? null);
                convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
            }
        }

        // 达到步数上限仍未收敛：再问一次「不给工具」逼出最终文本
        const final = await this.generate(convo, sampling);
        return { text: final, steps: maxSteps, messages: convo };
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

export default { LLMClient, buildRequest, extractText, extractToolCalls, extractDelta, parseSSEStream, buildMultimodalContent, buildToolsSpec, describeEmptyCompletion };
