/**
 * card-loader 文件/目录区分测试
 *
 * 覆盖 EISDIR 修复：loadCharacterCardByName 必须正确区分文件与目录，
 * 传入目录路径不会抛 "illegal operation on a directory"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadCharacterCard, loadCharacterCardByName } from '../server/runtime/card-loader.js';

function makeCardDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-loader-test-'));
    // 有效角色卡（V3，含内嵌 regex）
    const card = {
        spec: 'chara_card_v3',
        data: {
            name: 'Alice',
            description: 'test',
            extensions: {
                regex_scripts: [
                    { scriptName: 'strip', findRegex: '/<x>/g', replaceString: '' },
                ],
            },
        },
    };
    fs.writeFileSync(path.join(dir, 'Alice.json'), JSON.stringify(card), 'utf-8');
    // 同名目录（模拟角色卡目录下还有子目录，用于验证目录不会被误读）
    fs.mkdirSync(path.join(dir, 'Alice_Sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Alice_Sub', 'meta.json'), '{}', 'utf-8');
    // 大小写不同的扩展名文件
    fs.writeFileSync(path.join(dir, 'Bob.PNG'), 'not-really-png', 'utf-8');
    return dir;
}

test('loadCharacterCard - 传入目录路径应抛明确错误而非 EISDIR', () => {
    const dir = makeCardDir();
    const subDir = path.join(dir, 'Alice_Sub');
    assert.throws(() => loadCharacterCard(subDir), /不是文件/);
});

test('loadCharacterCardByName - 正常加载 .json 角色卡', () => {
    const dir = makeCardDir();
    const card = loadCharacterCardByName(dir, 'Alice');
    assert.ok(card);
    assert.equal(card.name, 'Alice');
    assert.ok(card.extensions.regex_scripts);
});

test('loadCharacterCardByName - 带扩展名加载', () => {
    const dir = makeCardDir();
    const card = loadCharacterCardByName(dir, 'Alice.json');
    assert.ok(card);
    assert.equal(card.name, 'Alice');
});

test('loadCharacterCardByName - 不存在返回 null 而非抛错', () => {
    const dir = makeCardDir();
    assert.equal(loadCharacterCardByName(dir, 'Nobody'), null);
});

test('loadCharacterCardByName - 目录不会被误读（同名目录场景）', () => {
    const dir = makeCardDir();
    // 目录名与文件 basename 不同，验证无 EISDIR
    const card = loadCharacterCardByName(dir, 'Alice_Sub');
    // Alice_Sub 是目录（无 .json/.png 扩展名）→ 精确候选不命中 → 扫描也找不到 basename 为 "Alice_Sub" 的文件 → null
    assert.equal(card, null);
});

test('loadCharacterCardByName - 目录下传入非法扩展名返回 null', () => {
    const dir = makeCardDir();
    assert.equal(loadCharacterCardByName(dir, 'Alice.txt'), null);
});
