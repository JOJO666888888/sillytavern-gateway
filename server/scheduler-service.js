/**
 * Scheduler Service - 插件定时任务调度器
 *
 * 消费插件通过 `static schedules = [{ cron, handler, description }]` 声明的定时任务。
 * 此前 getSchedules() 只被 getPluginInfo 展示、无人执行——AstrBot 的「定时任务」类
 * 插件因此无法移植。本模块补上执行引擎。
 *
 * 设计取舍：
 *   - 零依赖。自己实现 5 段 cron 匹配（分 时 日 月 周），够覆盖 AstrBot 插件的日常用法，
 *     避免为一个调度器引入 node-cron 及其传递依赖（本项目 deps 一直保持精简）。
 *   - 每 60s 轮询一次，按「分钟」粒度触发。够用且省心：不追求秒级精度，
 *     插件定时任务本就是分钟级（每日报告、整点提醒等）。
 *   - 同一 (job, 分钟) 只触发一次：轮询有抖动/补偿时不会重复触发。
 *   - 单个任务 handler 抛错被隔离，不影响其它任务与调度循环本身（对齐 event-pipeline 的容错）。
 *   - 时钟源可注入（options.now），便于测试；生产用真实 Date。
 */

import { createLogger } from './utils/logger.js';

const logger = createLogger('scheduler');

/** 轮询周期：60s。cron 最细粒度是分钟，轮询快于 1 分钟即可保证不漏。 */
const POLL_INTERVAL_MS = 60 * 1000;

/**
 * 解析 cron 单个字段为「命中判定函数」。
 * 支持：`*`、`*​/N`（步进）、`N`（精确）、`A,B,C`（列表）、`N-M`（区间）、`A-B/N`（区间步进）。
 * @param {string} field - 单个 cron 字段
 * @param {number} min - 该字段合法下界
 * @param {number} max - 该字段合法上界
 * @returns {(v: number) => boolean}
 */
function parseField(field, min, max) {
    // 逗号列表：任一子表达式命中即命中
    if (field.includes(',')) {
        const matchers = field.split(',').map(part => parseField(part, min, max));
        return (v) => matchers.some(m => m(v));
    }

    // 步进：base/step，base 可为 `*` 或区间 `A-B`
    let step = 1;
    let range = field;
    if (field.includes('/')) {
        const [base, stepStr] = field.split('/');
        step = parseInt(stepStr, 10);
        if (!Number.isInteger(step) || step <= 0) {
            throw new Error(`非法 cron 步进: ${field}`);
        }
        range = base;
    }

    let lo = min;
    let hi = max;
    if (range === '*' || range === '') {
        // 保持全域
    } else if (range.includes('-')) {
        const [a, b] = range.split('-').map(n => parseInt(n, 10));
        if (!Number.isInteger(a) || !Number.isInteger(b)) {
            throw new Error(`非法 cron 区间: ${field}`);
        }
        lo = a;
        hi = b;
    } else {
        const n = parseInt(range, 10);
        if (!Number.isInteger(n)) {
            throw new Error(`非法 cron 字段: ${field}`);
        }
        lo = n;
        hi = n;
    }

    if (lo < min || hi > max || lo > hi) {
        throw new Error(`cron 字段越界: ${field}（允许 ${min}-${max}）`);
    }

    return (v) => v >= lo && v <= hi && ((v - lo) % step === 0);
}

/**
 * 判断给定时刻是否命中 cron 表达式。
 * 5 段：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6，0=周日)。
 * 周字段同时接受 7 作为周日（与常见 cron 实现一致）。
 * @param {string} expr - cron 表达式
 * @param {Date} date - 待判定时刻
 * @returns {boolean}
 */
export function cronMatches(expr, date) {
    const parts = String(expr).trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`cron 表达式必须为 5 段（分 时 日 月 周），收到: ${JSON.stringify(expr)}`);
    }

    const [minF, hourF, domF, monF, dowF] = parts;
    const minute = parseField(minF, 0, 59);
    const hour = parseField(hourF, 0, 23);
    const dom = parseField(domF, 1, 31);
    const mon = parseField(monF, 1, 12);
    // 周字段：允许 0-7（7 与 0 均表示周日），判定时把 7 归一为 0
    const dowRaw = parseField(dowF, 0, 7);
    const dowMatch = (d) => dowRaw(d) || dowRaw(d === 0 ? 7 : d);

    const dowStar = dowF === '*';
    const domStar = domF === '*';

    const mMatch = minute(date.getMinutes());
    const hMatch = hour(date.getHours());
    const monMatch = mon(date.getMonth() + 1);
    const domHit = dom(date.getDate());
    const dowHit = dowMatch(date.getDay());

    if (!mMatch || !hMatch || !monMatch) return false;

    // cron 惯例：日、周都非 `*` 时取「或」（任一命中即触发）；否则取「与」。
    if (!domStar && !dowStar) {
        return domHit || dowHit;
    }
    return domHit && dowHit;
}

