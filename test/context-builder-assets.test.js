/**
 * ContextBuilder 资产注入 + 开场白机制测试（P1 / P2 / P3）
 *
 * 守护：
 *   - P1: _loadCharacterCard / _loadWorldbook 的容错加载（大小写扩展名、特殊字符文件名、
 *         目录扫描回退）、角色卡内嵌 character_book 激活注入、ContextBuilder.build 端到端注入
 *   - P1: 真实测试环境资产存在时（D:\QQbot\sillytavern-gateway\assets）用真实文件验证；
 *         不存在则跳过（不依赖不存在目录导致测试失败）
 *   - P3: normalizeCard 导出 first_message / alternate_greetings、getGreetingList/selectGreeting、
 *         AgentRunner.run 开场白注入（无历史 + 有角色卡时 prepend assistant 开场白）
 *   - P2: AgentRunner 捕获 lastPromptMap + onPromptBuilt 回调 + getLastPrompt 查询
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpDir, silentLogger, buildCharacterPng } from './helpers.js';
import { ContextBuilder } from '../server/agent/context-builder.js';
import { normalizeCard, loadCharacterCard } from '../server/runtime/card-loader.js';
import { activateEntries } from '../server/runtime/worldbook-engine.js';
import { AgentRunner } from '../plugins/agent-framework/engine/agent-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 真实测试环境资产目录（存在则用真实文件做回归验证，不存在跳过）。
// P3-3 修复：原硬编码 D:\QQbot\sillytavern-gateway\assets 导致其它机器整体 skip；
// 改为环境变量优先、回退仓库内 assets 目录（跨机器行为一致）。
const REAL_ASSETS = process.env.GATEWAY_TEST_ASSETS || path.join(__dirname, '..', 'assets');
const HAS_REAL_ASSETS = fs.existsSync(REAL_ASSETS);

const tmps = [];
function makeTmp() { const t = tmpDir('stgw-cb-'); tmps.push(t); return t.dir; }
after(() => { for (const t of tmps) t.cleanup(); });

/** 构造 assetsDir 指向临时目录的 ContextBuilder，并在 characters/worldbooks 下写好 fixture */
function makeBuilder() {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, 'characters'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'worldbooks'), { recursive: true });
    return { dir, builder: new ContextBuilder({ assetsDir: dir }) };
}

/** 构造带完整字段的 V2 角色卡 JSON fixture */
function fullCardJson(overrides = {}) {
    return {
        spec: 'chara_card_v2',
        data: {
            name: '测试角色',
            description: '她是测试角色。',
            personality: '温柔',
            scenario: '雨夜茶室',
            first_mes: '初次见面，你好。',
            mes_example: '<START>\n{{user}}: 你好\n{{char}}: 你好呀',
            alternate_greetings: ['另一个开场', '再一个开场'],
            character_book: {
                entries: [
                    { keys: ['茶'], content: '茶室设定：她泡的茶有茉莉香。' },
                    { keys: [], content: '常驻设定：她叫测试角色。', constant: true },
                ],
            },
            ...overrides,
        },
    };
}

// ==================== P1: 角色卡 / 世界书加载 ====================

