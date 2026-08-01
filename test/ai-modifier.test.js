/**
 * AI 辅助修改 Profile 测试（Task: AI 辅助页面修改系统）
 *
 * 守护 server/ai-modifier.js 的核心逻辑：
 *   - extractJsonFromLlmOutput：直接 JSON / ```json 包裹 / 前后带文字 / 非法 JSON
 *   - validateNewYaml：空 / 砍内容 / tools 空 / maxTokens 超限 / maxSteps 超限 / 合法
 *   - createAiModifierHandlers：
 *       · /plan：mock LLM 返回合法 JSON → 返回 plan；返回 ```json 包裹 → 正确提取；
 *               返回非法 JSON → 清晰错误；返回 newYaml 为空 → 校验拒绝
 *       · /apply：快照被保存到历史栈
 *       · /undo：从历史栈恢复；栈空返回错误
 *       · /history：返回正确计数
 *
 * 不启动真实 HTTP 服务，直接调用 createAiModifierHandlers 返回的处理函数，
 * 用 mock req/res + mock llmService + 内存文件存储。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import {
    createAiModifierHandlers,
    extractJsonFromLlmOutput,
    validateNewYaml,
    buildPlanMessages,
    MAX_HISTORY,
    MAX_MAX_TOKENS,
    MAX_MAX_STEPS,
} from '../server/ai-modifier.js';

// ==================== mock req/res ====================

/** 构造 mock Express req */
function mockReq(opts = {}) {
    return {
        params: opts.params || {},
        query: opts.query || {},
        body: opts.body || {},
    };
}

/** 构造 mock Express res，捕获 status/json */
function mockRes() {
    const res = {
        statusCode: 200,
        _json: null,
        _sent: false,
        status(code) { this.statusCode = code; return this; },
        json(body) { this._json = body; this._sent = true; return this; },
        send(body) { this._json = body; this._sent = true; return this; },
    };
    return res;
}

// ==================== 共享夹具 ====================

/** 合法的当前 Profile YAML（带完整内容，长度足够） */
const CURRENT_YAML = `name: default-rp
displayName: 默认角色扮演
description: 开箱即用的默认 Agent 方案。

systemPrompt: |
  你是一位严谨而克制的叙事 GM。请产出沉浸式、连贯、有代价感的叙事正文。
  不要用 AI 八股味。每个场景结束时必须有价值逆转。

tools:
  - state.read
  - state.write
  - memory.recall
  - memory.update

context:
  historyLimit: 20
  injectFiles:
    - "styles/dark.md"
    - "memory/project.md"

subAgents:
  - name: critic-character
    trigger: after_draft

model:
  temperature: 0.85
  maxTokens: 32768

maxSteps: 12
`;

/** 构造一个合法的修改后 YAML（提高 temperature，保留其余结构） */
function buildModifiedYaml() {
    return CURRENT_YAML
        .replace('temperature: 0.85', 'temperature: 0.95')
        .replace('maxSteps: 12', 'maxSteps: 15');
}

/** 构造一个合法的 plan JSON 对象（LLM 的标准输出） */
function buildPlanObj(opts = {}) {
    return {
        understanding: opts.understanding !== undefined ? opts.understanding : '你想提高创造性和叙事步数',
        summary: opts.summary !== undefined ? opts.summary : '1. 把 model.temperature 从 0.85 调到 0.95\n2. 把 maxSteps 从 12 调到 15',
        riskLevel: opts.riskLevel !== undefined ? opts.riskLevel : 'low',
        riskNote: opts.riskNote !== undefined ? opts.riskNote : '',
        changes: opts.changes !== undefined ? opts.changes : [
            { field: 'model.temperature', from: '0.85', to: '0.95', reason: '提高创造性' },
            { field: 'maxSteps', from: '12', to: '15', reason: '增加叙事步数' },
        ],
        newYaml: opts.newYaml !== undefined ? opts.newYaml : buildModifiedYaml(),
    };
}

