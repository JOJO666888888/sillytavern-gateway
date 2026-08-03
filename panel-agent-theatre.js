/**
 * Agent 剧场前端逻辑（Task 4.3-4.6）
 *
 * 功能：
 *   - EventSource 订阅 /api/agent-theatre/stream，实时正文流式追加
 *   - 状态面板渲染 state.visible（时间 / 地点 / 在场角色 / 各角色状态）
 *   - 时间线从 events 重建（工具调用 / 子代理 / 状态变更，不同图标）
 *   - 选项区点击即 POST /api/agent-theatre/input（带 callbackId）
 *   - 配置侧栏 YAML 编辑后 POST 保存，热重载（调 /api/agents 保存 + 通知引擎重载）
 *
 * 挂载方式：panel.html 在 "Agent 剧场" 区块展开且网关已连接时，动态注入本脚本。
 * 本脚本以 IIFE 形式自动初始化，依赖页面已存在的 DOM 元素：
 *   #gateway_theatre_* 系列元素 + 全局 gwFetch / esc / toastr 工具。
 *
 * 不依赖任何框架，原生 EventSource + fetch + DOM API，复用 style.css。
 */
(function () {
    'use strict';

    // 防止重复初始化（脚本被多次注入时跳过）
    if (window.__gatewayTheatreInit) return;
    window.__gatewayTheatreInit = true;

    // ==================== 工具函数 ====================

    /** 从 DOM 读取网关地址 */
    function gatewayUrl() {
        var el = document.getElementById('gateway_panel_url');
        return (el && el.value || 'http://127.0.0.1:3210').trim();
    }

    /** 从 DOM 读取鉴权 token */
    function gatewayToken() {
        var el = document.getElementById('gateway_panel_auth_token');
        return (el && el.value || '').trim();
    }

    /** 发起带鉴权的 API 请求，返回 JSON */
    function theatreFetch(endpoint, options) {
        options = options || {};
        var url = gatewayUrl() + endpoint;
        var token = gatewayToken();
        return fetch(url, Object.assign({}, options, {
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                token ? { 'X-Gateway-Token': token } : {},
                options.headers || {}
            )
        })).then(function (resp) {
            if (!resp.ok) {
                return resp.json().catch(function () { return {}; }).then(function (body) {
                    throw new Error(body.error || ('HTTP ' + resp.status));
                });
            }
            return resp.json();
        });
    }

    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function showToast(type, msg) {
        if (typeof toastr !== 'undefined') toastr[type](msg);
        else console.log('[' + type + ']', msg);
    }

    function $(id) { return document.getElementById(id); }

    // ==================== 状态 ====================

    var state = {
        eventSource: null,
        connected: false,
        currentRunId: null,
        lastResult: null,
        timelineEvents: [],  // 所有收到的事件，按 seq 排序
        profile: 'default-rp',
        session: 'native:default',
    };

    // 流式预览状态：token_delta 增量累积到正文区的"生成中"段落
    var streaming = {
        runId: null,
        el: null,
    };

    // ==================== SSE 订阅 ====================

    /** 建立 SSE 连接，订阅 AgentRunResult 流 */
    function connectStream() {
        if (state.eventSource) {
            try { state.eventSource.close(); } catch (_) { /* ignore */ }
        }
        var sessionKey = state.session || 'native:default';
        // EventSource 无法设置自定义 header，token 通过 query 传递（后端中间件已支持 GET query token）
        var url = gatewayUrl() + '/api/agent-theatre/stream?session=' + encodeURIComponent(sessionKey);
        var token = gatewayToken();
        if (token) url += '&token=' + encodeURIComponent(token);
        try {
            state.eventSource = new EventSource(url);
        } catch (e) {
            setStatus(false, 'SSE 不支持');
            return;
        }

        state.eventSource.addEventListener('open', function () {
            setStatus(true, '已连接');
        });

        state.eventSource.addEventListener('agent_result', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleAgentResult(data);
            } catch (e) { console.warn('[theatre] agent_result 解析失败', e); }
        });

        state.eventSource.addEventListener('agent_event', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleAgentEvent(data.event);
            } catch (e) { console.warn('[theatre] agent_event 解析失败', e); }
        });

        state.eventSource.addEventListener('state', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                renderStatePanel(data.state);
            } catch (e) { console.warn('[theatre] state 解析失败', e); }
        });

        // 流式 token 增量：Agent run 期间实时追加到正文区
        state.eventSource.addEventListener('token_delta', function (ev) {
            try {
                var data = JSON.parse(ev.data);
                handleTokenDelta(data);
            } catch (e) { console.warn('[theatre] token_delta 解析失败', e); }
        });

        state.eventSource.addEventListener('heartbeat', function () {
            // 心跳，无需处理
        });

        state.eventSource.addEventListener('error', function () {
            setStatus(false, '连接断开，3s 后重连');
            // EventSource 会自动重连，无需手动处理
        });
    }

    function setStatus(connected, msg) {
        state.connected = connected;
        var badge = $('gateway_theatre_status');
        if (badge) {
            badge.textContent = msg || (connected ? '已连接' : '未连接');
            badge.className = 'gateway-status-badge ' + (connected ? 'connected' : 'disconnected');
        }
        var stateBadge = $('gateway_theatre_state');
        if (stateBadge) stateBadge.textContent = connected ? '在线' : '离线';
    }

    // ==================== 处理 AgentRunResult ====================

    /**
     * 处理流式 token 增量：累积到正文区的"生成中"段落。
     * 新一轮 run 到来时重置预览；agent_result 落地后由 handleAgentResult 移除预览。
     */
    function handleTokenDelta(data) {
        if (!data || !data.delta) return;
        var el = $('gateway_theatre_narrative');
        if (!el) return;
        // 新一轮 run：重置流式预览
        if (data.runId !== streaming.runId) {
            streaming.runId = data.runId;
            if (streaming.el && streaming.el.parentNode) streaming.el.remove();
            streaming.el = null;
        }
        // 移除"思考中"光标（流式正文开始后不再需要）
        var cursor = $('gateway_theatre_cursor');
        if (cursor) cursor.remove();
        if (!streaming.el) {
            var empty = el.querySelector('.gateway-empty-hint');
            if (empty) empty.remove();
            var p = document.createElement('div');
            p.className = 'gateway-theatre-paragraph gateway-theatre-streaming';
            p.textContent = data.delta;
            el.appendChild(p);
            streaming.el = p;
        } else {
            streaming.el.textContent += data.delta;
        }
        el.scrollTop = el.scrollHeight;
    }

    /** 移除流式预览段落（agent_result 落地后调用，避免与完整正文重复） */
    function clearStreamingPreview() {
        if (streaming.el && streaming.el.parentNode) streaming.el.remove();
        streaming.el = null;
        streaming.runId = null;
    }

    function handleAgentResult(payload) {
        if (!payload) return;
        state.currentRunId = payload.runId;
        state.lastResult = payload.result;
        var text = payload.text || '';
        // 流式预览已实时渲染，落地时移除（避免与完整正文重复）
        clearStreamingPreview();
        // 追加正文（保留旧内容，新内容追加到末尾）
        appendNarrative(text);
        // 渲染选项
        renderOptions(payload.result ? payload.result.options : []);
        // 渲染状态
        if (payload.result && payload.result.state) {
            renderStatePanel(payload.result.state);
        }
        // 更新轮次
        var turnInfo = $('gateway_theatre_turn_info');
        if (turnInfo && payload.result && payload.result.meta) {
            turnInfo.textContent = '轮次 ' + (payload.result.meta.turn || '?') +
                ' · 视角 ' + (payload.result.meta.viewMode || '?') +
                ' · 文风 ' + (payload.result.meta.style || '-');
        }
        // 拉取历史事件重建时间线
        if (payload.runId) fetchTimeline(payload.runId);
    }

    function handleAgentEvent(event) {
        if (!event) return;
        state.timelineEvents.push(event);
        appendTimelineItem(event);
        // 内联事件流（在正文区下方显示工具调用）
        if ($('gateway_theatre_show_events') && $('gateway_theatre_show_events').checked) {
            appendInlineEvent(event);
        }
    }

    // ==================== 渲染：正文流 ====================

    function appendNarrative(text) {
        if (!text) return;
        var el = $('gateway_theatre_narrative');
        if (!el) return;
        // 清掉空提示
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        // 追加段落（按 \n\n 切分，每段一个 div）
        var paragraphs = String(text).split(/\n\n+/);
        for (var i = 0; i < paragraphs.length; i++) {
            if (!paragraphs[i].trim()) continue;
            var p = document.createElement('div');
            p.className = 'gateway-theatre-paragraph';
            p.textContent = paragraphs[i];
            el.appendChild(p);
        }
        // 滚动到底部
        el.scrollTop = el.scrollHeight;
    }

    function clearNarrative() {
        var el = $('gateway_theatre_narrative');
        if (el) el.innerHTML = '<div class="gateway-empty-hint">已清空，输入消息或点击选项重新开始</div>';
        var optEl = $('gateway_theatre_options');
        if (optEl) optEl.innerHTML = '<div class="gateway-empty-hint">（选项将在 Agent 输出后出现）</div>';
        var tlEl = $('gateway_theatre_timeline');
        if (tlEl) tlEl.innerHTML = '<div class="gateway-empty-hint">（事件流将在此显示）</div>';
        var inlineEl = $('gateway_theatre_events_inline');
        if (inlineEl) { inlineEl.innerHTML = ''; inlineEl.style.display = 'none'; }
        state.timelineEvents = [];
        clearStreamingPreview();
    }

    // ==================== 渲染：选项区 ====================

    function renderOptions(options) {
        var el = $('gateway_theatre_options');
        if (!el) return;
        if (!options || options.length === 0) {
            el.innerHTML = '<div class="gateway-empty-hint">（本轮无选项，可直接输入）</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < options.length; i++) {
            var o = options[i];
            html += '<button class="menu_button gateway-theatre-option-btn" ' +
                'data-callback="' + esc(o.callbackId || '') + '" ' +
                'data-text="' + esc(o.text || '') + '" ' +
                'title="点击提交此选项">' +
                '<b>' + esc(o.label || ('选项' + (i + 1))) + '</b>: ' + esc(o.text || '') +
                '</button>';
        }
        el.innerHTML = html;
    }

    // ==================== 渲染：状态面板 ====================

    function renderStatePanel(stateObj) {
        var el = $('gateway_theatre_state_panel');
        if (!el) return;
        if (!stateObj || !stateObj.visible) {
            el.innerHTML = '<div class="gateway-empty-hint">（无状态数据）</div>';
            return;
        }
        var v = stateObj.visible || {};
        var html = '';
        // 时间 / 地点
        if (v.time || v.location) {
            html += '<div class="gateway-theatre-state-row">';
            if (v.time) html += '<span class="gateway-theatre-state-tag">🕐 ' + esc(v.time) + '</span>';
            if (v.location) html += '<span class="gateway-theatre-state-tag">📍 ' + esc(v.location) + '</span>';
            html += '</div>';
        }
        // 在场角色
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
        // 场景
        if (v.scene) {
            html += '<div class="gateway-theatre-state-scene">';
            if (v.scene.beat) html += '<span>🎬 ' + esc(v.scene.beat) + '</span>';
            if (v.scene.goal) html += '<span>🎯 ' + esc(v.scene.goal) + '</span>';
            html += '</div>';
        }
        el.innerHTML = html || '<div class="gateway-empty-hint">（状态为空）</div>';
    }

    // ==================== 渲染：时间线 ====================

    /** 事件类型 → 图标 / 标签 映射 */
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
        var el = $('gateway_theatre_timeline');
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
        var el = $('gateway_theatre_events_inline');
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

    /** 从服务端拉取某 runId 的历史事件，重建时间线 */
    function fetchTimeline(runId) {
        if (!runId) return;
        theatreFetch('/api/agent-theatre/events/' + encodeURIComponent(runId) + '?limit=200')
            .then(function (data) {
                if (!data || !data.success || !data.events) return;
                // 重建时间线
                var el = $('gateway_theatre_timeline');
                if (el) el.innerHTML = '';
                state.timelineEvents = [];
                for (var i = 0; i < data.events.length; i++) {
                    appendTimelineItem(data.events[i]);
                }
            })
            .catch(function (e) {
                console.warn('[theatre] 拉取时间线失败', e);
            });
    }

    // ==================== 发送输入 / 触发 run ====================

    function sendInput(text, callbackId) {
        var sessionKey = (state.session || 'native:default');
        var body = {
            input: text || '',
            session: sessionKey,
            profile: state.profile,
        };
        if (callbackId) body.callbackId = callbackId;
        // 附加配置
        var styleEl = $('gateway_theatre_style');
        if (styleEl && styleEl.value) body.style = styleEl.value;

        // 在正文区追加用户消息
        if (text) appendUserMessage(text);

        // 显示"生成中"提示
        var narrative = $('gateway_theatre_narrative');
        if (narrative) {
            var empty = narrative.querySelector('.gateway-empty-hint');
            if (empty) empty.remove();
            var cursor = document.createElement('div');
            cursor.className = 'gateway-theatre-cursor';
            cursor.id = 'gateway_theatre_cursor';
            cursor.textContent = '▍ Agent 思考中...';
            narrative.appendChild(cursor);
            narrative.scrollTop = narrative.scrollHeight;
        }

        theatreFetch('/api/agent-theatre/input', {
            method: 'POST',
            body: JSON.stringify(body),
        }).then(function (data) {
            // 移除光标
            var c = $('gateway_theatre_cursor');
            if (c) c.remove();
            if (!data.success) {
                showToast('error', 'Agent run 失败: ' + (data.error || '未知错误'));
                return;
            }
            // handleAgentResult 会被 SSE 推送触发；这里兜底（无 SSE 时直接渲染）
            if (!state.connected) {
                handleAgentResult({
                    runId: data.runId,
                    result: data.result,
                    text: data.text,
                });
            }
        }).catch(function (e) {
            var c = $('gateway_theatre_cursor');
            if (c) c.remove();
            showToast('error', '发送失败: ' + e.message);
        });
    }

    function appendUserMessage(text) {
        var el = $('gateway_theatre_narrative');
        if (!el) return;
        var empty = el.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        var p = document.createElement('div');
        p.className = 'gateway-theatre-user-msg';
        p.textContent = '【你】' + text;
        el.appendChild(p);
        el.scrollTop = el.scrollHeight;
    }

    // ==================== Profile 加载 / 保存（热重载） ====================

    function loadProfileList() {
        theatreFetch('/api/agents').then(function (data) {
            if (!data || data.error) return;
            var sel = $('gateway_theatre_profile');
            if (!sel) return;
            var agents = data.agents || [];
            var current = sel.value || state.profile;
            sel.innerHTML = '';
            for (var i = 0; i < agents.length; i++) {
                var opt = document.createElement('option');
                opt.value = agents[i].name;
                opt.textContent = agents[i].displayName || agents[i].name;
                if (agents[i].name === current) opt.selected = true;
                sel.appendChild(opt);
            }
            if (agents.length > 0) {
                state.profile = sel.value;
                loadProfileYaml(sel.value);
            }
        }).catch(function (e) {
            console.warn('[theatre] 加载 Agent 列表失败', e);
        });
    }

    function loadProfileYaml(name) {
        if (!name) return;
        theatreFetch('/api/agents/' + encodeURIComponent(name)).then(function (def) {
            var yaml = toYaml(def);
            var ta = $('gateway_theatre_profile_yaml');
            if (ta) ta.value = yaml;
        }).catch(function (e) {
            console.warn('[theatre] 加载 Profile YAML 失败', e);
        });
    }

    function saveProfileYaml() {
        var name = state.profile;
        var yaml = ($('gateway_theatre_profile_yaml') || {}).value || '';
        if (!yaml.trim()) {
            showToast('warning', 'YAML 内容不能为空');
            return;
        }
        theatreFetch('/api/agents', {
            method: 'POST',
            body: JSON.stringify({ name: name, yaml: yaml }),
        }).then(function (data) {
            if (data.success) {
                showToast('success', 'Profile 已保存并热重载');
                var hint = $('gateway_theatre_save_hint');
                if (hint) {
                    hint.textContent = '✅ 已保存，引擎已热重载，会话不中断';
                    hint.style.display = 'block';
                    setTimeout(function () { hint.style.display = 'none'; }, 3000);
                }
            } else {
                showToast('error', '保存失败: ' + (data.error || '未知错误'));
            }
        }).catch(function (e) {
            showToast('error', '保存失败: ' + e.message);
        });
    }

    // ==================== 简易对象 → YAML（与 panel.html 中 toYaml 一致） ====================

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

    function yamlVal(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v) || typeof v === 'object') return '\n' + toYaml(v, 1);
        return String(v);
    }

    // ==================== 事件绑定 ====================

    function bindEvents() {
        // 发送按钮
        var sendBtn = $('gateway_theatre_send');
        if (sendBtn) sendBtn.addEventListener('click', function () {
            var input = $('gateway_theatre_input');
            var text = input ? input.value.trim() : '';
            if (!text) {
                showToast('warning', '请输入消息');
                return;
            }
            sendInput(text, null);
            if (input) input.value = '';
        });

        // 输入框 Ctrl+Enter 发送
        var inputEl = $('gateway_theatre_input');
        if (inputEl) inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (sendBtn) sendBtn.click();
            }
        });

        // 选项点击（事件委托）
        var optEl = $('gateway_theatre_options');
        if (optEl) optEl.addEventListener('click', function (e) {
            var btn = e.target.closest('.gateway-theatre-option-btn');
            if (!btn) return;
            var callbackId = btn.getAttribute('data-callback');
            var text = btn.getAttribute('data-text');
            sendInput(text, callbackId);
        });

        // 清空
        var clearBtn = $('gateway_theatre_clear');
        if (clearBtn) clearBtn.addEventListener('click', function () {
            clearNarrative();
        });

        // Profile 切换
        var profileSel = $('gateway_theatre_profile');
        if (profileSel) profileSel.addEventListener('change', function () {
            state.profile = this.value;
            loadProfileYaml(this.value);
        });

        // 会话切换
        var sessionEl = $('gateway_theatre_session');
        if (sessionEl) sessionEl.addEventListener('change', function () {
            state.session = this.value || 'native:default';
            connectStream();
        });

        // 保存热重载
        var saveBtn = $('gateway_theatre_save_profile');
        if (saveBtn) saveBtn.addEventListener('click', saveProfileYaml);
        var reloadBtn = $('gateway_theatre_reload_profile');
        if (reloadBtn) reloadBtn.addEventListener('click', function () {
            loadProfileYaml(state.profile);
        });
    }

    // ==================== 初始化 ====================

    function init() {
        // 读取初始 session
        var sessionEl = $('gateway_theatre_session');
        if (sessionEl) state.session = sessionEl.value || 'native:default';
        var profileEl = $('gateway_theatre_profile');
        if (profileEl) state.profile = profileEl.value || 'default-rp';

        bindEvents();
        // 加载 Profile 列表（如果网关已连接）
        if (gatewayUrl() && gatewayToken()) {
            loadProfileList();
        }
        // 建立 SSE 连接
        connectStream();
        // 加载当前会话状态
        theatreFetch('/api/agent-theatre/state?session=' + encodeURIComponent(state.session))
            .then(function (data) {
                if (data && data.success && data.active && data.lastResult) {
                    state.lastResult = data.lastResult;
                    handleAgentResult({
                        runId: data.lastRunId,
                        result: data.lastResult,
                        text: data.lastResult.artifacts && data.lastResult.artifacts[0] && data.lastResult.artifacts[0].text,
                    });
                }
            })
            .catch(function () { /* 静默 */ });

        console.log('[Gateway Theatre] 已初始化');
    }

    // 自动初始化（DOM 已就绪，因为本脚本在 panel.html 注入后才加载）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
