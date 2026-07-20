/**
 * 掷骰子示例插件
 * 支持 /roll NdM 格式、属性检定
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class DicePlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'roll',
            alias: ['r', '骰', '掷骰'],
            handler: 'handleRoll',
            description: '掷骰子 (如: /roll 2d6, /roll d20, /roll)',
            usage: '/roll [NdM] [原因]',
        },
        {
            name: 'check',
            alias: ['jc', '检定'],
            handler: 'handleCheck',
            description: '属性检定 (如: /check 力量 60)',
            usage: '/check <属性名> <目标值>',
        },
    ];

    static listeners = [];

    async onLoad() {
        this.logger.info('掷骰子插件已加载！');
    }

    async onUnload() {
        this.logger.info('掷骰子插件已卸载');
    }

    /**
     * /roll 命令 - 掷骰子
     * 支持格式: /roll 2d6+3 攻击, /roll d20, /roll
     */
    async handleRoll(ctx) {
        const input = ctx.args[0] || '';
        const reason = ctx.args.slice(1).join(' ') || '';

        // 解析 NdM+K 格式
        const match = input.match(/^(\d*)[dD](\d+)([+-]\d+)?$/);
        let num, faces, modifier;

        if (match) {
            num = parseInt(match[1]) || 1;
            faces = parseInt(match[2]);
            modifier = parseInt(match[3]) || 0;
        } else if (input === '' || /^\d+$/.test(input)) {
            // /roll 或 /roll 100 → 默认骰面
            num = 1;
            faces = input ? parseInt(input) : parseInt(this.getConfig('defaultDice') || '100');
            modifier = 0;
        } else {
            return ctx.reply('格式错误！用法: /roll [NdM+K] [原因]\n例: /roll 2d6+3 攻击');
        }

        // 限制范围
        if (num < 1 || num > 100) return ctx.reply('骰子数量需在 1-100 之间');
        if (faces < 2 || faces > 1000) return ctx.reply('骰面需在 2-1000 之间');

        // 掷骰
        const rolls = [];
        for (let i = 0; i < num; i++) {
            rolls.push(Math.floor(Math.random() * faces) + 1);
        }

        const sum = rolls.reduce((a, b) => a + b, 0) + modifier;
        const modStr = modifier !== 0 ? `${modifier > 0 ? '+' : ''}${modifier}` : '';
        const reasonStr = reason ? ` (${reason})` : '';

        let result;
        if (num === 1 && modifier === 0) {
            result = `🎲 ${ctx.senderName} 掷骰${reasonStr}: d${faces} = ${rolls[0]}`;
        } else {
            result = `🎲 ${ctx.senderName} 掷骰${reasonStr}: ${num}d${faces}${modStr} = [${rolls.join(', ')}]${modStr} = ${sum}`;
        }

        return ctx.reply(result);
    }

    /**
     * /check 命令 - 属性检定 (COC 风格)
     * /check 力量 60 → 掷 d100，≤60 成功
     */
    async handleCheck(ctx) {
        const attrName = ctx.args[0];
        const targetValue = parseInt(ctx.args[1]);

        if (!attrName || isNaN(targetValue)) {
            return ctx.reply('用法: /check <属性名> <目标值>\n例: /check 力量 60');
        }

        if (targetValue < 1 || targetValue > 100) {
            return ctx.reply('目标值需在 1-100 之间');
        }

        const roll = Math.floor(Math.random() * 100) + 1;
        let level;

        if (roll === 1) {
            level = '🌟 大成功！';
        } else if (roll === 100) {
            level = '💀 大失败！';
        } else if (roll <= targetValue / 5) {
            level = '✨ 极难成功';
        } else if (roll <= targetValue / 2) {
            level = '⭐ 困难成功';
        } else if (roll <= targetValue) {
            level = '✅ 成功';
        } else {
            level = '❌ 失败';
        }

        return ctx.reply(`🎯 ${ctx.senderName} 的${attrName}检定:\nd100 = ${roll} / ${targetValue}\n结果: ${level}`);
    }
}
