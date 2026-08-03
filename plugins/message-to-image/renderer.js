import puppeteer from 'puppeteer-core';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { computePagePlan, buildPageHtml, pageCacheKey, PAGE_FOOTER_HEIGHT } from './pagination.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 把本地绝对路径转成规范的 file:// URI。
 *
 * 必须走这一个函数，不要在调用点手拼。之前 render() 和 _getCachedImage()
 * 各拼一次 `file:///${path}`，Linux/macOS 上 path 本就以 / 开头，拼出来是
 * 4 个斜杠的畸形 URI（file:////home/...）。修的时候只改了 render() 那处，
 * 缓存命中那处漏了——症状变成"第一次渲染能发出去，同样内容再发一次就失败"。
 */
function toFileUrl(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

/**
 * 系统已安装的 Chrome/Chromium 可能路径（按优先级排序）
 * 覆盖 Linux 桌面、macOS、Windows、Termux(Android) 等环境
 */
const SYSTEM_CHROME_PATHS = [
    // Linux 桌面
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Termux (Android)
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
    // Windows 常见路径（用反斜杠，existsSync 兼容）
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * 轻量日志记录器
 * 支持分级日志（INFO/WARN/ERROR/DEBUG）+ 环形缓冲区 + 导出
 */
export class PluginLogger {
    constructor(maxEntries = 500) {
        this.entries = [];
        this.maxEntries = maxEntries;
    }

    _log(level, message, context = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            context: context ? (typeof context === 'string' ? context : JSON.stringify(context)) : null,
        };
        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
        // 同时输出到控制台
        const prefix = `[message-to-image][${level}]`;
        const ctxStr = context ? ` ${entry.context}` : '';
        if (level === 'ERROR') console.error(`${prefix} ${message}${ctxStr}`);
        else if (level === 'WARN') console.warn(`${prefix} ${message}${ctxStr}`);
        else if (level === 'DEBUG') console.debug(`${prefix} ${message}${ctxStr}`);
        else console.log(`${prefix} ${message}${ctxStr}`);
        return entry;
    }

    info(msg, ctx) { return this._log('INFO', msg, ctx); }
    warn(msg, ctx) { return this._log('WARN', msg, ctx); }
    error(msg, ctx) { return this._log('ERROR', msg, ctx); }
    debug(msg, ctx) { return this._log('DEBUG', msg, ctx); }

    /**
     * 获取最近 N 条日志
     */
    recent(count = 50, level = null) {
        let filtered = level ? this.entries.filter(e => e.level === level) : this.entries;
        return filtered.slice(-count);
    }

    /**
     * 导出日志为文本
     */
    exportText() {
        return this.entries.map(e => {
            const ctx = e.context ? ` | ${e.context}` : '';
            return `[${e.timestamp}] [${e.level}] ${e.message}${ctx}`;
        }).join('\n');
    }

    clear() {
        this.entries = [];
    }
}

/**
 * 图片渲染引擎
 * 基于 Puppeteer 将 HTML+CSS 渲染为 PNG/JPEG 图片
 * 特性：Browser 复用、Page 池、LRU 文件缓存、并发控制、详细日志
 */
export class ImageRenderer {
    constructor(options = {}) {
        this.cacheDir = options.cacheDir || path.join(__dirname, 'cache');
        this.logger = options.logger || new PluginLogger();
        this.options = {
            maxWidth: 800,
            imageFormat: 'png',
            imageQuality: 90,
            maxConcurrent: 2,
            pagePoolSize: 3,
            fontFamily: 'Microsoft YaHei, sans-serif',
            executablePath: '',
            headless: true,
            maxImageHeight: 1600,  // 单页最大高度（px，超过则分页），保证各页尺寸一致
            pageFooter: true,      // 分页时每张图底部显示页码
            ...options,
        };
        this.browser = null;
        this.pagePool = [];
        this.queue = [];
        this.running = 0;
        this.ready = false;
        this.stats = {
            totalRenders: 0,
            cacheHits: 0,
            cacheMisses: 0,
            failures: 0,
            totalRenderTime: 0,
        };
    }

    /**
     * 初始化 Puppeteer 浏览器和页面池
     */
    async init() {
        this.logger.info('初始化渲染引擎', { cacheDir: this.cacheDir });

        // 确保缓存目录存在
        await fs.mkdir(this.cacheDir, { recursive: true });

        // 构造启动参数
        const launchOptions = {
            headless: this.options.headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--font-render-hinting=none',
            ],
        };

        // 查找顺序：插件配置 > 环境变量 > 常见安装路径。
        // 环境变量这一层是为容器准备的：镜像里的 Chromium 装在哪由构建方决定，
        // 不该逼用户去改插件配置——设个 PUPPETEER_EXECUTABLE_PATH 就能跑。
        // 这两个名字是 puppeteer 生态的既有约定，用户大概率已经会设。
        const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;

        if (this.options.executablePath) {
            launchOptions.executablePath = this.options.executablePath;
            this.logger.info('使用配置指定的 Chrome 路径', { path: this.options.executablePath });
        } else if (envPath) {
            launchOptions.executablePath = envPath;
            this.logger.info('使用环境变量指定的 Chrome 路径', { path: envPath });
            if (!existsSync(envPath)) {
                this.logger.warn('环境变量指向的 Chrome 不存在，启动大概率会失败', { path: envPath });
            }
        } else {
            // 自动检测系统已安装的 Chrome/Chromium
            let detected = null;
            for (const p of SYSTEM_CHROME_PATHS) {
                if (existsSync(p)) {
                    detected = p;
                    break;
                }
            }
            if (detected) {
                launchOptions.executablePath = detected;
                this.logger.info('自动检测到系统 Chrome', { path: detected });
            } else {
                this.logger.warn('未找到系统 Chrome，puppeteer-core 需要外部浏览器。' +
                    '请设置插件配置 executablePath，或环境变量 PUPPETEER_EXECUTABLE_PATH');
            }
        }

        try {
            this.logger.info('启动 Puppeteer Browser...');
            this.browser = await puppeteer.launch(launchOptions);
            this.logger.info('Puppeteer Browser 已启动');
        } catch (err) {
            this.logger.error('Puppeteer 启动失败', { error: err.message });
            throw new Error(`Puppeteer 启动失败: ${err.message}。请确保已安装 puppeteer-core 依赖 (npm install) 并配置 Chrome 浏览器（通过 executablePath 或系统自动检测）。`);
        }

        // 初始化页面池
        this.logger.info('初始化页面池', { size: this.options.pagePoolSize });
        for (let i = 0; i < this.options.pagePoolSize; i++) {
            const page = await this.browser.newPage();
            await page.setViewport({ width: this.options.maxWidth, height: 1 });
            this.pagePool.push({ page, busy: false });
        }

        this.ready = true;
        this.logger.info('渲染引擎就绪', {
            maxWidth: this.options.maxWidth,
            imageFormat: this.options.imageFormat,
            maxConcurrent: this.options.maxConcurrent,
        });
    }

    /**
     * 渲染内容
     * @param {string} content - 原始文本（已转义 HTML）
     * @param {string} css - CSS 样式
     * @param {object} template - { html: string, preset: string }
     * @param {Array} rules - ST 正则规则数组
     * @param {object} variables - 变量占位符
     * @returns {Promise<string[]>} file:/// 图片路径数组（超长内容分页时为多张）
     */
    async render(content, css, template, rules = [], variables = {}) {
        if (!this.ready) {
            throw new Error('ImageRenderer 未初始化');
        }

        const renderId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const startTime = Date.now();
        this.logger.info(`[${renderId}] 渲染请求接收`, {
            contentLength: content.length,
            preset: template?.preset,
            rulesCount: rules.length,
            maxImageHeight: this.options.maxImageHeight,
        });

        // 1. 应用 ST 正则规则
        this.logger.debug(`[${renderId}] 应用 ST 正则规则`, { count: rules.length });
        const processedContent = this._applyRules(content, rules, renderId);
        this.logger.debug(`[${renderId}] 规则应用完成`, {
            beforeLength: content.length,
            afterLength: processedContent.length,
        });

        // 2. 套入模板
        const fullHtml = this._buildHtml(processedContent, css, template, variables);
        this.logger.debug(`[${renderId}] HTML 构建完成`, { htmlLength: fullHtml.length });

        // 3. 缓存快速路径：单页缓存键是确定性的（无需测量分页），命中直接返回。
        //    多页缓存键依赖测量结果，在 _doRender 内检查。
        //    缓存键掺入分页配置签名：调整 maxImageHeight/pageFooter 后旧缓存自动失效，
        //    避免"配置已要求分页、却命中旧的单页长图缓存"的错配。
        const configSig = `|maxH:${this.options.maxImageHeight}|foot:${this.options.pageFooter ? 1 : 0}`;
        const baseKey = this._getCacheKey(`${fullHtml}${configSig}`);
        const singleKey = pageCacheKey(baseKey, { paginated: false });
        const fastCached = await this._getCachedImage(singleKey);
        if (fastCached) {
            this.stats.cacheHits++;
            this.stats.totalRenders++;
            this.logger.info(`[${renderId}] 缓存命中（单页）`, { path: fastCached, duration: Date.now() - startTime });
            return [fastCached];
        }
        this.stats.cacheMisses++;
        this.logger.info(`[${renderId}] 缓存未命中，进入渲染队列`);

        // 4. 队列+并发控制渲染（测量、分页、分页缓存检查均在 _doRender 内完成）
        const result = await this._enqueueRender(fullHtml, baseKey, renderId);
        const duration = Date.now() - startTime;
        this.stats.totalRenders++;
        this.stats.totalRenderTime += duration;
        this.logger.info(`[${renderId}] 渲染完成`, { pages: result.length, duration: `${duration}ms` });
        return result;
    }

    /**
     * 应用 ST 正则规则
     */
    _applyRules(content, rules, renderId) {
        if (!rules || rules.length === 0) {
            this.logger.debug(`[${renderId}] 无 ST 规则，跳过`);
            return content;
        }

        let result = content;
        let applied = 0;
        let failed = 0;

        for (const rule of rules) {
            if (rule.enabled === false) continue;
            const pattern = rule.findRegex || rule.pattern;
            if (!pattern) continue;

            const replacement = rule.replaceString ?? rule.replacement ?? rule.replace_string ?? '';
            const flags = rule.flags || 'gm';

            try {
                const before = result;
                result = result.replace(new RegExp(pattern, flags), replacement);
                if (before !== result) applied++;
                this.logger.debug(`[${renderId}] 规则应用`, {
                    name: rule.name || 'unnamed',
                    pattern: pattern.slice(0, 60),
                    changed: before !== result,
                });
            } catch (err) {
                failed++;
                this.logger.warn(`[${renderId}] 正则规则失败`, {
                    name: rule.name || 'unnamed',
                    error: err.message,
                });
            }
        }

        this.logger.debug(`[${renderId}] 规则汇总`, { applied, failed, total: rules.length });
        return result;
    }

    /**
     * 构建完整 HTML 文档
     */
    _buildHtml(content, css, template, variables) {
        const preset = template?.preset || 'novel-card';
        const baseHtml = template?.html || this._getDefaultTemplate(preset);
        const baseCss = css || this._getDefaultCss(preset);

        // 注入变量
        let html = baseHtml;
        html = html.replace(/{{content}}/g, content);
        html = html.replace(/{{fontFamily}}/g, this.options.fontFamily);

        for (const [key, value] of Object.entries(variables)) {
            html = html.replace(new RegExp(`{{${key}}}`, 'g'), String(value ?? ''));
        }

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${this._getBaseResetCss()}
${baseCss}
</style>
</head>
<body>
${html}
</body>
</html>`;
    }

    _getBaseResetCss() {
        return `
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: ${this.options.fontFamily};
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
                background: transparent;
            }
            .render-root {
                width: ${this.options.maxWidth}px;
                padding: 24px;
            }
        `;
    }

    _getDefaultTemplate(preset) {
        const templates = {
            'novel-card': `<div class="render-root novel-card">
                <div class="card-header">{{roleName}}</div>
                <div class="card-body">{{content}}</div>
                <div class="card-footer">{{time}}</div>
            </div>`,
            'gal-dialogue': `<div class="render-root gal-dialogue">
                <div class="dialogue-name">{{roleName}}</div>
                <div class="dialogue-box">{{content}}</div>
            </div>`,
            'dark-terminal': `<div class="render-root dark-terminal">
                <div class="terminal-header">> MESSAGE_{{messageId}}</div>
                <div class="terminal-body">{{content}}</div>
            </div>`,
            'minimal': `<div class="render-root minimal">{{content}}</div>`,
        };
        return templates[preset] || templates['novel-card'];
    }

    _getDefaultCss(preset) {
        const cssMap = {
            'novel-card': `
                .novel-card { background: linear-gradient(135deg, #f5f0e8 0%, #e8e0d0 100%); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); color: #3a3228; }
                .card-header { font-size: 18px; font-weight: bold; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #d4c8b8; color: #6b5b4a; }
                .card-body { font-size: 16px; line-height: 1.8; white-space: pre-wrap; }
                .card-footer { font-size: 12px; color: #999; margin-top: 16px; text-align: right; }
            `,
            'gal-dialogue': `
                .gal-dialogue { background: linear-gradient(180deg, rgba(20,20,40,0.85) 0%, rgba(10,10,25,0.95) 100%); border-radius: 16px; border: 2px solid rgba(100,150,255,0.3); color: #f0f0f5; }
                .dialogue-name { font-size: 20px; font-weight: bold; color: #a0c8ff; margin-bottom: 12px; text-shadow: 0 0 10px rgba(100,150,255,0.5); }
                .dialogue-box { font-size: 17px; line-height: 1.7; white-space: pre-wrap; padding: 16px; background: rgba(255,255,255,0.05); border-radius: 12px; }
            `,
            'dark-terminal': `
                .dark-terminal { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #00ff88; font-family: 'Consolas', 'Monaco', monospace; }
                .terminal-header { font-size: 12px; color: #8b949e; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
                .terminal-body { font-size: 15px; line-height: 1.6; white-space: pre-wrap; }
            `,
            'minimal': `
                .minimal { background: #ffffff; color: #1a1a1a; font-size: 16px; line-height: 1.7; white-space: pre-wrap; }
            `,
        };
        return cssMap[preset] || cssMap['novel-card'];
    }

    /**
     * 渲染队列：控制最大并发
     */
    _enqueueRender(fullHtml, baseKey, renderId) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fullHtml, baseKey, renderId, resolve, reject });
            this._processQueue();
        });
    }

    _processQueue() {
        if (this.running >= this.options.maxConcurrent || this.queue.length === 0) return;

        this.running++;
        const { fullHtml, baseKey, renderId, resolve, reject } = this.queue.shift();

        this._doRender(fullHtml, baseKey, renderId)
            .then(resolve)
            .catch(reject)
            .finally(() => {
                this.running--;
                setImmediate(() => this._processQueue());
            });
    }

    /**
     * 实际渲染逻辑
     *
     * 分页流程：载入完整文档测量总高度 → 计算分页方案 → 分页缓存检查 → 逐页渲染。
     * 分页采用"平移 + 视窗裁剪"而非文本拆分，保证：
     *   1. 段落/行内格式与原始排版完全一致；
     *   2. 每页图片尺寸恒定（maxWidth × pageHeight），宽高比一致；
     *   3. 页码页脚独立于裁剪区，不遮挡正文。
     */
    async _doRender(fullHtml, baseKey, renderId) {
        const poolItem = this._acquirePage();
        if (!poolItem) {
            throw new Error('页面池耗尽（所有 Page 都在使用中）');
        }
        const { page } = poolItem;

        try {
            // 1. 载入完整文档（测量用），等待字体与图片就绪
            this.logger.debug(`[${renderId}] 步骤1: 载入内容并测量总高度`);
            await this._setPageContent(page, fullHtml, renderId);
            await this._waitPageReady(page);

            const totalHeight = await page.evaluate(() => {
                const el = document.querySelector('.render-root');
                return el ? Math.ceil(el.scrollHeight) : 0;
            });
            if (!totalHeight) {
                throw new Error('模板中缺少 .render-root 元素（截图目标不存在）');
            }
            this.logger.debug(`[${renderId}] 内容总高度`, { totalHeight, maxImageHeight: this.options.maxImageHeight });

            // 2. 计算分页方案（单页 / 多页）
            const plan = computePagePlan(totalHeight, this.options.maxImageHeight, PAGE_FOOTER_HEIGHT);
            const cacheKey = pageCacheKey(baseKey, plan);
            this.logger.debug(`[${renderId}] 分页方案`, plan);

            // 3. 分页缓存检查：所有页都存在才命中
            const cachedUrls = await this._checkCachedPages(cacheKey, plan);
            if (cachedUrls) {
                this.stats.cacheHits++;
                this.stats.totalRenders++;
                this.logger.info(`[${renderId}] 缓存命中（${plan.pageCount} 页）`, { pages: cachedUrls.length });
                return cachedUrls;
            }

            // 4. 逐页渲染（复用同一个 Page，保证字体/布局一致）
            this.logger.debug(`[${renderId}] 缓存未命中，开始渲染 ${plan.pageCount} 页`);
            const urls = [];
            for (let i = 0; i < plan.pageCount; i++) {
                const pageNo = i + 1;
                const filePath = path.join(this.cacheDir, this._pageFileName(cacheKey, plan, i));

                if (plan.paginated) {
                    const pageHtml = buildPageHtml(
                        fullHtml, i, plan.pageCount,
                        plan.pageHeight, plan.viewportHeight,
                        PAGE_FOOTER_HEIGHT, this.options.pageFooter
                    );
                    await this._setPageContent(page, pageHtml, renderId);
                    await this._waitPageReady(page);
                    await this._screenshotElement(page, '.render-page', filePath, plan.pageHeight, renderId, pageNo, plan.pageCount);
                } else {
                    await this._screenshotElement(page, '.render-root', filePath, null, renderId, pageNo, plan.pageCount);
                }

                if (!existsSync(filePath)) {
                    throw new Error(`截图后文件不存在: ${filePath}`);
                }
                urls.push(toFileUrl(filePath));
                this.logger.debug(`[${renderId}] 第 ${pageNo}/${plan.pageCount} 页已保存`, { path: filePath });
            }

            this.logger.info(`[${renderId}] 全部页面已生成`, { count: urls.length });
            return urls;
        } catch (err) {
            this.stats.failures++;
            this.logger.error(`[${renderId}] 渲染失败`, {
                step: 'doRender',
                error: err.message,
                stack: err.stack?.split('\n').slice(0, 3).join(' | '),
            });
            throw err;
        } finally {
            this._releasePage(poolItem);
        }
    }

    /**
     * 设置页面内容。
     * 用 domcontentloaded 而不是 networkidle0 —— 喂进去的 HTML 全内联、无网络请求，
     * networkidle0 会被浏览器后台连接拖死（真机在 systemd 起的服务里 100% 卡满 15s 超时），
     * 换成 domcontentloaded 后约 190ms 完成。外链资源由 _waitPageReady 显式兜住。
     */
    async _setPageContent(page, html, renderId) {
        this.logger.debug(`[${renderId}] 设置页面内容 (setContent)`);
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    }

    /**
     * 等待字体与图片就绪（测量与分页渲染共用）
     */
    async _waitPageReady(page) {
        await page.evaluateHandle('document.fonts.ready');
        // 自定义模板可能引用图片（外链或 data:）。逐个等待其 load/error，
        // 单张最多等 5 秒，避免一张挂掉的图拖垮整次渲染。
        await page.evaluate(async () => {
            const imgs = Array.from(document.images || []);
            await Promise.all(imgs.map((img) => {
                if (img.complete) return null;
                return new Promise((resolve) => {
                    const done = () => resolve(null);
                    img.addEventListener('load', done, { once: true });
                    img.addEventListener('error', done, { once: true });
                    setTimeout(done, 5000);
                });
            }));
        });
    }

    /**
     * 对指定元素截图并保存。单页时截 .render-root（自然高度）；
     * 分页时截 .render-page（固定 pageHeight），保证各页尺寸一致。
     */
    async _screenshotElement(page, selector, filePath, fixedHeight, renderId, pageNo, pageCount) {
        const element = await page.$(selector);
        if (!element) {
            throw new Error(`截图目标不存在: ${selector}`);
        }
        const box = await element.boundingBox();
        if (!box) {
            throw new Error(`无法获取 ${selector} 的边界框`);
        }

        const height = fixedHeight ? Math.ceil(fixedHeight) : Math.ceil(box.height);
        const screenshotOptions = {
            path: filePath,
            type: this.options.imageFormat,
            clip: {
                x: Math.round(box.x),
                y: Math.round(box.y),
                width: this.options.maxWidth,
                height,
            },
            omitBackground: false,
        };
        if (this.options.imageFormat === 'jpeg') {
            screenshotOptions.quality = this.options.imageQuality;
        }

        this.logger.debug(`[${renderId}] 截图 ${selector}${pageNo ? `（第 ${pageNo}/${pageCount} 页）` : ''}`, {
            format: this.options.imageFormat, path: filePath, width: this.options.maxWidth, height,
        });
        await page.screenshot(screenshotOptions);
    }

    /** 分页文件名：多页 p1/p2...，单页直接用缓存键 */
    _pageFileName(cacheKey, plan, pageIndex) {
        return plan.paginated
            ? `${cacheKey}.p${pageIndex + 1}.${this.options.imageFormat}`
            : `${cacheKey}.${this.options.imageFormat}`;
    }

    /**
     * 分页缓存检查：所有页文件都存在才返回 URL 数组，任一缺失视为整体未命中
     */
    async _checkCachedPages(cacheKey, plan) {
        const urls = [];
        for (let i = 0; i < plan.pageCount; i++) {
            const filePath = path.join(this.cacheDir, this._pageFileName(cacheKey, plan, i));
            try {
                await fs.access(filePath);
                urls.push(toFileUrl(filePath));
            } catch {
                return null;
            }
        }
        return urls;
    }

    _acquirePage() {
        const item = this.pagePool.find(p => !p.busy);
        if (item) {
            item.busy = true;
            return item;
        }
        return null;
    }

    _releasePage(poolItem) {
        poolItem.busy = false;
    }

    _getCacheKey(str) {
        return createHash('sha256').update(str).digest('hex').slice(0, 32);
    }

    async _getCachedImage(key) {
        const fileName = `${key}.${this.options.imageFormat}`;
        const filePath = path.join(this.cacheDir, fileName);
        try {
            await fs.access(filePath);
            return toFileUrl(filePath);
        } catch {
            return null;
        }
    }

    /**
     * 清理过期缓存
     */
    async cleanupCache(maxAgeDays = 7) {
        let deleted = 0;
        try {
            const files = await fs.readdir(this.cacheDir);
            const now = Date.now();
            const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

            for (const file of files) {
                const filePath = path.join(this.cacheDir, file);
                try {
                    const stat = await fs.stat(filePath);
                    if (now - stat.mtime.getTime() > maxAge) {
                        await fs.unlink(filePath);
                        deleted++;
                    }
                } catch {}
            }
            this.logger.info('缓存清理完成', { deleted, remaining: files.length - deleted });
        } catch (err) {
            this.logger.warn('缓存清理失败', { error: err.message });
        }
        return deleted;
    }

    async getCacheSize() {
        try {
            const files = await fs.readdir(this.cacheDir);
            let size = 0;
            for (const file of files) {
                const stat = await fs.stat(path.join(this.cacheDir, file));
                size += stat.size;
            }
            return size;
        } catch {
            return 0;
        }
    }

    async getCacheFileCount() {
        try {
            const files = await fs.readdir(this.cacheDir);
            return files.length;
        } catch {
            return 0;
        }
    }

    getStats() {
        const avgTime = this.stats.totalRenders > 0
            ? Math.round(this.stats.totalRenderTime / this.stats.totalRenders)
            : 0;
        return {
            ...this.stats,
            avgRenderTime: avgTime,
            queueLength: this.queue.length,
            runningRenders: this.running,
            pagePoolSize: this.pagePool.length,
            ready: this.ready,
        };
    }

    async dispose() {
        this.logger.info('正在关闭渲染引擎...');
        if (this.browser) {
            try {
                await this.browser.close();
                this.logger.info('Puppeteer Browser 已关闭');
            } catch (err) {
                this.logger.error('关闭 Browser 失败', { error: err.message });
            }
            this.browser = null;
        }
        this.pagePool = [];
        this.ready = false;
    }
}