/** 构造 mock llmService：chat 方法返回给定字符串 */
function mockLlm(reply) {
    return {
        chat: async () => reply,
    };
}

/**
 * 构造处理器 + 内存存储 + 历史栈，便于每个测试用例隔离。
 * @param {object} opts - { llmReply, currentYaml, initialHistory }
 */
function makeHandlers(opts = {}) {
    const store = new Map(); // profileName -> yaml
    if (opts.currentYaml !== undefined) {
        store.set('default-rp', opts.currentYaml);
    } else {
        store.set('default-rp', CURRENT_YAML);
    }
    const history = opts.initialHistory ? new Map(opts.initialHistory) : new Map();
    const llm = opts.llm !== undefined ? opts.llm : mockLlm(JSON.stringify(buildPlanObj()));
    const writes = []; // 记录 writeYaml 调用
    const handlers = createAiModifierHandlers({
        getLlmService: () => llm,
        readCurrentYaml: (name) => store.get(name) || '',
        writeYaml: (name, yaml) => { store.set(name, yaml); writes.push({ name, yaml }); },
        history,
        logger: { info() {}, error() {}, warn() {}, debug() {} },
    });
    return { handlers, store, history, llm, writes };
}

// ==================== extractJsonFromLlmOutput ====================

describe('extractJsonFromLlmOutput', () => {
    test('直接 JSON 字符串', () => {
        const r = extractJsonFromLlmOutput('{"a":1,"b":"x"}');
        assert.ok(r.ok);
        assert.deepStrictEqual(r.value, { a: 1, b: 'x' });
    });

    test('```json 围裹的 JSON', () => {
        const r = extractJsonFromLlmOutput('```json\n{"a":1}\n```');
        assert.ok(r.ok);
        assert.deepStrictEqual(r.value, { a: 1 });
    });

    test('``` 围裹（无 lang 标记）的 JSON', () => {
        const r = extractJsonFromLlmOutput('```\n{"a":1}\n```');
        assert.ok(r.ok);
        assert.deepStrictEqual(r.value, { a: 1 });
    });

    test('前后带解释文字的 JSON', () => {
        const r = extractJsonFromLlmOutput('好的，结果如下：\n```json\n{"a":1}\n```\n请审阅。');
        assert.ok(r.ok);
        assert.deepStrictEqual(r.value, { a: 1 });
    });

    test('只有开头围栏（无结尾）的 JSON', () => {
        const r = extractJsonFromLlmOutput('```json\n{"a":1}');
        assert.ok(r.ok);
        assert.deepStrictEqual(r.value, { a: 1 });
    });

    test('完全非法的文本返回错误', () => {
        const r = extractJsonFromLlmOutput('这不是 JSON，完全没有花括号');
        assert.ok(!r.ok);
        assert.match(r.error, /未找到可解析的 JSON/);
    });

    test('空字符串返回错误', () => {
        const r = extractJsonFromLlmOutput('');
        assert.ok(!r.ok);
    });

    test('畸形 JSON 返回错误信息', () => {
        const r = extractJsonFromLlmOutput('{a: 1, b: }');
        assert.ok(!r.ok);
        assert.match(r.error, /JSON/);
    });
});

// ==================== validateNewYaml ====================

