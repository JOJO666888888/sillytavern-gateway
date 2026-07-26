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
 * 构造请求（不发送）——便于测试与排障
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
        const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
        const rest = messages.filter(m => m.role !== 'system')
            .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
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
        const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
        const contents = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));
        const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com';
        const method = stream ? 'streamGenerateContent' : 'generateContent';
        return {
            url: `${base}/v1beta/models/${model}:${method}?key=${encodeURIComponent(cfg.apiKey || '')}`,
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
            messages,
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
            if (!text) throw new Error('LLM 返回空内容');
            return text;
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

export default { LLMClient, buildRequest, extractText };
