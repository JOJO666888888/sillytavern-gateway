/**
 * AstrBot 兼容 Shim
 *
 * 提供 AstrBot 风格的 API（Star 基类、AstrMessageEvent、消息组件等），
 * 全部构建在 GatewayPlugin / PluginContext 之上，零新依赖。
 *
 * 让 AstrBot 作者迁移时把 Python 逐行翻译成 JS 即可，无需理解网关内部机制。
 *
 * 对照:
 *   AstrBot (Python)                    → 本 Shim (JS)
 *   from astrbot.api.star import Star   → import { Star } from '../../server/compat/index.js'
 *   from astrbot.api.event import ...   → import { AstrMessageEvent } from '...'
 *   import astrbot.api.message_components as Comp → import { Plain, Image, At, Reply } from '...'
 *   @filter.command("name")             → defineCommand('name', {...})
 *   @filter.llm_tool("desc")            → defineLLMTool('name', 'desc', schema, 'handler')
 *   yield event.plain_result("text")    → yield event.plain_result("text")
 *   async def handler(self, event)      → async *handler(event) { ... }
 */

import { GatewayPlugin, defineCommand as gwDefineCommand } from '../plugin-sdk.js';
import { OutboundMessage } from '../adapters/base-adapter.js';

// ==================== 消息组件 ====================

/** 纯文本组件 */
export class Plain {
    constructor(text) { this.text = String(text); }
}

/** 图片组件 */
export class Image {
    constructor(url) { this.url = String(url); }
    static fromURL(url) { return new Image(url); }
    static fromFileSystem(path) { return new Image(`file://${path}`); }
}

/** @ 提及组件 */
export class At {
    constructor(qq) { this.qq = String(qq); }
}

/** 回复引用组件 */
export class Reply {
    constructor(id) { this.id = String(id); }
}

/**
 * 将消息组件链序列化为 { content, mediaUrls, replyToId }
 * 供 chain_result 和 context.send_message 使用。
 */
export function serializeChain(chain) {
    let content = '';
    const mediaUrls = [];
    let replyToId = '';

    for (const comp of chain) {
        if (comp instanceof At) {
            content += `@${comp.qq}`;
        } else if (comp instanceof Plain) {
            content += comp.text;
        } else if (comp instanceof Image) {
            mediaUrls.push(comp.url);
        } else if (comp instanceof Reply) {
            replyToId = String(comp.id);
        }
    }

    return { content, mediaUrls, replyToId };
}

// ==================== 结果对象 ====================

/**
 * 轻量结果对象，由 event.plain_result / image_result / chain_result 创建。
 * 在生成器 handler 中 yield 出去，由 drainGenerator 收集并发送。
 */
export class MessageEventResult {
    constructor(type, data) {
        this.type = type; // 'plain' | 'image' | 'chain'
        this.data = data;
    }
}

// ==================== 生成器 drain ====================

/**
 * 自动 drain 一个异步生成器，依次发送 yield 出的 MessageEventResult。
 * 异常隔离：单个 yield 出错不影响后续。
 *
 * @param {AsyncGenerator<MessageEventResult>} gen
 * @param {AstrMessageEvent} event
 */
export async function drainGenerator(gen, event) {
    let result = await gen.next();
    while (!result.done) {
        const value = result.value;
        if (value instanceof MessageEventResult) {
            try {
                await sendResult(value, event);
            } catch (e) {
                event._ctx?.logger?.error?.(`AstrBot handler yield 发送失败: ${e.message}`);
            }
        }
        result = await gen.next();
    }
}

async function sendResult(result, event) {
    switch (result.type) {
        case 'plain':
            await event._ctx.reply(String(result.data));
            break;
        case 'image':
            await event._ctx.reply('', { mediaUrls: [String(result.data)] });
            break;
        case 'chain': {
            const { content, mediaUrls, replyToId } = serializeChain(result.data || []);
            await event._ctx.reply(content, { mediaUrls, replyToId });
            break;
        }
    }
}

