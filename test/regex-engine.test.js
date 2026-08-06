/**
 * Regex Engine 单元测试
 * 覆盖：parseRegex / validateRegex / getRegexedString / importRegexFromCard
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    initRegexStore,
    getRegexStore,
    getRegexedString,
    validateRegex,
    importRegexFromCard,
    REGEX_PLACEMENT,
} from '../server/agent/regex-engine.js';

test('validateRegex - 合法正则', () => {
    const r = validateRegex('/foo/g');
    assert.equal(r.valid, true);
    const r2 = validateRegex('foo');
    assert.equal(r2.valid, true);
});

test('validateRegex - 非法正则', () => {
    const r = validateRegex('/(/g');
    assert.equal(r.valid, false);
    assert.ok(r.error);
});

test('validateRegex - 空', () => {
    assert.equal(validateRegex('').valid, false);
    assert.equal(validateRegex(null).valid, false);
});

test('getRegexedString - 基本替换 $1 捕获组', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/\\[(.+?)\\]/g',
        replaceString: '<$1>',
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
    };
    const out = getRegexedString('hello [world] !', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [script] });
    assert.equal(out, 'hello <world> !');
});

test('getRegexedString - {{match}} 完整匹配', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/\\*\\*(.+?)\\*\\*/g',
        replaceString: '[{{match}}]',
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
    };
    const out = getRegexedString('a **bold** b', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [script] });
    assert.equal(out, 'a [**bold**] b');
});

test('getRegexedString - promptOnly 仅提示词场景生效', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/secret/g',
        replaceString: '***',
        placement: [REGEX_PLACEMENT.USER_INPUT],
        disabled: false,
        promptOnly: true,
        markdownOnly: false,
    };
    // 提示词场景：生效
    const outPrompt = getRegexedString('tell me the secret', REGEX_PLACEMENT.USER_INPUT, { isPrompt: true, scripts: [script] });
    assert.equal(outPrompt, 'tell me the ***');
    // 非提示词场景：不生效
    const outOther = getRegexedString('tell me the secret', REGEX_PLACEMENT.USER_INPUT, { isPrompt: false, scripts: [script] });
    assert.equal(outOther, 'tell me the secret');
});

test('getRegexedString - markdownOnly 仅显示场景生效', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/\\/\\/\\//g',
        replaceString: '',
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        promptOnly: false,
        markdownOnly: true,
    };
    const out = getRegexedString('a /// b', REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true, scripts: [script] });
    assert.equal(out, 'a  b');
});

test('getRegexedString - disabled 脚本跳过', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/x/g',
        replaceString: 'y',
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: true,
    };
    assert.equal(getRegexedString('xxx', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [script] }), 'xxx');
});

test('getRegexedString - placement 不匹配跳过', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/x/g',
        replaceString: 'y',
        placement: [REGEX_PLACEMENT.WORLD_INFO],
        disabled: false,
    };
    assert.equal(getRegexedString('xxx', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [script] }), 'xxx');
});

test('getRegexedString - 非法正则返回原文', () => {
    const script = {
        scriptName: 'test',
        findRegex: '/(/g',
        replaceString: 'y',
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
    };
    assert.equal(getRegexedString('xxx', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [script] }), 'xxx');
});

test('getRegexedString - 多脚本顺序应用', () => {
    const s1 = { scriptName: 's1', findRegex: '/a/g', replaceString: 'b', placement: [1], disabled: false };
    const s2 = { scriptName: 's2', findRegex: '/b/g', replaceString: 'c', placement: [1], disabled: false };
    const out = getRegexedString('aaa', REGEX_PLACEMENT.USER_INPUT, { scripts: [s1, s2] });
    assert.equal(out, 'ccc');
});

test('RegexStore - CRUD 持久化', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regex-test-'));
    const store = initRegexStore(tmpDir);
    // 初始化只执行一次；用独立临时目录重新初始化会返回同一单例，因此用临时文件验证读写
    const created = store.create({ scriptName: 'n1', findRegex: '/a/g', replaceString: 'b' });
    assert.ok(created.id);
    assert.equal(store.list().length >= 1, true);
    const updated = store.update(created.id, { replaceString: 'c' });
    assert.equal(updated.replaceString, 'c');
    assert.equal(store.delete(created.id), true);
    assert.equal(store.delete('nonexistent'), false);
});

