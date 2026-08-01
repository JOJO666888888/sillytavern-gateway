/**
 * WorkspaceManager 测试（Task 5.1 / 5.2 / 5.3 / 5.4 / 5.8）
 *
 * 守护 spec.md "可审计可回滚的 Workspace"：
 *   run 级目录 / events.jsonl append-only / seq 单调 / checkpoint / commit / rollback
 *   + 路径穿越防护
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { tmpDir, silentLogger } from './helpers.js';
import { WorkspaceManager } from '../plugins/agent-framework/engine/workspace-manager.js';

const tmps = [];
after(() => { for (const t of tmps) t.cleanup(); });
function makeManager() {
    const t = tmpDir();
    tmps.push(t);
    return { manager: new WorkspaceManager({ dataRoot: t.dir, logger: silentLogger }), dir: t.dir };
}

describe('initRun 目录结构', () => {
    test('创建 output/scratch/checkpoints + manifest + init 事件', () => {
        const { manager } = makeManager();
        const runId = 'run-1';
        manager.initRun(runId, { sessionId: 'sess-1', manifest: { agent: 'GM' } });

        const runDir = manager.getRunDir(runId);
        for (const sub of ['output', 'scratch', 'checkpoints']) {
            assert.ok(fs.existsSync(path.join(runDir, sub)), `${sub} 应存在`);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
        assert.strictEqual(manifest.runId, runId);
        assert.strictEqual(manifest.sessionId, 'sess-1');
        assert.strictEqual(manifest.manifest.agent, 'GM');

        // init checkpoint 事件
        const evs = manager.getEvents(runId);
        assert.strictEqual(evs.length, 1);
        assert.strictEqual(evs[0].type, 'checkpoint');
        assert.strictEqual(evs[0].payload.label, 'init');
    });
});

describe('writeText / readText', () => {
    test('读写往返 + 自动建父目录', () => {
        const { manager } = makeManager();
        const runId = 'run-2';
        manager.initRun(runId, { sessionId: 'sess-2' });

        manager.writeText(runId, 'output/a.md', '正文 A');
        manager.writeText(runId, 'output/sub/b.md', '正文 B');
        assert.strictEqual(manager.readText(runId, 'output/a.md'), '正文 A');
        assert.strictEqual(manager.readText(runId, 'output/sub/b.md'), '正文 B');
    });

    test('读不存在返回 null', () => {
        const { manager } = makeManager();
        manager.initRun('run-3', { sessionId: 's' });
        assert.strictEqual(manager.readText('run-3', 'output/none.md'), null);
    });
});

describe('appendEvent / getEvents + seq 单调递增', () => {
    test('seq 从 1 起单调递增', () => {
        const { manager } = makeManager();
        const runId = 'run-4';
        manager.initRun(runId, { sessionId: 's' }); // 已写入 1 个 init 事件

        const s2 = manager.appendEvent(runId, 'tool_call', { tool: 'state.write' });
        const s3 = manager.appendEvent(runId, 'state_change', { key: 'k' });
        const s4 = manager.appendEvent(runId, 'subagent', { agent: 'critic' });

        assert.strictEqual(s2, 2);
        assert.strictEqual(s3, 3);
        assert.strictEqual(s4, 4);

        const evs = manager.getEvents(runId);
        assert.strictEqual(evs.length, 4);
        assert.strictEqual(evs[0].seq, 1);
        assert.strictEqual(evs[3].seq, 4);
    });

    test('getEvents afterSeq 过滤 + limit', () => {
        const { manager } = makeManager();
        const runId = 'run-5';
        manager.initRun(runId, { sessionId: 's' });
        for (let i = 0; i < 5; i++) manager.appendEvent(runId, 'tool_call', { i });

        const after2 = manager.getEvents(runId, { afterSeq: 2 });
        assert.strictEqual(after2.length, 4);
        assert.strictEqual(after2[0].seq, 3);

        const limited = manager.getEvents(runId, { limit: 2 });
        assert.strictEqual(limited.length, 2);
        assert.strictEqual(limited[1].seq, 2);
    });

    test('getEvents 空文件返回空数组', () => {
        const { manager } = makeManager();
        const runId = 'run-6';
        manager.initRun(runId, { sessionId: 's' });
        // 删掉 events 再读
        fs.rmSync(path.join(manager.getRunDir(runId), 'events.jsonl'));
        assert.deepStrictEqual(manager.getEvents(runId), []);
    });
});

describe('createCheckpoint', () => {
    test('快照 output + manifest，并追加 checkpoint 事件', () => {
        const { manager } = makeManager();
        const runId = 'run-7';
        manager.initRun(runId, { sessionId: 's' });
        manager.writeText(runId, 'output/a.md', '原内容');

        const cpId = manager.createCheckpoint(runId, 'after-draft');
        assert.ok(cpId.startsWith('cp-'));

        const cpDir = path.join(manager.getRunDir(runId), 'checkpoints', cpId);
        assert.ok(fs.existsSync(path.join(cpDir, 'output', 'a.md')));
        assert.ok(fs.existsSync(path.join(cpDir, 'manifest.json')));
        assert.ok(fs.existsSync(path.join(cpDir, 'events.jsonl')));

        const evs = manager.getEvents(runId);
        const last = evs[evs.length - 1];
        assert.strictEqual(last.type, 'checkpoint');
        assert.strictEqual(last.payload.label, 'after-draft');
        assert.strictEqual(last.payload.checkpointId, cpId);
    });
});

describe('commit promote 到会话级 persist', () => {
    test('output 合并覆盖到 sessions/<id>/persist，返回清单', () => {
        const { manager } = makeManager();
        const runId = 'run-8';
        manager.initRun(runId, { sessionId: 'sess-8' });
        manager.writeText(runId, 'output/a.md', 'A');
        manager.writeText(runId, 'output/sub/b.md', 'B');

        const promoted = manager.commit(runId);
        assert.ok(promoted.includes('a.md'));
        assert.ok(promoted.includes('sub/b.md'));

        const persistDir = path.join(manager.getSessionDir('sess-8'), 'persist');
        assert.strictEqual(fs.readFileSync(path.join(persistDir, 'a.md'), 'utf-8'), 'A');
        assert.strictEqual(fs.readFileSync(path.join(persistDir, 'sub', 'b.md'), 'utf-8'), 'B');

        // commit 事件
        const evs = manager.getEvents(runId);
        assert.strictEqual(evs[evs.length - 1].type, 'commit');
    });

    test('多次 commit 合并（覆盖同名）', () => {
        const { manager } = makeManager();
        const r1 = 'run-9a', r2 = 'run-9b';
        manager.initRun(r1, { sessionId: 'sess-9' });
        manager.writeText(r1, 'output/a.md', 'v1');
        manager.commit(r1);

        manager.initRun(r2, { sessionId: 'sess-9' });
        manager.writeText(r2, 'output/a.md', 'v2');
        manager.commit(r2);

        const persistDir = path.join(manager.getSessionDir('sess-9'), 'persist');
        assert.strictEqual(fs.readFileSync(path.join(persistDir, 'a.md'), 'utf-8'), 'v2');
    });
});

describe('rollback 恢复 workspace', () => {
    test('从 checkpoint 恢复 output（覆盖后续篡改）', () => {
        const { manager } = makeManager();
        const runId = 'run-10';
        manager.initRun(runId, { sessionId: 's' });
        manager.writeText(runId, 'output/a.md', '原内容');
        const cpId = manager.createCheckpoint(runId, 'before-commit');

        // 篡改
        manager.writeText(runId, 'output/a.md', '被改坏');
        manager.writeText(runId, 'output/evil.md', '不应存在');

        manager.rollback(runId, cpId);

        assert.strictEqual(manager.readText(runId, 'output/a.md'), '原内容');
        assert.strictEqual(manager.readText(runId, 'output/evil.md'), null);

        // rollback 追加事件（journal append-only）
        const evs = manager.getEvents(runId);
        assert.strictEqual(evs[evs.length - 1].type, 'checkpoint');
        assert.strictEqual(evs[evs.length - 1].payload.label, 'rollback');
    });

    test('回滚不存在的 checkpoint 抛错', () => {
        const { manager } = makeManager();
        const runId = 'run-11';
        manager.initRun(runId, { sessionId: 's' });
        assert.throws(() => manager.rollback(runId, 'cp-nope'), /checkpoint 不存在/);
    });
});

describe('listFiles', () => {
    test('按深度列出文件', () => {
        const { manager } = makeManager();
        const runId = 'run-12';
        manager.initRun(runId, { sessionId: 's' });
        manager.writeText(runId, 'output/a.md', 'A');
        manager.writeText(runId, 'output/sub/b.md', 'B');
        manager.writeText(runId, 'output/sub/deep/c.md', 'C');

        const top = manager.listFiles(runId, 'output', { depth: 1 });
        // depth=1 只列 output 直接下：a.md + sub/
        const names = top.map(e => e.path);
        assert.ok(names.includes('output/a.md'));
        assert.ok(names.some(n => n === 'output/sub'));
        assert.ok(!names.some(n => n.includes('deep')));

        const deep = manager.listFiles(runId, 'output', { depth: 3 });
        const deepNames = deep.map(e => e.path);
        assert.ok(deepNames.some(n => n.includes('deep/c.md')));
    });

    test('maxEntries 截断', () => {
        const { manager } = makeManager();
        const runId = 'run-13';
        manager.initRun(runId, { sessionId: 's' });
        for (let i = 0; i < 10; i++) manager.writeText(runId, `output/f${i}.md`, 'x');
        const list = manager.listFiles(runId, 'output', { maxEntries: 3 });
        assert.strictEqual(list.length, 3);
    });
});

describe('路径穿越防护', () => {
    test('relPath 含 .. 逃逸被拒', () => {
        const { manager } = makeManager();
        const runId = 'run-evil';
        manager.initRun(runId, { sessionId: 's' });
        assert.throws(() => manager.writeText(runId, '../evil.txt', 'x'), /路径穿越/);
        assert.throws(() => manager.writeText(runId, 'output/../../evil.txt', 'x'), /路径穿越/);
        assert.throws(() => manager.readText(runId, '../evil.txt'), /路径穿越/);
        assert.throws(() => manager.listFiles(runId, '../'), /路径穿越/);
    });

    test('绝对路径被拒', () => {
        const { manager } = makeManager();
        const runId = 'run-abs';
        manager.initRun(runId, { sessionId: 's' });
        const abs = path.join(path.parse(process.cwd()).root, 'evil', 'x.txt');
        assert.throws(() => manager.writeText(runId, abs, 'x'), /路径穿越/);
    });

    test('runId 篡改（含 .. / 分隔符）被拒', () => {
        const { manager } = makeManager();
        assert.throws(() => manager.getRunDir('../escape'), /路径穿越/);
        assert.throws(() => manager.readText('a/../../b', 'x'), /路径穿越/);
    });

    test('正常路径不被误伤（文件名含双点）', () => {
        const { manager } = makeManager();
        const runId = 'run-ok';
        manager.initRun(runId, { sessionId: 's' });
        manager.writeText(runId, 'output/foo..bar.md', 'ok');
        assert.strictEqual(manager.readText(runId, 'output/foo..bar.md'), 'ok');
    });
});
