/**
 * 重连策略回归测试（P1-A）
 *
 * 守护的核心不变量：回调持续失败时必须**自动续接**下一次重连。
 * 历史 bug：ReconnectStrategy 只 catch 回调异常、不再调度，导致
 * Telegram/Discord 首次重连失败后永久卡死在 ERROR（"静默死亡"）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ReconnectStrategy } from '../server/utils/reconnect.js';
import { silentLogger, sleep } from './helpers.js';

describe('ReconnectStrategy', () => {
    test('回调持续失败时自动续接重连（防止静默死亡）', async () => {
        let attempts = 0;
        const rs = new ReconnectStrategy({ initialDelay: 20, maxDelay: 40, logger: silentLogger });

        rs.scheduleReconnect(async () => {
            attempts++;
            throw new Error('模拟连接失败');
        });

        await sleep(300);
        rs.cancel();

        assert.ok(attempts >= 3, `300ms 内应自动重试多次，实际 ${attempts} 次`);
    });

    test('cancel() 后停止调度', async () => {
        let attempts = 0;
        const rs = new ReconnectStrategy({ initialDelay: 20, logger: silentLogger });
        rs.scheduleReconnect(async () => { attempts++; throw new Error('fail'); });

        await sleep(120);
        rs.cancel();
        const afterCancel = attempts;

        await sleep(150);
        assert.strictEqual(attempts, afterCancel, 'cancel 后不应再有新的重连尝试');
    });

    test('重复调度不会产生并发定时器（旧 timer 被取消）', async () => {
        let attempts = 0;
        // multiplier:1 固定延迟，把"无并发定时器"这一不变量与退避增长解耦，
        // 否则三次调度的延迟会指数增长(60→120→240)，等待时间难以确定。
        const rs = new ReconnectStrategy({
            initialDelay: 40, multiplier: 1, jitter: false, logger: silentLogger,
        });
        const cb = async () => { attempts++; };

        // 模拟 ws error + close 双事件导致的重复调度
        rs.scheduleReconnect(cb);
        rs.scheduleReconnect(cb);
        rs.scheduleReconnect(cb);

        await sleep(200);
        rs.cancel();

        assert.strictEqual(attempts, 1, `三次重复调度只应触发一次回调，实际 ${attempts} 次`);
    });

    test('reset() 恢复初始退避并清除计数', () => {
        const rs = new ReconnectStrategy({ initialDelay: 100, multiplier: 2, logger: silentLogger });
        rs.scheduleReconnect(async () => {});
        rs.scheduleReconnect(async () => {});
        assert.ok(rs.retryCount > 0);

        rs.reset();
        assert.strictEqual(rs.retryCount, 0);
        assert.strictEqual(rs.currentDelay, 100);
        assert.strictEqual(rs.active, false);
    });

    test('显式配置 0 不被 || 吞掉（用 ?? 取默认值）', () => {
        const rs = new ReconnectStrategy({ initialDelay: 0, maxRetries: 0, logger: silentLogger });
        assert.strictEqual(rs.initialDelay, 0, 'initialDelay:0 应被保留');
        assert.strictEqual(rs.maxRetries, 0, 'maxRetries:0 = 无限重试');
    });

    test('达到 maxRetries 后停止调度', async () => {
        let attempts = 0;
        const rs = new ReconnectStrategy({ initialDelay: 10, maxRetries: 2, logger: silentLogger });
        rs.scheduleReconnect(async () => { attempts++; throw new Error('fail'); });

        await sleep(250);
        rs.cancel();

        assert.strictEqual(attempts, 2, `maxRetries=2 应恰好尝试 2 次，实际 ${attempts} 次`);
    });
});
