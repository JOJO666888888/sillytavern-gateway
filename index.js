/**
 * SillyTavern Multi-Platform Gateway Extension
 * 前端扩展入口 - 完整 AI 自动回复管线
 *
 * 工作流程:
 *   平台消息 → 网关 → 扩展轮询 → 注入 ST 聊天 → 触发 AI 生成 → 回复转发回平台
 *
 * 重要说明:
 *   本扩展不使用相对路径静态导入 ST 内部模块(如 ../../extensions.js)。
 *   因为扩展的安装位置(第三方/用户目录)和 ST 版本内部结构会变化，
 *   相对导入极易解析失败导致整个扩展无法加载(表现为前端毫无反应)。
 *   因此统一改用:
 *     1. SillyTavern 全局上下文 (SillyTavern.getContext()) —— 官方稳定 API
 *     2. 根路径动态导入 (import '/script.js') —— 获取未暴露到上下文的函数
 *     3. import.meta.url 自动检测扩展文件夹名 —— 用于模板渲染
 */

// ==================== 健壮引导 ====================

/** 获取 SillyTavern 全局对象 */
function getST() {
    return globalThis.SillyTavern;
}

/** 获取 ST 上下文(每次调用返回最新引用) */
function getContext() {
    return getST().getContext();
}

/**
 * 从 import.meta.url 自动检测扩展文件夹路径。
 * 例: http://host/scripts/extensions/third-party/sillytavern-gateway/index.js
 *     -> "third-party/sillytavern-gateway"
 * renderExtensionTemplateAsync 需要这个路径来定位模板文件。
 */
function detectExtensionName() {
    try {
        const url = import.meta.url.split('?')[0];
        const marker = '/scripts/extensions/';
        const idx = url.indexOf(marker);
        if (idx !== -1) {
            const rest = url.substring(idx + marker.length);
            const dir = rest.substring(0, rest.lastIndexOf('/'));
            if (dir) return dir;
        }
    } catch (e) { /* 忽略, 使用兜底值 */ }
    return 'third-party/sillytavern-gateway';
}

/** 扩展文件夹路径(模板渲染用) */
const EXTENSION_NAME = detectExtensionName();

/**
 * 推导 ST 部署根地址(兼容非根路径部署)。
 * 例: http://host/scripts/extensions/... -> http://host
 */
function detectServerRoot() {
    try {
        const url = import.meta.url.split('?')[0];
        const idx = url.indexOf('/scripts/extensions/');
        if (idx !== -1) return url.substring(0, idx);
    } catch (e) { /* 忽略 */ }
    return '';
}
const SERVER_ROOT = detectServerRoot();

/**
 * 健壮的模板渲染:
 *   1. 优先使用 ST 官方 renderExtensionTemplateAsync(带 DOMPurify 净化 + i18n)
 *   2. 失败时兜底: 直接从本模块所在目录 fetch 静态 HTML
 */
async function renderTemplate(templateName) {
    try {
        return await getContext().renderExtensionTemplateAsync(EXTENSION_NAME, templateName);
    } catch (e) {
        console.warn(`[Gateway] 官方模板接口失败(${e.message}), 回退直接读取`);
    }
    const moduleUrl = import.meta.url.split('?')[0];
    const base = moduleUrl.substring(0, moduleUrl.lastIndexOf('/'));
    const resp = await fetch(`${base}/${templateName}.html`);
    if (!resp.ok) throw new Error(`模板 ${templateName}.html 加载失败: HTTP ${resp.status}`);
    return await resp.text();
}

// ==================== 获取 ST API ====================
// 全部来自官方 getContext(), 不再依赖脆弱的相对路径导入
const {
    eventSource,
    event_types,
    extensionSettings: extension_settings,
    SlashCommand,
    SlashCommandParser,
    callGenericPopup,
    POPUP_TYPE,
    saveSettingsDebounced,
} = getContext();

// sendMessageAsUser / doNavbarIconClick 未暴露到 getContext(),
// 通过根路径动态导入 script.js 获取(该模块已被 ST 加载, 此处仅取缓存引用)
const { sendMessageAsUser, doNavbarIconClick } = await import(`${SERVER_ROOT}/script.js`);

// 扩展设置默认值
const DEFAULT_SETTINGS = {
    serverUrl: 'http://127.0.0.1:3210',
    autoConnect: true,
    pollInterval: 3000,
    autoReplyEnabled: true,
    forwardingEnabled: false, // 默认游玩模式(不转发消息); 网关模式需手动开启
    autoUpdate: true,         // 启动 ST 时自动检查网关更新
    autoStartServer: false,   // 启动 ST 时是否自动启动本地网关服务(需要 Node 环境)
    serverPath: '',           // 本地网关服务入口路径(server/index.js 的绝对路径)，若为空则尝试从 import.meta.url 推导
};

// 扩展状态
let gatewayConnected = false;
let gatewayServerProcess = null;      // 本扩展自动启动的网关服务子进程
let gatewayServerStartedByUs = false; // 是否由本扩展启动服务
let pollTimer = null;
let lastMessages = [];
/** 已处理过的消息 ID 集合 (platform+chatId+timestamp) */
const processedMessageIds = new Set();

// ==================== 本地网关服务启动/停止 ====================

/**
 * 尝试获取 Node 模块
 * 仅在 Electron 等允许 renderer 访问 Node 的环境有效
 */
function getNodeModule(name) {
    if (typeof require !== 'undefined') {
        try { return require(name); } catch (_) {}
    }
    if (globalThis.require) {
        try { return globalThis.require(name); } catch (_) {}
    }
    return null;
}

/**
 * 解析网关后端服务入口文件路径
 * 优先使用用户配置路径，其次从 import.meta.url 推导
 */
