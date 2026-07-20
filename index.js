/**
 * SillyTavern Multi-Platform Gateway Extension
 * 前端扩展入口 - 完整 AI 自动回复管线
 * 
 * 工作流程:
 *   平台消息 → 网关 → 扩展轮询 → 注入 ST 聊天 → 触发 AI 生成 → 回复转发回平台
 */

import { getContext, extension_settings } from '../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { renderExtensionTemplateAsync } from '../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { eventSource, event_types } from '../../../script.js';
import { sendMessageAsUser } from '../../../script.js';

// 扩展设置默认值
const DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:3210',
    autoConnect: true,
    pollInterval: 3000,
    autoReplyEnabled: true,
};

// 扩展状态
let gatewayConnected = false;
let pollTimer = null;
let lastMessages = [];
/** 已处理过的消息 ID 集合 (platform+chatId+timestamp) */
const processedMessageIds = new Set();
/** 等待 AI 回复的目标 { platform, chatId } */
let pendingReplyTarget = null;
/** 是否正在处理消息（防止重复触发） */
let isProcessing = false;

/**
 * 获取扩展设置
 */
function getSettings() {
    if (!extension_settings.gateway) {
        extension_settings.gateway = { ...DEFAULT_SETTINGS };
    }
    return extension_settings.gateway;
}

/**
 * API 请求封装
 */
async function apiRequest(endpoint, options = {}) {
    const settings = getSettings();
    const url = `${settings.serverUrl}${endpoint}`;

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`[Gateway] API 请求失败: ${error.message}`);
        throw error;
    }
}

/**
 * 获取网关状态
 */
async function fetchGatewayStatus() {
    try {
        const status = await apiRequest('/api/gateway/status');
        updateStatusUI(status);
        gatewayConnected = true;
        updateConnectionStatus(true);

        // 处理新消息（自动回复管线）
        if (status.recentMessages && getSettings().autoReplyEnabled) {
            await processIncomingMessages(status.recentMessages);
        }

        return status;
    } catch (error) {
        gatewayConnected = false;
        updateConnectionStatus(false);
        return null;
    }
}

// ==================== AI 自动回复管线 ====================

/**
 * 处理入站消息：注入 ST 聊天 → 触发 AI 生成 → 回复转发
 */
async function processIncomingMessages(messages) {
    // 只处理入站、未处理过的消息
    const newMessages = messages.filter(msg => {
        if (msg.direction !== 'inbound') return false;
        const msgId = `${msg.platform}|${msg.chatId}|${msg.timestamp}|${msg.content}`;
        if (processedMessageIds.has(msgId)) return false;
        return true;
    });

    if (newMessages.length === 0) return;

    const context = getContext();

    // 如果没有选中角色，无法自动回复
    if (context.characterId === undefined && context.groupId === undefined) {
        console.warn('[Gateway] 未选中角色，跳过自动回复');
        return;
    }

    // 如果正在处理中，跳过
    if (isProcessing) {
        console.warn('[Gateway] 正在处理上一条消息，跳过');
        return;
    }

    for (const msg of newMessages) {
        const msgId = `${msg.platform}|${msg.chatId}|${msg.timestamp}|${msg.content}`;
        processedMessageIds.add(msgId);

        try {
            isProcessing = true;

            // 记录回复目标
            pendingReplyTarget = {
                platform: msg.platform,
                chatId: msg.chatId,
            };

            // 1. 注入用户消息到 ST 聊天
            const platformIcon = getPlatformIcon(msg.platform);
            const displayName = `[${platformIcon} ${msg.platform}] ${msg.content}`;
            await sendMessageAsUser(displayName, '');

            console.log(`[Gateway] 已注入消息: ${msg.platform}/${msg.chatId} -> ${msg.content}`);

            // 2. 标记下次回复需要转发到网关
            // 监听 GENERATION_ENDED 事件来捕获 AI 回复

            // 3. 触发 AI 生成
            await context.generate();

        } catch (error) {
            console.error(`[Gateway] 处理消息失败: ${error.message}`);
            isProcessing = false;
            pendingReplyTarget = null;
        }
    }
}

/**
 * 监听 AI 生成结束，将回复转发回网关
 */
