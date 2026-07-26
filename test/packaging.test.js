import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf-8'));

/**
 * 这组断言防的是同一类事故：依赖清单看着没问题，装出来却缺东西。
 *
 * 真实踩过的坑：optionalDependencies 里写了 `qq-official-bot: ^2.5.0`，
 * 而该包最新只发到 1.2.3。npm 对**装不上的可选依赖不报错**，只是静默跳过，
 * 于是 lock 里没有这个包、镜像里没有这个包、用户启用 QQ 官方机器人时
 * 只会看到"未安装 SDK"——而 CI 全绿。
 */
describe('依赖清单与 lock 文件', () => {
    test('lock 文件版本与 package.json 一致', () => {
        assert.equal(lock.name, pkg.name);
        assert.equal(lock.version, pkg.version);
    });

    test('每个 dependencies 都在 lock 中有解析结果', () => {
        for (const name of Object.keys(pkg.dependencies || {})) {
            assert.ok(
                lock.packages[`node_modules/${name}`],
                `dependencies 里的 ${name} 在 lock 文件中没有对应条目，npm ci 会失败`
            );
        }
    });

    test('每个 optionalDependencies 都在 lock 中有解析结果', () => {
        for (const name of Object.keys(pkg.optionalDependencies || {})) {
            assert.ok(
                lock.packages[`node_modules/${name}`],
                `可选依赖 ${name} 的版本范围解析不出任何已发布版本（npm 会静默跳过），` +
                `镜像里不会有它，对应平台适配器将永远处于"未安装 SDK"状态`
            );
        }
    });

    test('lock 中记录的版本满足 package.json 声明的范围', () => {
        const rootDeps = lock.packages[''];
        for (const field of ['dependencies', 'optionalDependencies']) {
            assert.deepEqual(
                rootDeps[field] || {},
                pkg[field] || {},
                `lock 根条目的 ${field} 与 package.json 不一致，npm ci 会拒绝安装`
            );
        }
    });
});

describe('Docker 构建上下文', () => {
    const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    test('lock 文件没有被 .dockerignore 排除', () => {
        // Dockerfile 里 `COPY package.json package-lock.json ./` 是非通配的，
        // 被排除掉会让构建直接报 "file not found"
        assert.ok(
            !dockerignore.some(p => p === 'package-lock.json' || p === '*.json'),
            'package-lock.json 被 .dockerignore 排除了，npm ci 拿不到它'
        );
    });

    test('Dockerfile 用 npm ci 而非 npm install', () => {
        const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
        assert.match(dockerfile, /npm ci\b/, 'Dockerfile 应使用 npm ci 保证依赖树可复现');
        const installLines = dockerfile.split('\n')
            .filter(l => /npm install/.test(l) && !l.trim().startsWith('#'));
        assert.deepEqual(installLines, [], `Dockerfile 不应回退到 npm install: ${installLines}`);
    });

    test('token 取用脚本存在且被 package.json 暴露', () => {
        // 自动生成的 token 会被日志脱敏，这个脚本是唯一的取回途径
        assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'show-token.js')));
        assert.equal(pkg.scripts.token, 'node scripts/show-token.js');
    });
});
