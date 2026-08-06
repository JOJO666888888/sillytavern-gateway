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

describe('部署清单不能泄露凭据', () => {
    const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    test('.env 被 .dockerignore 排除', () => {
        // 部署第一步就是 cp .env.example .env，所以构建时它一定存在。
        // 不排除的话 COPY . . 会把全部 bot token / API key 烘进镜像层，
        // 之后 docker save / push / `docker run --rm 镜像 cat /app/.env` 都能拿到。
        assert.ok(dockerignore.includes('.env'), '.env 必须在 .dockerignore 里');
        assert.ok(dockerignore.includes('.env.*'), '.env.local 之类也要排除');
        assert.ok(dockerignore.includes('!.env.example'), '模板文件应保留在构建上下文');
    });

    test('NapCat 的 QQ 登录态两边都被忽略', () => {
        assert.ok(dockerignore.includes('napcat/'), 'napcat/ 含登录凭据，不能进镜像');
        assert.ok(gitignore.includes('napcat/'), 'napcat/ 不能被提交');
    });

    test('开发环境痕迹不进镜像', () => {
        for (const p of ['.claude/', 'test-loader.js', 'test/', '.git']) {
            assert.ok(dockerignore.includes(p), `${p} 应被 .dockerignore 排除`);
        }
    });

    test('运行时状态目录一律不进镜像', () => {
        for (const p of ['config/', 'data/', 'logs/', 'assets/']) {
            assert.ok(dockerignore.includes(p), `${p} 是挂载卷，不能烘进镜像`);
        }
    });
});

describe('compose 与镜像的兼容性约束', () => {
    const composeRaw = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf-8');
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8');

    // 断言的是**配置**，不是注释。文件里有大段注释在解释"为什么某个写法是错的"，
    // 直接对原文 grep 会被自己的说明文字绊倒。
    const compose = composeRaw.split('\n')
        .filter(l => !/^\s*#/.test(l))
        .join('\n');

    /** 取出 services 下每个服务的配置块（按缩进切，不会误伤顶层 x-* 锚点） */
    function serviceBlocks(text) {
        const lines = text.split('\n');
        const start = lines.findIndex(l => /^services:\s*$/.test(l));
        assert.notEqual(start, -1, 'compose 里找不到 services:');
        const out = {};
        let name = null;
        for (const line of lines.slice(start + 1)) {
            if (/^\S/.test(line)) break;                    // 回到顶层，services 段结束
            const m = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
            if (m) { name = m[1]; out[name] = []; continue; }
            if (name) out[name].push(line);
        }
        return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]));
    }

    test('env_file 用字符串短语法', () => {
        // `path:/required:` 长语法是 Compose v2.24(2024-01) 才有的，
        // 老版本不是降级而是 schema 直接报错，up/config 全部起不来。
        // 目标人群大量在 NAS / 老 Debian 上，那里的 compose 普遍更旧。
        assert.doesNotMatch(compose, /env_file:\s*\n\s*-\s*path:/,
            'env_file 不能用长语法，会让 Compose < 2.24 直接报错');
        assert.match(compose, /env_file:\s*\n\s*-\s*\.env\s*$/m);
    });

    test('NapCat 的 QQ 数据挂在镜像真正会写的路径', () => {
        // 官方镜像里 napcat 用户 HOME=/app，QQ 写 /app/.config/QQ。
        // 挂到 root 家目录是错的：没有任何进程写那里，
        // 登录态不持久化，每次重建都要重新扫码。
        assert.match(compose, /:\/app\/\.config\/QQ/, 'QQ 登录态应挂到 /app/.config/QQ');
        assert.doesNotMatch(compose, /\/root\/\.config\/QQ/, 'root 家目录下那个路径是错的');
    });

    test('NapCat 用 MODE 而不是失效的旧开关变量开正向 WS', () => {
        // 现行镜像 entrypoint 只认 MODE（cp templates/$MODE.json → onebot11.json）。
        // 旧的 WS 开关是老接口，设了没用，3001 上不会有东西监听。
        assert.match(compose, /MODE:\s*ws/, '应用 MODE: ws 套用官方 ws 模板');
        assert.doesNotMatch(compose, /WS_ENABLE/, '旧开关变量现行镜像已不识别');
    });

    test('每个服务都有日志轮转', () => {
        // napcat 很吵且 restart 常开，不限制会把宿主机磁盘写满
        const services = serviceBlocks(compose);
        assert.deepEqual(Object.keys(services).sort(), ['gateway', 'napcat']);
        for (const [name, body] of Object.entries(services)) {
            assert.match(body, /logging:/, `服务 ${name} 缺少日志轮转配置`);
        }
    });

    test('网关有资源上限', () => {
        // 插件是主进程内 import() 执行的，没配额时坏插件撑爆的是宿主机
        assert.match(compose, /mem_limit:/);
        assert.match(compose, /pids_limit:/);
        assert.match(compose, /no-new-privileges:true/);
    });

    test('端口绑定地址可通过 .env 覆盖，不必改受 git 跟踪的 compose', () => {
        assert.match(compose, /\$\{GATEWAY_BIND_ADDR:-127\.0\.0\.1\}/);
        assert.match(envExample, /GATEWAY_BIND_ADDR/);
    });

    test('镜像装了 unzip —— 从 GitHub 装插件要用', () => {
        // plugin-manager 的 _extractZip() 会 execSync `unzip`，
        // bookworm-slim 不自带，缺了的话插件市场里每一个都装不上
        const pm = fs.readFileSync(path.join(ROOT, 'server', 'plugin-manager.js'), 'utf-8');
        if (/execSync\(`unzip/.test(pm)) {
            assert.match(dockerfile, /^\s+unzip \\$/m, 'plugin-manager 依赖 unzip，Dockerfile 必须装');
        }
    });

    test('compose 里引用的每个变量都在 .env.example 里有说明', () => {
        const referenced = new Set(
            [...compose.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}/g)].map(m => m[1])
        );
        const missing = [...referenced].filter(v => !envExample.includes(v));
        assert.deepEqual(missing, [], `这些变量 compose 用了但 .env.example 没提: ${missing}`);
    });
});

describe('容器里不该做的事要被拦住', () => {
    test('git 自更新端点在容器内直接给出正确指引', () => {
        // .dockerignore 排除了 .git、镜像里也没装 git，runGit 必然失败。
        // 前端把「检查更新」挂在 ST 启动流程上，不拦的话每开一次 ST
        // 就弹一次看不懂的 git 报错。
        const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf-8');
        assert.match(src, /IN_DOCKER/, '应有容器环境判定');
        assert.match(src, /GATEWAY_IN_DOCKER|\/\.dockerenv/, '判定应基于环境变量或 /.dockerenv');
        const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');
        assert.match(dockerfile, /GATEWAY_IN_DOCKER=1/, '镜像应打上容器标记');
    });

    test('插件数据目录创建失败不会让整个网关起不来', () => {
        // 裸 mkdirSync 抛出会冒到 startServer().catch() → process.exit(1)，
        // 配合 restart 策略变成无限崩溃重启循环
        const src = fs.readFileSync(path.join(ROOT, 'server', 'plugin-manager.js'), 'utf-8');
        assert.match(src, /dataDirWritable/, '应记录目录是否可写并降级');
    });
});

describe('落盘一律走原子写', () => {
    // 直接覆盖写的话，运行中 tar 备份或进程被 kill 时正好撞上写入，
    // 拿到的是半个文件。config.js 有"损坏就改名备份"的兜底，另两个没有。
    for (const rel of ['server/utils/config.js', 'server/runtime/chat-archive.js', 'server/session-manager.js']) {
        test(`${rel} 用 tmp + rename`, () => {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            assert.match(src, /renameSync/, `${rel} 应先写 tmp 再 rename`);
        });
    }
});

describe('测试自身不能破坏别人的数据', () => {
    /**
     * 真机事故：security-config.test.js 的 after() 钩子写成
     *   fs.rmSync('config', { recursive: true, force: true })
     * 这是**相对 CWD** 的路径。在仓库里跑没问题，但谁在自己的部署目录跑一次
     * `npm test`，config/（全部 bot token）和 data/（会话历史、聊天存档、
     * 插件配置与积累的数据）就被整个删掉——而且测试全绿，毫无提示。
     */
    const testFiles = fs.readdirSync(path.join(ROOT, 'test'))
        .filter(f => f.endsWith('.test.js') || f === 'helpers.js');

    /** 去掉注释再扫，否则会被"解释这个坑"的说明文字本身绊倒 */
    function stripComments(src) {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    }

    test('测试代码里不存在相对路径的递归删除', () => {
        const offenders = [];
        for (const f of testFiles) {
            const src = stripComments(fs.readFileSync(path.join(ROOT, 'test', f), 'utf-8'));
            // rm/rmSync 第一个参数是字符串字面量 = 相对 CWD，危险
            const re = /\b(?:fs\.)?rm(?:Sync)?\s*\(\s*(['"`])([^'"`$]+)\1/g;
            let m;
            while ((m = re.exec(src))) {
                offenders.push(f + ' → ' + m[2]);
            }
        }
        assert.deepEqual(offenders, [],
            '递归删除必须用基于 __dirname 的绝对路径，否则会删掉运行者当前目录下的同名目录');
    });

    test('清理钩子不碰 data/（可能含真实聊天存档）', () => {
        const src = fs.readFileSync(path.join(ROOT, 'test', 'security-config.test.js'), 'utf-8');
        const hook = src.slice(src.indexOf('after('), src.indexOf('describe('));
        assert.doesNotMatch(hook, /['"`]data['"`]/,
            'data/ 里可能有用户的聊天存档与插件数据，清理钩子不应包含它');
    });
});

