/**
 * Agent 前端（模块 B）独立页面逻辑
 *
 * 功能：
 *   - 连接配置（网关地址 + 鉴权 token，localStorage 持久化）
 *   - Agent 设置：三个折叠分组（Agent 引擎 / Agent 前端 / IM 集成只读提示），
 *     引擎 + 前端 URL 一次性提交 /api/plugins/agent-framework/config，
 *     前端 URL 存 localStorage + 插件 config agentFrontendUrl
 *   - Agent 前端 URL 校验（前端格式校验 + 后端 POST /api/agent-frontend/validate 可达性探测）
 *   - Agent 剧场：SSE 订阅 /api/agent-theatre/stream（agent_result / token_delta /
 *     state / events），输入走 /api/agent-theatre/input，Profile 管理走 /api/agents*
 *   - AI 助手（自然语言修改 Profile）：/api/agent-theatre/ai-modify/* 系列端点
 *   - 使用说明 Modal（自实现）+ 首次引导（localStorage 标记 gateway_agent_guide_done）
 *
 * 命名约定：内部状态 agentSettings / agentFrontend，DOM id 以 agent_* 为前缀，
 * 不使用旧 gateway_agent_* / gateway_theatre_* 命名。不依赖 ST / jQuery / toastr。
 */
(function () {
    'use strict';

    // ==================== 常量 ====================

    var DEFAULT_GATEWAY = 'http://127.0.0.1:3210';
    var DEFAULT_FRONTEND_URL = 'http://127.0.0.1:3210/agent';
    var LS_URL = 'gateway_agent_url';
    var LS_TOKEN = 'gateway_agent_token';
    var LS_FRONTEND_URL = 'gateway_agent_frontend_url';
    var LS_GUIDE_DONE = 'gateway_agent_guide_done';
    var LS_CHAT_PREFIX = 'agent_chat_history_';

    // ==================== 工具函数 ====================

    function $(id) { return document.getElementById(id); }

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 自实现 toast（页面无 toastr 依赖） */
    var agentToast = {
        show: function (type, msg) {
            var container = $('agent_toast_container');
            if (!container) return;
            var el = document.createElement('div');
            el.className = 'agent-toast ' + type;
            el.textContent = msg;
            container.appendChild(el);
            setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 250); }, 3600);
        },
        success: function (m) { this.show('success', m); },
        error: function (m) { this.show('error', m); },
        warning: function (m) { this.show('warning', m); },
        info: function (m) { this.show('info', m); },
    };

    /** 带鉴权的 API 请求；非 2xx 抛 Error */
    function agentFetch(endpoint, options) {
        options = options || {};
        var url = agentSettings.url.replace(/\/+$/, '') + endpoint;
        var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
        if (agentSettings.token) headers['X-Gateway-Token'] = agentSettings.token;
        return fetch(url, Object.assign({}, options, { headers: headers }))
            .then(function (resp) {
                if (!resp.ok) {
                    return resp.json().catch(function () { return {}; }).then(function (body) {
                        throw new Error(body.error || ('HTTP ' + resp.status));
                    });
                }
                return resp.json();
            });
    }

    // ==================== 连接配置 ====================

    var agentSettings = {
        url: DEFAULT_GATEWAY,
        token: '',
        engine: {},          // agent-framework config（含 agentFrontendUrl）
        frontendUrl: DEFAULT_FRONTEND_URL,
    };

    function loadConnection() {
        var savedUrl = (localStorage.getItem(LS_URL) || '').trim();
        agentSettings.url = savedUrl || DEFAULT_GATEWAY;
        agentSettings.token = (localStorage.getItem(LS_TOKEN) || '').trim();
        var urlEl = $('agent_conn_url');
        var tokenEl = $('agent_conn_token');
        if (urlEl) urlEl.value = agentSettings.url;
        if (tokenEl) tokenEl.value = agentSettings.token;
    }

    function saveConnection() {
        var urlEl = $('agent_conn_url');
        var tokenEl = $('agent_conn_token');
        var url = (urlEl && urlEl.value || DEFAULT_GATEWAY).trim();
        if (!/^https?:\/\//i.test(url)) {
            agentToast.error('网关地址需以 http:// 或 https:// 开头');
            if (urlEl) urlEl.classList.add('agent-input-invalid');
            return;
        }
        if (urlEl) urlEl.classList.remove('agent-input-invalid');
        agentSettings.url = url.replace(/\/+$/, '') || DEFAULT_GATEWAY;
        agentSettings.token = (tokenEl && tokenEl.value || '').trim();
        try {
            localStorage.setItem(LS_URL, agentSettings.url);
            localStorage.setItem(LS_TOKEN, agentSettings.token);
        } catch (_) { /* 隐私模式可能抛异常，静默 */ }
        agentToast.success('连接配置已保存');
        // 连接变化后刷新设置与剧场
        loadAllSettings().catch(function () { /* 已内部提示 */ });
        theatreReconnect();
    }

    // ==================== Agent 设置：加载 ====================

    /** 拉取引擎配置（含 agentFrontendUrl）并填充表单 */
    function loadAllSettings() {
        var statusEl = $('agent_conn_status');
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = '正在从网关加载设置...'; }
        return agentFetch('/api/plugins/agent-framework/config')
            .then(function (data) { return data.config || {}; })
            .then(function (config) {
                agentSettings.engine = config || {};
                fillEngineForm(agentSettings.engine);
                resolveFrontendUrl();
                if (statusEl) { statusEl.style.display = 'none'; }
            })
            .catch(function (e) {
                agentToast.warning('加载引擎配置失败: ' + e.message);
                if (statusEl) { statusEl.style.display = 'none'; }
            });
    }

    function fillEngineForm(config) {
        setVal('agent_engine_defaultMaxSteps', num(config.defaultMaxSteps, 10));
        setVal('agent_engine_summaryInterval', num(config.summaryInterval, 10));
        setVal('agent_engine_memoryRetriever', config.memoryRetriever || 'inverted');
        setVal('agent_engine_embedderMode', config.embedderMode || 'local');
        setVal('agent_engine_embedderBaseUrl', config.embedderBaseUrl || '');
        setVal('agent_engine_embedderModel', config.embedderModel || '');
        setVal('agent_engine_embedderApiKey', config.embedderApiKey || '');
    }

    /** 前端 URL 解析优先级：localStorage > 插件 config.agentFrontendUrl > 默认 */
    function resolveFrontendUrl() {
        var ls = '';
        try { ls = (localStorage.getItem(LS_FRONTEND_URL) || '').trim(); } catch (_) { /* 静默 */ }
        var url = ls
            || (typeof agentSettings.engine.agentFrontendUrl === 'string' && agentSettings.engine.agentFrontendUrl.trim())
            || DEFAULT_FRONTEND_URL;
        agentSettings.frontendUrl = url;
        setVal('agent_frontend_url', url);
    }

    function setVal(id, value) {
        var el = $(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value == null ? '' : String(value);
    }

    function num(v, def) { return (v == null || v === '' || isNaN(Number(v))) ? def : Number(v); }

    // ==================== Agent 设置：保存 ====================

    function collectEngine() {
        return {
            defaultMaxSteps: num($('agent_engine_defaultMaxSteps').value, 10),
            summaryInterval: num($('agent_engine_summaryInterval').value, 10),
            memoryRetriever: $('agent_engine_memoryRetriever').value || 'inverted',
            embedderMode: $('agent_engine_embedderMode').value || 'local',
            embedderBaseUrl: ($('agent_engine_embedderBaseUrl').value || '').trim(),
            embedderModel: ($('agent_engine_embedderModel').value || '').trim(),
            embedderApiKey: ($('agent_engine_embedderApiKey').value || '').trim(),
        };
    }

    /** 收集并校验前端 URL；空串视为留空（回退内置 /agent），非法返回 { error } */
    function collectFrontendUrl() {
        var input = $('agent_frontend_url');
        var raw = (input && input.value || '').trim();
        if (!raw) return { url: '', error: null };
        var result = validateFrontendUrlClient(raw);
        if (!result.valid) return { url: null, error: result.error };
        return { url: result.url, error: null };
    }

    /**
     * 统一保存（需求 3）：引擎参数 + 前端 URL 一次性 POST 到 /api/plugins/agent-framework/config。
     * 保存前对 URL 做格式校验（^https?://），非法则阻止保存并提示。
     */
    function saveAllSettings() {
        var engine = collectEngine();
        var fe = collectFrontendUrl();
        if (fe.error) {
            showFrontendError(fe.error);
            agentToast.error(fe.error);
            return;
        }
        showFrontendError(null);
        var config = Object.assign({}, engine, { agentFrontendUrl: fe.url });
        return agentFetch('/api/plugins/agent-framework/config', {
            method: 'POST',
            body: JSON.stringify(config),
        }).then(function () {
            agentSettings.engine = config;
            if (fe.url) {
                try { localStorage.setItem(LS_FRONTEND_URL, fe.url); } catch (_) { /* 静默 */ }
                agentSettings.frontendUrl = fe.url;
            }
            agentToast.success('Agent 设置已保存');
        }).catch(function (e) {
            agentToast.error('保存失败：' + e.message);
        });
    }

    // ==================== 前端 URL：校验 / 访问 / 保存 ====================

    /** 前端格式校验（纯函数，与后端规则一致） */
    function validateFrontendUrlClient(raw) {
        if (typeof raw !== 'string' || !raw.trim()) {
            return { valid: false, error: 'URL 不能为空，请填写 Agent 前端地址' };
        }
        var url = raw.trim();
        if (!/^https?:\/\//i.test(url)) {
            return { valid: false, error: 'URL 需以 http:// 或 https:// 开头（例如 http://127.0.0.1:3210/agent）' };
        }
        var parsed;
        try { parsed = new URL(url); } catch (_) {
            return { valid: false, error: 'URL 格式无效，请检查是否包含非法字符或主机名不完整' };
        }
        if (!parsed.hostname) return { valid: false, error: 'URL 缺少主机名（host）' };
        if (/\s/.test(parsed.hostname) || /\s/.test(parsed.host)) return { valid: false, error: 'URL 主机名不能包含空格' };
        if (parsed.port) {
            var port = Number(parsed.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                return { valid: false, error: '端口 ' + parsed.port + ' 非法，端口需在 1-65535 之间' };
            }
        }
        return { valid: true, url: url };
    }

    function showFrontendError(msg) {
        var el = $('agent_frontend_error');
        var input = $('agent_frontend_url');
        if (msg) {
            if (el) { el.textContent = msg; el.style.display = 'block'; }
            if (input) input.classList.add('agent-input-invalid');
        } else {
            if (el) el.style.display = 'none';
            if (input) input.classList.remove('agent-input-invalid');
        }
    }

    function openFrontend() {
        var input = $('agent_frontend_url');
        var raw = (input && input.value || '').trim();
        if (!raw) {
            // 留空：使用内置 /agent 页面（拼网关地址）
            var base = (agentSettings.url || DEFAULT_GATEWAY).replace(/\/+$/, '');
            window.open(base + '/agent', '_blank');
            return;
        }
        var result = validateFrontendUrlClient(raw);
        if (!result.valid) {
            showFrontendError(result.error);
            agentToast.error(result.error);
            return;
        }
        showFrontendError(null);
        window.open(result.url, '_blank');
    }

    function validateFrontendRemote() {
        var result = validateFrontendUrlClient($('agent_frontend_url').value);
        if (!result.valid) {
            showFrontendError(result.error);
            agentToast.error(result.error);
            return;
        }
        showFrontendError(null);
        var btn = $('agent_frontend_validate');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 验证中';
        agentFetch('/api/agent-frontend/validate', {
            method: 'POST',
            body: JSON.stringify({ url: result.url }),
        }).then(function (data) {
            if (data && data.ok === true) {
                // ok:true 表示可达（2xx/3xx 正常，4xx 视为页面存在即可访问，status 标记）
                var msg = 'URL 有效（HTTP ' + (data.status || 200) + '）';
                if (data.status >= 400) msg = 'URL 有效（页面存在，HTTP ' + data.status + '）';
                agentToast.success(msg + (data.warning ? '；' + data.warning : ''));
            } else {
                showFrontendError((data && data.error) || 'URL 校验失败');
                agentToast.error((data && data.error) || 'URL 校验失败');
            }
        }).catch(function (e) {
            agentToast.error('验证失败（网关不可达或 Token 未配置）：' + e.message);
        }).finally(function () {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> 验证';
        });
    }

    function saveFrontend() {
        // 已并入 saveAllSettings（统一保存：引擎 + 前端 URL 一次性提交）。
        // 保留为空壳并绑定到按钮，防止旧版 HTML 残留按钮失效。
        return saveAllSettings();
    }

    // ==================== 折叠面板 ====================

    function bindCollapsibles() {
        var toggles = document.querySelectorAll('.gateway-collapse-toggle');
        for (var i = 0; i < toggles.length; i++) {
            toggles[i].addEventListener('click', function () {
                var targetId = this.getAttribute('data-toggle');
                var body = $(targetId);
                var arrow = this.querySelector('.gateway-collapse-arrow');
                if (!body) return;
                var visible = body.style.display !== 'none';
                body.style.display = visible ? 'none' : 'block';
                if (arrow) arrow.classList.toggle('expanded', !visible);
            });
        }
    }

    // ==================== 使用说明 / 帮助 Modal ====================

    var HELP_TEXTS = {
        'connection': '<h4>连接配置</h4>' +
            '<p>填写网关服务地址（默认 <code>http://127.0.0.1:3210</code>）与鉴权 Token（网关启动时控制台会明文打印；若已关闭鉴权可留空）。' +
            '配置保存在浏览器 localStorage，页面内所有 API 请求自动携带 <code>X-Gateway-Token</code>。</p>',
        'agent-settings': '<h4>Agent 设置</h4>' +
            '<p>集中管理 Agent 相关配置，共三个分组：</p>' +
            '<ul><li><b>Agent 引擎</b>：agent-framework 插件参数（步数上限、摘要、记忆检索、embedding 等）；</li>' +
            '<li><b>Agent 前端</b>：自定义 Agent 前端 URL（验证 / 访问）；</li>' +
            '<li><b>IM 集成</b>：agent-rp 命令速查（只读提示）。</li></ul>' +
            '<p>「保存设置」会把「Agent 引擎」与「Agent 前端 URL」一次性提交到 agent-framework 插件配置。</p>',
        'agent-engine': '<h4>Agent 引擎（agent-framework）</h4>' +
            '<ul>' +
            '<li><code>defaultMaxSteps</code>：Agent 默认最大工具调用步数（1-50）；</li>' +
            '<li><code>summaryInterval</code>：每 N 轮自动生成剧情摘要写入记忆（0=禁用）；</li>' +
            '<li><code>memoryRetriever</code>：记忆检索引擎，inverted=倒排索引（零依赖），embedding=嵌入向量；</li>' +
            '<li><code>embedderMode</code>：向量生成方式，local=内置字符 n-gram（离线可用），api=外部 /embeddings 端点；</li>' +
            '<li><code>embedderBaseUrl / embedderModel / embedderApiKey</code>：api 模式的 OpenAI 兼容端点配置（key 留空回退环境变量 <code>AGENT_EMBEDDER_API_KEY</code>）。</li>' +
            '</ul>',
        'im-integration': '<h4>IM 集成（agent-rp）</h4>' +
            '<p>agent-rp 把 Agent 运行结果渲染为 IM 富文本（正文分段 + 选项按钮 + 实时状态图），支持群聊多 Bot 协同。</p>' +
            '<p>在聊天中发送 <code>/rp start</code> 启动 RP 会话，<code>/rp bindbot &lt;botId&gt; &lt;Profile&gt;</code> 绑定多 Bot。本分组只读展示命令速查，配置保存在 agent-rp 插件，不在此落库。</p>',
        'agent-frontend': '<h4>Agent 前端 URL</h4>' +
            '<p>指定 Agent 前端的访问地址，默认 <code>http://127.0.0.1:3210/agent</code>（本页面）。' +
            '可改为部署到公网的镜像地址。「访问」在新标签打开（留空时使用内置 /agent 页面）；「验证」先做格式校验，再由网关后端探测可达性。</p>' +
            '<p>URL 必须以 <code>http://</code> 或 <code>https://</code> 开头，主机名不能含空格，可选端口需在 1-65535 之间。</p>',
        'theatre': '<h4>Agent 剧场</h4>' +
            '<p>与 Agent 引擎实时交互的工作台：</p>' +
            '<ul>' +
            '<li><b>工具栏</b>：选择 Profile、文风、视角（同步到 Profile YAML 的 <code>viewMode</code> 字段）、会话标识；</li>' +
            '<li><b>正文流</b>：SSE 实时流式显示 Agent 输出与选项；</li>' +
            '<li><b>状态面板 / 时间线</b>：展示当前场景状态与工具调用等事件；</li>' +
            '<li><b>配置侧栏</b>：Profile YAML 编辑后「保存热重载」即时生效，AI 助手可用自然语言修改配置。</li>' +
            '</ul>',
    };

    var GUIDE_HTML = '<h4>欢迎使用 Agent 前端</h4>' +
        '<p>这是多平台网关的 <b>Agent 专用独立页面</b>，不依赖 SillyTavern，包含「Agent 设置」与「Agent 剧场」两大区域。</p>' +
        '<h4>三步上手</h4>' +
        '<ol>' +
        '<li><b>配置连接</b>：在顶部「连接配置」填入网关地址与鉴权 Token，点击「保存连接」；</li>' +
        '<li><b>确认设置</b>：展开「Agent 设置」，按需调整引擎 / 前端配置并点击「保存设置」；</li>' +
        '<li><b>开始剧场</b>：展开「Agent 剧场」，选择 Profile，输入消息（或点击选项）即可触发 Agent 运行，正文实时流式显示。</li>' +
        '</ol>' +
        '<p>各分组标题旁的 <i class="fa-solid fa-circle-question"></i> 图标可查看对应说明。</p>';

    function showModal(title, html) {
        var titleEl = $('agent_modal_title');
        var bodyEl = $('agent_modal_body');
        var backdrop = $('agent_modal_backdrop');
        if (titleEl) titleEl.textContent = title;
        if (bodyEl) bodyEl.innerHTML = html;
        if (backdrop) backdrop.style.display = 'flex';
    }

    function closeModal() {
        var backdrop = $('agent_modal_backdrop');
        if (backdrop) backdrop.style.display = 'none';
        // 首次引导：关闭 modal 即标记完成并移除高亮
        if (!localStorage.getItem(LS_GUIDE_DONE)) {
            try { localStorage.setItem(LS_GUIDE_DONE, '1'); } catch (_) { /* 静默 */ }
        }
        var openBtn = $('agent_frontend_open');
        if (openBtn) openBtn.classList.remove('agent-highlight');
    }

    function bindModalEvents() {
        var closeBtn = $('agent_modal_close');
        var closeX = $('agent_modal_close_x');
        var backdrop = $('agent_modal_backdrop');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (closeX) closeX.addEventListener('click', closeModal);
        if (backdrop) backdrop.addEventListener('click', function (e) {
            if (e.target === backdrop) closeModal();
        });
        // 使用说明按钮
        var guideBtn = $('agent_guide_btn');
        if (guideBtn) guideBtn.addEventListener('click', function () {
            showModal('使用说明', GUIDE_HTML);
        });
        // "不再提示"：勾选即写入 gateway_agent_guide_done，之后不再自动弹出
        var nodisclaim = $('agent_modal_nodisclaim');
        if (nodisclaim) nodisclaim.addEventListener('change', function () {
            if (nodisclaim.checked) {
                try { localStorage.setItem(LS_GUIDE_DONE, '1'); } catch (_) { /* 静默 */ }
                agentToast.success('已开启不再自动弹出使用说明');
            }
        });
        // 帮助图标（阻止冒泡，避免误触发所在折叠面板）
        var icons = document.querySelectorAll('.agent-help-icon');
        for (var i = 0; i < icons.length; i++) {
            icons[i].addEventListener('click', function (e) {
                e.stopPropagation();
                var key = this.getAttribute('data-help');
                var html = HELP_TEXTS[key] || '<p>' + esc(key) + '</p>';
                showModal('说明', html);
            });
        }
    }

    function runFirstGuide() {
        var done = false;
        try { done = localStorage.getItem(LS_GUIDE_DONE) === '1'; } catch (_) { /* 静默 */ }
        if (done) return;
        var openBtn = $('agent_frontend_open');
        if (openBtn) openBtn.classList.add('agent-highlight');
        showModal('使用说明', GUIDE_HTML);
    }

    // ==================== Agent 剧场：状态 ====================

    var theatre = {
        eventSource: null,
        connected: false,
        currentRunId: null,
        lastResult: null,
        timelineEvents: [],
        profile: 'default-rp',
        session: 'native:default',
        character: '',
        worldbook: '',
        // P2: run 生命周期状态机：idle | running | aborting | aborted | completed | error
        // 由 SSE run_state 事件驱动（server/index.js 广播）
        runState: 'idle',
    };

    var streaming = { runId: null, el: null };

    /** 滚动跟随开关：距底部 <80px 时自动跟随新内容，用户上翻阅读时暂停 */
    var autoScroll = true;

    function gatewayUrl() { return agentSettings.url; }
    function gatewayToken() { return agentSettings.token; }

    function showToast(type, msg) { agentToast[type] ? agentToast[type](msg) : agentToast.show(type, msg); }

    // ==================== Agent 剧场：SSE ====================

    function connectStream() {
        if (theatre.eventSource) {
            try { theatre.eventSource.close(); } catch (_) { /* ignore */ }
            theatre.eventSource = null;
        }
        var sessionKey = theatre.session || 'native:default';
        // EventSource 无法设置自定义 header，token 通过 query 传递（后端中间件支持 GET query token）
        var url = gatewayUrl() + '/api/agent-theatre/stream?session=' + encodeURIComponent(sessionKey);
        var token = gatewayToken();
        if (token) url += '&token=' + encodeURIComponent(token);
        var es;
        try {
            es = new EventSource(url);
        } catch (e) {
            setTheatreStatus(false, 'SSE 不支持');
            return;
        }
        theatre.eventSource = es;

        es.addEventListener('open', function () { setTheatreStatus(true, '已连接'); });

        es.addEventListener('agent_result', function (ev) {
            try { handleAgentResult(JSON.parse(ev.data)); } catch (e) { console.warn('[agent-frontend] agent_result 解析失败', e); }
        });

        es.addEventListener('agent_event', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleAgentEvent(data.event);
            } catch (e) { console.warn('[agent-frontend] agent_event 解析失败', e); }
        });

        es.addEventListener('state', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                renderStatePanel(data.state);
            } catch (e) { console.warn('[agent-frontend] state 解析失败', e); }
        });

        es.addEventListener('token_delta', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleTokenDelta(data);
            } catch (e) { console.warn('[agent-frontend] token_delta 解析失败', e); }
        });

        // P2: run 生命周期状态（running / aborting / aborted / completed / error）
        es.addEventListener('run_state', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleRunState(data);
            } catch (e) { console.warn('[agent-frontend] run_state 解析失败', e); }
        });

        es.addEventListener('heartbeat', function () { /* 心跳，无需处理 */ });

        es.addEventListener('error', function () {
            setTheatreStatus(false, '连接断开，3s 后重连');
        });
    }

    function setTheatreStatus(connected, msg) {
        theatre.connected = connected;
        var badge = $('agent_theatre_status');
        if (badge) {
            badge.textContent = msg || (connected ? '已连接' : '未连接');
            badge.className = 'gateway-status-badge ' + (connected ? 'connected' : 'disconnected');
        }
        var stateBadge = $('agent_theatre_state');
        if (stateBadge) {
            stateBadge.textContent = connected ? '在线' : '离线';
            stateBadge.className = 'agent-header-state ' + (connected ? 'online' : 'offline');
        }
    }

    // ==================== Agent 剧场：正文 / 事件 ====================

    // P2: run 生命周期状态机处理（SSE run_state 事件驱动 UI）
    function handleRunState(data) {
        if (!data || !data.state) return;
        theatre.runState = data.state;
        if (data.runId) theatre.currentRunId = data.runId;
        renderRunState();
    }

    // P2: 按 runState 渲染停止按钮 / 发送按钮 / 状态徽标（适配 ST 圆形图标按钮）
    function renderRunState() {
        var stopBtn = $('agent_theatre_stop');
        var sendBtn = $('agent_theatre_send');
        var badge = $('agent_theatre_status');
        var restoreStopBtn = function () {
            if (!stopBtn) return;
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
            stopBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
        };
        switch (theatre.runState) {
            case 'running':
                if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = false; stopBtn.innerHTML = '<i class="fa-solid fa-stop"></i>'; }
                if (sendBtn) sendBtn.disabled = true;
                if (badge) { badge.textContent = '生成中...'; badge.className = 'gateway-status-badge connected'; }
                break;
            case 'aborting':
                if (stopBtn) { stopBtn.style.display = ''; stopBtn.disabled = true; stopBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
                if (sendBtn) sendBtn.disabled = true;
                if (badge) { badge.textContent = '正在停止...'; badge.className = 'gateway-status-badge connected'; }
                break;
            case 'aborted':
                restoreStopBtn();
                if (sendBtn) sendBtn.disabled = false;
                if (badge) { badge.textContent = '已停止'; badge.className = 'gateway-status-badge disconnected'; }
                break;
            case 'completed':
            case 'error':
                restoreStopBtn();
                if (sendBtn) sendBtn.disabled = false;
                if (badge && theatre.connected) { badge.textContent = '已连接'; badge.className = 'gateway-status-badge connected'; }
                break;
            default: // idle
                restoreStopBtn();
                if (sendBtn) sendBtn.disabled = false;
        }
    }

    function handleTokenDelta(data) {
        if (!data || !data.delta) return;
        // 「实时流式显示」未勾选时跳过增量，仅等 agent_result 落地
        var streamEl = $('agent_theatre_stream_stream');
        if (streamEl && !streamEl.checked) return;
        var el = $('agent_theatre_narrative');
        if (!el) return;
        if (data.runId !== streaming.runId) {
            streaming.runId = data.runId;
            if (streaming.el && streaming.el.parentNode) streaming.el.remove();
            streaming.el = null;
        }
        // 清除「思考中」占位光标
        var cursor = $('agent_theatre_cursor');
        if (cursor) cursor.remove();
        if (!streaming.el) {
            var empty = el.querySelector('.gateway-empty-hint');
            if (empty) empty.remove();
            streaming.el = createAssistantMsg(data.delta, true);
            el.appendChild(streaming.el);
        } else {
            var bubble = streaming.el.querySelector('.agent-chat-bubble');
            if (bubble) {
                var c = bubble.querySelector('.agent-chat-cursor');
                if (c) c.remove();
                bubble.textContent += data.delta;
                appendCursor(bubble);
            }
        }
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    function clearStreamingPreview() {
        if (streaming.el && streaming.el.parentNode) streaming.el.remove();
        streaming.el = null;
        streaming.runId = null;
    }

    /** 移除当前流式/占位 AI 消息与思考光标（发送失败 / run 未启动时恢复干净状态） */
    function removePendingPlaceholder() {
        if (streaming.el && streaming.el.parentNode) streaming.el.remove();
        streaming.el = null;
        streaming.runId = null;
        var c = $('agent_theatre_cursor');
        if (c) c.remove();
    }

    function handleAgentResult(payload) {
        if (!payload) return;
        theatre.currentRunId = payload.runId;
        theatre.lastResult = payload.result;
        // P2: 兜底——run 结果已落地但未收到 run_state 终态（如 SSE 短暂断线），
        // 直接把状态机推进到 completed，恢复 UI
        if (theatre.runState === 'running' || theatre.runState === 'aborting') {
            theatre.runState = 'completed';
            renderRunState();
        }
        var text = payload.text || '';
        clearStreamingPreview();
        appendNarrative(text);
        renderOptions(payload.result ? payload.result.options : []);
        if (payload.result && payload.result.state) renderStatePanel(payload.result.state);
        var turnInfo = $('agent_theatre_turn_info');
        if (turnInfo && payload.result && payload.result.meta) {
            turnInfo.textContent = '轮次 ' + (payload.result.meta.turn || '?') +
                ' · 视角 ' + (payload.result.meta.viewMode || '?') +
                ' · 文风 ' + (payload.result.meta.style || '-');
        }
        if (payload.runId) fetchTimeline(payload.runId);
    }

    function handleAgentEvent(event) {
        if (!event) return;
        theatre.timelineEvents.push(event);
        appendTimelineItem(event);
        if ($('agent_theatre_show_events') && $('agent_theatre_show_events').checked) {
            appendInlineEvent(event);
        }
    }

    function appendNarrative(text) {
        if (!text) return;
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        var msg = createAssistantMsg(text, false);
        el.appendChild(msg);
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    function clearNarrativeDom() {
        var el = $('agent_theatre_narrative');
        if (el) el.innerHTML = '<div class="gateway-empty-hint">已清空，输入消息或点击选项重新开始</div>';
        var optEl = $('agent_theatre_options');
        if (optEl) optEl.innerHTML = '<div class="gateway-empty-hint">（选项将在 Agent 输出后出现）</div>';
        var tlEl = $('agent_theatre_timeline');
        if (tlEl) tlEl.innerHTML = '<div class="gateway-empty-hint">（事件流将在此显示）</div>';
        var inlineEl = $('agent_theatre_events_inline');
        if (inlineEl) { inlineEl.innerHTML = ''; inlineEl.style.display = 'none'; }
        theatre.timelineEvents = [];
        clearStreamingPreview();
    }

    function clearNarrative() {
        clearNarrativeDom();
        // 同时清除当前角色卡的本地聊天记录
        try { localStorage.removeItem(chatHistoryKey()); } catch (_) { /* 静默 */ }
    }

    // ==================== Agent 剧场：选项 ====================

    function renderOptions(options) {
        var el = $('agent_theatre_options');
        if (!el) return;
        if (!options || options.length === 0) {
            el.innerHTML = '<div class="gateway-empty-hint">（本轮无选项，可直接输入）</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < options.length; i++) {
            var o = options[i];
            html += '<button class="menu_button gateway-theatre-option-btn agent-chat-option-btn" ' +
                'data-callback="' + esc(o.callbackId || '') + '" ' +
                'data-text="' + esc(o.text || '') + '" ' +
                'title="点击提交此选项">' +
                '<b>' + esc(o.label || ('选项' + (i + 1))) + '</b>: ' + esc(o.text || '') +
                '</button>';
        }
        el.innerHTML = html;
    }

    // ==================== Agent 剧场：状态面板 ====================

    function renderStatePanel(stateObj) {
        var el = $('agent_theatre_state_panel');
        if (!el) return;
        if (!stateObj || !stateObj.visible) {
            el.innerHTML = '<div class="gateway-empty-hint">（无状态数据）</div>';
            return;
        }
        var v = stateObj.visible || {};
        var html = '';
        if (v.time || v.location) {
            html += '<div class="gateway-theatre-state-row">';
            if (v.time) html += '<span class="gateway-theatre-state-tag">🕐 ' + esc(v.time) + '</span>';
            if (v.location) html += '<span class="gateway-theatre-state-tag">📍 ' + esc(v.location) + '</span>';
            html += '</div>';
        }
        if (Array.isArray(v.actors) && v.actors.length > 0) {
            html += '<div class="gateway-theatre-state-actors">';
            for (var i = 0; i < v.actors.length; i++) {
                var a = v.actors[i];
                html += '<div class="gateway-theatre-actor">';
                html += '<span class="gateway-theatre-actor-name">' + esc(a.name || a.id || '?') + '</span>';
                if (a.status) html += '<span class="gateway-theatre-actor-status">' + esc(a.status) + '</span>';
                if (a.health != null) html += '<span class="gateway-theatre-actor-health">❤️' + esc(a.health) + '</span>';
                html += '</div>';
            }
            html += '</div>';
        }
        if (v.scene) {
            html += '<div class="gateway-theatre-state-scene">';
            if (v.scene.beat) html += '<span>🎬 ' + esc(v.scene.beat) + '</span>';
            if (v.scene.goal) html += '<span>🎯 ' + esc(v.scene.goal) + '</span>';
            html += '</div>';
        }
        el.innerHTML = html || '<div class="gateway-empty-hint">（状态为空）</div>';
    }

    // ==================== Agent 剧场：时间线 ====================

    var EVENT_META = {
        tool_call: { icon: '🔧', label: '工具调用', cls: 'tool' },
        state_change: { icon: '✏️', label: '状态变更', cls: 'state' },
        subagent: { icon: '🤖', label: '子代理', cls: 'subagent' },
        subagent_dispatch: { icon: '🤖', label: '子代理', cls: 'subagent' },
        checkpoint: { icon: '📸', label: '检查点', cls: 'checkpoint' },
        draft: { icon: '📝', label: '草稿', cls: 'draft' },
        commit: { icon: '✅', label: '提交', cls: 'commit' },
        error: { icon: '❌', label: '错误', cls: 'error' },
    };

    function appendTimelineItem(event) {
        var el = $('agent_theatre_timeline');
        if (!el) return;
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        var meta = EVENT_META[event.type] || { icon: '•', label: event.type, cls: 'other' };
        var item = document.createElement('div');
        item.className = 'gateway-theatre-tl-item gateway-theatre-tl-' + meta.cls;
        var detail = '';
        if (event.payload) {
            if (event.payload.tool) detail = event.payload.tool;
            else if (event.payload.agent) detail = event.payload.agent;
            else if (event.payload.label) detail = event.payload.label;
            else if (event.payload.promoted) detail = 'promote ' + event.payload.promoted.length + ' 项';
        }
        var ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : '';
        item.innerHTML = '<span class="gateway-theatre-tl-icon">' + meta.icon + '</span>' +
            '<span class="gateway-theatre-tl-label">' + esc(meta.label) + '</span>' +
            (detail ? '<span class="gateway-theatre-tl-detail">' + esc(detail) + '</span>' : '') +
            '<span class="gateway-theatre-tl-ts">' + esc(ts) + '</span>';
        el.appendChild(item);
        el.scrollTop = el.scrollHeight;
    }

    function appendInlineEvent(event) {
        var el = $('agent_theatre_events_inline');
        if (!el) return;
        el.style.display = 'block';
        var meta = EVENT_META[event.type] || { icon: '•', label: event.type };
        var detail = '';
        if (event.payload) {
            if (event.payload.tool) detail = event.payload.tool;
            else if (event.payload.agent) detail = event.payload.agent;
            else if (event.payload.label) detail = event.payload.label;
        }
        var item = document.createElement('div');
        item.className = 'gateway-theatre-inline-event';
        item.textContent = '── ' + meta.icon + ' ' + meta.label + (detail ? ': ' + detail : '') + ' ──';
        el.appendChild(item);
    }

    function fetchTimeline(runId) {
        if (!runId) return;
        agentFetch('/api/agent-theatre/events/' + encodeURIComponent(runId) + '?limit=200')
            .then(function (data) {
                if (!data || !data.success || !data.events) return;
                var el = $('agent_theatre_timeline');
                if (el) el.innerHTML = '';
                theatre.timelineEvents = [];
                for (var i = 0; i < data.events.length; i++) {
                    appendTimelineItem(data.events[i]);
                }
            })
            .catch(function (e) { console.warn('[agent-frontend] 拉取时间线失败', e); });
    }

    // ==================== Agent 剧场：发送 ====================

    function sendInput(text, callbackId, options) {
        options = options || {};
        var body = {
            input: text || '',
            session: theatre.session || 'native:default',
            profile: theatre.profile,
        };
        if (theatre.character) body.character = theatre.character;
        if (theatre.worldbook) body.worldbook = theatre.worldbook;
        if (callbackId) body.callbackId = callbackId;
        if (options.rerun) body.rerun = true;
        var styleEl = $('agent_theatre_style');
        if (styleEl && styleEl.value) body.style = styleEl.value;

        // 重跑时不重复追加用户消息（上一轮已有）
        if (text && !options.rerun) appendUserMessage(text);

        var narrative = $('agent_theatre_narrative');
        if (narrative) {
            var empty = narrative.querySelector('.gateway-empty-hint');
            if (empty) empty.remove();
            // 先清掉旧流式/占位消息，创建「思考中」占位 AI 气泡
            // （流式首帧到达后由 handleTokenDelta 接管为正式流式消息）
            if (streaming.el && streaming.el.parentNode) streaming.el.remove();
            streaming.el = null;
            streaming.runId = null;
            var placeholder = createAssistantMsg('', false);
            placeholder.classList.add('pending');
            var bubble = placeholder.querySelector('.agent-chat-bubble');
            var cursor = document.createElement('span');
            cursor.className = 'agent-chat-cursor';
            cursor.id = 'agent_theatre_cursor';
            cursor.textContent = '▍ Agent 思考中...';
            bubble.appendChild(cursor);
            narrative.appendChild(placeholder);
            streaming.el = placeholder;
            if (autoScroll) narrative.scrollTop = narrative.scrollHeight;
        }

        // P2: 本地状态机先进入 running（SSE run_state 事件随后到达驱动 UI，此处兜底保证按钮即时反应）
        theatre.runState = 'running';
        renderRunState();

        agentFetch('/api/agent-theatre/input', {
            method: 'POST',
            body: JSON.stringify(body),
        }).then(function (data) {
            if (!data.success) {
                removePendingPlaceholder();
                showToast('error', 'Agent run 失败: ' + (data.error || '未知错误'));
                // P2: run 未启动，恢复状态机
                theatre.runState = 'idle';
                renderRunState();
                return;
            }
            // handleAgentResult 会被 SSE 推送触发；无 SSE 时兜底渲染
            if (!theatre.connected) {
                handleAgentResult({ runId: data.runId, result: data.result, text: data.text });
            }
        }).catch(function (e) {
            removePendingPlaceholder();
            showToast('error', '发送失败: ' + e.message);
        });
    }

    /**
     * 创建 AI 消息结构：.agent-chat-msg.assistant > 头像 + 气泡
     * streamingFlag=true 时气泡带 .streaming class 并在末尾追加流式光标 ▍
     */
    function createAssistantMsg(text, streamingFlag) {
        var msg = document.createElement('div');
        msg.className = 'agent-chat-msg assistant' + (streamingFlag ? ' streaming' : '');
        var avatar = document.createElement('div');
        avatar.className = 'agent-chat-avatar';
        avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';
        var bubble = document.createElement('div');
        bubble.className = 'agent-chat-bubble';
        if (streamingFlag) bubble.classList.add('streaming');
        bubble.textContent = text || '';
        if (streamingFlag) appendCursor(bubble);
        msg.appendChild(avatar);
        if (!streamingFlag) {
            // 重试按钮：hover 显示，点击重跑上一轮（事件委托绑定在 narrative 上）
            var retry = document.createElement('button');
            retry.className = 'agent-chat-retry';
            retry.title = '重跑上一轮';
            retry.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 重试';
            bubble.appendChild(retry);
        }
        msg.appendChild(bubble);
        return msg;
    }

    /** 在气泡末尾追加流式光标 ▍ */
    function appendCursor(bubble) {
        if (!bubble) return;
        var s = document.createElement('span');
        s.className = 'agent-chat-cursor';
        s.textContent = '▍';
        bubble.appendChild(s);
    }

    function appendUserMessage(text) {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        var msg = document.createElement('div');
        msg.className = 'agent-chat-msg user';
        var avatar = document.createElement('div');
        avatar.className = 'agent-chat-avatar';
        avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
        var bubble = document.createElement('div');
        bubble.className = 'agent-chat-bubble';
        bubble.textContent = text;
        msg.appendChild(avatar);
        msg.appendChild(bubble);
        el.appendChild(msg);
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    // ==================== 角色卡 / 世界书 / 聊天记录 ====================

    /** 生成当前角色卡的 localStorage key（无角色卡用 default） */
    function chatHistoryKey(name) {
        var n = name != null ? name : theatre.character;
        return LS_CHAT_PREFIX + (n || 'default');
    }

    /** 更新工具栏角色卡指示徽标 */
    function updateCharacterBadge() {
        var badge = $('agent_theatre_character_badge');
        if (!badge) return;
        var name = theatre.character;
        if (name) {
            var abbr = name.length > 2 ? name.substring(0, 2) : name;
            badge.textContent = '🧩 ' + abbr;
            badge.title = '当前角色卡：' + name;
            badge.className = 'gateway-status-badge connected';
        } else {
            badge.textContent = '🧩 -';
            badge.title = '未指定角色卡';
            badge.className = 'gateway-status-badge';
        }
    }

    /** 调用 /api/agent-theatre/assets 获取角色卡和世界书列表，填充两个 select */
    function loadAssets() {
        agentFetch('/api/agent-theatre/assets').then(function (data) {
            if (!data || !data.assets) return;
            var characters = data.assets.characters || [];
            var worldbooks = data.assets.worldbooks || [];

            var charSel = $('agent_theatre_character');
            if (charSel) {
                var curChar = theatre.character || charSel.value || '';
                charSel.innerHTML = '<option value="">🧩 不指定</option>';
                for (var i = 0; i < characters.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = characters[i];
                    opt.textContent = characters[i];
                    if (characters[i] === curChar) opt.selected = true;
                    charSel.appendChild(opt);
                }
                theatre.character = charSel.value;
            }

            var wbSel = $('agent_theatre_worldbook');
            if (wbSel) {
                var curWb = theatre.worldbook || wbSel.value || '';
                wbSel.innerHTML = '<option value="">📖 不指定</option>';
                for (var j = 0; j < worldbooks.length; j++) {
                    var wopt = document.createElement('option');
                    wopt.value = worldbooks[j];
                    wopt.textContent = worldbooks[j];
                    if (worldbooks[j] === curWb) wopt.selected = true;
                    wbSel.appendChild(wopt);
                }
                theatre.worldbook = wbSel.value;
            }

            updateCharacterBadge();
        }).catch(function (e) {
            console.warn('[agent-frontend] 加载角色卡/世界书列表失败', e);
        });
    }

    /** 将当前消息流序列化存入 localStorage（按角色卡隔离） */
    function saveChatHistory() {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var msgs = el.querySelectorAll('.agent-chat-msg');
        var history = [];
        for (var i = 0; i < msgs.length; i++) {
            var node = msgs[i];
            if (node.classList.contains('user')) {
                var ububble = node.querySelector('.agent-chat-bubble');
                var utext = ububble ? ububble.textContent : '';
                if (utext) history.push({ role: 'user', content: utext, timestamp: Date.now() });
            } else if (node.classList.contains('assistant')) {
                var abubble = node.querySelector('.agent-chat-bubble');
                if (!abubble) continue;
                // 克隆后移除重试按钮 / 流式光标文本，提取纯正文
                var clone = abubble.cloneNode(true);
                var retry = clone.querySelector('.agent-chat-retry');
                if (retry) retry.remove();
                var cursor = clone.querySelector('.agent-chat-cursor');
                if (cursor) cursor.remove();
                var atext = clone.textContent;
                if (atext) history.push({ role: 'assistant', content: atext, timestamp: Date.now() });
            }
        }
        try {
            localStorage.setItem(chatHistoryKey(), JSON.stringify(history));
        } catch (e) {
            console.warn('[agent-frontend] 保存聊天记录失败', e);
        }
    }

    /** 从 localStorage 读取并恢复消息流 */
    function loadChatHistory() {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var raw = null;
        try { raw = localStorage.getItem(chatHistoryKey()); } catch (_) { /* 静默 */ }
        if (!raw) return;
        var history = [];
        try { history = JSON.parse(raw) || []; } catch (_) { return; }
        if (!history.length) return;
        // 清掉空提示
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        for (var i = 0; i < history.length; i++) {
            var item = history[i];
            if (!item || !item.role || !item.content) continue;
            if (item.role === 'user') {
                appendUserMessage(item.content);
            } else if (item.role === 'assistant') {
                appendNarrative(item.content);
            }
        }
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    /** 切换角色卡：保存当前记录 -> 淡出 -> 清空 DOM -> 加载新记录 -> 淡入 */
    function switchCharacter(name) {
        // 1. 保存当前角色卡的聊天记录（此时 theatre.character 仍为旧值）
        saveChatHistory();
        // 2. 淡出动画
        var narrative = $('agent_theatre_narrative');
        if (narrative) narrative.style.opacity = '0';
        // 3. 延迟后切换：更新角色卡 -> 清空 DOM（不删 localStorage）-> 加载新记录
        setTimeout(function () {
            theatre.character = name;
            clearNarrativeDom();
            loadChatHistory();
            updateCharacterBadge();
            if (narrative) narrative.style.opacity = '1';
            showToast('success', name ? '已切换到角色卡「' + name + '」' : '已清除角色卡');
        }, 200);
    }

    // ==================== Agent 剧场：Profile 加载 / 保存（热重载） ====================

    function loadProfileList() {
        agentFetch('/api/agents').then(function (data) {
            if (!data || data.error) return;
            var sel = $('agent_theatre_profile');
            if (!sel) return;
            var agents = data.agents || [];
            var current = sel.value || theatre.profile;
            sel.innerHTML = '';
            for (var i = 0; i < agents.length; i++) {
                var opt = document.createElement('option');
                opt.value = agents[i].name;
                opt.textContent = agents[i].displayName || agents[i].name;
                if (agents[i].name === current) opt.selected = true;
                sel.appendChild(opt);
            }
            if (agents.length > 0) {
                theatre.profile = sel.value;
                loadProfileYaml(sel.value);
            }
        }).catch(function (e) {
            console.warn('[agent-frontend] 加载 Agent 列表失败', e);
        });
    }

    function loadProfileYaml(name) {
        if (!name) return;
        agentFetch('/api/agents/' + encodeURIComponent(name)).then(function (def) {
            var yaml = toYaml(def);
            var ta = $('agent_theatre_profile_yaml');
            if (ta) ta.value = yaml;
            // 同步视角选择器（读 YAML 根级 viewMode）
            var vm = yamlViewMode(yaml);
            var sel = $('agent_theatre_viewmode');
            if (sel && vm && ['actor', 'director', 'first'].indexOf(vm) !== -1) sel.value = vm;
        }).catch(function (e) {
            console.warn('[agent-frontend] 加载 Profile YAML 失败', e);
        });
    }

    function saveProfileYaml() {
        var name = theatre.profile;
        var ta = $('agent_theatre_profile_yaml');
        var yaml = (ta && ta.value) || '';
        if (!yaml.trim()) {
            showToast('warning', 'YAML 内容不能为空');
            return;
        }
        agentFetch('/api/agents', {
            method: 'POST',
            body: JSON.stringify({ name: name, yaml: yaml }),
        }).then(function (data) {
            if (data.success) {
                showToast('success', 'Profile 已保存并热重载');
                showSaveHint('✅ 已保存，引擎已热重载，会话不中断');
            } else {
                showToast('error', '保存失败: ' + (data.error || '未知错误'));
            }
        }).catch(function (e) {
            showToast('error', '保存失败: ' + e.message);
        });
    }

    function validateRun() {
        var name = theatre.profile;
        var ta = $('agent_theatre_profile_yaml');
        var yaml = (ta && ta.value) || '';
        if (!yaml.trim()) {
            showToast('warning', 'YAML 内容不能为空');
            return;
        }

        var btn = $('agent_theatre_validate_run');
        if (btn) { btn.disabled = true; btn.textContent = '试运行中...'; }

        agentFetch('/api/agent-theatre/validate-run', {
            method: 'POST',
            body: JSON.stringify({ name: name, yaml: yaml }),
        }).then(function (data) {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-flask"></i> 试运行'; }
            if (data.success) {
                showToast('success', '验证通过：保存成功 + run 已完成');
                showSaveHint('✅ 验证通过，Profile 可正常运行');
                // 把试运行结果渲染到正文区
                if (data.text) {
                    handleAgentResult({ runId: data.runId, result: data.result, text: data.text });
                }
            } else {
                showToast('error', '验证失败: ' + (data.error || '未知错误'));
            }
        }).catch(function (e) {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-flask"></i> 试运行'; }
            showToast('error', '试运行失败: ' + e.message);
        });
    }

    function showSaveHint(msg) {
        var hint = $('agent_theatre_save_hint');
        if (hint) {
            hint.textContent = msg;
            hint.style.display = 'block';
            setTimeout(function () { hint.style.display = 'none'; }, 3000);
        }
    }

    /** 读取 YAML 根级 viewMode 字段值 */
    function yamlViewMode(yaml) {
        var m = /^viewMode:\s*([^\s#]+)/m.exec(yaml || '');
        return m ? m[1] : null;
    }

    /** 把视角写入 Profile YAML（有 viewMode 行则替换，否则插入到 name 行之后） */
    function applyViewModeToYaml(yaml, mode) {
        if (!mode || !yaml) return yaml;
        if (/^viewMode:/m.test(yaml)) return yaml.replace(/^viewMode:.*$/m, 'viewMode: ' + mode);
        if (/^name:.*$/m.test(yaml)) return yaml.replace(/^(name:.*)$/m, '$1\nviewMode: ' + mode);
        return 'viewMode: ' + mode + '\n' + yaml;
    }

    // ==================== Agent 剧场：简易对象 → YAML ====================

    function toYaml(obj, indent) {
        indent = indent || 0;
        var pad = '  '.repeat(indent);
        var lines = [];
        if (obj === null || obj === undefined) return '';
        if (typeof obj !== 'object') return String(obj);
        if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) {
                var item = obj[i];
                if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
                    var entries = Object.keys(item);
                    if (entries.length > 0) {
                        lines.push(pad + '- ' + entries[0] + ': ' + yamlVal(item[entries[0]], indent + 1));
                        for (var j = 1; j < entries.length; j++) {
                            lines.push(pad + '  ' + entries[j] + ': ' + yamlVal(item[entries[j]], indent + 1));
                        }
                    }
                } else {
                    lines.push(pad + '- ' + yamlVal(item, indent));
                }
            }
            return lines.join('\n');
        }
        for (var key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            var val = obj[key];
            if (val !== null && typeof val === 'object') {
                var sub = toYaml(val, indent + 1);
                lines.push(pad + key + ':');
                if (sub) lines.push(sub);
            } else {
                lines.push(pad + key + ': ' + yamlVal(val, indent));
            }
        }
        return lines.join('\n');
    }

    function yamlVal(v, indent) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v) || typeof v === 'object') return '\n' + toYaml(v, (indent || 0) + 1);
        return String(v);
    }

    // ==================== AI 助手（自然语言修改 Profile） ====================

    var aiState = {
        inFlight: false,
        lastPlan: null,
        highConfirmArmed: false,
    };

    function riskBadgeClass(level) {
        if (level === 'low') return 'gateway-ai-plan-risk low';
        if (level === 'high') return 'gateway-ai-plan-risk high';
        return 'gateway-ai-plan-risk medium';
    }

    function riskLabel(level) {
        if (level === 'low') return '低风险';
        if (level === 'high') return '高风险';
        return '中风险';
    }

    function renderPlan(plan) {
        var view = $('agent_theatre_ai_plan_view');
        if (!view) return;
        var changesHtml = '';
        var changes = Array.isArray(plan.changes) ? plan.changes : [];
        if (changes.length === 0) {
            changesHtml = '<div class="gateway-ai-plan-change-empty">（无具体字段变更，可能仅文字润色）</div>';
        } else {
            for (var i = 0; i < changes.length; i++) {
                var c = changes[i] || {};
                changesHtml += '' +
                    '<div class="gateway-ai-plan-change">' +
                    '<div class="gateway-ai-plan-change-field">' + esc(c.field || '?') + '</div>' +
                    '<div class="gateway-ai-plan-change-diff">' +
                    '<span class="gateway-ai-plan-from">' + esc(c.from == null ? '(空)' : c.from) + '</span>' +
                    '<span class="gateway-ai-plan-arrow">→</span>' +
                    '<span class="gateway-ai-plan-to">' + esc(c.to == null ? '(空)' : c.to) + '</span>' +
                    '</div>' +
                    (c.reason ? '<div class="gateway-ai-plan-change-reason">' + esc(c.reason) + '</div>' : '') +
                    '</div>';
            }
        }
        var isHigh = plan.riskLevel === 'high';
        var applyBtnClass = 'menu_button gateway-ai-apply-btn' + (isHigh ? ' gateway-ai-apply-danger' : '');
        var applyBtnText = isHigh ? '⚠️ 确认应用高风险修改（再点一次）' : '✅ 应用修改';

        view.innerHTML = '' +
            '<div class="gateway-ai-plan-card">' +
            '<div class="gateway-ai-plan-understanding">' + esc(plan.understanding || '') + '</div>' +
            '<div class="gateway-ai-plan-summary">' + esc(plan.summary || '').replace(/\n/g, '<br>') + '</div>' +
            '<div class="gateway-ai-plan-changes">' + changesHtml + '</div>' +
            '<div class="gateway-ai-plan-risk-row">' +
            '<span class="' + riskBadgeClass(plan.riskLevel) + '">' + riskLabel(plan.riskLevel) + '</span>' +
            (plan.riskNote ? '<span class="gateway-ai-plan-risk-note">' + esc(plan.riskNote) + '</span>' : '') +
            '</div>' +
            '<div class="gateway-ai-plan-actions">' +
            '<button id="agent_theatre_ai_apply" class="' + applyBtnClass + '">' + applyBtnText + '</button>' +
            '<button id="agent_theatre_ai_cancel_plan" class="menu_button">取消</button>' +
            '</div>' +
            '</div>';
        view.style.display = 'block';

        var applyBtn = $('agent_theatre_ai_apply');
        if (applyBtn) applyBtn.addEventListener('click', function () {
            if (isHigh && !aiState.highConfirmArmed) {
                aiState.highConfirmArmed = true;
                applyBtn.textContent = '⚠️ 再次点击确认应用（不可撤销除外）';
                applyBtn.classList.add('gateway-ai-apply-armed');
                return;
            }
            aiState.highConfirmArmed = false;
            applyPlan(plan);
        });
        var cancelBtn = $('agent_theatre_ai_cancel_plan');
        if (cancelBtn) cancelBtn.addEventListener('click', clearPlanView);
    }

    function clearPlanView() {
        var view = $('agent_theatre_ai_plan_view');
        if (view) { view.innerHTML = ''; view.style.display = 'none'; }
        aiState.lastPlan = null;
        aiState.highConfirmArmed = false;
    }

    function renderAiLoading() {
        var view = $('agent_theatre_ai_plan_view');
        if (!view) return;
        view.innerHTML = '<div class="gateway-ai-loading"><span></span><span></span><span></span><span class="gateway-ai-loading-text">AI 正在分析修改方案…</span></div>';
        view.style.display = 'block';
    }

    function renderAiError(msg) {
        var view = $('agent_theatre_ai_plan_view');
        if (!view) return;
        view.innerHTML = '<div class="gateway-ai-plan-error"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(msg) + '</div>';
        view.style.display = 'block';
    }

    function generatePlan() {
        if (aiState.inFlight) {
            showToast('warning', '上一次请求仍在进行中，请稍候');
            return;
        }
        var input = $('agent_theatre_ai_input');
        var request = input ? input.value.trim() : '';
        if (!request) { showToast('warning', '请先用大白话描述你想怎么改'); return; }
        var profileName = currentProfileName();
        var yamlTa = $('agent_theatre_profile_yaml');
        var currentYaml = yamlTa ? yamlTa.value : '';
        if (!currentYaml.trim()) { showToast('warning', '当前 Profile YAML 为空，请先加载或选择 Profile'); return; }

        aiState.inFlight = true;
        aiState.highConfirmArmed = false;
        renderAiLoading();

        agentFetch('/api/agent-theatre/ai-modify/plan', {
            method: 'POST',
            body: JSON.stringify({ request: request, profileName: profileName, currentYaml: currentYaml }),
        }).then(function (data) {
            if (data && data.success && data.plan) {
                aiState.lastPlan = data.plan;
                renderPlan(data.plan);
            } else {
                renderAiError((data && data.error) || 'AI 未能生成方案');
            }
        }).catch(function (e) {
            renderAiError(e.message || '请求失败');
        }).finally(function () {
            aiState.inFlight = false;
        });
    }

    function applyPlan(plan) {
        var profileName = currentProfileName();
        var newYaml = plan.newYaml || '';
        if (!newYaml.trim()) { showToast('error', '方案中没有可应用的 YAML'); return; }
        agentFetch('/api/agent-theatre/ai-modify/apply', {
            method: 'POST',
            body: JSON.stringify({ profileName: profileName, newYaml: newYaml }),
        }).then(function (data) {
            if (data && data.success) {
                showToast('success', 'AI 修改已应用，引擎已热重载');
                var yamlTa = $('agent_theatre_profile_yaml');
                if (yamlTa) yamlTa.value = newYaml;
                var vm = yamlViewMode(newYaml);
                var sel = $('agent_theatre_viewmode');
                if (sel && vm && ['actor', 'director', 'first'].indexOf(vm) !== -1) sel.value = vm;
                showSaveHint('✅ AI 修改已应用，引擎已热重载，会话不中断');
                clearPlanView();
                refreshAiHistory();
            } else {
                showToast('error', '应用失败: ' + ((data && data.error) || '未知错误'));
            }
        }).catch(function (e) {
            showToast('error', '应用失败: ' + e.message);
        });
    }

    function undoModify() {
        var profileName = currentProfileName();
        agentFetch('/api/agent-theatre/ai-modify/undo', {
            method: 'POST',
            body: JSON.stringify({ profileName: profileName }),
        }).then(function (data) {
            if (data && data.success) {
                showToast('success', '已撤销上次 AI 修改');
                if (data.restoredYaml) {
                    var yamlTa = $('agent_theatre_profile_yaml');
                    if (yamlTa) yamlTa.value = data.restoredYaml;
                }
                showSaveHint('↩️ 已撤销到上一版本，引擎已热重载');
            } else {
                showToast('warning', (data && data.error) || '撤销失败');
            }
            refreshAiHistory();
        }).catch(function (e) {
            showToast('error', '撤销失败: ' + e.message);
        });
    }

    function refreshAiHistory() {
        var profileName = currentProfileName();
        agentFetch('/api/agent-theatre/ai-modify/history?profileName=' + encodeURIComponent(profileName))
            .then(function (data) {
                var el = $('agent_theatre_ai_history');
                if (!el) return;
                el.textContent = (data && data.success) ? (data.canUndo ? '可撤销 ' + data.count + ' 步' : '无可撤销') : '';
            })
            .catch(function () {
                var el = $('agent_theatre_ai_history');
                if (el) el.textContent = '';
            });
    }

    function currentProfileName() {
        var sel = $('agent_theatre_profile');
        return (sel && sel.value) || theatre.profile || 'default-rp';
    }

    // ==================== 事件绑定 ====================

    function bindEvents() {
        // 连接
        var connSave = $('agent_conn_save');
        if (connSave) connSave.addEventListener('click', saveConnection);

        // 设置（统一保存：引擎 + 前端 URL 一次性提交）
        var saveAll = $('agent_settings_save_all');
        if (saveAll) saveAll.addEventListener('click', saveAllSettings);
        // 兼容旧版 HTML 残留的分组保存按钮（如有则重定向到统一保存）
        var legacyEngineSave = $('agent_engine_save');
        if (legacyEngineSave) legacyEngineSave.addEventListener('click', saveAllSettings);
        var legacyFrontendSave = $('agent_frontend_save');
        if (legacyFrontendSave) legacyFrontendSave.addEventListener('click', saveAllSettings);

        // 前端 URL
        var openBtn = $('agent_frontend_open');
        if (openBtn) openBtn.addEventListener('click', openFrontend);
        var validateBtn = $('agent_frontend_validate');
        if (validateBtn) validateBtn.addEventListener('click', validateFrontendRemote);
        var urlInput = $('agent_frontend_url');
        if (urlInput) urlInput.addEventListener('input', function () { showFrontendError(null); });

        // 剧场：发送
        var sendBtn = $('agent_theatre_send');
        if (sendBtn) sendBtn.addEventListener('click', function () {
            var input = $('agent_theatre_input');
            var text = input ? input.value.trim() : '';
            if (!text) { showToast('warning', '请输入消息'); return; }
            sendInput(text, null);
            if (input) input.value = '';
        });

        // P2: 剧场：停止生成（run 运行时调用 /abort，UI 由 SSE run_state 事件驱动）
        var stopBtn = $('agent_theatre_stop');
        if (stopBtn) stopBtn.addEventListener('click', function () {
            if (theatre.runState !== 'running') return;
            agentFetch('/api/agent-theatre/abort', {
                method: 'POST',
                body: JSON.stringify({ session: theatre.session || 'native:default' }),
            }).then(function (data) {
                if (!data.success) { showToast('error', '停止失败: ' + (data.error || '未知错误')); return; }
                // aborting 状态由 SSE run_state 事件驱动（/abort 端点广播）
            }).catch(function (e) {
                showToast('error', '停止请求失败: ' + e.message);
            });
        });

        var inputEl = $('agent_theatre_input');
        if (inputEl) inputEl.addEventListener('keydown', function (e) {
            // ST 风格：Enter 发送 / Shift+Enter 换行
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (sendBtn && !sendBtn.disabled) sendBtn.click();
            }
        });

        // 滚动跟随：距底部 <80px 时跟随新内容，用户上翻阅读时暂停
        var narrativeEl = $('agent_theatre_narrative');
        if (narrativeEl) narrativeEl.addEventListener('scroll', function () {
            var dist = this.scrollHeight - this.scrollTop - this.clientHeight;
            autoScroll = dist < 80;
        });

        // AI 消息气泡「重试」按钮（事件委托，点击重跑上一轮）
        if (narrativeEl) narrativeEl.addEventListener('click', function (e) {
            var btn = e.target.closest('.agent-chat-retry');
            if (!btn) return;
            if (!theatre.lastResult) {
                showToast('warning', '还没有上一轮可重跑');
                return;
            }
            sendInput(null, null, { rerun: true });
        });

        // 选项点击（事件委托）
        var optEl = $('agent_theatre_options');
        if (optEl) optEl.addEventListener('click', function (e) {
            var btn = e.target.closest('.gateway-theatre-option-btn');
            if (!btn) return;
            sendInput(btn.getAttribute('data-text'), btn.getAttribute('data-callback'));
        });

        // 清空
        var clearBtn = $('agent_theatre_clear');
        if (clearBtn) clearBtn.addEventListener('click', clearNarrative);

        // 保存聊天记录
        var saveHistoryBtn = $('agent_theatre_save_history');
        if (saveHistoryBtn) saveHistoryBtn.addEventListener('click', function () {
            saveChatHistory();
            showToast('success', '聊天记录已保存到本地');
        });

        // 角色卡切换（自动保存/加载聊天记录）
        var charSel = $('agent_theatre_character');
        if (charSel) charSel.addEventListener('change', function () {
            switchCharacter(this.value);
        });

        // 世界书切换
        var wbSel = $('agent_theatre_worldbook');
        if (wbSel) wbSel.addEventListener('change', function () {
            theatre.worldbook = this.value;
            showToast('info', this.value ? '已选择世界书「' + this.value + '」' : '已清除世界书');
        });

        // 重跑
        var rerunBtn = $('agent_theatre_rerun');
        if (rerunBtn) rerunBtn.addEventListener('click', function () {
            if (!theatre.lastResult) {
                showToast('warning', '还没有上一轮可重跑');
                return;
            }
            sendInput(null, null, { rerun: true });
        });

        // Profile 切换
        var profileSel = $('agent_theatre_profile');
        if (profileSel) profileSel.addEventListener('change', function () {
            theatre.profile = this.value;
            loadProfileYaml(this.value);
        });

        // 会话切换
        var sessionEl = $('agent_theatre_session');
        if (sessionEl) sessionEl.addEventListener('change', function () {
            theatre.session = this.value || 'native:default';
            connectStream();
        });

        // 视角：同步到 Profile YAML（保存热重载后生效）
        var viewSel = $('agent_theatre_viewmode');
        if (viewSel) viewSel.addEventListener('change', function () {
            var ta = $('agent_theatre_profile_yaml');
            if (!ta || !ta.value.trim()) {
                showToast('warning', '请先加载 Profile YAML 后再切换视角');
                return;
            }
            ta.value = applyViewModeToYaml(ta.value, this.value);
            showSaveHint('👁 视角已写入 Profile YAML（viewMode），点击「保存热重载」生效');
        });

        // 保存热重载 / 重新加载
        var saveBtn = $('agent_theatre_save_profile');
        if (saveBtn) saveBtn.addEventListener('click', saveProfileYaml);
        var validateBtn = $('agent_theatre_validate_run');
        if (validateBtn) validateBtn.addEventListener('click', validateRun);
        var reloadBtn = $('agent_theatre_reload_profile');
        if (reloadBtn) reloadBtn.addEventListener('click', function () { loadProfileYaml(theatre.profile); });

        // AI 助手
        var aiPlanBtn = $('agent_theatre_ai_plan');
        if (aiPlanBtn) aiPlanBtn.addEventListener('click', generatePlan);
        var aiUndoBtn = $('agent_theatre_ai_undo');
        if (aiUndoBtn) aiUndoBtn.addEventListener('click', undoModify);
    }

    // ==================== 顶栏下拉面板 ====================

    /** 关闭所有已打开的下拉面板 */
    function closeDropdowns() {
        var all = document.querySelectorAll('.agent-dropdown.open');
        for (var j = 0; j < all.length; j++) all[j].classList.remove('open');
    }

    /** 下拉开合：点击 toggle 切换 .open；点击面板外关闭；ESC 关闭 */
    function bindDropdowns() {
        var toggles = ['agent_settings_toggle', 'agent_status_toggle'];
        for (var i = 0; i < toggles.length; i++) {
            var t = $(toggles[i]);
            if (!t) continue;
            t.addEventListener('click', function (e) {
                e.stopPropagation();
                var dropdown = this.closest('.agent-dropdown');
                if (!dropdown) return;
                var willOpen = !dropdown.classList.contains('open');
                closeDropdowns();
                if (willOpen) dropdown.classList.add('open');
            });
        }
        // 关闭按钮：点击 × 关闭对应下拉面板
        var closeBtns = document.querySelectorAll('[data-close-dropdown]');
        for (var j = 0; j < closeBtns.length; j++) {
            closeBtns[j].addEventListener('click', function (e) {
                e.stopPropagation();
                var dropdown = this.closest('.agent-dropdown');
                if (dropdown) dropdown.classList.remove('open');
            });
        }
        // 点击面板外区域关闭所有下拉（面板内点击不影响原有表单/折叠事件）
        document.addEventListener('click', function (e) {
            if (e.target.closest('.agent-dropdown')) return;
            closeDropdowns();
        });
        // ESC 关闭
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeDropdowns();
        });
    }

    /** 抽屉开合：点击 toggle 切换 .open */
    function bindDrawer() {
        var toggle = $('agent_toolbar_toggle');
        if (!toggle) return;
        toggle.addEventListener('click', function () {
            var drawer = $('agent_toolbar_drawer');
            if (drawer) drawer.classList.toggle('open');
        });
    }

    // ==================== 初始化 ====================

    function theatreReconnect() {
        // 重新拉取 Profile 列表 + 重连 SSE
        var sessionEl = $('agent_theatre_session');
        if (sessionEl) theatre.session = sessionEl.value || 'native:default';
        if (gatewayUrl()) loadProfileList();
        connectStream();
        agentFetch('/api/agent-theatre/state?session=' + encodeURIComponent(theatre.session))
            .then(function (data) {
                if (data && data.success && data.active && data.lastResult) {
                    theatre.lastResult = data.lastResult;
                    handleAgentResult({
                        runId: data.lastRunId,
                        result: data.lastResult,
                        text: data.lastResult.artifacts && data.lastResult.artifacts[0] && data.lastResult.artifacts[0].text,
                    });
                }
            })
            .catch(function () { /* 静默 */ });
    }

    function init() {
        loadConnection();

        var sessionEl = $('agent_theatre_session');
        if (sessionEl) theatre.session = sessionEl.value || 'native:default';
        var profileEl = $('agent_theatre_profile');
        if (profileEl) theatre.profile = profileEl.value || 'default-rp';

        bindCollapsibles();
        bindModalEvents();
        bindDropdowns();
        bindDrawer();
        bindEvents();

        // 拉取设置并填充
        loadAllSettings().catch(function () { /* 已内部提示 */ });

        // 剧场初始化
        theatreReconnect();

        // 加载角色卡 / 世界书列表
        loadAssets();

        // 加载当前角色卡的本地聊天记录（若有）
        loadChatHistory();

        // 首次使用引导
        runFirstGuide();

        console.log('[Agent 前端] 已初始化');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