describe('P1 - _loadCharacterCard 归一化（fixture）', () => {
    test('.json 角色卡归一化完整（含 first_message / alternateGreetings）', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '测试角色.json'), JSON.stringify(fullCardJson()));

        const card = builder._loadCharacterCard('测试角色');
        assert.ok(card, '应加载到角色卡');
        assert.strictEqual(card.name, '测试角色');
        assert.strictEqual(card.description, '她是测试角色。');
        assert.strictEqual(card.personality, '温柔');
        assert.strictEqual(card.scenario, '雨夜茶室');
        assert.strictEqual(card.mesExample.includes('你好呀'), true);
        assert.strictEqual(card.first_message, '初次见面，你好。');
        assert.strictEqual(card.firstMes, '初次见面，你好。', 'firstMes 兼容别名应保留');
        assert.deepStrictEqual(card.alternateGreetings, ['另一个开场', '再一个开场']);
    });

    test('.png 角色卡（tEXt 内嵌）归一化', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(
            path.join(dir, 'characters', 'png卡.png'),
            buildCharacterPng({ spec: 'chara_card_v2', data: { name: 'png卡', description: 'PNG 描述' } }),
        );

        const card = builder._loadCharacterCard('png卡');
        assert.ok(card);
        assert.strictEqual(card.name, 'png卡');
        assert.strictEqual(card.description, 'PNG 描述');
    });

    test('.PNG 大写扩展名可命中（带扩展名 + 无扩展名）', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(
            path.join(dir, 'characters', 'UpperCard.PNG'),
            buildCharacterPng({ spec: 'chara_card_v2', data: { name: 'UpperCard', description: 'd' } }),
        );

        assert.strictEqual(builder._loadCharacterCard('UpperCard.PNG')?.name, 'UpperCard', '带大写扩展名应命中');
        assert.strictEqual(builder._loadCharacterCard('UpperCard')?.name, 'UpperCard', '无扩展名应通过扫描回退命中');
    });

    test('特殊字符文件名（中文 + 括号）可命中', () => {
        const { dir, builder } = makeBuilder();
        const fname = '1软萌魔王的后宫征服计划(被).png';
        fs.writeFileSync(
            path.join(dir, 'characters', fname),
            buildCharacterPng({ spec: 'chara_card_v3', data: { name: '1软萌魔王的后宫征服计划(被)' } }),
        );

        assert.strictEqual(builder._loadCharacterCard('1软萌魔王的后宫征服计划(被)')?.name, '1软萌魔王的后宫征服计划(被)');
        assert.strictEqual(builder._loadCharacterCard(fname)?.name, '1软萌魔王的后宫征服计划(被)', '带扩展名应命中');
    });

    test('不存在的角色卡返回 null（不抛错）', () => {
        const { builder } = makeBuilder();
        assert.strictEqual(builder._loadCharacterCard('不存在卡'), null);
    });
});

describe('P1 - _loadWorldbook + activateEntries（fixture）', () => {
    test('世界书加载并可按关键词激活', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'worldbooks', '世界书A.json'), JSON.stringify({
            entries: [
                { uid: 1, keys: ['魔法'], content: '魔法体系设定', insertion_order: 1 },
                { uid: 2, keys: [], content: '常驻世界观', constant: true, insertion_order: 2 },
            ],
        }));

        const entries = builder._loadWorldbook('世界书A');
        assert.ok(entries);
        assert.strictEqual(entries.length, 2);

        const r1 = activateEntries(entries, '我想学魔法');
        assert.deepStrictEqual(r1.activated.map(e => e.content), ['魔法体系设定', '常驻世界观'], '关键词 + 常驻按 order 排序');
        const r2 = activateEntries(entries, '今天天气不错');
        assert.deepStrictEqual(r2.activated.map(e => e.content), ['常驻世界观'], '无关键词时仅常驻激活');
    });

    test('特殊字符世界书文件名（连字符 + 全角符号）无扩展名可命中', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(
            path.join(dir, 'worldbooks', '------------师妹的系统目标是我？.json'),
            JSON.stringify({ entries: [{ uid: 1, keys: ['目标'], content: '她盯上你了' }] }),
        );

        const entries = builder._loadWorldbook('------------师妹的系统目标是我？');
        assert.ok(entries, '无扩展名应通过扫描回退命中');
        assert.strictEqual(entries.length, 1);
    });

    test('不存在的世界书返回 null', () => {
        const { builder } = makeBuilder();
        assert.strictEqual(builder._loadWorldbook('不存在书'), null);
    });
});