describe('message-to-image 渲染不能依赖 networkidle0', () => {
    const renderer = fs.readFileSync(
        path.join(ROOT, 'plugins', 'message-to-image', 'renderer.js'), 'utf-8');

    /**
     * 真机事故：setContent 用 waitUntil:'networkidle0'。
     * 我们喂的 HTML 是全内联的，页面不发任何网络请求，所以 networkidle0
     * 要么立刻满足、要么被浏览器自身的后台连接（组件更新、扩展、Debian 的
     * chromium 包装脚本注入的 --enable-remote-extensions 等）拖到超时。
     * 同一份 HTML、同一个 chromium：独立进程 1.8s 渲染完，
     * systemd 起的服务里 100% 卡满 15s 超时 → 用户只看到"渲染失败，回退为原文本"。
     * 换 domcontentloaded 后 190ms 完成。
     */
    test('setContent 不使用 networkidle0', () => {
        assert.doesNotMatch(renderer, /waitUntil:\s*['"]networkidle/,
            'networkidle0 会被浏览器后台连接拖到超时，全内联 HTML 不该用它');
    });

    test('setContent 用 domcontentloaded', () => {
        assert.match(renderer, /setContent\([^)]*waitUntil:\s*['"]domcontentloaded['"]/s);
    });

    test('仍然显式等待字体与图片就绪', () => {
        // 放弃 networkidle0 之后，外链资源要靠显式等待兜住，否则自定义模板里
        // 的图片会在加载完成前就被截图
        assert.match(renderer, /document\.fonts\.ready/);
        assert.match(renderer, /document\.images/, '应显式等待 <img> 加载完成');
    });
});