function setupGenerationListener() {
    eventSource.on(event_types.GENERATION_ENDED, async (chatId) => {
        // 没有待回复的目标则跳过
        if (!pendingReplyTarget) return;

        const target = { ...pendingReplyTarget };
        const context = getContext();

        try {
            // 获取 AI 的最后一条消息
            const lastMessage = context.chat[context.chat.length - 1];
            if (!lastMessage || lastMessage.is_user) {
                console.warn('[Gateway] 未找到 AI 回复消息');
                return;
            }

            const replyContent = lastMessage.mes;

            // 发送回复到网关
            await apiRequest('/api/gateway/send', {
                method: 'POST',
                body: JSON.stringify({
                    platform: target.platform,
                    chatId: target.chatId,
                    content: replyContent,
                }),
            });

            console.log(`[Gateway] AI 回复已转发到 ${target.platform}/${target.chatId}`);
            toastr.success(`AI 回复已发送到 ${target.platform}`);
        } catch (error) {
            console.error(`[Gateway] 转发回复失败: ${error.message}`);
            toastr.error(`转发回复失败: ${error.message}`);
        } finally {
            // 重置状态
            pendingReplyTarget = null;
            isProcessing = false;
        }
    });
}

// ==================== UI 更新 ====================

/**
 * 更新连接状态 UI
 */
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('gateway_connection_status');
    if (statusEl) {
        statusEl.textContent = connected ? '已连接' : '未连接';
        statusEl.className = `gateway-status ${connected ? 'connected' : 'disconnected'}`;
    }
}

/**
 * 更新状态 UI
 */
function updateStatusUI(status) {
    if (!status?.adapters) return;

    const platforms = ['qq', 'telegram', 'discord'];
    const stateTexts = {
        connected: '在线',
        disconnected: '离线',
        connecting: '连接中',
        reconnecting: '重连中',
        error: '错误',
    };

    for (const platform of platforms) {
        const adapterStatus = status.adapters[platform];
        const stateEl = document.getElementById(`gateway_${platform}_state`);

        if (stateEl && adapterStatus) {
            const stateText = stateTexts[adapterStatus.state] || adapterStatus.state;
            stateEl.textContent = stateText;
            stateEl.className = `gateway-state ${adapterStatus.state}`;
        }
    }

    // 更新消息日志
    if (status.recentMessages) {
        updateMessageLog(status.recentMessages);
    }
}

/**
 * 更新消息日志 UI
 */
function updateMessageLog(messages) {
    const logEl = document.getElementById('gateway_message_log');
    if (!logEl) return;

    if (!messages || messages.length === 0) {
        logEl.innerHTML = '<div class="gateway-empty-message">暂无消息</div>';
        return;
    }

    const html = messages.slice(-50).reverse().map(msg => {
        const time = new Date(msg.timestamp).toLocaleTimeString();
        const direction = msg.direction === 'inbound' ? '←' : '→';
        const platformIcon = getPlatformIcon(msg.platform);
        return `
            <div class="gateway-message-item ${msg.direction}">
                <span class="gateway-msg-time">${time}</span>
                <span class="gateway-msg-platform">${platformIcon}</span>
                <span class="gateway-msg-direction">${direction}</span>
                <span class="gateway-msg-content">${escapeHtml(msg.content || '')}</span>
            </div>
        `;
    }).join('');

    logEl.innerHTML = html;
}

/**
 * 获取平台图标
 */
