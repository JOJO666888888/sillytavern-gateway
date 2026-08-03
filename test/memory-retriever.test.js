/**
 * 任务 2b：Memory 倒排检索测试
 *
 * 覆盖：
 *   - InvertedIndexRetriever：倒排正确性（命中正确段落、多词加权排序）、
 *     配额公平（单类型段落多不占满）、namespace 隔离、update 后失效重查
 *   - EmbeddingRetriever：无 embedder 时返回 []
 *   - MemoryEngine 接线：recall 契约不变（不含 score）、retriever 选项可选
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { tmpDir } from './helpers.js';
import { InvertedIndexRetriever, EmbeddingRetriever, createRetriever } from '../plugins/agent-framework/engine/memory-retriever.js';
import { createEmbedder } from '../plugins/agent-framework/engine/embedder.js';
import { MemoryEngine } from '../plugins/agent-framework/engine/memory-engine.js';

/** 构造一个内存版数据源（模拟 MemoryEngine.read） */
function makeSource(store) {
    return (type, namespace = '') => store[`${namespace}::${type}`] || '';
}

describe('Memory 倒排检索（任务 2b）', () => {
    test('倒排正确性：查询词命中正确段落', () => {
        const store = {
            '::project': '第一段 关于龙\n\n第二段 关于宝藏\n\n第三段 关于天空',
        };
        const r = new InvertedIndexRetriever();
        r.setSources(makeSource(store));

        const hitDragon = r.retrieve('龙', 5);
        assert.ok(hitDragon.length >= 1, '应命中龙相关段落');
        assert.ok(hitDragon.every(x => x.content.includes('龙')), '命中段落都应包含查询词');

        const hitTreasure = r.retrieve('宝藏', 5);
        assert.strictEqual(hitTreasure[0].content, '第二段 关于宝藏', '宝藏查询应命中对应段落');
    });

    test('多词加权排序：命中词越多排越前', () => {
        const store = {
            '::project': '龙 与 宝藏\n\n龙',
            '::reference': '宝藏',
        };
        const r = new InvertedIndexRetriever();
        r.setSources(makeSource(store));

        const results = r.retrieve('龙 宝藏', 5);
        assert.ok(results.length >= 3, '应返回全部 3 段命中');
        assert.strictEqual(results[0].content, '龙 与 宝藏', '命中 2 词的段落应排最前');
    });

    test('配额公平：单类型段落多不占满结果上限', () => {
        const store = {
            '::project': ['段落一 关于龙', '段落二 关于龙', '段落三 关于龙',
                '段落四 关于龙', '段落五 关于龙', '段落六 关于龙'].join('\n\n'),
            '::reference': '只有一条关于龙的参考',
        };
        const r = new InvertedIndexRetriever();
        r.setSources(makeSource(store));

        const results = r.retrieve('龙', 5);
        assert.ok(results.length <= 5, `结果数应 <= limit(5)，实际 ${results.length}`);
        assert.ok(results.some(x => x.type === 'reference'), 'reference 类型应有机会被检索到');
    });

    test('namespace 隔离：char:alice 与全局不串扰', () => {
        const store = {
            '::reference': 'Alice 见过龙',
            '::project': 'Bob 见过巨人',
            'char:alice::reference': 'Alice 的独立记忆',
        };
        const r = new InvertedIndexRetriever();
        r.setSources(makeSource(store));

        const global = r.retrieve('龙', 5, '');
        assert.ok(global.some(x => x.content.includes('龙')));
        assert.ok(!global.some(x => x.content.includes('Alice 的独立记忆')), '全局检索不应包含角色记忆');

        const alice = r.retrieve('Alice 的独立记忆', 5, 'char:alice');
        assert.ok(alice.length >= 1, '角色命名空间应命中自身内容');
        assert.ok(alice.every(x => x.namespace === 'char:alice'), '结果 namespace 应为 char:alice');
    });

    test('update 后失效重查返回新内容（引擎接线）', async () => {
        const { dir, cleanup } = tmpDir();
        try {
            const engine = new MemoryEngine(dir);
            engine.update('project', '旧内容 关于龙');
            let results = await engine.recall('龙', 5);
            assert.ok(results.some(x => x.content.includes('旧内容')), '首次检索应命中旧内容');

            engine.update('project', '新内容 关于凤凰');
            results = await engine.recall('凤凰', 5);
            assert.ok(results.some(x => x.content.includes('新内容')), 'update 后应能检索到新内容');
            assert.ok(!results.some(x => x.content.includes('旧内容')), 'update 后不应残留旧内容');

            // 契约：返回对象不含 score
            assert.ok(results.every(x => !('score' in x)), 'recall 返回对象不应含 score 字段');
        } finally {
            cleanup();
        }
    });

    test('append 后失效重查（引擎接线）', async () => {
        const { dir, cleanup } = tmpDir();
        try {
            const engine = new MemoryEngine(dir);
            engine.append('user', '第一段记忆');
            engine.append('user', '第二段记忆 关于喜好');
            const results = await engine.recall('喜好', 5);
            assert.ok(results.some(x => x.content.includes('第二段记忆')), 'append 后应能检索到新增内容');
        } finally {
            cleanup();
        }
    });

    test('空查询返回空数组（契约不变）', () => {
        const store = { '::project': '任意内容' };
        const r = new InvertedIndexRetriever();
        r.setSources(makeSource(store));
        assert.deepStrictEqual(r.retrieve('   ', 5), []);
    });

    test('无数据源返回空数组', () => {
        const r = new InvertedIndexRetriever();
        assert.deepStrictEqual(r.retrieve('龙', 5), []);
    });
});

