/**
 * 自建推理管线 - 会话 Profile 删除回归测试
 *
 * 验证面板「删除已绑定会话」功能的存储层语义：
 *   - update -> list -> delete -> 列表为空
 *   - 重复删除幂等（返回 false，不抛错）
 *   - 删除持久化到磁盘（新实例加载不到）
 *   - 删除后 get() 按默认值重建，不残留旧绑定
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { ProfileStore } from '../server/runtime/profile-store.js';
import { tmpDir } from './helpers.js';

const tmps = [];
function makeTmp() { const t = tmpDir(); tmps.push(t); return t.dir; }
after(() => { for (const t of tmps) t.cleanup(); });

describe('会话 Profile：删除已绑定会话', () => {
    test('update -> list -> delete -> 列表为空', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('telegram', '111', { character: '月见' });
        assert.strictEqual(store.list().length, 1);

        assert.strictEqual(store.delete('telegram', '111'), true);
        assert.strictEqual(store.list().length, 0);
    });

    test('重复删除幂等：返回 false，不抛错', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('qq', '222', { character: 'A' });
        store.delete('qq', '222');

        assert.strictEqual(store.delete('qq', '222'), false);
        assert.strictEqual(store.list().length, 0);
    });

    test('删除持久化：新实例加载不到已删会话', () => {
        const file = path.join(makeTmp(), 'profiles.json');
        const s1 = new ProfileStore({ file });
        s1.update('qq', '222', { character: 'A' });
        s1.update('qq', '333', { character: 'B' });
        s1.delete('qq', '222');

        const s2 = new ProfileStore({ file });
        const sessions = s2.list().map(p => p.session);
        assert.deepEqual(sessions, ['qq:333']);
    });

    test('删除后 get() 按默认值重建，不残留旧绑定', () => {
        const file = path.join(makeTmp(), 'profiles.json');
        const store = new ProfileStore({ file, defaults: { character: '默认卡' } });
        store.update('discord', '444', { character: '旧绑定', preset: 'P' });
        store.delete('discord', '444');

        const p = store.get('discord', '444');
        assert.strictEqual(p.character, '默认卡');
        assert.strictEqual(p.preset, '');
        assert.deepStrictEqual(p.worldbooks, []);
    });

    test('仅删除目标会话，不影响其他会话绑定', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('telegram', '111', { character: '甲' });
        store.update('telegram', '222', { character: '乙' });
        store.update('qq', '333', { character: '丙' });

        store.delete('telegram', '111');

        const byKey = Object.fromEntries(store.list().map(p => [p.session, p.character]));
        assert.deepStrictEqual(byKey, {
            'telegram:222': '乙',
            'qq:333': '丙',
        });
    });
});
