/**
 * file-tools.js 路径安全测试
 *
 * 守护 AGENT_SYSTEM_TECHNICAL_REVIEW.md 发现的缺陷：
 * file-tools resolvePath 使用 startsWith(dataDir) 前缀检查，缺少路径边界，
 * 前缀相似目录（如 dataDir2）可绕过。修复后对齐 workspace-manager._safeResolve
 * 的 path.relative 边界检查。
 *
 * 覆盖：
 *   - 正常相对路径读写
 *   - `..` 目录逃逸拒绝
 *   - 绝对路径拒绝
 *   - 前缀相似目录（dataDir2）绕过拒绝
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { createFileTools } from '../plugins/agent-framework/tools/file-tools.js';
import { tmpDir } from './helpers.js';

const tmps = [];
after(() => {
    for (const t of tmps) t.cleanup();
});
function makeTmp() { const t = tmpDir('stgw-ft-'); tmps.push(t); return t.dir; }

// 按工具名索引，便于按语义引用
function toolsByName(dataDir) {
    return Object.fromEntries(createFileTools(dataDir).map(t => [t.name, t]));
}

describe('file-tools 路径安全', () => {
    test('正常相对路径可写可读', async () => {
        const root = makeTmp();
        const dataDir = path.join(root, 'agent-framework');
        const t = toolsByName(dataDir);

        const w = await t['file.write'].handler({ path: 'docs/note.txt', content: '内容' });
        assert.ok(w.success, `写入应成功: ${JSON.stringify(w)}`);

        const r = await t['file.read'].handler({ path: 'docs/note.txt' });
        assert.strictEqual(r.content, '内容');

        const l = await t['file.list'].handler({ path: 'docs' });
        assert.ok(l.items.some(i => i.name === 'note.txt'), '应列出 note.txt');
    });

    test('`..` 目录逃逸被拒绝', async () => {
        const root = makeTmp();
        const dataDir = path.join(root, 'agent-framework');
        const t = toolsByName(dataDir);

        const w = await t['file.write'].handler({ path: '../evil.txt', content: 'x' });
        assert.ok(w.error, `穿越应被拒绝: ${JSON.stringify(w)}`);

        const r = await t['file.read'].handler({ path: '../../etc/passwd' });
        assert.ok(r.error, `穿越读应被拒绝: ${JSON.stringify(r)}`);

        const l = await t['file.list'].handler({ path: '..' });
        assert.ok(l.error, `穿越列目录应被拒绝: ${JSON.stringify(l)}`);
    });

    test('绝对路径被拒绝', async () => {
        const root = makeTmp();
        const dataDir = path.join(root, 'agent-framework');
        const t = toolsByName(dataDir);

        const w = await t['file.write'].handler({ path: 'C:\\evil.txt', content: 'x' });
        assert.ok(w.error, `绝对路径写入应被拒绝: ${JSON.stringify(w)}`);

        const r = await t['file.read'].handler({ path: '/abs/path.txt' });
        assert.ok(r.error, `绝对路径读取应被拒绝: ${JSON.stringify(r)}`);
    });

    test('前缀相似目录（dataDir2）无法绕过路径边界', async () => {
        const root = makeTmp();
        const dataDir = path.join(root, 'agent-framework');
        // 构造前缀相似目录：agent-framework2（旧 startsWith 检查会误放行）
        const sibling = path.join(root, 'agent-framework2');
        fs.mkdirSync(sibling, { recursive: true });

        const t = toolsByName(dataDir);

        // 攻击路径解析为 <root>/agent-framework2/pwn.txt
        const w = await t['file.write'].handler({ path: '../agent-framework2/pwn.txt', content: 'pwn' });
        assert.ok(w.error, `前缀相似目录写入应被拒绝: ${JSON.stringify(w)}`);
        assert.ok(!fs.existsSync(path.join(sibling, 'pwn.txt')), '目标目录不应被写入');

        const r = await t['file.read'].handler({ path: '../agent-framework2/pwn.txt' });
        assert.ok(r.error, `前缀相似目录读取应被拒绝: ${JSON.stringify(r)}`);
    });
});
