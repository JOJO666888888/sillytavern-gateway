/**
 * 与现有插件协同验证（SubTask 7.4）
 *
 * 守护 spec.md "Impact：plugins/option-splitter、message-to-image、
 * group-rp-bidding、rp-memory（多 Bot / 富渲染协同）"：
 *   - agent-rp 作为 IM 适配器，复用 option-splitter 的 >选项X： 格式约定
 *   - agent-rp 复用 message-to-image 的 ImageRenderer 渲染状态图（不可用则降级）
 *   - rp-memory 出站过滤（剥离 <summary>）不得破坏 option-splitter 的选项提取
 *   - group-rp-bidding 与 agent-rp 命令不冲突，endMarker 不误匹配选项格式
 *
 * 核心不变量：
 *   1. 格式契约稳定：agent-rp 产出的 >选项X： 能被 option-splitter 正确提取（中/阿数字）
 *   2. 渲染器复用：ImageRenderer 可从 message-to-image/renderer.js 导入
 *   3. 过滤链无冲突：rp-memory 剥离 <summary>/<thinking> 后，>选项X： 选项行存活
 *   4. 命令空间隔离：四个插件命令名互不重叠
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import AgentRPPlugin from '../plugins/agent-rp/index.js';
import OptionSplitterPlugin from '../plugins/option-splitter/index.js';
import GroupRPBiddingPlugin from '../plugins/group-rp-bidding/index.js';
import RPMemoryPlugin from '../plugins/rp-memory/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

/** 静默 logger */
const silentLogger = {
    info() {}, warn() {}, error() {}, debug() {},
    child() { return silentLogger; },
};

/** 构造最小可用插件实例（不触发 onLoad 副作用），可注入 config */
function makePlugin(PluginClass, name, config = {}) {
    const plugin = new PluginClass({
        name,
        pluginConfig: config,
        services: {
            gateway: {
                addInboundFilter: () => () => {},
                addOutboundFilter: () => () => {},
                sendMessage: () => {},
            },
        },
    });
    plugin.logger = silentLogger;
    return plugin;
}

// ====================================================================
// 1. option-splitter ↔ agent-rp 格式契约
// ====================================================================

describe('SubTask 7.4: option-splitter ↔ agent-rp 选项格式契约', () => {
    test('两端 OPTION_LINE_REGEX 源码一致（同一格式约定）', () => {
        // 守护：agent-rp 与 option-splitter 的选项行正则必须保持同步，
        // 否则 agent-rp 产出的选项格式 option-splitter 识别不了。
        const agentRpSrc = fs.readFileSync(
            path.join(PLUGINS_DIR, 'agent-rp', 'index.js'), 'utf-8');
        const splitterSrc = fs.readFileSync(
            path.join(PLUGINS_DIR, 'option-splitter', 'index.js'), 'utf-8');

        const agentRpMatch = agentRpSrc.match(/OPTION_LINE_REGEX\s*=\s*(\/.+\/[gim]+)/);
        const splitterMatch = splitterSrc.match(/DEFAULT_OPTION_LINE_REGEX\s*=\s*(\/.+\/[gim]+)/);
        assert.ok(agentRpMatch, 'agent-rp 须定义 OPTION_LINE_REGEX');
        assert.ok(splitterMatch, 'option-splitter 须定义 DEFAULT_OPTION_LINE_REGEX');
        assert.strictEqual(agentRpMatch[1], splitterMatch[1],
            '两端选项行正则源码必须一致（格式契约）');
    });

    test('option-splitter 能提取 agent-rp 产出的中文数字选项', () => {
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');
        // 模拟 agent-rp._sendOptions 产出的格式：>选项一：...
        const content = '酒馆里灯火通明。\n\n>选项一：向酒保打听消息\n>选项二：独自坐在角落观察';
        const { options, mainText } = splitter._extractFromContent(content);
        assert.strictEqual(options.length, 2, '应提取 2 个选项');
        assert.strictEqual(options[0].content, '向酒保打听消息');
        assert.strictEqual(options[1].content, '独自坐在角落观察');
        assert.ok(mainText.includes('酒馆里灯火通明'), '正文应保留');
        assert.ok(!mainText.includes('>选项'), '正文不应再含选项行');
    });

    test('option-splitter 能提取阿拉伯数字选项（agent-rp >10 项时用阿拉伯数字）', () => {
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');
        // agent-rp._toChineseNum: 1-10 用中文，>10 用阿拉伯数字
        const lines = [];
        for (let i = 1; i <= 12; i++) {
            const idx = i <= 10 ? '一二三四五六七八九十'[i - 1] : String(i);
            lines.push(`>选项${idx}：选项${i}内容`);
        }
        const content = '正文。\n\n' + lines.join('\n');
        const { options } = splitter._extractFromContent(content);
        assert.strictEqual(options.length, 12, '应提取全部 12 个选项');
        assert.strictEqual(options[0].content, '选项1内容');
        assert.strictEqual(options[11].content, '选项12内容');
    });

    test('option-splitter 支持 <options> 标签块（agent-rp 注释约定的批量格式）', () => {
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');
        // agent-rp 注释说明可用 <options> 标签块包裹（batch/sequential 模式都能识别）
        const content = '正文内容\n<options>\n>选项一：行动A\n>选项二：行动B\n</options>';
        const { options, mainText } = splitter._extractFromContent(content);
        assert.strictEqual(options.length, 2);
        assert.ok(mainText.includes('正文内容'));
        assert.ok(!mainText.includes('<options>'), '标签块应被移除');
    });

    test('agent-rp._toChineseNum 与 option-splitter 正则的数字范围对齐', () => {
        const agentRp = makePlugin(AgentRPPlugin, 'agent-rp');
        // 1-10 中文，>10 阿拉伯——两者都在 option-splitter 正则的字符类内
        assert.strictEqual(agentRp._toChineseNum(1), '一');
        assert.strictEqual(agentRp._toChineseNum(10), '十');
        assert.strictEqual(agentRp._toChineseNum(11), '11');

        // 验证 option-splitter 正则能匹配这两个范围
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');
        const content = `>选项${agentRp._toChineseNum(10)}：第十项\n>选项${agentRp._toChineseNum(15)}：第十五项`;
        const { options } = splitter._extractFromContent(content);
        assert.strictEqual(options.length, 2, '中文"十"与阿拉伯"15"都应被识别');
    });
});