describe('validateNewYaml', () => {
    test('合法 YAML 通过', () => {
        const r = validateNewYaml(buildModifiedYaml(), CURRENT_YAML);
        assert.ok(r.ok, r.error || '');
    });

    test('空 YAML 被拒', () => {
        const r = validateNewYaml('', CURRENT_YAML);
        assert.ok(!r.ok);
        assert.match(r.error, /为空/);
    });

    test('newYaml 比原文短太多被拒', () => {
        const short = 'name: default-rp\n';
        const r = validateNewYaml(short, CURRENT_YAML);
        assert.ok(!r.ok);
        assert.match(r.error, /内容丢失|长度/);
    });

    test('tools: [] 被拒', () => {
        const y = CURRENT_YAML.replace(/tools:[\s\S]*?(?=\ncontext:)/, 'tools: []\n');
        const r = validateNewYaml(y, CURRENT_YAML);
        assert.ok(!r.ok);
        assert.match(r.error, /tools/);
    });

    test('tools 块无条目被拒', () => {
        // 构造一个 tools: 后面跟着空块再接 context 的 YAML
        const y = CURRENT_YAML.replace(/tools:[\s\S]*?(?=\ncontext:)/, 'tools:\n\n');
        const r = validateNewYaml(y, CURRENT_YAML);
        assert.ok(!r.ok);
        assert.match(r.error, /tools/);
    });

    test('maxTokens 超过上限被拒', () => {
        const y = buildModifiedYaml().replace('maxTokens: 32768', `maxTokens: ${MAX_MAX_TOKENS + 1}`);
        const r = validateNewYaml(y, CURRENT_YAML);
        assert.ok(!r.ok);
        assert.match(r.error, /maxTokens/);
    });

    test('maxSteps 超过上限被拒', () => {
        const y = buildModifiedYaml().replace('maxSteps: 15', `maxSteps: ${MAX_MAX_STEPS + 1}`);
        const r = validateNewYaml(y, CURRENT_YAML);
        assert.ok(!r.ok);
        assert.match(r.error, /maxSteps/);
    });

    test('maxTokens 正好等于上限通过', () => {
        const y = buildModifiedYaml().replace('maxTokens: 32768', `maxTokens: ${MAX_MAX_TOKENS}`);
        const r = validateNewYaml(y, CURRENT_YAML);
        assert.ok(r.ok, r.error || '');
    });

    test('无 currentYaml 时跳过长度对比', () => {
        const r = validateNewYaml(buildModifiedYaml(), '');
        assert.ok(r.ok, r.error || '');
    });
});

// ==================== buildPlanMessages ====================

describe('buildPlanMessages', () => {
    test('返回 system + user 两条消息', () => {
        const msgs = buildPlanMessages('更黑暗一点', CURRENT_YAML);
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[0].role, 'system');
        assert.strictEqual(msgs[1].role, 'user');
    });

    test('system prompt 包含可修改字段与禁止规则', () => {
        const msgs = buildPlanMessages('x', CURRENT_YAML);
        const sys = msgs[0].content;
        assert.match(sys, /systemPrompt/);
        assert.match(sys, /tools/);
        assert.match(sys, /不能清空 systemPrompt/);
        assert.ok(sys.includes(String(MAX_MAX_TOKENS)));
        assert.ok(sys.includes(String(MAX_MAX_STEPS)));
    });

    test('user prompt 包含用户需求与当前 YAML', () => {
        const msgs = buildPlanMessages('让叙事更长', CURRENT_YAML);
        const u = msgs[1].content;
        assert.match(u, /让叙事更长/);
        assert.match(u, /default-rp/);
    });
});

// ==================== /plan 端点 ====================