function resolveGatewayServerPath() {
    // 优先使用手动配置的路径
    const configuredPath = getSettings().serverPath;
    if (configuredPath) {
        return configuredPath;
    }

    try {
        const urlModule = getNodeModule('url');
        const serverUrl = new URL('server/index.js', import.meta.url);
        if (urlModule && urlModule.fileURLToPath) {
            return urlModule.fileURLToPath(serverUrl);
        }
        // fallback: 简单转换 file:// 路径
        return serverUrl.href.replace(/^file:\/\//, '').replace(/\//g, '\\');
    } catch (error) {
        console.error('[Gateway] 解析服务路径失败:', error);
        return null;
    }
}

/**
 * 启动本地网关服务（作为子进程）
 * 需要 ST 环境允许扩展访问 Node child_process，否则抛出错误
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function startGatewayServer() {
    if (gatewayServerProcess) {
        return { success: true, message: '网关服务已在运行' };
    }

    // 若服务已经在外部运行，直接认为已就绪
    let alreadyRunning = false;
    try {
        const res = await fetch(`${getSettings().serverUrl}/api/gateway/health`);
        alreadyRunning = res.ok;
    } catch (_) {}
    if (alreadyRunning) {
        return { success: true, message: '网关服务已在运行（外部启动）' };
    }

    const childProcess = getNodeModule('child_process');
    if (!childProcess || typeof childProcess.spawn !== 'function') {
        throw new Error('当前 SillyTavern 环境不允许扩展访问 Node child_process，无法从扩展内启动网关服务');
    }

    const serverPath = resolveGatewayServerPath();
    if (!serverPath) {
        throw new Error('无法定位网关服务入口文件 (server/index.js)，请检查扩展目录完整性');
    }

    return new Promise((resolve, reject) => {
        try {
            console.log(`[Gateway] 正在启动本地网关服务: ${serverPath}`);
            gatewayServerProcess = childProcess.spawn('node', [serverPath], {
                detached: false,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            gatewayServerStartedByUs = true;

            let stdoutBuffer = '';
            let stderrBuffer = '';

            gatewayServerProcess.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop();
                for (const line of lines) {
                    if (line.trim()) console.log('[Gateway Server]', line.trim());
                }
            });

            gatewayServerProcess.stderr.on('data', (data) => {
                stderrBuffer += data.toString();
                const lines = stderrBuffer.split('\n');
                stderrBuffer = lines.pop();
                for (const line of lines) {
                    if (line.trim()) console.error('[Gateway Server]', line.trim());
                }
            });

            gatewayServerProcess.on('error', (error) => {
                console.error('[Gateway] 服务子进程错误:', error.message);
                gatewayServerProcess = null;
                gatewayServerStartedByUs = false;
                reject(new Error(`启动网关服务失败: ${error.message}`));
            });

            gatewayServerProcess.on('close', (code) => {
                console.log(`[Gateway] 服务子进程退出，code=${code}`);
                gatewayServerProcess = null;
                gatewayServerStartedByUs = false;
                if (typeof updateGatewayServerUI === 'function') updateGatewayServerUI();
            });

            // 等待服务端口就绪，最多 10 秒
            let attempts = 0;
            const maxAttempts = 20;
            const timer = setInterval(() => {
                attempts++;
                if (gatewayServerProcess === null) {
                    clearInterval(timer);
                    reject(new Error('网关服务启动后异常退出'));
                    return;
                }
                fetch(`${getSettings().serverUrl}/api/gateway/health`)
                    .then((res) => {
                        if (res.ok) {
                            clearInterval(timer);
                            resolve({ success: true, message: '网关服务已启动并就绪' });
                        }
                    })
                    .catch(() => {});
                if (attempts >= maxAttempts) {
                    clearInterval(timer);
                    // 虽然还没检测到就绪，但进程可能正在启动，也算部分成功
                    resolve({ success: true, message: '网关服务已启动，正在等待就绪' });
                }
            }, 500);
        } catch (error) {
            gatewayServerProcess = null;
            gatewayServerStartedByUs = false;
            reject(error);
        }
    });
}

/**
 * 停止由本扩展启动的网关服务
 */
async function stopGatewayServer() {
    if (!gatewayServerProcess) {
        return { success: true, message: '网关服务未在运行' };
    }
    try {
        gatewayServerProcess.kill();
        gatewayServerProcess = null;
        gatewayServerStartedByUs = false;
        return { success: true, message: '网关服务已停止' };
    } catch (error) {
        throw new Error(`停止网关服务失败: ${error.message}`);
    }
}
/**
 * 转发时间截断戳: 只转发 timestamp > 此值 的入站消息。
 * 在页面加载时和切换到网关模式时重置, 确保刷新/重启后
 * 绝不会把之前缓存的老消息转发过来。
 */
let forwardCutoffTs = Date.now();
/** 等待 AI 回复的目标 { platform, chatId } */
let pendingReplyTarget = null;
/** 是否正在处理消息（防止重复触发） */
let isProcessing = false;
/** 会话-角色绑定表 (由 st-data-manager 插件维护，ST 扩展轮询拉取) */
let gatewayBindings = {};
/** 上次拉取绑定表的时间戳（节流，避免每次轮询都拉取） */
let lastBindingsFetch = 0;

/**
 * 获取扩展设置
 */
function getSettings() {
    if (!extension_settings.gateway) {
        extension_settings.gateway = { ...DEFAULT_SETTINGS };
    }
    // 存量用户兼容：旧版设置无 forwardingEnabled 字段, 回退为 true（保持原有行为）
    if (extension_settings.gateway.forwardingEnabled === undefined) {
        extension_settings.gateway.forwardingEnabled = true;
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
        // 双门控: 仅网关模式(forwardingEnabled)且开启自动回复时才转发
        if (status.recentMessages && getSettings().forwardingEnabled && getSettings().autoReplyEnabled) {
            // 拉取角色绑定表（每 5 秒最多拉取一次，避免频繁请求）
            const now = Date.now();
            if (now - lastBindingsFetch > 5000) {
                lastBindingsFetch = now;
                try {
                    const pluginConfig = await apiRequest('/api/plugins/st-data-manager/config');
                    if (pluginConfig?.config?.bindings) {
                        gatewayBindings = pluginConfig.config.bindings;
                    }
                } catch (e) {
                    // 插件未安装或网关未连接，使用空绑定表
                }
            }
            await processIncomingMessages(status.recentMessages);
        }

        return status;
    } catch (error) {
        gatewayConnected = false;
        updateConnectionStatus(false);
        return null;
    }
}

// ==================== 角色路由（st-data-manager 插件联动） ====================

/**
 * 切换 ST 当前角色
 * 尝试多种方式，兼容不同 ST 版本：
 *   1. 通过 slash command /loadchar
 *   2. 通过 selectCharacterById 全局函数
 *   3. 通过 ST 后端 API
 *
 * @param {string} characterName - 目标角色名
 * @returns {Promise<boolean>} 是否切换成功
 */
async function switchCharacter(characterName) {
    const context = getContext();

    // 已是当前角色，无需切换
    if (context.name2 === characterName) {
        return true;
    }

    // 查找角色
    const characters = context.characters || [];
    const targetChar = characters.find(c => c.name === characterName);
    if (!targetChar) {
        console.warn(`[Gateway] 角色路由: 未找到角色 "${characterName}"，保持当前角色`);
        return false;
    }

    // 方式1: 通过 slash command /loadchar（最稳定）
    try {
        const { SlashCommandParser: Parser } = context;
        if (Parser) {
            // ST 的 SlashCommandParser 可通过 parseAndWait 或类似方法执行命令
            // 不同 ST 版本 API 可能不同，尝试多种调用方式
            if (typeof Parser.parse === 'function') {
                await Parser.parse(`/loadchar ${characterName}`);
                console.log(`[Gateway] 角色路由: 已通过 /loadchar 切换到 "${characterName}"`);
                return true;
            }
        }
    } catch (e) {
        console.warn(`[Gateway] /loadchar 切换失败: ${e.message}`);
    }

    // 方式2: 通过 selectCharacterById 全局函数
    try {
        // selectCharacterById 可能在 script.js 或 characters.js 中
        const charModule = await import(`${SERVER_ROOT}/scripts/characters.js`).catch(() => null);
        if (charModule?.selectCharacterById) {
            await charModule.selectCharacterById(targetChar.avatar);
            console.log(`[Gateway] 角色路由: 已通过 selectCharacterById 切换到 "${characterName}"`);
            return true;
        }
    } catch (e) {
        console.warn(`[Gateway] selectCharacterById 切换失败: ${e.message}`);
    }

    // 方式3: 通过全局 window 对象查找
    try {
        if (typeof window !== 'undefined' && typeof window.selectCharacterById === 'function') {
            await window.selectCharacterById(targetChar.avatar);
            console.log(`[Gateway] 角色路由: 已通过 window.selectCharacterById 切换到 "${characterName}"`);
            return true;
        }
    } catch (e) {
        console.warn(`[Gateway] window.selectCharacterById 失败: ${e.message}`);
    }

    console.error(`[Gateway] 角色路由: 所有切换方式均失败，无法切换到 "${characterName}"`);
    return false;
}

/**
 * 等待角色加载完成
 * 监听 CHARACTER_CHANGED 事件，超时后强制返回
 *
 * @param {string} characterName - 期望的角色名
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @returns {Promise<void>}
 */
function waitForCharacterLoad(characterName, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const context = getContext();

        // 如果已经是目标角色，立即返回
        if (context.name2 === characterName) {
            resolve();
            return;
        }

        let resolved = false;
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.warn(`[Gateway] 角色路由: 等待 "${characterName}" 加载超时，继续处理`);
                resolve();
            }
        }, timeoutMs);

        // 监听角色变更事件
        const handler = () => {
            const ctx = getContext();
            if (ctx.name2 === characterName && !resolved) {
                resolved = true;
                clearTimeout(timer);
                eventSource.off(event_types.CHARACTER_CHANGED, handler);
                console.log(`[Gateway] 角色路由: "${characterName}" 加载完成`);
                resolve();
            }
        };

        // CHARACTER_CHANGED 可能在不同 ST 版本中名称不同
        const evtType = event_types.CHARACTER_CHANGED || event_types.CHAT_CHANGED;
        if (evtType) {
            eventSource.on(evtType, handler);
        } else {
            // 无事件可用，直接等超时
        }
    });
}

// ==================== AI 自动回复管线 ====================

/**
 * 处理入站消息：注入 ST 聊天 → 触发 AI 生成 → 回复转发
 */