describe('EmbeddingRetriever 接口预留', () => {
    test('无 embedder 时返回 [] 并 warn 一次', async () => {
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (msg) => { warnings.push(msg); };
        try {
            const r = new EmbeddingRetriever();
            r.setSources(() => '龙 的内容');
            const first = await r.retrieve('龙', 5);
            const second = await r.retrieve('龙', 5);
            assert.deepStrictEqual(first, [], '无 embedder 应返回 []');
            assert.deepStrictEqual(second, [], '重复调用仍返回 []');
            assert.strictEqual(warnings.filter(w => String(w).includes('未配置 embedder')).length, 1,
                '未配置 embedder 的警告应只出现一次');
        } finally {
            console.warn = origWarn;
        }
    });

    test('createRetriever 工厂：默认 inverted，embedding 类型正确', () => {
        assert.ok(createRetriever() instanceof InvertedIndexRetriever, '默认应为倒排检索器');
        assert.ok(createRetriever('inverted') instanceof InvertedIndexRetriever);
        assert.ok(createRetriever('embedding') instanceof EmbeddingRetriever);
    });

    test('MemoryEngine retriever 选项可切换为 embedding（无 embedder 空结果）', async () => {
        const { dir, cleanup } = tmpDir();
        try {
            const engine = new MemoryEngine(dir, { retriever: 'embedding' });
            engine.update('project', '龙 的内容');
            const results = await engine.recall('龙', 5);
            assert.deepStrictEqual(results, [], 'embedding 引擎未配置 embedder 时 recall 返回 []');
        } finally {
            cleanup();
        }
    });
});

describe('嵌入向量引擎启用（createEmbedder）', () => {
    test('local embedder：确定性 + 归一化 + 语义相关命中', async () => {
        const { dir, cleanup } = tmpDir();
        try {
            const engine = new MemoryEngine(dir, {
                retriever: 'embedding',
                retrieverOptions: { embedder: createEmbedder('local') },
            });
            engine.update('project', '龙 与 宝藏 的传说\n\n关于 星空的 观测 记录');
            const results = await engine.recall('龙 宝藏', 5);
            assert.ok(results.length >= 1, 'embedding 引擎应返回命中段落');
            assert.ok(results[0].content.includes('龙'), 'query 相关段落应排最前');
            assert.ok(results.every(x => !('score' in x)), 'recall 返回对象不应含 score 字段');
        } finally {
            cleanup();
        }
    });

    test('api embedder：mock /embeddings 端点返回向量', async () => {
        const calls = [];
        const origFetch = global.fetch;
        global.fetch = async (url, init) => {
            calls.push({ url: String(url), init });
            return {
                ok: true,
                json: async () => ({ data: [{ embedding: [1, 0, 0, 1] }] }),
            };
        };
        try {
            const embedder = createEmbedder('api', { baseUrl: 'http://mock/v1', apiKey: 'sk-test' });
            const vec = await embedder('龙');
            assert.deepStrictEqual(vec, [1, 0, 0, 1]);
            // 缓存：相同文本不重复请求
            await embedder('龙');
            assert.strictEqual(calls.length, 1, '相同文本应命中缓存，只请求一次');
            assert.ok(String(calls[0].url).endsWith('/embeddings'), '应请求 /embeddings 端点');
            assert.ok(String(calls[0].init.headers.Authorization).includes('sk-test'));
        } finally {
            global.fetch = origFetch;
        }
    });

    test('api embedder：非 200 抛出可读错误', async () => {
        const origFetch = global.fetch;
        global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
        try {
            const embedder = createEmbedder('api', { baseUrl: 'http://mock/v1' });
            await assert.rejects(() => embedder('龙'), /401/);
        } finally {
            global.fetch = origFetch;
        }
    });

    test('api embedder：未配置 baseUrl 抛出配置错误', async () => {
        const embedder = createEmbedder('api', {});
        await assert.rejects(() => embedder('龙'), /embedderBaseUrl/);
    });
});

describe('Memory 倒排检索性能微基准（宽松）', () => {
    test('100 段记忆 recall 耗时上界（< 2s，防回归）', () => {
        const paras = [];
        for (let i = 0; i < 100; i++) {
            paras.push(`第${i}段 内容关键词${i} 与龙相关描述`);
        }
        const store = { '::project': paras.join('\n\n') };
        const r = new InvertedIndexRetriever();
        r.setSources(makeSource(store));

        // 预热并构建索引
        r.retrieve('龙', 5);
        const t0 = Date.now();
        for (let i = 0; i < 20; i++) {
            r.retrieve(`关键词${i * 5}`, 5);
        }
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 2000, `20 次检索应 < 2s，实际 ${elapsed}ms`);
    });
});