test('importRegexFromCard - V3 角色卡内嵌正则导入', () => {
    const card = {
        data: {
            name: 'TestChar',
            extensions: {
                regex_scripts: [
                    { scriptName: 'strip-think', findRegex: '/<think>.*?<\\/think>/gs', replaceString: '' },
                ],
            },
        },
    };
    const store = getRegexStore();
    const before = store.list().length;
    const added = importRegexFromCard(card, 'TestChar');
    assert.equal(added, 1);
    // 再次导入相同脚本不重复
    const added2 = importRegexFromCard(card, 'TestChar');
    assert.equal(added2, 0);
    // 标记 source
    const scripts = store.list();
    const imported = scripts.find(s => s.scriptName === 'strip-think');
    assert.equal(imported.source, 'character:TestChar');
});

test('getActiveScripts - 仅返回全局 + 当前角色脚本（多角色隔离）', () => {
    const store = getRegexStore();
    // 准备：导入角色 A 与角色 B 的专属脚本（内容相同也各自独立）
    const cardA = {
        data: { name: 'IsoA', extensions: { regex_scripts: [
            { scriptName: 'only-a', findRegex: '/AAA/g', replaceString: 'X' },
            { scriptName: 'shared', findRegex: '/same/g', replaceString: 'Y' },
        ] } },
    };
    const cardB = {
        data: { name: 'IsoB', extensions: { regex_scripts: [
            { scriptName: 'only-b', findRegex: '/BBB/g', replaceString: 'Z' },
            { scriptName: 'shared', findRegex: '/same/g', replaceString: 'Y' },
        ] } },
    };
    importRegexFromCard(cardA, 'IsoA');
    importRegexFromCard(cardB, 'IsoB');
    // 全局脚本（手动创建）
    const g = store.create({ scriptName: 'g1', findRegex: '/global/g', replaceString: 'G', source: 'global' });

    // 角色 A 激活：全局 + 仅 A 专属
    const activeA = store.getActiveScripts('IsoA');
    const aSources = activeA.map(s => s.source).sort();
    assert.ok(aSources.includes('global'));
    assert.ok(aSources.includes('character:IsoA'));
    assert.ok(!aSources.includes('character:IsoB'), '角色 B 的脚本不应在角色 A 生效集合中');
    assert.ok(activeA.some(s => s.scriptName === 'only-a'));
    assert.ok(activeA.some(s => s.scriptName === 'only-b') === false, '角色 B 专属脚本被隔离');

    // 切换到角色 B：立即关闭 A 的脚本，仅保留全局 + B
    const activeB = store.getActiveScripts('IsoB');
    assert.ok(activeB.some(s => s.scriptName === 'only-b'));
    assert.ok(activeB.some(s => s.scriptName === 'only-a') === false, '切换后角色 A 脚本立即关闭，无残留');
    assert.ok(activeB.some(s => s.source === 'global' && s.scriptName === 'g1'), '全局正则在切换后仍保持启用');

    // 无角色视图：仅全局
    const activeNone = store.getActiveScripts('');
    assert.ok(activeNone.every(s => s.source === 'global'), '未选择角色时仅全局正则生效');

    store.delete(g.id);
});

test('importBatch - 跨角色同内容各自独立（多对一关联）', () => {
    const store = getRegexStore();
    const before = store.list().length;
    const addedA = store.importBatch(
        [{ scriptName: 'dup', findRegex: '/dup/g', replaceString: '1' }],
        'character:MultiA',
    );
    const addedB = store.importBatch(
        [{ scriptName: 'dup', findRegex: '/dup/g', replaceString: '1' }],
        'character:MultiB',
    );
    assert.equal(addedA, 1);
    assert.equal(addedB, 1, '不同角色即使内容相同也应各自存储，互不串扰');
    // 同一角色重复导入不新增
    const addedA2 = store.importBatch(
        [{ scriptName: 'dup', findRegex: '/dup/g', replaceString: '1' }],
        'character:MultiA',
    );
    assert.equal(addedA2, 0, '同一角色重复导入被去重');
    const after = store.list().length;
    assert.equal(after - before, 2, '两个角色各持有一条独立记录');
});

test('create/update - source 作用域透传（全局/角色类型管理）', () => {
    const store = getRegexStore();
    // 创建全局正则
    const g = store.create({ scriptName: 'scope-g', findRegex: '/g/g', source: 'global' });
    assert.equal(g.source, 'global');
    // 创建角色正则（绑定当前角色）
    const c = store.create({ scriptName: 'scope-c', findRegex: '/c/g', source: 'character:绑定角色' });
    assert.equal(c.source, 'character:绑定角色');
    // 更新时保留/修改 source
    const u = store.update(c.id, { source: 'global' });
    assert.equal(u.source, 'global');
    const u2 = store.update(g.id, { source: 'character:新绑定' });
    assert.equal(u2.source, 'character:新绑定');
    store.delete(g.id);
    store.delete(c.id);
});
