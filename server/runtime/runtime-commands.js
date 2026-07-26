import { createLogger } from '../utils/logger.js';

const logger = createLogger('runtime-cmd');

/**
 * 自建管线的会话级切换命令
 *
 * ⭐ 这些命令兑现「自由切换存档 / 角色卡 / 世界书 / 预设」——
 * 每条命令只作用于**发出命令的那个会话**，其它会话不受影响
 * （对比 ST 前端：任何切换都是全局的，会打断别人）。
 *
 * 注册到 CommandRouter，与插件命令共存。
 */
export function registerRuntimeCommands(commandRouter, runtime) {
    const reg = (name, opts) => commandRouter.register({
        name,
        alias: opts.alias || [],
        description: opts.description,
        usage: opts.usage || '',
        adminOnly: opts.adminOnly === true,
        pluginName: 'runtime',
        handler: opts.handler,
    });

    // /char [名字] —— 查看或切换本会话角色卡
    reg('char', {
        alias: ['角色'],
        description: '查看或切换本会话的角色卡',
        usage: '/char           列出可用角色卡\n/char <名字>    切换到指定角色卡',
        handler: async (ctx) => {
            const name = ctx.args.join(' ').trim();
            const assets = runtime.listAssets();
            if (!name) {
                const cur = runtime.profiles.get(ctx.platform, ctx.chatId).character || '(未设置)';
                return ctx.reply(`当前角色：${cur}\n可用角色卡：\n${assets.characters.map(c => `· ${c}`).join('\n') || '(无，请放入 assets/characters/)'}`);
            }
            if (!assets.characters.includes(name)) {
                return ctx.reply(`未找到角色卡「${name}」。可用：${assets.characters.join('、') || '(无)'}`);
            }
            runtime.profiles.update(ctx.platform, ctx.chatId, { character: name });
            const greeting = runtime.getGreeting(ctx.platform, ctx.chatId);
            return ctx.reply(`✅ 本会话角色已切换为「${name}」${greeting ? `\n\n${greeting}` : ''}`);
        },
    });

    // /preset [名字]
    reg('preset', {
        alias: ['预设'],
        description: '查看或切换本会话的预设',
        usage: '/preset          列出可用预设\n/preset <名字>   切换预设',
        handler: async (ctx) => {
            const name = ctx.args.join(' ').trim();
            const assets = runtime.listAssets();
            if (!name) {
                const cur = runtime.profiles.get(ctx.platform, ctx.chatId).preset || '(默认)';
                return ctx.reply(`当前预设：${cur}\n可用预设：\n${assets.presets.map(p => `· ${p}`).join('\n') || '(无)'}`);
            }
            runtime.profiles.update(ctx.platform, ctx.chatId, { preset: name });
            runtime.clearCache();
            return ctx.reply(`✅ 本会话预设已切换为「${name}」`);
        },
    });

    // /world [add|remove|list] <名字>
    reg('world', {
        alias: ['世界书'],
        description: '管理本会话启用的世界书',
        usage: '/world                列出\n/world add <名字>     启用\n/world remove <名字>  停用',
        handler: async (ctx) => {
            const [sub, ...rest] = ctx.args;
            const name = rest.join(' ').trim();
            const profile = runtime.profiles.get(ctx.platform, ctx.chatId);
            const assets = runtime.listAssets();

            if (!sub || sub === 'list') {
                return ctx.reply(`本会话启用的世界书：${(profile.worldbooks || []).join('、') || '(无)'}\n可用：${assets.worldbooks.join('、') || '(无)'}`);
            }
            if (sub === 'add') {
                if (!assets.worldbooks.includes(name)) return ctx.reply(`未找到世界书「${name}」`);
                const list = new Set(profile.worldbooks || []);
                list.add(name);
                runtime.profiles.update(ctx.platform, ctx.chatId, { worldbooks: [...list] });
                return ctx.reply(`✅ 已为本会话启用世界书「${name}」`);
            }
            if (sub === 'remove') {
                const list = (profile.worldbooks || []).filter(w => w !== name);
                runtime.profiles.update(ctx.platform, ctx.chatId, { worldbooks: list });
                return ctx.reply(`✅ 已停用世界书「${name}」`);
            }
            return ctx.reply('用法：/world [list|add|remove] <名字>');
        },
    });

    // /load <存档名> —— 切换本会话的聊天存档
    reg('load', {
        alias: ['存档'],
        description: '切换本会话的聊天存档（与 SillyTavern 互通）',
        usage: '/load            列出存档\n/load <名字>     切换到该存档',
        handler: async (ctx) => {
            const name = ctx.args.join(' ').trim();
            const assets = runtime.listAssets();
            if (!name) {
                const cur = runtime.profiles.get(ctx.platform, ctx.chatId).archive || `${ctx.platform}_${ctx.chatId}`;
                return ctx.reply(`当前存档：${cur}\n可用存档：\n${assets.archives.map(a => `· ${a}`).join('\n') || '(无)'}`);
            }
            runtime.profiles.update(ctx.platform, ctx.chatId, { archive: name });
            return ctx.reply(`✅ 本会话已切换到存档「${name}」（不影响其它会话）`);
        },
    });

    // /new [存档名] —— 新建存档（相当于开新聊天）
    reg('new', {
        alias: ['新聊天'],
        description: '为本会话新建一个聊天存档',
        usage: '/new [存档名]',
        handler: async (ctx) => {
            const name = ctx.args.join(' ').trim() || `${ctx.platform}_${ctx.chatId}_${Math.floor(Date.now() / 1000)}`;
            runtime.profiles.update(ctx.platform, ctx.chatId, { archive: name });
            const greeting = runtime.getGreeting(ctx.platform, ctx.chatId);
            return ctx.reply(`🆕 已新建存档「${name}」${greeting ? `\n\n${greeting}` : ''}`);
        },
    });

    // /profile —— 查看本会话完整运行上下文
    reg('profile', {
        alias: ['配置'],
        description: '查看本会话的角色/预设/世界书/存档绑定',
        handler: async (ctx) => {
            const p = runtime.profiles.get(ctx.platform, ctx.chatId);
            return ctx.reply([
                `📋 本会话配置 (${ctx.platform}:${ctx.chatId})`,
                `角色卡：${p.character || '(未设置)'}`,
                `预设：${p.preset || '(默认)'}`,
                `世界书：${(p.worldbooks || []).join('、') || '(无)'}`,
                `存档：${p.archive || `${ctx.platform}_${ctx.chatId}`}`,
            ].join('\n'));
        },
    });

    logger.info('自建管线命令已注册: /char /preset /world /load /new /profile');
}

export default registerRuntimeCommands;