describe('P1 - ContextBuilder.build 端到端注入（fixture）', () => {
    test('角色卡 + 世界书 + 内嵌 character_book 全部注入 system', () => {
        const { dir, builder } = makeBuilder();
        // 角色卡：description 非空 + 内嵌 character_book
        fs.writeFileSync(path.join(dir, 'characters', '测试角色.json'), JSON.stringify(fullCardJson()));
        // 世界书
        fs.writeFileSync(path.join(dir, 'worldbooks', '世界书A.json'), JSON.stringify({
            entries: [{ uid: 1, keys: ['雨夜'], content: '雨夜茶室场景设定' }],
        }));

        const definition = {
            name: 'default-rp',
            systemPrompt: '你是一位叙事 GM。',
            context: {
                injectAssets: { character: '${character}', worldbook: '${worldbook}' },
            },
        };
        const session = { character: '测试角色', worldbook: '世界书A' };
        const history = [{ role: 'user', content: '雨夜里我走进茶室' }];
        const messages = builder.build(definition, session, history, '继续');

        const system = messages.find(m => m.role === 'system')?.content || '';
        assert.ok(system.includes('【角色描述】'), '应注入角色描述');
        assert.ok(system.includes('【性格】'), '应注入性格');
        assert.ok(system.includes('【角色内嵌世界书】'), '应注入角色卡内嵌世界书（P1 修复）');
        assert.ok(system.includes('常驻设定'), '内嵌世界书常驻条目应激活');
        assert.ok(system.includes('【世界书】'), '应注入独立世界书');
        assert.ok(system.includes('雨夜茶室场景设定'), '世界书关键词条目应激活');
    });

    test('V3 卡 description 为空时，内嵌 character_book 仍注入（真实卡形态）', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '纯书驱动卡.json'), JSON.stringify({
            spec: 'chara_card_v3',
            data: {
                name: '纯书驱动卡',
                description: '',
                personality: '',
                character_book: { entries: [{ keys: [], content: '人物全在内嵌书里', constant: true }] },
            },
        }));

        const definition = {
            name: 'x',
            systemPrompt: 'sys',
            context: { injectAssets: { character: '${character}' } },
        };
        const system = builder.build(definition, { character: '纯书驱动卡' }, [], '你好')
            .find(m => m.role === 'system')?.content || '';
        assert.ok(!system.includes('【角色描述】'), 'description 为空不应输出空描述段');
        assert.ok(system.includes('【角色内嵌世界书】'), '内嵌世界书应注入');
        assert.ok(system.includes('人物全在内嵌书里'));
    });
});

// ==================== P1: 真实资产回归（存在才跑） ====================

describe('P1 - 真实测试环境资产回归（D:\\QQbot\\sillytavern-gateway\\assets）', { skip: !HAS_REAL_ASSETS }, () => {
    test('真实 .png 角色卡加载 + 归一化字段完整', () => {
        const charsDir = path.join(REAL_ASSETS, 'characters');
        const files = fs.readdirSync(charsDir).filter(f => f.endsWith('.png'));
        assert.ok(files.length >= 2, `至少应有 2 个角色卡，实际 ${files.length}`);
        for (const f of files.slice(0, 3)) {
            const card = loadCharacterCard(path.join(charsDir, f));
            assert.ok(card.name, `${f} 应解析出 name`);
            assert.ok('first_message' in card, `${f} 应归一化导出 first_message`);
            assert.ok(Array.isArray(card.alternateGreetings), `${f} 应归一化导出 alternateGreetings`);
        }
    });

    test('ContextBuilder 用无扩展名特殊字符文件名加载真实角色卡/世界书并注入', () => {
        const builder = new ContextBuilder({ assetsDir: REAL_ASSETS });
        const chars = fs.readdirSync(path.join(REAL_ASSETS, 'characters')).filter(f => f.endsWith('.png'));
        const books = fs.readdirSync(path.join(REAL_ASSETS, 'worldbooks')).filter(f => f.endsWith('.json'));
        assert.ok(chars.length >= 1 && books.length >= 1);

        // 用真实文件名（去扩展名）作为会话值，验证容错匹配
        const charName = path.basename(chars[0], '.png');
        const bookName = path.basename(books[0], '.json');
        const definition = {
            name: 'default-rp',
            systemPrompt: '你是一位叙事 GM。',
            context: { injectAssets: { character: '${character}', worldbook: '${worldbook}' } },
        };
        const messages = builder.build(definition, { character: charName, worldbook: bookName }, [], '你好');
        const system = messages.find(m => m.role === 'system')?.content || '';
        // 真实 V3 卡 description 可能为空，但内嵌 character_book 或独立世界书至少有一方注入
        assert.ok(
            system.includes('【角色内嵌世界书】') || system.includes('【世界书】'),
            `system 应包含角色内嵌世界书或独立世界书（卡=${charName}, 书=${bookName}）`,
        );
    });
});

// ==================== P3: 开场白机制 ====================

