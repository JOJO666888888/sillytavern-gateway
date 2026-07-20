/**
 * Plugin Manager - 插件生命周期管理 + REST API
 * 维护插件列表、启用/禁用、安装/卸载、配置持久化
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';
import { PluginLoader } from './plugin-loader.js';
import { CommandRouter } from './command-router.js';
import { EventPipeline } from './event-pipeline.js';
import { execSync } from 'child_process';

const logger = createLogger('plugin-manager');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 插件管理器
 */
export class PluginManager {
    /**
     * @param {object} options
     * @param {import('./gateway-core.js').GatewayCore} options.gateway - 网关核心
     * @param {import('./session-manager.js').SessionManager} options.sessionManager - 会话管理器
     * @param {import('./utils/config.js').default} options.configManager - 配置管理器
     */
    constructor(options = {}) {
        this.gateway = options.gateway;
        this.sessionManager = options.sessionManager;
        this.configManager = options.configManager;

        // 插件数据目录（存放各插件配置）
        this.dataDir = path.resolve(__dirname, '..', 'data', 'plugins');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        // 插件加载器
        this.loader = new PluginLoader({
            pluginsDir: path.resolve(__dirname, '..', 'plugins'),
            services: {
                gateway: this.gateway,
                sessionManager: this.sessionManager,
                configManager: this.configManager,
                savePluginConfig: (name, config) => this.savePluginConfig(name, config),
            },
        });

        // 命令路由器和事件管线
        this.commandRouter = new CommandRouter();
        this.eventPipeline = new EventPipeline();

        // 插件状态（启用/禁用）
        this.pluginStates = new Map(); // name -> { enabled: boolean }
    }

    /**
     * 初始化：加载所有插件并注册命令/监听器
     */
    async init() {
        logger.info('正在初始化插件系统...');

        // 加载所有插件
        await this.loader.loadAll((name) => this.loadPluginConfig(name));

        // 注册所有已加载插件的命令和监听器
        for (const [name, loaded] of this.loader.getAllPlugins()) {
            const { instance, meta } = loaded;
            const enabled = meta.enabled !== false;
            this.pluginStates.set(name, { enabled });

            if (enabled) {
                this.registerPlugin(instance);
            }
        }

        logger.info(`插件系统初始化完成，已加载 ${this.loader.getAllPlugins().size} 个插件`);
    }

    /**
     * 注册插件的命令和监听器到路由器/管线
     * @param {GatewayPlugin} instance
     */
    registerPlugin(instance) {
        const commands = instance.getCommands();
        const listeners = instance.getListeners();

        // 注册命令
        for (const cmd of commands) {
            this.commandRouter.register({
                name: cmd.name,
                alias: cmd.alias || [],
                description: cmd.description || '',
                usage: cmd.usage || '',
                pluginName: instance.meta.name,
                handler: async (ctx) => {
                    if (typeof instance[cmd.handler] === 'function') {
                        return await instance[cmd.handler](ctx);
                    }
                    logger.warn(`插件 ${instance.meta.name} 的命令处理器 ${cmd.handler} 不存在`);
                },
            });
        }

        // 注册监听器
        for (const listener of listeners) {
            this.eventPipeline.register({
                event: listener.event || 'message',
                filter: listener.filter || {},
                pluginName: instance.meta.name,
                priority: listener.priority || instance.meta.priority || 100,
                handler: async (ctx) => {
                    if (typeof instance[listener.handler] === 'function') {
                        return await instance[listener.handler](ctx);
                    }
                    logger.warn(`插件 ${instance.meta.name} 的监听器 ${listener.handler} 不存在`);
                },
            });
        }

        logger.debug(`已注册插件 ${instance.meta.name}: ${commands.length} 命令, ${listeners.length} 监听器`);
    }

    /**
     * 注销插件的命令和监听器
     * @param {string} pluginName
     */
    unregisterPlugin(pluginName) {
        this.commandRouter.unregisterByPlugin(pluginName);
        this.eventPipeline.unregisterByPlugin(pluginName);
    }

    /**
     * 处理入站消息（由 gateway-core 调用）
     * @param {import('./adapters/base-adapter.js').InboundMessage} message
     * @returns {Promise<boolean>} 是否被插件处理
     */
    async handleMessage(message) {
        // 检查是否是命令
        if (message.content && message.content.startsWith('/')) {
            const handled = await this.commandRouter.handle(message, {
                gateway: this.gateway,
                sessionManager: this.sessionManager,
                configManager: this.configManager,
            });
            if (handled) return true;
        }

        // 通过事件管线分发给监听器
        const handled = await this.eventPipeline.dispatch(message, {
            gateway: this.gateway,
            sessionManager: this.sessionManager,
            configManager: this.configManager,
        });

        return handled;
    }

