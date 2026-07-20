/**
 * Plugin Loader - 插件发现、加载、卸载
 * 扫描 plugins/ 目录，动态 import 插件，验证实例化
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createLogger } from './utils/logger.js';
import { GatewayPlugin } from './plugin-sdk.js';

const logger = createLogger('plugin-loader');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 插件加载器
 */
export class PluginLoader {
    /**
     * @param {object} options
     * @param {string} options.pluginsDir - 插件目录路径
     * @param {object} options.services - 注入给插件的服务引用
     */
    constructor(options = {}) {
        this.pluginsDir = options.pluginsDir || path.resolve(__dirname, '..', 'plugins');
        this.services = options.services || {};
        this.loadedPlugins = new Map(); // name -> { instance, meta, path }
    }

    /**
     * 扫描插件目录，返回所有有效插件的元数据
     * @returns {Array<{name: string, dir: string, meta: object}>}
     */
    discoverPlugins() {
        const plugins = [];

        if (!fs.existsSync(this.pluginsDir)) {
            logger.info(`插件目录不存在，已创建: ${this.pluginsDir}`);
            fs.mkdirSync(this.pluginsDir, { recursive: true });
            return plugins;
        }

        const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const pluginDir = path.join(this.pluginsDir, entry.name);
            const metaPath = path.join(pluginDir, 'plugin.json');

            if (!fs.existsSync(metaPath)) {
                logger.debug(`跳过 ${entry.name}：缺少 plugin.json`);
                continue;
            }

            try {
                const metaRaw = fs.readFileSync(metaPath, 'utf-8');
                const meta = JSON.parse(metaRaw);

                if (!meta.name) {
                    logger.warn(`插件 ${entry.name} 的 plugin.json 缺少 name 字段`);
                    continue;
                }

                plugins.push({
                    name: meta.name,
                    dir: pluginDir,
                    meta,
                });
            } catch (error) {
                logger.error(`解析 ${entry.name}/plugin.json 失败: ${error.message}`);
            }
        }

        return plugins;
    }

    /**
     * 加载单个插件
     * @param {string} pluginDir - 插件目录
     * @param {object} meta - plugin.json 元数据
     * @param {object} pluginConfig - 插件私有配置
     * @returns {Promise<GatewayPlugin|null>}
     */
    async loadPlugin(pluginDir, meta, pluginConfig = {}) {
        const mainFile = meta.main || 'index.js';
        const mainPath = path.join(pluginDir, mainFile);

        if (!fs.existsSync(mainPath)) {
            logger.error(`插件 ${meta.name} 入口文件不存在: ${mainPath}`);
            return null;
        }

        try {
            // 动态导入（添加时间戳避免缓存）
            const fileUrl = pathToFileURL(mainPath).href + `?t=${Date.now()}`;
            const module = await import(fileUrl);

            const PluginClass = module.default;

            if (!PluginClass) {
                logger.error(`插件 ${meta.name} 没有默认导出`);
                return null;
            }

            // 验证是否继承 GatewayPlugin
            if (!(PluginClass.prototype instanceof GatewayPlugin) && PluginClass !== GatewayPlugin) {
                logger.error(`插件 ${meta.name} 必须继承 GatewayPlugin`);
                return null;
            }

            // 实例化
            const instance = new PluginClass({
                pluginConfig,
                services: this.services,
            });

            // 注入 plugin.json 元数据
            instance.meta = { ...instance.meta, ...meta };
            instance._pluginDir = pluginDir;

            // 调用 onLoad 生命周期
            await instance.onLoad();
            instance._loaded = true;

            this.loadedPlugins.set(meta.name, {
                instance,
                meta,
                path: pluginDir,
            });

            logger.info(`插件已加载: ${meta.displayName || meta.name} v${meta.version || '0.0.0'}`);
            return instance;
        } catch (error) {
            logger.error(`加载插件 ${meta.name} 失败: ${error.message}`);
            logger.debug(error.stack);
            return null;
        }
    }

    /**
     * 卸载单个插件
     * @param {string} name - 插件名称
     */
    async unloadPlugin(name) {
        const loaded = this.loadedPlugins.get(name);
        if (!loaded) {
            logger.warn(`插件 ${name} 未加载`);
            return false;
        }

        try {
            await loaded.instance.onUnload();
            loaded.instance._loaded = false;
            this.loadedPlugins.delete(name);
            logger.info(`插件已卸载: ${name}`);
            return true;
        } catch (error) {
            logger.error(`卸载插件 ${name} 时出错: ${error.message}`);
            // 即使 onUnload 出错也强制移除
            this.loadedPlugins.delete(name);
            return true;
        }
    }

    /**
     * 重载插件（卸载后重新加载）
     * @param {string} name - 插件名称
     * @param {object} pluginConfig - 插件配置
     */
    async reloadPlugin(name, pluginConfig = {}) {
        const loaded = this.loadedPlugins.get(name);
        if (!loaded) {
            logger.warn(`插件 ${name} 未加载，无法重载`);
            return null;
        }

        const { meta, path: pluginDir } = loaded;
        await this.unloadPlugin(name);
        return await this.loadPlugin(pluginDir, meta, pluginConfig);
    }

    /**
     * 加载所有发现的插件
     * @param {Function} getConfig - 获取插件配置的函数 (name) => config
     * @returns {Map<string, GatewayPlugin>}
     */
    async loadAll(getConfig = () => ({})) {
        const discovered = this.discoverPlugins();
        logger.info(`发现 ${discovered.length} 个插件`);

        for (const plugin of discovered) {
            const config = getConfig(plugin.name);
            await this.loadPlugin(plugin.dir, plugin.meta, config);
        }

        return this.loadedPlugins;
    }

    /**
     * 卸载所有插件
     */
    async unloadAll() {
        const names = [...this.loadedPlugins.keys()];
        for (const name of names) {
            await this.unloadPlugin(name);
        }
    }

    /**
     * 获取已加载插件实例
     * @param {string} name
     */
    getPlugin(name) {
        return this.loadedPlugins.get(name)?.instance || null;
    }

    /**
     * 获取所有已加载插件
     */
    getAllPlugins() {
        return this.loadedPlugins;
    }
}

export default PluginLoader;