describe('P3 - normalizeCard 开场白字段', () => {
    test('V1/V2 first_mes → first_message / firstMes 别名齐全', () => {
        const v1 = normalizeCard({ name: '老卡', first_mes: 'V1 开场' });
        assert.strictEqual(v1.first_message, 'V1 开场');
        assert.strictEqual(v1.firstMes, 'V1 开场');

        const v2 = normalizeCard({ spec: 'chara_card_v2', data: { name: '新卡', first_mes: 'V2 开场' } });
        assert.strictEqual(v2.first_message, 'V2 开场');
        assert.strictEqual(v2.first_message, v2.firstMes);
    });

    test('alternate_greetings / alternateGreetings 双命名导出', () => {
        const card = normalizeCard({
            spec: 'chara_card_v2',
            data: { name: 'x', alternate_greetings: ['A', 'B'] },
        });
        assert.deepStrictEqual(card.alternateGreetings, ['A', 'B']);
        assert.deepStrictEqual(card.alternate_greetings, ['A', 'B']);
    });
});

describe('P3 - ContextBuilder.getGreetingList / selectGreeting', () => {
    test('getGreetingList 返回 first_message + alternate_greetings 合并列表', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '测试角色.json'), JSON.stringify(fullCardJson()));

        const list = builder.getGreetingList('测试角色');
        assert.ok(list);
        assert.strictEqual(list.character, '测试角色');
        assert.strictEqual(list.firstMessage, '初次见面，你好。');
        assert.deepStrictEqual(list.alternateGreetings, ['另一个开场', '再一个开场']);
        assert.deepStrictEqual(list.greetings, ['初次见面，你好。', '另一个开场', '再一个开场']);
    });

    test('selectGreeting 按序号选择，越界取模，无开场白返回空串', () => {
        const { dir, builder } = makeBuilder();
        fs.writeFileSync(path.join(dir, 'characters', '测试角色.json'), JSON.stringify(fullCardJson()));

        assert.strictEqual(builder.selectGreeting('测试角色', 0), '初次见面，你好。');
        assert.strictEqual(builder.selectGreeting('测试角色', 1), '另一个开场');
        assert.strictEqual(builder.selectGreeting('测试角色', 2), '再一个开场');
        assert.strictEqual(builder.selectGreeting('测试角色', 3), '初次见面，你好。', '越界应取模循环（3 % 3 = 0）');
        assert.strictEqual(builder.selectGreeting('测试角色', 4), '另一个开场', '越界应取模循环（4 % 3 = 1）');
        assert.strictEqual(builder.selectGreeting('不存在卡', 0), '');
    });
});

// ==================== P3 + P2: AgentRunner 开场白注入 + 提示词捕获 ====================

/** 构造可捕获 build 参数的 mock contextBuilder（行为与真实 ContextBuilder 一致） */
function makeFakeContextBuilder() {
    return {
        builds: [],
        build(definition, session, history, userMessage) {
            const messages = [{ role: 'system', content: 'sys' }, ...history];
            if (userMessage) messages.push({ role: 'user', content: userMessage });
            this.builds.push({ session, history, userMessage });
            return messages;
        },
        selectGreeting(name, idx) {
            return name === '测试角色' ? `开场白${idx ?? 0}` : '';
        },
    };
}

function makeRunner(cb, opts = {}) {
    return new AgentRunner({
        contextBuilder: cb,
        toolRegistry: {
            getDeclarations: () => [],
            createExecutor: () => async () => 'ok',
        },
        stateManager: { flush: () => {} },
        logger: silentLogger,
        ...opts,
    });
}

const LLM = { runToolsStream: async () => ({ text: '正文', steps: 1 }) };
const DEF = { name: 'test-agent', tools: [], maxSteps: 5, model: {} };