async function processIncomingMessages(messages) {
    // 只处理入站、未处理过、且晚于截断时间到达的消息
    const newMessages = messages.filter(msg => {
        if (msg.direction !== 'inbound') return false;
        // 时间截断: 只处理进入页面/开启网关模式之后才到达的消息,
        // 防止刷新/重启后把之前缓存的老消息批量转发进来
        if (msg.timestamp <= forwardCutoffTs) return false;
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

            // === 角色路由：按绑定表切换 ST 角色 ===
            const sessionKey = `${msg.platform}:${msg.chatId}`;
            const binding = gatewayBindings[sessionKey];
            if (binding && binding.characterName) {
                const ctx = getContext();
                const currentName = ctx.name2;
                if (currentName !== binding.characterName) {
                    console.log(`[Gateway] 角色路由: ${sessionKey} 需要切换 ${currentName} -> ${binding.characterName}`);
                    const switched = await switchCharacter(binding.characterName);
                    if (switched) {
                        await waitForCharacterLoad(binding.characterName, 2000);
                    }
                }
            } else {
                // 未绑定，保持当前角色（不影响原有行为）
            }

            // 记录回复目标
            pendingReplyTarget = {
                platform: msg.platform,
                chatId: msg.chatId,
                chatType: msg.chatType || 'private', // 频道消息需传 chatType, 否则 Discord 会用频道ID当用户ID查询导致发送失败
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
        // 游玩模式(未开启转发)时, 不把 AI 回复转发出去
        if (!getSettings().forwardingEnabled) return;
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
                    chatType: target.chatType || 'private',
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

/**
 * 更新模式开关 UI（游玩模式 / 网关模式）
 * 同时将开关勾选状态与设置同步（面板注入后用于恢复状态）
 */
function updateModeUI() {
    const enabled = getSettings().forwardingEnabled;
    const textEl = $('#gateway_panel_mode_text');
    const hintEl = $('#gateway_panel_mode_hint');
    if (textEl.length) {
        textEl.text(enabled ? '网关模式' : '游玩模式');
    }
    if (hintEl.length) {
        hintEl.text(enabled ? '转发平台消息并自动回复' : '不转发消息，安心游玩');
    }
    // 区块配色: 网关模式绿色高亮, 游玩模式灰色
    $('#gateway_mode_block').toggleClass('mode-active', enabled);
    $('#gateway_panel_forwarding').prop('checked', enabled);
}

/**
 * 恢复自动更新开关状态
 */
function updateUpdateUI() {
    $('#gateway_panel_auto_update').prop('checked', getSettings().autoUpdate);
}

/**
 * 更新本地服务控制 UI
 */
function updateGatewayServerUI() {
    const autoStart = getSettings().autoStartServer;
    $('#gateway_panel_auto_start_server').prop('checked', autoStart);
    $('#gateway_panel_server_path').val(getSettings().serverPath || '');
    const running = !!gatewayServerProcess;
    $('#gateway_panel_start_server').prop('disabled', running);
    $('#gateway_panel_stop_server').prop('disabled', !running);
    const stateEl = $('#gateway_panel_server_state');
    if (running) {
        stateEl.text('运行中').removeClass('disconnected').addClass('connected');
    } else {
        stateEl.text('未启动').removeClass('connected').addClass('disconnected');
    }
}

/**
 * 检查网关更新
 * @param {boolean} silent - true 时仅在发现更新时通知, 无更新则静默
 */
async function checkForUpdate(silent = false) {
    const checkBtn = $('#gateway_panel_update_check');
    const infoEl = $('#gateway_panel_update_info');

    checkBtn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');

    try {
        const result = await apiRequest('/api/gateway/update/check');
        if (result.hasUpdate) {
            infoEl.show().html(`
                <i class="fa-solid fa-circle-up"></i> 发现新版本！
                当前 <code>${result.currentCommit}</code> → 最新 <code>${result.latestCommit}</code>
                （落后 <b>${result.behindBy}</b> 个提交）
            `);
            $('#gateway_panel_update_apply').show();
            if (!silent) {
                toastr.info(`发现新版本（落后 ${result.behindBy} 个提交）`, '网关更新');
            }
        } else {
            infoEl.show().html('<i class="fa-solid fa-circle-check"></i> 已是最新版本 ✓');
            $('#gateway_panel_update_apply').hide();
            if (!silent) {
                toastr.success('已是最新版本');
            }
        }
    } catch (error) {
        infoEl.show().html(`<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(error.message)}`);
        if (!silent) {
            toastr.error(`检查更新失败: ${error.message}`);
        }
    } finally {
        checkBtn.prop('disabled', false).html('<i class="fa-solid fa-magnifying-glass"></i> 检查更新');
    }
}

/**
 * 应用网关更新（git pull + 自动 npm install）
 */
async function applyUpdate() {
    const btn = $('#gateway_panel_update_apply');
    const infoEl = $('#gateway_panel_update_info');

    if (!confirm('确定要更新网关程序吗？更新后需要重启网关服务。')) return;

    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 更新中');

    try {
        const result = await apiRequest('/api/gateway/update/apply', { method: 'POST' });
        if (result.success) {
            toastr.success(result.message);
            infoEl.show().html(`<i class="fa-solid fa-circle-check"></i> ${escapeHtml(result.message)}`);
            btn.hide();
            // 提示重启
            toastr.info('请重启网关服务以应用更改（在终端中重新运行 node server/index.js）', '', { timeOut: 15000 });
        } else {
            toastr.error(result.error);
            infoEl.show().html(`<i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(result.error)}`);
        }
    } catch (error) {
        toastr.error(`更新失败: ${error.message}`);
    } finally {
        btn.prop('disabled', false).html('<i class="fa-solid fa-download"></i> 立即更新');
    }
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

    // 同步顶级面板连接状态徽标
    const panelBadge = document.getElementById('gateway_panel_status');
    if (panelBadge) {
        panelBadge.textContent = connected ? '已连接' : '未连接';
        panelBadge.className = `gateway-status-badge ${connected ? 'connected' : 'disconnected'}`;
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

        // 同步顶级面板适配器状态徽标
        const prefix = PLATFORM_PREFIX[platform];
        const panelStateEl = document.getElementById(`gateway_panel_${prefix}_state`);
        if (panelStateEl && adapterStatus) {
            const stateText = stateTexts[adapterStatus.state] || adapterStatus.state;
            panelStateEl.textContent = stateText;
            panelStateEl.className = `gateway-adapter-state ${adapterStatus.state}`;
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

/** 平台名 -> 面板元素 ID 前缀映射 (telegram->tg, discord->dc) */
const PLATFORM_PREFIX = {
    qq: 'qq',
    telegram: 'tg',
    discord: 'dc',
};

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
    const html = await renderTemplate('window');
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
            saveSettingsDebounced();
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
        saveSettingsDebounced();

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

/**
 * 扩展主初始化逻辑
 */
async function initExtension() {
    console.log('[Gateway] 扩展加载中...');

    // 页面加载时间截断: 只转发进入本页面之后才到达的消息,
    // 在此之前缓存的老消息一律不转发(无论是刷新还是重启)
    forwardCutoffTs = Date.now();

    // === 注入顶级设置面板（与预设、API、世界书同等级）===
    // 单独 try/catch: 面板注入失败不应影响其他功能(斜杠命令/自动回复等)
    try {
        await initGatewayPanel();
    } catch (error) {
        console.error('[Gateway] 顶级面板注入失败(不影响其他功能):', error);
    }

    // 添加扩展按钮到菜单（保留原有入口）
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

    // 加载设置面板（扩展页内的简版设置）
    try {
        const settingsHtml = await renderTemplate('settings');
        $('#extensions_settings2').append(settingsHtml);
        bindSettingsEvents();
    } catch (error) {
        console.error('[Gateway] 扩展页设置面板加载失败:', error);
    }

    // 注册斜杠命令
    registerSlashCommands();

    // 设置 AI 生成监听器（捕获 AI 回复并转发）
    setupGenerationListener();

    // 自动启动本地网关服务（若启用）
    if (getSettings().autoStartServer) {
        try {
            await startGatewayServer();
        } catch (error) {
            console.warn('[Gateway] 自动启动本地服务失败:', error.message);
            toastr.warning(`网关服务自动启动失败: ${error.message}`);
        }
    }

    // 自动连接（默认启用）
    if (getSettings().autoConnect) {
        await fetchGatewayStatus();
        startPolling();
    }

    // 注册页面关闭时清理自动启动的服务
    if (gatewayServerStartedByUs) {
        window.addEventListener('beforeunload', () => {
            if (gatewayServerProcess) {
                try { gatewayServerProcess.kill(); } catch (_) {}
            }
        });
    }

    // 新用户/未开启转发时给出提示
    if (!getSettings().forwardingEnabled) {
        toastr.info('当前为"游玩模式"——消息不会转发。如需使用网关功能，请在面板中切换到"网关模式"。', '', {
            timeOut: 8000,
            extendedTimeOut: 3000,
        });
    }

    // 自动更新检查
    if (getSettings().autoUpdate && gatewayConnected) {
        setTimeout(() => checkForUpdate(true), 3000); // 延迟 3s, 避免与启动阶段网络请求竞争
    }

    console.log('[Gateway] 扩展加载完成，AI 自动回复管线已就绪');
}

/**
 * 启动入口:
 *   优先使用 ST 官方 APP_READY 事件(应用完全就绪后触发, 若已就绪则附加后立即自动触发),
 *   老版本不支持时回退到 jQuery DOM-ready。
 */
(function bootstrap() {
    const readyEventType = event_types?.APP_READY;
    if (eventSource && readyEventType) {
        eventSource.on(readyEventType, async () => {
            try {
                await initExtension();
            } catch (error) {
                console.error('[Gateway] 扩展初始化失败:', error);
            }
        });
    } else {
        jQuery(async () => {
            try {
                await initExtension();
            } catch (error) {
                console.error('[Gateway] 扩展初始化失败:', error);
            }
        });
    }
})();

// ==================== 顶级面板 ====================

/**
 * 初始化网关顶级设置面板
 * 注入到 ST 顶部设置栏(#top-settings-holder)，与预设/API/世界书/扩展同等级。
 *
 * 关键点:
 *   - 使用与 ST 原生 drawer 完全一致的 DOM 结构(.drawer > .drawer-toggle > .drawer-icon + .drawer-content)
 *   - 绑定 ST 官方导出的 doNavbarIconClick 处理开关(自动互斥关闭其他 drawer、点击外部自动收起)
 *   - 面板作为 .drawer-content 初始带 closedDrawer 类(由 ST CSS 控制隐藏)
 */
async function initGatewayPanel() {
    // 防止重复注入
    if ($('#gateway_drawer_button').length) {
        return;
    }

    // 1. 加载面板 HTML (作为 drawer-content)
    const panelHtml = await renderTemplate('panel');

    // 2. 构建与 ST 原生一致的完整 drawer 结构(按钮 + 内容)
    const drawerHtml = `
        <div id="gateway_drawer_button" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="gatewayDrawerIcon" class="drawer-icon fa-solid fa-tower-broadcast fa-fw closedIcon" title="多平台网关" data-i18n="[title]多平台网关"></div>
            </div>
            ${panelHtml}
        </div>
    `;

    // 3. 插入到顶部设置栏, 紧跟在"扩展"图标之后(与预设/API/世界书同级)
    const anchor = $('#extensions-settings-button');
    if (anchor.length) {
        anchor.after(drawerHtml);
    } else {
        // 兜底: 直接追加到顶部设置容器
        $('#top-settings-holder').append(drawerHtml);
    }

    // 4. 绑定 ST 官方 drawer 开关逻辑。
    //    注意: ST 的 $('.drawer-toggle').on('click', doNavbarIconClick) 是在页面加载时
    //    直接绑定到已存在元素的, 动态注入的 drawer 不会自动获得, 需手动绑定。
    $('#gateway_drawer_button .drawer-toggle').on('click', doNavbarIconClick);

    // 5. 监听面板开合状态, 打开时自动刷新数据
    const panelEl = document.getElementById('gateway_panel');
    if (panelEl) {
        const observer = new MutationObserver(() => {
            if (panelEl.classList.contains('openDrawer')) {
                refreshPanelData();
            }
        });
        observer.observe(panelEl, { attributes: true, attributeFilter: ['class'] });
    }

    // 6. 绑定面板内部事件
    bindPanelEvents();
    bindRegexEvents();

    // 7. 恢复模式开关状态（游玩模式 / 网关模式）
    updateModeUI();

    // 8. 恢复自动更新开关状态
    updateUpdateUI();

    // 9. 恢复本地服务控制状态
    updateGatewayServerUI();

    console.log('[Gateway] 顶级设置面板已注入 (与预设/API/世界书同等级)');
}

/**
 * 绑定顶级面板事件
 */
function bindPanelEvents() {
    // === 模式开关（游玩模式 / 网关模式）===
    // 游玩模式(默认, 未勾选): 不转发任何消息(双向)
    // 网关模式(勾选): 转发平台消息并自动回复
    $('#gateway_panel_forwarding').on('change', function () {
        const settings = getSettings();
        settings.forwardingEnabled = this.checked;
        if (this.checked) {
            // 切换到网关模式时重置时间截断:
            // 只转发此刻之后才到达的消息, 之前积压的老消息一律不转发
            forwardCutoffTs = Date.now();
        }
        saveSettingsDebounced();
        updateModeUI();
    });

    // 连接按钮
    $('#gateway_panel_connect').on('click', async () => {
        const url = $('#gateway_panel_url').val().trim();
        if (url) {
            getSettings().serverUrl = url;
            saveSettingsDebounced();
        }
        await fetchGatewayStatus();
        startPolling();
        refreshPanelData();
    });

    // 本地服务控制
    $('#gateway_panel_auto_start_server').on('change', function () {
        getSettings().autoStartServer = this.checked;
        saveSettingsDebounced();
    });

    $('#gateway_panel_server_path').on('change', function () {
        getSettings().serverPath = this.value.trim();
        saveSettingsDebounced();
    });

    $('#gateway_panel_start_server').on('click', async () => {
        try {
            const result = await startGatewayServer();
            toastr.success(result.message);
            updateGatewayServerUI();
            // 服务启动后自动连接
            await fetchGatewayStatus();
            startPolling();
            refreshPanelData();
        } catch (error) {
            toastr.error(error.message);
            updateGatewayServerUI();
        }
    });

    $('#gateway_panel_stop_server').on('click', async () => {
        try {
            const result = await stopGatewayServer();
            toastr.success(result.message);
            updateGatewayServerUI();
        } catch (error) {
            toastr.error(error.message);
        }
    });

    // 适配器配置折叠：点击标题栏切换。
    // 排除开关(.toggle-switch)和验证按钮(.gateway-adapter-verify)，避免点击它们时误触发折叠。
    $('.gateway-adapter-header').on('click', function (e) {
        if ($(e.target).closest('.toggle-switch').length) return;
        if ($(e.target).closest('.gateway-adapter-verify').length) return;
        const targetId = $(this).data('toggle');
        $(`#${targetId}`).stop(true, true).slideToggle(150);
    });

    // 开关逻辑（修复反向问题）：
    //   打开磁贴 -> 展开该 bot 配置栏；关闭磁贴 -> 收起配置栏。符合直觉。
    $('.gateway-adapter-header .toggle-switch input').on('change', function () {
        const header = $(this).closest('.gateway-adapter-header');
        const targetId = header.data('toggle');
        const body = $(`#${targetId}`);
        if (this.checked) {
            body.stop(true, true).slideDown(150);
        } else {
            body.stop(true, true).slideUp(150);
        }
    });

    // 抽屉式折叠区块：点击标题栏展开/收起内容（插件配置区块的标准格式）。
    // 结构: .gateway-collapse-toggle[data-toggle="<bodyId>"] + .gateway-collapse-body + .gateway-collapse-arrow
    // 排除标题栏内的按钮/输入框/开关等可交互元素，避免点击它们时误触发折叠。
    $('.gateway-collapse-toggle').on('click', function (e) {
        if ($(e.target).closest('button, input, select, textarea, label, a').length) return;
        const targetId = $(this).data('toggle');
        const body = $(`#${targetId}`);
        const arrow = $(this).find('.gateway-collapse-arrow');
        body.stop(true, true).slideToggle(150);
        arrow.toggleClass('expanded');
    });

    // 验证单个适配器连接
    $('.gateway-adapter-verify').on('click', function () {
        const platform = $(this).data('platform');
        verifyAdapter(platform);
    });

    // 验证全部适配器连接
    $('#gateway_panel_verify_all').on('click', verifyAllAdapters);

    // 保存配置
    $('#gateway_panel_save_config').on('click', savePanelConfig);

    // 从 GitHub 安装插件
    $('#gateway_plugin_install_btn').on('click', installPluginFromGitHub);

    // 搜索插件
    $('#gateway_plugin_search_btn').on('click', searchPlugins);
    $('#gateway_plugin_search_input').on('keypress', function (e) {
        if (e.key === 'Enter') searchPlugins();
    });

    // 刷新插件列表
    $('#gateway_plugin_refresh').on('click', loadPluginList);

    // 刷新消息日志
    $('#gateway_panel_refresh_log').on('click', () => fetchGatewayStatus());

    // 下载插件开发规范指南（编写参考）
    $('#gateway_docs_download').on('click', downloadPluginGuide);

    // === 自动更新 ===
    // 自动更新开关
    $('#gateway_panel_auto_update').on('change', function () {
        const settings = getSettings();
        settings.autoUpdate = this.checked;
        saveSettingsDebounced();
    });

    // 立即检查更新
    $('#gateway_panel_update_check').on('click', () => checkForUpdate(false));

    // 应用更新
    $('#gateway_panel_update_apply').on('click', applyUpdate);
}

/**
 * 刷新面板数据
 */
async function refreshPanelData() {
    await fetchGatewayStatus();
    await loadPluginList();
    await loadPanelConfig();
    await loadRegexConfig();
}

/**
 * 下载插件开发规范指南（编写参考）
 * 从网关拉取 Markdown 文件, 通过 Blob + a.download 强制触发浏览器下载（跨域亦可用, 后端已开 CORS）。
 */
async function downloadPluginGuide() {
    const btn = $('#gateway_docs_download');
    const settings = getSettings();
    const url = `${settings.serverUrl}/api/gateway/docs/plugin-guide`;
    const defaultHtml = btn.html();

    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 下载中');
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = 'PLUGIN_DEVELOPMENT_GUIDE.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
        toastr.success('📘 插件开发规范指南已开始下载');
    } catch (error) {
        console.error('[Gateway] 下载指南失败:', error.message);
        toastr.error(`下载失败: ${error.message}（请确认网关已连接）`);
    } finally {
        btn.prop('disabled', false).html(defaultHtml);
    }
}

/**
 * 保存面板配置到后端
 */
async function savePanelConfig() {
    try {
        await apiRequest('/api/gateway/config', {
            method: 'POST',
            body: JSON.stringify({
                adapters: {
                    qq: {
                        enabled: $('#gateway_panel_qq_enabled').is(':checked'),
                        mode: $('#gateway_panel_qq_mode').val(),
                        wsUrl: $('#gateway_panel_qq_ws').val().trim(),
                        accessToken: $('#gateway_panel_qq_token').val(),
                        requireMention: $('#gateway_panel_qq_mention').is(':checked'),
                    },
                    telegram: {
                        enabled: $('#gateway_panel_tg_enabled').is(':checked'),
                        botToken: $('#gateway_panel_tg_token').val(),
                        requireMention: $('#gateway_panel_tg_mention').is(':checked'),
                    },
                    discord: {
                        enabled: $('#gateway_panel_dc_enabled').is(':checked'),
                        botToken: $('#gateway_panel_dc_token').val(),
                        requireMention: $('#gateway_panel_dc_mention').is(':checked'),
                    },
                },
            }),
        });
        toastr.success('网关配置已保存');

        // 自动启动已启用的适配器, 避免用户误以为"保存=启动"
        try {
            const adapterChecks = [
                { name: 'qq', prefix: 'qq' },
                { name: 'telegram', prefix: 'tg' },
                { name: 'discord', prefix: 'dc' },
            ];
            let anyStarted = false;
            for (const { name, prefix } of adapterChecks) {
                if ($(`#gateway_panel_${prefix}_enabled`).is(':checked')) {
                    try {
                        await apiRequest(`/api/gateway/adapters/${name}/start`, { method: 'POST' });
                        anyStarted = true;
                    } catch (_) { /* 适配器可能已在运行或配置有误, 静默忽略 */ }
                }
            }
            if (anyStarted) {
                // 刷新状态以反映适配器启动结果
                await fetchGatewayStatus();
            }
        } catch (_) { /* 网关未连接时忽略, 不影响主流程 */ }
    } catch (error) {
        toastr.error(`保存失败: ${error.message}`);
    }
}

/**
 * 加载后端配置到面板
 */
async function loadPanelConfig() {
    try {
        const config = await apiRequest('/api/gateway/config');
        const adapters = config.adapters || {};

        if (adapters.qq) {
            $('#gateway_panel_qq_enabled').prop('checked', adapters.qq.enabled);
            $('#gateway_panel_qq_mode').val(adapters.qq.mode);
            $('#gateway_panel_qq_ws').val(adapters.qq.wsUrl);
            $('#gateway_panel_qq_token').val(adapters.qq.accessToken);
            $('#gateway_panel_qq_mention').prop('checked', adapters.qq.requireMention !== false);
        }
        if (adapters.telegram) {
            $('#gateway_panel_tg_enabled').prop('checked', adapters.telegram.enabled);
            $('#gateway_panel_tg_token').val(adapters.telegram.botToken);
            $('#gateway_panel_tg_mention').prop('checked', adapters.telegram.requireMention);
        }
        if (adapters.discord) {
            $('#gateway_panel_dc_enabled').prop('checked', adapters.discord.enabled);
            $('#gateway_panel_dc_token').val(adapters.discord.botToken);
            $('#gateway_panel_dc_mention').prop('checked', adapters.discord.requireMention);
        }
    } catch (_) { /* 网关未连接时忽略 */ }
}

// ==================== 连接验证 ====================

/**
 * 验证单个适配器连接
 * @param {string} platform - qq | telegram | discord
 */
async function verifyAdapter(platform) {
    const btn = $(`.gateway-adapter-verify[data-platform="${platform}"]`);
    const prefix = PLATFORM_PREFIX[platform];
    const stateEl = $(`#gateway_panel_${prefix}_state`);
    const icon = getPlatformIcon(platform);

    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    if (stateEl.length) {
        stateEl.text('验证中').attr('class', 'gateway-adapter-state connecting');
    }

    try {
        const result = await apiRequest(`/api/gateway/adapters/${platform}/verify`, { method: 'POST' });
        if (result.ok) {
            toastr.success(`${icon} ${result.message}`);
            if (stateEl.length) stateEl.text('✓ 正常').attr('class', 'gateway-adapter-state connected');
            // 凭据有效但适配器可能未连接 — 消除"验证通过但显示离线"的认知矛盾
            if (result.state && result.state !== 'connected') {
                toastr.warning(`${icon} 凭据有效，但适配器未连接（状态: ${result.state}）。请确认已在配置中启用并重启网关服务。`, '', {
                    timeOut: 8000,
                });
            }
        } else {
            toastr.error(`${icon} ${result.message || '验证失败'}`);
            if (stateEl.length) stateEl.text('✗ 异常').attr('class', 'gateway-adapter-state error');
        }
        return result;
    } catch (error) {
        toastr.error(`${icon} 验证失败: ${error.message}`);
        if (stateEl.length) stateEl.text('✗ 异常').attr('class', 'gateway-adapter-state error');
        return null;
    } finally {
        btn.prop('disabled', false).html('<i class="fa-solid fa-plug-circle-check"></i>');
    }
}

/**
 * 验证所有适配器连接，并在连接区块显示汇总
 */
async function verifyAllAdapters() {
    const btn = $('#gateway_panel_verify_all');
    const summaryEl = $('#gateway_panel_adapters');

    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 验证中');
    summaryEl.show().html('<div class="gateway-empty-hint">正在验证所有平台...</div>');

    try {
        const data = await apiRequest('/api/gateway/verify', { method: 'POST' });
        const results = data.results || {};
        const entries = Object.entries(results);

        if (entries.length === 0) {
            summaryEl.html('<div class="gateway-empty-hint">无适配器</div>');
            return;
        }

        const html = entries.map(([platform, r]) => `
            <div class="gateway-verify-item ${r.ok ? 'ok' : 'fail'}">
                <span class="gateway-verify-icon">${getPlatformIcon(platform)}</span>
                <span class="gateway-verify-name">${platform}</span>
                <span class="gateway-verify-msg">${escapeHtml(r.message || (r.ok ? '正常' : '异常'))}</span>
                <span class="gateway-verify-badge ${r.ok ? 'connected' : 'error'}">${r.ok ? '✓' : '✗'}</span>
            </div>
        `).join('');
        summaryEl.html(html);

        // 同步更新各适配器头部状态徽标
        for (const [platform, r] of entries) {
            const prefix = PLATFORM_PREFIX[platform];
            if (prefix) {
                $(`#gateway_panel_${prefix}_state`)
                    .text(r.ok ? '✓ 正常' : '✗ 异常')
                    .attr('class', `gateway-adapter-state ${r.ok ? 'connected' : 'error'}`);
            }
        }

        const okCount = entries.filter(([, r]) => r.ok).length;
        toastr.info(`验证完成: ${okCount}/${entries.length} 个平台正常`);
    } catch (error) {
        summaryEl.html(`<div class="gateway-empty-hint">验证失败: ${escapeHtml(error.message)}</div>`);
        toastr.error(`验证失败: ${error.message}`);
    } finally {
        btn.prop('disabled', false).html('<i class="fa-solid fa-plug-circle-check"></i> 验证全部');
    }
}

// ==================== 插件管理 UI ====================

/**
 * 加载已安装插件列表
 */
async function loadPluginList() {
    const listEl = $('#gateway_plugin_list');
    try {
        const data = await apiRequest('/api/plugins');
        const plugins = data.plugins || [];

        if (plugins.length === 0) {
            listEl.html('<div class="gateway-empty-hint">暂无已安装插件</div>');
            return;
        }

        const html = plugins.map(p => `
            <div class="gateway-plugin-item" data-name="${p.name}">
                <div class="gateway-plugin-info">
                    <span class="gateway-plugin-name">${escapeHtml(p.displayName)}</span>
                    <span class="gateway-plugin-version">v${p.version}</span>
                    <span class="gateway-plugin-desc">${escapeHtml(p.description || '')}</span>
                </div>
                <div class="gateway-plugin-actions">
                    <span class="gateway-plugin-commands" title="命令: ${p.commands.join(', ')}">${p.commands.length} 命令</span>
                    ${p.hasConfig && p.configUi !== 'none' && p.configUi !== 'custom' ? `<button class="menu_button gateway-plugin-config" data-name="${p.name}" title="配置"><i class="fa-solid fa-sliders"></i></button>` : ''}
                    <button class="menu_button gateway-plugin-toggle ${p.enabled ? 'active' : ''}" data-name="${p.name}" data-enabled="${p.enabled}">
                        ${p.enabled ? '✅' : '⏸️'}
                    </button>
                    <button class="menu_button gateway-plugin-reload" data-name="${p.name}" title="重载">
                        <i class="fa-solid fa-rotate-right"></i>
                    </button>
                    <button class="menu_button gateway-plugin-uninstall" data-name="${p.name}" title="卸载">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');

        listEl.html(html);

        // 绑定插件操作按钮
        listEl.find('.gateway-plugin-toggle').off('click').on('click', async function () {
            const name = $(this).data('name');
            const enabled = $(this).data('enabled');
            const action = enabled ? 'disable' : 'enable';
            try {
                await apiRequest(`/api/plugins/${name}/${action}`, { method: 'POST' });
                toastr.success(`插件 ${name} 已${enabled ? '禁用' : '启用'}`);
                loadPluginList();
            } catch (e) {
                toastr.error(e.message);
            }
        });

        // R3: 绑定配置按钮（schema 驱动的动态配置弹窗）
        listEl.find('.gateway-plugin-config').off('click').on('click', async function () {
            const name = $(this).data('name');
            await openPluginConfigPopup(name);
        });

        listEl.find('.gateway-plugin-reload').off('click').on('click', async function () {
            const name = $(this).data('name');
            try {
                await apiRequest(`/api/plugins/${name}/reload`, { method: 'POST' });
                toastr.success(`插件 ${name} 已重载`);
                loadPluginList();
            } catch (e) {
                toastr.error(e.message);
            }
        });

        listEl.find('.gateway-plugin-uninstall').off('click').on('click', async function () {
            const name = $(this).data('name');
            if (!confirm(`确定要卸载插件 ${name} 吗？`)) return;
            try {
                await apiRequest(`/api/plugins/${name}`, { method: 'DELETE' });
                toastr.success(`插件 ${name} 已卸载`);
                loadPluginList();
            } catch (e) {
                toastr.error(e.message);
            }
        });

    } catch (error) {
        listEl.html('<div class="gateway-empty-hint">无法连接网关</div>');
    }
}

/**
 * 从 GitHub 安装插件
 */
async function installPluginFromGitHub() {
    const url = $('#gateway_plugin_github_url').val().trim();
    if (!url) {
        toastr.warning('请输入 GitHub 仓库地址');
        return;
    }

    const btn = $('#gateway_plugin_install_btn');
    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');

    try {
        const result = await apiRequest('/api/plugins/install/github', {
            method: 'POST',
            body: JSON.stringify({ url }),
        });

        if (result.success) {
            toastr.success(result.message);
            $('#gateway_plugin_github_url').val('');
            loadPluginList();
        } else {
            toastr.error(result.error || '安装失败');
        }
    } catch (error) {
        toastr.error(`安装失败: ${error.message}`);
    } finally {
        btn.prop('disabled', false).html('<i class="fa-solid fa-download"></i>');
    }
}

/**
 * 搜索社区插件
 */
async function searchPlugins() {
    const query = $('#gateway_plugin_search_input').val().trim();
    if (!query) {
        toastr.warning('请输入搜索关键词');
        return;
    }

    const resultsEl = $('#gateway_plugin_search_results');
    resultsEl.show().html('<div class="gateway-empty-hint">搜索中...</div>');

    try {
        const data = await apiRequest(`/api/plugins/marketplace/search?q=${encodeURIComponent(query)}`);
        const plugins = data.plugins || [];

        if (plugins.length === 0) {
            resultsEl.html('<div class="gateway-empty-hint">未找到相关插件</div>');
            return;
        }

        const html = plugins.map(p => `
            <div class="gateway-search-item">
                <div class="gateway-search-info">
                    <span class="gateway-search-name">${escapeHtml(p.name)}</span>
                    <span class="gateway-search-stars">⭐ ${p.stars}</span>
                    <span class="gateway-search-desc">${escapeHtml(p.description || '')}</span>
                </div>
                <button class="menu_button gateway-search-install" data-url="${p.url}" title="安装">
                    <i class="fa-solid fa-download"></i> 安装
                </button>
            </div>
        `).join('');

        resultsEl.html(html);

        // 绑定安装按钮
        resultsEl.find('.gateway-search-install').off('click').on('click', async function () {
            const repoUrl = $(this).data('url');
            $('#gateway_plugin_github_url').val(repoUrl);
            await installPluginFromGitHub();
        });

    } catch (error) {
        resultsEl.html(`<div class="gateway-empty-hint">搜索失败: ${error.message}</div>`);
    }
}

// ==================== 正则过滤器设置 ====================

let regexConfig = { extractPatterns: [], removePatterns: [], fallbackToOriginal: true, trimWhitespace: true };
let editingRegex = { type: null, idx: -1 }; // 当前正在编辑的规则 {type: 'extract' | 'remove', idx: number}

/**
 * 加载正则过滤器配置
 */
async function loadRegexConfig() {
    // 正则过滤器为内置插件，配置界面应始终可见。
    // 仅在网关未连接时显示离线提示，不再隐藏整个区块。
    $('#gateway_regex_section').show();
    try {
        const data = await apiRequest('/api/plugins/regex-filter/config');
        regexConfig = data.config || {};
        if (!regexConfig.extractPatterns) regexConfig.extractPatterns = [];
        if (!regexConfig.removePatterns) regexConfig.removePatterns = [];
        $('#gateway_regex_offline_hint').hide();
        renderRegexConfig();
    } catch (_) {
        // 网关未连接：仍显示配置界面(可编辑/测试)，仅提示无法加载/保存
        $('#gateway_regex_offline_hint').show();
        renderRegexConfig();
    }
}

/**
 * 将当前正则配置立即持久化到后端
 * 所有增/删/改操作后都会调用, 确保规则不会因面板重载/刷新而丢失
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveRegexConfig() {
    try {
        await apiRequest('/api/plugins/regex-filter/config', {
            method: 'POST',
            body: JSON.stringify(regexConfig),
        });
        return true;
    } catch (error) {
        toastr.error(`正则配置保存失败: ${error.message}（请确认网关已连接）`);
        return false;
    }
}

/**
 * 渲染正则配置到 UI
 */
function renderRegexConfig() {
    // 全局选项
    $('#gateway_regex_fallback').prop('checked', regexConfig.fallbackToOriginal !== false);
    $('#gateway_regex_trim').prop('checked', regexConfig.trimWhitespace !== false);

    // 提取规则列表
    const extractHtml = regexConfig.extractPatterns.map((r, i) => `
        <div class="gateway-regex-item ${editingRegex.type === 'extract' && editingRegex.idx === i ? 'editing' : ''}" data-idx="${i}" data-type="extract">
            <div class="gateway-regex-item-main">
                <span class="gateway-regex-item-status ${r.enabled ? 'on' : 'off'}">${r.enabled ? '✅' : '⏸️'}</span>
                <span class="gateway-regex-item-name">${escapeHtml(r.name)}</span>
                <code class="gateway-regex-item-pattern">${escapeHtml(r.pattern)}</code>
                <span class="gateway-regex-item-group">组:${r.group ?? 1}</span>
            </div>
            <div class="gateway-regex-item-actions">
                <button class="menu_button regex-rule-edit" data-type="extract" data-idx="${i}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="menu_button regex-rule-toggle" data-type="extract" data-idx="${i}" title="启用/禁用">${r.enabled ? '⏸️' : '▶️'}</button>
                <button class="menu_button regex-rule-delete" data-type="extract" data-idx="${i}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('') || '<div class="gateway-empty-hint">无提取规则</div>';
    $('#gateway_regex_extract_list').html(extractHtml);

    // 移除规则列表
    const removeHtml = regexConfig.removePatterns.map((r, i) => `
        <div class="gateway-regex-item ${editingRegex.type === 'remove' && editingRegex.idx === i ? 'editing' : ''}" data-idx="${i}" data-type="remove">
            <div class="gateway-regex-item-main">
                <span class="gateway-regex-item-status ${r.enabled ? 'on' : 'off'}">${r.enabled ? '✅' : '⏸️'}</span>
                <span class="gateway-regex-item-name">${escapeHtml(r.name)}</span>
                <code class="gateway-regex-item-pattern">${escapeHtml(r.pattern)}</code>
                <span class="gateway-regex-item-group">→"${r.replacement ?? ''}"</span>
            </div>
            <div class="gateway-regex-item-actions">
                <button class="menu_button regex-rule-edit" data-type="remove" data-idx="${i}" title="编辑"><i class="fa-solid fa-pen-to-square"></i></button>
                <button class="menu_button regex-rule-toggle" data-type="remove" data-idx="${i}" title="启用/禁用">${r.enabled ? '⏸️' : '▶️'}</button>
                <button class="menu_button regex-rule-delete" data-type="remove" data-idx="${i}" title="删除"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('') || '<div class="gateway-empty-hint">无移除规则</div>';
    $('#gateway_regex_remove_list').html(removeHtml);

    // 根据编辑状态更新按钮与表单
    updateRegexEditUI();

    // 绑定规则操作按钮
    bindRegexRuleButtons();
}

/**
 * 根据编辑状态更新按钮与表单
 */
function updateRegexEditUI() {
    const isEditing = editingRegex.type !== null && editingRegex.idx >= 0;

    if (isEditing) {
        const rule = regexConfig[editingRegex.type === 'extract' ? 'extractPatterns' : 'removePatterns'][editingRegex.idx];
        if (rule) {
            if (editingRegex.type === 'extract') {
                $('#gateway_regex_extract_name').val(rule.name);
                $('#gateway_regex_extract_pattern').val(rule.pattern);
                $('#gateway_regex_extract_group').val(rule.group ?? 1);
                $('#gateway_regex_extract_desc').val(rule.description || '');
                $('#gateway_regex_extract_add').html('<i class="fa-solid fa-check"></i>').attr('title', '保存修改');
                $('#gateway_regex_extract_cancel').show();
            } else {
                $('#gateway_regex_remove_name').val(rule.name);
                $('#gateway_regex_remove_pattern').val(rule.pattern);
                $('#gateway_regex_remove_replacement').val(rule.replacement ?? '');
                $('#gateway_regex_remove_desc').val(rule.description || '');
                $('#gateway_regex_remove_add').html('<i class="fa-solid fa-check"></i>').attr('title', '保存修改');
                $('#gateway_regex_remove_cancel').show();
            }
        }
    } else {
        // 重置表单
        $('#gateway_regex_extract_name, #gateway_regex_extract_pattern, #gateway_regex_extract_desc').val('');
        $('#gateway_regex_extract_group').val(1);
        $('#gateway_regex_remove_name, #gateway_regex_remove_pattern, #gateway_regex_remove_replacement, #gateway_regex_remove_desc').val('');
        $('#gateway_regex_extract_add').html('<i class="fa-solid fa-plus"></i>').attr('title', '添加提取规则（添加后自动保存，永久生效）');
        $('#gateway_regex_remove_add').html('<i class="fa-solid fa-plus"></i>').attr('title', '添加移除规则');
        $('#gateway_regex_extract_cancel, #gateway_regex_remove_cancel').hide();
    }
}

/**
 * 绑定规则操作按钮
 */
function bindRegexRuleButtons() {
    // 编辑
    $('.regex-rule-edit').off('click').on('click', async function () {
        const type = $(this).data('type');
        const idx = $(this).data('idx');
        editingRegex = { type, idx };
        renderRegexConfig();
    });

    // 启用/禁用（改动后立即持久化）
    $('.regex-rule-toggle').off('click').on('click', async function () {
        const type = $(this).data('type');
        const idx = $(this).data('idx');
        const key = type === 'extract' ? 'extractPatterns' : 'removePatterns';
        if (regexConfig[key][idx]) {
            regexConfig[key][idx].enabled = !regexConfig[key][idx].enabled;
            renderRegexConfig();
            await saveRegexConfig();
        }
    });

    // 删除（改动后立即持久化）
    $('.regex-rule-delete').off('click').on('click', async function () {
        const type = $(this).data('type');
        const idx = $(this).data('idx');
        const key = type === 'extract' ? 'extractPatterns' : 'removePatterns';
        if (editingRegex.type === type && editingRegex.idx === idx) {
            editingRegex = { type: null, idx: -1 };
        }
        regexConfig[key].splice(idx, 1);
        renderRegexConfig();
        await saveRegexConfig();
    });
}

/**
 * 绑定正则设置面板事件
 */
function bindRegexEvents() {
    // 添加提取规则
    $('#gateway_regex_extract_add').on('click', () => {
        const name = $('#gateway_regex_extract_name').val().trim();
        const pattern = $('#gateway_regex_extract_pattern').val().trim();
        const group = parseInt($('#gateway_regex_extract_group').val()) || 1;
        const desc = $('#gateway_regex_extract_desc').val().trim();

        if (!name || !pattern) {
            toastr.warning('请填写名称和正则表达式');
            return;
        }
        try { new RegExp(pattern); } catch (e) {
            toastr.error(`无效正则: ${e.message}`);
            return;
        }

        if (editingRegex.type === 'extract') {
            regexConfig.extractPatterns[editingRegex.idx] = { name, enabled: true, pattern, group, description: desc };
            editingRegex = { type: null, idx: -1 };
        } else {
            regexConfig.extractPatterns.push({ name, enabled: true, pattern, group, description: desc });
        }
        $('#gateway_regex_extract_name').val('');
        $('#gateway_regex_extract_pattern').val('');
        $('#gateway_regex_extract_desc').val('');
        renderRegexConfig();
        saveRegexConfig(); // 立即持久化, 规则不会因面板重载而丢失
    });

    // 取消编辑提取规则
    $('#gateway_regex_extract_cancel').on('click', () => {
        editingRegex = { type: null, idx: -1 };
        renderRegexConfig();
    });

    // 添加移除规则
    $('#gateway_regex_remove_add').on('click', () => {
        const name = $('#gateway_regex_remove_name').val().trim();
        const pattern = $('#gateway_regex_remove_pattern').val().trim();
        const replacement = $('#gateway_regex_remove_replacement').val();
        const desc = $('#gateway_regex_remove_desc').val().trim();

        if (!name || !pattern) {
            toastr.warning('请填写名称和正则表达式');
            return;
        }
        try { new RegExp(pattern); } catch (e) {
            toastr.error(`无效正则: ${e.message}`);
            return;
        }

        if (editingRegex.type === 'remove') {
            regexConfig.removePatterns[editingRegex.idx] = { name, enabled: true, pattern, replacement, description: desc };
            editingRegex = { type: null, idx: -1 };
        } else {
            regexConfig.removePatterns.push({ name, enabled: true, pattern, replacement, description: desc });
        }
        $('#gateway_regex_remove_name').val('');
        $('#gateway_regex_remove_pattern').val('');
        $('#gateway_regex_remove_replacement').val('');
        $('#gateway_regex_remove_desc').val('');
        renderRegexConfig();
        saveRegexConfig(); // 立即持久化, 规则不会因面板重载而丢失
    });

    // 取消编辑移除规则
    $('#gateway_regex_remove_cancel').on('click', () => {
        editingRegex = { type: null, idx: -1 };
        renderRegexConfig();
    });

    // 全局选项（Fallback/去空白）变化时自动保存
    $('#gateway_regex_fallback, #gateway_regex_trim').on('change', () => {
        regexConfig.fallbackToOriginal = $('#gateway_regex_fallback').is(':checked');
        regexConfig.trimWhitespace = $('#gateway_regex_trim').is(':checked');
        saveRegexConfig();
    });

    // 手动保存按钮（规则的增删改已自动保存, 此按钮用于兜底确认）
    $('#gateway_regex_save').on('click', async () => {
        regexConfig.fallbackToOriginal = $('#gateway_regex_fallback').is(':checked');
        regexConfig.trimWhitespace = $('#gateway_regex_trim').is(':checked');
        if (await saveRegexConfig()) {
            toastr.success('正则过滤配置已保存');
        }
    });

    // 刷新
    $('#gateway_regex_refresh').on('click', loadRegexConfig);

    // 正则测试
    $('#gateway_regex_test_btn').on('click', () => {
        const text = $('#gateway_regex_test_input').val();
        const pattern = $('#gateway_regex_test_pattern').val().trim();
        const resultEl = $('#gateway_regex_test_result');

        if (!text || !pattern) {
            toastr.warning('请输入测试文本和正则表达式');
            return;
        }

        try {
            const regex = new RegExp(pattern, 's');
            const match = text.match(regex);
            resultEl.show();

            if (match) {
                const groups = match.slice(1).map((g, i) => `<div class="regex-match-group"><b>组 ${i + 1}:</b> ${escapeHtml((g || '').substring(0, 200))}</div>`).join('');
                resultEl.html(`
                    <div class="regex-match-success">
                        <div>✅ 匹配成功！完整匹配: ${escapeHtml(match[0].substring(0, 200))}${match[0].length > 200 ? '...' : ''}</div>
                        ${groups}
                    </div>
                `);
            } else {
                resultEl.html('<div class="regex-match-fail">❌ 未匹配</div>');
            }
        } catch (error) {
            resultEl.show().html(`<div class="regex-match-fail">❌ 正则错误: ${escapeHtml(error.message)}</div>`);
        }
    });

    // === 导入 SillyTavern 正则 ===
    $('#gateway_regex_import_st').on('click', () => {
        $('#gateway_regex_import_file').trigger('click');
    });

    $('#gateway_regex_import_file').on('change', async function () {
        const file = this.files[0];
        if (!file) return;
        // 重置 input 以便同一文件可再次选择
        const resetInput = () => { this.value = ''; };

        try {
            const text = await file.text();
            let rules;
            try {
                rules = JSON.parse(text);
            } catch (e) {
                toastr.error(`文件解析失败: 不是有效的 JSON (${e.message})`);
                resetInput();
                return;
            }

            const data = await apiRequest('/api/plugins/regex-filter/import-st', {
                method: 'POST',
                body: JSON.stringify({ rules }),
            });

            if (data.imported > 0) {
                toastr.success(`✅ 导入成功: ${data.imported} 条规则，跳过 ${data.skipped} 条`);
                await loadRegexConfig(); // 刷新列表
            } else {
                toastr.info(`导入完成: 无新规则导入 (跳过 ${data.skipped} 条，可能不适用或已存在)`);
            }
        } catch (error) {
            toastr.error(`导入失败: ${error.message}`);
        }
        resetInput();
    });
}

// ==================== R3: Schema 驱动的插件配置弹窗 ====================

/**
 * 打开插件配置弹窗（schema 驱动，自动生成表单）
 * @param {string} pluginName - 插件名
 */
async function openPluginConfigPopup(pluginName) {
    try {
        // 并行获取 schema 和当前配置
        const [schemaRes, configRes] = await Promise.all([
            apiRequest(`/api/plugins/${pluginName}/schema`),
            apiRequest(`/api/plugins/${pluginName}/config`),
        ]);

        const schema = schemaRes.schema;
        const config = configRes.config || {};

        if (!schema.hasSchema) {
            toastr.info(`插件 ${schema.displayName || pluginName} 没有可配置项`);
            return;
        }

        // 构建表单 HTML
        const formHtml = renderSchemaConfigForm(schema, config, pluginName);

        // 用 ST 弹窗展示
        const dialog = $(`
            <div class="gateway-plugin-config-popup">
                <h3><i class="fa-solid fa-sliders"></i> ${escapeHtml(schema.displayName || pluginName)} 配置</h3>
                ${formHtml}
            </div>
        `);

        callGenericPopup(dialog, POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: '保存',
            cancelButton: '取消',
        }).then(async (result) => {
            if (result === 1) {
                // 用户点击"保存"
                await savePluginConfigFromForm(pluginName, schema);
            }
        });

    } catch (error) {
        toastr.error(`加载插件配置失败: ${error.message}`);
    }
}

/**
 * 根据 schema 渲染配置表单
 * @param {object} schema - 从 /api/plugins/:name/schema 获取的 schema
 * @param {object} config - 当前配置值
 * @param {string} pluginName - 插件名（用于生成字段 ID）
 * @returns {string} 表单 HTML
 */
function renderSchemaConfigForm(schema, config, pluginName) {
    const configSchema = schema.configSchema;
    const prefix = `plugin_config_${pluginName.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // 按 ui.order 排序字段
    const fields = Object.entries(configSchema).map(([key, def]) => ({
        key,
        def,
        order: def.ui?.order ?? 99,
    })).sort((a, b) => a.order - b.order);

    const fieldHtml = fields.map(({ key, def }) => {
        const value = config[key] ?? def.default;
        const desc = def.description ? `<span class="gateway-hint">${escapeHtml(def.description)}</span>` : '';
        const fieldId = `${prefix}_${key}`;

        switch (def.type) {
            case 'boolean':
                return `
                    <div class="gateway-field">
                        <label class="toggle-switch">
                            <input type="checkbox" id="${fieldId}" data-key="${key}" ${value !== false ? 'checked' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                        <span>${escapeHtml(def.description || key)}</span>
                    </div>
                `;

            case 'number': {
                const min = def.ui?.min ?? def.min ?? '';
                const max = def.ui?.max ?? def.max ?? '';
                const step = def.ui?.step ?? def.step ?? 1;
                const unit = def.ui?.unit ? ` ${escapeHtml(def.ui.unit)}` : '';
                return `
                    <div class="gateway-field">
                        <label>${escapeHtml(def.description || key)}${unit}</label>
                        <input type="number" id="${fieldId}" data-key="${key}" class="text_pole"
                            value="${value}" ${min !== '' ? `min="${min}"` : ''} ${max !== '' ? `max="${max}"` : ''} step="${step}">
                    </div>
                `;
            }

            case 'string': {
                if (def.enum) {
                    const options = def.enum.map(opt =>
                        `<option value="${escapeHtml(opt.value ?? opt)}" ${value === (opt.value ?? opt) ? 'selected' : ''}>${escapeHtml(opt.label ?? opt.value ?? opt)}</option>`
                    ).join('');
                    return `
                        <div class="gateway-field">
                            <label>${escapeHtml(def.description || key)}</label>
                            <select id="${fieldId}" data-key="${key}" class="text_pole">${options}</select>
                        </div>
                    `;
                }
                const placeholder = def.ui?.placeholder || def.placeholder || '';
                return `
                    <div class="gateway-field">
                        <label>${escapeHtml(def.description || key)}</label>
                        <input type="text" id="${fieldId}" data-key="${key}" class="text_pole"
                            value="${escapeHtml(String(value ?? ''))}" placeholder="${escapeHtml(placeholder)}">
                    </div>
                `;
            }

            case 'array': {
                const arrValue = Array.isArray(value) ? value.join(',') : String(value ?? '');
                const placeholder = def.ui?.placeholder || def.placeholder || '逗号分隔';
                const inputMode = def.ui?.inputMode || 'csv';
                if (inputMode === 'textarea') {
                    return `
                        <div class="gateway-field">
                            <label>${escapeHtml(def.description || key)}</label>
                            <textarea id="${fieldId}" data-key="${key}" class="text_pole" rows="3"
                                placeholder="${escapeHtml(placeholder)}">${escapeHtml(arrValue)}</textarea>
                        </div>
                    `;
                }
                return `
                    <div class="gateway-field">
                        <label>${escapeHtml(def.description || key)}</label>
                        <input type="text" id="${fieldId}" data-key="${key}" class="text_pole"
                            value="${escapeHtml(arrValue)}" placeholder="${escapeHtml(placeholder)}">
                    </div>
                `;
            }

            default:
                return `
                    <div class="gateway-field">
                        <label>${escapeHtml(def.description || key)} <span class="gateway-hint">(未知类型: ${escapeHtml(def.type)})</span></label>
                        <input type="text" id="${fieldId}" data-key="${key}" class="text_pole"
                            value="${escapeHtml(String(value ?? ''))}">
                    </div>
                `;
        }
    }).join('');

    return `<div class="gateway-plugin-config-form">${fieldHtml}</div>`;
}

/**
 * 从表单收集配置并保存到后端
 * @param {string} pluginName - 插件名
 * @param {object} schema - 插件 schema
 */
async function savePluginConfigFromForm(pluginName, schema) {
    const configSchema = schema.configSchema;
    const prefix = `plugin_config_${pluginName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const newConfig = {};

    for (const [key, def] of Object.entries(configSchema)) {
        const fieldId = `${prefix}_${key}`;
        const el = document.getElementById(fieldId);
        if (!el) continue;

        switch (def.type) {
            case 'boolean':
                newConfig[key] = el.checked;
                break;
            case 'number':
                newConfig[key] = parseInt(el.value) || 0;
                break;
            case 'array': {
                const text = el.value.trim();
                newConfig[key] = text
                    ? text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
                    : [];
                break;
            }
            case 'string':
            default:
                newConfig[key] = el.value;
                break;
        }
    }

    try {
        await apiRequest(`/api/plugins/${pluginName}/config`, {
            method: 'POST',
            body: JSON.stringify(newConfig),
        });
        toastr.success(`${schema.displayName || pluginName} 配置已保存`);
    } catch (error) {
        toastr.error(`保存失败: ${error.message}`);
    }
}
