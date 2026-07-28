/**
 * 自建推理管线 - Prompt 组装回归测试（P2-4/9/10）
 * 预设归一化、ST prompt_order 还原、token 估算与截断
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    normalizePreset, defaultPreset, buildPrompt, parseSTPromptOrder, listPresetEntries,
    estimateTokens, truncateHistoryByTokens,
} from '../server/runtime/preset-engine.js';

/** 构造一个典型的 ST 预设 */
function stPreset(overrides = {}) {
    return {
        temperature: 0.7,
        openai_max_tokens: 500,
        prompts: [
            { identifier: 'main', role: 'system', content: '你是角色扮演助手' },
            { identifier: 'worldInfoBefore', marker: true },
            { identifier: 'charDescription', marker: true },
            { identifier: 'chatHistory', marker: true },
            { identifier: 'jailbreak', role: 'system', content: '保持角色' },
            { identifier: 'nsfw', role: 'system', content: '不该出现的内容' },
            { identifier: 'custom1', role: 'user', content: '自定义用户条目' },
        ],
        prompt_order: [{
            character_id: 100001,
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'worldInfoBefore', enabled: true },
                { identifier: 'charDescription', enabled: true },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'custom1', enabled: true },
                { identifier: 'jailbreak', enabled: true },
                { identifier: 'nsfw', enabled: false }, // 关闭项
            ],
        }],
        ...overrides,
    };
}

describe('token 估算与截断', () => {
    test('CJK 约 1 token/字', () => {
        assert.strictEqual(estimateTokens('你好世界'), 4);
    });

    test('拉丁约 4 字符/token', () => {
        assert.strictEqual(estimateTokens('abcdefgh'), 2);
    });

    test('多模态 parts 计入图片开销', () => {
        const t = estimateTokens([{ type: 'text', text: 'hi' }, { type: 'image' }]);
        assert.ok(t > 800, `图片应有固定开销，实际 ${t}`);
    });

    test('空内容为 0', () => {
        assert.strictEqual(estimateTokens(''), 0);
        assert.strictEqual(estimateTokens(null), 0);
    });

    test('按预算截断并保留最近的对话', () => {
        const history = [
            { role: 'user', content: '一'.repeat(100) },
            { role: 'assistant', content: '二'.repeat(100) },
            { role: 'user', content: '最近一条' },
        ];
        const kept = truncateHistoryByTokens(history, 120);

        assert.ok(kept.length < history.length, '应发生截断');
        assert.strictEqual(kept[kept.length - 1].content, '最近一条', '必须保留最近的消息');
    });

    test('预算为 0 时不截断（按条数模式）', () => {
        const history = [{ role: 'user', content: 'x'.repeat(1000) }];
        assert.strictEqual(truncateHistoryByTokens(history, 0).length, 1);
    });

    test('buildPrompt 在预算内保留全部历史', () => {
        const history = [{ role: 'user', content: '短' }, { role: 'assistant', content: '也短' }];
        const r = buildPrompt({
            card: { name: 'C' }, preset: defaultPreset(),
            history, userInput: 'hi', tokenBudget: 100000,
        });
        const userMsgs = r.messages.filter(m => m.role === 'user');
        assert.ok(userMsgs.length >= 2, '预算充足时历史不应被截断');
    });
});

describe('ST 预设 prompt_order 还原', () => {
    test('marker 条目映射到内部段键', () => {
        const order = parseSTPromptOrder(stPreset());
        assert.strictEqual(order[1], 'worldBefore');
        assert.strictEqual(order[2], 'charDescription');
        assert.strictEqual(order[3], 'history');
    });

    test('普通条目还原为保留 role 的固定文本', () => {
        const order = parseSTPromptOrder(stPreset());
        assert.strictEqual(order[0].type, 'literal');
        assert.strictEqual(order[0].content, '你是角色扮演助手');
        assert.strictEqual(order[0].role, 'system');

        const custom = order.find(o => o.identifier === 'custom1');
        assert.strictEqual(custom.role, 'user', '自定义条目的 role 必须保留');
    });

    test('enabled:false 的条目被跳过', () => {
        const order = parseSTPromptOrder(stPreset());
        assert.ok(!JSON.stringify(order).includes('不该出现的内容'), '关闭的条目不得进入顺序表');
    });

    test('无 prompts/prompt_order 时返回 null（回退默认顺序）', () => {
        assert.strictEqual(parseSTPromptOrder({}), null);
        assert.strictEqual(parseSTPromptOrder({ prompts: [] }), null);
    });

    test('normalizePreset 采用 ST 顺序并提取采样参数', () => {
        const p = normalizePreset(stPreset());
        assert.strictEqual(p.orderSource, 'st_prompt_order');
        assert.strictEqual(p.sampling.temperature, 0.7);
        assert.strictEqual(p.sampling.max_tokens, 500, 'openai_max_tokens 应映射到 max_tokens');
    });

    test('gateway_order 优先级高于 ST prompt_order', () => {
        const p = normalizePreset({ ...stPreset(), gateway_order: ['system', 'history'] });
        assert.strictEqual(p.orderSource, 'gateway_order');
    });

    test('无预设时用内置默认顺序', () => {
        const p = defaultPreset();
        assert.strictEqual(p.orderSource, 'default');
        assert.ok(p.order.includes('history'));
    });
});