/**
 * 定时任务调度器。
 */
export class SchedulerService {
    /**
     * @param {object} [options]
     * @param {() => Date} [options.now] - 时钟源（测试可注入）；默认 () => new Date()
     * @param {number} [options.pollIntervalMs] - 轮询周期，默认 60s
     */
    constructor(options = {}) {
        this._now = options.now || (() => new Date());
        this._pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
        /** @type {Array<{pluginName, cron, description, run, _lastFireKey}>} */
        this.jobs = [];
        this._timer = null;
    }

    /**
     * 注册一个插件的所有定时任务。
     * @param {object} spec
     * @param {string} spec.pluginName
     * @param {Array<{cron: string, handler: string, description?: string}>} spec.schedules
     * @param {(schedule: object) => Promise<any>} spec.run - 执行单个 schedule 的回调（由 PluginManager 提供，负责构造 ctx 并调用插件方法）
     */
    registerPlugin({ pluginName, schedules, run }) {
        if (!Array.isArray(schedules) || schedules.length === 0) return;
        for (const schedule of schedules) {
            if (!schedule?.cron || !schedule?.handler) {
                logger.warn(`插件 ${pluginName} 的定时任务缺少 cron/handler，已跳过: ${JSON.stringify(schedule)}`);
                continue;
            }
            // 注册即校验 cron，非法表达式尽早暴露而非到触发时才炸
            try {
                cronMatches(schedule.cron, this._now());
            } catch (e) {
                logger.error(`插件 ${pluginName} 定时任务 cron 非法（${schedule.cron}）已跳过: ${e.message}`);
                continue;
            }
            this.jobs.push({
                pluginName,
                cron: schedule.cron,
                handler: schedule.handler,
                description: schedule.description || '',
                run: () => run(schedule),
                _lastFireKey: null,
            });
            logger.debug(`已注册定时任务: ${pluginName} [${schedule.cron}] -> ${schedule.handler}`);
        }
    }

    /**
     * 注销某插件的全部定时任务（禁用/卸载/重载时调用）。
     * @param {string} pluginName
     * @returns {number} 被移除的任务数
     */
    unregisterByPlugin(pluginName) {
        const before = this.jobs.length;
        this.jobs = this.jobs.filter(j => j.pluginName !== pluginName);
        return before - this.jobs.length;
    }

    /**
     * 对某一时刻执行所有命中的任务（轮询循环的核心；测试可直接调用）。
     * @param {Date} [date] - 判定时刻，默认取时钟源当前值
     * @returns {Promise<number>} 本次触发的任务数
     */
    async tick(date) {
        const at = date || this._now();
        // 以「年-月-日-时-分」为去重键：同一分钟内多次 tick 只触发一次
        const fireKey = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}-${at.getMinutes()}`;
        let fired = 0;

        for (const job of this.jobs) {
            let hit = false;
            try {
                hit = cronMatches(job.cron, at);
            } catch (e) {
                // 理论上注册时已校验，这里兜底
                logger.error(`定时任务 cron 判定出错（${job.pluginName} ${job.cron}）: ${e.message}`);
                continue;
            }
            if (!hit) continue;
            if (job._lastFireKey === fireKey) continue; // 本分钟已触发
            job._lastFireKey = fireKey;
            fired++;

            // 单任务错误隔离：不阻塞其它任务，也不打断调度循环
            try {
                await job.run();
                logger.debug(`定时任务已执行: ${job.pluginName} [${job.cron}] -> ${job.handler}`);
            } catch (e) {
                logger.error(`定时任务执行失败（${job.pluginName} -> ${job.handler}）: ${e.message}`);
            }
        }
        return fired;
    }

    /** 启动轮询循环。已启动则幂等返回。 */
    start() {
        if (this._timer) return;
        // 不在 start 时立即 tick：避免启动瞬间正好落在整分钟而误触发一批任务。
        this._timer = setInterval(() => {
            this.tick().catch(e => logger.error(`调度轮询异常: ${e.message}`));
        }, this._pollIntervalMs);
        // 允许进程在仅剩此定时器时退出（不阻塞 SIGINT/SIGTERM 后的自然退出）
        if (typeof this._timer.unref === 'function') this._timer.unref();
        logger.info(`定时任务调度器已启动（轮询 ${this._pollIntervalMs / 1000}s，共 ${this.jobs.length} 个任务）`);
    }

    /** 停止轮询循环。 */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            logger.info('定时任务调度器已停止');
        }
    }
}

export default { SchedulerService, cronMatches };
