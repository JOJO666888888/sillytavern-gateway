/**
 * 协作工具（Phase 3 多 Agent 协作）
 * 让 Agent 通过 collab.* 工具与其他 Agent 通信：
 * - collab.send：广播/定向发送消息（type=broadcast）
 * - collab.request：请求-应答（type=request + 等待 response）
 * - collab.state_sync：发布状态快照（type=state_sync）
 * - collab.recv：拉取本 run 指定 topic 的待处理消息（消费后移除）
 *
 * 消息绑定：from = 当前 Agent 定义名，runId = 当前 run（从工具执行上下文注入）。
 */
export function createCollabTools(collabBus) {
    /** 从执行上下文解析发送方与 runId */
    const resolveMsg = (ctx) => {
        const runId = ctx?.runId || ctx?.session?._runId || '';
        const from = ctx?.definition?.name || ctx?.session?.agentName || 'agent';
        return { runId, from };
    };

    return [
        {
            name: 'collab.send',
            description: '向本次 Agent run 内其他 Agent 广播消息（topic + payload）。其他 Agent 可用 collab.recv 拉取，或插件通过总线订阅。用于评审结论同步、草稿分发等。',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: '消息主题（如 draft_review / outline_sync）' },
                    payload: { type: 'object', description: '消息内容' },
                    to: { type: 'string', description: '可选，指定接收 Agent 名称；缺省广播给所有订阅者' },
                },
                required: ['topic', 'payload'],
            },
            handler: async (args, ctx) => {
                const { runId, from } = resolveMsg(ctx);
                const ret = collabBus.publish({
                    from,
                    to: args.to || '',
                    type: 'broadcast',
                    topic: args.topic,
                    payload: args.payload || {},
                    runId,
                });
                return ret.error ? ret : { ok: true, seq: ret.seq, runId, topic: args.topic };
            },
        },
        {
            name: 'collab.request',
            description: '向本次 run 内其他 Agent 发起请求-应答：广播 request 消息并等待同 topic 的 response。用于征求评审意见、获取协作结果。',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: '请求主题' },
                    payload: { type: 'object', description: '请求内容' },
                    timeoutMs: { type: 'number', description: '等待超时（毫秒，默认 30000）' },
                    to: { type: 'string', description: '可选，指定应答 Agent 名称；缺省任一订阅者应答' },
                },
                required: ['topic', 'payload'],
            },
            handler: async (args, ctx) => {
                const { runId, from } = resolveMsg(ctx);
                // 先建立应答等待，再广播 request —— 避免同步应答方在订阅前发布 response 被漏接
                const replyPromise = collabBus.request(args.topic, args.payload, {
                    timeoutMs: args.timeoutMs || 30000,
                    runId,
                });
                collabBus.publish({
                    from,
                    to: args.to || '',
                    type: 'request',
                    topic: args.topic,
                    payload: args.payload || {},
                    runId,
                });
                const reply = await replyPromise;
                if (reply.error) return reply;
                return { ok: true, response: reply.payload, from: reply.from, seq: reply.seq };
            },
        },
        {
            name: 'collab.state_sync',
            description: '发布状态快照到指定 topic，供其他 Agent 同步认知（如当前进度、已确认的决策）。',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: '同步主题（如 progress / decisions）' },
                    payload: { type: 'object', description: '状态快照' },
                },
                required: ['topic', 'payload'],
            },
            handler: async (args, ctx) => {
                const { runId, from } = resolveMsg(ctx);
                const ret = collabBus.publish({
                    from,
                    type: 'state_sync',
                    topic: args.topic,
                    payload: args.payload || {},
                    runId,
                });
                return ret.error ? ret : { ok: true, seq: ret.seq, runId, topic: args.topic };
            },
        },
        {
            name: 'collab.recv',
            description: '拉取本次 run 内指定 topic 的待处理消息（读取后即移除）。用于消费其他 Agent 通过 collab.send / collab.request 发来的消息。',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: '消息主题' },
                },
                required: ['topic'],
            },
            handler: async (args, ctx) => {
                const runId = ctx?.runId || ctx?.session?._runId || '';
                const msgs = collabBus.recv(runId, args.topic);
                return { ok: true, topic: args.topic, messages: msgs, count: msgs.length };
            },
        },
    ];
}