describe('条目级启停（disabledIds 覆盖 + listPresetEntries）', () => {
    test('disabledIds 覆盖禁用 prompt_order 条目', () => {
        const order = parseSTPromptOrder(stPreset(), new Set(['main']));
        assert.ok(!order.some(o => o && o.identifier === 'main'), 'main 被覆盖禁用应不在顺序表');
        assert.ok(order.some(o => o === 'worldBefore'), '未禁用的 marker 应保留');
    });

    test('disabledIds 与文件 enabled=false 叠加生效', () => {
        // nsfw 已 enabled:false；再覆盖禁用 jailbreak
        const order = parseSTPromptOrder(stPreset(), new Set(['jailbreak']));
        assert.ok(!JSON.stringify(order).includes('保持角色'), 'jailbreak 被覆盖禁用');
        assert.ok(!JSON.stringify(order).includes('不该出现的内容'), 'nsfw 文件级禁用仍生效');
    });

    test('listPresetEntries 列出所有条目含 enabled 与 isMarker', () => {
        const entries = listPresetEntries(stPreset());
        const ids = entries.map(e => e.id);
        assert.ok(ids.includes('main') && ids.includes('worldInfoBefore') && ids.includes('nsfw'));
        const nsfw = entries.find(e => e.id === 'nsfw');
        assert.strictEqual(nsfw.enabled, false, '文件 enabled=false 应反映');
        assert.strictEqual(entries.find(e => e.id === 'worldInfoBefore').isMarker, true, 'marker 条目标记');
        assert.strictEqual(entries.find(e => e.id === 'main').isMarker, false);
    });

    test('listPresetEntries 无 prompt_order 返回空', () => {
        assert.deepStrictEqual(listPresetEntries({ prompts: [] }), []);
        assert.deepStrictEqual(listPresetEntries({}), []);
    });

    test('normalizePreset 透传 disabledIds 到构建顺序', () => {
        const p = normalizePreset(stPreset(), new Set(['main']));
        assert.ok(!p.order.some(o => o && o.identifier === 'main'), '被禁条目不应进入构建顺序');
    });
});

describe('buildPrompt 组装结果', () => {
    const ctx = () => ({
        card: { name: '月见', description: '月下剑士', personality: '沉静' },
        preset: normalizePreset(stPreset()),
        world: { beforeChar: ['世界设定X'], afterChar: [] },
        history: [{ role: 'user', content: '历史一' }],
        userInput: '现在呢',
    });

    test('严格遵循 ST 定义的先后顺序', () => {
        const { messages } = buildPrompt(ctx());
        const flat = messages.map(m => (Array.isArray(m.content) ? '' : m.content)).join('||');

        assert.ok(flat.indexOf('你是角色扮演助手') < flat.indexOf('世界设定X'), 'main 应在 worldInfoBefore 之前');
        assert.ok(flat.indexOf('世界设定X') < flat.indexOf('月下剑士'), 'worldInfoBefore 应在 charDescription 之前');
        assert.ok(flat.indexOf('历史一') < flat.indexOf('自定义用户条目'), 'chatHistory 应在自定义条目之前');
    });

    test('自定义条目保留 user role', () => {
        const { messages } = buildPrompt(ctx());
        assert.ok(messages.some(m => m.role === 'user' && m.content === '自定义用户条目'));
    });

    test('用户输入作为最后一条 user 消息', () => {
        const { messages } = buildPrompt(ctx());
        assert.strictEqual(messages[messages.length - 1].content, '现在呢');
        assert.strictEqual(messages[messages.length - 1].role, 'user');
    });

    test('{{char}} / {{user}} 占位符被替换', () => {
        const { messages } = buildPrompt({
            card: { name: '月见', description: '{{char}} 认识 {{user}}' },
            preset: defaultPreset(),
            userInput: 'hi',
            userName: '阿星',
        });
        const flat = messages.map(m => m.content).join('||');
        assert.ok(flat.includes('月见 认识 阿星'));
        assert.ok(!flat.includes('{{char}}'), '占位符不应残留');
    });

    test('多模态 userInput（parts 数组）原样传递', () => {
        const parts = [{ type: 'text', text: '看图' }, { type: 'image', url: 'u' }];
        const { messages } = buildPrompt({
            card: { name: 'C' }, preset: defaultPreset(), userInput: parts,
        });
        assert.ok(Array.isArray(messages[messages.length - 1].content));
    });

    test('返回采样参数', () => {
        const { sampling } = buildPrompt(ctx());
        assert.strictEqual(sampling.temperature, 0.7);
    });

    test('世界书为空时不产生空段', () => {
        const { messages } = buildPrompt({
            card: { name: 'C', description: 'd' },
            preset: defaultPreset(),
            world: { beforeChar: [], afterChar: [] },
            userInput: 'hi',
        });
        assert.ok(messages.every(m => m.content && String(m.content).trim().length > 0), '不应有空消息');
    });
});
