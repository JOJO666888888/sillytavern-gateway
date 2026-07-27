/**
 * 定时任务调度器测试
 *
 * 守护的核心不变量：
 *   1. cron 5 段各种写法（*、*​/N、精确、列表、区间、区间步进）判定正确
 *   2. 日/周字段的 cron 惯例（都非 * 取「或」）
 *   3. 同一分钟内多次 tick 只触发一次（去重键）
 *   4. 单个任务 handler 抛错被隔离，不影响其它任务
 *   5. 非法 cron 在注册期被拒绝，不进入任务表
 *   6. unregisterByPlugin 精确移除指定插件的任务
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SchedulerService, cronMatches } from '../server/scheduler-service.js';

describe('cronMatches - 字段解析', () => {
    test('通配 * 匹配任意时刻', () => {
        assert.strictEqual(cronMatches('* * * * *', new Date(2026, 6, 26, 13, 37)), true);
    });

    test('精确 分/时 匹配', () => {
        assert.strictEqual(cronMatches('0 9 * * *', new Date(2026, 6, 26, 9, 0)), true);
        assert.strictEqual(cronMatches('0 9 * * *', new Date(2026, 6, 26, 9, 1)), false);
        assert.strictEqual(cronMatches('0 9 * * *', new Date(2026, 6, 26, 10, 0)), false);
    });

    test('步进 *​/N', () => {
        assert.strictEqual(cronMatches('*/5 * * * *', new Date(2026, 6, 26, 9, 0)), true);
        assert.strictEqual(cronMatches('*/5 * * * *', new Date(2026, 6, 26, 9, 5)), true);
        assert.strictEqual(cronMatches('*/5 * * * *', new Date(2026, 6, 26, 9, 5)), true);
        assert.strictEqual(cronMatches('*/5 * * * *', new Date(2026, 6, 26, 9, 3)), false);
    });

    test('列表 A,B,C', () => {
        assert.strictEqual(cronMatches('0,15,30,45 * * * *', new Date(2026, 6, 26, 9, 15)), true);
        assert.strictEqual(cronMatches('0,15,30,45 * * * *', new Date(2026, 6, 26, 9, 20)), false);
    });

    test('区间 N-M', () => {
        assert.strictEqual(cronMatches('0 9-17 * * *', new Date(2026, 6, 26, 12, 0)), true);
        assert.strictEqual(cronMatches('0 9-17 * * *', new Date(2026, 6, 26, 18, 0)), false);
    });

    test('区间步进 A-B/N', () => {
        // 每 2 小时的偶数点：9-17 内的 9,11,13,15,17
        assert.strictEqual(cronMatches('0 9-17/2 * * *', new Date(2026, 6, 26, 11, 0)), true);
        assert.strictEqual(cronMatches('0 9-17/2 * * *', new Date(2026, 6, 26, 12, 0)), false);
    });

    test('月份字段（1-12）', () => {
        // 2026-07-26 是 7 月
        assert.strictEqual(cronMatches('0 0 26 7 *', new Date(2026, 6, 26, 0, 0)), true);
        assert.strictEqual(cronMatches('0 0 26 8 *', new Date(2026, 6, 26, 0, 0)), false);
    });

    test('周字段：0 与 7 都表示周日', () => {
        // 2026-07-26 是周日
        const sunday = new Date(2026, 6, 26, 9, 0);
        assert.strictEqual(sunday.getDay(), 0);
        assert.strictEqual(cronMatches('0 9 * * 0', sunday), true);
        assert.strictEqual(cronMatches('0 9 * * 7', sunday), true);
        assert.strictEqual(cronMatches('0 9 * * 1', sunday), false); // 周一
    });

    test('日与周都非 * 时取「或」', () => {
        // 触发条件：每月 1 号 或 每周一。2026-07-26 是周日、26 号，两者都不满足
        const sunday26 = new Date(2026, 6, 26, 9, 0);
        assert.strictEqual(cronMatches('0 9 1 * 1', sunday26), false);
        // 周一（2026-07-27）满足「周」这一支
        const monday27 = new Date(2026, 6, 27, 9, 0);
        assert.strictEqual(monday27.getDay(), 1);
        assert.strictEqual(cronMatches('0 9 1 * 1', monday27), true);
        // 每月 1 号满足「日」这一支（无论星期几）
        const first = new Date(2026, 7, 1, 9, 0);
        assert.strictEqual(cronMatches('0 9 1 * 1', first), true);
    });

    test('非法表达式抛错', () => {
        assert.throws(() => cronMatches('* * * *', new Date()), /5 段/);
        assert.throws(() => cronMatches('99 * * * *', new Date()), /越界/);
        assert.throws(() => cronMatches('*/0 * * * *', new Date()), /步进/);
    });
});

