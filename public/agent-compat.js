/**
 * agent-compat.js —— SillyTavern 前端生态 → Agent 剧场 兼容层（ST 兼容，P0/P1）
 *
 * 适配而非重开发：不重写消息渲染，只做"标签解析 + 增量增强"。
 * 在 agent.js 之上以 hook（__agentCompat.onFloorsRendered / onAgentResult）驱动，
 * 通过 __agentBridge 与主界面交互（读楼层 / 截断 / 发消息）。
 *
 * 覆盖功能：
 *   - 前端卡：<maintext> 正文卡 / <option> 并入选项区 / <sum> 摘要 chip / <UpdateVariable> 隐藏
 *   - 状态栏：<stu> 文本 → 美化状态栏卡（N/100 进度条 + 键值网格）
 *   - MVU：消费服务端广播的 stat_data（variables），渲染变量状态面板
 *   - 小手机：右下角悬浮按钮 + 可展开面板（编年史 / 变量查看器 / 脚本库）
 *   - 读档：扫描 <sum> 楼层 → 弹窗选择 → 截断会话（本地楼层 + 服务端历史）
 *   - 编年史：R1 重构——由服务端「编年史子代理」每轮实时生成并广播（chronicle 字段），
 *     本层直接消费；localStorage 仅作刷新缓存，不再从楼层 <sum> 标签本地累积
 *   - 阅读模式：全屏 overlay 按楼层展示 <maintext> + <mission>
 *   - 变量查看器 overlay
 *   - 脚本库（对标酒馆助手 Tavern-Helper）：全局/角色脚本分类、新建/导入/编辑/保存/
 *     运行/按钮触发/版本回滚；服务端 Node vm 沙箱执行 + 酒馆助手兼容 API 桥
 *   - 初始化变量：粘贴初始 stat_data JSON → POST /api/agent-theatre/variables-set
 */
