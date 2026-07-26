/**
 * OneBot v11 协议解析/封装
 * 参考: https://github.com/botuniverse/onebot-11
 *
 * 处理 CQ 码解析、消息段转换、API 调用封装
 */

import { MediaAsset, MediaType } from '../adapters/base-adapter.js';

/**
 * 解析 CQ 码消息为结构化消息段
 * @param {string} rawMessage - 包含 CQ 码的原始消息
 * @returns {Array<{type: string, data: object}>} 消息段数组
 */
export function parseCQCode(rawMessage) {
    if (!rawMessage) return [];

    const segments = [];
    const cqRegex = /\[CQ:(\w+)(?:,([^\]]*))?\]/g;
    let lastIndex = 0;
    let match;

    while ((match = cqRegex.exec(rawMessage)) !== null) {
        // 添加 CQ 码之前的纯文本
        if (match.index > lastIndex) {
            const text = rawMessage.substring(lastIndex, match.index);
            if (text.trim()) {
                segments.push({ type: 'text', data: { text: unescapeCQ(text) } });
            }
        }

        // 解析 CQ 码
        const type = match[1];
        const paramsStr = match[2] || '';
        const data = parseCQParams(paramsStr);
        segments.push({ type, data });

        lastIndex = cqRegex.lastIndex;
    }

    // 添加最后的纯文本
    if (lastIndex < rawMessage.length) {
        const text = rawMessage.substring(lastIndex);
        if (text.trim()) {
            segments.push({ type: 'text', data: { text: unescapeCQ(text) } });
        }
    }

    // 如果没有 CQ 码，整条消息作为文本
    if (segments.length === 0 && rawMessage.trim()) {
        segments.push({ type: 'text', data: { text: rawMessage } });
    }

    return segments;
}

/**
 * 解析 CQ 码参数
 * @param {string} paramsStr - 参数字符串 "key1=value1,key2=value2"
 * @returns {object}
 */
function parseCQParams(paramsStr) {
    const data = {};
    if (!paramsStr) return data;

    const pairs = paramsStr.split(',');
    for (const pair of pairs) {
        const eqIndex = pair.indexOf('=');
        if (eqIndex > 0) {
            const key = pair.substring(0, eqIndex);
            const value = unescapeCQ(pair.substring(eqIndex + 1));
            data[key] = value;
        }
    }
    return data;
}

/**
 * 将消息段数组转换为纯文本（提取文本内容）
 * @param {Array} segments - 消息段数组
 * @returns {{text: string, mediaUrls: string[], mentioned: boolean}}
 */
export function segmentsToContent(segments) {
    let text = '';
    const media = [];
    let mentioned = false;
    let replyToId = '';

    for (const seg of segments) {
        switch (seg.type) {
            case 'text':
                text += seg.data.text || '';
                break;
            case 'at':
                if (seg.data.qq === 'all') {
                    text += '@全体成员 ';
                } else {
                    text += `@${seg.data.name || seg.data.qq} `;
                }
                mentioned = true;
                break;
            case 'image': {
                const url = seg.data.url || seg.data.file || '';
                media.push(new MediaAsset({ type: MediaType.IMAGE, url, platform: 'qq', name: seg.data.file || '' }));
                text += '[图片] ';
                break;
            }
            case 'record': {
                const url = seg.data.url || seg.data.file || '';
                media.push(new MediaAsset({ type: MediaType.VOICE, url, platform: 'qq' }));
                text += '[语音] ';
                break;
            }
            case 'video': {
                const url = seg.data.url || seg.data.file || '';
                media.push(new MediaAsset({ type: MediaType.VIDEO, url, platform: 'qq' }));
                text += '[视频] ';
                break;
            }
            case 'file': {
                const url = seg.data.url || seg.data.file || '';
                media.push(new MediaAsset({ type: MediaType.FILE, url, platform: 'qq', name: seg.data.name || seg.data.file || '' }));
                text += '[文件] ';
                break;
            }
            case 'face':
                text += `[表情${seg.data.id}] `;
                break;
            case 'reply':
                // 记录引用的消息ID，供上下文关联（此前被完全丢弃）
                if (seg.data.id) replyToId = String(seg.data.id);
                break;
            default:
                text += `[${seg.type}] `;
        }
    }

    // 向后兼容：从 media 派生 mediaUrls
    const mediaUrls = media.map(m => m.url).filter(Boolean);
    return { text: text.trim(), mediaUrls, media, mentioned, replyToId };
}

/**
 * 将纯文本转换为 OneBot 消息段格式
 * @param {string} text - 纯文本
 * @param {string[]} mediaUrls - 媒体URL列表
 * @param {string} replyToId - 回复的消息ID
 * @returns {Array} OneBot 消息段数组
 */
export function contentToSegments(text, media = [], replyToId = '') {
    const segments = [];

    // 添加回复
    if (replyToId) {
        segments.push({ type: 'reply', data: { id: replyToId } });
    }

    // 添加文本
    // 关键修复：数组格式消息段的 data.text 不应做 CQ 转义——OneBot 实现不会对
    // 数组段文本反转义，转义后 [ ] & 会在 QQ 端显示为 &#91; &#93; &amp;，
    // 导致 Markdown 链接/代码块/角色扮演标记乱码。转义仅适用于字符串格式消息。
    if (text) {
        segments.push({ type: 'text', data: { text } });
    }

    // 添加媒体：按类型映射到对应的 OneBot 段（此前一律当图片，语音/视频/文件无法出站）
    for (const item of media) {
        // 兼容旧调用：传入字符串数组时按图片处理
        if (typeof item === 'string') {
            segments.push({ type: 'image', data: { file: item } });
            continue;
        }
        const file = item.url || item.localPath || '';
        if (!file) continue;
        switch (item.type) {
            case MediaType.VOICE:
            case MediaType.AUDIO:
                segments.push({ type: 'record', data: { file } });
                break;
            case MediaType.VIDEO:
                segments.push({ type: 'video', data: { file } });
                break;
            case MediaType.FILE:
                segments.push({ type: 'file', data: { file, name: item.name || '' } });
                break;
            case MediaType.IMAGE:
            default:
                segments.push({ type: 'image', data: { file } });
        }
    }

    return segments;
}

