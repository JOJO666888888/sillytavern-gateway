/**
 * SillyTavern 宏系统引擎
 *
 * 支持: setvar, getvar, roll, random, {{//comment}}, {{char}}, {{user}}
 *
 * 执行顺序:
 * 1. setvar (按文本顺序执行, 移除标签)
 * 2. 注释移除 {{//...}}
 * 3. roll / random (立即求值)
 * 4. getvar (替换为变量值, 支持默认值)
 * 5. {{char}} / {{user}}
 * 6. 递归解析 (最多 10 轮, 防止死循环)
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('macro-engine');
const MAX_RECURSION = 10;

// ---- 正则 ----

// setvar::name::value  (value 可含 ::, 非贪婪匹配到第一个 }})
const RE_SETVAR = /\{\{setvar::([^:]+)::([\s\S]*?)\}\}/g;
// getvar::name  或  getvar::name::default
const RE_GETVAR = /\{\{getvar::([^:}]+)(?:::([^}]*))?\}\}/g;
// roll:NdM
const RE_ROLL_NDM = /\{\{roll:(\d+)d(\d+)\}\}/gi;
// roll:dN
const RE_ROLL_DN = /\{\{roll:d(\d+)\}\}/gi;
// roll:N
const RE_ROLL_N = /\{\{roll:(\d+)\}\}/gi;
// random::a::b::c
const RE_RANDOM = /\{\{random::([\s\S]*?)\}\}/g;
// {{//comment}}  (注意: / 需转义, 否则正则字面量提前闭合)
const RE_COMMENT = /\{\{\/\/([\s\S]*?)\}\}/g;

// ---- 工具 ----

function rollDie(sides) {
    return Math.floor(Math.random() * sides) + 1;
}

function rollDice(count, sides) {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += rollDie(sides);
    return sum;
}

function pickRandom(options) {
    if (!options || options.length === 0) return '';
    return options[Math.floor(Math.random() * options.length)];
}

// ---- 引擎类 ----

export class MacroEngine {
    constructor(options = {}) {
        this.charName = options.charName || 'Assistant';
        this.userName = options.userName || 'User';
        this.variables = options.variables || new Map();
    }

    getVar(name) {
        const key = name.toLowerCase();
        return this.variables.has(key) ? this.variables.get(key) : undefined;
    }

    setVar(name, value) {
        this.variables.set(name.toLowerCase(), value);
    }

    /**
     * 处理文本, 展开所有宏
     * @param {string} text 原始文本
     * @returns {string} 展开后的文本
     */
    process(text) {
        if (!text || typeof text !== 'string') return text;

        let result = text;

        // 第 1 轮: setvar (按文本顺序执行)
        result = result.replace(RE_SETVAR, (match, name, value) => {
            this.setVar(name.trim(), value);
            return ''; // setvar 标签从文本中移除
        });

        // 第 2 轮: 移除注释
        result = result.replace(RE_COMMENT, '');

        // 第 3 轮: roll / random
        result = result.replace(RE_ROLL_NDM, (m, n, s) => String(rollDice(parseInt(n), parseInt(s))));
        result = result.replace(RE_ROLL_DN, (m, s) => String(rollDie(parseInt(s))));
        result = result.replace(RE_ROLL_N, (m, n) => String(rollDie(parseInt(n))));
        result = result.replace(RE_RANDOM, (m, content) => {
            const options = content.split('::');
            return pickRandom(options);
        });

        // 第 4-6 轮: getvar + char/user + 递归
        for (let round = 0; round < MAX_RECURSION; round++) {
            const before = result;

            // getvar 替换
            result = result.replace(RE_GETVAR, (match, name, defaultVal) => {
                const val = this.getVar(name.trim());
                if (val !== undefined) return val;
                return defaultVal !== undefined ? defaultVal : '';
            });

            // char / user
            result = result.replace(/\{\{char\}\}/gi, this.charName);
            result = result.replace(/\{\{user\}\}/gi, this.userName);

            // 如果没有变化, 结束递归
            if (result === before) break;
        }

        return result;
    }
}

// ---- 顶层函数 ----

/**
 * 一次性处理文本中的所有宏
 * @param {string} text 原始文本
 * @param {object} options { charName, userName, variables? }
 * @returns {string} 展开后的文本
 */
export function processMacros(text, options = {}) {
    const engine = new MacroEngine(options);
    return engine.process(text);
}