function getPlatformIcon(platform) {
    const icons = {
        qq: '🐧',
        telegram: '✈️',
        discord: '🎮',
    };
    return icons[platform] || '💬';
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 发送消息
 */
async function sendMessage(platform, chatId, content) {
    try {
        const result = await apiRequest('/api/gateway/send', {
            method: 'POST',
            body: JSON.stringify({ platform, chatId, content }),
        });

        if (result.success) {
            toastr.success('消息已发送');
        } else {
            toastr.error(result.error || '发送失败');
        }
        return result;
    } catch (error) {
        toastr.error(`发送失败: ${error.message}`);
        return null;
    }
}

/**
 * 获取会话列表
 */
async function fetchSessions() {
    try {
        const sessions = await apiRequest('/api/gateway/sessions');
        updateSessionList(sessions);
        return sessions;
    } catch (error) {
        return [];
    }
}

/**
 * 更新会话列表 UI
 */
function updateSessionList(sessions) {
    const listEl = document.getElementById('gateway_session_list');
    if (!listEl) return;

    if (!sessions || sessions.length === 0) {
        listEl.innerHTML = '<div class="gateway-empty-message">暂无会话</div>';
        return;
    }

    const html = sessions.map(session => {
        const time = new Date(session.lastActiveAt).toLocaleString();
        const platformIcon = getPlatformIcon(session.platform);
        return `
            <div class="gateway-session-item" data-platform="${session.platform}" data-chatid="${session.chatId}">
                <span class="gateway-session-icon">${platformIcon}</span>
                <span class="gateway-session-id">${session.chatId}</span>
                <span class="gateway-session-count">${session.messageCount} 条</span>
                <span class="gateway-session-time">${time}</span>
            </div>
        `;
    }).join('');

    listEl.innerHTML = html;
}

/**
 * 启动轮询
 */
function startPolling() {
    stopPolling();
    const settings = getSettings();
    pollTimer = setInterval(() => {
        if (gatewayConnected) {
            fetchGatewayStatus();
        }
    }, settings.pollInterval);
}

/**
 * 停止轮询
 */
function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

/**
 * 显示网关窗口
 */
async function showGatewayWindow() {
    const html = await renderExtensionTemplateAsync('gateway', 'window');
    const dialog = $(html);

    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    // 绑定窗口内事件
    setTimeout(() => {
        bindWindowEvents();
        fetchGatewayStatus();
        fetchSessions();
    }, 100);
}

/**
 * 绑定窗口事件
 */
function bindWindowEvents() {
    // 刷新按钮
    $('#gateway_refresh_btn').on('click', () => {
        fetchGatewayStatus();
        fetchSessions();
    });

    // 发送按钮
    $('#gateway_send_btn').on('click', async () => {
        const platform = $('#gateway_send_platform').val();
        const chatId = $('#gateway_send_chatid').val().trim();
        const content = $('#gateway_send_content').val().trim();

        if (!chatId || !content) {
            toastr.warning('请填写目标 ID 和消息内容');
            return;
        }

        await sendMessage(platform, chatId, content);
        $('#gateway_send_content').val('');
        fetchGatewayStatus();
    });

    // 会话项点击
    $(document).on('click', '.gateway-session-item', function () {
        const platform = $(this).data('platform');
        const chatId = $(this).data('chatid');
        $('#gateway_send_platform').val(platform);
        $('#gateway_send_chatid').val(chatId);
    });
}

/**
 * 绑定设置面板事件
 */
function bindSettingsEvents() {
    // 连接按钮
    $('#gateway_connect_btn').on('click', async () => {
        const serverUrl = $('#gateway_server_url').val().trim();
        if (serverUrl) {
            getSettings().serverUrl = serverUrl;
        }
        await fetchGatewayStatus();
        startPolling();
    });

    // 断开按钮
    $('#gateway_disconnect_btn').on('click', () => {
        stopPolling();
        gatewayConnected = false;
        updateConnectionStatus(false);
    });

    // 保存设置
    $('#gateway_save_settings').on('click', async () => {
        const settings = getSettings();
        settings.serverUrl = $('#gateway_server_url').val().trim();
        settings.autoReplyEnabled = $('#gateway_auto_reply_enabled_ext').is(':checked');

        // 同步到后端配置
        try {
            await apiRequest('/api/gateway/config', {
                method: 'POST',
                body: JSON.stringify({
                    adapters: {
                        qq: {
                            enabled: $('#gateway_qq_enabled').is(':checked'),
                            mode: $('#gateway_qq_mode').val(),
                            wsUrl: $('#gateway_qq_ws_url').val().trim(),
                            accessToken: $('#gateway_qq_token').val(),
                        },
                        telegram: {
                            enabled: $('#gateway_telegram_enabled').is(':checked'),
                            botToken: $('#gateway_telegram_token').val(),
                            requireMention: $('#gateway_telegram_require_mention').is(':checked'),
                        },
                        discord: {
                            enabled: $('#gateway_discord_enabled').is(':checked'),
                            botToken: $('#gateway_discord_token').val(),
                            requireMention: $('#gateway_discord_require_mention').is(':checked'),
                        },
                    },
                    autoReply: {
                        enabled: settings.autoReplyEnabled,
                        responseDelay: parseInt($('#gateway_response_delay').val()) || 500,
                    },
                }),
            });
            toastr.success('设置已保存');
        } catch (error) {
            toastr.error(`保存失败: ${error.message}`);
        }
    });

    // 重新加载配置
    $('#gateway_reload_config').on('click', async () => {
        try {
            const config = await apiRequest('/api/gateway/config');
            loadConfigToUI(config);
            toastr.success('配置已加载');
        } catch (error) {
            toastr.error(`加载失败: ${error.message}`);
        }
    });
}

/**
 * 将配置加载到 UI
 */
function loadConfigToUI(config) {
    if (!config) return;

    const adapters = config.adapters || {};

    // QQ
    if (adapters.qq) {
        $('#gateway_qq_enabled').prop('checked', adapters.qq.enabled);
        $('#gateway_qq_mode').val(adapters.qq.mode);
        $('#gateway_qq_ws_url').val(adapters.qq.wsUrl);
        $('#gateway_qq_token').val(adapters.qq.accessToken);
    }

    // Telegram
    if (adapters.telegram) {
        $('#gateway_telegram_enabled').prop('checked', adapters.telegram.enabled);
        $('#gateway_telegram_token').val(adapters.telegram.botToken);
        $('#gateway_telegram_require_mention').prop('checked', adapters.telegram.requireMention);
    }

    // Discord
    if (adapters.discord) {
        $('#gateway_discord_enabled').prop('checked', adapters.discord.enabled);
        $('#gateway_discord_token').val(adapters.discord.botToken);
        $('#gateway_discord_require_mention').prop('checked', adapters.discord.requireMention);
    }

    // 自动回复
    if (config.autoReply) {
        $('#gateway_auto_reply_enabled_ext').prop('checked', getSettings().autoReplyEnabled);
        $('#gateway_response_delay').val(config.autoReply.responseDelay);
    }
}

/**
 * 注册斜杠命令
 */
function registerSlashCommands() {
    // /gateway status - 查看网关状态
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gateway',
        callback: async (args, value) => {
            const subCommand = value?.trim().split(' ')[0] || 'status';

            switch (subCommand) {
                case 'status':
                    const status = await fetchGatewayStatus();
                    if (status) {
                        const lines = Object.entries(status.adapters)
                            .map(([name, s]) => `${name}: ${s.state}`)
                            .join('\n');
                        return `网关状态:\n${lines}`;
                    }
                    return '网关未连接';

                case 'send':
                    const parts = value.trim().split(' ');
                    if (parts.length >= 4) {
                        const platform = parts[1];
                        const chatId = parts[2];
                        const content = parts.slice(3).join(' ');
                        await sendMessage(platform, chatId, content);
                        return `消息已发送到 ${platform}:${chatId}`;
                    }
                    return '用法: /gateway send <platform> <chatId> <message>';

                case 'open':
                    await showGatewayWindow();
                    return '网关控制台已打开';

                default:
                    return '可用命令: /gateway status, /gateway send, /gateway open';
            }
        },
        returns: '网关操作结果',
        namedArgumentList: [],
        unnamedArgumentList: [
            {
                name: 'command',
                description: '子命令: status, send, open',
                isRequired: false,
                acceptsMultiple: false,
                enumList: [
                    { value: 'status', description: '查看状态' },
                    { value: 'send', description: '发送消息' },
                    { value: 'open', description: '打开控制台' },
                ],
            },
        ],
        helpString: `
            <h3>多平台网关命令</h3>
            <ul>
                <li><code>/gateway status</code> - 查看各平台连接状态</li>
                <li><code>/gateway send qq 123456 你好</code> - 发送消息到 QQ 群</li>
                <li><code>/gateway open</code> - 打开网关控制台</li>
            </ul>
        `,
    }));
}

// ==================== 扩展初始化 ====================

jQuery(async () => {
    console.log('[Gateway] 扩展加载中...');

    // 添加扩展按钮到菜单
    const buttonHtml = `
        <div id="gateway_extension" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-tower-broadcast extensionsMenuExtensionButton" /></div>
            多平台网关
        </div>
    `;
    $('#extensions_menu_container').append(buttonHtml);

    // 绑定按钮点击
    $('#gateway_extension').on('click', async () => {
        await showGatewayWindow();
    });

    // 加载设置面板
    const settingsHtml = await renderExtensionTemplateAsync('gateway', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    // 绑定设置事件
    bindSettingsEvents();

    // 注册斜杠命令
    registerSlashCommands();

    // 设置 AI 生成监听器（捕获 AI 回复并转发）
    setupGenerationListener();

    // 自动连接（默认启用）
    if (getSettings().autoConnect) {
        await fetchGatewayStatus();
        startPolling();
    }

    console.log('[Gateway] 扩展加载完成，AI 自动回复管线已就绪');
});