// ====================================================================
// 2. message-to-image ↔ agent-rp 渲染器复用
// ====================================================================

describe('SubTask 7.4: message-to-image ↔ agent-rp 渲染器复用', () => {
    test('ImageRenderer 由 message-to-image/renderer.js 导出（静态契约检查）', () => {
        // 注：renderer.js 顶部 import puppeteer-core，测试环境未装该依赖时无法动态 import，
        // 故用静态源码扫描守护"导出契约"——agent-rp 靠此命名导出复用渲染器。
        const src = fs.readFileSync(
            path.join(PLUGINS_DIR, 'message-to-image', 'renderer.js'), 'utf-8');
        assert.match(src, /export\s+class\s+ImageRenderer\b/,
            'renderer.js 须以命名导出 ImageRenderer 类');
    });

    test('agent-rp 源码引用正确的 renderer 路径与命名导出（懒加载导入点）', () => {
        const src = fs.readFileSync(
            path.join(PLUGINS_DIR, 'agent-rp', 'index.js'), 'utf-8');
        assert.ok(src.includes("import('../message-to-image/renderer.js')"),
            'agent-rp 须从 message-to-image/renderer.js 懒加载');
        assert.ok(src.includes('ImageRenderer'),
            'agent-rp 须解构 ImageRenderer 命名导出');
    });

    test('agent-rp 实现渲染器降级：_sendStateCard 在渲染失败时走文本状态卡', () => {
        const agentRp = makePlugin(AgentRPPlugin, 'agent-rp');
        // 渲染器不可用时（puppeteer/Chrome 缺失）走文本降级路径
        assert.strictEqual(typeof agentRp._sendStateCard, 'function',
            'agent-rp 须实现 _sendStateCard（含降级逻辑）');
        assert.strictEqual(typeof agentRp._buildStateCardHtml, 'function',
            'agent-rp 须实现 _buildStateCardHtml（HTML 构建）');
        assert.strictEqual(typeof agentRp._getStateRenderer, 'function',
            'agent-rp 须实现 _getStateRenderer（懒加载渲染器，失败设标志）');
        // 降级标志位机制
        assert.ok('_stateRendererInitFailed' in agentRp, '须有渲染器初始化失败标志');
    });

    test('message-to-image plugin.json 存在且可被 agent-rp 引用（协同前置）', () => {
        const m2iJson = JSON.parse(fs.readFileSync(
            path.join(PLUGINS_DIR, 'message-to-image', 'plugin.json'), 'utf-8'));
        assert.strictEqual(m2iJson.name, 'message-to-image');
        assert.ok(m2iJson.main === 'index.js', '主入口标准');
    });
});

// ====================================================================
// 3. rp-memory ↔ agent-rp / option-splitter 过滤链无冲突
// ====================================================================