    // ==================== 插件管理操作 ====================

    /**
     * 启用插件
     */
    async enablePlugin(name) {
        const state = this.pluginStates.get(name);
        if (!state) return { success: false, error: `插件 ${name} 不存在` };

        state.enabled = true;
        const instance = this.loader.getPlugin(name);
        if (instance) {
            this.registerPlugin(instance);
        }

        logger.info(`插件已启用: ${name}`);
        return { success: true, message: `插件 ${name} 已启用` };
    }

    /**
     * 禁用插件
     */
    async disablePlugin(name) {
        const state = this.pluginStates.get(name);
        if (!state) return { success: false, error: `插件 ${name} 不存在` };

        state.enabled = false;
        this.unregisterPlugin(name);

        logger.info(`插件已禁用: ${name}`);
        return { success: true, message: `插件 ${name} 已禁用` };
    }

    /**
     * 重载插件
     */
    async reloadPlugin(name) {
        const config = this.loadPluginConfig(name);
        this.unregisterPlugin(name);

        const instance = await this.loader.reloadPlugin(name, config);
        if (instance) {
            const state = this.pluginStates.get(name);
            if (state?.enabled !== false) {
                this.registerPlugin(instance);
            }
            return { success: true, message: `插件 ${name} 已重载` };
        }
        return { success: false, error: `重载插件 ${name} 失败` };
    }

    /**
     * 卸载插件
     */
    async uninstallPlugin(name) {
        this.unregisterPlugin(name);
        await this.loader.unloadPlugin(name);
        this.pluginStates.delete(name);
        return { success: true, message: `插件 ${name} 已卸载` };
    }

    /**
     * 获取所有插件信息
     */
    listPlugins() {
        const plugins = [];
        for (const [name, loaded] of this.loader.getAllPlugins()) {
            const { instance, meta } = loaded;
            const state = this.pluginStates.get(name);
            plugins.push({
                name,
                displayName: meta.displayName || name,
                version: meta.version || '0.0.0',
                author: meta.author || 'unknown',
                description: meta.description || '',
                enabled: state?.enabled !== false,
                commands: instance.getCommands().map(c => c.name),
                listeners: instance.getListeners().length,
            });
        }
        return plugins;
    }

    /**
     * 获取插件详情
     */
    getPluginInfo(name) {
        const loaded = this.loader.getAllPlugins().get(name);
        if (!loaded) return null;

        const { instance, meta } = loaded;
        const state = this.pluginStates.get(name);

        return {
            name,
            meta,
            enabled: state?.enabled !== false,
            commands: instance.getCommands(),
            listeners: instance.getListeners(),
            schedules: instance.getSchedules(),
            config: this.loadPluginConfig(name),
        };
    }

    // ==================== 配置持久化 ====================

    /**
     * 加载插件配置
     */
    loadPluginConfig(name) {
        const configPath = path.join(this.dataDir, `${name}.json`);
        if (fs.existsSync(configPath)) {
            try {
                return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (error) {
                logger.warn(`读取插件 ${name} 配置失败: ${error.message}`);
            }
        }
        return {};
    }

    /**
     * 保存插件配置
     */
    savePluginConfig(name, config) {
        const configPath = path.join(this.dataDir, `${name}.json`);
        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        } catch (error) {
            logger.error(`保存插件 ${name} 配置失败: ${error.message}`);
        }
    }

    // ==================== REST API 路由注册 ====================

