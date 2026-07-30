/**
 * 自建推理管线 - 会话 Profile 删除回归测试
 *
 * 验证面板「删除已绑定会话」功能的存储层语义：
 *   - update -> list -> delete -> 列表为空
 *   - 重复删除幂等（返回 false，不抛错）
 *   - 删除持久化到磁盘（新实例加载不到）
 *   - 删除后 get() 按默认值重建，不残留旧绑定
 *
 * 另含「会话绑定刷新」功能的存储层测试：
 *   - 面板刷新按钮调用 GET /api/runtime/profiles，最终读取 ProfileStore.list()
 *   - 验证 list() 始终反映最新状态、边界情况与响应时间
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
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

/**
 * 「会话绑定刷新」功能的数据源测试
 *
 * 前端刷新按钮 #gateway_rt_profiles_refresh 点击后：
 *   loadRuntimeProfiles() -> GET /api/runtime/profiles -> nativeRuntime.profiles.list()
 *
 * 这里验证 list() 这个数据源在刷新场景下的正确性与边界情况：
 *   - 正常流程：增删改后再次刷新（list）能拿到最新结果
 *   - 边界：空列表、不存在的会话、重复刷新
 *   - 数据结构：返回项含 session/character/preset/worldbooks/archive 字段
 *   - 性能：响应在 3s 内（前端要求 ≤3s）
 */
describe('会话绑定刷新：list() 数据源', () => {
    test('正常流程：update 后刷新立即反映新绑定', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        assert.strictEqual(store.list().length, 0, '初始应为空');

        store.update('telegram', '111', { character: '月见', preset: 'P1' });
        // 模拟点击刷新：重新读取 list()
        let list = store.list();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].session, 'telegram:111');
        assert.strictEqual(list[0].character, '月见');

        store.update('qq', '222', { character: 'A' });
        list = store.list(); // 再次刷新
        assert.strictEqual(list.length, 2, '刷新后应反映新增会话');
    });

    test('正常流程：delete 后刷新不再返回该会话', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('discord', '444', { character: 'D' });
        store.update('qq', '555', { character: 'Q' });

        store.delete('discord', '444');
        const sessions = store.list().map(p => p.session);
        assert.deepStrictEqual(sessions, ['qq:555'], '删除后刷新只应剩未删会话');
    });

    test('正常流程：修改字段后刷新拿到新值（而非旧值）', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('qq', '666', { character: '旧卡' });

        // 外部（如 ST 或保存按钮）改了角色卡绑定
        store.update('qq', '666', { character: '新卡', preset: '新预设' });

        const refreshed = store.list();
        assert.strictEqual(refreshed[0].character, '新卡', '刷新应拿到最新角色卡');
        assert.strictEqual(refreshed[0].preset, '新预设', '刷新应拿到最新预设');
    });

    test('边界：空列表刷新返回空数组（非 undefined/null）', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        const list = store.list();
        assert.ok(Array.isArray(list), 'list() 必须返回数组');
        assert.strictEqual(list.length, 0);
    });

    test('边界：get() 创建的默认会话也会出现在刷新列表中', () => {
        // IM 收到第一条消息时 get() 会自动创建空 profile，刷新应能看到
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json'), defaults: { character: '默认卡' } });
        store.get('telegram', '777'); // 触发自动创建

        const list = store.list();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].session, 'telegram:777');
        assert.strictEqual(list[0].character, '默认卡');
    });

    test('边界：连续多次刷新结果稳定一致（幂等读）', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('qq', '888', { character: 'X' });

        const r1 = store.list();
        const r2 = store.list();
        const r3 = store.list();
        assert.deepStrictEqual(r1, r2);
        assert.deepStrictEqual(r2, r3, '无写入时多次刷新结果应一致');
    });

    test('数据结构：list() 项含完整字段（session + profile 各字段）', () => {
        const store = new ProfileStore({ file: path.join(makeTmp(), 'profiles.json') });
        store.update('telegram', '999', {
            character: 'C', preset: 'P',
            worldbooks: ['wb1', 'wb2'], archive: 'arc1', persona: null, llm: null,
        });

        const [item] = store.list();
        assert.strictEqual(item.session, 'telegram:999');
        assert.strictEqual(item.character, 'C');
        assert.strictEqual(item.preset, 'P');
        assert.deepStrictEqual(item.worldbooks, ['wb1', 'wb2']);
        assert.strictEqual(item.archive, 'arc1');
    });

    test('性能：大量 profile 下 list() 仍远低于 3s', () => {
        const dir = makeTmp();
        const file = path.join(dir, 'profiles.json');
        // 一次性写入 1000 个会话绑定到磁盘（避免逐条 update 的磁盘开销污染计时）
        const obj = {};
        for (let i = 0; i < 1000; i++) {
            obj[`qq:${i}`] = { character: `卡${i}`, preset: `P${i}`, worldbooks: [], archive: '', persona: null, llm: null };
        }
        fs.writeFileSync(file, JSON.stringify(obj));

        const store = new ProfileStore({ file });

        const start = Date.now();
        const list = store.list();
        const elapsed = Date.now() - start;

        assert.strictEqual(list.length, 1000);
        // 前端要求刷新响应 ≤3s；list() 是同步内存操作，应远低于此阈值（<500ms 宽松上限）
        assert.ok(elapsed < 500, `list() 耗时 ${elapsed}ms 应 < 500ms（前端 3s 要求的数据源侧）`);
    });

    test('刷新数据源：新实例从磁盘加载到最新持久化结果', () => {
        // 模拟：保存按钮写入后，后端进程重启，刷新仍能看到（持久化语义）
        const file = path.join(makeTmp(), 'profiles.json');
        const s1 = new ProfileStore({ file });
        s1.update('qq', 'aaa', { character: '持久化卡' });

        // 新实例（模拟后端重启后再被刷新请求读取）
        const s2 = new ProfileStore({ file });
        const list = s2.list();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].character, '持久化卡');
    });
});
