/**
 * AI 辅助修改 Profile 前端逻辑（Task: AI 辅助页面修改系统）
 *
 * 功能：
 *   - 自然语言输入 → 调 /api/agent-theatre/ai-modify/plan 生成修改方案
 *   - 方案预览卡片：理解复述 / 修改要点（from→to 高亮）/ 风险徽章 / 风险说明
 *   - 用户确认后调 /apply 应用（应用前自动把 newYaml 回填到 YAML 编辑器并提示热重载）
 *   - 撤销：调 /undo，恢复后回填 YAML 编辑器
 *   - 历史计数显示"可撤销 N 步"
 *   - riskLevel=high 时"应用修改"按钮变红，需二次点击确认
 *
 * 挂载方式：panel.html 在 "Agent 剧场" 区块展开时，于 panel-agent-theatre.js
 * 之后动态注入本脚本，并调用 window.GatewayAiModifier.init()。
 *
 * 不依赖任何框架，原生 fetch + DOM API，复用 toastr / fa-icon / style.css。
 * 工具函数自行重实现 gatewayUrl/gatewayToken/esc，避免与 panel-agent-theatre.js 耦合。
 */
(function () {
    'use strict';

    // 防止重复初始化
    if (window.__gatewayAiModifierInit) return;
    window.__gatewayAiModifierInit = true;

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

    /** HTML 转义 */
    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 提示（复用 toastr，无则 console） */
    function showToast(type, msg) {
        if (typeof toastr !== 'undefined') toastr[type](msg);
        else console.log('[' + type + ']', msg);
    }

    function $(id) { return document.getElementById(id); }

    /** 发起带鉴权的 API 请求，返回 JSON */
    function aiFetch(endpoint, options) {
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

    /** 获取当前 Profile 名（从剧场工具栏的下拉） */
    function currentProfileName() {
        var sel = $('gateway_theatre_profile');
        return (sel && sel.value) || 'default-rp';
    }

    // ==================== 状态 ====================

    var state = {
        inFlight: false,     // 是否有 plan 请求在进行
        lastPlan: null,      // 最近一次方案（用于应用）
        highConfirmArmed: false, // high 风险二次确认是否已武装
    };

    // ==================== 方案预览渲染 ====================

    /** 风险徽章 class 映射 */
    function riskBadgeClass(level) {
        if (level === 'low') return 'gateway-ai-plan-risk low';
        if (level === 'high') return 'gateway-ai-plan-risk high';
        return 'gateway-ai-plan-risk medium';
    }

    /** 风险中文标签 */
    function riskLabel(level) {
        if (level === 'low') return '低风险';
        if (level === 'high') return '高风险';
        return '中风险';
    }

    /**
     * 渲染方案预览卡片到 #gateway_theatre_ai_plan_view。
     * @param {object} plan - 后端返回的 plan 对象
     */
    function renderPlan(plan) {
        var view = $('gateway_theatre_ai_plan_view');
        if (!view) return;

        var changesHtml = '';
        var changes = Array.isArray(plan.changes) ? plan.changes : [];
        if (changes.length === 0) {
            changesHtml = '<div class="gateway-ai-plan-change-empty">（无具体字段变更，可能仅文字润色）</div>';
        } else {
            for (var i = 0; i < changes.length; i++) {
                var c = changes[i] || {};
                changesHtml += ''
                    + '<div class="gateway-ai-plan-change">'
                    +   '<div class="gateway-ai-plan-change-field">' + esc(c.field || '?') + '</div>'
                    +   '<div class="gateway-ai-plan-change-diff">'
                    +     '<span class="gateway-ai-plan-from">' + esc(c.from == null ? '(空)' : c.from) + '</span>'
                    +     '<span class="gateway-ai-plan-arrow">→</span>'
                    +     '<span class="gateway-ai-plan-to">' + esc(c.to == null ? '(空)' : c.to) + '</span>'
                    +   '</div>'
                    +   (c.reason ? '<div class="gateway-ai-plan-change-reason">' + esc(c.reason) + '</div>' : '')
                    + '</div>';
            }
        }

        var isHigh = plan.riskLevel === 'high';
        var applyBtnClass = 'menu_button gateway-ai-apply-btn' + (isHigh ? ' gateway-ai-apply-danger' : '');
        var applyBtnText = isHigh ? '⚠️ 确认应用高风险修改（再点一次）' : '✅ 应用修改';

        view.innerHTML = ''
            + '<div class="gateway-ai-plan-card">'
            +   '<div class="gateway-ai-plan-understanding">' + esc(plan.understanding || '') + '</div>'
            +   '<div class="gateway-ai-plan-summary">' + esc(plan.summary || '').replace(/\n/g, '<br>') + '</div>'
            +   '<div class="gateway-ai-plan-changes">' + changesHtml + '</div>'
            +   '<div class="gateway-ai-plan-risk-row">'
            +     '<span class="' + riskBadgeClass(plan.riskLevel) + '">' + riskLabel(plan.riskLevel) + '</span>'
            +     (plan.riskNote ? '<span class="gateway-ai-plan-risk-note">' + esc(plan.riskNote) + '</span>' : '')
            +   '</div>'
            +   '<div class="gateway-ai-plan-actions">'
            +     '<button id="gateway_theatre_ai_apply" class="' + applyBtnClass + '">' + applyBtnText + '</button>'
            +     '<button id="gateway_theatre_ai_cancel_plan" class="menu_button">取消</button>'
            +   '</div>'
            + '</div>';
        view.style.display = 'block';

        // 绑定按钮
        var applyBtn = $('gateway_theatre_ai_apply');
        if (applyBtn) applyBtn.addEventListener('click', function () {
            // high 风险二次确认：第一次点击武装，第二次才真正应用
            if (isHigh && !state.highConfirmArmed) {
                state.highConfirmArmed = true;
                applyBtn.textContent = '⚠️ 再次点击确认应用（不可撤销除外）';
                applyBtn.classList.add('gateway-ai-apply-armed');
                return;
            }
            state.highConfirmArmed = false;
            applyPlan(plan);
        });
        var cancelBtn = $('gateway_theatre_ai_cancel_plan');
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
            clearPlanView();
        });
    }

    /** 清空方案预览 */
    function clearPlanView() {
        var view = $('gateway_theatre_ai_plan_view');
        if (view) {
            view.innerHTML = '';
            view.style.display = 'none';
        }
        state.lastPlan = null;
        state.highConfirmArmed = false;
    }

    /** 渲染 loading 动画 */
    function renderLoading() {
        var view = $('gateway_theatre_ai_plan_view');
        if (!view) return;
        view.innerHTML = '<div class="gateway-ai-loading"><span></span><span></span><span></span><span class="gateway-ai-loading-text">AI 正在分析修改方案…</span></div>';
        view.style.display = 'block';
    }

    /** 渲染错误 */
    function renderError(msg) {
        var view = $('gateway_theatre_ai_plan_view');
        if (!view) return;
        view.innerHTML = '<div class="gateway-ai-plan-error"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(msg) + '</div>';
        view.style.display = 'block';
    }

    // ==================== 业务流程 ====================

    /** 生成修改方案 */
    function generatePlan() {
        if (state.inFlight) {
            showToast('warning', '上一次请求仍在进行中，请稍候');
            return;
        }
        var input = $('gateway_theatre_ai_input');
        var request = input ? input.value.trim() : '';
        if (!request) {
            showToast('warning', '请先用大白话描述你想怎么改');
            return;
        }
        var profileName = currentProfileName();
        var yamlTa = $('gateway_theatre_profile_yaml');
        var currentYaml = yamlTa ? yamlTa.value : '';
        if (!currentYaml.trim()) {
            showToast('warning', '当前 Profile YAML 为空，请先加载或选择 Profile');
            return;
        }

        state.inFlight = true;
        state.highConfirmArmed = false;
        renderLoading();

        aiFetch('/api/agent-theatre/ai-modify/plan', {
            method: 'POST',
            body: JSON.stringify({
                request: request,
                profileName: profileName,
                currentYaml: currentYaml,
            }),
        }).then(function (data) {
            if (data && data.success && data.plan) {
                state.lastPlan = data.plan;
                renderPlan(data.plan);
            } else {
                renderError((data && data.error) || 'AI 未能生成方案');
            }
        }).catch(function (e) {
            renderError(e.message || '请求失败');
        }).finally(function () {
            state.inFlight = false;
        });
    }

    /**
     * 应用方案：调 /apply，成功后回填 YAML 编辑器并提示热重载。
     * @param {object} plan
     */
    function applyPlan(plan) {
        var profileName = currentProfileName();
        var newYaml = plan.newYaml || '';
        if (!newYaml.trim()) {
            showToast('error', '方案中没有可应用的 YAML');
            return;
        }
        aiFetch('/api/agent-theatre/ai-modify/apply', {
            method: 'POST',
            body: JSON.stringify({ profileName: profileName, newYaml: newYaml }),
        }).then(function (data) {
            if (data && data.success) {
                showToast('success', 'AI 修改已应用，引擎已热重载');
                // 回填 YAML 编辑器
                var yamlTa = $('gateway_theatre_profile_yaml');
                if (yamlTa) yamlTa.value = newYaml;
                // 显示热重载提示
                var hint = $('gateway_theatre_save_hint');
                if (hint) {
                    hint.textContent = '✅ AI 修改已应用，引擎已热重载，会话不中断';
                    hint.style.display = 'block';
                    setTimeout(function () { hint.style.display = 'none'; }, 3000);
                }
                clearPlanView();
                refreshHistory();
            } else {
                showToast('error', '应用失败: ' + ((data && data.error) || '未知错误'));
            }
        }).catch(function (e) {
            showToast('error', '应用失败: ' + e.message);
        });
    }

    /** 撤销上次修改 */
    function undoModify() {
        var profileName = currentProfileName();
        aiFetch('/api/agent-theatre/ai-modify/undo', {
            method: 'POST',
            body: JSON.stringify({ profileName: profileName }),
        }).then(function (data) {
            if (data && data.success) {
                showToast('success', '已撤销上次 AI 修改');
                // 回填恢复后的 YAML
                if (data.restoredYaml) {
                    var yamlTa = $('gateway_theatre_profile_yaml');
                    if (yamlTa) yamlTa.value = data.restoredYaml;
                }
                var hint = $('gateway_theatre_save_hint');
                if (hint) {
                    hint.textContent = '↩️ 已撤销到上一版本，引擎已热重载';
                    hint.style.display = 'block';
                    setTimeout(function () { hint.style.display = 'none'; }, 3000);
                }
            } else {
                showToast('warning', (data && data.error) || '撤销失败');
            }
            refreshHistory();
        }).catch(function (e) {
            showToast('error', '撤销失败: ' + e.message);
        });
    }

    /** 刷新撤销历史计数显示 */
    function refreshHistory() {
        var profileName = currentProfileName();
        aiFetch('/api/agent-theatre/ai-modify/history?profileName=' + encodeURIComponent(profileName))
            .then(function (data) {
                var el = $('gateway_theatre_ai_history');
                if (!el) return;
                if (data && data.success) {
                    el.textContent = data.canUndo ? ('可撤销 ' + data.count + ' 步') : '无可撤销';
                } else {
                    el.textContent = '';
                }
            })
            .catch(function () {
                var el = $('gateway_theatre_ai_history');
                if (el) el.textContent = '';
            });
    }

    // ==================== 事件绑定 ====================

    function bindEvents() {
        var planBtn = $('gateway_theatre_ai_plan');
        if (planBtn) planBtn.addEventListener('click', generatePlan);

        var undoBtn = $('gateway_theatre_ai_undo');
        if (undoBtn) undoBtn.addEventListener('click', undoModify);

        // 输入框 Ctrl+Enter 触发生成方案
        var inputEl = $('gateway_theatre_ai_input');
        if (inputEl) inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                generatePlan();
            }
        });

        // Profile 切换时刷新历史计数
        var profileSel = $('gateway_theatre_profile');
        if (profileSel) profileSel.addEventListener('change', function () {
            clearPlanView();
            refreshHistory();
        });
    }

    // ==================== 初始化 ====================

    function init() {
        bindEvents();
        // 网关已连接时拉取历史计数
        if (gatewayUrl()) {
            refreshHistory();
        }
        console.log('[Gateway AiModifier] 已初始化');
    }

    // 暴露全局对象供 panel.html 显式调用
    window.GatewayAiModifier = {
        init: init,
        generatePlan: generatePlan,
        applyPlan: applyPlan,
        undoModify: undoModify,
        refreshHistory: refreshHistory,
    };

    // 自动初始化（DOM 已就绪，因为本脚本在 panel.html 注入后才加载）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