    /**
     * 注册插件管理 REST API 到 Express app
     * @param {import('express').Express} app
     */
    registerRoutes(app) {
        // 列出所有插件
        app.get('/api/plugins', (req, res) => {
            res.json({ success: true, plugins: this.listPlugins() });
        });

        // 获取插件详情
        app.get('/api/plugins/:name', (req, res) => {
            const info = this.getPluginInfo(req.params.name);
            if (!info) {
                return res.status(404).json({ success: false, error: '插件不存在' });
            }
            res.json({ success: true, plugin: info });
        });

        // 启用插件
        app.post('/api/plugins/:name/enable', async (req, res) => {
            const result = await this.enablePlugin(req.params.name);
            res.status(result.success ? 200 : 404).json(result);
        });

        // 禁用插件
        app.post('/api/plugins/:name/disable', async (req, res) => {
            const result = await this.disablePlugin(req.params.name);
            res.status(result.success ? 200 : 404).json(result);
        });

        // 重载插件
        app.post('/api/plugins/:name/reload', async (req, res) => {
            const result = await this.reloadPlugin(req.params.name);
            res.status(result.success ? 200 : 500).json(result);
        });

        // 卸载插件
        app.delete('/api/plugins/:name', async (req, res) => {
            const result = await this.uninstallPlugin(req.params.name);
            res.json(result);
        });

        // 安装插件（从本地路径）
        app.post('/api/plugins/install', async (req, res) => {
            const { path: pluginPath } = req.body;
            if (!pluginPath) {
                return res.status(400).json({ success: false, error: '请提供插件路径' });
            }

            try {
                // 验证路径存在且包含 plugin.json
                const metaPath = path.join(pluginPath, 'plugin.json');
                if (!fs.existsSync(metaPath)) {
                    return res.status(400).json({ success: false, error: '无效插件：缺少 plugin.json' });
                }

                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                const targetDir = path.join(this.loader.pluginsDir, meta.name);

                // 复制插件到 plugins 目录
                fs.cpSync(pluginPath, targetDir, { recursive: true });

                // 加载
                const config = this.loadPluginConfig(meta.name);
                const instance = await this.loader.loadPlugin(targetDir, meta, config);
                if (instance) {
                    this.pluginStates.set(meta.name, { enabled: meta.enabled !== false });
                    if (meta.enabled !== false) {
                        this.registerPlugin(instance);
                    }
                    res.json({ success: true, message: `插件 ${meta.name} 安装成功` });
                } else {
                    res.status(500).json({ success: false, error: '插件加载失败' });
                }
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // 从 GitHub 安装插件
        app.post('/api/plugins/install/github', async (req, res) => {
            const { url, subfolder } = req.body;
            if (!url) {
                return res.status(400).json({ success: false, error: '请提供 GitHub 仓库地址' });
            }

            try {
                const result = await this.installFromGitHub(url, subfolder);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // 插件市场：搜索 GitHub 上的网关插件
        app.get('/api/plugins/marketplace/search', async (req, res) => {
            const query = req.query.q || 'sillytavern-gateway-plugin';
            try {
                const results = await this.searchGitHubPlugins(query);
                res.json({ success: true, plugins: results });
            } catch (error) {
                res.json({ success: true, plugins: [], error: error.message });
            }
        });

        logger.info('插件管理 API 已注册');
    }

    // ==================== GitHub 插件安装 ====================

    /**
     * 从 GitHub 仓库安装插件
     * 支持格式:
     *   - https://github.com/user/repo (整个仓库作为插件)
     *   - https://github.com/user/repo/tree/main/subfolder (仓库子目录)
     *   - user/repo (简写)
     * @param {string} url - GitHub 地址
     * @param {string} subfolder - 可选子目录
     */
    async installFromGitHub(url, subfolder = '') {
        // 解析 GitHub URL
        const parsed = this._parseGitHubUrl(url);
        if (!parsed) {
            throw new Error('无效的 GitHub 地址，支持格式: https://github.com/user/repo 或 user/repo');
        }

        const { owner, repo, branch, path: repoPath } = parsed;
        const actualSubfolder = subfolder || repoPath;

        logger.info(`从 GitHub 安装插件: ${owner}/${repo} (branch: ${branch}, path: ${actualSubfolder || '/'})`);

        // 下载 ZIP
        const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
        const tempDir = path.join(this.dataDir, '_temp_install');
        const zipPath = path.join(tempDir, `${repo}.zip`);

        try {
            // 清理临时目录
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true });
            }
            fs.mkdirSync(tempDir, { recursive: true });

            // 下载 ZIP
            logger.info(`下载: ${zipUrl}`);
            await this._downloadFile(zipUrl, zipPath);

            // 解压
            const extractDir = path.join(tempDir, 'extracted');
            await this._extractZip(zipPath, extractDir);

            // 找到插件目录（ZIP 解压后通常有一层 repo-branch 目录）
            let pluginSourceDir = extractDir;
            const entries = fs.readdirSync(extractDir);
            if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
                pluginSourceDir = path.join(extractDir, entries[0]);
            }

            // 如果有子目录
            if (actualSubfolder) {
                pluginSourceDir = path.join(pluginSourceDir, actualSubfolder);
            }

            // 验证 plugin.json
            const metaPath = path.join(pluginSourceDir, 'plugin.json');
            if (!fs.existsSync(metaPath)) {
                // 尝试在子目录中查找 plugin.json
                const found = this._findPluginJson(pluginSourceDir);
                if (found) {
                    pluginSourceDir = found;
                } else {
                    throw new Error('仓库中未找到 plugin.json，请确认这是一个有效的网关插件');
                }
            }

            const meta = JSON.parse(fs.readFileSync(path.join(pluginSourceDir, 'plugin.json'), 'utf-8'));
            const targetDir = path.join(this.loader.pluginsDir, meta.name);

            // 如果已存在，先卸载
            if (this.loader.getPlugin(meta.name)) {
                await this.uninstallPlugin(meta.name);
            }
            if (fs.existsSync(targetDir)) {
                fs.rmSync(targetDir, { recursive: true });
            }

            // 复制到 plugins 目录
            fs.cpSync(pluginSourceDir, targetDir, { recursive: true });

            // 加载插件
            const config = this.loadPluginConfig(meta.name);
            const instance = await this.loader.loadPlugin(targetDir, meta, config);
            if (instance) {
                this.pluginStates.set(meta.name, { enabled: meta.enabled !== false });
                if (meta.enabled !== false) {
                    this.registerPlugin(instance);
                }
                logger.info(`GitHub 插件安装成功: ${meta.displayName || meta.name} v${meta.version}`);
                return {
                    success: true,
                    message: `插件 ${meta.displayName || meta.name} v${meta.version} 安装成功`,
                    plugin: { name: meta.name, displayName: meta.displayName, version: meta.version },
                };
            } else {
                throw new Error('插件加载失败，请检查插件代码');
            }
        } finally {
            // 清理临时文件
            try {
                if (fs.existsSync(tempDir)) {
                    fs.rmSync(tempDir, { recursive: true });
                }
            } catch (_) { /* ignore */ }
        }
    }

    /**
     * 搜索 GitHub 上的网关插件
     */
    async searchGitHubPlugins(query) {
        const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+topic:sillytavern-gateway-plugin&sort=updated&per_page=20`;
        try {
            const response = await fetch(searchUrl, {
                headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'STGateway' },
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.items || []).map(item => ({
                name: item.name,
                fullName: item.full_name,
                description: item.description || '',
                url: item.html_url,
                stars: item.stargazers_count,
                updatedAt: item.updated_at,
                owner: item.owner?.login,
            }));
        } catch (error) {
            logger.warn(`GitHub 搜索失败: ${error.message}`);
            return [];
        }
    }

    /**
     * 解析 GitHub URL
     */
    _parseGitHubUrl(url) {
        // 简写: user/repo
        const shortMatch = url.match(/^([\w.-]+)\/([\w.-]+)$/);
        if (shortMatch) {
            return { owner: shortMatch[1], repo: shortMatch[2], branch: 'main', path: '' };
        }

        // 完整 URL
        const urlMatch = url.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.-]+)(?:\/(.*))?)?$/);
        if (urlMatch) {
            return {
                owner: urlMatch[1],
                repo: urlMatch[2],
                branch: urlMatch[3] || 'main',
                path: urlMatch[4] || '',
            };
        }

        return null;
    }

    /**
     * 下载文件
     */
    async _downloadFile(url, destPath) {
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) {
            throw new Error(`下载失败: HTTP ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(destPath, buffer);
    }

    /**
     * 解压 ZIP（使用 PowerShell 或 unzip）
     */
    async _extractZip(zipPath, extractDir) {
        fs.mkdirSync(extractDir, { recursive: true });
        try {
            // Windows: 使用 PowerShell
            if (process.platform === 'win32') {
                execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 30000 });
            } else {
                execSync(`unzip -o '${zipPath}' -d '${extractDir}'`, { timeout: 30000 });
            }
        } catch (error) {
            throw new Error(`解压失败: ${error.message}`);
        }
    }

    /**
     * 递归查找 plugin.json
     */
    _findPluginJson(dir, depth = 0) {
        if (depth > 2) return null; // 最多搜索 2 层
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'plugin.json') {
                return dir;
            }
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const found = this._findPluginJson(path.join(dir, entry.name), depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * 关闭插件系统
     */
    async shutdown() {
        await this.loader.unloadAll();
        logger.info('插件系统已关闭');
    }
}

export default PluginManager;
