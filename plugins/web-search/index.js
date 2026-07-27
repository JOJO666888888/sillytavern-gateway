/**
 * 联网搜索插件（Web Search）
 *
 * 给网关 LLM 装上一个 web_search 工具，走 runTools agent 循环：模型自己决定
 * 何时联网、搜什么词，网关执行搜索把结果回灌，模型据此作答。
 *
 *   - /search <问题>   让模型联网查资料后回答
 *
 * 搜索后端（config.provider）：
 *   - "duckduckgo"：用 DuckDuckGo Instant Answer API（免 key，覆盖有限，适合演示）
 *   - "custom"：调用你自己的搜索 API（config.searchApi.url + 可选 apiKey），
 *               约定返回 JSON 数组或 { results: [...] }，每项含 title/snippet/url 字段
 *
 * 需要 "llm" 权限（消耗网关配置的模型额度，拿不到 API key）。
 * 联网请求用 Node 18+ 内置 fetch，零额外依赖。
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';

export default class WebSearchPlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'search',
            alias: ['搜', '搜索'],
            handler: 'handleSearch',
            description: '联网搜索并由 AI 总结作答',
            usage: '/search <问题>',
        },
    ];

    get tools() {
        return [
            {
                name: 'web_search',
                description: '联网搜索网页，返回若干条标题/摘要/链接。需要实时或事实性信息时调用。',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '搜索关键词' },
                    },
                    required: ['query'],
                },
            },
        ];
    }

    async executeTool(name, args) {
        if (name !== 'web_search') return { error: `未知工具: ${name}` };
        const query = String(args?.query || '').trim();
        if (!query) return { error: '缺少 query' };
        try {
            const results = await this._search(query);
            if (!results.length) return { query, results: [], note: '未找到结果' };
            return { query, results };
        } catch (e) {
            this.logger.error(`搜索失败: ${e.message}`);
            return { query, error: `搜索失败: ${e.message}` };
        }
    }

    async handleSearch(ctx) {
        const question = ctx.args.join(' ').trim();
        if (!question) return ctx.reply('用法: /search <问题>');

        try {
            const { text, steps } = await ctx.llm.runTools(
                [
                    { role: 'system', content: this.getConfig('systemPrompt') || '你是联网助手，可用 web_search 工具查资料。' },
                    { role: 'user', content: question },
                ],
                this.tools,
                (name, args) => this.executeTool(name, args),
                { maxSteps: this.getConfig('maxSteps') || 4 },
            );
            this.logger.info(`联网搜索用了 ${steps} 轮工具`);
            return ctx.reply(text);
        } catch (e) {
            this.logger.error(`联网搜索失败: ${e.message}`);
            return ctx.reply(`抱歉，处理失败：${e.message}`);
        }
    }

    // ==================== 搜索后端 ====================

    /** 按 provider 分发到具体搜索实现，统一返回 [{title, snippet, url}] */
    async _search(query) {
        const provider = this.getConfig('provider') || 'duckduckgo';
        const max = this.getConfig('maxResults') || 5;
        const raw = provider === 'custom'
            ? await this._searchCustom(query)
            : await this._searchDuckDuckGo(query);
        return raw.slice(0, max);
    }

    /** DuckDuckGo Instant Answer API（免 key） */
    async _searchDuckDuckGo(query) {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
        const data = await this._fetchJson(url);
        const results = [];
        if (data.AbstractText) {
            results.push({ title: data.Heading || query, snippet: data.AbstractText, url: data.AbstractURL || '' });
        }
        const flatten = (topics) => {
            for (const t of topics || []) {
                if (t.Topics) { flatten(t.Topics); continue; }
                if (t.Text) results.push({ title: t.Text.split(' - ')[0], snippet: t.Text, url: t.FirstURL || '' });
            }
        };
        flatten(data.RelatedTopics);
        return results;
    }

    /** 自定义搜索 API：GET config.searchApi.url，带可选 Bearer apiKey */
    async _searchCustom(query) {
        const cfg = this.getConfig('searchApi') || {};
        if (!cfg.url) throw new Error('provider=custom 需在配置 searchApi.url 填入搜索接口地址');
        const param = cfg.queryParam || 'q';
        const sep = cfg.url.includes('?') ? '&' : '?';
        const url = `${cfg.url}${sep}${encodeURIComponent(param)}=${encodeURIComponent(query)}`;
        const headers = {};
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const data = await this._fetchJson(url, { headers });
        const arr = Array.isArray(data) ? data : (data.results || data.data || []);
        return arr.map((r) => ({
            title: r.title || r.name || '',
            snippet: r.snippet || r.description || r.content || '',
            url: r.url || r.link || '',
        }));
    }

    /** 带超时的 JSON 请求（Node18+ 内置 fetch/AbortController） */
    async _fetchJson(url, options = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
            const resp = await fetch(url, { ...options, signal: controller.signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } finally {
            clearTimeout(timer);
        }
    }
}
