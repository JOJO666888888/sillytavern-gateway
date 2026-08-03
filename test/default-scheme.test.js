/**
 * 默认方案测试（Task 6）
 *
 * 守护 spec.md "开箱即用初始 Agent 方案"：
 *   - SubTask 6.1: default-rp.yaml 可加载、含 isDefault、工具白名单齐全
 *   - SubTask 6.2: 默认记忆模板四层 + 摘要规则文件存在
 *   - SubTask 6.3: 默认文风 Skill 存在且含去八股规则
 *   - SubTask 6.4/6.5: agent-loader.getDefault() 可识别默认方案
 *   - SubTask 6.7: state-engine.yaml 可加载
 *   - SubTask 6.8: independent-character.yaml 可加载 + namespace 隔离生效
 *   - 从默认方案创建副本逻辑（SubTask 6.6 的核心：改名 + 去 isDefault）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpDir, silentLogger } from './helpers.js';
import { AgentLoader } from '../plugins/agent-framework/engine/agent-loader.js';
import { MemoryEngine } from '../plugins/agent-framework/engine/memory-engine.js';
import { StateManager } from '../plugins/agent-framework/engine/state-manager.js';
import { SubagentDispatcher } from '../plugins/agent-framework/engine/subagent-dispatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'plugins', 'agent-framework', 'templates');
const DEFAULTS_DIR = path.join(TEMPLATES_DIR, 'defaults');

// ==================== SubTask 6.1: default-rp.yaml ====================

describe('SubTask 6.1 - default-rp.yaml 默认 Agent 方案', () => {
    test('模板文件存在', () => {
        assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, 'default-rp.yaml')),
            'templates/default-rp.yaml 应存在');
    });

    test('可被 AgentLoader 加载，且 name=default-rp', () => {
        const { dir, cleanup } = tmpDir();
        try {
            // 复制模板到临时目录
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('default-rp');
            assert.ok(def, 'default-rp 应被加载');
            assert.strictEqual(def.name, 'default-rp');
        } finally {
            cleanup();
        }
    });

    test('含 isDefault: true 标记', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.getDefault();
            assert.ok(def, 'getDefault() 应返回默认方案');
            assert.strictEqual(def.name, 'default-rp');
            assert.strictEqual(def.isDefault, true);
        } finally {
            cleanup();
        }
    });

    test('getDefaultName 返回 default-rp', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            assert.strictEqual(loader.getDefaultName(), 'default-rp');
        } finally {
            cleanup();
        }
    });

    test('工具白名单包含核心工具', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('default-rp');
            const tools = def.tools || [];
            const required = ['state.read', 'state.write', 'memory.recall', 'memory.update', 'character.read', 'subagent.dispatch'];
            for (const t of required) {
                assert.ok(tools.includes(t), `工具白名单应包含 ${t}`);
            }
        } finally {
            cleanup();
        }
    });

    test('含 systemPrompt 和 context 配置', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('default-rp');
            assert.ok(def.systemPrompt && def.systemPrompt.length > 100, 'systemPrompt 应非空且内容充分');
            assert.ok(def.context, '应含 context 配置');
            assert.ok(def.context.historyLimit > 0, 'context.historyLimit 应为正数');
            assert.ok(def.context.injectFiles && def.context.injectFiles.length > 0, '应注入文件列表');
        } finally {
            cleanup();
        }
    });

    test('含 critic-character 子代理配置', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('default-rp');
            assert.ok(def.subAgents && def.subAgents.length > 0, '应含子代理配置');
            const critic = def.subAgents.find(s => s.name === 'critic-character');
            assert.ok(critic, '应含 critic-character 子代理');
            assert.strictEqual(critic.trigger, 'after_draft');
        } finally {
            cleanup();
        }
    });
});

// ==================== SubTask 6.2: 默认记忆模板 ====================

describe('SubTask 6.2 - 默认记忆模板', () => {
    test('四层记忆模板文件存在', () => {
        const memoryDir = path.join(DEFAULTS_DIR, 'memory');
        const required = ['project.md', 'reference.md', 'feedback.md', 'user.md'];
        for (const f of required) {
            assert.ok(fs.existsSync(path.join(memoryDir, f)), `memory/${f} 应存在`);
        }
    });

    test('摘要规则文件存在', () => {
        assert.ok(fs.existsSync(path.join(DEFAULTS_DIR, 'memory', 'SUMMARY_RULES.md')),
            'memory/SUMMARY_RULES.md 应存在');
    });

    test('记忆模板内容非空且有结构', () => {
        const project = fs.readFileSync(path.join(DEFAULTS_DIR, 'memory', 'project.md'), 'utf-8');
        assert.ok(project.trim().length > 0, 'project.md 不应为空');
        // 应含标题或结构标记（# 或 【 或 -）
        assert.ok(/^(#|【|-)/m.test(project), 'project.md 应有结构化标题');
    });
});

// ==================== SubTask 6.3: 默认文风 Skill ====================

describe('SubTask 6.3 - 默认文风 Skill', () => {
    test('default.md 文风文件存在', () => {
        assert.ok(fs.existsSync(path.join(DEFAULTS_DIR, 'styles', 'default.md')),
            'styles/default.md 应存在');
    });

    test('文风内容含去八股规则', () => {
        const style = fs.readFileSync(path.join(DEFAULTS_DIR, 'styles', 'default.md'), 'utf-8');
        assert.ok(style.length > 100, '文风内容应充分');
        // 应含去八股相关关键词
        const lower = style.toLowerCase();
        const hasAntiCliche = style.includes('八股') || style.includes('作为') || style.includes('排比') || style.includes('空洞');
        assert.ok(hasAntiCliche, '文风应含去八股规则');
    });
});

// ==================== SubTask 6.4/6.5: 默认方案识别 ====================

describe('SubTask 6.4/6.5 - 默认方案识别与一键开玩', () => {
    test('播种所有模板后 getDefault 仍只返回 default-rp', () => {
        const { dir, cleanup } = tmpDir();
        try {
            const seeds = ['default-rp.yaml', 'multi-critic.yaml', 'director-mode.yaml', 'state-engine.yaml', 'independent-character.yaml'];
            for (const f of seeds) {
                const src = path.join(TEMPLATES_DIR, f);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, path.join(dir, f));
                }
            }
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.getDefault();
            assert.ok(def, '应有默认方案');
            assert.strictEqual(def.name, 'default-rp');
            assert.strictEqual(def.isDefault, true);
        } finally {
            cleanup();
        }
    });

    test('list() 返回的条目含 isDefault 标记', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'default-rp.yaml'),
                path.join(dir, 'default-rp.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const list = loader.list();
            const def = list.find(a => a.name === 'default-rp');
            assert.ok(def, 'list 应含 default-rp');
            assert.strictEqual(def.isDefault, true);
        } finally {
            cleanup();
        }
    });
});

// ==================== SubTask 6.6: 从默认方案创建副本 ====================

describe('SubTask 6.6 - 从默认方案创建副本逻辑', () => {
    test('复制并改名后 name 字段更新、isDefault 被移除', () => {
        const { dir, cleanup } = tmpDir();
        try {
            const src = fs.readFileSync(path.join(TEMPLATES_DIR, 'default-rp.yaml'), 'utf-8');
            let yamlText = src;
            // 模拟 server/index.js 中的复制逻辑
            yamlText = yamlText.replace(/^name:\s*default-rp\s*$/m, 'name: my-custom-rp');
            yamlText = yamlText.replace(/^isDefault:\s*true\s*$/m, '# isDefault: true');
            fs.writeFileSync(path.join(dir, 'my-custom-rp.yaml'), yamlText, 'utf-8');

            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('my-custom-rp');
            assert.ok(def, '副本应被加载');
            assert.strictEqual(def.name, 'my-custom-rp');
            assert.notStrictEqual(def.isDefault, true, '副本不应是默认方案');
        } finally {
            cleanup();
        }
    });

    test('agentLoader.save 可保存副本并覆盖 name', () => {
        const { dir, cleanup } = tmpDir();
        try {
            const loader = new AgentLoader(dir);
            let yamlText = fs.readFileSync(path.join(TEMPLATES_DIR, 'default-rp.yaml'), 'utf-8');
            yamlText = yamlText.replace(/^name:\s*default-rp\s*$/m, 'name: test-clone');
            yamlText = yamlText.replace(/^isDefault:\s*true\s*$/m, '# isDefault: true');
            const def = loader.save('test-clone', yamlText);
            assert.strictEqual(def.name, 'test-clone');
            assert.notStrictEqual(def.isDefault, true);
            // 文件应存在
            assert.ok(fs.existsSync(path.join(dir, 'test-clone.yaml')));
        } finally {
            cleanup();
        }
    });
});

// ==================== SubTask 6.7: state-engine.yaml ====================

describe('SubTask 6.7 - state-engine.yaml 状态引擎模板', () => {
    test('模板文件存在且可加载', () => {
        assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, 'state-engine.yaml')));
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'state-engine.yaml'),
                path.join(dir, 'state-engine.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('state-engine');
            assert.ok(def, 'state-engine 应被加载');
            assert.strictEqual(def.name, 'state-engine');
        } finally {
            cleanup();
        }
    });

    test('含状态优先循环的工具白名单', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'state-engine.yaml'),
                path.join(dir, 'state-engine.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('state-engine');
            const tools = def.tools || [];
            assert.ok(tools.includes('state.read'), '应含 state.read');
            assert.ok(tools.includes('state.write'), '应含 state.write');
            assert.ok(tools.includes('state.list'), '应含 state.list');
        } finally {
            cleanup();
        }
    });
});

// ==================== SubTask 6.8: independent-character + namespace 隔离 ====================

describe('SubTask 6.8 - independent-character.yaml + namespace 隔离', () => {
    test('模板文件存在且可加载', () => {
        assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, 'independent-character.yaml')));
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'independent-character.yaml'),
                path.join(dir, 'independent-character.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('independent-character');
            assert.ok(def, 'independent-character 应被加载');
            assert.strictEqual(def.name, 'independent-character');
        } finally {
            cleanup();
        }
    });

    test('子代理配置含 namespace 字段', () => {
        const { dir, cleanup } = tmpDir();
        try {
            fs.copyFileSync(
                path.join(TEMPLATES_DIR, 'independent-character.yaml'),
                path.join(dir, 'independent-character.yaml'),
            );
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const def = loader.get('independent-character');
            assert.ok(def.subAgents && def.subAgents.length > 0, '应含子代理');
            const charAgent = def.subAgents.find(s => s.namespace);
            assert.ok(charAgent, '应有子代理含 namespace 字段');
            assert.ok(charAgent.namespace.includes('char'), 'namespace 应含 char 前缀');
        } finally {
            cleanup();
        }
    });
});

// ==================== namespace 隔离：MemoryEngine ====================

describe('SubTask 6.8 - MemoryEngine namespace 隔离', () => {
    let env;
    before(() => {
        env = tmpDir();
    });
    after(() => {
        env.cleanup();
    });

    test('全局记忆与角色记忆互不干扰', () => {
        const engine = new MemoryEngine(env.dir);
        // 写全局记忆
        engine.update('project', '全局剧情进度', '');
        // 写角色 alice 的独立记忆
        engine.update('project', 'Alice 的视角记忆', 'char:alice');

        // 读全局
        assert.strictEqual(engine.read('project', ''), '全局剧情进度');
        // 读 alice 的
        assert.strictEqual(engine.read('project', 'char:alice'), 'Alice 的视角记忆');
        // 全局不受 alice 影响
        assert.strictEqual(engine.read('project'), '全局剧情进度');
    });

    test('不同 namespace 的记忆互不可见', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('user', 'Alice 的用户设定', 'char:alice');
        engine.update('user', 'Bob 的用户设定', 'char:bob');

        assert.strictEqual(engine.read('user', 'char:alice'), 'Alice 的用户设定');
        assert.strictEqual(engine.read('user', 'char:bob'), 'Bob 的用户设定');
        // 全局 user 为空（未被写入）
        assert.strictEqual(engine.read('user', ''), '');
    });

    test('recall 在指定 namespace 下只检索该 namespace', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('reference', 'Alice 见过龙', 'char:alice');
        engine.update('reference', 'Bob 见过巨人', 'char:bob');

        const aliceResults = engine.recall('龙', 5, 'char:alice');
        assert.ok(aliceResults.some(r => r.content.includes('龙')));
        assert.ok(!aliceResults.some(r => r.content.includes('巨人')), 'Alice 不应看到 Bob 的记忆');

        const bobResults = engine.recall('巨人', 5, 'char:bob');
        assert.ok(bobResults.some(r => r.content.includes('巨人')));
        assert.ok(!bobResults.some(r => r.content.includes('龙')), 'Bob 不应看到 Alice 的记忆');
    });

    test('namespace 目录路径安全（冒号转分隔符）', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('project', 'test', 'char:alice');
        // 文件应存储在 memory/char/alice/project.md
        const expectedPath = path.join(env.dir, 'memory', 'char', 'alice', 'project.md');
        assert.ok(fs.existsSync(expectedPath), `记忆文件应存储在 ${expectedPath}`);
    });

    test('listNamespaces 列出已创建的 namespace', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('project', 'test1', 'char:alice');
        engine.update('project', 'test2', 'char:bob');
        const namespaces = engine.listNamespaces();
        // 应含 char/alice 和 char/bob
        const hasAlice = namespaces.some(ns => ns.includes('alice'));
        const hasBob = namespaces.some(ns => ns.includes('bob'));
        assert.ok(hasAlice, '应列出 char/alice');
        assert.ok(hasBob, '应列出 char/bob');
    });

    test('未传 namespace 时向后兼容（使用全局）', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('project', '全局内容');
        assert.strictEqual(engine.read('project'), '全局内容');
        assert.strictEqual(engine.read('project', undefined), '全局内容');
        assert.strictEqual(engine.read('project', null), '全局内容');
    });

    test('recall 多类型公平：单类型段落多不占满结果上限', () => {
        const engine = new MemoryEngine(env.dir);
        // project 有 6 个匹配段落，reference 只有 1 个 —— 旧实现 project 前 5 段会占满 limit
        engine.update('project', [
            '段落一 关于龙', '段落二 关于龙', '段落三 关于龙',
            '段落四 关于龙', '段落五 关于龙', '段落六 关于龙',
        ].join('\n\n'));
        engine.update('reference', '只有一条关于龙的参考');

        const results = engine.recall('龙', 5);
        assert.ok(results.length <= 5, `结果数应 <= limit(5)，实际 ${results.length}`);
        assert.ok(results.some(r => r.type === 'reference'), 'reference 类型应有机会被检索到');
    });

    test('recall 按命中关键词数排序', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('project', '龙 与 宝藏');
        engine.update('reference', '龙');

        const results = engine.recall('龙 宝藏', 5);
        assert.ok(results.length >= 2, '应同时返回两段记忆');
        assert.strictEqual(results[0].type, 'project', '命中 2 词的段落应排最前');
        assert.strictEqual(results[0].content, '龙 与 宝藏');
        // 返回契约不含 score 字段
        assert.ok(!('score' in results[0]), '返回对象不应包含 score 字段');
    });

    test('recall 空查询返回空数组', () => {
        const engine = new MemoryEngine(env.dir);
        engine.update('project', '任意内容');
        assert.deepStrictEqual(engine.recall('   ', 5), []);
    });
});

// ==================== namespace 隔离：StateManager ====================

describe('SubTask 6.8 - StateManager namespace 隔离', () => {
    let env;
    before(() => {
        env = tmpDir();
    });
    after(() => {
        env.cleanup();
    });

    test('全局状态与角色私有状态互不干扰', () => {
        const sm = new StateManager(env.dir);
        // 全局世界状态
        sm.write('native', 'default', 'time', '第三天', '');
        // Alice 的私有状态
        sm.write('native', 'default', 'mood', '开心', 'char:alice');
        // Bob 的私有状态
        sm.write('native', 'default', 'mood', '愤怒', 'char:bob');

        // 全局状态
        assert.strictEqual(sm.read('native', 'default', 'time', ''), '第三天');
        assert.strictEqual(sm.read('native', 'default', 'mood', ''), undefined);

        // Alice 私有
        assert.strictEqual(sm.read('native', 'default', 'mood', 'char:alice'), '开心');
        // Bob 私有
        assert.strictEqual(sm.read('native', 'default', 'mood', 'char:bob'), '愤怒');
    });

    test('namespace 状态文件存储在独立子目录', () => {
        const sm = new StateManager(env.dir);
        sm.write('native', 'default', 'hp', 80, 'char:alice');
        sm.flush(); // 写缓冲批处理：断言文件存在前先落盘
        const expectedPath = path.join(env.dir, 'states', 'char', 'alice', 'native_default.json');
        assert.ok(fs.existsSync(expectedPath), `状态文件应存储在 ${expectedPath}`);
    });

    test('写缓冲合并：同文件多次写入只落盘最后一次（flush 后）', () => {
        const sm = new StateManager(env.dir);
        sm.write('native', 'default', 'hp', 100);
        sm.write('native', 'default', 'hp', 50);
        sm.write('native', 'default', 'hp', 30);
        sm.flush();
        const filePath = path.join(env.dir, 'states', 'native_default.json');
        const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        assert.strictEqual(state.hp, 30, '最终值应为最后一次写入');
    });

    test('未 flush 前 cache 已可见（读一致性）', () => {
        const sm = new StateManager(env.dir);
        sm.write('native', 'default', 'hp', 80);
        // 写缓冲未落盘，但内存 cache 立即一致
        assert.strictEqual(sm.read('native', 'default', 'hp'), 80);
        sm.flush();
        const state = JSON.parse(fs.readFileSync(path.join(env.dir, 'states', 'native_default.json'), 'utf-8'));
        assert.strictEqual(state.hp, 80);
    });

    test('dispose 幂等且落盘缓冲', () => {
        const sm = new StateManager(env.dir);
        sm.write('native', 'default', 'a', 1);
        sm.dispose();
        sm.dispose(); // 多次调用不抛错
        const state = JSON.parse(fs.readFileSync(path.join(env.dir, 'states', 'native_default.json'), 'utf-8'));
        assert.strictEqual(state.a, 1);
    });

    test('未传 namespace 时向后兼容', () => {
        const sm = new StateManager(env.dir);
        sm.write('native', 'default', 'turn', 5);
        assert.strictEqual(sm.read('native', 'default', 'turn'), 5);
        assert.strictEqual(sm.read('native', 'default', 'turn', undefined), 5);
    });

    test('delete 仅影响指定 namespace', () => {
        const sm = new StateManager(env.dir);
        sm.write('native', 'default', 'secret', 'A', 'char:alice');
        sm.write('native', 'default', 'secret', 'B', 'char:bob');

        sm.delete('native', 'default', 'secret', 'char:alice');
        assert.strictEqual(sm.read('native', 'default', 'secret', 'char:alice'), undefined);
        // Bob 的不受影响
        assert.strictEqual(sm.read('native', 'default', 'secret', 'char:bob'), 'B');
    });
});

// ==================== namespace 解析：SubagentDispatcher ====================

describe('SubTask 6.8 - SubagentDispatcher namespace 解析', () => {
    test('_resolveNamespace 支持 ${variable} 占位符', () => {
        const dispatcher = new SubagentDispatcher({ logger: silentLogger });
        const definition = { namespace: 'char:${character}' };
        const session = { character: 'alice' };
        const ns = dispatcher._resolveNamespace(definition, session, {});
        assert.strictEqual(ns, 'char:alice');
    });

    test('options.namespace 优先于 definition.namespace', () => {
        const dispatcher = new SubagentDispatcher({ logger: silentLogger });
        const definition = { namespace: 'char:default' };
        const session = {};
        const ns = dispatcher._resolveNamespace(definition, session, { namespace: 'char:override' });
        assert.strictEqual(ns, 'char:override');
    });

    test('definition.namespace 优先于 session.namespace', () => {
        const dispatcher = new SubagentDispatcher({ logger: silentLogger });
        const definition = { namespace: 'char:from-def' };
        const session = { namespace: 'char:from-session' };
        const ns = dispatcher._resolveNamespace(definition, session, {});
        assert.strictEqual(ns, 'char:from-def');
    });

    test('无 namespace 时返回空字符串', () => {
        const dispatcher = new SubagentDispatcher({ logger: silentLogger });
        const ns = dispatcher._resolveNamespace({}, {}, {});
        assert.strictEqual(ns, '');
    });
});

// ==================== 综合端到端：默认方案播种 ====================

describe('综合 - 默认方案播种流程', () => {
    test('所有 5 个模板文件均存在', () => {
        const seeds = [
            'default-rp.yaml',
            'multi-critic.yaml',
            'director-mode.yaml',
            'state-engine.yaml',
            'independent-character.yaml',
        ];
        for (const f of seeds) {
            assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, f)), `模板 ${f} 应存在`);
        }
    });

    test('所有模板均可被 AgentLoader 加载', () => {
        const { dir, cleanup } = tmpDir();
        try {
            const seeds = [
                'default-rp.yaml',
                'multi-critic.yaml',
                'director-mode.yaml',
                'state-engine.yaml',
                'independent-character.yaml',
            ];
            for (const f of seeds) {
                fs.copyFileSync(path.join(TEMPLATES_DIR, f), path.join(dir, f));
            }
            const loader = new AgentLoader(dir);
            loader.loadAll();
            const list = loader.list();
            assert.strictEqual(list.length, 5, '应加载 5 个模板');
            const names = list.map(a => a.name);
            for (const seed of ['default-rp', 'multi-critic', 'director-mode', 'state-engine', 'independent-character']) {
                assert.ok(names.includes(seed), `应含 ${seed}`);
            }
        } finally {
            cleanup();
        }
    });
});
