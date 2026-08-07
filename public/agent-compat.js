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
 *   - 小手机：右下角悬浮按钮 + 可展开面板（编年史 / 变量查看器 / 思维链查看器）
 *   - 读档：扫描 <sum> 楼层 → 弹窗选择 → 截断会话（本地楼层 + 服务端历史）
 *   - 编年史：由每楼 <sum> 累积，localStorage 持久化
 *   - 阅读模式：全屏 overlay 按楼层展示 <maintext> + <mission>
 *   - 变量查看器 / 思维链查看器 overlay
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
        chronicle: [],          // [{ floor, entryNum, content }]
        phoneOpen: false,
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

    function enhanceFloors() {
        var narrative = $('agent_theatre_narrative');
        if (!narrative) return;
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
            if (!tags.hasTags || !state.enabled) continue;

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
                // 原文折叠查看
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

    // ==================== 编年史（<sum> 累积） ====================

    function chronicleKey() { return LS_CHRONICLE_PREFIX + ((window.__agentBridge && window.__agentBridge.getCharacter) ? window.__agentBridge.getCharacter() : 'default'); }

    function rebuildChronicle() {
        var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
        var entries = [];
        var num = 0;
        for (var i = 0; i < floors.length; i++) {
            var raw = currentFloorRawText(floors[i]);
            var tags = parseTags(raw);
            if (tags.sums.length) {
                num += 1;
                entries.push({ floor: i, entryNum: num, content: tags.sums[tags.sums.length - 1] });
            }
        }
        state.chronicle = entries;
        try { localStorage.setItem(chronicleKey(), JSON.stringify(entries)); } catch (_) { /* 忽略 */ }
        return entries;
    }

    function renderChroniclePanel() {
        var list = $('th_chronicle_list');
        if (!list) return;
        var entries = rebuildChronicle();
        if (!entries.length) {
            list.innerHTML = '<div class="th-empty">暂无编年史条目（AI 回复含 &lt;sum&gt; 标签时自动累积）</div>';
            return;
        }
        list.innerHTML = entries.map(function (e) {
            return '<div class="th-chronicle-item"><span class="th-chronicle-num">#' + e.entryNum + '</span>' +
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
            obj.forEach(function (v, i) { flattenVars(v, (prefix ? prefix + '.' : '') + '[' + i + ']', out); });
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
        if (!rows.length) {
            openOverlay('变量查看器', '<div class="th-empty">暂无变量数据（AI 回复含 &lt;UpdateVariable&gt; 或手动初始化后出现）。</div>' +
                '<div class="th-hint">若角色卡有 [initvar]初始 变量表，可在下方粘贴初始化：</div>' +
                '<textarea id="th_initvar_text" class="th-textarea" placeholder=\'{"角色": {"好感度": 0, "心情": "平静"}}\'></textarea>' +
                '<button id="th_initvar_btn" class="menu_button">初始化变量</button>');
            bindInitVar();
            return;
        }
        var html = '<div class="th-var-list">' + rows.map(function (r) {
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

    function openCoTViewer() {
        var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
        var parts = [];
        for (var i = 0; i < floors.length; i++) {
            var raw = currentFloorRawText(floors[i]);
            var tags = parseTags(raw);
            var block = '';
            if (tags.analysis) block += '<div class="th-cot-block">' + formatText(tags.analysis) + '</div>';
            var um = raw.match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
            if (um) block += '<div class="th-cot-update">' + esc(summarize(um[0], 400)) + '</div>';
            if (block) {
                parts.push('<div class="th-cot-chapter"><div class="th-reader-floor">—— 第 ' + (i + 1) + ' 层 ——</div>' + block + '</div>');
            }
        }
        if (!parts.length) {
            openOverlay('思维链查看器', '<div class="th-empty">暂无 <Analysis> / &lt;UpdateVariable&gt; 内容。</div>');
            return;
        }
        openOverlay('思维链查看器', '<div class="th-cot">' + parts.join('') + '</div>', true);
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
        phone.title = '小手机（编年史 / 变量 / 思维链）';
        body.appendChild(phone);

        var panel = el('div', 'th-phone-panel', '');
        panel.style.display = 'none';
        panel.innerHTML =
            '<div class="th-phone-head"><span>小手机</span><button class="th-phone-min" title="收起"><i class="fa-solid fa-minus"></i></button></div>' +
            '<div class="th-phone-tabs">' +
            '<button class="th-phone-tab active" data-tab="chronicle">编年史</button>' +
            '<button class="th-phone-tab" data-tab="vars">变量</button>' +
            '<button class="th-phone-tab" data-tab="cot">思维链</button>' +
            '</div>' +
            '<div class="th-phone-body"><div id="th_chronicle_list" class="th-phone-pane active"></div>' +
            '<div id="th_vars_pane" class="th-phone-pane"></div>' +
            '<div id="th_cot_pane" class="th-phone-pane"></div></div>' +
            '<div class="th-phone-footer">' +
            '<button id="th_btn_reader" class="menu_button">📖 阅读</button>' +
            '<button id="th_btn_saveload" class="menu_button">💾 读档</button>' +
            '<button id="th_btn_initvar" class="menu_button">🧪 变量</button>' +
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
        // 思维链 pane
        var cp = $('th_cot_pane');
        if (cp) {
            var floors = (window.__agentBridge && window.__agentBridge.getFloors) ? window.__agentBridge.getFloors() : [];
            var parts = [];
            for (var i = 0; i < floors.length; i++) {
                var tags = parseTags(currentFloorRawText(floors[i]));
                if (tags.analysis) parts.push('<div class="th-cot-block">' + formatText(tags.analysis) + '</div>');
            }
            cp.innerHTML = parts.length ? parts.join('') : '<div class="th-empty">暂无思维链</div>';
        }
    }

    // ==================== 前端卡开关 ====================

    function initCompatBar() {
        // 在输入区上方插入一条轻量兼容工具栏
        var sendForm = document.querySelector('.agent-input-area') || $('agent_theatre_input') || document.querySelector('footer');
        // 找不到专用容器时用浮层按钮区（小手机已提供主要入口）
    }

    // ==================== toast ====================

    function toast(msg) {
        if (window.toastr) { window.toastr.success(msg); return; }
        var t = el('div', 'th-toast', esc(msg));
        document.body.appendChild(t);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    }

    // ==================== 主入口 ====================

    function init() {
        loadPrefs();
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