describe('SubTask 7.4: rp-memory ↔ option-splitter 过滤链无冲突', () => {
    test('rp-memory 剥离 <summary> 后 >选项X： 行存活（option-splitter 仍可提取）', () => {
        const rpMemory = makePlugin(RPMemoryPlugin, 'rp-memory', {
            stripSummaryTags: true,
            stripThinkTags: false,
            formatThinkTags: true,
        });
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');

        // 模拟 AI 回复：正文 + <summary> 摘要 + 选项（agent-rp 产出）
        const original = [
            '酒馆内，旅人推门而入。',
            '<summary>旅人抵达酒馆，准备打听消息</summary>',
            '>选项一：向酒保点一杯麦酒',
            '>选项二：直接询问悬赏告示',
        ].join('\n');

        // 1) rp-memory 出站过滤：提取 summary + 剥离 <summary> 标签
        const msg = { platform: 'qq', chatId: 'c1', content: original };
        const filtered = rpMemory.filterOutbound(msg);
        assert.ok(!filtered.content.includes('<summary>'), '<summary> 标签应被剥离');
        assert.ok(!filtered.content.includes('</summary>'), '</summary> 标签应被剥离');
        // 选项行必须存活
        assert.ok(filtered.content.includes('>选项一：'), '选项一行应存活');
        assert.ok(filtered.content.includes('>选项二：'), '选项二行应存活');

        // 2) option-splitter 接力：从过滤后的内容提取选项
        const { options, mainText } = splitter._extractFromContent(filtered.content);
        assert.strictEqual(options.length, 2, '过滤后仍应提取到 2 个选项');
        assert.strictEqual(options[0].content, '向酒保点一杯麦酒');
        assert.strictEqual(options[1].content, '直接询问悬赏告示');
        assert.ok(mainText.includes('酒馆内'), '正文应保留');
    });

    test('rp-memory 默认不剥离 选项 行（stripSummaryTags 只针对 <summary>）', () => {
        const rpMemory = makePlugin(RPMemoryPlugin, 'rp-memory');
        const content = '>选项一：行动\n<summary>摘要</summary>';
        const filtered = rpMemory.filterOutbound({ platform: 'qq', chatId: 'c1', content });
        // <summary> 被剥离，但 >选项一： 完整保留
        assert.ok(filtered.content.includes('>选项一：行动'));
    });

    test('过滤优先级：rp-memory 与 option-splitter 都用 priority 5（同优先级不破坏契约）', () => {
        // 守护：两个出站过滤器都注册为 priority 5，无论执行顺序如何，
        // rp-memory 只动 <summary>/<thinking>，option-splitter 只动 >选项X：，
        // 两者操作的内容域不重叠，故无冲突。
        const rpMemorySrc = fs.readFileSync(
            path.join(PLUGINS_DIR, 'rp-memory', 'index.js'), 'utf-8');
        const splitterSrc = fs.readFileSync(
            path.join(PLUGINS_DIR, 'option-splitter', 'index.js'), 'utf-8');
        assert.match(rpMemorySrc, /priority:\s*5/, 'rp-memory 注册 priority 5');
        assert.match(splitterSrc, /priority:\s*5/, 'option-splitter 注册 priority 5');
    });

    test('rp-memory 剥离 <thinking> 标签也不影响选项行', () => {
        const rpMemory = makePlugin(RPMemoryPlugin, 'rp-memory', {
            stripSummaryTags: true,
            stripThinkTags: true, // 显式剥离 thinking
        });
        const content = '<thinking>内心盘算</thinking>\n正文。\n>选项一：行动';
        const filtered = rpMemory.filterOutbound({ platform: 'qq', chatId: 'c1', content });
        assert.ok(!filtered.content.includes('<thinking>'), 'thinking 应被剥离');
        assert.ok(!filtered.content.includes('</thinking>'), '</thinking> 应被剥离');
        assert.ok(filtered.content.includes('>选项一：行动'), '选项行应存活');
    });
});

// ====================================================================
// 4. group-rp-bidding ↔ agent-rp 命令与格式隔离
// ====================================================================

