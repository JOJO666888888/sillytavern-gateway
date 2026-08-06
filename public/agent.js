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

    /**
     * 页内确认对话框（Promise 化，非阻塞）。
     *
     * 替代原生 window.confirm：原生模态弹窗在 IDE 内置浏览器 / WebView 等嵌入环境
     * 中不受支持（可能静默返回 false、阻塞渲染线程，甚至拖垮宿主 React 渲染循环，
     * 表现为 "Maximum update depth exceeded" / React error #185）。改为页面内浮层，
     * 交互不依赖宿主环境，点击「取消/遮罩/Esc」resolve(false)，「确定」resolve(true)。
     *
     * @param {string} message - 提示文案
     * @param {object} [options]
     * @param {string} [options.title='确认操作']
     * @param {string} [options.confirmText='确定']
     * @param {boolean} [options.danger=false] - 危险操作（确定按钮红色高亮）
     * @returns {Promise<boolean>}
     */
    var confirmPending = null;
    function agentConfirm(message, options) {
        options = options || {};
        var dialog = $('agent_confirm_dialog');
        if (!dialog) {
            // 极端兜底：DOM 缺失时退化为 window.confirm（保留原有交互语义）
            return Promise.resolve(window.confirm(message || ''));
        }
        // 已有未决的确认（连点）→ 直接拒绝新请求，避免对话框状态错乱
        if (confirmPending) return Promise.resolve(false);
        var titleEl = $('agent_confirm_title');
        var msgEl = $('agent_confirm_message');
        var okBtn = $('agent_confirm_ok');
        var cancelBtn = $('agent_confirm_cancel');
        if (titleEl) titleEl.textContent = options.title || '确认操作';
        if (msgEl) msgEl.textContent = message || '';
        if (okBtn) {
            okBtn.textContent = options.confirmText || '确定';
            okBtn.className = 'menu_button agent-confirm-ok' + (options.danger ? ' danger' : '');
        }
        dialog.style.display = 'flex';
        dialog.setAttribute('aria-hidden', 'false');
        if (okBtn) okBtn.focus();
        return new Promise(function (resolve) {
            confirmPending = { resolve: resolve };
            function settle(result) {
                if (!confirmPending) return;
                confirmPending = null;
                dialog.style.display = 'none';
                dialog.setAttribute('aria-hidden', 'true');
                cleanup();
                resolve(result);
            }
            function cleanup() {
                if (okBtn) okBtn.removeEventListener('click', onOk);
                if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
                if (mask) mask.removeEventListener('click', onCancel);
                if (dialog) dialog.removeEventListener('keydown', onKeydown);
            }
            function onOk() { settle(true); }
            function onCancel() { settle(false); }
            function onKeydown(e) {
                if (e.key === 'Escape') settle(false);
                else if (e.key === 'Enter') settle(true);
            }
            var mask = dialog.querySelector('.agent-confirm-mask');
            if (okBtn) okBtn.addEventListener('click', onOk);
            if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
            if (mask) mask.addEventListener('click', onCancel);
            if (dialog) dialog.addEventListener('keydown', onKeydown);
        });
    }

    /** 全局错误兜底：未捕获异常/未处理的 Promise 拒绝统一转 toast，避免错误外溢到宿主环境 */
    function bindGlobalErrorHandlers() {
        window.addEventListener('error', function (e) {
            console.error('[agent-frontend] 未捕获异常:', e && e.error ? e.error : e);
            if (e && e.error && e.error.message) {
                showToast('error', '页面出错: ' + e.error.message);
            } else if (e && e.message) {
                showToast('error', '页面出错: ' + e.message);
            }
            // 不阻止默认行为（保留控制台完整堆栈），仅提示用户
        });
        window.addEventListener('unhandledrejection', function (e) {
            var reason = e && e.reason;
            var msg = (reason && reason.message) ? reason.message : String(reason);
            console.error('[agent-frontend] 未处理的 Promise 拒绝:', reason);
            showToast('error', '请求异常: ' + msg);
        });
    }

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
                        var msg = body.error || ('HTTP ' + resp.status);
                        // 404/401 常见根因：连接配置中的网关地址指向了错误/旧版服务。
                        // 给出可操作的排查指引（Agent 独立服务 http://127.0.0.1:4321）。
                        if (resp.status === 404 || resp.status === 401) {
                            msg = msg + '。请检查「连接配置」中的网关地址是否指向正确的 Agent 服务' +
                                '（独立服务默认 http://127.0.0.1:4321，主网关 http://127.0.0.1:3210）。' +
                                '当前请求地址: ' + url;
                        }
                        throw new Error(msg);
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

    // ==================== LLM 配置 ====================

    /** 拉取脱敏的 runtime.llm 配置并填充表单 */
    function loadLlmConfig() {
        return agentFetch('/api/agent-theatre/llm-config')
            .then(function (data) {
                if (!data || !data.success) return;
                var llm = data.llm || {};
                setVal('agent_llm_provider', llm.provider || 'openai');
                setVal('agent_llm_baseurl', llm.baseUrl || '');
                setVal('agent_llm_apikey', llm.apiKey || '');
                setVal('agent_llm_model', llm.model || '');
                setVal('agent_llm_timeout', llm.timeout || '120000');
                setVal('agent_llm_maxtokens', llm.maxTokens || '131072');
            })
            .catch(function (e) {
                console.warn('[agent-frontend] 加载 LLM 配置失败', e);
            });
    }

    /** 收集 LLM 配置表单值 */
    function collectLlmConfig() {
        return {
            provider: ($('agent_llm_provider') && $('agent_llm_provider').value) || 'openai',
            baseUrl: ($('agent_llm_baseurl') && $('agent_llm_baseurl').value || '').trim(),
            apiKey: ($('agent_llm_apikey') && $('agent_llm_apikey').value || '').trim(),
            model: ($('agent_llm_model') && $('agent_llm_model').value || '').trim(),
            timeout: $('agent_llm_timeout') && $('agent_llm_timeout').value ? Number($('agent_llm_timeout').value) : 120000,
            maxTokens: $('agent_llm_maxtokens') && $('agent_llm_maxtokens').value ? Number($('agent_llm_maxtokens').value) : 131072,
        };
    }

    /** 保存 LLM 配置（保存后后端自动重建服务，无需重启） */
    function saveLlmConfig() {
        var cfg = collectLlmConfig();
        if (!cfg.model) {
            showToast('warning', '模型名（model）不能为空');
            return;
        }
        var btn = $('agent_llm_save');
        var btnHtml = btn ? btn.innerHTML : '';
        if (btn) btn.disabled = true;
        return agentFetch('/api/agent-theatre/llm-config', {
            method: 'POST',
            body: JSON.stringify(cfg),
        }).then(function (data) {
            var hint = $('agent_llm_hint');
            if (hint) { hint.style.display = 'block'; hint.textContent = data.message || '已保存'; }
            showToast('success', data.message || 'LLM 配置已保存并生效');
            if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
        }).catch(function (e) {
            showToast('error', '保存 LLM 配置失败: ' + e.message);
            if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
        });
    }

    /** 拉取可用模型列表，填充 datalist */
    function fetchLlmModels() {
        var cfg = collectLlmConfig();
        var btn = $('agent_llm_fetch_models');
        var btnHtml = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 获取中...'; }
        var hint = $('agent_llm_hint');
        if (hint) { hint.style.display = 'block'; hint.textContent = '正在拉取模型列表...'; }
        agentFetch('/api/agent-theatre/llm-models', {
            method: 'POST',
            body: JSON.stringify({ provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }),
        }).then(function (data) {
            var list = $('agent_llm_model_list');
            var modelEl = $('agent_llm_model');
            if (data.success && data.models && list && modelEl) {
                list.innerHTML = '';
                for (var i = 0; i < data.models.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = data.models[i];
                    list.appendChild(opt);
                }
                if (hint) { hint.textContent = '找到 ' + data.models.length + ' 个模型，点击模型名输入框可从下拉选择'; }
            } else {
                if (hint) { hint.textContent = data.error || '未获取到模型'; }
            }
            if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
        }).catch(function (e) {
            if (hint) { hint.textContent = '获取失败: ' + e.message; }
            showToast('error', '获取模型失败: ' + e.message);
            if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
        });
    }

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
        }).then(function () {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> 验证';
        }, function () {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-circle-check"></i> 验证';
        });
    }

    function saveFrontend() {
        // 已并入 saveAllSettings（统一保存：引擎 + 前端 URL 一次性提交）。
        // 保留为空壳并绑定到按钮，防止旧版 HTML 残留按钮失效。
        return saveAllSettings();
    }

    // ==================== 用户设定（GET/POST /api/user-profile） ====================

    /** 从 localStorage 读取用户设定缓存；无缓存或格式非法返回 null */
    function cachedUserProfile() {
        try {
            var raw = localStorage.getItem(LS_USER_PROFILE);
            if (!raw) return null;
            var p = JSON.parse(raw);
            if (!p || typeof p !== 'object') return null;
            return {
                name: typeof p.name === 'string' && p.name ? p.name : 'user',
                persona: typeof p.persona === 'string' ? p.persona : '',
            };
        } catch (_) { return null; }
    }

    /** 写入用户设定缓存（隐私模式等异常静默） */
    function cacheUserProfile(name, persona) {
        try {
            localStorage.setItem(LS_USER_PROFILE, JSON.stringify({ name: name, persona: persona }));
        } catch (_) { /* 静默 */ }
    }

    /** 填充用户设定表单（缺省回退 name=user，persona=''） */
    function fillUserProfileForm(profile) {
        profile = profile || {};
        var nameEl = $('user_profile_name');
        var personaEl = $('user_profile_persona');
        if (nameEl) nameEl.value = (typeof profile.name === 'string' && profile.name) ? profile.name : 'user';
        if (personaEl) personaEl.value = typeof profile.persona === 'string' ? profile.persona : '';
    }

    /** 收集用户设定表单值 */
    function collectUserProfile() {
        var nameEl = $('user_profile_name');
        var personaEl = $('user_profile_persona');
        return {
            name: ((nameEl && nameEl.value) || 'user').trim(),
            persona: (personaEl && personaEl.value || '').trim(),
        };
    }

    /**
     * 初始化加载：先用本地缓存即时填充表单，再以 GET /api/user-profile 后端为准刷新。
     * GET 失败（如后端旧版无该端点）静默降级——保留缓存/默认值，不弹错误。
     */
    function loadUserProfile() {
        var cached = cachedUserProfile();
        if (cached) fillUserProfileForm(cached);
        return agentFetch('/api/user-profile')
            .then(function (data) {
                if (data && data.success && data.profile) {
                    fillUserProfileForm(data.profile);
                    cacheUserProfile(data.profile.name, data.profile.persona);
                }
            })
            .catch(function (e) {
                console.warn('[agent-frontend] 加载用户设定失败（静默降级为默认/缓存值）', e);
            });
    }

    /** 保存用户设定；reset=true 时由重置流程调用（toast 文案区分） */
    function saveUserProfile(reset) {
        var profile = collectUserProfile();
        if (!profile.name) {
            showToast('warning', '角色名称不能为空（默认 user）');
            return Promise.resolve(false);
        }
        var btn = $('user_profile_save');
        var btnHtml = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...'; }
        return agentFetch('/api/user-profile', {
            method: 'POST',
            body: JSON.stringify(profile),
        }).then(function (data) {
            if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
            // 以后端回显为准（缺省回退本地表单值），并同步缓存
            var saved = (data && data.success && data.profile) ? data.profile : profile;
            fillUserProfileForm(saved);
            cacheUserProfile(saved.name, saved.persona);
            flashUserProfileSaved(btn);
            showToast('success', reset ? '已恢复默认设定' : '用户设定已保存（下次对话生效）');
            return true;
        }).catch(function (e) {
            if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
            showToast('error', '保存用户设定失败: ' + e.message);
            return false;
        });
    }

    /** 保存成功后按钮短暂显示「✓ 已保存」，1.5s 后复原 */
    function flashUserProfileSaved(btn) {
        if (!btn) return;
        var btnHtml = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> 已保存';
        setTimeout(function () { btn.innerHTML = btnHtml; }, 1500);
    }

    /** 重置：页内确认后填默认值并走保存逻辑 */
    function resetUserProfile() {
        agentConfirm('确定将用户设定恢复为默认？（角色名称 user，人设留空）', {
            title: '恢复默认用户设定',
            confirmText: '恢复默认',
        }).then(function (confirmed) {
            if (!confirmed) return;
            fillUserProfileForm({ name: 'user', persona: '' });
            return saveUserProfile(true);
        }).catch(function (e) {
            showToast('error', '操作中断: ' + (e && e.message ? e.message : String(e)));
        });
    }

    /** 绑定用户设定事件（init 中调用一次，不重复绑定） */
    function bindUserProfileEvents() {
        var saveBtn = $('user_profile_save');
        if (saveBtn) saveBtn.addEventListener('click', function () { saveUserProfile(false); });
        var resetBtn = $('user_profile_reset');
        if (resetBtn) resetBtn.addEventListener('click', resetUserProfile);
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

    // ==================== 手风琴设置面板 ====================

    var LS_ACCORDION = 'agent_accordion_open';
    var ACCORDION_SECTIONS = ['gw_body_connection', 'gw_body_agent', 'gw_body_llm', 'gw_body_profile', 'gw_body_user_profile', 'gw_body_regex'];

    function bindAccordion() {
        var toggles = document.querySelectorAll('.gateway-accordion-toggle');
        for (var i = 0; i < toggles.length; i++) {
            toggles[i].addEventListener('click', function () {
                var targetId = this.getAttribute('data-toggle');
                if (!targetId) return;
                var body = $(targetId);
                var arrow = this.querySelector('.gateway-collapse-arrow');
                if (!body) return;
                var willOpen = body.style.display === 'none';
                // 手风琴：先关闭所有主区块
                for (var j = 0; j < ACCORDION_SECTIONS.length; j++) {
                    var other = $(ACCORDION_SECTIONS[j]);
                    if (!other) continue;
                    if (other !== body) {
                        other.style.display = 'none';
                        var otherToggle = document.querySelector('.gateway-accordion-toggle[data-toggle="' + ACCORDION_SECTIONS[j] + '"]');
                        if (otherToggle) {
                            var otherArrow = otherToggle.querySelector('.gateway-collapse-arrow');
                            if (otherArrow) otherArrow.classList.remove('expanded');
                        }
                    }
                }
                // 切换目标区块
                body.style.display = willOpen ? 'block' : 'none';
                if (arrow) arrow.classList.toggle('expanded', willOpen);
                // 记忆展开状态
                try { localStorage.setItem(LS_ACCORDION, willOpen ? targetId : ''); } catch (_) { /* 静默 */ }
            });
        }
        // 恢复上次展开的区块
        var saved = null;
        try { saved = localStorage.getItem(LS_ACCORDION); } catch (_) { /* 静默 */ }
        if (saved && $(saved)) {
            // 先关闭所有
            for (var k = 0; k < ACCORDION_SECTIONS.length; k++) {
                var el = $(ACCORDION_SECTIONS[k]);
                if (el && el.id !== saved) {
                    el.style.display = 'none';
                    var t = document.querySelector('.gateway-accordion-toggle[data-toggle="' + ACCORDION_SECTIONS[k] + '"]');
                    if (t) { var a = t.querySelector('.gateway-collapse-arrow'); if (a) a.classList.remove('expanded'); }
                }
            }
            // 展开记忆的区块
            $(saved).style.display = 'block';
            var st = document.querySelector('.gateway-accordion-toggle[data-toggle="' + saved + '"]');
            if (st) { var sa = st.querySelector('.gateway-collapse-arrow'); if (sa) sa.classList.add('expanded'); }
        }
    }

    // ==================== 正则表达式管理 ====================

    var regexScripts = [];
    /** 当前正则列表视图对应的角色名（'' = 全局视图；非空 = 全局 + 该角色专属视图） */
    var regexViewCharacter = '';

    function loadRegexList(character) {
        // 角色隔离：有当前角色时后端只返回「全局 + 该角色专属」脚本，
        // 切换角色后前一角色的脚本立即从列表与应用中移除
        var url = '/api/agent-theatre/regex';
        var charName = character != null ? character : theatre.character || '';
        if (charName) url += '?character=' + encodeURIComponent(charName);
        agentFetch(url)
            .then(function (data) {
                if (data && data.success) {
                    regexScripts = data.scripts || [];
                    regexViewCharacter = charName;
                    renderRegexList();
                }
            })
            .catch(function (e) { console.warn('[regex] 加载列表失败', e); });
    }

    function renderRegexList() {
        var el = $('agent_regex_list');
        if (!el) return;
        var viewChar = regexViewCharacter;
        var header = '';
        if (viewChar) {
            header = '<div class="agent-regex-view-hint">当前生效：<b>全局</b> + 角色「' + esc(viewChar) + '」专属（已隔离其他角色）</div>';
        } else {
            header = '<div class="agent-regex-view-hint">未选择角色卡：仅显示<b>全局</b>正则。切换角色后自动过滤为「全局 + 当前角色」。</div>';
        }
        if (regexScripts.length === 0) {
            el.innerHTML = header + '<div class="gateway-empty-hint">（暂无正则脚本，点击「新建脚本」创建，或用「导入全部角色卡」批量导入）</div>';
            return;
        }
        var html = header;
        for (var i = 0; i < regexScripts.length; i++) {
            var s = regexScripts[i];
            var srcLabel = s.source === 'global' ? '全局' : '角色：' + String(s.source || '').replace(/^character:/, '');
            var srcCls = s.source && s.source !== 'global' ? 'character' : '';
            html += '<div class="agent-regex-item' + (s.disabled ? ' disabled' : '') + '" data-regex-id="' + esc(s.id) + '">';
            html += '<div class="agent-regex-item-header">';
            html += '<label class="agent-regex-switch"><input type="checkbox" data-regex-toggle="' + esc(s.id) + '"' + (s.disabled ? '' : ' checked') + '><span class="agent-regex-switch-slider"></span></label>';
            html += '<span class="agent-regex-item-name">' + esc(s.scriptName || '(未命名)') + '</span>';
            html += '<span class="agent-regex-source ' + srcCls + '" title="' + esc(s.source || '') + '">' + esc(srcLabel) + '</span>';
            html += '<button class="agent-icon-btn agent-regex-edit-btn" data-regex-edit="' + esc(s.id) + '" title="编辑"><i class="fa-solid fa-pen"></i></button>';
            html += '<button class="agent-icon-btn agent-regex-delete-btn" data-regex-delete="' + esc(s.id) + '" title="删除"><i class="fa-solid fa-trash"></i></button>';
            html += '</div>';
            html += '<div class="agent-regex-item-meta">';
            html += '<code>' + esc((s.findRegex || '').substring(0, 60)) + (s.findRegex && s.findRegex.length > 60 ? '…' : '') + '</code>';
            if (s.promptOnly) html += ' <span class="agent-regex-tag">仅提示词</span>';
            if (s.markdownOnly) html += ' <span class="agent-regex-tag">仅显示</span>';
            html += '</div>';
            html += renderRegexEditForm(s);
            html += '</div>';
        }
        el.innerHTML = html;
    }

    function renderRegexEditForm(s) {
        var isNew = !s || !s.id;
        var id = s ? s.id : '';
        // 类型（作用域）：global=全局（所有场景启用）；character:名称=仅对应角色启用
        var src = s && s.source ? s.source : '';
        var isGlobal = !src || src === 'global';
        var boundChar = src && src !== 'global' ? String(src).replace(/^character:/, '') : '';
        // 角色专属脚本只能属于绑定角色；非当前角色视图下不可篡改关联（radio 只读）
        var lockRole = !isGlobal && boundChar && boundChar !== (theatre.character || '');
        var typeRadios = '<div class="gateway-field"><label>类型（作用域）</label>'
            + '<div class="gateway-field-row">'
            + '<label class="checkbox-label"><input type="radio" name="regex_type_' + (id || 'new') + '" value="global" class="regex-field-type"' + (isGlobal ? ' checked' : '') + '> 全局（所有场景启用）</label>'
            + '<label class="checkbox-label"><input type="radio" name="regex_type_' + (id || 'new') + '" value="character" class="regex-field-type"' + (!isGlobal ? ' checked' : '') + (lockRole ? ' disabled' : '') + '> '
            + (lockRole ? '角色（' + esc(boundChar) + '）' : (theatre.character ? '角色（' + esc(theatre.character) + '）' : '角色（需先选择角色卡）'))
            + '</label>'
            + '</div>'
            + '<div class="agent-regex-type-hint">'
            + (isGlobal
                ? '全局正则：在所有角色卡下均保持启用，不受角色切换影响。'
                : (lockRole
                    ? '该脚本已绑定角色「' + esc(boundChar) + '」，仅在该角色激活时启用；切换角色后自动关闭。'
                    : '角色正则：仅当前激活角色「' + esc(theatre.character || '') + '」启用，切换角色后自动关闭。'))
            + '</div></div>';
        return '<div class="agent-regex-edit-form" id="regex_edit_' + (id || 'new') + '" style="display:none;">'
            + '<div class="gateway-field"><label>脚本名称</label>'
            + '<input type="text" class="text_pole regex-field-name" value="' + esc(s ? s.scriptName : '') + '" placeholder="如：过滤思考标签"></div>'
            + '<div class="gateway-field"><label>查找正则</label>'
            + '<input type="text" class="text_pole regex-field-find" value="' + esc(s ? s.findRegex : '') + '" placeholder="/pattern/gi"></div>'
            + '<div class="gateway-field"><label>替换字符串</label>'
            + '<input type="text" class="text_pole regex-field-replace" value="' + esc(s ? s.replaceString : '') + '" placeholder="替换文本（可用 $1 $2 {{match}}）"></div>'
            + typeRadios
            + '<div class="gateway-field-row">'
            + '<label class="checkbox-label"><input type="checkbox" class="regex-field-prompt"' + (s && s.promptOnly ? ' checked' : '') + '> 仅提示词</label>'
            + '<label class="checkbox-label"><input type="checkbox" class="regex-field-markdown"' + (s && s.markdownOnly ? ' checked' : '') + '> 仅显示</label>'
            + '<label class="checkbox-label"><input type="checkbox" class="regex-field-user"' + (s && (!s.placement || s.placement.indexOf(1) !== -1) ? ' checked' : '') + '> 用户输入</label>'
            + '<label class="checkbox-label"><input type="checkbox" class="regex-field-ai"' + (s && (!s.placement || s.placement.indexOf(2) !== -1) ? ' checked' : '') + '> AI输出</label>'
            + '</div>'
            + '<div class="agent-regex-error" style="display:none;"></div>'
            + '<div class="agent-regex-test-area">'
            + '<textarea class="text_pole regex-test-input" rows="2" placeholder="输入测试文本…"></textarea>'
            + '<div class="gateway-field-row" style="margin-top:4px;">'
            + '<button class="menu_button regex-btn-test"><i class="fa-solid fa-vial"></i> 测试</button>'
            + '<button class="menu_button gateway-save-btn regex-btn-save"><i class="fa-solid fa-floppy-disk"></i> 保存</button>'
            + '<button class="menu_button regex-btn-cancel">取消</button>'
            + '</div>'
            + '<div class="agent-regex-test-result" style="display:none;"></div>'
            + '</div>'
            + '</div>';
    }

    function toggleRegexEditForm(id) {
        // 关闭其他编辑表单
        var forms = document.querySelectorAll('.agent-regex-edit-form');
        for (var i = 0; i < forms.length; i++) {
            if (forms[i].id !== 'regex_edit_' + id) forms[i].style.display = 'none';
        }
        var form = $('regex_edit_' + id);
        if (form) {
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
            var item = form.closest('.agent-regex-item');
            if (item) item.classList.toggle('editing', form.style.display === 'block');
        }
    }

    function saveRegexScript(id) {
        var form = $('regex_edit_' + id);
        if (!form) return;
        var name = form.querySelector('.regex-field-name').value.trim();
        var find = form.querySelector('.regex-field-find').value.trim();
        var replace = form.querySelector('.regex-field-replace').value;
        var promptOnly = form.querySelector('.regex-field-prompt').checked;
        var markdownOnly = form.querySelector('.regex-field-markdown').checked;
        var userPlacement = form.querySelector('.regex-field-user').checked;
        var aiPlacement = form.querySelector('.regex-field-ai').checked;
        var errEl = form.querySelector('.agent-regex-error');

        if (!name) { if (errEl) { errEl.textContent = '脚本名称不能为空'; errEl.style.display = 'block'; } return; }
        if (!find) { if (errEl) { errEl.textContent = '查找正则不能为空'; errEl.style.display = 'block'; } return; }

        var placement = [];
        if (userPlacement) placement.push(1);
        if (aiPlacement) placement.push(2);
        if (placement.length === 0) placement = [1, 2];

        // 类型（作用域）：radio 选中 global -> 全局；选中 character -> 绑定当前角色。
        // 已有角色专属脚本且绑定角色非当前角色时 radio 为只读，保留原 source（不篡改关联）。
        var typeInput = form.querySelector('.regex-field-type:checked');
        var scope = typeInput ? typeInput.value : 'global';
        var prevSource = regexScripts.find(function (x) { return x.id === id; });
        var source = 'global';
        if (scope === 'character') {
            if (!theatre.character) {
                if (errEl) { errEl.textContent = '角色正则需先选择角色卡，请先在剧场选择角色再保存'; errEl.style.display = 'block'; }
                return;
            }
            source = 'character:' + theatre.character;
        } else if (prevSource && prevSource.source && prevSource.source !== 'global') {
            // 编辑已绑定的角色正则且用户未改为全局：保持原绑定角色不变
            source = prevSource.source;
        }

        var body = {
            scriptName: name,
            findRegex: find,
            replaceString: replace,
            promptOnly: promptOnly,
            markdownOnly: markdownOnly,
            placement: placement,
            trimStrings: [],
            disabled: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
            source: source,
        };

        var method = id && id !== 'new' ? 'PUT' : 'POST';
        var url = '/api/agent-theatre/regex' + (method === 'PUT' ? '/' + encodeURIComponent(id) : '');

        agentFetch(url, { method: method, body: JSON.stringify(body) })
            .then(function (data) {
                if (data.success) {
                    showToast('success', '正则脚本已保存');
                    loadRegexList();
                } else {
                    if (errEl) { errEl.textContent = data.error || '保存失败'; errEl.style.display = 'block'; }
                }
            })
            .catch(function (e) {
                if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
            });
    }

    function deleteRegexScript(id) {
        agentConfirm('确定删除此正则脚本？', { title: '删除正则脚本', confirmText: '删除', danger: true })
            .then(function (confirmed) {
                if (!confirmed) return;
                return agentFetch('/api/agent-theatre/regex/' + encodeURIComponent(id), { method: 'DELETE' });
            })
            .then(function (data) {
                if (!data) return;
                if (data.success) { showToast('success', '已删除'); loadRegexList(); }
                else showToast('error', data.error || '删除失败');
            })
            .catch(function (e) { showToast('error', '删除失败: ' + e.message); });
    }

    function toggleRegexScript(id, checked) {
        agentFetch('/api/agent-theatre/regex/' + encodeURIComponent(id), {
            method: 'PUT',
            body: JSON.stringify({ disabled: !checked }),
        }).then(function (data) {
            if (!data.success) { showToast('error', data.error || '切换失败'); loadRegexList(); }
        }).catch(function () { loadRegexList(); });
    }

    function testRegexScript(form) {
        var find = form.querySelector('.regex-field-find').value.trim();
        var replace = form.querySelector('.regex-field-replace').value;
        var testText = form.querySelector('.regex-test-input').value;
        var resultEl = form.querySelector('.agent-regex-test-result');
        var errEl = form.querySelector('.agent-regex-error');

        agentFetch('/api/agent-theatre/regex/test', {
            method: 'POST',
            body: JSON.stringify({ findRegex: find, replaceString: replace, testText: testText }),
        }).then(function (data) {
            if (errEl) errEl.style.display = 'none';
            if (data.success) {
                if (resultEl) {
                    resultEl.textContent = data.result || '(无匹配结果)';
                    resultEl.style.display = 'block';
                }
            } else {
                if (errEl) { errEl.textContent = data.error || '测试失败'; errEl.style.display = 'block'; }
                if (resultEl) resultEl.style.display = 'none';
            }
        }).catch(function (e) {
            if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
        });
    }

    function addNewRegexScript() {
        // 临时添加一条空记录用于编辑
        var tempId = 'new';
        var tempScript = { id: tempId, scriptName: '', findRegex: '', replaceString: '', promptOnly: false, markdownOnly: false, placement: [1, 2] };
        // 检查是否已有 new 表单
        if ($('regex_edit_new')) {
            toggleRegexEditForm('new');
            return;
        }
        var el = $('agent_regex_list');
        if (!el) return;
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        var div = document.createElement('div');
        div.className = 'agent-regex-item editing';
        div.setAttribute('data-regex-id', 'new');
        div.innerHTML = '<div class="agent-regex-item-header">'
            + '<span class="agent-regex-item-name">（新脚本）</span>'
            + '</div>'
            + renderRegexEditForm(tempScript);
        el.insertBefore(div, el.firstChild);
        $('regex_edit_new').style.display = 'block';
    }

    function importRegexFromCardUI() {
        if (!theatre.character) {
            showToast('warning', '请先选择角色卡');
            return;
        }
        agentFetch('/api/agent-theatre/regex/import-card', {
            method: 'POST',
            body: JSON.stringify({ character: theatre.character }),
        }).then(function (data) {
            if (data.success) {
                showToast('success', '从角色卡导入 ' + data.added + ' 个正则脚本' + (data.added === 0 ? '（角色卡无内嵌正则或已存在）' : ''));
                loadRegexList();
            } else {
                showToast('error', data.error || '导入失败');
            }
        }).catch(function (e) { showToast('error', '导入失败: ' + e.message); });
    }

    /** 一键导入全部角色卡的内嵌正则（每个角色卡独立标记 source=character:名称） */
    function importAllRegexFromCardsUI() {
        agentConfirm('将扫描全部角色卡并导入各自内嵌的正则脚本（已导入的不会重复添加）。继续？', {
            title: '批量导入正则脚本',
            confirmText: '开始导入',
        }).then(function (confirmed) {
            if (!confirmed) return;
            var btn = $('agent_regex_import_all');
            var btnHtml = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 导入中...'; }
            return agentFetch('/api/agent-theatre/regex/import-all', { method: 'POST' })
                .then(function (data) {
                    if (data.success) {
                        var detail = (data.characters && data.characters.length > 0)
                            ? data.characters.map(function (c) { return c.character + '(' + c.added + ')'; }).join('、')
                            : '（角色卡均无内嵌正则）';
                        showToast('success', '检查 ' + data.checked + ' 张角色卡，新增 ' + data.added + ' 个正则脚本');
                        if (data.added > 0) console.info('[regex] 导入明细: ' + detail);
                        loadRegexList();
                    } else {
                        showToast('error', data.error || '导入失败');
                    }
                })
                .catch(function (e) { showToast('error', '导入失败: ' + e.message); })
                .finally(function () {
                    if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
                });
        }).catch(function (e) {
            showToast('error', '操作中断: ' + (e && e.message ? e.message : String(e)));
        });
    }

    function bindRegexEvents() {
        var listEl = $('agent_regex_list');
        if (listEl) {
            listEl.addEventListener('click', function (e) {
                var editBtn = e.target.closest('[data-regex-edit]');
                if (editBtn) { toggleRegexEditForm(editBtn.getAttribute('data-regex-edit')); return; }
                var delBtn = e.target.closest('[data-regex-delete]');
                if (delBtn) { deleteRegexScript(delBtn.getAttribute('data-regex-delete')); return; }
                var testBtn = e.target.closest('.regex-btn-test');
                if (testBtn) { var form = testBtn.closest('.agent-regex-edit-form'); if (form) testRegexScript(form); return; }
                var saveBtn = e.target.closest('.regex-btn-save');
                if (saveBtn) { var form2 = saveBtn.closest('.agent-regex-edit-form'); if (form2) { var item = form2.closest('.agent-regex-item'); saveRegexScript(item ? item.getAttribute('data-regex-id') : 'new'); } return; }
                var cancelBtn = e.target.closest('.regex-btn-cancel');
                if (cancelBtn) { var form3 = cancelBtn.closest('.agent-regex-edit-form'); if (form3) form3.style.display = 'none'; var item3 = form3.closest('.agent-regex-item'); if (item3) item3.classList.remove('editing'); if (form3.id === 'regex_edit_new' && item3) item3.remove(); return; }
            });
            listEl.addEventListener('change', function (e) {
                var toggle = e.target.closest('[data-regex-toggle]');
                if (toggle) { toggleRegexScript(toggle.getAttribute('data-regex-toggle'), toggle.checked); }
            });
        }
        var addBtn = $('agent_regex_add');
        if (addBtn) addBtn.addEventListener('click', addNewRegexScript);
        var importBtn = $('agent_regex_import_card');
        if (importBtn) importBtn.addEventListener('click', importRegexFromCardUI);
        var importAllBtn = $('agent_regex_import_all');
        if (importAllBtn) importAllBtn.addEventListener('click', importAllRegexFromCardsUI);
        var refreshBtn = $('agent_regex_refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', function () { loadRegexList(); });
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
        'llm': '<h4>LLM 配置</h4>' +
            '<p>配置 Agent 运行所需的 LLM 服务，支持 OpenAI 兼容（含 DeepSeek / Ollama / vLLM）、Claude (Anthropic) 与 Gemini (Google)。</p>' +
            '<ul>' +
            '<li><b>Provider</b>：选择服务商类型；</li>' +
            '<li><b>Base URL</b>：接口基址，留空使用官方默认；</li>' +
            '<li><b>API Key</b>：鉴权密钥（脱敏显示，留脱敏串保存会自动保留原值）；</li>' +
            '<li><b>模型名</b>：实际使用的模型（必填）；</li>' +
            '<li><b>超时 / maxTokens</b>：请求超时毫秒数与回复 token 上限。</li>' +
            '</ul>' +
            '<p>「获取模型」用上方 Base URL / API Key 拉取可用模型列表；「保存 LLM 配置」立即生效，无需重启服务。</p>',
        'regex': '<h4>正则表达式</h4>' +
            '<p>正则脚本在消息发送/接收时自动应用文本替换，参考 SillyTavern 的 regex 扩展设计：</p>' +
            '<ul>' +
            '<li><b>类型（作用域）</b>：<b>全局</b>=所有角色卡下均启用，不受切换影响；<b>角色</b>=仅对应角色激活时启用，切换角色后立即关闭；</li>' +
            '<li><b>查找正则</b>：支持 <code>/pattern/flags</code> 格式（如 <code>/&lt;think&gt;.*?&lt;\\/think&gt;/gs</code>）；</li>' +
            '<li><b>替换字符串</b>：支持 <code>$1</code> <code>$2</code> 捕获组与 <code>{{match}}</code> 完整匹配；</li>' +
            '<li><b>仅提示词</b>：仅影响发送给 LLM 的文本（不修改显示）；</li>' +
            '<li><b>仅显示</b>：仅影响前端显示（不修改 LLM 提示词）；</li>' +
            '<li><b>用户输入 / AI输出</b>：选择正则应用位置。</li>' +
            '</ul>' +
            '<p><b>导入全部角色卡</b>：扫描角色卡目录，将各卡 <code>data.extensions.regex_scripts</code> 一键入库，' +
            '每张卡的脚本独立标记 <code>source=character:名称</code>，角色切换时仅「全局 + 当前角色」正则生效。</p>',
        'user-profile': '<h4>用户设定</h4>' +
            '<p>自定义你在 RP 中的角色名与用户人设：</p>' +
            '<ul>' +
            '<li><b>角色名称（name）</b>：你在 RP 中的角色名，默认 <code>user</code>；</li>' +
            '<li><b>用户人设（persona）</b>：填写后每轮对话把完整设定注入 LLM 上下文，留空则仅注入角色名。</li>' +
            '</ul>' +
            '<p>保存后由后端持久化，下次 LLM 交互即生效；「重置」恢复默认（名称 user，人设留空）。</p>',
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
        // P4: 当前会话最后保存/载入的服务器聊天文件（相对路径，按角色卡持久化到 localStorage）。
        // 后续保存携带 prevFile 覆盖同一文件，避免重复存档（同一会话出现多份记录）。
        chatFile: null,
        // P2: run 生命周期状态机：idle | running | aborting | aborted | completed | error
        // 由 SSE run_state 事件驱动（server/index.js 广播）
        runState: 'idle',
        // P3: 楼层模型：{ userMsg, pages: [], currentPage: 1, draftPage, failed }
        //   用户一句话 = 一个楼层；重试产物 = 该楼层 pages 的一页（可翻页）
        floors: [],
        // P3: 角色卡开场白（合并后的字符串数组）与当前索引（后端 selectGreeting 取模循环）
        greetings: [],
        greetingIndex: 0,
        // P2: 最近一次提示词构建时间（prompt_built 事件 / prompt 接口更新）
        promptBuiltAt: null,
    };

    var streaming = { runId: null, el: null, pendingFloorIdx: null };

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

        // P2: 提示词构建完成（theatreBroadcaster 广播），携带 prompt messages
        es.addEventListener('prompt_built', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handlePromptBuilt(data);
            } catch (e) { console.warn('[agent-frontend] prompt_built 解析失败', e); }
        });

        // P4: 保存状态（后端自动/手动保存后广播），同步保存指示器
        es.addEventListener('save_state', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleSaveState(data);
            } catch (e) { console.warn('[agent-frontend] save_state 解析失败', e); }
        });

        // P4: 聊天记录已载入（后端 load 后广播），刷新聊天区并重置保存状态
        es.addEventListener('chat_loaded', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleChatLoaded(data);
            } catch (e) { console.warn('[agent-frontend] chat_loaded 解析失败', e); }
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
        // P7: 先捕获楼层索引（finalizePendingOnComplete / discardPendingDraft 会清空 pendingFloorIdx）
        var flowFloorIdx = streaming.pendingFloorIdx;
        // P2: run 结束（completed/error）后刷新提示词查看器（若面板已打开）
        if (data.state === 'completed') {
            // P3: 兜底——result 未送达但有流式草稿时，把草稿 commit 为新页
            finalizePendingOnComplete();
            var v = $('agent_prompt_viewer');
            if (v && v.style.display !== 'none') fetchPrompt();
        } else if (data.state === 'aborted' || data.state === 'error') {
            // P3: 丢弃进行中的草稿页，避免楼层停留在「思考中」
            discardPendingDraft();
            var v2 = $('agent_prompt_viewer');
            if (v2 && v2.style.display !== 'none') fetchPrompt();
        }
        // P7: 执行流程栏状态跟随 run 状态机（running/aborting 归一为 running，其余原样）
        updateFlowStatus(flowFloorIdx, data.state);
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
        // P3: 楼层模式——流式写入进行中楼层的草稿页（更新已有气泡，不追加新气泡）
        if (streaming.pendingFloorIdx != null && theatre.floors[streaming.pendingFloorIdx]) {
            var floor = theatre.floors[streaming.pendingFloorIdx];
            floor.draftPage = (floor.draftPage || '') + data.delta;
            var latestPage = floor.pages.length + 1; // 草稿页位于最新页
            if (floor.currentPage !== latestPage) {
                // 流式中间态：若当前页不是最新页，切到最新页（用户看到重试结果）
                floor.currentPage = latestPage;
                updateFloorDom(streaming.pendingFloorIdx, true);
            } else {
                updateFloorBubbleText(streaming.pendingFloorIdx, floor.draftPage, true);
            }
            if (autoScroll) el.scrollTop = el.scrollHeight;
            return;
        }
        // 回退旧逻辑（无楼层数据的流式，如纯展示场景）
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
                var textEl = bubble.querySelector('.agent-chat-bubble-text');
                if (textEl) textEl.textContent += data.delta;
                else bubble.textContent += data.delta;
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

    // ==================== P3: 楼层模型（用户一句话 = 一个楼层，重试产物 = 楼层内多页） ====================

    /** 取楼层当前展示文本（优先草稿页，否则 pages[currentPage-1]） */
    function currentFloorText(floor) {
        if (floor.draftPage != null) return floor.draftPage;
        if (!floor.pages || floor.pages.length === 0) return '';
        var idx = (floor.currentPage || 1) - 1;
        if (idx < 0) idx = 0;
        if (idx >= floor.pages.length) idx = floor.pages.length - 1;
        return floor.pages[idx] || '';
    }

    function getFloorEl(floorIdx) {
        var el = $('agent_theatre_narrative');
        if (!el) return null;
        return el.querySelector('.agent-chat-floor[data-floor-idx="' + floorIdx + '"]');
    }

    /** 构建单个楼层 DOM：用户消息 + 当前页 AI 回复 */
    function buildFloorDom(floorIdx, streamingFlag) {
        var floor = theatre.floors[floorIdx];
        if (!floor) return null;
        var wrap = document.createElement('div');
        wrap.className = 'agent-chat-floor';
        wrap.setAttribute('data-floor-idx', String(floorIdx));
        if (floor.userMsg) wrap.appendChild(createUserMsg(floor.userMsg));

        // P7: 执行流程栏（用户消息之后、assistant 之前；有流程事件或运行中时插入）
        if ((floor.flow && floor.flow.length > 0) || floor.flowStatus === 'running') {
            wrap.appendChild(createRunFlowDom(floorIdx));
        }

        // 失败且无任何回复时，仅保留用户消息（不渲染空气泡）
        var showAssistant = true;
        if (floor.failed && floor.pages.length === 0 && !floor.draftPage) showAssistant = false;
        if (showAssistant) {
            var isDraft = !!streamingFlag && floor.draftPage != null;
            var content = isDraft ? (floor.draftPage || '') : currentFloorText(floor);
            var a = createAssistantMsg(content, streamingFlag, floorIdx);
            var needThinking = !floor.failed && ((isDraft && !floor.draftPage) ||
                (!isDraft && !floor.draftPage && floor.pages.length === 0 && floor.userMsg));
            if (needThinking) {
                a.classList.add('pending');
                var bubble = a.querySelector('.agent-chat-bubble');
                var textEl = bubble.querySelector('.agent-chat-bubble-text');
                var thinking = document.createElement('span');
                thinking.className = 'agent-chat-cursor';
                thinking.id = 'agent_theatre_cursor';
                thinking.textContent = '▍ Agent 思考中...';
                (textEl || bubble).appendChild(thinking);
            }
            wrap.appendChild(a);
        }
        return wrap;
    }

    /** 全量渲染消息流（清空 + 逐楼层重建；随后恢复开场白预览） */
    function renderFloors() {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        el.innerHTML = '';
        if (!theatre.floors || theatre.floors.length === 0) {
            el.innerHTML = '<div class="gateway-empty-hint">在下方输入消息开始 Agent RP（Enter 发送 / Shift+Enter 换行）</div>';
        } else {
            for (var i = 0; i < theatre.floors.length; i++) {
                var dom = buildFloorDom(i, false);
                if (dom) el.appendChild(dom);
            }
        }
        renderGreetingControls();
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    /** 局部重建单个楼层 DOM（翻页 / 流式切页时使用，不重建整个消息流） */
    function updateFloorDom(floorIdx, streamingFlag) {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var old = getFloorEl(floorIdx);
        var fresh = buildFloorDom(floorIdx, streamingFlag);
        if (!fresh) return;
        if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
        else el.appendChild(fresh);
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    /** 仅更新楼层 AI 气泡文本（流式增量，保留光标） */
    function updateFloorBubbleText(floorIdx, text, withCursor) {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var floorEl = getFloorEl(floorIdx);
        if (!floorEl) return;
        var a = floorEl.querySelector('.agent-chat-msg.assistant');
        if (!a) return;
        var bubble = a.querySelector('.agent-chat-bubble');
        if (!bubble) return;
        var c = bubble.querySelector('.agent-chat-cursor');
        if (c) c.remove();
        var textEl = bubble.querySelector('.agent-chat-bubble-text');
        if (textEl) textEl.textContent = text;
        else bubble.textContent = text;
        if (withCursor) appendCursor(bubble);
        if (autoScroll) el.scrollTop = el.scrollHeight;
    }

    /** 楼层翻页：‹ / › 切换该楼层 currentPage 并局部重渲染 */
    function flipFloor(floorIdx, dir) {
        var floor = theatre.floors[floorIdx];
        if (!floor || !floor.pages || floor.pages.length === 0) return;
        if (floor.draftPage != null) return; // 流式中禁止翻页
        var max = floor.pages.length;
        var cur = floor.currentPage || 1;
        cur = ((cur + dir - 1) % max + max) % max + 1;
        floor.currentPage = cur;
        updateFloorDom(floorIdx, false);
        saveChatHistory();
    }

    /** 发送失败 / run 未启动时回滚进行中的楼层写入 */
    function rollbackPendingSend() {
        if (streaming.pendingFloorIdx != null) {
            var floor = theatre.floors[streaming.pendingFloorIdx];
            if (floor) {
                floor.flowStatus = 'error'; // P7: 发送失败 / run 未启动 → 执行流程栏置出错
                floor.draftPage = null;
                if (floor.pages.length === 0 && !floor.userMsg) {
                    theatre.floors.pop();
                } else if (floor.pages.length === 0 && floor.userMsg) {
                    floor.failed = true;
                } else {
                    floor.currentPage = floor.pages.length;
                }
            }
            streaming.pendingFloorIdx = null;
        }
        removePendingPlaceholder();
        renderFloors();
    }

    /** run 中止/出错：丢弃进行中的草稿页，避免楼层停留在「思考中」 */
    function discardPendingDraft() {
        if (streaming.pendingFloorIdx == null) return;
        var floor = theatre.floors[streaming.pendingFloorIdx];
        if (floor) {
            floor.flowStatus = 'error'; // P7: run 中止/出错 → 执行流程栏置出错（handleRunState 随后按实际终态覆盖）
            floor.draftPage = null;
            if (floor.pages.length === 0 && !floor.userMsg) {
                theatre.floors.pop();
            } else if (floor.pages.length === 0 && floor.userMsg) {
                floor.failed = true;
            } else {
                floor.currentPage = floor.pages.length;
            }
        }
        streaming.pendingFloorIdx = null;
        renderFloors();
    }

    /** run_state completed 兜底：若有流式草稿内容则 commit 为新页（防止 agent_result 丢失）。
     *  无草稿或空草稿时保持 pendingFloorIdx，等 agent_result 正常 commit（修复流式未启用时文本丢失） */
    function finalizePendingOnComplete() {
        if (streaming.pendingFloorIdx == null) return;
        var floorIdx = streaming.pendingFloorIdx;
        var floor = theatre.floors[floorIdx];
        if (!floor) { streaming.pendingFloorIdx = null; return; }
        if (floor.draftPage != null) {
            if (floor.draftPage) {
                // 有流式草稿内容：commit 为新页，标记 finalized 防止晚到的 agent_result 重复追加
                floor.pages.push(floor.draftPage);
                floor.finalized = true;
            }
            floor.draftPage = null;
            floor.currentPage = floor.pages.length;
            streaming.pendingFloorIdx = null;
            updateFloorDom(floorIdx, false);
        }
        // 无草稿（undefined）：保持 pendingFloorIdx，等 agent_result 到达后正常 commit
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
        // P3: 楼层写入——进行中的草稿页 commit 为该楼层新页；无进行中写入时追加到最后一楼层
        if (streaming.pendingFloorIdx != null && theatre.floors[streaming.pendingFloorIdx]) {
            var floorIdx = streaming.pendingFloorIdx;
            var floor = theatre.floors[floorIdx];
            var finalText = (floor.draftPage != null && floor.draftPage) ? floor.draftPage : text;
            if (floor.draftPage != null) {
                floor.pages.push(finalText || '');
                floor.draftPage = null;
            } else if (floor.pages.length === 0 && finalText) {
                floor.pages.push(finalText);
            } else if (finalText && floor.pages[floor.pages.length - 1] !== finalText) {
                floor.pages.push(finalText);
            }
            floor.failed = false;
            floor.currentPage = floor.pages.length;
            updateFlowStatus(floorIdx, 'completed'); // P7: agent_result 兜底置 completed
            streaming.pendingFloorIdx = null;
            updateFloorDom(floorIdx, false);
        } else if (text) {
            if (theatre.floors.length === 0) {
                theatre.floors.push({ userMsg: '', pages: [text], currentPage: 1 });
            } else {
                var lf = theatre.floors[theatre.floors.length - 1];
                if (lf.finalized) {
                    // 已被 run_state completed 兜底 commit，晚到的 result 不再重复追加
                    lf.finalized = false;
                    // 兜底：finalizePendingOnComplete 因草稿为空未 push 时，补上 agent_result 文本
                    if (lf.pages.length === 0 && text) {
                        lf.pages.push(text);
                    }
                    lf.currentPage = lf.pages.length;
                } else {
                    lf.pages.push(text);
                    lf.currentPage = lf.pages.length;
                }
                lf.draftPage = null;
            }
            updateFlowStatus(theatre.floors.length - 1, 'completed'); // P7: agent_result 兜底置 completed
            renderFloors();
        }
        clearStreamingPreview();
        renderOptions(payload.result ? payload.result.options : []);
        if (payload.result && payload.result.state) renderStatePanel(payload.result.state);
        var turnInfo = $('agent_theatre_turn_info');
        if (turnInfo && payload.result && payload.result.meta) {
            turnInfo.textContent = '轮次 ' + (payload.result.meta.turn || '?') +
                ' · 视角 ' + (payload.result.meta.viewMode || '?') +
                ' · 文风 ' + (payload.result.meta.style || '-');
        }
        // P4: 收到 AI 回复（新消息产生）-> 标记未保存并延迟自动保存（防丢）
        if (text) scheduleAutoSave();
        // P3: 持久化楼层到 localStorage（修复刷新后历史丢失）
        saveChatHistory();
        if (payload.runId) fetchTimeline(payload.runId);
    }

    function handleAgentEvent(event) {
        if (!event) return;
        theatre.timelineEvents.push(event);
        appendTimelineItem(event);
        if ($('agent_theatre_show_events') && $('agent_theatre_show_events').checked) {
            appendInlineEvent(event);
        }
        // P7: 同步到当前轮次楼层的执行流程栏（实时展示调用状态 / 步骤顺序 / 关键节点）
        appendFlowEvent(streaming.pendingFloorIdx, event);
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
        // P3: 重置楼层模型与开场白索引
        theatre.floors = [];
        streaming.pendingFloorIdx = null;
        theatre.greetingIndex = 0;
        // 同时清除当前角色卡的本地聊天记录
        try { localStorage.removeItem(chatHistoryKey()); } catch (_) { /* 静默 */ }
        // 清空后下次保存视为新会话：不沿用旧文件，避免把新对话写进已清空的旧记录
        theatre.chatFile = null;
        renderFloors();
        // P4: 清空后无可保存内容，视为已保存
        markSaved();
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

    // ==================== P7: 执行流程栏（实时 agent 执行流程信息栏） ====================
    // 楼层数据：floor.flow[]（事件数组）、floor.flowStatus（idle/running/completed/aborted/error）、
    // floor.flowCollapsed。旧楼层（历史加载）可能无 flow，读取统一用 floor.flow || [] 容错。

    /** 取楼层当前 DOM 中的执行流程栏元素（无则 null） */
    function getFloorFlowEl(floorIdx) {
        var floorEl = getFloorEl(floorIdx);
        if (!floorEl) return null;
        return floorEl.querySelector('.agent-run-flow');
    }

    /** 状态徽标文案：running→执行中；completed→完成；aborted→已中止；error→出错；其余不显示 */
    function flowBadgeText(status) {
        switch (status) {
            case 'running': return '⏳ 执行中';
            case 'completed': return '✅ 完成';
            case 'aborted': return '⏹ 已中止';
            case 'error': return '❌ 出错';
            default: return '';
        }
    }

    /** 进度文案：执行中显示「已执行 N 个操作」，run 结束显示「共 N 个操作」 */
    function flowProgressText(floor) {
        var n = (floor.flow || []).length;
        var done = floor.flowStatus === 'completed' || floor.flowStatus === 'aborted' || floor.flowStatus === 'error';
        return (done ? '共 ' : '已执行 ') + n + ' 个操作';
    }

    /** 单条流程事件 DOM：EVENT_META 图标 + 标签 + 详情（tool/agent/label）+ 时间戳 */
    function createFlowItem(event) {
        var meta = EVENT_META[event.type] || { icon: '•', label: event.type, cls: 'other' };
        var item = document.createElement('div');
        item.className = 'agent-run-flow-item agent-run-flow-item-' + meta.cls;
        var icon = document.createElement('span');
        icon.className = 'agent-run-flow-item-icon';
        icon.textContent = meta.icon;
        item.appendChild(icon);
        var label = document.createElement('span');
        label.className = 'agent-run-flow-item-label';
        label.textContent = meta.label;
        item.appendChild(label);
        var detail = '';
        if (event.payload) {
            if (event.payload.tool) detail = event.payload.tool;
            else if (event.payload.agent) detail = event.payload.agent;
            else if (event.payload.label) detail = event.payload.label;
        }
        if (detail) {
            var dEl = document.createElement('span');
            dEl.className = 'agent-run-flow-item-detail';
            dEl.textContent = detail;
            dEl.title = detail;
            item.appendChild(dEl);
        }
        if (event.timestamp) {
            var tsEl = document.createElement('span');
            tsEl.className = 'agent-run-flow-item-ts';
            tsEl.textContent = new Date(event.timestamp).toLocaleTimeString();
            item.appendChild(tsEl);
        }
        return item;
    }

    /** 构建执行流程栏 DOM：头部（箭头 + 标题 + 状态徽标 + 进度）+ 事件主体 */
    function createRunFlowDom(floorIdx) {
        var floor = theatre.floors[floorIdx] || {};
        var flowEl = document.createElement('div');
        flowEl.className = 'agent-run-flow';
        flowEl.setAttribute('data-floor-idx', String(floorIdx));
        flowEl.setAttribute('data-flow-status', floor.flowStatus || '');
        if (floor.flowCollapsed) flowEl.classList.add('collapsed');

        var header = document.createElement('div');
        header.className = 'agent-run-flow-header';
        header.title = '点击展开/收起执行流程';
        var arrow = document.createElement('span');
        arrow.className = 'agent-run-flow-arrow';
        arrow.textContent = floor.flowCollapsed ? '▸' : '▾';
        var title = document.createElement('span');
        title.className = 'agent-run-flow-title';
        title.textContent = '🤖 执行流程';
        var badge = document.createElement('span');
        badge.className = 'agent-run-flow-badge';
        var bt = flowBadgeText(floor.flowStatus);
        if (bt) badge.textContent = bt;
        else badge.style.display = 'none';
        var progress = document.createElement('span');
        progress.className = 'agent-run-flow-progress';
        progress.textContent = flowProgressText(floor);
        header.appendChild(arrow);
        header.appendChild(title);
        header.appendChild(badge);
        header.appendChild(progress);

        var body = document.createElement('div');
        body.className = 'agent-run-flow-body';
        var flow = floor.flow || [];
        for (var i = 0; i < flow.length; i++) {
            body.appendChild(createFlowItem(flow[i]));
        }

        flowEl.appendChild(header);
        flowEl.appendChild(body);
        return flowEl;
    }

    /** 局部重建某楼层的执行流程栏（仅替换 .agent-run-flow，不触碰用户/assistant 气泡，避免打断流式） */
    function rebuildFloorFlow(floorIdx) {
        var floorEl = getFloorEl(floorIdx);
        if (!floorEl) return;
        var oldFlow = floorEl.querySelector('.agent-run-flow');
        if (oldFlow) oldFlow.remove();
        var floor = theatre.floors[floorIdx];
        if (!floor) return;
        if ((floor.flow && floor.flow.length > 0) || floor.flowStatus === 'running') {
            var flowEl = createRunFlowDom(floorIdx);
            var asst = floorEl.querySelector('.agent-chat-msg.assistant');
            if (asst && asst.parentNode) asst.parentNode.insertBefore(flowEl, asst);
            else floorEl.appendChild(flowEl);
        }
    }

    /** 把 agent_event 追加进当前轮次楼层的执行流程栏（按到达顺序 + 自动滚到底部） */
    function appendFlowEvent(floorIdx, event) {
        if (floorIdx == null || !event) return;
        var floor = theatre.floors[floorIdx];
        if (!floor) return;
        floor.flow = floor.flow || [];
        floor.flow.push(event);
        var flowEl = getFloorFlowEl(floorIdx);
        if (!flowEl) {
            // 兜底：楼层 DOM 尚无流程栏（事件先于 DOM 到达），局部重建楼层补上
            updateFloorDom(floorIdx, streaming.pendingFloorIdx === floorIdx);
            flowEl = getFloorFlowEl(floorIdx);
            if (!flowEl) return;
        }
        var body = flowEl.querySelector('.agent-run-flow-body');
        if (body) {
            body.appendChild(createFlowItem(event));
            body.scrollTop = body.scrollHeight; // 自动滚到底部
        }
        updateFlowProgress(flowEl, floor);
    }

    /** 更新流程栏进度文案（复用当前 DOM，不重建） */
    function updateFlowProgress(flowEl, floor) {
        if (!flowEl) return;
        var prog = flowEl.querySelector('.agent-run-flow-progress');
        if (prog) prog.textContent = flowProgressText(floor);
    }

    /** 执行流程栏状态跟随 run 状态机（running/aborting 归一为 running，其余原样）；completed 时进度显示总数 */
    function updateFlowStatus(floorIdx, state) {
        if (floorIdx == null) return;
        var floor = theatre.floors[floorIdx];
        if (!floor) return;
        floor.flowStatus = (state === 'running' || state === 'aborting') ? 'running' : state;
        var flowEl = getFloorFlowEl(floorIdx);
        if (!flowEl) return; // 楼层 DOM 中无流程栏（未到插入时机）时仅更新数据
        flowEl.setAttribute('data-flow-status', floor.flowStatus || '');
        var badge = flowEl.querySelector('.agent-run-flow-badge');
        var bt = flowBadgeText(floor.flowStatus);
        if (badge) {
            if (bt) { badge.textContent = bt; badge.style.display = ''; }
            else badge.style.display = 'none';
        }
        updateFlowProgress(flowEl, floor);
    }

    /** 点击流程栏头部：切换展开/收起 */
    function toggleFlowCollapsed(floorIdx) {
        var floor = theatre.floors[floorIdx];
        if (!floor) return;
        floor.flowCollapsed = !floor.flowCollapsed;
        var flowEl = getFloorFlowEl(floorIdx);
        if (!flowEl) return;
        flowEl.classList.toggle('collapsed', !!floor.flowCollapsed);
        var arrow = flowEl.querySelector('.agent-run-flow-arrow');
        if (arrow) arrow.textContent = floor.flowCollapsed ? '▸' : '▾';
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
        // P3: 携带开场白索引（后端 selectGreeting 支持 greetingIndex 取模循环）
        body.greetingIndex = theatre.greetingIndex || 0;
        var styleEl = $('agent_theatre_style');
        if (styleEl && styleEl.value) body.style = styleEl.value;

        var narrative = $('agent_theatre_narrative');
        if (narrative) {
            var empty = narrative.querySelector('.gateway-empty-hint');
            if (empty) empty.remove();
            // P3: 楼层模型——
            //   新输入：创建新楼层（用户消息），流式/结果写入该楼层；
            //   重跑：不创建新楼层，在最后一楼层开启「草稿页」，完成后 commit 为新页
            if (text && !options.rerun) {
                theatre.floors.push({
                    userMsg: text, pages: [], currentPage: 0,
                    flow: [], flowStatus: 'running', flowCollapsed: false, // P7: 执行流程栏
                });
                streaming.pendingFloorIdx = theatre.floors.length - 1;
                renderFloors();
                saveChatHistory(); // 持久化用户消息（刷新不丢）
            } else if (options.rerun && theatre.floors.length > 0) {
                var f = theatre.floors[theatre.floors.length - 1];
                f.draftPage = '';
                f.failed = false;
                f.flow = [];              // P7: 重跑清空上一轮执行流程
                f.flowStatus = 'running'; // P7: 重跑置 running
                f.flowCollapsed = false;  // P7: 重跑恢复展开
                streaming.pendingFloorIdx = theatre.floors.length - 1;
                f.currentPage = f.pages.length + 1; // 流式中间态：切到最新页（用户看到重试结果）
                // P7: 仅局部重建该楼层执行流程栏（不整楼重建，避免打断流式）
                rebuildFloorFlow(streaming.pendingFloorIdx);
            } else {
                // 兼容旧路径：无楼层数据时创建「思考中」占位 AI 气泡
                if (streaming.el && streaming.el.parentNode) streaming.el.remove();
                streaming.el = null;
                streaming.runId = null;
                var placeholder = createAssistantMsg('', false);
                placeholder.classList.add('pending');
                var bubble = placeholder.querySelector('.agent-chat-bubble');
                var textEl = bubble.querySelector('.agent-chat-bubble-text');
                var cursor = document.createElement('span');
                cursor.className = 'agent-chat-cursor';
                cursor.id = 'agent_theatre_cursor';
                cursor.textContent = '▍ Agent 思考中...';
                (textEl || bubble).appendChild(cursor);
                narrative.appendChild(placeholder);
                streaming.el = placeholder;
            }
            if (autoScroll) narrative.scrollTop = narrative.scrollHeight;
        }

        // P2: 本地状态机先进入 running（SSE run_state 事件随后到达驱动 UI，此处兜底保证按钮即时反应）
        theatre.runState = 'running';
        renderRunState();

        // P4: 用户发送消息（新消息产生）→ 标记未保存并延迟自动保存（防丢）
        scheduleAutoSave();

        agentFetch('/api/agent-theatre/input', {
            method: 'POST',
            body: JSON.stringify(body),
        }).then(function (data) {
            if (!data.success) {
                rollbackPendingSend();
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
            rollbackPendingSend();
            showToast('error', '发送失败: ' + e.message);
        });
    }

    // ==================== P6: 角色卡头像自动切换 ====================
    // 缓存：name -> { ok: bool, img: Image }。预载成功的直接复用（流畅无卡顿）；
    // 加载失败（JSON 卡 / 404 / 网络错误）标记 ok=false，后续直接降级默认头像。
    var avatarCache = {};

    /** 生成角色卡头像图片 URL（GET 支持 query token，img 标签无法带 header） */
    function characterAvatarUrl(name) {
        if (!name) return '';
        var url = gatewayUrl() + '/api/agent-theatre/character-image?name=' + encodeURIComponent(name);
        var token = gatewayToken();
        if (token) url += '&token=' + encodeURIComponent(token);
        return url;
    }

    /** 预加载角色卡头像（切卡前调用，保证切换瞬间即有图、无闪烁） */
    function preloadCharacterAvatar(name) {
        if (!name || avatarCache[name]) return;
        var img = new Image();
        avatarCache[name] = { ok: false, img: img };
        img.onload = function () { avatarCache[name].ok = true; };
        img.onerror = function () { /* 保持 ok=false，applyAvatar 据此降级 */ };
        img.src = characterAvatarUrl(name);
    }

    /** 头像降级为默认机器人图标 */
    function renderDefaultAvatar(avatarEl) {
        if (!avatarEl) return;
        if (avatarEl.querySelector('i')) return; // 已是默认图标
        avatarEl.innerHTML = '<i class="fa-solid fa-robot"></i>';
        delete avatarEl.dataset.avatarName;
    }

    /**
     * 把头像 div 渲染为当前角色卡图片；非 PNG / 加载失败时优雅降级为默认图标。
     * 已渲染同名头像且状态未变时跳过（避免重复操作）。
     */
    function applyAvatar(avatarEl, name) {
        if (!avatarEl) return;
        if (!name) { renderDefaultAvatar(avatarEl); return; }
        if (!avatarCache[name]) preloadCharacterAvatar(name);
        var entry = avatarCache[name];
        var img = entry && entry.img;
        if (!img) { renderDefaultAvatar(avatarEl); return; }

        if (avatarEl.querySelector('img.agent-avatar-img') &&
            avatarEl.dataset.avatarName === name && entry.ok) return;

        avatarEl.innerHTML = '';
        var el = document.createElement('img');
        el.className = 'agent-avatar-img';
        el.src = img.src;
        el.alt = '';
        el.onerror = function () {
            entry.ok = false;                 // 标记不可用，避免反复加载失败
            renderDefaultAvatar(avatarEl);    // 优雅降级为默认头像
        };
        avatarEl.appendChild(el);
        avatarEl.dataset.avatarName = name;
    }

    /** 更新消息流中所有 assistant 头像为当前角色卡头像（含开场白预览气泡） */
    function updateChatAvatars() {
        var name = theatre.character || '';
        if (name) preloadCharacterAvatar(name); // 预载，保证下次创建消息即用缓存
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var avatars = el.querySelectorAll('.agent-chat-msg.assistant .agent-chat-avatar');
        for (var i = 0; i < avatars.length; i++) applyAvatar(avatars[i], name);
    }

    /**
     * 创建 AI 消息结构：.agent-chat-msg.assistant > 头像 + 气泡
     * streamingFlag=true 时气泡带 .streaming class 并在末尾追加流式光标 ▍
     * P3: floorIdx 传入时，气泡内追加楼层翻页控件（多页回复时显示 "1/3" + ‹ ›）
     */
    function createAssistantMsg(text, streamingFlag, floorIdx) {
        var msg = document.createElement('div');
        msg.className = 'agent-chat-msg assistant' + (streamingFlag ? ' streaming' : '');
        var avatar = document.createElement('div');
        avatar.className = 'agent-chat-avatar';
        applyAvatar(avatar, theatre.character || ''); // P6: 角色卡为 PNG 时显示其头像，否则默认图标
        var bubble = document.createElement('div');
        bubble.className = 'agent-chat-bubble';
        if (streamingFlag) bubble.classList.add('streaming');
        var textEl = document.createElement('div');
        textEl.className = 'agent-chat-bubble-text';
        textEl.textContent = text || '';
        bubble.appendChild(textEl);
        if (streamingFlag) {
            appendCursor(bubble);
        } else {
            // 重试按钮：hover 显示，点击重跑上一轮（事件委托绑定在 narrative 上）
            var retry = document.createElement('button');
            retry.className = 'agent-chat-retry';
            retry.title = '重跑上一轮';
            retry.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 重试';
            bubble.appendChild(retry);
            // P3: 楼层翻页控件（pages.length > 1 时显示）
            if (floorIdx != null && theatre.floors && theatre.floors[floorIdx] &&
                theatre.floors[floorIdx].pages && theatre.floors[floorIdx].pages.length > 1) {
                var floor = theatre.floors[floorIdx];
                var pager = document.createElement('div');
                pager.className = 'agent-chat-floor-pager';
                var prev = document.createElement('button');
                prev.className = 'agent-chat-floor-nav agent-chat-floor-prev';
                prev.type = 'button';
                prev.setAttribute('data-floor-prev', String(floorIdx));
                prev.innerHTML = '&#8249;';
                var ind = document.createElement('span');
                ind.className = 'agent-chat-floor-indicator';
                ind.textContent = (floor.currentPage || 1) + '/' + floor.pages.length;
                var next = document.createElement('button');
                next.className = 'agent-chat-floor-nav agent-chat-floor-next';
                next.type = 'button';
                next.setAttribute('data-floor-next', String(floorIdx));
                next.innerHTML = '&#8250;';
                pager.appendChild(prev);
                pager.appendChild(ind);
                pager.appendChild(next);
                bubble.appendChild(pager);
            }
        }
        msg.appendChild(avatar);
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

    /** 创建用户消息 DOM（楼层渲染复用） */
    function createUserMsg(text) {
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
        return msg;
    }

    function appendUserMessage(text) {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        el.appendChild(createUserMsg(text));
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
            // P6: 初始角色卡确定后，刷新已渲染历史楼层/开场白预览头像（PNG 卡显示图片，JSON 卡默认）
            updateChatAvatars();
        }).catch(function (e) {
            console.warn('[agent-frontend] 加载角色卡/世界书列表失败', e);
        });
    }

    /** 将楼层模型序列化存入 localStorage（按角色卡隔离；含全部重试页面文本、翻页位置与服务器聊天文件） */
    function saveChatHistory() {
        var floors = theatre.floors || [];
        var history = [];
        for (var i = 0; i < floors.length; i++) {
            var f = floors[i];
            if (!f) continue;
            history.push({
                userMsg: f.userMsg || '',
                pages: (f.pages || []).slice(),
                currentPage: f.currentPage || (f.pages && f.pages.length ? 1 : 0),
            });
        }
        try {
            localStorage.setItem(chatHistoryKey(), JSON.stringify({
                v: 2,
                floors: history,
                chatFile: theatre.chatFile || null, // 记录已保存到的服务器文件，刷新后继续沿用同一文件
            }));
        } catch (e) {
            console.warn('[agent-frontend] 保存聊天记录失败', e);
        }
    }

    /** 旧历史格式 [{role,content}] → 楼层格式（user+assistant 配对成楼层，多 assistant 成为多页） */
    function legacyToFloors(history) {
        var floors = [];
        var cur = null;
        for (var i = 0; i < history.length; i++) {
            var item = history[i];
            if (!item || !item.role || !item.content) continue;
            if (item.role === 'user') {
                cur = { userMsg: item.content, pages: [], currentPage: 0 };
                floors.push(cur);
            } else if (item.role === 'assistant') {
                if (!cur) {
                    cur = { userMsg: '', pages: [], currentPage: 0 };
                    floors.push(cur);
                }
                cur.pages.push(item.content);
                cur.currentPage = cur.pages.length;
            }
        }
        return floors;
    }

    /** 从 localStorage 读取并恢复楼层消息流（兼容 v2 楼层格式与旧 {role,content} 格式） */
    function loadChatHistory() {
        var el = $('agent_theatre_narrative');
        if (!el) return;
        var raw = null;
        try { raw = localStorage.getItem(chatHistoryKey()); } catch (_) { /* 静默 */ }
        if (!raw) {
            theatre.floors = [];
            renderFloors();
            return;
        }
        var parsed;
        try { parsed = JSON.parse(raw) || {}; } catch (_) { parsed = {}; }
        var floors = [];
        if (parsed && parsed.v === 2 && Array.isArray(parsed.floors)) {
            floors = parsed.floors;
            for (var i = 0; i < floors.length; i++) {
                var f = floors[i];
                if (!f || typeof f !== 'object') continue;
                f.userMsg = f.userMsg || '';
                f.pages = Array.isArray(f.pages) ? f.pages : [];
                f.currentPage = f.currentPage || (f.pages.length > 0 ? 1 : 0);
                f.draftPage = null; // 不恢复进行中的草稿
            }
        } else if (Array.isArray(parsed)) {
            floors = legacyToFloors(parsed);
        }
        theatre.floors = floors;
        // 恢复当前角色卡最后保存的服务器聊天文件（若有），后续保存继续覆盖同一文件，避免重复存档
        theatre.chatFile = (parsed && typeof parsed === 'object' && parsed.chatFile) || null;
        renderFloors();
    }

    /**
     * P1-5: 服务重启后把本地楼层历史同步给服务端。
     * 后端仅当该会话历史为空（重启场景）时采纳，刷新页面后继续对话 LLM 上下文不丢。
     */
    function syncLocalHistoryToServer() {
        var floors = theatre.floors || [];
        var history = [];
        for (var i = 0; i < floors.length; i++) {
            var f = floors[i];
            if (!f) continue;
            if (f.userMsg) history.push({ role: 'user', content: f.userMsg });
            var page = (f.pages && f.pages.length > 0) ? f.pages[(f.currentPage || 1) - 1] : null;
            if (page) history.push({ role: 'assistant', content: page });
        }
        if (history.length === 0) return;
        agentFetch('/api/agent-theatre/history-sync', {
            method: 'POST',
            body: JSON.stringify({
                session: theatre.session || 'native:default',
                // P4-1: 历史按角色卡归槽，不同角色卡的本地历史互不串扰
                character: theatre.character || '',
                history: history,
            }),
        }).catch(function () { /* 同步失败不阻塞页面 */ });
    }

    /** 切换角色卡：保存当前记录 -> 淡出 -> 清空 DOM -> 加载新记录 -> 加载新角色卡开场白 -> 淡入 */
    function switchCharacter(name) {
        // 1. 保存当前角色卡的聊天记录（此时 theatre.character 仍为旧值）
        saveChatHistory();
        // P4: 切换前先把当前会话保存到服务器（后端也会自动保存，双保险）
        saveCurrentChat('switch');
        // 2. 淡出动画
        var narrative = $('agent_theatre_narrative');
        if (narrative) narrative.style.opacity = '0';
        // 3. 延迟后切换：更新角色卡 -> 重置楼层/开场白 -> 加载新记录 -> 加载新角色卡开场白
        setTimeout(function () {
            theatre.character = name;
            // P3: 重置楼层与开场白状态（新角色卡会话从零开始）
            theatre.floors = [];
            streaming.pendingFloorIdx = null;
            theatre.greetings = [];
            theatre.greetingIndex = 0;
            clearNarrativeDom();
            loadChatHistory();
            updateCharacterBadge();
            // P3: 拉取新角色卡的开场白（有则显示预览气泡 + 切换条）
            loadGreetings(name);
            // P6: 刷新消息流与开场白预览头像为当前角色卡图片（PNG），JSON 卡自动降级默认
            updateChatAvatars();
            // 正则隔离：切换角色后立即刷新正则列表为当前角色生效集合（global + 角色专属），
            // 前一角色的正则脚本从列表与应用中同步移除
            loadRegexList(name);
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
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v) || typeof v === 'object') return '\n' + toYaml(v, (indent || 0) + 1);
        if (typeof v === 'string') {
            if (v.indexOf('\n') !== -1) {
                // 多行字符串：输出为 YAML 字面块（|），后续行缩进 +1 层。
                // 否则裸拼多行会被后端手写 YAML 解析器误判为顶层列表/键，导致 name 字段丢失。
                var pad = '  '.repeat((indent || 0) + 1);
                return '|\n' + v.split('\n').map(function (l) { return pad + (l ? l : ''); }).join('\n');
            }
            return v;
        }
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
        }).then(function () {
            aiState.inFlight = false;
        }, function () {
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

    // ==================== P2: 提示词查看器 ====================

    function openPromptViewer() {
        var v = $('agent_prompt_viewer');
        if (v) v.style.display = 'flex';
        fetchPrompt();
    }

    function closePromptViewer() {
        var v = $('agent_prompt_viewer');
        if (v) v.style.display = 'none';
    }

    /** 主动拉取当前 session 的 prompt 并渲染（面板打开时） */
    function fetchPrompt() {
        var session = theatre.session || 'native:default';
        agentFetch('/api/agent-theatre/prompt?session=' + encodeURIComponent(session))
            .then(function (data) {
                if (data && data.success && data.prompt) {
                    renderPromptViewer(data.prompt);
                } else {
                    renderPromptEmpty();
                }
            })
            .catch(function () {
                renderPromptEmpty();
            });
    }

    /** SSE prompt_built 事件：面板打开时自动刷新 + 更新构建时间 */
    function handlePromptBuilt(data) {
        var promptObj = (data && data.prompt) || data || null;
        if (!promptObj || !promptObj.messages) return;
        if (promptObj.builtAt) theatre.promptBuiltAt = promptObj.builtAt;
        var v = $('agent_prompt_viewer');
        if (v && v.style.display !== 'none') {
            renderPromptViewer(promptObj);
        }
    }

    function promptRoleLabel(role) {
        if (role === 'user') return '用户输入';
        if (role === 'assistant') return 'AI 回复/开场白';
        if (role === 'system') return '系统提示';
        return role || '消息';
    }

    /** 启发式判断 system 段落类别：角色卡/世界书 / 记忆/文风 / 系统提示 */
    function promptSectionCategory(text) {
        var t = String(text || '');
        if (/角色描述|角色内嵌世界书|世界书|角色卡|人物设定|人物卡|persona|character\s*sheet/i.test(t)) {
            if (/记忆|文风|风格|style|memory/i.test(t)) return '记忆/文风';
            return '角色卡/世界书';
        }
        if (/记忆|文风|风格|style|memory/i.test(t)) return '记忆/文风';
        return '系统提示';
    }

    function formatPromptTime(t) {
        if (!t) return '';
        var d = new Date(t);
        if (isNaN(d.getTime())) return String(t);
        return d.toLocaleTimeString();
    }

    function promptSectionHtml(role, label, text, key) {
        return '<details class="agent-prompt-section agent-prompt-' + esc(role) + '" open>' +
            '<summary><span class="agent-prompt-tag agent-prompt-tag-' + esc(role) + '">' + esc(label) + '</span>' +
            '<span class="agent-prompt-role">' + esc(role) + '</span></summary>' +
            '<pre class="agent-prompt-pre">' + esc(text) + '</pre>' +
            '</details>';
    }

    /** 按 role 分组渲染 prompt.messages；system content 按 \n\n 分段并启发式打标签 */
    function renderPromptViewer(promptObj) {
        var body = $('agent_prompt_viewer_body');
        if (!body) return;
        var builtAtEl = $('agent_prompt_built_at');
        if (builtAtEl) {
            builtAtEl.textContent = promptObj && promptObj.builtAt ? ('构建于 ' + formatPromptTime(promptObj.builtAt)) : '';
        }
        var messages = (promptObj && promptObj.messages) || [];
        if (!messages.length) { renderPromptEmpty(); return; }
        var html = '';
        var seq = 0;
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            if (!m || !m.role) continue;
            var role = m.role;
            var content = m.content || '';
            if (role === 'system') {
                var segs = String(content).split(/\n{2,}/);
                for (var j = 0; j < segs.length; j++) {
                    var seg = segs[j];
                    if (!seg.trim()) continue;
                    html += promptSectionHtml(role, promptSectionCategory(seg), seg, 'sys' + seq++);
                }
            } else {
                html += promptSectionHtml(role, promptRoleLabel(role), content, role + i);
            }
        }
        body.innerHTML = html || '<div class="gateway-empty-hint">（提示词消息为空）</div>';
    }

    function renderPromptEmpty() {
        var body = $('agent_prompt_viewer_body');
        if (body) body.innerHTML = '<div class="gateway-empty-hint">暂无提示词记录，触发一次 Agent run 后自动出现</div>';
    }

    // ==================== P3: 角色卡开场白 ====================

    /** 当前选中开场白文本（greetingIndex 取模循环） */
    function currentGreetingText() {
        if (!theatre.greetings || !theatre.greetings.length) return '';
        var n = theatre.greetings.length;
        var idx = ((theatre.greetingIndex || 0) % n + n) % n;
        return theatre.greetings[idx] || '';
    }

    /** 会话是否已有消息（排除开场白预览自身） */
    function sessionHasMessages() {
        var el = $('agent_theatre_narrative');
        if (!el) return true;
        return el.querySelector('.agent-chat-floor') != null ||
            el.querySelector('.agent-chat-msg:not(.agent-greeting-preview)') != null;
    }

    /**
     * 确保开场白预览气泡存在（动态创建，不依赖 HTML 静态元素——
     * 静态元素会被 renderFloors / clearNarrativeDom 的 innerHTML 清空后丢失）。
     */
    function ensureGreetingPreview() {
        var preview = $('agent_greeting_preview');
        if (preview) return preview;
        preview = document.createElement('div');
        preview.id = 'agent_greeting_preview';
        preview.className = 'agent-chat-msg assistant agent-greeting-preview';
        preview.style.display = 'none';
        var avatar = document.createElement('div');
        avatar.className = 'agent-chat-avatar';
        avatar.innerHTML = '<i class="fa-solid fa-robot"></i>';
        var bubble = document.createElement('div');
        bubble.className = 'agent-chat-bubble';
        var badge = document.createElement('span');
        badge.className = 'agent-greeting-badge';
        badge.textContent = '开场白';
        var text = document.createElement('div');
        text.className = 'agent-chat-bubble-text';
        bubble.appendChild(badge);
        bubble.appendChild(text);
        preview.appendChild(avatar);
        preview.appendChild(bubble);
        return preview;
    }

    /** 渲染开场白切换条 + 预览气泡（仅在选择角色卡且会话刚开始时显示；隐藏时从消息流彻底移除） */
    function renderGreetingControls() {
        var narrative = $('agent_theatre_narrative');
        var bar = $('agent_greeting_bar');
        var hasG = !!(theatre.greetings && theatre.greetings.length);
        // 开场白只在「用户选择了角色卡」且「会话尚无任何消息」时显示：
        // 页面加载（角色卡为空 / 历史已恢复）时不自动出现，避免"自动添加聊天记录"的错觉。
        var show = hasG && !!theatre.character && !sessionHasMessages();
        if (bar) {
            if (show && theatre.greetings.length > 1) {
                bar.style.display = '';
                var ind = $('agent_greeting_indicator');
                if (ind) {
                    ind.textContent = '开场白 ' + ((theatre.greetingIndex % theatre.greetings.length) + 1) + '/' + theatre.greetings.length;
                }
            } else {
                bar.style.display = 'none';
            }
        }
        if (show) {
            var preview = ensureGreetingPreview();
            var t = preview.querySelector('.agent-chat-bubble-text');
            if (t) t.textContent = currentGreetingText();
            if (preview.parentNode !== narrative) {
                narrative.insertBefore(preview, narrative.firstChild);
            }
            preview.style.display = '';
            // 头像同步为当前角色卡（PNG 卡显示图片，JSON 卡降级默认）
            updateChatAvatars();
        } else {
            var existing = $('agent_greeting_preview');
            if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        }
    }

    /** 切换开场白索引（取模循环） */
    function flipGreeting(dir) {
        if (!theatre.greetings || !theatre.greetings.length) return;
        var n = theatre.greetings.length;
        theatre.greetingIndex = ((theatre.greetingIndex || 0) + dir) % n;
        if (theatre.greetingIndex < 0) theatre.greetingIndex += n;
        renderGreetingControls();
    }

    /** 拉取角色卡开场白列表并初始化 greetingIndex=0 */
    function loadGreetings(character) {
        if (!character) {
            theatre.greetings = [];
            theatre.greetingIndex = 0;
            renderGreetingControls();
            return;
        }
        var session = theatre.session || 'native:default';
        agentFetch('/api/agent-theatre/greetings?session=' + encodeURIComponent(session) +
            '&character=' + encodeURIComponent(character))
            .then(function (data) {
                if (theatre.character !== character) return; // 已切换角色卡，忽略过期响应
                var list = [];
                if (data && data.success) {
                    // 后端响应：{ success, character, firstMessage, alternateGreetings, greetings:[字符串数组] }
                    if (Array.isArray(data.greetings)) {
                        for (var i = 0; i < data.greetings.length; i++) {
                            var item = data.greetings[i];
                            if (typeof item === 'string' && item) {
                                list.push(item);
                            } else if (item && typeof item === 'object' && Array.isArray(item.greetings)) {
                                // 旧结构兼容：对象数组 {character, greetings:[...]}
                                if (item.character === character) {
                                    for (var k = 0; k < item.greetings.length; k++) {
                                        if (typeof item.greetings[k] === 'string') list.push(item.greetings[k]);
                                    }
                                }
                            }
                        }
                    }
                    // 兜底：仅 firstMessage 可用时作为唯一开场白
                    if (!list.length && data.firstMessage) list.push(data.firstMessage);
                }
                theatre.greetings = list;
                theatre.greetingIndex = 0;
                renderGreetingControls();
            })
            .catch(function () {
                if (theatre.character !== character) return;
                theatre.greetings = [];
                theatre.greetingIndex = 0;
                renderGreetingControls();
            });
    }

    // ==================== P4: 保存状态指示器 ====================

    /** 保存状态机：unsaved（未保存）| saving（保存中）| saved（已保存）| failed（保存失败） */
    var saveIndicator = {
        state: 'unsaved',
        dirtySince: null,   // 最近一次变为未保存的时间（30 分钟提醒基准）
        warnShown: false,   // 30 分钟提醒是否已弹（再次未保存后重置）
        saveTimer: null,    // 自动保存防抖计时器
        saving: false,      // 是否有保存请求在途
    };

    /** 格式化时钟 HH:MM:SS */
    function formatClock(d) {
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /** 更新指示器 DOM（data-state / 文本 / title），与状态机保持一致 */
    function setSaveIndicator(state, opts) {
        opts = opts || {};
        var el = $('agent_save_indicator');
        saveIndicator.state = state;
        if (!el) return;
        el.setAttribute('data-state', state);
        var textEl = el.querySelector('.agent-save-text');
        switch (state) {
            case 'unsaved':
                if (textEl) textEl.textContent = '未保存';
                el.title = '会话有未保存的更改';
                break;
            case 'saving':
                if (textEl) textEl.textContent = '保存中…';
                el.title = '正在保存到服务器';
                break;
            case 'saved':
                var t = opts.savedAt ? formatClock(new Date(opts.savedAt)) : formatClock(new Date());
                if (textEl) textEl.textContent = '已保存 ' + t;
                el.title = '已保存到服务器';
                break;
            case 'failed':
                if (textEl) textEl.textContent = '保存失败';
                el.title = '保存失败' + (opts.error ? '：' + opts.error : '');
                break;
        }
    }

    /** 标记未保存：记录 dirtySince、重置提醒标记、移除橙色警示 */
    function markDirty() {
        var now = Date.now();
        if (saveIndicator.state !== 'unsaved') {
            saveIndicator.dirtySince = now;
            saveIndicator.warnShown = false;
        } else if (!saveIndicator.dirtySince) {
            saveIndicator.dirtySince = now;
        }
        var el = $('agent_save_indicator');
        if (el) el.classList.remove('agent-save-warn');
        setSaveIndicator('unsaved');
    }

    /** 标记保存中 */
    function markSaving() { setSaveIndicator('saving'); }

    /** 标记已保存（savedAt 为后端返回的时间戳，缺省用当前时间） */
    function markSaved(savedAt) {
        var el = $('agent_save_indicator');
        if (el) el.classList.remove('agent-save-warn');
        saveIndicator.warnShown = true; // 已保存后无需再提醒
        setSaveIndicator('saved', { savedAt: savedAt });
    }

    /** 标记保存失败（err 写入 title 便于排查） */
    function markSaveFailed(err) {
        setSaveIndicator('failed', { error: err && err.message ? err.message : (err || '') });
    }

    /**
     * 收集当前会话历史 [{role, content}]：
     * 优先复用内存楼层模型（与 localStorage 的 agent_chat_history_ 结构同构，数据最新），
     * 楼层为空时兜底从聊天区 DOM 提取当前消息。
     */
    function collectHistoryForSave() {
        var history = [];
        var floors = theatre.floors || [];
        for (var i = 0; i < floors.length; i++) {
            var f = floors[i];
            if (!f) continue;
            if (f.userMsg) history.push({ role: 'user', content: f.userMsg });
            var pages = Array.isArray(f.pages) ? f.pages : [];
            for (var j = 0; j < pages.length; j++) {
                if (pages[j]) history.push({ role: 'assistant', content: pages[j] });
            }
            // 进行中的草稿页也一并保存（防丢）
            if (f.draftPage) history.push({ role: 'assistant', content: f.draftPage });
        }
        if (history.length === 0) {
            // DOM 兜底：遍历楼层消息；无楼层则遍历平铺消息
            var el = $('agent_theatre_narrative');
            if (el) {
                var floorEls = el.querySelectorAll('.agent-chat-floor');
                if (floorEls.length > 0) {
                    for (var k = 0; k < floorEls.length; k++) {
                        var ms = floorEls[k].querySelectorAll('.agent-chat-msg');
                        for (var m = 0; m < ms.length; m++) {
                            var h = extractMsgForSave(ms[m]);
                            if (h) history.push(h);
                        }
                    }
                } else {
                    var msgEls = el.querySelectorAll('.agent-chat-msg:not(.agent-greeting-preview)');
                    for (var n = 0; n < msgEls.length; n++) {
                        var h2 = extractMsgForSave(msgEls[n]);
                        if (h2) history.push(h2);
                    }
                }
            }
        }
        return history;
    }

    /** 从单个消息 DOM 提取 {role, content}（无有效角色/内容返回 null） */
    function extractMsgForSave(msgEl) {
        if (!msgEl) return null;
        var role = msgEl.classList.contains('user') ? 'user'
            : (msgEl.classList.contains('assistant') ? 'assistant' : null);
        if (!role) return null;
        var bubble = msgEl.querySelector('.agent-chat-bubble-text') || msgEl.querySelector('.agent-chat-bubble');
        if (!bubble) return null;
        var content = bubble.textContent.replace(/\s+$/g, '');
        if (!content) return null;
        return { role: role, content: content };
    }

    /**
     * 保存当前会话到服务器（POST /chats/save）。
     * trigger: 'auto'（自动）/ 'manual'（手动按钮）/ 'switch'（切换角色卡），仅手动保存弹 toast。
     * 保存携带 prevFile = 当前会话已保存到的服务器文件，覆盖式写入同一文件，避免重复存档。
     */
    function saveCurrentChat(trigger) {
        if (saveIndicator.saving) {
            if (trigger === 'manual') showToast('info', '正在保存中，请稍候');
            return;
        }
        var messages = collectHistoryForSave();
        if (messages.length === 0) {
            // 无可保存内容：视为已保存
            markSaved();
            return;
        }
        // 记录本次保存针对的角色卡：切换角色卡时旧会话的保存请求可能在切换完成后才返回，
        // 若期间角色卡已变化则不应把返回的文件写回新角色会话（否则会串档）。
        var savedForChar = theatre.character || '';
        var savedForFile = theatre.chatFile || null;
        saveIndicator.saving = true;
        markSaving();
        agentFetch('/api/agent-theatre/chats/save', {
            method: 'POST',
            body: JSON.stringify({
                character: savedForChar,
                messages: messages,
                userName: 'User',
                prevFile: savedForFile || undefined,
            }),
        }).then(function (data) {
            saveIndicator.saving = false;
            if (data && data.success) {
                if (data.file && theatre.character === savedForChar) {
                    theatre.chatFile = data.file;
                    saveChatHistory(); // 持久化已保存文件，刷新后继续沿用同一文件
                }
                markSaved(data.savedAt);
                if (trigger === 'manual') {
                    showToast('success', '聊天已保存（' + (data.messageCount || messages.length) + ' 条消息）');
                }
            } else {
                markSaveFailed((data && data.error) || '未知错误');
                if (trigger === 'manual') showToast('error', '保存失败: ' + ((data && data.error) || '未知错误'));
            }
        }).catch(function (e) {
            saveIndicator.saving = false;
            markSaveFailed(e.message);
            if (trigger === 'manual') showToast('error', '保存失败: ' + e.message);
        });
    }

    /** 消息变更后延迟触发自动保存（防抖：连续交互只保存最后一次） */
    function scheduleAutoSave() {
        markDirty();
        if (saveIndicator.saveTimer) clearTimeout(saveIndicator.saveTimer);
        saveIndicator.saveTimer = setTimeout(function () {
            saveIndicator.saveTimer = null;
            saveCurrentChat('auto');
        }, 3000);
    }

    /** 每分钟检查：unsaved 超过 30 分钟弹一次提醒并加橙色警示（不反复弹） */
    function startDirtyCheckTimer() {
        setInterval(function () {
            if (saveIndicator.state !== 'unsaved') return;
            if (!saveIndicator.dirtySince) return;
            if (Date.now() - saveIndicator.dirtySince <= 30 * 60 * 1000) return;
            if (saveIndicator.warnShown) return;
            saveIndicator.warnShown = true;
            showToast('info', '聊天已超过 30 分钟未保存，建议立即保存');
            var el = $('agent_save_indicator');
            if (el) el.classList.add('agent-save-warn');
        }, 60 * 1000);
    }

    /**
     * 页面关闭前尽力保存（后端定时保存兜底）。
     * 后端鉴权中间件仅对 GET 支持 query token，POST 必须带 X-Gateway-Token header，
     * 因此优先 fetch keepalive（可带 header，鉴权必然成功），
     * navigator.sendBeacon 作为 fetch 不可用时的兜底；两者均不可用则跳过。
     */
    function flushSaveBeforeUnload() {
        var messages = collectHistoryForSave();
        if (messages.length === 0) return;
        var body = JSON.stringify({
            character: theatre.character || '',
            messages: messages,
            userName: 'User',
            prevFile: theatre.chatFile || undefined, // 沿用当前会话已保存的文件，避免刷新产生重复存档
        });
        var base = gatewayUrl() + '/api/agent-theatre/chats/save';
        var token = gatewayToken();
        var fetchOk = false;
        try {
            var headers = { 'Content-Type': 'application/json' };
            if (token) headers['X-Gateway-Token'] = token;
            fetch(base, { method: 'POST', headers: headers, body: body, keepalive: true })
                .catch(function () { /* 静默：后端定时保存兜底 */ });
            fetchOk = true;
        } catch (_) { /* 走 sendBeacon 兜底 */ }
        if (fetchOk) return;
        if (typeof navigator.sendBeacon === 'function') {
            try {
                navigator.sendBeacon(base, new Blob([body], { type: 'application/json' }));
            } catch (_) { /* 静默 */ }
        }
    }

    // ==================== P4: SSE 联动 ====================

    /** SSE save_state：后端自动/手动保存后广播，同步指示器 */
    function handleSaveState(data) {
        if (!data || !data.state) return;
        if (data.state === 'saved') {
            saveIndicator.saving = false;
            markSaved(data.savedAt);
        } else if (data.state === 'save_failed') {
            saveIndicator.saving = false;
            markSaveFailed(data.error || '后端自动保存失败');
        }
    }

    /** SSE chat_loaded：载入历史后广播，拉取并刷新聊天区（防抖 1s 保证幂等） */
    var chatLoadedGuard = { file: null, at: 0 };
    function handleChatLoaded(data) {
        if (!data || !data.file) return;
        var now = Date.now();
        if (chatLoadedGuard.file === data.file && now - chatLoadedGuard.at < 1000) return;
        chatLoadedGuard.file = data.file;
        chatLoadedGuard.at = now;
        agentFetch('/api/agent-theatre/chats/read?file=' + encodeURIComponent(data.file))
            .then(function (resp) {
                var chat = (resp && resp.chat) || resp || {};
                if (chat && chat.messages) {
                    applyLoadedMessages(chat.messages, chat.character || data.character || '', data.file);
                }
            })
            .catch(function (e) { console.warn('[agent-frontend] chat_loaded 拉取历史失败', e); });
    }

    /** 把载入的消息应用到剧场会话（楼层模型 + 本地缓存 + 保存状态） */
    function applyLoadedMessages(messages, character, file) {
        theatre.floors = legacyToFloors(messages || []);
        streaming.pendingFloorIdx = null;
        theatre.greetings = [];
        theatre.greetingIndex = 0;
        if (character) {
            theatre.character = character;
            // 同步下拉框（程序化赋值不触发 change 事件，安全）；无该选项则置为不指定
            var charSel = $('agent_theatre_character');
            if (charSel) {
                var found = false;
                for (var i = 0; i < charSel.options.length; i++) {
                    if (charSel.options[i].value === character) { found = true; break; }
                }
                charSel.value = found ? character : '';
            }
        }
        clearNarrativeDom();
        renderFloors();
        updateCharacterBadge();
        // P6: 载入历史后刷新头像为载入记录的角色卡图片（PNG），JSON 卡自动降级默认
        updateChatAvatars();
        // 记录当前会话对应的服务器文件：后续保存覆盖同一文件，避免载入后再保存产生重复存档
        theatre.chatFile = file || null;
        saveChatHistory(); // 写回本地缓存，刷新页面后仍在
        markSaved();
    }

    // ==================== P4: 聊天记录管理面板 ====================

    var chatRecords = {
        page: 1,
        pageSize: 10,
        total: 0,
        items: [],
        selected: {},      // file -> true（跨页累积）
        previewOpen: null, // 当前展开预览的文件
        previews: {},      // file -> messages（懒加载缓存）
        loaded: false,     // 是否已首次加载（懒加载）
        loading: false,
        deleting: false,   // 批量删除进行中（重入保护，防止并发/重复提交）
    };

    /** 展开/收起聊天记录管理浮层；首次展开时懒加载列表 */
    function toggleChatRecords(forceOpen) {
        var panel = $('agent_chat_records_panel');
        if (!panel) return;
        var visible = panel.style.display !== 'none';
        // forceOpen=true 强制展开（如点击 header 按钮）；否则取反切换
        var open = (forceOpen === true) ? true : !visible;
        panel.style.display = open ? 'flex' : 'none';
        if (open && !chatRecords.loaded) {
            chatRecords.loaded = true;
            loadChatRecords();
        }
    }

    /** <input type="date"> 值（YYYY-MM-DD）→ 本地时区毫秒；startOfDay=true 取当天 00:00（from），false 取 23:59:59.999（to） */
    function dateInputToMs(val, startOfDay) {
        if (!val) return null;
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
        if (!m) return null;
        var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return startOfDay ? d.getTime() : d.getTime() + 24 * 60 * 60 * 1000 - 1;
    }

    /** ms → YYYY-MM-DD HH:mm */
    function formatChatTime(ms) {
        if (!ms) return '-';
        var d = new Date(ms);
        if (isNaN(d.getTime())) return '-';
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /** 加载列表（GET /chats），成功后渲染列表/分页并同步当前会话保存状态 */
    function loadChatRecords() {
        if (chatRecords.loading) return;
        chatRecords.loading = true;
        chatRecords.selected = {};
        chatRecords.previewOpen = null;
        chatRecords.previews = {}; // 清理预览缓存，避免长期使用内存膨胀
        renderChatListLoading();
        var params = [];
        var charInput = $('agent_chat_search_character');
        var kwInput = $('agent_chat_search_keyword');
        var character = (charInput && charInput.value || '').trim();
        var keyword = (kwInput && kwInput.value || '').trim();
        if (character) params.push('character=' + encodeURIComponent(character));
        if (keyword) params.push('keyword=' + encodeURIComponent(keyword));
        var fromMs = dateInputToMs($('agent_chat_search_from') && $('agent_chat_search_from').value, true);
        var toMs = dateInputToMs($('agent_chat_search_to') && $('agent_chat_search_to').value, false);
        if (fromMs != null) params.push('from=' + fromMs);
        if (toMs != null) params.push('to=' + toMs);
        params.push('page=' + chatRecords.page);
        params.push('pageSize=' + chatRecords.pageSize);
        agentFetch('/api/agent-theatre/chats?' + params.join('&'))
            .then(function (data) {
                chatRecords.loading = false;
                if (!data || !data.success) {
                    renderChatListError((data && data.error) || '加载失败');
                    return;
                }
                chatRecords.total = data.total || 0;
                chatRecords.items = data.items || [];
                chatRecords.page = data.page || chatRecords.page;
                renderChatList();
                renderChatPagination();
                updateSelectedUI();
                // 后端已按校验和合并内容重复的旧记录，这里给出可见提示
                var hintEl = $('agent_chat_dedup_hint');
                if (hintEl) {
                    hintEl.textContent = data.deduped > 0
                        ? '（已合并 ' + data.deduped + ' 条内容重复的旧存档，仅显示最新一份）'
                        : '';
                }
                // 同步当前会话保存状态（后端返回的 session 信息）
                syncSaveStateFromSession(data.session);
            })
            .catch(function (e) {
                chatRecords.loading = false;
                renderChatListError(e.message);
            });
    }

    /** 用后端 session 信息初始化/校正保存指示器（dirty=true 视为未保存，否则显示最近保存时间） */
    function syncSaveStateFromSession(session) {
        if (!session || saveIndicator.state === 'saving') return;
        if (session.dirty) {
            markDirty();
        } else if (session.savedAt) {
            markSaved(session.savedAt);
        }
    }

    function renderChatListLoading() {
        var listEl = $('agent_chat_list');
        if (listEl) listEl.innerHTML = '<div class="gateway-empty-hint"><i class="fa-solid fa-spinner fa-spin"></i> 加载中…</div>';
    }

    function renderChatListError(msg) {
        var listEl = $('agent_chat_list');
        if (listEl) listEl.innerHTML = '<div class="gateway-empty-hint">（加载失败：' + esc(msg) + '）</div>';
        renderChatPagination();
    }

    /** 渲染单个列表项 HTML（含选中态与预览展开区） */
    function buildChatRecordItemHtml(item) {
        var file = esc(item.file || '');
        var isSel = !!chatRecords.selected[item.file];
        var preview = (item.preview || '').replace(/\s+/g, ' ').trim();
        if (preview.length > 60) preview = preview.substring(0, 60) + '…';
        // 命名规则：角色卡名_保存时间（如 清月_2026-08-05 20:32），保证名称一致可读
        var displayName = (item.character || '未知') + '_' + formatChatTime(item.updatedAt);
        var detailHtml = '';
        if (chatRecords.previewOpen === item.file) {
            detailHtml = '<div class="agent-chat-record-detail">' + renderChatDetail(item.file) + '</div>';
        }
        return '' +
            '<div class="agent-chat-record-item' + (isSel ? ' selected' : '') + '" data-file="' + file + '">' +
            '<label class="agent-chat-record-check" title="选择该记录">' +
            '<input type="checkbox" class="agent-chat-item-check" data-file="' + file + '"' + (isSel ? ' checked' : '') + '>' +
            '</label>' +
            '<div class="agent-chat-record-main">' +
            '<div class="agent-chat-record-title">' +
            '<span class="agent-chat-record-char" title="' + esc(item.character || '未知') + '">🧩 ' + esc(displayName) + '</span>' +
            '<span class="agent-chat-record-count">' + (item.messageCount || 0) + ' 条消息</span>' +
            '</div>' +
            '<div class="agent-chat-record-preview" title="' + file + '">' + esc(preview || '（无内容预览）') + '</div>' +
            '<div class="agent-chat-record-actions">' +
            '<button type="button" class="menu_button agent-chat-act-btn" data-act="load" data-file="' + file + '"><i class="fa-solid fa-arrow-up-right-from-square"></i> 载入</button>' +
            '<button type="button" class="menu_button agent-chat-act-btn" data-act="preview" data-file="' + file + '"><i class="fa-solid fa-eye"></i> ' +
            (chatRecords.previewOpen === item.file ? '收起' : '预览') + '</button>' +
            '</div>' +
            '</div>' +
            detailHtml +
            '</div>';
    }

    /** 预览详情区：最近 10 条消息（正序展示） */
    function renderChatDetail(file) {
        var msgs = chatRecords.previews[file];
        if (!msgs) return '<div class="gateway-empty-hint"><i class="fa-solid fa-spinner fa-spin"></i> 加载中…</div>';
        if (msgs.length === 0) return '<div class="gateway-empty-hint">（无消息）</div>';
        var last10 = msgs.slice(-10);
        var html = '<div class="agent-chat-detail-list">';
        for (var i = 0; i < last10.length; i++) {
            var m = last10[i];
            var roleCls = m.role === 'user' ? 'user' : 'assistant';
            var name = m.role === 'user' ? '你' : (m.name || 'AI');
            html += '<div class="agent-chat-detail-msg ' + roleCls + '">' +
                '<span class="agent-chat-detail-role">' + esc(name) + '</span>' +
                '<span class="agent-chat-detail-content">' + esc(m.content || '') + '</span>' +
                '</div>';
        }
        html += '</div>';
        return html;
    }

    /** 全量重渲染列表（保留选中/预览状态），并刷新选中 UI */
    function rerenderListKeepSelection() {
        var listEl = $('agent_chat_list');
        if (!listEl) return;
        try {
            if (chatRecords.items.length === 0) {
                listEl.innerHTML = '<div class="gateway-empty-hint">（没有找到聊天记录）</div>';
            } else {
                var html = '';
                for (var i = 0; i < chatRecords.items.length; i++) {
                    html += buildChatRecordItemHtml(chatRecords.items[i]);
                }
                listEl.innerHTML = html;
            }
            updateSelectedUI();
        } catch (e) {
            // 渲染异常不向上抛（避免拖垮宿主渲染），降级为空态提示并记录
            console.error('[agent-frontend] 聊天记录列表渲染失败:', e);
            listEl.innerHTML = '<div class="gateway-empty-hint">（列表渲染失败：' + esc(e && e.message ? e.message : String(e)) + '）</div>';
        }
    }

    function renderChatList() {
        var listEl = $('agent_chat_list');
        if (!listEl) return;
        try {
            if (chatRecords.items.length === 0) {
                listEl.innerHTML = '<div class="gateway-empty-hint">（没有找到聊天记录）</div>';
                return;
            }
            var html = '';
            for (var i = 0; i < chatRecords.items.length; i++) {
                html += buildChatRecordItemHtml(chatRecords.items[i]);
            }
            listEl.innerHTML = html;
        } catch (e) {
            console.error('[agent-frontend] 聊天记录列表渲染失败:', e);
            listEl.innerHTML = '<div class="gateway-empty-hint">（列表渲染失败：' + esc(e && e.message ? e.message : String(e)) + '）</div>';
        }
    }

    /** 渲染分页信息与按钮禁用态 */
    function renderChatPagination() {
        var infoEl = $('agent_chat_page_info');
        var totalPages = Math.max(1, Math.ceil(chatRecords.total / chatRecords.pageSize));
        if (infoEl) infoEl.textContent = '第 ' + chatRecords.page + ' / ' + totalPages + ' 页';
        var prevBtn = $('agent_chat_page_prev');
        var nextBtn = $('agent_chat_page_next');
        if (prevBtn) prevBtn.disabled = chatRecords.page <= 1;
        if (nextBtn) nextBtn.disabled = chatRecords.page >= totalPages;
    }

    /** 更新全选框状态、选中计数与删除按钮 */
    function updateSelectedUI() {
        var count = 0;
        for (var key in chatRecords.selected) {
            if (chatRecords.selected[key]) count++;
        }
        var delBtn = $('agent_chat_delete_btn');
        if (delBtn) {
            delBtn.disabled = count === 0;
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i> 删除选中 (' + count + ')';
        }
        var countEl = $('agent_chat_selected_count');
        if (countEl) countEl.textContent = count > 0 ? '已选 ' + count + ' 项' : '';
        var selectAll = $('agent_chat_select_all');
        if (selectAll) {
            var checked = 0;
            for (var i = 0; i < chatRecords.items.length; i++) {
                if (chatRecords.selected[chatRecords.items[i].file]) checked++;
            }
            selectAll.checked = chatRecords.items.length > 0 && checked === chatRecords.items.length;
        }
    }

    /** 切换预览展开/收起；首次展开懒加载 read 详情 */
    function toggleChatPreview(file) {
        if (chatRecords.previewOpen === file) {
            chatRecords.previewOpen = null;
            rerenderListKeepSelection();
            return;
        }
        chatRecords.previewOpen = file;
        rerenderListKeepSelection();
        if (chatRecords.previews[file] === undefined) {
            agentFetch('/api/agent-theatre/chats/read?file=' + encodeURIComponent(file))
                .then(function (data) {
                    var chat = (data && data.chat) || data || {};
                    chatRecords.previews[file] = chat.messages || [];
                    if (chatRecords.previewOpen === file) rerenderListKeepSelection();
                })
                .catch(function () {
                    chatRecords.previews[file] = [];
                    if (chatRecords.previewOpen === file) rerenderListKeepSelection();
                });
        }
    }

    /** 载入记录（POST /chats/load），成功后刷新聊天区（后端同时广播 chat_loaded） */
    function loadChatRecord(file) {
        agentFetch('/api/agent-theatre/chats/load', {
            method: 'POST',
            body: JSON.stringify({ file: file }),
        }).then(function (data) {
            if (!data || !data.success) {
                showToast('error', '载入失败: ' + ((data && data.error) || '未知错误'));
                return;
            }
            applyLoadedMessages(data.messages || [], data.character || '', file);
            showToast('success', '已载入聊天记录（' + ((data.messages && data.messages.length) || 0) + ' 条消息）');
        }).catch(function (e) {
            showToast('error', '载入失败: ' + e.message);
        });
    }

    /** 批量删除选中的记录（页内确认对话框；带重入保护与按钮状态，避免并发/重复提交） */
    function deleteSelectedChats() {
        if (chatRecords.deleting) return; // 删除进行中：阻止重复触发
        var files = [];
        for (var key in chatRecords.selected) {
            if (chatRecords.selected[key]) files.push(key);
        }
        if (files.length === 0) return;
        agentConfirm('确定删除选中的 ' + files.length + ' 条聊天记录？此操作不可恢复。', {
            title: '删除聊天记录',
            confirmText: '确认删除',
            danger: true,
        }).then(function (confirmed) {
            if (!confirmed) return;
            chatRecords.deleting = true;
            var delBtn = $('agent_chat_delete_btn');
            if (delBtn) { delBtn.disabled = true; delBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 删除中…'; }
            agentFetch('/api/agent-theatre/chats/delete', {
                method: 'POST',
                body: JSON.stringify({ files: files }),
            }).then(function (data) {
                if (!data || !data.success) {
                    showToast('error', '删除失败: ' + ((data && data.error) || '未知错误'));
                    return;
                }
                showToast('success', '已删除 ' + (data.deleted || files.length) + ' 条聊天记录');
                // 记录已删除，立即清空选中态（避免残留计数与重复提交）
                chatRecords.selected = {};
                // 当前页被删空且非首页时回退一页
                if (chatRecords.items.length - (data.deleted || 0) <= 0 && chatRecords.page > 1) {
                    chatRecords.page--;
                }
                loadChatRecords();
            }).catch(function (e) {
                showToast('error', '删除失败: ' + e.message);
            }).finally(function () {
                chatRecords.deleting = false;
                updateSelectedUI(); // 恢复删除按钮的计数/禁用态
            });
        }).catch(function (e) {
            // 确认对话框异常也不应中断页面（兜底提示）
            showToast('error', '操作中断: ' + (e && e.message ? e.message : String(e)));
        });
    }

    /** 迁移旧版聊天记录（POST /chats/migrate） */
    function migrateChats() {
        var btn = $('agent_chat_migrate_btn');
        var oldHtml = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 迁移中…'; }
        agentFetch('/api/agent-theatre/chats/migrate', {
            method: 'POST',
        }).then(function (data) {
            if (data && data.success) {
                var migrated = data.migrated || 0;
                var skipped = data.skipped || 0;
                var errs = (data.errors && data.errors.length) || 0;
                var legacyDir = data.legacyDir || '';
                var msg;
                if (migrated > 0 || skipped > 0 || errs > 0) {
                    msg = '成功迁移 ' + migrated + ' 条';
                    if (skipped) msg += '，跳过 ' + skipped + ' 条（已存在）';
                    if (errs) msg += '，失败 ' + errs + ' 条';
                } else {
                    // 0 条 = 旧档目录不存在或没有可迁移的 .jsonl（含 ST 格式）文件
                    msg = '未发现可迁移的旧版聊天记录（旧档目录: ' + legacyDir + '）。';
                    msg += '请将旧版 .jsonl 聊天文件（含 SillyTavern 导出的）放入该目录后重试。';
                }
                showToast(errs ? 'warning' : (migrated > 0 ? 'success' : 'info'), msg);
                chatRecords.page = 1;
                loadChatRecords();
            } else {
                showToast('error', '迁移失败: ' + ((data && data.error) || '未知错误'));
            }
        }).catch(function (e) {
            showToast('error', '迁移失败: ' + e.message);
        }).then(function () {
            if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
        }, function () {
            if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
        });
    }

    /** 翻页 */
    function goChatPage(page) {
        var totalPages = Math.max(1, Math.ceil(chatRecords.total / chatRecords.pageSize));
        if (page < 1 || page > totalPages || page === chatRecords.page) return;
        chatRecords.page = page;
        loadChatRecords();
    }

    /** 绑定聊天记录面板交互（搜索/重置/分页/删除/迁移/列表委托） */
    function bindChatRecordsEvents() {
        // header 入口按钮：点击展开浮层（再点收起）
        var toggle = $('agent_chat_records_btn');
        if (toggle) toggle.addEventListener('click', function () { toggleChatRecords(); });

        // 浮层关闭按钮
        var closeBtn = $('agent_chat_records_close');
        if (closeBtn) closeBtn.addEventListener('click', function () { toggleChatRecords(false); });

        // 点击浮层遮罩（非面板本体）关闭
        var panel = $('agent_chat_records_panel');
        if (panel) panel.addEventListener('click', function (e) {
            if (e.target === panel) toggleChatRecords(false);
        });

        // Esc 键关闭浮层
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && panel && panel.style.display !== 'none') {
                toggleChatRecords(false);
            }
        });

        var searchBtn = $('agent_chat_search_btn');
        if (searchBtn) searchBtn.addEventListener('click', function () {
            chatRecords.page = 1;
            loadChatRecords();
        });

        // 角色卡名 / 关键词输入框回车触发搜索
        var searchInputs = ['agent_chat_search_character', 'agent_chat_search_keyword'];
        for (var i = 0; i < searchInputs.length; i++) {
            var inp = $(searchInputs[i]);
            if (inp) inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    chatRecords.page = 1;
                    loadChatRecords();
                }
            });
        }

        var resetBtn = $('agent_chat_search_reset');
        if (resetBtn) resetBtn.addEventListener('click', function () {
            ['agent_chat_search_character', 'agent_chat_search_from', 'agent_chat_search_to', 'agent_chat_search_keyword']
                .forEach(function (id) { var el = $(id); if (el) el.value = ''; });
            chatRecords.page = 1;
            loadChatRecords();
        });

        var prevBtn = $('agent_chat_page_prev');
        if (prevBtn) prevBtn.addEventListener('click', function () { goChatPage(chatRecords.page - 1); });
        var nextBtn = $('agent_chat_page_next');
        if (nextBtn) nextBtn.addEventListener('click', function () { goChatPage(chatRecords.page + 1); });

        var delBtn = $('agent_chat_delete_btn');
        if (delBtn) delBtn.addEventListener('click', deleteSelectedChats);

        var migrateBtn = $('agent_chat_migrate_btn');
        if (migrateBtn) migrateBtn.addEventListener('click', migrateChats);

        // 全选本页
        var selectAll = $('agent_chat_select_all');
        if (selectAll) selectAll.addEventListener('change', function () {
            for (var j = 0; j < chatRecords.items.length; j++) {
                var f = chatRecords.items[j].file;
                if (selectAll.checked) chatRecords.selected[f] = true;
                else delete chatRecords.selected[f];
            }
            rerenderListKeepSelection();
        });

        // 列表事件委托：载入 / 预览按钮
        var listEl = $('agent_chat_list');
        if (listEl) listEl.addEventListener('click', function (e) {
            var actBtn = e.target.closest('[data-act]');
            if (!actBtn) return;
            var act = actBtn.getAttribute('data-act');
            var file = actBtn.getAttribute('data-file');
            if (act === 'load') loadChatRecord(file);
            else if (act === 'preview') toggleChatPreview(file);
        });

        // 列表事件委托：行内复选框（选中高亮 + 更新全选/计数）
        if (listEl) listEl.addEventListener('change', function (e) {
            var cb = e.target.closest('.agent-chat-item-check');
            if (!cb) return;
            var file = cb.getAttribute('data-file');
            if (cb.checked) chatRecords.selected[file] = true;
            else delete chatRecords.selected[file];
            var itemEl = cb.closest('.agent-chat-record-item');
            if (itemEl) itemEl.classList.toggle('selected', cb.checked);
            updateSelectedUI();
        });
    }

    /** 绑定保存状态指示器交互（立即保存 + beforeunload 兜底保存） */
    function bindSaveIndicatorEvents() {
        var saveNowBtn = $('agent_save_now_btn');
        if (saveNowBtn) saveNowBtn.addEventListener('click', function () { saveCurrentChat('manual'); });
        window.addEventListener('beforeunload', flushSaveBeforeUnload);
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

        // AI 消息气泡「重试」按钮 + P3 楼层翻页箭头 + P7 执行流程栏展开/收起（事件委托）
        if (narrativeEl) narrativeEl.addEventListener('click', function (e) {
            // P7: 执行流程栏展开/收起（点击整条头部切换）
            var flowHeader = e.target.closest('.agent-run-flow-header');
            if (flowHeader) {
                var flowWrap = flowHeader.closest('.agent-run-flow');
                if (flowWrap) toggleFlowCollapsed(Number(flowWrap.getAttribute('data-floor-idx')));
                return;
            }
            // P3: 楼层翻页（‹ / ›）
            var prevBtn = e.target.closest('[data-floor-prev]');
            if (prevBtn) {
                flipFloor(Number(prevBtn.getAttribute('data-floor-prev')), -1);
                return;
            }
            var nextBtn = e.target.closest('[data-floor-next]');
            if (nextBtn) {
                flipFloor(Number(nextBtn.getAttribute('data-floor-next')), 1);
                return;
            }
            // 重试按钮：点击重跑上一轮（重试产物作为该楼层的新页，不新增楼层）
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
            // P1-1 修复：优先只传 callbackId（后端会映射回选项文本），
            // 避免同时传 input 文本导致 callbackId 被后端忽略。
            var cb = btn.getAttribute('data-callback');
            if (cb) {
                sendInput(null, cb);
            } else {
                sendInput(btn.getAttribute('data-text'), null);
            }
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

        // LLM 配置
        var llmSaveBtn = $('agent_llm_save');
        if (llmSaveBtn) llmSaveBtn.addEventListener('click', saveLlmConfig);
        var llmFetchBtn = $('agent_llm_fetch_models');
        if (llmFetchBtn) llmFetchBtn.addEventListener('click', fetchLlmModels);

        // P2: 提示词查看器
        var promptBtn = $('agent_prompt_viewer_btn');
        if (promptBtn) promptBtn.addEventListener('click', openPromptViewer);
        var promptClose = $('agent_prompt_viewer_close');
        if (promptClose) promptClose.addEventListener('click', closePromptViewer);
        var promptRefresh = $('agent_prompt_viewer_refresh');
        if (promptRefresh) promptRefresh.addEventListener('click', fetchPrompt);
        var promptBackdrop = $('agent_prompt_viewer');
        if (promptBackdrop) promptBackdrop.addEventListener('click', function (e) {
            if (e.target === promptBackdrop) closePromptViewer();
        });

        // P3: 开场白切换
        var gPrev = $('agent_greeting_prev');
        if (gPrev) gPrev.addEventListener('click', function () { flipGreeting(-1); });
        var gNext = $('agent_greeting_next');
        if (gNext) gNext.addEventListener('click', function () { flipGreeting(1); });
        var gSend = $('agent_greeting_send');
        if (gSend) gSend.addEventListener('click', function () {
            var text = currentGreetingText();
            if (!text) { showToast('warning', '暂无开场白文本'); return; }
            sendInput(text, null);
        });
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

        // 全局错误兜底（未捕获异常 / 未处理 Promise 拒绝 → toast 提示，避免外溢到宿主环境）
        bindGlobalErrorHandlers();

        var sessionEl = $('agent_theatre_session');
        if (sessionEl) theatre.session = sessionEl.value || 'native:default';
        var profileEl = $('agent_theatre_profile');
        if (profileEl) theatre.profile = profileEl.value || 'default-rp';

        bindCollapsibles();
        bindAccordion();
        bindRegexEvents();
        bindUserProfileEvents();
        bindModalEvents();
        bindDropdowns();
        bindDrawer();
        bindEvents();
        // P4: 聊天记录面板 + 保存状态指示器 + 30 分钟未保存提醒
        bindChatRecordsEvents();
        bindSaveIndicatorEvents();
        startDirtyCheckTimer();

        // 拉取设置并填充
        loadAllSettings().catch(function () { /* 已内部提示 */ });

        // 拉取 LLM 配置并填充
        loadLlmConfig();

        // 用户设定：先用本地缓存填充（即时反馈），再以后端为准刷新
        loadUserProfile();

        // 剧场初始化
        theatreReconnect();

        // 加载角色卡 / 世界书列表
        loadAssets();

        // 加载正则脚本列表
        loadRegexList();

        // 加载当前角色卡的本地聊天记录（若有）
        loadChatHistory();

        // P1-5: 服务重启后回填本地历史到服务端（服务端历史为空时采纳），保证 LLM 上下文连续
        syncLocalHistoryToServer();

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
