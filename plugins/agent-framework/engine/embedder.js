/**
 * 嵌入向量生成器（任务 2b 延伸：启用 EmbeddingRetriever）
 *
 * 两种模式：
 * - 'local'（默认，零依赖、同步、确定性）：字符 n-gram hashing → 固定维度稀疏 TF 向量 + L2 归一化。
 *   中文按单字切分、英文按整词，无需分词器，开箱即用；语义强度有限（适合原型/离线演示）。
 * - 'api'（外部语义向量）：调用 OpenAI 兼容的 /embeddings 端点（火山方舟 / OpenAI / 本地后端均可）。
 *   异步返回真实语义向量；内置进程内缓存（相同文本不重复请求）。
 *
 * 统一入口 createEmbedder(mode, options)。
 */
const DEFAULT_DIM = 256;

function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * 本地零依赖 embedder：字符 n-gram 词袋 + hashing → 固定维度向量。
 * @param {object} [options] - { dim?: number }
 * @returns {(text: string) => number[]}
 */
export function createLocalEmbedder(options = {}) {
    const dim = options.dim || DEFAULT_DIM;
    return (text) => {
        const vec = new Array(dim).fill(0);
        const s = String(text || '').toLowerCase();
        if (!s) return vec;

        const grams = [];
        // 中文片段按单字；英文/数字片段按整词 + 2-gram
        for (const tok of s.split(/\s+/)) {
            if (!tok) continue;
            if (/[\u4e00-\u9fff]/.test(tok)) {
                for (const ch of tok) grams.push(ch);
            } else {
                for (let i = 0; i < tok.length; i++) grams.push(tok[i]);
                for (let i = 0; i < tok.length - 1; i++) grams.push(tok.slice(i, i + 2));
            }
        }
        for (const g of grams) {
            vec[hashStr(g) % dim] += 1;
        }
        // L2 归一化
        let norm = 0;
        for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let i = 0; i < dim; i++) vec[i] /= norm;
        }
        return vec;
    };
}

/**
 * 外部 API embedder：POST {baseUrl}/embeddings（OpenAI 兼容）。
 * - apiKey 取 options.apiKey，未配置时回退环境变量 AGENT_EMBEDDER_API_KEY。
 * - 相同文本命中进程内缓存，不重复请求。
 * @param {object} [options] - { baseUrl, apiKey?, model?, timeoutMs? }
 * @returns {(text: string) => Promise<number[]>}
 */
export function createApiEmbedder(options = {}) {
    const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    const apiKey = options.apiKey || process.env.AGENT_EMBEDDER_API_KEY || '';
    const model = options.model || 'text-embedding-3-small';
    const timeoutMs = options.timeoutMs || 15000;
    const cache = new Map();

    async function embed(text) {
        const input = String(text || '');
        if (cache.has(input)) return cache.get(input);
        if (!baseUrl) {
            throw new Error('api embedder 未配置 embedderBaseUrl（本地/内网后端请填 http://127.0.0.1:端口/v1）');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({ model, input }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`嵌入 API ${res.status}: ${body.slice(0, 200)}`);
            }
            const data = await res.json();
            const vector = data?.data?.[0]?.embedding;
            if (!Array.isArray(vector)) {
                throw new Error('嵌入 API 响应缺少 data[0].embedding，请确认端点 /embeddings 与 model 参数');
            }
            cache.set(input, vector);
            return vector;
        } finally {
            clearTimeout(timer);
        }
    }
    return embed;
}

/**
 * 统一工厂
 * @param {'local'|'api'} [mode='local']
 * @param {object} [options]
 * @returns {Function} embedder：(text) => number[] 或 (text) => Promise<number[]>
 */
export function createEmbedder(mode = 'local', options = {}) {
    if (mode === 'api') return createApiEmbedder(options);
    return createLocalEmbedder(options);
}
