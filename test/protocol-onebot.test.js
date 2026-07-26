/**
 * OneBot v11 协议回归测试（P1-D 附带修复）
 *
 * 守护的核心不变量：
 *   1. 数组消息段的文本**不做** CQ 转义（历史 bug：转义后 [ ] & 在 QQ 端
 *      显示为 &#91; &#93; &amp;，Markdown 链接/代码块全乱码）
 *   2. CQ 参数中的 &#44; 必须反解码为逗号（否则含逗号的图片 URL 失效）
 *   3. 出站媒体按类型映射到对应段（语音→record，不再一律当图片）
 *   4. reply 段保留 replyToId
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseCQCode, segmentsToContent, contentToSegments } from '../server/protocols/onebot-v11.js';
import { MediaAsset, MediaType } from '../server/adapters/base-adapter.js';

describe('CQ 码解析', () => {
    test('&#44; 反解码为逗号，且转义逗号不导致参数错切', () => {
        const raw = '看图[CQ:image,url=http://h/p?a=1&#44;b=2&#44;c=3,file=x.jpg]';
        const segs = parseCQCode(raw);
        const img = segs.find(s => s.type === 'image');

        assert.strictEqual(img.data.url, 'http://h/p?a=1,b=2,c=3', '&#44; 必须还原为逗号，否则 URL 失效');
        assert.strictEqual(img.data.file, 'x.jpg', '转义的逗号不应被当作参数分隔符');
    });

    test('&#91; &#93; &amp; 正确反解码', () => {
        const segs = parseCQCode('文本 &#91;标记&#93; 与 &amp; 符号');
        assert.strictEqual(segs[0].data.text, '文本 [标记] 与 & 符号');
    });

    test('纯文本消息（无 CQ 码）原样成段', () => {
        const segs = parseCQCode('普通消息');
        assert.strictEqual(segs.length, 1);
        assert.strictEqual(segs[0].type, 'text');
    });

    test('空输入返回空数组，不抛异常', () => {
        assert.deepStrictEqual(parseCQCode(''), []);
        assert.deepStrictEqual(parseCQCode(null), []);
    });
});

describe('消息段 → 内容', () => {
    test('图片段产出带类型的 MediaAsset', () => {
        const r = segmentsToContent([{ type: 'image', data: { url: 'http://h/a.png' } }]);
        assert.strictEqual(r.media[0].type, MediaType.IMAGE);
        assert.strictEqual(r.media[0].url, 'http://h/a.png');
        assert.strictEqual(r.mediaUrls[0], 'http://h/a.png', '向后兼容的 mediaUrls');
    });

    test('语音/视频/文件段各自映射到正确类型', () => {
        const r = segmentsToContent([
            { type: 'record', data: { url: 'u1' } },
            { type: 'video', data: { url: 'u2' } },
            { type: 'file', data: { url: 'u3', name: 'a.pdf' } },
        ]);
        assert.deepStrictEqual(
            r.media.map(m => m.type),
            [MediaType.VOICE, MediaType.VIDEO, MediaType.FILE],
        );
    });

    test('reply 段保留 replyToId（历史 bug：被完全丢弃）', () => {
        const r = segmentsToContent([
            { type: 'reply', data: { id: '12345' } },
            { type: 'text', data: { text: '回答' } },
        ]);
        assert.strictEqual(r.replyToId, '12345');
        assert.strictEqual(r.text, '回答');
    });

    test('at 段标记 mentioned', () => {
        const r = segmentsToContent([{ type: 'at', data: { qq: '10001' } }]);
        assert.strictEqual(r.mentioned, true);
    });
});

describe('内容 → 消息段（出站）', () => {
    test('文本不再被 CQ 转义（修复 QQ 端乱码）', () => {
        const segs = contentToSegments('看这个[重要]链接 a&b', [], '');
        const textSeg = segs.find(s => s.type === 'text');
        assert.strictEqual(
            textSeg.data.text,
            '看这个[重要]链接 a&b',
            '数组格式消息段的文本不应转义，否则 QQ 端显示为 HTML 实体',
        );
    });

    test('媒体按类型映射到对应段', () => {
        const segs = contentToSegments('', [
            MediaAsset.voice('http://v/a.mp3'),
            new MediaAsset({ type: MediaType.FILE, url: 'http://f/x.pdf', name: 'x.pdf' }),
            MediaAsset.image('http://i/p.png'),
        ], '');

        assert.deepStrictEqual(segs.map(s => s.type), ['record', 'file', 'image']);
    });

    test('兼容旧调用：字符串数组按图片处理', () => {
        const segs = contentToSegments('', ['http://i/a.png'], '');
        assert.strictEqual(segs[0].type, 'image');
        assert.strictEqual(segs[0].data.file, 'http://i/a.png');
    });

    test('replyToId 生成 reply 段且在最前', () => {
        const segs = contentToSegments('内容', [], '999');
        assert.strictEqual(segs[0].type, 'reply');
        assert.strictEqual(segs[0].data.id, '999');
    });

    test('往返一致性：解析→生成 不改变可见文本', () => {
        const original = '你好[测试] & 世界';
        const segs = parseCQCode(original);
        const { text } = segmentsToContent(segs);
        const rebuilt = contentToSegments(text, [], '');
        assert.strictEqual(rebuilt.find(s => s.type === 'text').data.text, original);
    });
});