describe('SchedulerService - 任务注册与触发', () => {
    test('注册并在命中时刻触发', async () => {
        const sched = new SchedulerService();
        let fired = 0;
        sched.registerPlugin({
            pluginName: 'p1',
            schedules: [{ cron: '0 9 * * *', handler: 'daily' }],
            run: async () => { fired++; },
        });

        await sched.tick(new Date(2026, 6, 26, 9, 0));
        assert.strictEqual(fired, 1);

        // 不命中的时刻不触发
        await sched.tick(new Date(2026, 6, 26, 10, 0));
        assert.strictEqual(fired, 1);
    });

    test('同一分钟内多次 tick 只触发一次', async () => {
        const sched = new SchedulerService();
        let fired = 0;
        sched.registerPlugin({
            pluginName: 'p1',
            schedules: [{ cron: '* * * * *', handler: 'h' }],
            run: async () => { fired++; },
        });

        const at = new Date(2026, 6, 26, 9, 0, 0);
        await sched.tick(at);
        await sched.tick(new Date(2026, 6, 26, 9, 0, 30)); // 同一分钟
        assert.strictEqual(fired, 1);

        // 进入下一分钟则再次触发
        await sched.tick(new Date(2026, 6, 26, 9, 1, 0));
        assert.strictEqual(fired, 2);
    });

    test('单任务 handler 抛错被隔离，不影响其它任务', async () => {
        const sched = new SchedulerService();
        let goodFired = 0;
        sched.registerPlugin({
            pluginName: 'bad',
            schedules: [{ cron: '* * * * *', handler: 'boom' }],
            run: async () => { throw new Error('故意炸'); },
        });
        sched.registerPlugin({
            pluginName: 'good',
            schedules: [{ cron: '* * * * *', handler: 'ok' }],
            run: async () => { goodFired++; },
        });

        const fired = await sched.tick(new Date(2026, 6, 26, 9, 0));
        assert.strictEqual(fired, 2);       // 两个都命中并尝试执行
        assert.strictEqual(goodFired, 1);   // 好任务照常执行
    });

    test('非法 cron 在注册期被拒绝，不进入任务表', async () => {
        const sched = new SchedulerService();
        let fired = 0;
        sched.registerPlugin({
            pluginName: 'p',
            schedules: [
                { cron: '不是 cron', handler: 'x' },
                { cron: '* * * * *', handler: 'y' },
            ],
            run: async () => { fired++; },
        });
        // 只有合法的那条进入任务表
        assert.strictEqual(sched.jobs.length, 1);
        await sched.tick(new Date(2026, 6, 26, 9, 0));
        assert.strictEqual(fired, 1);
    });

    test('缺 cron 或 handler 的任务被跳过', () => {
        const sched = new SchedulerService();
        sched.registerPlugin({
            pluginName: 'p',
            schedules: [
                { handler: 'nocron' },
                { cron: '* * * * *' },
            ],
            run: async () => {},
        });
        assert.strictEqual(sched.jobs.length, 0);
    });

    test('unregisterByPlugin 精确移除指定插件任务', async () => {
        const sched = new SchedulerService();
        sched.registerPlugin({ pluginName: 'a', schedules: [{ cron: '* * * * *', handler: 'h' }], run: async () => {} });
        sched.registerPlugin({ pluginName: 'b', schedules: [{ cron: '* * * * *', handler: 'h' }], run: async () => {} });
        assert.strictEqual(sched.jobs.length, 2);

        const removed = sched.unregisterByPlugin('a');
        assert.strictEqual(removed, 1);
        assert.strictEqual(sched.jobs.length, 1);
        assert.strictEqual(sched.jobs[0].pluginName, 'b');
    });

    test('run 回调收到 schedule 描述对象', async () => {
        const sched = new SchedulerService();
        let received = null;
        sched.registerPlugin({
            pluginName: 'p',
            schedules: [{ cron: '* * * * *', handler: 'report', description: '每日报告' }],
            run: async (schedule) => { received = schedule; },
        });
        await sched.tick(new Date(2026, 6, 26, 9, 0));
        assert.strictEqual(received.handler, 'report');
        assert.strictEqual(received.description, '每日报告');
    });

    test('start/stop 幂等且不抛错', () => {
        const sched = new SchedulerService({ pollIntervalMs: 60000 });
        sched.start();
        sched.start(); // 幂等
        sched.stop();
        sched.stop();  // 幂等
        assert.ok(true);
    });
});
