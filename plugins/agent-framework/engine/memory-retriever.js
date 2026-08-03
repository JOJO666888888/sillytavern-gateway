/**
 * 记忆检索器（任务 2b：可插拔双引擎）
 *
 * - InvertedIndexRetriever（默认）：懒构建倒排索引 + TF-IDF 评分 + 配额制公平。
 *   语义与旧 recall 完全一致：分段规则 \n\n+、namespace 隔离、输出契约 { type, content, namespace, score }。
 *   性能收益：构建后查询只扫命中词的倒排列表（精确匹配），
 *   对倒排无精确命中的查询词做子串兜底扫描（兼容旧 includes 语义，中文无空格文本友好）。
 * - EmbeddingRetriever（接口预留）：配置 embedder 后按余弦相似度检索；未配置时返回 [] 并 warn 一次。
 * - createRetriever(type, options)：统一工厂。
 */
export const MEMORY_TYPES = ['project', 'reference', 'feedback', 'user'];

/** 同一 key 只 warn 一次 */
function warnOnce(key, msg) {
    if (warnOnce._warned && warnOnce._warned.has(key)) return;
    warnOnce._warned = warnOnce._warned || new Set();
    warnOnce._warned.add(key);
    console.warn(`[memory-retriever] ${msg}`);
}

/**
 * 配额制公平选择（与旧 recall L136-146 一致）：
 * 每种命中类型保底 top1，其余按全局分数填充，结果按分数降序。
 * @param {Array<{type:string, score:number}>} scored
 * @param {number} limit
 * @returns {Array}
 */
function quotaSelect(scored, limit) {
    if (scored.length === 0) return [];
    const byType = new Map();
    for (const s of scored) {
        if (!byType.has(s.type)) byType.set(s.type, []);
        byType.get(s.type).push(s);
    }
    for (const list of byType.values()) list.sort((a, b) => b.score - a.score);

    const result = [];
    for (const list of byType.values()) result.push(list[0]);
    if (result.length < limit) {
        const rest = [];
        for (const list of byType.values()) rest.push(...list.slice(1));
        rest.sort((a, b) => b.score - a.score);
        result.push(...rest.slice(0, limit - result.length));
    }
    result.sort((a, b) => b.score - a.score);
    return result;
}

export class InvertedIndexRetriever {
    constructor(options = {}) {
        this._loadFn = null;        // (type, namespace) => content（MemoryEngine 注入 read）
        this._index = new Map();    // namespaceKey -> { docs, inverted, docFreq, N }
        this._options = options;
    }

    /** 注入数据源并清空缓存（懒构建：首次 retrieve 时再建索引） */
    setSources(loadFn) {
        this._loadFn = typeof loadFn === 'function' ? loadFn : null;
        this.invalidate();
    }

    /** 显式失效缓存（MemoryEngine 在 update/append 成功后调用） */
    invalidate() {
        this._index.clear();
    }

    /** 分词：小写 + 空白拆分 + 空词过滤（与旧 recall 查询侧一致） */
    _tokenize(text) {
        return String(text).toLowerCase().split(/\s+/).filter(Boolean);
    }

    /**
     * 懒构建某 namespace 的倒排索引。
     * 索引结构：docs 数组 + inverted(term -> Map<paraIndex, tf>) + docFreq(term -> df) + N。
     * @param {string} namespace
     * @returns {{docs:Array, inverted:Map, docFreq:Map, N:number}}
     */
    _buildIndex(namespace) {
        const docs = [];
        const inverted = new Map();
        const docFreq = new Map();
        for (const type of MEMORY_TYPES) {
            const content = this._loadFn ? this._loadFn(type, namespace) : '';
            if (!content) continue;
            for (const para of content.split(/\n\n+/)) {
                const paraIndex = docs.length;
                docs.push({ type, content: para });
                const freq = new Map();
                for (const t of this._tokenize(para)) {
                    freq.set(t, (freq.get(t) || 0) + 1);
                }
                for (const t of freq.keys()) {
                    if (!inverted.has(t)) inverted.set(t, new Map());
                    inverted.get(t).set(paraIndex, freq.get(t));
                    docFreq.set(t, (docFreq.get(t) || 0) + 1);
                }
            }
        }
        return { docs, inverted, docFreq, N: docs.length };
    }

    _getIndex(namespace) {
        const key = namespace || '';
        if (this._index.has(key)) return this._index.get(key);
        const idx = this._buildIndex(namespace);
        this._index.set(key, idx);
        return idx;
    }

