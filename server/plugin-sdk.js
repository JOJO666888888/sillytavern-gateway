/**
 * Gateway Plugin SDK
 * 插件开发者使用的所有接口
 *
 * 用法:
 *   import { GatewayPlugin } from '../../server/plugin-sdk.js';
 *
 *   export default class MyPlugin extends GatewayPlugin {
 *       static commands = [
 *           { name: 'hello', alias: ['你好'], handler: 'handleHello', description: '打招呼' },
 *       ];
 *       static listeners = [
 *           { event: 'message', filter: { platform: 'qq' }, handler: 'onMessage' },
 *       ];
 *       static schedules = [
 *           { cron: '0 9 * * *', handler: 'dailyReport', description: '每日报告' },
 *       ];
 *
 *       async onLoad() { }
 *       async onUnload() { }
 *
 *       async handleHello(ctx) {
 *           return ctx.reply('Hello!');
 *       }
 *   }
 */

import { createLogger } from './utils/logger.js';

/**
 * 插件基类 - 所有插件必须继承此类
 */
export class GatewayPlugin {
    /**
     * 插件元数据（由 plugin.json 注入，也可在类中覆盖）
     * @type {{name: string, displayName: string, version: string, author: string, description: string}}
     */
    meta = {
        name: 'unnamed',
        displayName: '未命名插件',
        version: '0.0.0',
        author: 'unknown',
        description: '',
    };

    /**
     * 命令注册表
     * 子类通过 static commands 声明
     * @type {Array<{name: string, alias?: string[], handler: string, description?: string, usage?: string}>}
     */
    static commands = [];

    /**
     * 事件监听器注册表
     * 子类通过 static listeners 声明
     * @type {Array<{event: string, filter?: object, handler: string, priority?: number}>}
     */
    static listeners = [];

    /**
     * 定时任务注册表
     * 子类通过 static schedules 声明
     * @type {Array<{cron: string, handler: string, description?: string}>}
     */
    static schedules = [];

    /**
     * @param {object} options - 由 PluginLoader 注入
     * @param {object} options.pluginConfig - 插件私有配置
     * @param {object} options.services - 网关服务引用
     */
    constructor(options = {}) {
        this._services = options.services || {};
        this._pluginConfig = options.pluginConfig || {};
        this._enabled = true;
        this._loaded = false;
        this.logger = createLogger(`plugin:${this.meta.name}`);
    }

    /**
     * 插件加载时调用（子类可覆盖）
     */
    async onLoad() {}

    /**
     * 插件卸载时调用（子类可覆盖）
     */
    async onUnload() {}

    /**
     * 获取插件私有配置
     * @param {string} key - 配置键（可选，不传返回全部）
     */
    getConfig(key) {
        if (key) return this._pluginConfig[key];
        return { ...this._pluginConfig };
    }

    /**
     * 设置插件私有配置
     * @param {string} key
     * @param {*} value
     */
    setConfig(key, value) {
        this._pluginConfig[key] = value;
        // 通知 manager 持久化
        if (this._services.savePluginConfig) {
            this._services.savePluginConfig(this.meta.name, this._pluginConfig);
        }
    }

    /**
     * 是否已启用
     */
    get enabled() {
        return this._enabled;
    }

    /**
     * 获取已注册的命令列表
     */
    getCommands() {
        return this.constructor.commands || [];
    }

    /**
     * 获取已注册的监听器列表
     */
    getListeners() {
        return this.constructor.listeners || [];
    }

    /**
     * 获取已注册的定时任务列表
     */
    getSchedules() {
        return this.constructor.schedules || [];
    }
}

/**
 * 命令注册辅助函数（用于非 static 方式的动态注册）
 * @param {string} name - 命令名
 * @param {object} options - 选项
 * @returns {object} 命令描述对象
 */
export function defineCommand(name, options = {}) {
    return {
        name,
        alias: options.alias || [],
        handler: options.handler || name,
        description: options.description || '',
        usage: options.usage || '',
    };
}

/**
 * 消息监听器注册辅助函数
 * @param {object} filter - 过滤条件 { platform?, chatType?, chatId? }
 * @param {string} handler - 处理方法名
 * @returns {object} 监听器描述对象
 */
export function defineListener(filter = {}, handler = 'onMessage') {
    return {
        event: 'message',
        filter,
        handler,
    };
}

/**
 * 定时任务注册辅助函数
 * @param {string} cron - cron 表达式
 * @param {string} handler - 处理方法名
 * @param {string} description - 描述
 * @returns {object} 定时任务描述对象
 */
export function defineSchedule(cron, handler, description = '') {
    return { cron, handler, description };
}

export default GatewayPlugin;
