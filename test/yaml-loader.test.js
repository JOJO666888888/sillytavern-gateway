/**
 * YAML 解析器升级测试（任务 1：js-yaml 4.x）
 *
 * 守护：agent-loader.js parseYAML 升级后——
 *   - js-yaml 支持 YAML 1.2 全特性（锚点/别名、合并键、flow 语法、复杂嵌套）
 *   - 非法 YAML 不崩 loadAll（回退简易解析）
 *   - save 往返语义一致
 *   - 性能无明显退化（宽松上界）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpDir } from './helpers.js';
import { AgentLoader } from '../plugins/agent-framework/engine/agent-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'plugins', 'agent-framework', 'templates');

/** 在临时目录建一个 AgentLoader 并写入给定 yaml 文件 */
function makeLoader(files) {
    const t = tmpDir('yaml-loader-');
    for (const [fname, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(t.dir, fname), content, 'utf-8');
    }
    return { loader: new AgentLoader(t.dir), cleanup: t.cleanup };
}

describe('js-yaml 增量能力（原简易解析不支持的特性）', () => {
    test('锚点 + 别名 + 合并键（<<）', () => {
        const { loader, cleanup } = makeLoader({
            'anchor.yaml': `
name: anchor-agent
displayName: 锚点测试
model:
  defaults: &defaults
    temperature: 0.7
    maxTokens: 4096
  config:
    <<: *defaults
    maxTokens: 8192
`.trim() + '\n',
        });
        try {
            loader.loadAll();
            const def = loader.get('anchor-agent');
            assert.ok(def, '应能加载含锚点/别名/合并键的 YAML');
            assert.strictEqual(def.model.config.temperature, 0.7, '合并键应带来自定义属性');
            assert.strictEqual(def.model.config.maxTokens, 8192, '显式值覆盖合并键');
        } finally {
            cleanup();
        }
    });

    test('flow 语法（{}/[]）与复杂嵌套', () => {
        const { loader, cleanup } = makeLoader({
            'flow.yaml': `
name: flow-agent
displayName: Flow测试
tags: [action, adventure, "含空格"]
props: { alpha: 1, beta: true, nested: { deep: [1, 2, 3] } }
context:
  injectFiles:
    - "styles/\${style}.md"
    - "memory/project.md"
subAgents:
  - name: critic-a
    trigger: after_draft
    parallel: true
  - name: critic-b
    trigger: after_outline
    parallel: false
`.trim() + '\n',
        });
        try {
            loader.loadAll();
            const def = loader.get('flow-agent');
            assert.ok(def, '应能加载 flow 语法 YAML');
            assert.deepStrictEqual(def.tags, ['action', 'adventure', '含空格']);
            assert.strictEqual(def.props.alpha, 1);
            assert.strictEqual(def.props.beta, true);
            assert.deepStrictEqual(def.props.nested.deep, [1, 2, 3]);
            assert.deepStrictEqual(def.context.injectFiles[0], 'styles/${style}.md');
            assert.strictEqual(def.subAgents.length, 2);
            assert.strictEqual(def.subAgents[0].parallel, true);
            assert.strictEqual(def.subAgents[1].parallel, false);
        } finally {
            cleanup();
        }
    });

    test('多行块标量（| 与 >）', () => {
        const { loader, cleanup } = makeLoader({
            'block.yaml': `
name: block-agent
displayName: 块标量
systemPrompt: |
  第一行
  第二行

  空行后第三行
summary: >
  折叠的
  内容
`.trim() + '\n',
        });
        try {
            loader.loadAll();
            const def = loader.get('block-agent');
            assert.ok(def, '应能加载块标量 YAML');
            assert.ok(def.systemPrompt.includes('第一行'));
            assert.ok(def.systemPrompt.includes('空行后第三行'));
            assert.ok(def.summary.includes('折叠的'));
        } finally {
            cleanup();
        }
    });
});

describe('容错与边界', () => {
    test('非法 YAML（重复键）不崩 loadAll，其它文件不受影响', () => {
        const { loader, cleanup } = makeLoader({
            'bad.yaml': 'name: dup\nname: dup2\n  broken_indent: [unclosed', // 既重复键又坏缩进
            'good.yaml': 'name: good-agent\ndisplayName: 好Agent\n',
        });
        try {
            assert.doesNotThrow(() => loader.loadAll());
            // good 文件必须仍可加载
            assert.ok(loader.get('good-agent'), '合法文件应正常加载');
        } finally {
            cleanup();
        }
    });

    test('空/非对象文档被安全跳过', () => {
        const { loader, cleanup } = makeLoader({
            'empty.yaml': '',
            'null.yaml': '---\n',
            'scalar.yaml': 'just a string\n',
        });
        try {
            assert.doesNotThrow(() => loader.loadAll());
            assert.strictEqual(loader.list().length, 0, '非法/空定义不应入库');
        } finally {
            cleanup();
        }
    });
});

describe('AgentLoader.save 往返', () => {
    test('保存后定义可读且文件落盘', () => {
        const t = tmpDir('yaml-save-');
        try {
            const loader = new AgentLoader(t.dir);
            const yamlText = 'name: saved-agent\ndisplayName: 保存测试\nmaxSteps: 7\n';
            const def = loader.save('saved-agent', yamlText);
            assert.strictEqual(def.name, 'saved-agent');
            assert.strictEqual(def.maxSteps, 7);
            assert.ok(fs.existsSync(path.join(t.dir, 'saved-agent.yaml')), '文件应落盘');
            // 重新加载也能读回
            const loader2 = new AgentLoader(t.dir);
            loader2.loadAll();
            assert.strictEqual(loader2.get('saved-agent').maxSteps, 7);
        } finally {
            t.cleanup();
        }
    });
});

describe('模板兼容性与性能', () => {
    test('6 个内置模板均可被 js-yaml 加载且字段结构正确', () => {
        const loader = new AgentLoader(TEMPLATES_DIR);
        assert.doesNotThrow(() => loader.loadAll());
        const agents = loader.list();
        assert.ok(agents.length >= 6, `模板应全部加载，实际 ${agents.length}`);
        const names = agents.map(a => a.name);
        for (const n of ['default-rp', 'multi-critic', 'director-mode', 'state-engine', 'independent-character', 'simple-rp']) {
            assert.ok(names.includes(n), `模板 ${n} 应加载`);
        }
        // 关键字段结构抽查
        const multi = loader.get('multi-critic');
        assert.ok(Array.isArray(multi.tools) && multi.tools.length > 0);
        assert.ok(Array.isArray(multi.context.injectFiles));
        assert.ok(Array.isArray(multi.subAgents) && multi.subAgents.length === 4);
        assert.strictEqual(multi.subAgents[0].trigger, 'after_draft');
        assert.strictEqual(typeof multi.systemPrompt, 'string');
    });

    test('性能不退化（宽松上界：全模板各解析 50 次 < 10s）', () => {
        const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.yaml'));
        assert.ok(files.length > 0);
        // 通过 AgentLoader 触发 js-yaml 全量解析（含 loadAll 的读盘 + 解析）
        const loader = new AgentLoader(TEMPLATES_DIR);
        const start = Date.now();
        for (let i = 0; i < 50; i++) {
            loader.loadAll();
        }
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 10000, `50 轮全量解析应在 10s 内（实际 ${elapsed}ms）`);
    });
});