(function () {
    'use strict';

    var LS_COMPAT_KEY = 'agent_compat_prefs';
    var LS_CHRONICLE_PREFIX = 'agent_compat_chronicle_';
    var LS_URL = 'gateway_agent_url';
    var LS_TOKEN = 'gateway_agent_token';

    var state = {
        enabled: true,          // 前端卡模式开关
        mvu: { stat_data: {} }, // 最新 stat_data（来自 agent_result 广播）
        mvuHistory: [],         // 变量变更历史（最近 10 轮，来自 agent_result 广播）
        chronicle: [],          // 编年史（服务端子代理广播，localStorage 缓存）
        phoneOpen: false,
        scriptScope: 'global',  // 脚本库分类：global（全局）/ character（角色）
    };

    // ==================== 工具 ====================

    function $(id) { return document.getElementById(id); }

    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html !== undefined) n.innerHTML = html;
        return n;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function gw() {
        var url = (localStorage.getItem(LS_URL) || '').trim().replace(/\/+$/, '') || 'http://127.0.0.1:3210';
        var token = (localStorage.getItem(LS_TOKEN) || '').trim();
        return { url: url, token: token };
    }

    function sessionKey() {
        var s = $('agent_theatre_session');
        return (s && s.value) || 'native:default';
    }

    function apiPost(path, body) {
        var c = gw();
        return fetch(c.url + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Gateway-Token': c.token },
            body: JSON.stringify(body || {}),
        }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }

    function apiGet(path) {
        var c = gw();
        return fetch(c.url + path, {
            method: 'GET',
            headers: { 'X-Gateway-Token': c.token },
        }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }

    function apiPut(path, body) {
        var c = gw();
        return fetch(c.url + path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Gateway-Token': c.token },
            body: JSON.stringify(body || {}),
        }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }

    function apiDelete(path) {
        var c = gw();
        return fetch(c.url + path, {
            method: 'DELETE',
            headers: { 'X-Gateway-Token': c.token },
        }).then(function (r) { return r.json().catch(function () { return {}; }); });
    }

    function loadPrefs() {
        try {
            var raw = localStorage.getItem(LS_COMPAT_KEY);
            if (raw) state.enabled = (JSON.parse(raw).enabled !== false);
        } catch (_) { /* 忽略 */ }
    }
    function savePrefs() {
        try { localStorage.setItem(LS_COMPAT_KEY, JSON.stringify({ enabled: state.enabled })); } catch (_) { /* 忽略 */ }
    }

    // ==================== 标签解析 ====================

    function parseTags(text) {
        var r = { mainText: '', options: [], sums: [], stu: '', analysis: '', mission: '', updateBlock: '', hasTags: false, raw: text || '' };
        if (!text) return r;
        var mm = text.match(/<maintext>([\s\S]*?)<\/maintext>/gi);
        if (mm && mm.length) r.mainText = mm[mm.length - 1].replace(/<\/?maintext>/gi, '').trim();
        var om = text.match(/<option>([\s\S]*?)<\/option>/gi);
        if (om && om.length) {
            var lines = om[om.length - 1].replace(/<\/?option>/gi, '').split('\n');
            for (var i = 0; i < lines.length; i++) {
                var s = lines[i].trim();
                if (!s) continue;
                var m = s.match(/^\s*(?:\d+[.、]|>\s*选项\s*[一二三四五六七八九十\d]+\s*[：:])\s*(.+)$/);
                r.options.push(m ? m[1].trim() : s);
            }
        }
        var sm = text.match(/<sum>([\s\S]*?)<\/sum>/gi);
        if (sm && sm.length) {
            for (var j = 0; j < sm.length; j++) r.sums.push(sm[j].replace(/<\/?sum>/gi, '').trim());
        }
        var st = text.match(/<stu>([\s\S]*?)<\/stu>/i);
        if (st) r.stu = st[1].trim();
        var am = text.match(/<Analysis>([\s\S]*?)<\/Analysis>/i);
        if (am) r.analysis = am[1].trim();
        var mi = text.match(/<mission>([\s\S]*?)<\/mission>/i);
        if (mi) r.mission = mi[1].trim();
        var um = text.match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
        if (um) r.updateBlock = um[0];
        r.hasTags = !!(r.mainText || r.options.length || r.sums.length || r.stu || r.updateBlock || r.analysis || r.mission);
        return r;
    }

    /** 折叠为可读文本（去换行压缩，用于读档列表） */
    function summarize(text, max) {
        var t = String(text || '').replace(/\s+/g, ' ').trim();
        return t.length > max ? t.slice(0, max) + '…' : t;
    }

    // ==================== 状态栏卡（<stu> → HTML） ====================

    function renderStatusBar(stuText) {
        if (!stuText) return '';
        var lines = String(stuText).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var html = '<div class="th-statusbar"><div class="th-statusbar-title">📊 状态栏</div><div class="th-statusbar-grid">';
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            // 支持 "key：value" 与 "key: value"（全角/半角冒号）
            var m = line.match(/^([^：:]{1,24})[：:]\s*(.+)$/);
            if (!m) {
                // 分段标题（如【玩家状态】）或纯文本行
                if (/^【.+】$/.test(line)) html += '<div class="th-statusbar-section">' + esc(line) + '</div>';
                else html += '<div class="th-statusbar-line">' + esc(line) + '</div>';
                continue;
            }
            var key = m[1].trim();
            var val = m[2].trim();
            // N/100 或 N/M 进度条
            var pm = val.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
            if (pm) {
                var pct = Math.max(0, Math.min(100, (Number(pm[1]) / Number(pm[2])) * 100));
                html += '<div class="th-statusbar-field"><span class="th-statusbar-key">' + esc(key) + '</span>' +
                    '<div class="th-statusbar-track"><div class="th-statusbar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>' +
                    '<span class="th-statusbar-val">' + esc(val) + '</span></div>';
            } else {
                html += '<div class="th-statusbar-field"><span class="th-statusbar-key">' + esc(key) + '</span>' +
                    '<span class="th-statusbar-val">' + esc(val) + '</span></div>';
            }
        }
        html += '</div></div>';
        return html;
    }

    // ==================== 楼层富渲染 ====================

    function currentFloorRawText(floor) {
        if (!floor) return '';
        if (floor.draftPage) return floor.draftPage;
        var pages = floor.pages || [];
        if (pages.length === 0) return '';
        var idx = Math.min((floor.currentPage || 1) - 1, pages.length - 1);
        return pages[idx] || '';
    }

    /** 原文折叠 toggle（富卡渲染共用） */
    function appendRawToggle(bubble, textEl) {
        if (!bubble) return;
        var toggle = el('button', 'th-raw-toggle', '查看原文');
        toggle.type = 'button';
        toggle.addEventListener('click', function (ev) {
            var t = ev.target;
            var txt = t.parentNode.querySelector('.agent-chat-bubble-text');
            if (txt) {
                var hidden = txt.style.display === 'none';
                txt.style.display = hidden ? '' : 'none';
                t.textContent = hidden ? '隐藏原文' : '查看原文';
            }
        });
        bubble.appendChild(toggle);
        if (textEl) textEl.style.display = 'none'; // 默认显示卡片
    }

    function enhanceFloors() {
        var narrative = $('agent_theatre_narrative');
        if (!narrative) return;
        var AR = window.AgentRenderer; // R2 渲染引擎（agent-renderer.js，module 脚本已挂载）
        var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
        var msgEls = narrative.querySelectorAll('.agent-chat-msg.assistant');
        for (var i = 0; i < msgEls.length; i++) {
            var msgEl = msgEls[i];
            if (msgEl.getAttribute('data-th-enhanced')) continue;
            msgEl.setAttribute('data-th-enhanced', '1');
            var bubble = msgEl.querySelector('.agent-chat-bubble');
            if (!bubble) continue;
            var textEl = bubble.querySelector('.agent-chat-bubble-text');
            var raw = textEl ? (textEl.textContent || '') : '';
            var tags = parseTags(raw);
            if (!state.enabled) continue;

            // R2 通道 A：正则 HTML 直通——服务端正则已在 AI_OUTPUT 阶段把作者自定义标签
            // 替换为 HTML 标记（酒馆助手同机制），白名单 sanitize 后直接注入。
            // 优先级最高：含正则 HTML 输出时不再走预设标签卡（避免双重包裹）。
            if (AR && raw && AR.hasHtmlMarker(raw)) {
                var safeHtml = '';
                try { safeHtml = AR.sanitizeHtml(raw); } catch (e) { safeHtml = ''; }
                if (safeHtml) {
                    var htmlCard = el('div', 'th-card th-card-html');
                    htmlCard.innerHTML = safeHtml;
                    bubble.appendChild(htmlCard);
                    appendRawToggle(bubble, textEl);
                    // 选项仍并入选项区（作者正则可能未处理 <option>）
                    if (tags.options.length) pushTagOptions(tags.options);
                    continue;
                }
                // sanitize 失败 → 继续走通道 B 预设标签（优雅降级）
            }
            if (!tags.hasTags) continue;

            // 正文卡
            var card = document.createElement('div');
            card.className = 'th-card';
            var cardHtml = '';
            if (tags.mainText) {
                cardHtml += '<div class="th-maintext">' + formatText(tags.mainText) + '</div>';
            } else if (tags.stu || tags.sums.length) {
                // 无 maintext 时正文回退为原始文本（去掉状态栏/摘要块）
                var body = raw
                    .replace(/<maintext>[\s\S]*?<\/maintext>/gi, '')
                    .replace(/<option>[\s\S]*?<\/option>/gi, '')
                    .replace(/<sum>[\s\S]*?<\/sum>/gi, '')
                    .replace(/<stu>[\s\S]*?<\/stu>/gi, '')
                    .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '')
                    .replace(/<StatusPlaceHolderImpl\s*\/?>/gi, '')
                    .trim();
                if (body) cardHtml += '<div class="th-maintext">' + formatText(body) + '</div>';
            }
            if (tags.stu) cardHtml += renderStatusBar(tags.stu);
            if (tags.sums.length) {
                cardHtml += '<div class="th-sum">📌 小总结：' + esc(tags.sums[tags.sums.length - 1]) + '</div>';
            }
            if (tags.mission) {
                cardHtml += '<div class="th-mission">🎯 任务：' + esc(tags.mission) + '</div>';
            }
            if (cardHtml) {
                card.innerHTML = cardHtml;
                bubble.appendChild(card);
                appendRawToggle(bubble, textEl);
            }
            // 选项：并入选项区（复用 gateway-theatre-option-btn，主界面事件委托已处理）
            if (tags.options.length) pushTagOptions(tags.options);
        }
        renderChroniclePanel();
    }

    /** 简易段落格式化：保留换行，按行转义 */
    function formatText(t) {
        return String(t || '').split(/\r?\n/).map(esc).join('<br>');
    }

    function pushTagOptions(options) {
        var area = $('agent_theatre_options');
        if (!area || !options.length) return;
        var empty = area.querySelector('.gateway-empty-hint');
        if (empty) empty.remove();
        var html = '';
        for (var i = 0; i < options.length; i++) {
            html += '<button class="menu_button gateway-theatre-option-btn agent-chat-option-btn" ' +
                'data-text="' + esc(options[i]) + '" data-callback="" title="点击提交此选项">' +
                '<b>选项' + (i + 1) + '</b>: ' + esc(options[i]) + '</button>';
        }
        area.insertAdjacentHTML('beforeend', html);
    }

    // ==================== 编年史（R1：服务端同步） ====================
    // 数据源 = 服务端「编年史子代理」每轮广播的 chronicle（agent_result 载荷），
    // 不再从楼层 <sum> 标签本地累积（标签触发不稳定）。localStorage 仅作刷新缓存。

    function chronicleKey() { return LS_CHRONICLE_PREFIX + ((window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : 'default'); }

    function loadChronicleCache() {
        try {
            var raw = localStorage.getItem(chronicleKey());
            if (raw) state.chronicle = JSON.parse(raw) || [];
        } catch (_) { /* 忽略 */ }
    }

    function saveChronicleCache(entries) {
        try { localStorage.setItem(chronicleKey(), JSON.stringify(entries || [])); } catch (_) { /* 忽略 */ }
    }

    /** 设置编年史（服务端广播优先；参数为 null/undefined 时保持现状） */
    function setChronicle(entries) {
        if (!Array.isArray(entries)) return;
        state.chronicle = entries;
        saveChronicleCache(entries);
    }

    function renderChroniclePanel() {
        var list = $('th_chronicle_list');
        if (!list) return;
        var entries = state.chronicle || [];
        if (!entries.length) {
            list.innerHTML = '<div class="th-empty">暂无编年史条目（服务端子代理每轮实时生成后显示）</div>';
            return;
        }
        list.innerHTML = entries.map(function (e) {
            return '<div class="th-chronicle-item"><span class="th-chronicle-num">#' + (e.entryNum != null ? e.entryNum : '') + '</span>' +
                '<span class="th-chronicle-text">' + esc(e.content) + '</span></div>';
        }).join('');
    }

    // ==================== 读档 ====================

    function openSaveLoad() {
        var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
        var items = [];
        for (var i = 0; i < floors.length; i++) {
            var raw = currentFloorRawText(floors[i]);
            var tags = parseTags(raw);
            var label = tags.sums.length ? tags.sums[tags.sums.length - 1] : '';
            if (label) items.push({ floor: i, label: label });
        }
        if (!items.length) {
            openOverlay('读档', '<div class="th-empty">没有找到带 &lt;sum&gt; 小总结的楼层，无法读档。</div>');
            return;
        }
        var html = '<div class="th-savelist">' + items.map(function (it) {
            return '<div class="th-save-item" data-floor="' + it.floor + '">' +
                '<span class="th-save-floor">第 ' + (it.floor + 1) + ' 层</span>' +
                '<span class="th-save-label">' + esc(it.label) + '</span></div>';
        }).join('') + '</div>' +
            '<div class="th-hint">读档 = 回到该楼层重新分支（截断之后的楼层与服务端历史）。此操作不可撤销。</div>';
        openOverlay('读档（选择存档点）', html);
        var listEl = document.querySelector('#th_overlay .th-savelist');
        if (listEl) listEl.addEventListener('click', function (ev) {
            var item = ev.target.closest('.th-save-item');
            if (!item) return;
            var floorIdx = Number(item.getAttribute('data-floor'));
            doLoad(floorIdx);
        });
    }

    function doLoad(floorIdx) {
        // 计算保留消息数 = 前 floorIdx+1 个楼层包含的 user+assistant 消息总数
        var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
        var keep = 0;
        for (var i = 0; i <= floorIdx && i < floors.length; i++) {
            var f = floors[i];
            if (f && f.userMsg) keep += 1;
            var raw = currentFloorRawText(f);
            if (raw) keep += 1;
        }
        apiPost('/api/agent-theatre/history-truncate', {
            session: sessionKey(),
            character: (window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : '',
            keepMessages: keep,
        }).then(function (r) {
            if (window.__agentBridge && window.__agentBridge.truncateFloors) {
                window.__agentBridge.truncateFloors(floorIdx + 1);
            }
            closeOverlay();
            toast('✅ 已读档到第 ' + (floorIdx + 1) + ' 层（保留 ' + keep + ' 条消息）');
        }).catch(function (e) { toast('❌ 读档失败：' + e.message); });
    }

    // ==================== 阅读模式 ====================

    function openReader() {
        var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
        var parts = [];
        for (var i = 0; i < floors.length; i++) {
            var raw = currentFloorRawText(floors[i]);
            var tags = parseTags(raw);
            var text = tags.mainText || (tags.hasTags ? raw : raw);
            if (!text) continue;
            parts.push('<div class="th-reader-chapter"><div class="th-reader-floor">—— 第 ' + (i + 1) + ' 层 ——</div>' +
                '<div class="th-reader-body">' + formatText(text) + '</div>' +
                (tags.mission ? '<div class="th-reader-mission">🎯 ' + esc(tags.mission) + '</div>' : '') +
                '</div>');
        }
        if (!parts.length) {
            openOverlay('阅读模式', '<div class="th-empty">暂无内容。</div>');
            return;
        }
        openOverlay('阅读模式', '<div class="th-reader">' + parts.join('') + '</div>', true);
    }

    // ==================== 变量查看器 / 思维链查看器 ====================

    function flattenVars(obj, prefix, out) {
        out = out || [];
        if (obj === null || typeof obj !== 'object') {
            out.push({ key: prefix || '(值)', value: String(obj) });
            return out;
        }
        if (Array.isArray(obj)) {
            obj.forEach(function (v, i) { flattenVars(v, (prefix || '') + '[' + i + ']', out); });
            return out;
        }
        Object.keys(obj).forEach(function (k) {
            var v = obj[k];
            if (v !== null && typeof v === 'object') {
                flattenVars(v, prefix ? prefix + '.' + k : k, out);
            } else {
                out.push({ key: prefix ? prefix + '.' + k : k, value: typeof v === 'string' ? v : JSON.stringify(v) });
            }
        });
        return out;
    }

    function openVarViewer() {
        var rows = flattenVars(state.mvu.stat_data || {});
        // 变量元信息：初始来源 + 最近更新方式（R1：子代理/标签标记可视化）
        var meta = '';
        if (state.mvu && (state.mvu.initSource || state.mvu.lastUpdate)) {
            meta += '<div class="th-hint">';
            if (state.mvu.initSource) meta += '🎴 初始变量：' + esc(state.mvu.initSource) + '<br>';
            if (state.mvu.lastUpdate) {
                var via = state.mvu.lastUpdate.via === 'processor' ? '🤖 变量子代理' : '🏷 标签解析（兼容路径）';
                meta += via + ' · 最近更新 ' + esc(state.mvu.lastUpdate.count) + ' 项';
            }
            meta += '</div>';
        }
        // 变量变更历史（最近 10 轮）
        var hist = '';
        if (state.mvuHistory && state.mvuHistory.length) {
            hist = '<div class="th-hint">📜 最近变更：' + state.mvuHistory.map(function (h) {
                var src = h.via === 'processor' ? '🤖子代理' : '🏷标签';
                var cmds = (h.commands || []).map(function (c) { return (c.op || 'set') + ' ' + (c.path || c.to || '?'); }).join(', ');
                return '轮' + (h.turn != null ? h.turn : '?') + ' ' + src + (cmds ? ' [' + cmds + ']' : '');
            }).join('；') + '</div>';
        }
        if (!rows.length) {
            openOverlay('变量查看器', meta + '<div class="th-empty">暂无变量数据（AI 回复含 &lt;UpdateVariable&gt; 或手动初始化后出现）。</div>' +
                '<div class="th-hint">若角色卡有 [initvar]初始 变量表，可在下方粘贴初始化：</div>' +
                '<textarea id="th_initvar_text" class="th-textarea" placeholder=\'{"角色": {"好感度": 0, "心情": "平静"}}\'></textarea>' +
                '<button id="th_initvar_btn" class="menu_button">初始化变量</button>');
            bindInitVar();
            return;
        }
        var html = meta + hist + '<div class="th-var-list">' + rows.map(function (r) {
            return '<div class="th-var-row"><span class="th-var-key">' + esc(r.key) + '</span><span class="th-var-val">' + esc(r.value) + '</span></div>';
        }).join('') + '</div>' +
            '<button id="th_editvar_btn" class="menu_button">初始化 / 覆盖变量</button>';
        openOverlay('变量查看器', html);
        var btn = $('th_editvar_btn');
        if (btn) btn.addEventListener('click', function () {
            openOverlay('初始化 / 覆盖变量', '<textarea id="th_initvar_text" class="th-textarea">' + esc(JSON.stringify(state.mvu.stat_data || {}, null, 2)) + '</textarea>' +
                '<div class="th-hint">整体替换 stat_data。粘贴角色卡 [initvar]初始 的初始变量 JSON 后保存。</div>' +
                '<button id="th_initvar_save" class="menu_button">保存</button>');
            bindInitVar(true);
        });
    }

    function bindInitVar(withExisting) {
        var btn = $('th_initvar_btn') || $('th_initvar_save');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var ta = $('th_initvar_text');
            if (!ta) return;
            var text = ta.value.trim();
            if (!text) { toast('⚠️ 请粘贴初始变量 JSON'); return; }
            var parsed;
            try { parsed = JSON.parse(text); } catch (e) { toast('❌ JSON 解析失败：' + e.message); return; }
            apiPost('/api/agent-theatre/variables-set', {
                session: sessionKey(),
                character: (window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : '',
                variables: parsed,
            }).then(function (r) {
                if (r && r.success) {
                    state.mvu.stat_data = (r.variables && r.variables.stat_data) || parsed;
                    toast('✅ 变量已初始化');
                    closeOverlay();
                    renderChroniclePanel();
                } else {
                    toast('❌ ' + ((r && r.error) || '初始化失败'));
                }
            }).catch(function (e) { toast('❌ ' + e.message); });
        });
    }

    // ==================== Overlay 通用 ====================

    function openOverlay(title, html, full) {
        var ov = $('th_overlay');
        if (!ov) return;
        ov.innerHTML = '';
        var box = el('div', 'th-overlay-box' + (full ? ' th-overlay-full' : ''));
        box.innerHTML = '<div class="th-overlay-head"><span class="th-overlay-title">' + esc(title) + '</span>' +
            '<button class="th-overlay-close" title="关闭"><i class="fa-solid fa-xmark"></i></button></div>' +
            '<div class="th-overlay-body">' + html + '</div>';
        ov.appendChild(box);
        ov.style.display = 'flex';
        var close = box.querySelector('.th-overlay-close');
        if (close) close.addEventListener('click', closeOverlay);
    }

    function closeOverlay() {
        var ov = $('th_overlay');
        if (ov) ov.style.display = 'none';
    }

    // ==================== 小手机（悬浮按钮 + 面板） ====================

    function initPhone() {
        var body = document.body;
        var phone = el('div', 'th-phone-btn', '<i class="fa-solid fa-mobile-screen-button"></i>');
        phone.title = '小手机（编年史 / 变量 / 脚本）';
        body.appendChild(phone);

        var panel = el('div', 'th-phone-panel', '');
        panel.style.display = 'none';
        panel.innerHTML =
            '<div class="th-phone-head"><span>小手机</span><button class="th-phone-min" title="收起"><i class="fa-solid fa-minus"></i></button></div>' +
            '<div class="th-phone-tabs">' +
            '<button class="th-phone-tab active" data-tab="chronicle">编年史</button>' +
            '<button class="th-phone-tab" data-tab="vars">变量</button>' +
            '<button class="th-phone-tab" data-tab="scripts">脚本</button>' +
            '</div>' +
            '<div class="th-phone-body"><div id="th_chronicle_list" class="th-phone-pane active"></div>' +
            '<div id="th_vars_pane" class="th-phone-pane"></div>' +
            '<div id="th_scripts_pane" class="th-phone-pane"></div></div>' +
            '<div class="th-phone-footer">' +
            '<button id="th_btn_reader" class="menu_button">📖 阅读</button>' +
            '<button id="th_btn_saveload" class="menu_button">💾 读档</button>' +
            '<button id="th_btn_initvar" class="menu_button">🧪 变量</button>' +
            '<button id="th_btn_scripts" class="menu_button">🛠 脚本</button>' +
            '</div>';
        body.appendChild(panel);

        // 拖拽（点击 vs 拖拽：>4px 视为拖拽）
        var dragging = false, moved = 0, sx = 0, sy = 0;
        phone.addEventListener('mousedown', function (e) {
            dragging = true; moved = 0; sx = e.clientX; sy = e.clientY;
            phone.classList.add('th-dragging');
        });
        window.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var dx = e.clientX - sx, dy = e.clientY - sy;
            moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
            if (moved > 4) {
                var r = phone.getBoundingClientRect();
                var x = Math.min(window.innerWidth - r.width, Math.max(0, r.left + dx));
                var y = Math.min(window.innerHeight - r.height, Math.max(0, r.top + dy));
                phone.style.left = x + 'px';
                phone.style.top = y + 'px';
                sx = e.clientX; sy = e.clientY;
            }
        });
        window.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            phone.classList.remove('th-dragging');
            if (moved <= 4) { // 点击
                state.phoneOpen = !state.phoneOpen;
                panel.style.display = state.phoneOpen ? 'flex' : 'none';
                if (state.phoneOpen) refreshPhonePanes();
            }
        });
        // 触屏
        phone.addEventListener('touchstart', function (e) {
            dragging = true; moved = 0;
            var t = e.touches[0]; sx = t.clientX; sy = t.clientY;
        }, { passive: true });
        window.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            var t = e.touches[0];
            var dx = t.clientX - sx, dy = t.clientY - sy;
            moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
            if (moved > 4) {
                var r = phone.getBoundingClientRect();
                phone.style.left = Math.min(window.innerWidth - r.width, Math.max(0, r.left + dx)) + 'px';
                phone.style.top = Math.min(window.innerHeight - r.height, Math.max(0, r.top + dy)) + 'px';
                sx = t.clientX; sy = t.clientY;
            }
        }, { passive: true });
        window.addEventListener('touchend', function () {
            if (!dragging) return;
            dragging = false;
            if (moved <= 4) {
                state.phoneOpen = !state.phoneOpen;
                panel.style.display = state.phoneOpen ? 'flex' : 'none';
                if (state.phoneOpen) refreshPhonePanes();
            }
        });

        // 收起
        var min = panel.querySelector('.th-phone-min');
        if (min) min.addEventListener('click', function () { state.phoneOpen = false; panel.style.display = 'none'; });
        // 页签切换
        var tabs = panel.querySelectorAll('.th-phone-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function () {
                var target = this.getAttribute('data-tab');
                for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('active', tabs[j] === this);
                var panes = panel.querySelectorAll('.th-phone-pane');
                for (var k = 0; k < panes.length; k++) panes[k].classList.toggle('active', panes[k].id === 'th_' + target + '_pane' || panes[k].id === 'th_chronicle_list' && target === 'chronicle');
                refreshPhonePanes();
            });
        }
        // 底部按钮
        var bReader = $('th_btn_reader');
        if (bReader) bReader.addEventListener('click', function () { closePhone(); openReader(); });
        var bSave = $('th_btn_saveload');
        if (bSave) bSave.addEventListener('click', function () { closePhone(); openSaveLoad(); });
        var bInit = $('th_btn_initvar');
        if (bInit) bInit.addEventListener('click', function () { closePhone(); openVarViewer(); });
        var bScripts = $('th_btn_scripts');
        if (bScripts) bScripts.addEventListener('click', function () {
            state.scriptScope = state.scriptScope || 'global';
            refreshScriptsPane();
            // 切换到脚本 tab
            var tab = panel.querySelector('.th-phone-tab[data-tab="scripts"]');
            if (tab) tab.click();
        });
    }

    function closePhone() {
        state.phoneOpen = false;
        var panel = document.querySelector('.th-phone-panel');
        if (panel) panel.style.display = 'none';
    }

    function refreshPhonePanes() {
        renderChroniclePanel();
        // 变量 pane
        var vp = $('th_vars_pane');
        if (vp) {
            var rows = flattenVars(state.mvu.stat_data || {});
            vp.innerHTML = rows.length
                ? rows.map(function (r) {
                    return '<div class="th-var-row"><span class="th-var-key">' + esc(r.key) + '</span><span class="th-var-val">' + esc(r.value) + '</span></div>';
                }).join('')
                : '<div class="th-empty">暂无变量</div>';
        }
        // 脚本 pane（懒加载：仅在面板打开且脚本 pane 存在时渲染）
        if ($('th_scripts_pane')) refreshScriptsPane();
    }

    // ==================== 脚本库（对标酒馆助手脚本库） ====================

    function scriptScopeLabel() {
        return state.scriptScope === 'character' ? '角色脚本' : '全局脚本';
    }

    function scriptApiPath(suffix) {
        var s = state.scriptScope || 'global';
        var c = (window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : '';
        var q = '?scope=' + encodeURIComponent(s) + '&session=' + encodeURIComponent(sessionKey());
        if (s === 'character' && c) q += '&character=' + encodeURIComponent(c);
        return '/api/agent-theatre/scripts' + suffix + q;
    }

    function refreshScriptsPane() {
        var pane = $('th_scripts_pane');
        if (!pane) return;
        var s = state.scriptScope || 'global';
        var c = (window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : '';
        // 加载中
        pane.innerHTML = '<div class="th-empty">加载脚本库…</div>';
        var url = '/api/agent-theatre/scripts?scope=' + encodeURIComponent(s) + '&session=' + encodeURIComponent(sessionKey());
        if (s === 'character' && c) url += '&character=' + encodeURIComponent(c);
        apiGet(url).then(function (data) {
            renderScriptList(pane, data || {});
        }).catch(function (e) {
            pane.innerHTML = '<div class="th-empty">❌ 加载失败：' + esc(e.message) + '</div>';
        });
    }

    function renderScriptList(pane, data) {
        var scripts = (data && data.scripts) || [];
        var s = state.scriptScope || 'global';
        var html = '';
        // 分类切换 + 操作按钮
        html += '<div class="th-script-toolbar">' +
            '<button class="th-script-scope th-script-scope-' + s + '" data-scope="global">🌐 全局</button>' +
            '<button class="th-script-scope th-script-scope-' + s + '" data-scope="character">👤 角色</button>' +
            '<button class="th-script-act" data-act="new" title="新建空白脚本">＋</button>' +
            '<button class="th-script-act" data-act="import" title="导入脚本">📥</button>' +
            (s === 'character' ? '<button class="th-script-act" data-act="sync" title="从角色卡同步导入">🔄</button>' : '') +
            '</div>';
        if (!scripts.length) {
            html += '<div class="th-empty">暂无' + (s === 'character' ? '角色' : '全局') + '脚本。<br>点击 ＋ 新建，或 📥 导入酒馆助手脚本。</div>';
        } else {
            for (var i = 0; i < scripts.length; i++) {
                var sc = scripts[i];
                var btns = (sc.button && sc.button.buttons) || [];
                html += '<div class="th-script-item">' +
                    '<div class="th-script-head">' +
                    '<label class="th-script-enable"><input type="checkbox" data-enable="' + esc(sc.id) + '"' + (sc.enabled !== false ? ' checked' : '') + '></label>' +
                    '<span class="th-script-name" title="' + esc(sc.info || '') + '">' + esc(sc.name || '未命名') + '</span>' +
                    '<span class="th-script-ops">' +
                    '<button class="th-script-op" data-run="' + esc(sc.id) + '" title="运行">▶</button>' +
                    '<button class="th-script-op" data-edit="' + esc(sc.id) + '" title="编辑">✏️</button>' +
                    '<button class="th-script-op" data-del="' + esc(sc.id) + '" title="删除">🗑</button>' +
                    '</span></div>';
                if (btns.length) {
                    html += '<div class="th-script-btns">' + btns.map(function (b) {
                        return '<button class="th-script-btn" data-btn="' + esc(sc.id) + '" data-btnname="' + esc(b.name) + '">' + esc(b.name) + '</button>';
                    }).join('') + '</div>';
                }
                html += '</div>';
            }
        }
        pane.innerHTML = html;
        bindScriptPaneEvents(pane);
    }

    function bindScriptPaneEvents(pane) {
        // 分类切换（按钮每次重建 DOM，无累积）
        var scopes = pane.querySelectorAll('.th-script-scope');
        for (var i = 0; i < scopes.length; i++) {
            scopes[i].addEventListener('click', function () {
                state.scriptScope = this.getAttribute('data-scope');
                refreshScriptsPane();
            });
        }
        // 启用开关
        var enables = pane.querySelectorAll('[data-enable]');
        for (var j = 0; j < enables.length; j++) {
            enables[j].addEventListener('change', function () {
                apiPut(scriptApiPath('/' + encodeURIComponent(this.getAttribute('data-enable'))), { enabled: this.checked });
            });
        }
        // pane 级事件委托：用 onclick 覆盖式赋值（每次渲染重建 DOM 后重新绑定，不累积监听器）
        pane.onclick = function (e) {
            var act = e.target.closest('[data-act]');
            if (act) {
                var a = act.getAttribute('data-act');
                if (a === 'new') openScriptEditor(null);
                else if (a === 'import') openScriptImport();
                else if (a === 'sync') syncScriptsFromCard();
                return;
            }
            var run = e.target.closest('[data-run]');
            if (run) { runScriptById(run.getAttribute('data-run'), null); return; }
            var edit = e.target.closest('[data-edit]');
            if (edit) { openScriptEditor(edit.getAttribute('data-edit')); return; }
            var del = e.target.closest('[data-del]');
            if (del) { deleteScriptById(del.getAttribute('data-del')); return; }
            var btn = e.target.closest('[data-btn]');
            if (btn) { runScriptById(btn.getAttribute('data-btn'), btn.getAttribute('data-btnname')); }
        };
    }

    /** 运行脚本（按钮或手动） */
    function runScriptById(id, buttonName) {
        apiPost(scriptApiPath('/' + encodeURIComponent(id) + '/run'), {
            buttonName: buttonName || '',
            session: sessionKey(),
        }).then(function (r) {
            if (!r) return;
            if (r.success) {
                var n = (r.eventsFired || []).length;
                toast('✅ 脚本执行完成' + (n ? '（触发 ' + n + ' 个监听器）' : ''));
                if (r.logs && r.logs.length) showScriptLogs(r.logs);
            } else {
                toast('❌ ' + (r.error || '执行失败'));
                if (r.logs && r.logs.length) showScriptLogs(r.logs);
            }
        }).catch(function (e) { toast('❌ ' + e.message); });
    }

    function showScriptLogs(logs) {
        var html = '<div class="th-script-logs">' + (logs || []).map(function (l) {
            return '<div class="th-script-log">' + esc(l) + '</div>';
        }).join('') + '</div>';
        openOverlay('脚本执行日志', html + '<button id="th_log_close" class="menu_button">关闭</button>');
        var btn = $('th_log_close');
        if (btn) btn.addEventListener('click', closeOverlay);
    }

    function deleteScriptById(id) {
        if (!confirm('确定删除该脚本？')) return;
        apiDelete(scriptApiPath('/' + encodeURIComponent(id))).then(function () {
            toast('🗑 已删除');
            refreshScriptsPane();
        }).catch(function (e) { toast('❌ ' + e.message); });
    }

    function syncScriptsFromCard() {
        apiPost('/api/agent-theatre/scripts/sync', {
            session: sessionKey(),
            character: (window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : '',
        }).then(function (r) {
            if (r && r.success) {
                toast('✅ 已同步角色卡脚本（新增 ' + (r.imported || 0) + '）');
                refreshScriptsPane();
            } else {
                toast('⚠️ ' + ((r && r.error) || '同步失败'));
            }
        }).catch(function (e) { toast('❌ ' + e.message); });
    }

    function openScriptImport() {
        var html =
            '<div class="th-hint">导入酒馆助手脚本：<br>① 文本脚本：粘贴 JavaScript 源码导入<br>② 酒馆助手导出 JSON（ScriptTree 数组）</div>' +
            '<textarea id="th_import_text" class="th-textarea" rows="6" placeholder="// 粘贴脚本源码或酒馆助手 ScriptTree JSON"></textarea>' +
            '<div class="th-hint">可导入多个脚本（每行一个 / 或 JSON 数组），导入到：<b>' + esc(scriptScopeLabel()) + '</b></div>' +
            '<button id="th_import_btn" class="menu_button">导入</button>';
        openOverlay('导入脚本', html);
        var btn = $('th_import_btn');
        if (btn) btn.addEventListener('click', function () {
            var ta = $('th_import_text');
            if (!ta || !ta.value.trim()) { toast('⚠️ 请粘贴内容'); return; }
            var text = ta.value.trim();
            var list = [];
            // JSON 数组形态（酒馆助手导出）
            if (text.startsWith('[') || text.startsWith('{')) {
                try {
                    var parsed = JSON.parse(text);
                    if (Array.isArray(parsed)) list = parsed;
                    else list = [parsed];
                } catch (e) { toast('❌ JSON 解析失败：' + e.message); return; }
            } else {
                // 文本脚本：按名字导入（多段用分隔行 ---）
                var parts = text.split(/\n\s*---+\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
                parts.forEach(function (p, idx) {
                    list.push({ name: '导入脚本 ' + (idx + 1), content: p, info: '手动导入' });
                });
            }
            apiPost(scriptApiPath('/import'), { scripts: list, session: sessionKey() }).then(function (r) {
                if (r && r.success) {
                    toast('✅ 导入成功：新增 ' + (r.imported || 0) + ' / 更新 ' + (r.updated || 0));
                    closeOverlay();
                    refreshScriptsPane();
                } else {
                    toast('❌ ' + ((r && r.error) || '导入失败'));
                }
            }).catch(function (e) { toast('❌ ' + e.message); });
        });
    }

    /** 编辑器：新建（script=null）或编辑已有脚本 */
    function openScriptEditor(scriptId) {
        var isNew = !scriptId;
        var finish = function (sc) {
            var html =
                '<div class="th-script-editor">' +
                '<div class="th-script-editor-row"><span class="th-script-editor-label">名称</span><input id="th_ed_name" class="th-input" value="' + esc(sc.name || '') + '"></div>' +
                '<div class="th-script-editor-row"><span class="th-script-editor-label">备注</span><input id="th_ed_info" class="th-input" value="' + esc(sc.info || '') + '"></div>' +
                '<textarea id="th_ed_content" class="th-textarea th-script-editor-code" rows="12" spellcheck="false">' + esc(sc.content || '') + '</textarea>' +
                '</div>' +
                '<div class="th-script-editor-ops">' +
                '<button id="th_ed_save" class="menu_button">💾 保存</button>' +
                '<button id="th_ed_run" class="menu_button">▶ 运行</button>' +
                '<button id="th_ed_versions" class="menu_button">📜 版本</button>' +
                '<button id="th_ed_close" class="menu_button">关闭</button>' +
                '</div>' +
                '<div id="th_ed_log" class="th-script-logs" style="display:none"></div>';
            openOverlay(isNew ? '新建脚本' : ('编辑脚本：' + sc.name), html, true);
            var save = function () {
                var payload = {
                    name: ($('th_ed_name') ? $('th_ed_name').value : sc.name) || '未命名脚本',
                    info: ($('th_ed_info') ? $('th_ed_info').value : sc.info) || '',
                    content: ($('th_ed_content') ? $('th_ed_content').value : sc.content) || '',
                };
                var req = isNew
                    ? apiPost(scriptApiPath(''), payload)
                    : apiPut(scriptApiPath('/' + encodeURIComponent(sc.id)), payload);
                req.then(function (r) {
                    if (r && r.success) {
                        toast('✅ 已保存');
                        if (isNew && r.script) { isNew = false; sc = r.script; }
                        refreshScriptsPane();
                    } else {
                        toast('❌ ' + ((r && r.error) || '保存失败'));
                    }
                }).catch(function (e) { toast('❌ ' + e.message); });
            };
            var run = function () {
                var payload = {
                    name: ($('th_ed_name') ? $('th_ed_name').value : sc.name) || '未命名脚本',
                    content: ($('th_ed_content') ? $('th_ed_content').value : sc.content) || '',
                };
                // 先保存到临时脚本（若为新脚本），再运行
                var saveFirst = isNew
                    ? apiPost(scriptApiPath(''), payload)
                    : Promise.resolve({ success: true, script: sc });
                saveFirst.then(function (r) {
                    if (!r || !r.success) { toast('❌ 保存后运行失败'); return; }
                    var sid = r.script ? r.script.id : sc.id;
                    var logEl = $('th_ed_log');
                    if (logEl) { logEl.style.display = ''; logEl.innerHTML = '<div class="th-script-log">运行中…</div>'; }
                    apiPost(scriptApiPath('/' + encodeURIComponent(sid) + '/run'), { session: sessionKey() }).then(function (rr) {
                        if (logEl) {
                            var logs = (rr && rr.logs) || [];
                            logEl.innerHTML = '<div class="th-script-log">' + (rr && rr.success ? '✅ 完成' : '❌ ' + (rr && rr.error || '失败')) + '</div>' +
                                logs.map(function (l) { return '<div class="th-script-log">' + esc(l) + '</div>'; }).join('');
                        }
                        if (rr && rr.success) toast('✅ 脚本执行完成');
                        else toast('❌ ' + ((rr && rr.error) || '执行失败'));
                    }).catch(function (e) { toast('❌ ' + e.message); });
                }).catch(function (e) { toast('❌ ' + e.message); });
            };
            var versions = function () {
                if (isNew) { toast('⚠️ 请先保存再查看版本'); return; }
                apiGet(scriptApiPath('/' + encodeURIComponent(sc.id) + '/versions')).then(function (r) {
                    var vs = (r && r.versions) || [];
                    if (!vs.length) { toast('ℹ️ 暂无历史版本'); return; }
                    var html = '<div class="th-ver-list">' + vs.map(function (v) {
                        var d = new Date(v.ts);
                        return '<div class="th-ver-item"><span class="th-ver-time">' + d.toLocaleString() + '</span>' +
                            '<button class="th-ver-restore" data-ts="' + v.ts + '">回滚</button></div>';
                    }).join('') + '</div>';
                    openOverlay('版本历史', html);
                    var btns = document.querySelectorAll('#th_overlay .th-ver-restore');
                    for (var i = 0; i < btns.length; i++) {
                        btns[i].addEventListener('click', function () {
                            if (!confirm('回滚到该版本？当前内容会保留为最新版本。')) return;
                            apiPost(scriptApiPath('/' + encodeURIComponent(sc.id) + '/restore'), { ts: Number(this.getAttribute('data-ts')), session: sessionKey() }).then(function () {
                                toast('✅ 已回滚');
                                closeOverlay();
                                openScriptEditor(sc.id);
                            }).catch(function (e) { toast('❌ ' + e.message); });
                        });
                    }
                }).catch(function (e) { toast('❌ ' + e.message); });
            };
            $('th_ed_save').addEventListener('click', save);
            $('th_ed_run').addEventListener('click', run);
            $('th_ed_versions').addEventListener('click', versions);
            $('th_ed_close').addEventListener('click', closeOverlay);
        };
        if (isNew) { finish({ id: '', name: '新脚本', content: '// 酒馆助手兼容脚本\n\n', info: '' }); return; }
        apiGet(scriptApiPath('/' + encodeURIComponent(scriptId))).then(function (r) {
            if (r && r.success && r.script) finish(r.script);
            else toast('❌ ' + ((r && r.error) || '脚本不存在'));
        }).catch(function (e) { toast('❌ ' + e.message); });
    }

    // ==================== 前端卡开关 ====================

    function initCompatBar() {
        // 在输入区上方插入一条轻量兼容工具栏
        var sendForm = document.querySelector('.agent-input-area') || $('agent_theatre_input') || document.querySelector('footer');
        // 找不到专用容器时用浮层按钮区（小手机已提供主要入口）
    }

    // ==================== toast ====================

    function toast(msg) {
        // 转义后展示：脚本异常 message / 角色卡名等外部输入可能含 HTML，防 toastr 存储型 XSS
        var safe = esc(msg);
        if (window.toastr) { window.toastr.success(safe); return; }
        var t = el('div', 'th-toast', safe);
        document.body.appendChild(t);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    }

    // ==================== 主入口 ====================

    function init() {
        loadPrefs();
        // R1: 页面刷新后、首次广播前，用 localStorage 缓存恢复编年史
        loadChronicleCache();
        // overlay 容器
        var ov = el('div', 'th-overlay');
        ov.id = 'th_overlay';
        ov.style.display = 'none';
        document.body.appendChild(ov);
        // 小手机
        initPhone();
    }

    window.__agentCompat = {
        onFloorsRendered: function () { enhanceFloors(); },
        onAgentResult: function (payload) {
            if (payload && payload.variables) {
                state.mvu = payload.variables;
            }
            // R1: 变量变更历史（可视化每轮由子代理/标签应用了什么命令）
            if (payload && Array.isArray(payload.mvuHistory)) {
                state.mvuHistory = payload.mvuHistory;
            }
            // R1: 编年史服务端同步——chronicle 子代理每轮广播，直接消费并缓存
            if (payload && Array.isArray(payload.chronicle)) {
                setChronicle(payload.chronicle);
            }
            renderChroniclePanel();
            enhanceFloors();
        },
        getState: function () { return state; },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
