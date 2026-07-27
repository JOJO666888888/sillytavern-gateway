/**
 * Plugin Manager - 插件生命周期管理 + REST API
 * 维护插件列表、启用/禁用、安装/卸载、配置持久化
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger.js';
import { PluginLoader } from './plugin-loader.js';
import { buildScopedServices, normalizePermissions, scanPluginRisk, formatInstallDisclosure, highestRisk } from './plugin-permissions.js';
import { createLLMService } from './llm-service.js';
import { SchedulerService } from './scheduler-service.js';
import { PluginContext } from './plugin-context.js';
import { CommandRouter } from './command-router.js';
import { EventPipeline } from './event-pipeline.js';
import { execSync } from 'child_process';

const logger = createLogger('plugin-manager');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 合法插件名：小写字母/数字开头，仅含 [a-z0-9._-]，长度 ≤ 64。
// 用于所有以插件名拼接文件路径的场景，杜绝 ../ 、%2F、绝对路径等穿越。
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// 下载/解压安全上限
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;  // 单个插件 ZIP 上限 25MB
const DOWNLOAD_TIMEOUT_MS = 30000;

/**
 * 校验插件名合法性；非法则抛错。
 * @param {string} name
 * @returns {string} 规范化后的名字
 */
function assertValidPluginName(name) {
    if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name) || name === '.' || name === '..') {
        throw new Error(`非法插件名: ${JSON.stringify(name)}（仅允许字母数字及 . _ -，长度≤64）`);
    }
    return name;
}

/**
 * 断言 target 解析后位于 baseDir 之内（含相等），否则抛错。防止 path.join 穿越。
 * @param {string} baseDir
 * @param {string} target
 * @returns {string} 解析后的绝对路径
 */