    /**
     * 倒排 + TF-IDF 检索。
     * - IDF = log((N+1)/(df+1)) + 1；TF 用词频。
     * - 倒排无精确命中的查询词，对该 namespace 段落做子串兜底（兼容旧 recall 的 includes 语义）。
     * @param {string} query
     * @param {number} [limit=5]
     * @param {string} [namespace]
     * @returns {Array<{type:string, content:string, namespace:string, score:number}>}
     */
    retrieve(query, limit = 5, namespace = '') {
        const terms = this._tokenize(query);
        if (terms.length === 0) return [];
        const idx = this._getIndex(namespace);
        if (!idx || idx.N === 0) return [];

        // paraIndex -> { type, content, score }
        const hitPara = new Map();
        for (const term of terms) {
            const idf = Math.log((idx.N + 1) / ((idx.docFreq.get(term) || 0) + 1)) + 1;
            const postings = idx.inverted.get(term);
            if (postings) {
                for (const [paraIndex, tf] of postings) {
                    const entry = hitPara.get(paraIndex)
                        || { type: idx.docs[paraIndex].type, content: idx.docs[paraIndex].content, score: 0 };
                    entry.score += tf * idf;
                    hitPara.set(paraIndex, entry);
                }
            } else {
                // 精确无命中 → 子串兜底（词频按 1 计）
                for (let i = 0; i < idx.docs.length; i++) {
                    if (idx.docs[i].content.toLowerCase().includes(term)) {
                        const entry = hitPara.get(i)
                            || { type: idx.docs[i].type, content: idx.docs[i].content, score: 0 };
                        entry.score += idf;
                        hitPara.set(i, entry);
                    }
                }
            }
        }
        if (hitPara.size === 0) return [];

        const selected = quotaSelect([...hitPara.values()], limit);
        return selected.map(r => ({ ...r, namespace: namespace || '' }));
    }
}

export class EmbeddingRetriever {
    constructor(options = {}) {
        this._loadFn = null;
        this._embedder = typeof options.embedder === 'function' ? options.embedder : null;
        this._docs = null; // 惰性缓存：{ type, content }[]
    }

    setSources(loadFn) {
        this._loadFn = typeof loadFn === 'function' ? loadFn : null;
        this._docs = null;
    }

    setEmbedder(fn) {
        this._embedder = typeof fn === 'function' ? fn : null;
        this._docs = null;
    }

    invalidate() {
        this._docs = null;
    }

    _loadDocs(namespace) {
        if (this._docs) return this._docs;
        const docs = [];
        if (this._loadFn) {
            for (const type of MEMORY_TYPES) {
                const content = this._loadFn(type, namespace);
                if (!content) continue;
                for (const para of content.split(/\n\n+/)) {
                    docs.push({ type, content: para });
                }
            }
        }
        this._docs = docs;
        return docs;
    }

    _cosine(a, b) {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0) return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    /**
     * 嵌入检索（接口预留，同步契约以兼容 recall 返回数组）。
     * 未配置 embedder 时返回 [] 并 warn 一次。
     * 启用方式：new MemoryEngine(dir, { retriever: 'embedding', retrieverOptions: { embedder: fn } })
     * （embedder 应为同步函数；异步向量化引擎接入时需在调用方做 await 包装）
     * @param {string} query
     * @param {number} [limit=5]
     * @param {string} [namespace]
     */
    retrieve(query, limit = 5, namespace = '') {
        if (!this._embedder) {
            warnOnce('embedding-no-embedder',
                'EmbeddingRetriever 未配置 embedder，本次检索返回空结果。'
                + "启用方式：new MemoryEngine(dir, { retriever: 'embedding', retrieverOptions: { embedder: fn } })");
            return [];
        }
        const docs = this._loadDocs(namespace);
        if (docs.length === 0) return [];

        const qv = this._embedder(query);
        if (!Array.isArray(qv)) return [];

        const scored = [];
        for (const d of docs) {
            const dv = this._embedder(d.content);
            if (!Array.isArray(dv)) continue;
            scored.push({
                type: d.type,
                content: d.content,
                namespace: namespace || '',
                score: this._cosine(qv, dv),
            });
        }
        return quotaSelect(scored, limit);
    }
}

/**
 * 统一工厂
 * @param {'inverted'|'embedding'} [type='inverted']
 * @param {object} [options]
 * @returns {InvertedIndexRetriever|EmbeddingRetriever}
 */
export function createRetriever(type = 'inverted', options = {}) {
    if (type === 'embedding') return new EmbeddingRetriever(options);
    return new InvertedIndexRetriever(options);
}