describe('POST /plan', () => {
    test('mock LLM 返回合法 JSON → 返回 plan 结构完整', async () => {
        const { handlers } = makeHandlers({ llm: mockLlm(JSON.stringify(buildPlanObj())) });
        const req = mockReq({ body: { request: '提高创造性', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res._json.success);
        const plan = res._json.plan;
        assert.ok(plan);
        assert.strictEqual(plan.understanding, '你想提高创造性和叙事步数');
        assert.strictEqual(plan.riskLevel, 'low');
        assert.ok(Array.isArray(plan.changes));
        assert.strictEqual(plan.changes.length, 2);
        assert.ok(plan.newYaml.includes('temperature: 0.95'));
    });

    test('mock LLM 返回 ```json 包裹的 JSON → 正确提取', async () => {
        const wrapped = '好的，方案如下：\n```json\n' + JSON.stringify(buildPlanObj()) + '\n```\n请确认。';
        const { handlers } = makeHandlers({ llm: mockLlm(wrapped) });
        const req = mockReq({ body: { request: '提高创造性', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res._json.success);
        assert.ok(res._json.plan.newYaml.includes('temperature: 0.95'));
    });

    test('mock LLM 返回非法 JSON → 返回清晰错误', async () => {
        const { handlers } = makeHandlers({ llm: mockLlm('这根本不是 JSON { ') });
        const req = mockReq({ body: { request: '提高创造性', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.ok(res.statusCode >= 400);
        assert.ok(!res._json.success);
        assert.match(res._json.error, /解析失败|JSON/);
    });

    test('mock LLM 返回 newYaml 为空 → 校验拒绝', async () => {
        const bad = buildPlanObj({ newYaml: '' });
        const { handlers } = makeHandlers({ llm: mockLlm(JSON.stringify(bad)) });
        const req = mockReq({ body: { request: '清空', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.ok(res.statusCode >= 400);
        assert.ok(!res._json.success);
        assert.match(res._json.error, /为空|校验失败/);
    });

    test('缺少 request 字段 → 400', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ body: { profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /request/);
    });

    test('缺少 currentYaml → 400', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ body: { request: '改', profileName: 'default-rp', currentYaml: '' } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /currentYaml/);
    });

    test('llmService 未就绪 → 503', async () => {
        const { handlers } = makeHandlers({ llm: null });
        const req = mockReq({ body: { request: '改', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 503);
        assert.match(res._json.error, /runtime\.llm|未配置/);
    });

    test('LLM 输出缺少字段 → 502', async () => {
        const incomplete = JSON.stringify({ understanding: 'x', summary: 'y' }); // 缺 riskLevel/changes/newYaml
        const { handlers } = makeHandlers({ llm: mockLlm(incomplete) });
        const req = mockReq({ body: { request: '改', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 502);
        assert.match(res._json.error, /缺少字段/);
    });

    test('riskLevel 非法值被规范化为 medium', async () => {
        const p = buildPlanObj({ riskLevel: 'critical' });
        const { handlers } = makeHandlers({ llm: mockLlm(JSON.stringify(p)) });
        const req = mockReq({ body: { request: '改', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res._json.plan.riskLevel, 'medium');
    });

    test('LLM 抛异常 → 500', async () => {
        const errLlm = { chat: async () => { throw new Error('网络超时'); } };
        const { handlers } = makeHandlers({ llm: errLlm });
        const req = mockReq({ body: { request: '改', profileName: 'default-rp', currentYaml: CURRENT_YAML } });
        const res = mockRes();
        await handlers.plan(req, res);
        assert.strictEqual(res.statusCode, 500);
        assert.match(res._json.error, /网络超时/);
    });
});

// ==================== /apply 端点 ====================

describe('POST /apply', () => {
    test('快照被保存到历史栈', async () => {
        const { handlers, store, history } = makeHandlers();
        const newYaml = buildModifiedYaml();
        const req = mockReq({ body: { profileName: 'default-rp', newYaml } });
        const res = mockRes();
        await handlers.apply(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res._json.success);
        assert.ok(res._json.snapshotSaved);
        // 历史栈应包含 1 个快照（应用前的原 YAML）
        const stack = history.get('default-rp');
        assert.strictEqual(stack.length, 1);
        assert.strictEqual(stack[0], CURRENT_YAML);
        // 存储已被新 YAML 覆盖
        assert.strictEqual(store.get('default-rp'), newYaml);
    });

    test('多次 apply 累积快照', async () => {
        const { handlers, history } = makeHandlers();
        const y1 = buildModifiedYaml();
        const y2 = y1.replace('temperature: 0.95', 'temperature: 1.0');
        await handlers.apply(mockReq({ body: { profileName: 'default-rp', newYaml: y1 } }), mockRes());
        await handlers.apply(mockReq({ body: { profileName: 'default-rp', newYaml: y2 } }), mockRes());
        const stack = history.get('default-rp');
        assert.strictEqual(stack.length, 2);
        assert.strictEqual(stack[0], CURRENT_YAML);
        assert.strictEqual(stack[1], y1);
    });

    test('缺少 profileName → 400', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ body: { newYaml: 'x' } });
        const res = mockRes();
        await handlers.apply(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /profileName/);
    });

    test('缺少 newYaml → 400', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ body: { profileName: 'default-rp' } });
        const res = mockRes();
        await handlers.apply(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /newYaml/);
    });

    test('writeYaml 抛异常 → 500', async () => {
        const { handlers } = makeHandlers();
        // 替换 store 的 writeYaml 为抛错版本：直接用新 handlers
        const errHandlers = createAiModifierHandlers({
            getLlmService: () => mockLlm('x'),
            readCurrentYaml: () => CURRENT_YAML,
            writeYaml: () => { throw new Error('磁盘已满'); },
            history: new Map(),
            logger: { info() {}, error() {}, warn() {}, debug() {} },
        });
        const req = mockReq({ body: { profileName: 'default-rp', newYaml: buildModifiedYaml() } });
        const res = mockRes();
        await errHandlers.apply(req, res);
        assert.strictEqual(res.statusCode, 500);
        assert.match(res._json.error, /磁盘已满/);
    });

    test('历史栈超过 MAX_HISTORY 丢弃最旧', async () => {
        const { handlers, history } = makeHandlers();
        // 预填满到上限
        const stack = [];
        for (let i = 0; i < MAX_HISTORY; i++) stack.push('snapshot-' + i);
        history.set('default-rp', stack.slice());
        // 再 apply 一次
        await handlers.apply(
            mockReq({ body: { profileName: 'default-rp', newYaml: buildModifiedYaml() } }),
            mockRes()
        );
        const after = history.get('default-rp');
        assert.strictEqual(after.length, MAX_HISTORY);
        // 最旧的 snapshot-0 应被丢弃
        assert.ok(!after.includes('snapshot-0'));
        assert.ok(after.includes('snapshot-1'));
    });
});

// ==================== /undo 端点 ====================

describe('POST /undo', () => {
    test('从历史栈恢复', async () => {
        const { handlers, store, history } = makeHandlers();
        // 先 apply 一次产生快照
        const newYaml = buildModifiedYaml();
        await handlers.apply(
            mockReq({ body: { profileName: 'default-rp', newYaml } }),
            mockRes()
        );
        assert.strictEqual(store.get('default-rp'), newYaml);

        // undo
        const req = mockReq({ body: { profileName: 'default-rp' } });
        const res = mockRes();
        await handlers.undo(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res._json.success);
        assert.strictEqual(res._json.restoredYaml, CURRENT_YAML);
        assert.strictEqual(res._json.remaining, 0);
        // 存储已恢复为原 YAML
        assert.strictEqual(store.get('default-rp'), CURRENT_YAML);
        // 栈空
        assert.strictEqual((history.get('default-rp') || []).length, 0);
    });

    test('历史栈空时返回错误', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ body: { profileName: 'default-rp' } });
        const res = mockRes();
        await handlers.undo(req, res);
        assert.ok(res.statusCode >= 400);
        assert.ok(!res._json.success);
        assert.match(res._json.error, /没有可撤销/);
    });

    test('缺少 profileName → 400', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ body: {} });
        const res = mockRes();
        await handlers.undo(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /profileName/);
    });

    test('undo 多次按 LIFO 顺序恢复', async () => {
        const { handlers, store } = makeHandlers();
        const y1 = buildModifiedYaml();
        const y2 = y1.replace('temperature: 0.95', 'temperature: 1.0');
        await handlers.apply(mockReq({ body: { profileName: 'default-rp', newYaml: y1 } }), mockRes());
        await handlers.apply(mockReq({ body: { profileName: 'default-rp', newYaml: y2 } }), mockRes());
        // 当前是 y2
        assert.strictEqual(store.get('default-rp'), y2);
        // 第一次 undo → 恢复 y1
        let res = mockRes();
        await handlers.undo(mockReq({ body: { profileName: 'default-rp' } }), res);
        assert.strictEqual(res._json.restoredYaml, y1);
        assert.strictEqual(res._json.remaining, 1);
        // 第二次 undo → 恢复原始
        res = mockRes();
        await handlers.undo(mockReq({ body: { profileName: 'default-rp' } }), res);
        assert.strictEqual(res._json.restoredYaml, CURRENT_YAML);
        assert.strictEqual(res._json.remaining, 0);
        // 第三次 undo → 报错
        res = mockRes();
        await handlers.undo(mockReq({ body: { profileName: 'default-rp' } }), res);
        assert.ok(!res._json.success);
    });

    test('undo 写失败时快照放回栈（不丢失撤销机会）', async () => {
        let writeFail = false;
        const history = new Map();
        history.set('default-rp', ['snapshot-A']);
        const handlers = createAiModifierHandlers({
            getLlmService: () => mockLlm('x'),
            readCurrentYaml: () => CURRENT_YAML,
            writeYaml: () => { if (writeFail) throw new Error('写失败'); },
            history,
            logger: { info() {}, error() {}, warn() {}, debug() {} },
        });
        writeFail = true;
        const res = mockRes();
        await handlers.undo(mockReq({ body: { profileName: 'default-rp' } }), res);
        assert.strictEqual(res.statusCode, 500);
        // 快照应被放回栈
        assert.strictEqual(history.get('default-rp').length, 1);
        assert.strictEqual(history.get('default-rp')[0], 'snapshot-A');
    });
});

// ==================== /history 端点 ====================

describe('GET /history', () => {
    test('返回正确计数', async () => {
        const history = new Map();
        history.set('default-rp', ['s1', 's2', 's3']);
        const { handlers } = makeHandlers({ initialHistory: [['default-rp', ['s1', 's2', 's3']]] });
        const req = mockReq({ query: { profileName: 'default-rp' } });
        const res = mockRes();
        handlers.history(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res._json.success);
        assert.strictEqual(res._json.count, 3);
        assert.strictEqual(res._json.canUndo, true);
    });

    test('无历史时 canUndo=false', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ query: { profileName: 'default-rp' } });
        const res = mockRes();
        handlers.history(req, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res._json.count, 0);
        assert.strictEqual(res._json.canUndo, false);
    });

    test('未知 profile 返回 count=0', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ query: { profileName: 'nonexistent' } });
        const res = mockRes();
        handlers.history(req, res);
        assert.strictEqual(res._json.count, 0);
        assert.strictEqual(res._json.canUndo, false);
    });

    test('缺少 profileName → 400', async () => {
        const { handlers } = makeHandlers();
        const req = mockReq({ query: {} });
        const res = mockRes();
        handlers.history(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.match(res._json.error, /profileName/);
    });
});

