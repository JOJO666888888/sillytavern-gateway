/**
 * AstrBot 兼容层 - 统一导出
 *
 * 模拟 AstrBot 的 import 路径。迁移 AstrBot 插件时，把 Python 的:
 *
 *   from astrbot.api.star import Context, Star, register
 *   from astrbot.api.event import AstrMessageEvent, filter
 *   from astrbot.api import AstrBotConfig
 *   import astrbot.api.message_components as Comp
 *
 * 统一替换为一行:
 *
 *   import { Star, AstrMessageEvent, Plain, Image, At, Reply,
 *            defineCommand, defineLLMTool } from '../../server/compat/index.js';
 *
 * 详细迁移指南见 docs/PLUGIN_DEVELOPMENT_GUIDE.md 第 16 节，
 * 或使用 astrbot-port skill 自动翻译。
 */

export {
    // 基类
    Star,
    // 事件对象
    AstrMessageEvent,
    // 消息组件（等价 AstrBot 的 Comp.*）
    Plain,
    Image,
    At,
    Reply,
    // 结果对象
    MessageEventResult,
    // 注册辅助（因 JS 无装饰器，改为声明式）
    defineCommand,
    defineLLMTool,
    // 内部工具（一般插件用不到，但导出供高级场景）
    serializeChain,
    drainGenerator,
} from './astrbot-shim.js';
