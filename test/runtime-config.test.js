/**
 * 自建推理管线 - 配置层默认值回归
 *
 * 守护"体验优先"的核心配置不变量：
 *   runtime.llm.maxTokens 必须存在且为正数——它是回复 token 预算下限，
 *   防止推理模型思维链吃光 max_tokens 或正文半途截断。
 *   旧配置文件里没有该字段时，deepMerge 会用默认值补齐（迁移安全）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import configManager from '../server/utils/config.js';

describe('runtime.llm.maxTokens 下限默认值', () => {
    test('字段存在且为正数', () => {
        const mt = configManager.config?.runtime?.llm?.maxTokens;
        assert.strictEqual(typeof mt, 'number', 'runtime.llm.maxTokens 必须存在（旧配置由 deepMerge 补齐）');
        assert.ok(mt > 0, `maxTokens 下限应为正数，实际 ${mt}`);
    });

    test('源码默认值足够慷慨（≥16384，RP 长思考/长输出）', () => {
        // 源码默认 16384；若实例配置更高则保留实例值，故用 >= 断言
        assert.ok(
            configManager.config.runtime.llm.maxTokens >= 16384,
            `maxTokens 默认下限应 ≥16384，实际 ${configManager.config.runtime.llm.maxTokens}`,
        );
    });
});