// ==================== 端到端流程：plan → apply → undo ====================

describe('端到端流程 plan → apply → undo', () => {
    test('完整流程闭环', async () => {
        const { handlers, store, history } = makeHandlers();
        // 1. plan
        let res = mockRes();
        await handlers.plan(
            mockReq({ body: { request: '提高创造性', profileName: 'default-rp', currentYaml: CURRENT_YAML } }),
            res
        );
        assert.strictEqual(res.statusCode, 200);
        const plan = res._json.plan;
        const newYaml = plan.newYaml;

        // 2. apply
        res = mockRes();
        await handlers.apply(
            mockReq({ body: { profileName: 'default-rp', newYaml } }),
            res
        );
        assert.ok(res._json.success);
        assert.strictEqual(store.get('default-rp'), newYaml);

        // 3. history 应为 1
        res = mockRes();
        handlers.history(mockReq({ query: { profileName: 'default-rp' } }), res);
        assert.strictEqual(res._json.count, 1);

        // 4. undo
        res = mockRes();
        await handlers.undo(mockReq({ body: { profileName: 'default-rp' } }), res);
        assert.ok(res._json.success);
        assert.strictEqual(store.get('default-rp'), CURRENT_YAML);

        // 5. history 应为 0
        res = mockRes();
        handlers.history(mockReq({ query: { profileName: 'default-rp' } }), res);
        assert.strictEqual(res._json.count, 0);
        assert.strictEqual(res._json.canUndo, false);
    });
});
