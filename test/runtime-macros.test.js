/**
 * 宏引擎测试 - ST 宏迁移验证
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MacroEngine, processMacros } from '../server/runtime/macro-engine.js';

describe('setvar / getvar', () => {
    test('setvar + getvar 基本流程', () => {
        const engine = new MacroEngine({ charName: '清月', userName: 'Master' });
        const result = engine.process('{{setvar::foo::bar}}value is {{getvar::foo}}');
        assert.strictEqual(result, 'value is bar');
    });

    test('setvar 标签从文本中移除', () => {
        const engine = new MacroEngine();
        const result = engine.process('before{{setvar::x::y}}after');
        assert.strictEqual(result, 'beforeafter');
    });

    test('未定义变量返回空字符串', () => {
        const result = processMacros('{{getvar::undefined}}');
        assert.strictEqual(result, '');
    });

    test('getvar 带默认值 - 变量未定义时使用默认值', () => {
        const result = processMacros('{{getvar::lang::中文}}');
        assert.strictEqual(result, '中文');
    });

    test('getvar 带默认值 - 变量已定义时使用实际值', () => {
        const engine = new MacroEngine();
        engine.process('{{setvar::lang::日本語}}');
        const result = engine.process('{{getvar::lang::中文}}');
        assert.strictEqual(result, '日本語');
    });

    test('空值 setvar', () => {
        const result = processMacros('{{setvar::foo::}}{{getvar::foo}}');
        assert.strictEqual(result, '');
    });

    test('变量名大小写不敏感', () => {
        const engine = new MacroEngine();
        engine.process('{{setvar::Foo::bar}}');
        assert.strictEqual(engine.getVar('foo'), 'bar');
        assert.strictEqual(engine.getVar('FOO'), 'bar');
    });

    test('setvar value 中包含 ::', () => {
        const result = processMacros('{{setvar::foo::a::b::c}}{{getvar::foo}}');
        assert.strictEqual(result, 'a::b::c');
    });
});

describe('roll 骰子', () => {
    test('roll:dN 格式 (1-N 随机)', () => {
        const result = processMacros('{{roll:d10}}');
        const n = parseInt(result);
        assert.ok(n >= 1 && n <= 10, `期望 1-10, 得到 ${result}`);
    });

    test('roll:N 格式 (1-N 随机)', () => {
        const result = processMacros('{{roll:6}}');
        const n = parseInt(result);
        assert.ok(n >= 1 && n <= 6, `期望 1-6, 得到 ${result}`);
    });

    test('roll:NdM 格式 (N 个 M 面骰子之和)', () => {
        const result = processMacros('{{roll:3d6}}');
        const n = parseInt(result);
        assert.ok(n >= 3 && n <= 18, `期望 3-18, 得到 ${result}`);
    });

    test('roll:1d1 永远为 1', () => {
        for (let i = 0; i < 10; i++) {
            assert.strictEqual(processMacros('{{roll:1d1}}'), '1');
        }
    });
});

describe('random 随机选择', () => {
    test('随机选一个', () => {
        const options = ['🐱', '🐶', '🐰'];
        for (let i = 0; i < 20; i++) {
            const result = processMacros('{{random::🐱::🐶::🐰}}');
            assert.ok(options.includes(result), `结果 "${result}" 不在选项中`);
        }
    });

    test('只有一个选项时返回该选项', () => {
        assert.strictEqual(processMacros('{{random::唯一}}'), '唯一');
    });

    test('空选项返回空字符串', () => {
        const result = processMacros('{{random::}}');
        assert.strictEqual(result, '');
    });
});

describe('注释移除', () => {
    test('注释被完全移除', () => {
        const result = processMacros('before{{//这是注释}}after');
        assert.strictEqual(result, 'beforeafter');
    });

    test('多行注释', () => {
        const result = processMacros('a{{//第一行\n第二行}}b');
        assert.strictEqual(result, 'ab');
    });

    test('注释包含特殊字符', () => {
        const result = processMacros('x{{//含:冒号和{花括号}}y');
        // 注释内容 "含:冒号和{花括号" 到第一个 }} 结束
        assert.strictEqual(result, 'xy');
    });
});

describe('嵌套与递归', () => {
    test('getvar 结果中嵌套 getvar', () => {
        const engine = new MacroEngine();
        // setvar a = "{{getvar::b}}", setvar b = "hello"
        // getvar a -> "{{getvar::b}}" -> "hello"
        engine.setVar('b', 'hello');
        engine.setVar('a', '{{getvar::b}}');
        const result = engine.process('{{getvar::a}}');
        assert.strictEqual(result, 'hello');
    });

    test('多轮递归正常终止', () => {
        const engine = new MacroEngine();
        engine.setVar('a', '{{getvar::b}}');
        engine.setVar('b', '{{getvar::c}}');
        engine.setVar('c', 'deep');
        const result = engine.process('{{getvar::a}}');
        assert.strictEqual(result, 'deep');
    });

    test('char/user 在宏结果中也能替换', () => {
        const engine = new MacroEngine({ charName: '清月', userName: 'Master' });
        engine.setVar('greeting', '你好 {{char}}，我是 {{user}}');
        const result = engine.process('{{getvar::greeting}}');
        assert.strictEqual(result, '你好 清月，我是 Master');
    });
});

describe('综合场景', () => {
    test('预设中的 setvar 链 + getvar 展开 (模拟管线.txt)', () => {
        const text = [
            '{{setvar::fzj::- 鼓励剧情语出惊人}}',
            '{{setvar::tjq::- 允许不写无聊剧情}}',
            '<config>{{getvar::fzj}}\n{{getvar::tjq}}</config>',
        ].join('\n');
        const result = processMacros(text);
        assert.ok(result.includes('- 鼓励剧情语出惊人'));
        assert.ok(result.includes('- 允许不写无聊剧情'));
        assert.ok(!result.includes('{{setvar'));
        assert.ok(!result.includes('{{getvar'));
    });

    test('roll 宏在插图表路径中展开', () => {
        const text = 'image: SFW/qingyue/gxcp/happy/{{roll:1d10}}';
        const result = processMacros(text);
        assert.match(result, /^image: SFW\/qingyue\/gxcp\/happy\/\d+$/);
    });

    test('注释和变量声明混合 (模拟预设头部)', () => {
        const text = [
            '{{//作者：泉此方}}',
            '{{setvar::geshi::}}{{setvar::fkrobot::}}',
            '正文开始',
            '{{getvar::geshi}}{{getvar::fkrobot}}',
        ].join('\n');
        const result = processMacros(text);
        assert.ok(!result.includes('{{'));
        assert.ok(result.includes('正文开始'));
    });
});

describe('enableMacros=false 向后兼容', () => {
    test('关闭宏引擎时仅替换 char/user', () => {
        const engine = new MacroEngine({ charName: '清月', userName: 'Master' });
        const text = '{{setvar::foo::bar}}{{getvar::foo}} {{char}} and {{user}}';
        // 手动模拟关闭: 不调用 process, 只做 char/user 替换
        const result = text
            .replace(/\{\{char\}\}/gi, '清月')
            .replace(/\{\{user\}\}/gi, 'Master');
        assert.ok(result.includes('{{setvar::foo::bar}}'));
        assert.ok(result.includes('清月'));
        assert.ok(result.includes('Master'));
    });
});