describe('P3 - AgentRunner.run 开场白注入', () => {
    test('无历史 + 有角色卡 + 有开场白 → 开场白作为首条 assistant 消息 + system 注明', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);
        const session = { character: '测试角色', platform: 'native', chatId: 'c1' };

        await runner.run(DEF, session, [], '你好', { llm: LLM });

        const rec = runner.getLastPrompt('native:c1');
        assert.ok(rec, '应捕获提示词');
        const roles = rec.messages.map(m => m.role);
        assert.deepStrictEqual(roles, ['system', 'assistant', 'user'], '开场白应插在 system 与 user 之间');
        assert.strictEqual(rec.messages[1].content, '开场白0');
        assert.match(rec.messages[0].content, /开场白已展示/, 'system 应注明开场白已展示');
    });

    test('有历史时不再注入开场白', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);
        const session = { character: '测试角色', platform: 'native', chatId: 'c1' };
        const history = [{ role: 'user', content: '之前聊过' }, { role: 'assistant', content: '是啊' }];

        await runner.run(DEF, session, history, '继续', { llm: LLM });

        const rec = runner.getLastPrompt('native:c1');
        const roles = rec.messages.map(m => m.role);
        assert.deepStrictEqual(roles, ['system', 'user', 'assistant', 'user'], '历史原样透传，无开场白');
        assert.ok(!rec.messages[0].content.includes('开场白已展示'));
    });

    test('greetingIndex 选择 alternate 开场白', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);
        const session = { character: '测试角色', greetingIndex: 2, platform: 'native', chatId: 'c2' };

        await runner.run(DEF, session, [], '你好', { llm: LLM });

        const rec = runner.getLastPrompt('native:c2');
        assert.strictEqual(rec.messages[1].content, '开场白2');
    });

    test('无开场白的卡 / 无角色卡 → 不注入开场白', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);

        // 无角色卡
        await runner.run(DEF, { platform: 'native', chatId: 'c3' }, [], '你好', { llm: LLM });
        let rec = runner.getLastPrompt('native:c3');
        assert.deepStrictEqual(rec.messages.map(m => m.role), ['system', 'user'], '无角色卡不注入');

        // 卡存在但 selectGreeting 返回空（模拟无开场白）
        const cb2 = makeFakeContextBuilder();
        cb2.selectGreeting = () => '';
        const runner2 = makeRunner(cb2);
        await runner2.run(DEF, { character: '测试角色', platform: 'native', chatId: 'c4' }, [], '你好', { llm: LLM });
        rec = runner2.getLastPrompt('native:c4');
        assert.deepStrictEqual(rec.messages.map(m => m.role), ['system', 'user'], '无开场白不注入');
    });
});

describe('P2 - AgentRunner 提示词捕获（lastPromptMap + onPromptBuilt + getLastPrompt）', () => {
    test('run 后 lastPromptMap 记录 messages/builtAt/runId，getLastPrompt 可查询', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);
        const result = await runner.run(DEF, { platform: 'native', chatId: 'p1' }, [], '你好', { llm: LLM });

        const rec = runner.getLastPrompt('native:p1');
        assert.ok(rec);
        assert.ok(Array.isArray(rec.messages) && rec.messages.length >= 2);
        assert.ok(typeof rec.builtAt === 'number');
        assert.strictEqual(rec.runId, result.runId);
    });

    test('未 run 过的会话 getLastPrompt 返回 null', () => {
        const runner = makeRunner(makeFakeContextBuilder());
        assert.strictEqual(runner.getLastPrompt('native:never'), null);
    });

    test('onPromptBuilt 回调在每次 run 构建后被调用并携带会话 key 与提示词', async () => {
        const cb = makeFakeContextBuilder();
        const calls = [];
        const runner = makeRunner(cb, {
            onPromptBuilt: (sessionKey, prompt) => calls.push({ sessionKey, prompt }),
        });

        await runner.run(DEF, { platform: 'native', chatId: 'p2' }, [], 'hi', { llm: LLM });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].sessionKey, 'native:p2');
        assert.ok(calls[0].prompt.messages.length >= 2);
        assert.ok(calls[0].prompt.builtAt);
    });

    test('lastPromptMap 按会话隔离，不同会话互不覆盖', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);
        await runner.run(DEF, { platform: 'native', chatId: 'A' }, [], '1', { llm: LLM });
        await runner.run(DEF, { platform: 'native', chatId: 'B' }, [], '2', { llm: LLM });

        const a = runner.getLastPrompt('native:A');
        const b = runner.getLastPrompt('native:B');
        assert.ok(a && b);
        assert.strictEqual(a.messages[a.messages.length - 1].content, '1');
        assert.strictEqual(b.messages[b.messages.length - 1].content, '2');
    });

    test('run 失败（LLM 抛错）时提示词仍已捕获（构建发生在 LLM 调用之前）', async () => {
        const cb = makeFakeContextBuilder();
        const runner = makeRunner(cb);
        const failingLlm = { runToolsStream: async () => { throw new Error('LLM 挂了'); } };

        const result = await runner.run(DEF, { platform: 'native', chatId: 'p3' }, [], 'hi', { llm: failingLlm });
        assert.ok(result.error, 'run 应返回错误结果而非抛出');
        const rec = runner.getLastPrompt('native:p3');
        assert.ok(rec, '即使 LLM 失败，构建出的提示词也应可查询');
    });
});