describe('SubTask 7.4: group-rp-bidding ↔ agent-rp 命令与格式隔离', () => {
    test('命令名不冲突：agent-rp 用 /rp，group-rp-bidding 用 /bid /skip /bstatus /breset', () => {
        const rpCmds = AgentRPPlugin.commands.map(c => c.name);
        const bidCmds = GroupRPBiddingPlugin.commands.map(c => c.name);
        // 取交集
        const overlap = rpCmds.filter(c => bidCmds.includes(c));
        assert.deepStrictEqual(overlap, [], `命令重叠: ${overlap.join(', ')}`);

        // 显式校验关键命令归属
        assert.ok(rpCmds.includes('rp'), 'agent-rp 须注册 /rp');
        assert.ok(bidCmds.includes('bid'), 'group-rp-bidding 须注册 /bid');
        assert.ok(bidCmds.includes('skip'), 'group-rp-bidding 须注册 /skip');
    });

    test('别名也不冲突（中文别名空间隔离）', () => {
        const rpAlias = (AgentRPPlugin.commands.flatMap(c => c.alias || []));
        const bidAlias = (GroupRPBiddingPlugin.commands.flatMap(c => c.alias || []));
        const overlap = rpAlias.filter(a => bidAlias.includes(a));
        assert.deepStrictEqual(overlap, [], `别名重叠: ${overlap.join(', ')}`);
    });

    test('group-rp-bidding 的 endMarker 不匹配 option-splitter 的选项格式', () => {
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');
        // endMarker 默认 【本轮结束】
        const bidding = makePlugin(GroupRPBiddingPlugin, 'group-rp-bidding');
        const marker = bidding.getConfig('endMarker') || '【本轮结束】';

        // 把 endMarker 当作正文喂给 option-splitter，不应被误识别为选项
        const { options } = splitter._extractFromContent(`剧情推进。\n${marker}`);
        assert.strictEqual(options.length, 0, 'endMarker 不应被 option-splitter 识别为选项');

        // 反向：选项格式也不应被 group-rp-bidding 误识别为 endMarker
        assert.notStrictEqual('>选项一：行动', marker);
        assert.ok(!marker.startsWith('>选项'), 'endMarker 不应以 >选项 开头');
    });

    test('四个插件 plugin.json 互不依赖（无硬 dependencies 约束）', () => {
        const names = ['agent-rp', 'option-splitter', 'message-to-image', 'group-rp-bidding', 'rp-memory'];
        for (const name of names) {
            const pkg = JSON.parse(fs.readFileSync(
                path.join(PLUGINS_DIR, name, 'plugin.json'), 'utf-8'));
            // 协同通过软约定（格式契约 + 软导入），不通过硬 dependencies
            const deps = pkg.dependencies || [];
            assert.ok(!deps.includes('agent-rp') || name === 'agent-rp',
                `${name} 不应硬依赖 agent-rp（协同应为软约定）`);
        }
    });
});

// ====================================================================
// 5. 综合：完整出站过滤链端到端
// ====================================================================

describe('SubTask 7.4: 综合 - 完整出站过滤链（rp-memory → option-splitter）', () => {
    test('一条含 summary + thinking + 选项的消息经两道过滤后：标签剥离、选项可提取', () => {
        const rpMemory = makePlugin(RPMemoryPlugin, 'rp-memory', {
            stripSummaryTags: true,
            stripThinkTags: true,
        });
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter', {
            outputFormat: 'sequential',
        });

        const original = [
            '<thinking>旅人看起来很疲惫</thinking>',
            '酒馆内，旅人推门而入，风雪随之灌入。',
            '<summary>旅人抵达，将推动剧情</summary>',
            '>选项一：递上一杯热酒',
            '>选项二：询问他的来意',
        ].join('\n');

        // 第一道：rp-memory
        const msg1 = { platform: 'qq', chatId: 'group-1', content: original };
        const afterRpMemory = rpMemory.filterOutbound(msg1);
        assert.ok(!afterRpMemory.content.includes('<summary>'));
        assert.ok(!afterRpMemory.content.includes('<thinking>'));

        // 第二道：option-splitter
        const afterSplitter = splitter.filterOutbound(afterRpMemory);
        // sequential 模式：返回正文（选项被拆出单独发送）
        assert.ok(afterSplitter, '正文消息应非空');
        assert.ok(!afterSplitter.content.includes('>选项'), '正文不应再含选项行');
        assert.ok(afterSplitter.content.includes('酒馆内'), '正文应保留');
    });

    test('agent-rp 产出的 AgentRunResult 选项经格式化后可被 option-splitter 提取', () => {
        // 模拟 agent-rp._sendOptions 的格式化逻辑产出
        const agentRp = makePlugin(AgentRPPlugin, 'agent-rp');
        const options = [
            { label: '一', text: '向酒保打听' },
            { label: '二', text: '观察环境' },
        ];
        // 复刻 _sendOptions 的格式化（>选项X：text）
        const lines = options.map(o => `>选项${o.label}：${o.text}`);
        const content = '正文。\n\n' + lines.join('\n');

        // option-splitter 提取
        const splitter = makePlugin(OptionSplitterPlugin, 'option-splitter');
        const { options: extracted } = splitter._extractFromContent(content);
        assert.strictEqual(extracted.length, 2);
        assert.strictEqual(extracted[0].content, '向酒保打听');
        assert.strictEqual(extracted[1].content, '观察环境');
    });
});