function assertInside(baseDir, target) {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(target);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new Error('路径越界：拒绝访问目标目录之外的位置');
    }
    return resolved;
}

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

        // LLM 调用服务：供声明了 "llm" 权限的插件调用网关配置的 LLM。
        // 现读 runtime.llm 配置，apiKey 只在服务内部用于拼请求，不流入插件。
        this.llmService = createLLMService(this.configManager);

        // 插件数据目录（存放各插件配置）
        this.dataDir = path.resolve(__dirname, '..', 'data', 'plugins');
        // 不能让这里抛：异常会一路冒到 startServer().catch() → process.exit(1)，
        // 配合 compose 的 restart: unless-stopped 就变成无限崩溃重启，
        // 日志里只有孤零零一行 EACCES。data/ 是挂载卷，只读挂载 / --user 覆盖 /
        // SELinux 未加 :z / NFS root_squash 都可能让它不可写。
        // 降级代价只是插件配置不能持久化，网关照常收发消息，远好过整个容器起不来。
        // （同一批目录里 media-store 与 logger 都是这么做的，此处原本是漏网的。）
        this.dataDirWritable = true;
        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }
        } catch (error) {
            this.dataDirWritable = false;
            logger.error(`插件数据目录不可用: ${this.dataDir} (${error.message})`);
            logger.error(`当前 uid=${typeof process.getuid === 'function' ? process.getuid() : 'n/a'}；`
                + '插件配置本次将无法持久化。修复：在宿主机执行 chown -R $(id -u):$(id -g) data');
        }

        // 插件加载器
        this.loader = new PluginLoader({
            pluginsDir: path.resolve(__dirname, '..', 'plugins'),
            services: {
                gateway: this.gateway,
                sessionManager: this.sessionManager,
                configManager: this.configManager,
                llmService: this.llmService,
                savePluginConfig: (name, config) => this.savePluginConfig(name, config),
            },
        });

        // 命令路由器和事件管线
        this.commandRouter = new CommandRouter();
        this.eventPipeline = new EventPipeline();
        // 定时任务调度器：消费插件 static schedules，60s 轮询按分钟触发。
        // 此前 schedules 只被展示、无人执行，AstrBot「定时任务」类插件无法移植。
        this.scheduler = new SchedulerService();

        // 插件状态（启用/禁用）
        this.pluginStates = new Map(); // name -> { enabled: boolean }
        // 状态持久化文件（重启后保留用户的启用/禁用选择）
        this.statesFile = path.join(this.dataDir, '_states.json');
        this._persistedStates = this._loadStates();
    }

    /** 从磁盘读取已持久化的插件启用/禁用状态 */
    _loadStates() {
        try {
            if (fs.existsSync(this.statesFile)) {
                return JSON.parse(fs.readFileSync(this.statesFile, 'utf-8')) || {};
            }
        } catch (e) {
            logger.warn(`读取插件状态失败: ${e.message}`);
        }
        return {};
    }

    /** 持久化插件启用/禁用状态（原子写） */
    _saveStates() {
        const obj = {};
        for (const [name, st] of this.pluginStates) obj[name] = { enabled: st.enabled };
        try {
            const tmp = this.statesFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
            fs.renameSync(tmp, this.statesFile);
        } catch (e) {
            logger.warn(`保存插件状态失败: ${e.message}`);
        }
    }

    /**
     * 初始化：加载所有插件并注册命令/监听器
     */
    async init() {
        logger.info('正在初始化插件系统...');

        // 是否启用：持久化状态优先于 plugin.json 的 enabled 字段
        const isEnabled = (name, meta) => {
            const persisted = this._persistedStates[name];
            if (persisted && typeof persisted.enabled === 'boolean') return persisted.enabled;
            return meta.enabled !== false;
        };

        // 加载所有插件（禁用的只加载不启动，不执行 onLoad）
        await this.loader.loadAll((name) => this.loadPluginConfig(name), isEnabled);

        // 注册所有已启用插件的命令和监听器
        for (const [name, loaded] of this.loader.getAllPlugins()) {
            const { instance, meta } = loaded;
            const enabled = isEnabled(name, meta);
            this.pluginStates.set(name, { enabled });

            if (enabled) {
                this.registerPlugin(instance);
            }
        }
        this._saveStates();

        // 注入 CommandRouter 到 GatewayCore，用于连接时自动同步命令
        this.gateway.setCommandRouter(this.commandRouter);

        // 初始同步：对已连接的适配器立即同步一次
        const commands = this.commandRouter.getCommandsForSync();
        await this.gateway.syncAllCommands(commands);

        logger.info(`插件系统初始化完成，已加载 ${this.loader.getAllPlugins().size} 个插件`);

        // 所有已启用插件的定时任务已注册，启动调度轮询
        this.scheduler.start();
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
                adminOnly: cmd.adminOnly === true,
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

        // 注册定时任务
        const schedules = instance.getSchedules();
        if (schedules.length > 0) {
            this.scheduler.registerPlugin({
                pluginName: instance.meta.name,
                schedules,
                // run 回调：为每次触发构造一个不含入站消息的 ctx（llm/gatewayConfig 按权限收窄），
                // 再调用插件的 handler 方法。handler 抛错由 scheduler 隔离。
                run: async (schedule) => {
                    const fn = instance[schedule.handler];
                    if (typeof fn !== 'function') {
                        logger.warn(`插件 ${instance.meta.name} 的定时任务处理器 ${schedule.handler} 不存在`);
                        return;
                    }
                    const ctx = this._buildScheduleContext(instance.meta.name);
                    return await fn.call(instance, ctx);
                },
            });
            logger.debug(`已注册插件 ${instance.meta.name}: ${schedules.length} 定时任务`);
        }
    }

    /**
     * 为定时任务构造上下文。无入站消息（message 为 null），
     * 插件通过 ctx.send(platform, chatId, text) 主动推送，或用 ctx.llm 调用模型。
     * llm / gatewayConfig 与命令/监听器走同一套权限收窄。
     * @param {string} pluginName
     * @returns {PluginContext}
     */
    _buildScheduleContext(pluginName) {
        return new PluginContext({
            message: null,
            gateway: this.gateway,
            sessionManager: this.sessionManager,
            configManager: this.configManager,
            gatewayConfig: this.getGatewayConfigFor(pluginName),
            llm: this.getLLMFor(pluginName),
            pluginName,
        });
    }

    /**
     * 注销插件的命令和监听器
     * @param {string} pluginName
     */
    unregisterPlugin(pluginName) {
        this.commandRouter.unregisterByPlugin(pluginName);
        this.eventPipeline.unregisterByPlugin(pluginName);
        // 注销该插件的定时任务
        this.scheduler.unregisterByPlugin(pluginName);
        // 框架代管回收：强制移除该插件注册的出站过滤器（安全网，即便插件 onUnload 有 bug）
        if (this.gateway.removeOutboundFiltersByPlugin) {
            this.gateway.removeOutboundFiltersByPlugin(pluginName);
        }
        // 框架代管回收：强制移除该插件注册的入站过滤器（安全网）
        if (this.gateway.removeInboundFiltersByPlugin) {
            this.gateway.removeInboundFiltersByPlugin(pluginName);
        }
    }

    /**
     * 处理入站消息（由 gateway-core 调用）
     * @param {import('./adapters/base-adapter.js').InboundMessage} message
     * @returns {Promise<boolean>} 是否被插件处理
     */
    /**
     * 为指定插件返回按其权限收窄的网关配置视图（凭据脱敏）。
     * 供 CommandRouter / EventPipeline 构造 ctx 时注入，
     * 使 ctx.getConfig() 不再能读出 bot token。
     * @param {string} pluginName
     */
    getGatewayConfigFor(pluginName) {
        const instance = this.loader.getPlugin(pluginName);
        const granted = new Set(instance?._grantedPermissions || []);
        return buildScopedServices(pluginName, granted, {
            gateway: null,
            sessionManager: null,
            configManager: this.configManager,
        }).gatewayConfig;
    }

    /**
     * 为指定插件返回按其权限收窄的 LLM 调用服务。
     * 未声明 "llm" 权限时返回拒绝桩（调用即抛错）。
     * @param {string} pluginName
     */
    getLLMFor(pluginName) {
        const instance = this.loader.getPlugin(pluginName);
        const granted = new Set(instance?._grantedPermissions || []);
        return buildScopedServices(pluginName, granted, {
            gateway: null,
            sessionManager: null,
            configManager: this.configManager,
            llmService: this.llmService,
        }).llm;
    }

    /** 传给命令路由/事件管线的服务集合 */
    _dispatchServices() {
        return {
            gateway: this.gateway,
            sessionManager: this.sessionManager,
            configManager: this.configManager,
            getGatewayConfigFor: (name) => this.getGatewayConfigFor(name),
            getLLMFor: (name) => this.getLLMFor(name),
        };
    }

    async handleMessage(message) {
        // 检查是否是命令
        if (message.content && message.content.startsWith('/')) {
            const handled = await this.commandRouter.handle(message, this._dispatchServices());
            if (handled) return true;
        }

        // 通过事件管线分发给监听器
        const handled = await this.eventPipeline.dispatch(message, this._dispatchServices());

        return handled;
    }

    // ==================== 插件管理操作 ====================

    /**
     * 启用插件
     */
    async enablePlugin(name) {
        const state = this.pluginStates.get(name);
        if (!state) return { success: false, error: `插件 ${name} 不存在` };
        if (state.enabled) return { success: true, message: `插件 ${name} 已是启用状态` }; // 幂等

        const instance = this.loader.getPlugin(name);
        if (instance) {
            // 对称生命周期：启用时执行 onLoad（重新注册出站过滤器/定时器等资源）
            if (!instance._loaded) {
                try {
                    await instance.onLoad();
                    instance._loaded = true;
                } catch (e) {
                    logger.error(`插件 ${name} onLoad 失败: ${e.message}`);
                    return { success: false, error: `启用失败: ${e.message}` };
                }
            }
            this.registerPlugin(instance);
        }
        state.enabled = true;
        this._saveStates();

        // 重新同步命令到所有平台
        const commands = this.commandRouter.getCommandsForSync();
        await this.gateway.syncAllCommands(commands);

        logger.info(`插件已启用: ${name}`);
        return { success: true, message: `插件 ${name} 已启用` };
    }

    /**
     * 禁用插件
     */
    async disablePlugin(name) {
        const state = this.pluginStates.get(name);
        if (!state) return { success: false, error: `插件 ${name} 不存在` };
        if (!state.enabled) return { success: true, message: `插件 ${name} 已是禁用状态` }; // 幂等

        const instance = this.loader.getPlugin(name);
        if (instance) {
            // 对称生命周期：禁用时执行 onUnload，让插件释放自有资源（定时器/连接等）
            if (instance._loaded && typeof instance.onUnload === 'function') {
                try { await instance.onUnload(); } catch (e) { logger.warn(`插件 ${name} onUnload 出错: ${e.message}`); }
            }
            // 框架代管回收：强制注销该插件的出站过滤器（安全网）
            if (instance._managedUnregister) {
                for (const fn of instance._managedUnregister) {
                    try { fn(); } catch (_) { /* ignore */ }
                }
                instance._managedUnregister.length = 0;
            }
            instance._loaded = false;
        }
        // 注销命令/监听器 + 强制移除出站过滤器
        this.unregisterPlugin(name);
        state.enabled = false;
        this._saveStates();

        // 重新同步命令到所有平台（移除已禁用插件的命令）
        const commands = this.commandRouter.getCommandsForSync();
        await this.gateway.syncAllCommands(commands);

        logger.info(`插件已禁用: ${name}`);
        return { success: true, message: `插件 ${name} 已禁用` };
    }

    /**
     * 重载插件
     */
    async reloadPlugin(name) {
        const config = this.loadPluginConfig(name);
        this.unregisterPlugin(name);

        const state = this.pluginStates.get(name);
        const enabled = state?.enabled !== false;
        // 禁用的插件重载时不启动（不执行 onLoad）
        const instance = await this.loader.reloadPlugin(name, config, { autoStart: enabled });
        if (instance) {
            if (enabled) {
                this.registerPlugin(instance);
            }
            // 重新同步命令到所有平台
            const commands = this.commandRouter.getCommandsForSync();
            await this.gateway.syncAllCommands(commands);
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
        this._saveStates();
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
            const configSchema = meta.config || {};
            plugins.push({
                name,
                displayName: meta.displayName || name,
                version: meta.version || '0.0.0',
                author: meta.author || 'unknown',
                description: meta.description || '',
                enabled: state?.enabled !== false,
                commands: instance.getCommands().map(c => c.name),
                listeners: instance.getListeners().length,
                // R3: 配置 schema 信息，前端据此决定是否显示"配置"按钮
                hasConfig: Object.keys(configSchema).length > 0,
                configUi: meta.configUi || 'auto',
                // 该插件实际被授予的能力（供面板展示，用户可知道它能做什么）
                permissions: instance._grantedPermissions || [],
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

    /**
     * 获取插件配置 schema（R3: schema 驱动 UI 后端支持）
     * 返回 plugin.json 中声明的 config 字段 + configUi 模式
     * @param {string} name - 插件名
     * @returns {object|null} { configSchema, configUi } 或 null（插件不存在/无 schema）
     */
    getPluginSchema(name) {
        const loaded = this.loader.getAllPlugins().get(name);
        if (!loaded) return null;

        const meta = loaded.meta || {};
        const configSchema = meta.config || {};
        const configUi = meta.configUi || 'auto'; // 'auto' | 'custom' | 'none'

        return {
            name,
            displayName: meta.displayName || name,
            configSchema,
            configUi,
            hasSchema: Object.keys(configSchema).length > 0,
        };
    }

    // ==================== 配置持久化 ====================

    /**
     * 加载插件配置
     */
    loadPluginConfig(name) {
        let configPath;
        try {
            assertValidPluginName(name);
            configPath = assertInside(this.dataDir, path.join(this.dataDir, `${name}.json`));
        } catch (error) {
            logger.warn(`拒绝读取插件配置: ${error.message}`);
            return {};
        }
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
     * 保存插件配置（原子写：tmp + rename，避免中途崩溃截断丢配置）
     */
    savePluginConfig(name, config) {
        let configPath;
        try {
            assertValidPluginName(name);
            configPath = assertInside(this.dataDir, path.join(this.dataDir, `${name}.json`));
        } catch (error) {
            logger.error(`拒绝保存插件配置: ${error.message}`);
            return;
        }
        try {
            const tmp = `${configPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
            fs.renameSync(tmp, configPath);
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

        // 获取插件配置
        app.get('/api/plugins/:name/config', (req, res) => {
            // 仅允许读取已加载插件的配置，杜绝用插件名路径穿越读取 config/gateway.json 等
            if (!this.loader.getAllPlugins().get(req.params.name)) {
                return res.status(404).json({ success: false, error: '插件不存在' });
            }
            const config = this.loadPluginConfig(req.params.name);
            res.json({ success: true, config });
        });

        // 更新插件配置
        app.post('/api/plugins/:name/config', (req, res) => {
            const name = req.params.name;
            const loaded = this.loader.getAllPlugins().get(name);
            if (!loaded) {
                return res.status(404).json({ success: false, error: '插件不存在' });
            }
            this.savePluginConfig(name, req.body);
            // 同步到插件实例
            if (loaded.instance) {
                loaded.instance._pluginConfig = req.body;
            }
            res.json({ success: true, message: `插件 ${name} 配置已更新` });
        });

        // R3: 获取插件配置 schema（前端 schema 驱动 UI 使用）
        app.get('/api/plugins/:name/schema', (req, res) => {
            const schema = this.getPluginSchema(req.params.name);
            if (!schema) {
                return res.status(404).json({ success: false, error: '插件不存在' });
            }
            res.json({ success: true, schema });
        });

        // 导入 SillyTavern 正则到 regex-filter 插件
        app.post('/api/plugins/regex-filter/import-st', (req, res) => {
            const loaded = this.loader.getAllPlugins().get('regex-filter');
            if (!loaded || !loaded.instance) {
                return res.status(404).json({ success: false, error: 'regex-filter 插件未加载' });
            }

            const { rules } = req.body;
            if (!rules) {
                return res.status(400).json({ success: false, error: '请提供 rules 字段（ST 正则 JSON 对象或数组）' });
            }

            try {
                const result = loaded.instance.importFromST(rules);
                res.json({ success: true, ...result });
            } catch (error) {
                res.status(400).json({ success: false, error: `导入失败: ${error.message}` });
            }
        });

        // 正则过滤器：测试文本通过规则链处理后的结果（不实际发送）
        app.post('/api/plugins/regex-filter/preview', (req, res) => {
            const loaded = this.loader.getAllPlugins().get('regex-filter');
            if (!loaded || !loaded.instance) {
                return res.status(404).json({ success: false, error: 'regex-filter 插件未加载' });
            }
            const { text } = req.body;
            if (typeof text !== 'string') {
                return res.status(400).json({ success: false, error: '请提供 text 字段' });
            }
            try {
                const processedText = loaded.instance.processText(text);
                res.json({ success: true, processedText });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
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
                // 校验 meta.name 并断言目标目录落在 plugins/ 之内，防止 ../ 覆盖核心文件
                assertValidPluginName(meta.name);
                const targetDir = assertInside(this.loader.pluginsDir, path.join(this.loader.pluginsDir, meta.name));

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
            const { url, subfolder, confirm } = req.body;
            if (!url) {
                return res.status(400).json({ success: false, error: '请提供 GitHub 仓库地址' });
            }

            try {
                // 两阶段安装：首次调用只下载并返回"将获得哪些能力 + 代码扫描结果"，
                // 由用户确认后带 confirm:true 再次调用才真正落地加载。
                // 插件与网关同进程运行，安装即等于执行其代码——必须让用户先看见。
                const result = await this.installFromGitHub(url, subfolder, { confirm: confirm === true });
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
    async installFromGitHub(url, subfolder = '', options = {}) {
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

            // 如果有子目录：断言仍落在解压目录内，防止 ../../ 逃逸读取任意目录
            if (actualSubfolder) {
                const rootAfterUnzip = pluginSourceDir;
                pluginSourceDir = assertInside(rootAfterUnzip, path.join(rootAfterUnzip, actualSubfolder));
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
            // 校验 meta.name（来自不可信 ZIP）并断言目标落在 plugins/ 内，
            // 防止 {"name":"../../server"} 之类删除/覆盖核心文件
            assertValidPluginName(meta.name);
            const targetDir = assertInside(this.loader.pluginsDir, path.join(this.loader.pluginsDir, meta.name));

            // ⭐ 安装前风险披露：扫描源码 + 汇总将授予的能力。
            // 未确认时到此为止——不复制、不加载、不执行插件任何代码。
            const risk = scanPluginRisk(pluginSourceDir, { fs, path });
            const { granted } = normalizePermissions(meta.permissions, meta.name);
            if (!options.confirm) {
                logger.info(`插件 ${meta.name} 待确认安装（风险等级 ${risk.maxLevel}）`);
                return {
                    success: false,
                    needConfirm: true,
                    plugin: {
                        name: meta.name,
                        displayName: meta.displayName || meta.name,
                        version: meta.version || '',
                        author: meta.author || '',
                    },
                    permissions: [...granted],
                    permissionRisk: highestRisk(granted),
                    scan: risk,
                    disclosure: formatInstallDisclosure(meta, risk),
                    message: '请确认插件申请的能力与代码扫描结果后再安装',
                };
            }
            logger.warn(`用户已确认安装插件 ${meta.name}（风险 ${risk.maxLevel}，权限 ${[...granted].join(',')}）`);

            // 如果已存在，先卸载
            if (this.loader.getPlugin(meta.name)) {
                await this.uninstallPlugin(meta.name);
            }
            if (fs.existsSync(targetDir)) {
                fs.rmSync(targetDir, { recursive: true });
            }

            // 安全：拒绝插件包内的符号链接（可指向宿主任意文件，构成越界读写/逃逸）。
            // 注：外部 unzip/PowerShell 解压不校验 zip-slip，完整防护应改用纯 JS 解压库
            // 并逐条目断言路径归属（见 docs 综合分析报告 P0-4）；此处先堵住最实际的 symlink 逃逸。
            this._assertNoSymlinks(pluginSourceDir);

            // 复制到 plugins 目录（不跟随符号链接）
            fs.cpSync(pluginSourceDir, targetDir, { recursive: true, dereference: false });

            // 加载插件
            const config = this.loadPluginConfig(meta.name);
            const instance = await this.loader.loadPlugin(targetDir, meta, config);
            if (instance) {
                this.pluginStates.set(meta.name, { enabled: meta.enabled !== false });
                if (meta.enabled !== false) {
                    this.registerPlugin(instance);
                }
                // 重新同步命令到所有平台
                const commands = this.commandRouter.getCommandsForSync();
                await this.gateway.syncAllCommands(commands);
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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        try {
            const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
            if (!response.ok) {
                throw new Error(`下载失败: HTTP ${response.status}`);
            }
            // 预检 Content-Length（若提供）
            const declared = parseInt(response.headers.get('content-length') || '0', 10);
            if (declared && declared > MAX_DOWNLOAD_BYTES) {
                throw new Error(`插件包过大（${(declared / 1048576).toFixed(1)}MB，上限 ${MAX_DOWNLOAD_BYTES / 1048576}MB）`);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            // 兜底：无 Content-Length 时按实际大小再校验一次
            if (buffer.length > MAX_DOWNLOAD_BYTES) {
                throw new Error(`插件包过大（${(buffer.length / 1048576).toFixed(1)}MB，上限 ${MAX_DOWNLOAD_BYTES / 1048576}MB）`);
            }
            fs.writeFileSync(destPath, buffer);
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`下载超时（${DOWNLOAD_TIMEOUT_MS / 1000}s）`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
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
     * 递归断言目录内无符号链接，命中即抛错。
     * @param {string} dir
     * @param {number} depth
     */
    _assertNoSymlinks(dir, depth = 0) {
        if (depth > 8) return; // 防御异常深目录
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error(`插件包含符号链接，出于安全拒绝安装: ${entry.name}`);
            }
            if (entry.isDirectory() && entry.name !== 'node_modules') {
                this._assertNoSymlinks(full, depth + 1);
            }
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
        this.scheduler.stop();
        await this.loader.unloadAll();
        logger.info('插件系统已关闭');
    }
}

export default PluginManager;