// ==================== AstrMessageEvent ====================

/**
 * 包装 PluginContext 为 AstrBot 风格的事件对象。
 * 字段和方法名与 AstrBot 的 AstrMessageEvent 一致。
 */
export class AstrMessageEvent {
    /**
     * @param {import('../plugin-context.js').PluginContext} ctx
     * @param {Star} [star] - 所属 Star 实例（可选）
     */
    constructor(ctx, star = null) {
        this._ctx = ctx;
        this._star = star;

        // 字段映射 — 镜像 AstrBot 命名
        this.message_str = ctx.content || '';
        this.sender_id = ctx.senderId || '';
        this.sender_name = ctx.senderName || '';
        this.chat_id = ctx.chatId || '';
        this.platform = ctx.platform || '';
        this.message_id = ctx.messageId || '';
        this.session_id = ctx.chatId || '';
        this.group_id = ctx.chatType === 'group' ? ctx.chatId : '';
        this.message_type = ctx.chatType || 'private';

        // 原始消息对象（简化版）
        this.message_obj = {
            message_id: this.message_id,
            sender_id: this.sender_id,
            sender_name: this.sender_name,
            session_id: this.session_id,
            platform: this.platform,
            content: this.message_str,
        };
    }

    // ========== 获取器 ==========

    get_sender_name() { return this.sender_name; }
    get_sender_id() { return this.sender_id; }
    get_group_id() { return this.group_id; }
    get_session_id() { return this.session_id; }
    get_platform_name() { return this.platform; }
    get_message_str() { return this.message_str; }
    get_message_id() { return this.message_id; }
    get_message_type() { return this.message_type; }

    is_private_chat() { return this.message_type === 'private'; }
    is_group_chat() { return this.message_type === 'group'; }

    /**
     * 检查发送者是否为管理员。
     * 读取网关配置的 admins 白名单，格式 "platform:senderId" 或裸 senderId。
     */
    is_admin() {
        const cfg = this._ctx._configManager;
        if (!cfg) return false;
        const admins = cfg.get('admins') || [];
        const who = `${this.platform}:${this.sender_id}`;
        return admins.includes(who) || admins.includes(String(this.sender_id));
    }

    is_wake_up() {
        return this._ctx.mentioned || false;
    }

    // ========== 结果创建（用于 yield） ==========

    /** 创建纯文本结果 */
    plain_result(text) {
        return new MessageEventResult('plain', text);
    }

    /** 创建图片结果 */
    image_result(url) {
        return new MessageEventResult('image', url);
    }

    /** 创建组件链结果 */
    chain_result(chain) {
        return new MessageEventResult('chain', chain);
    }

    // ========== 直接发送（用于非生成器上下文） ==========

    /**
     * 直接发送文本消息（不通过 yield）。
     * AstrBot 兼容：event.send("text")
     */
    async send(text, options = {}) {
        return this._ctx.reply(text, options);
    }

    /** 发送打字指示（网关无 typing 信令，仅记录日志） */
    send_typing() {
        this._ctx?.logger?.debug?.('AstrBot handler 请求 typing 信令（网关不支持，已忽略）');
    }

    /** 发送流式消息（网关不支持流式出站，降级为普通发送） */
    async send_streaming(text) {
        return this._ctx.reply(text);
    }

    // ========== 控制流 ==========

    /** 阻止消息继续传播 */
    stop_event() {
        this._ctx.stopPropagation();
    }

    /** 继续传播（默认行为，无操作） */
    continue_event() {
        // 默认就是继续传播，无需操作
    }
}

// ==================== 注册辅助函数 ====================

