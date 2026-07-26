/**
 * 消息队列回归测试（P1-B）
 *
 * 守护的核心不变量：
 *   1. 同一会话消息严格有序（失败重试不得让后面的消息越位）
 *   2. 单条发送挂起不得锁死整个队列（超时保护）
 *   3. 最终失败进死信队列，不静默丢弃
 *   4. 队满时 enqueue 返回 false（背压），而非静默丢队头
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { MessageQueue } from '../server/message-queue.js';
import { sleep } from './helpers.js';

const mk = (platform, chatId, content) => ({ platform, chatId, content });

let activeQueues = [];
function makeQueue(opts) {
    const q = new MessageQueue(opts);
    activeQueues.push(q);
    return q;
}
afterEach(() => {
    for (const q of activeQueues) q.stop();
    activeQueues = [];
});

describe('MessageQueue', () => {
    test('同一会话消息在重试后仍保持有序', async () => {
        const sent = [];
        const q = makeQueue({ retryDelay: 60, maxRetries: 3, processInterval: 10, sendTimeout: 500 });
        let failFirst = true;
        q.setSendHandler(async (m) => {
            if (m.chatId === 'A' && m.content === 'A1' && failFirst) { failFirst = false; return false; }
            sent.push(`${m.chatId}:${m.content}`);
            return true;
        });

        q.enqueue(mk('qq', 'A', 'A1'));
        q.enqueue(mk('qq', 'A', 'A2'));
        q.start();
        await sleep(400);

        const i1 = sent.indexOf('A:A1');
        const i2 = sent.indexOf('A:A2');
        assert.ok(i1 >= 0 && i2 >= 0, `两条都应发出，实际: ${sent.join(',')}`);
        assert.ok(i1 < i2, `A1 必须先于 A2（实际顺序: ${sent.join(',')}）`);
    });

    test('一个会话重试不阻塞其它会话', async () => {
        const sent = [];
        const q = makeQueue({ retryDelay: 100, maxRetries: 3, processInterval: 10, sendTimeout: 500 });
        let failFirst = true;
        q.setSendHandler(async (m) => {
            if (m.chatId === 'A' && failFirst) { failFirst = false; return false; }
            sent.push(m.chatId);
            return true;
        });

        q.enqueue(mk('qq', 'A', 'A1'));
        q.enqueue(mk('qq', 'B', 'B1'));
        q.start();
        await sleep(80); // A 尚在退避中

        assert.ok(sent.includes('B'), `B 会话不应被 A 的重试阻塞，已发送: ${sent.join(',')}`);
    });

    test('发送挂起触发超时，不锁死队列', async () => {
        const q = makeQueue({ retryDelay: 20, maxRetries: 2, processInterval: 10, sendTimeout: 50 });
        q.setSendHandler(() => new Promise(() => {})); // 永不 resolve

        q.enqueue(mk('qq', 'C', 'C1'));
        q.start();
        await sleep(400);

        const st = q.getStatus();
        assert.strictEqual(st.processing, false, '超时后处理锁必须释放，否则队列永久锁死');
        assert.strictEqual(st.deadLetter, 1, '超时耗尽重试后应进死信队列');
    });

    test('最终失败进入死信队列并可取出', async () => {
        const q = makeQueue({ retryDelay: 10, maxRetries: 2, processInterval: 10 });
        q.setSendHandler(async () => { throw new Error('永久失败'); });

        q.enqueue(mk('qq', 'D', 'D1'));
        q.start();
        await sleep(300);

        const drained = q.drainDeadLetter();
        assert.strictEqual(drained.length, 1);
        assert.strictEqual(drained[0].message.content, 'D1', '死信应保留原始消息内容供人工补发');
        assert.match(drained[0].error, /永久失败/);
        assert.strictEqual(q.getStatus().deadLetter, 0, 'drain 后死信队列应清空');
    });

    test('队满时 enqueue 返回 false（背压）', () => {
        const q = makeQueue({ maxLength: 2 });
        assert.strictEqual(q.enqueue(mk('qq', 'E', '1')), true);
        assert.strictEqual(q.enqueue(mk('qq', 'E', '2')), true);
        assert.strictEqual(q.enqueue(mk('qq', 'E', '3')), false, '队满必须返回 false 让调用方感知拥塞');
        assert.strictEqual(q.getStatus().stats.dropped, 1);
    });

    test('stop() 复位处理锁，避免重启后永不处理', async () => {
        const q = makeQueue({ processInterval: 10, sendTimeout: 1000 });
        let resolveSend;
        q.setSendHandler(() => new Promise(r => { resolveSend = r; }));
        q.enqueue(mk('qq', 'F', 'F1'));
        q.start();
        await sleep(50);
        assert.strictEqual(q.getStatus().processing, true, '此刻应正在处理');

        q.stop();
        assert.strictEqual(q.getStatus().processing, false, 'stop 必须复位 processing');
        if (resolveSend) resolveSend(true);
    });

    test('成功发送后统计正确', async () => {
        const q = makeQueue({ processInterval: 10 });
        q.setSendHandler(async () => true);
        q.enqueue(mk('qq', 'G', 'G1'));
        q.start();
        await sleep(100);

        assert.strictEqual(q.getStatus().stats.success, 1);
        assert.strictEqual(q.getStatus().length, 0, '成功后应从队列移除');
    });
});