/**
 * 构建 OneBot API 请求
 * @param {string} action - API 动作名
 * @param {object} params - 参数
 * @param {string} echo - 回调标识
 * @returns {object} OneBot API 请求对象
 */
export function buildApiRequest(action, params = {}, echo = '') {
    const request = { action, params };
    if (echo) {
        request.echo = echo;
    }
    return request;
}

/**
 * 常用 API 构建器
 */
export const OneBotAPI = {
    /**
     * 发送私聊消息
     */
    sendPrivateMsg(userId, message, autoEscape = false) {
        return buildApiRequest('send_private_msg', {
            user_id: userId,
            message,
            auto_escape: autoEscape,
        });
    },

    /**
     * 发送群消息
     */
    sendGroupMsg(groupId, message, autoEscape = false) {
        return buildApiRequest('send_group_msg', {
            group_id: groupId,
            message,
            auto_escape: autoEscape,
        });
    },

    /**
     * 发送消息（通用）
     */
    sendMsg(messageType, targetId, message) {
        if (messageType === 'private') {
            return OneBotAPI.sendPrivateMsg(targetId, message);
        } else {
            return OneBotAPI.sendGroupMsg(targetId, message);
        }
    },

    /**
     * 撤回消息
     */
    deleteMsg(messageId) {
        return buildApiRequest('delete_msg', { message_id: messageId });
    },

    /**
     * 获取登录号信息
     */
    getLoginInfo() {
        return buildApiRequest('get_login_info', {});
    },

    /**
     * 获取陌生人信息
     */
    getStrangerInfo(userId) {
        return buildApiRequest('get_stranger_info', { user_id: userId });
    },

    /**
     * 获取群成员信息
     */
    getGroupMemberInfo(groupId, userId) {
        return buildApiRequest('get_group_member_info', {
            group_id: groupId,
            user_id: userId,
        });
    },

    /**
     * 发送群戳一戳
     */
    sendGroupPoke(groupId, userId) {
        return buildApiRequest('group_poke', {
            group_id: groupId,
            user_id: userId,
        });
    },

    /**
     * 设置群名片
     */
    setGroupCard(groupId, userId, card) {
        return buildApiRequest('set_group_card', {
            group_id: groupId,
            user_id: userId,
            card,
        });
    },
};

/**
 * CQ 码转义
 */
function escapeCQ(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/\[/g, '&#91;')
        .replace(/\]/g, '&#93;');
}

/**
 * CQ 码反转义
 * 注意 &amp; 必须最后处理，避免把 &#91; 中的 & 提前还原。
 * 逗号 &#44; 必须还原：CQ 参数值内的逗号按规范转义，不还原会导致
 * 含逗号的图片URL/文件名残留 &#44; → 媒体下载失效。
 */
function unescapeCQ(text) {
    return text
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&#44;/g, ',')
        .replace(/&amp;/g, '&');
}

/**
 * 解析 OneBot 事件
 * @param {object} data - WebSocket 收到的原始数据
 * @returns {object|null} 解析后的事件对象
 */
export function parseEvent(data) {
    if (!data || typeof data !== 'object') return null;

    // API 响应（有 echo 字段）
    if (data.echo !== undefined) {
        return {
            type: 'api_response',
            echo: data.echo,
            status: data.status,
            retcode: data.retcode,
            data: data.data,
        };
    }

    // 事件
    const postType = data.post_type;

    switch (postType) {
        case 'message':
            return parseMessageEvent(data);
        case 'notice':
            return {
                type: 'notice',
                noticeType: data.notice_type,
                subType: data.sub_type,
                groupId: data.group_id,
                userId: data.user_id,
                operatorId: data.operator_id,
                raw: data,
            };
        case 'request':
            return {
                type: 'request',
                requestType: data.request_type,
                subType: data.sub_type,
                groupId: data.group_id,
                userId: data.user_id,
                comment: data.comment,
                flag: data.flag,
                raw: data,
            };
        case 'meta_event':
            return {
                type: 'meta_event',
                metaEventType: data.meta_event_type,
                subType: data.sub_type,
                selfId: data.self_id,
                interval: data.interval,
                status: data.status,
                raw: data,
            };
        default:
            return { type: 'unknown', raw: data };
    }
}

/**
 * 解析消息事件
 */
function parseMessageEvent(data) {
    const messageType = data.message_type; // 'private' | 'group'
    const segments = Array.isArray(data.message) ? data.message : parseCQCode(data.raw_message || data.message);
    const { text, mediaUrls, media, mentioned, replyToId } = segmentsToContent(segments);

    return {
        type: 'message',
        messageType,
        messageId: data.message_id,
        userId: data.user_id,
        groupId: data.group_id,
        sender: data.sender || {},
        content: text,
        mediaUrls,
        media,
        mentioned,
        replyToId,
        segments,
        rawMessage: data.raw_message,
        time: data.time,
        raw: data,
    };
}

export default {
    parseCQCode,
    segmentsToContent,
    contentToSegments,
    buildApiRequest,
    OneBotAPI,
    parseEvent,
};