/**
 * 声明一条命令（AstrBot 的 @filter.command 等价）。
 * 返回格式与 GatewayPlugin 的 commands 数组兼容。
 *
 * @param {string} name - 命令名（不含 /）
 * @param {object}   [options]
 * @param {string[]} [options.alias] - 别名
 * @param {string}   [options.description] - 描述
 * @param {string}   [options.usage] - 用法
 * @param {string}   [options.handler] - 处理器方法名（默认同 name）
 * @returns {object} 命令描述对象
 */
export function defineCommand(name, options = {}) {
    return gwDefineCommand(name, options);
}

/**
 * 声明一条 LLM 工具（AstrBot 的 @filter.llm_tool 等价）。
 * 与 defineTool 类似，但标记为 LLM 工具。
 *
 * @param {string}   name - 工具名
 * @param {string}   description - 描述
 * @param {object}   parameters - JSON Schema 参数定义
 * @param {string}   [handler] - 执行器方法名（默认同 name）
 * @returns {object} 工具描述对象
 */
export function defineLLMTool(name, description, parameters, handler) {
    return { name, description, parameters, _handler: handler || name, _llmTool: true };
}

// ==================== Context ====================

/**
 * 构建 AstrBot 风格的 Context 对象。
 * 挂在 Star 实例的 this.context 上。
 */
function buildContext(star) {
    return {
        /** 发送消息到指定会话 */
        send_message: async (session, chain) => {
            const { content, mediaUrls, replyToId } = serializeChain(chain);
            const gw = star._services?.gateway;
            if (!gw) throw new Error('Context.send_message: 网关未就绪');

            const msg = new OutboundMessage({
                platform: session.platform || session.session_id?.split(':')[0] || 'unknown',
                chatId: session.session_id || '',
                chatType: session.message_type || 'private',
                content,
                mediaUrls,
                replyToId,
                // AstrBot 的 session 对象可能包含这些字段
                ...(session.message_type === 'group' ? { chatType: 'group' } : {}),
            });
            gw.sendMessage(msg);
        },

        /** 获取当前 LLM 提供者（声明了 llm 权限时可用） */
        get_using_provider: async () => {
            return star._services?.llm || null;
        },

        /** 获取所有已加载插件元数据 */
        get_all_stars: () => {
            // 简化：返回插件列表的元数据
            try {
                const pm = star._services?._pluginManager;
                if (pm && typeof pm.listPlugins === 'function') {
                    return pm.listPlugins().map(p => ({
                        name: p.name,
                        displayName: p.displayName,
                        version: p.version,
                        author: p.author,
                        description: p.description,
                        enabled: p.enabled,
                    }));
                }
            } catch (_) { /* ignore */ }
            return [];
        },

        /** 获取网关配置（受权限收窄 + 凭据脱敏） */
        get_config: (umo) => {
            return star._services?.gatewayConfig || null;
        },
    };
}

// ==================== Star 基类 ====================

/**
 * AstrBot 兼容的 Star 基类。
 * 继承 GatewayPlugin，提供 AstrBot 风格的 API。
 *
 * 用法:
 * ```js
 * import { Star, defineCommand, defineLLMTool, Plain, Image } from '../../server/compat/index.js';
 *
 * export default class MySkill extends Star {
 *     static commands = [
 *         defineCommand('hello', { description: '打招呼' }),
 *     ];
 *
 *     async *hello(event) {
 *         yield event.plain_result(`Hello, ${event.sender_name}!`);
 *     }
 * }
 * ```
 */
export class Star extends GatewayPlugin {
    constructor(options = {}) {
        super(options);

        // AstrBot 风格的 Context
        this.context = buildContext(this);

        // 自动包装生成器 handler
        this._setupHandlerWrappers();
    }

    // ========== 生成器自动包装 ==========

    /** 检测声明 handler 中哪些是生成器，创建包装方法 */
    _setupHandlerWrappers() {
        this._handlerWrappers = new Map(); // originalName -> wrapperName

        const handlers = new Set();
        for (const l of this.constructor.listeners || []) {
            if (l.handler) handlers.add(l.handler);
        }
        for (const c of this.constructor.commands || []) {
            if (c.handler) handlers.add(c.handler);
        }

        for (const name of handlers) {
            if (typeof this[name] !== 'function') continue;
            // 检查是否为异步生成器函数
            const fn = this[name];
            if (fn.constructor && fn.constructor.name === 'AsyncGeneratorFunction') {
                const wrapperName = `_aw_${name}`;
                this[wrapperName] = this._makeGeneratorWrapper(name);
                this._handlerWrappers.set(name, wrapperName);
            }
        }
    }

    /** 为生成器 handler 创建包装函数 */
    _makeGeneratorWrapper(handlerName) {
        const star = this;
        return async function wrappedHandler(ctx) {
            const event = new AstrMessageEvent(ctx, star);
            const gen = star[handlerName](event);
            await drainGenerator(gen, event);
        };
    }

    /** 获取命令列表（自动替换生成器 handler 名为包装名） */
    getCommands() {
        const cmds = super.getCommands();
        if (this._handlerWrappers?.size) {
            return cmds.map(c => {
                const w = this._handlerWrappers.get(c.handler);
                return w ? { ...c, handler: w } : c;
            });
        }
        return cmds;
    }

    /** 获取监听器列表（自动替换生成器 handler 名为包装名） */
    getListeners() {
        const listeners = super.getListeners();
        if (this._handlerWrappers?.size) {
            return listeners.map(l => {
                const w = this._handlerWrappers.get(l.handler);
                return w ? { ...l, handler: w } : l;
            });
        }
        return listeners;
    }

    // ========== AstrBot 生命周期 ==========

    /**
     * AstrBot 风格的初始化方法（对应 onLoad）。
     * 子类覆盖此方法而非 onLoad。
     */
    async initialize() {
        // 子类覆盖
    }

    /**
     * AstrBot 风格的终止方法（对应 onUnload）。
     * 子类覆盖此方法而非 onUnload。
     */
    async terminate() {
        // 子类覆盖
    }

    /** @internal 网关生命周期钩子 → AstrBot initialize */
    async onLoad() {
        await this.initialize();
    }

    /** @internal 网关生命周期钩子 → AstrBot terminate */
    async onUnload() {
        await this.terminate();
    }

    // ========== 工具支持 ==========

    /**
     * LLM 工具定义（由 defineLLMTool 声明）。
     * 子类若使用 LLM 工具，需同时提供 tools 和 executeTool。
     * 此方法从 _llmTools 集合自动构建 tools 数组。
     */
    get tools() {
        // 若子类覆盖了 tools 直接返回
        if (this.constructor._toolsOverride) return this.constructor._toolsOverride;
        return this._buildToolsFromDeclarations();
    }

    _buildToolsFromDeclarations() {
        const tools = [];
        // 检查 static llm_tools
        const decls = this.constructor.llm_tools || [];
        for (const t of decls) {
            tools.push({
                name: t.name,
                description: t.description || '',
                parameters: t.parameters || { type: 'object', properties: {} },
            });
        }
        return tools;
    }

    /**
     * LLM 工具执行器。
     * 子类若声明了 llm_tools，应覆盖此方法。
     * 默认自动路由到 llm_tools 声明中 handler 指定的方法。
     */
    async executeTool(name, args) {
        const decls = this.constructor.llm_tools || [];
        for (const t of decls) {
            if (t.name === name) {
                const handler = t._handler || name;
                if (typeof this[handler] === 'function') {
                    return this[handler](args);
                }
            }
        }
        return { error: `未实现工具: ${name}` };
    }

    /**
     * 声明 LLM 工具（静态）。
     * 在子类中覆盖此 getter，返回 defineLLMTool 的结果数组。
     * @type {Array<{name: string, description: string, parameters: object, _handler: string}>}
     */
    static get llm_tools() {
        return [];
    }
}