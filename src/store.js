import { create } from 'zustand';

function normalizePermissionMode(value) {
  if (value === 'system' || value?.permissionMode === 'system') return 'system';
  if (value === 'workspace' || value?.permissionMode === 'workspace') return 'workspace';
  return value?.autoApprove === true ? 'system' : 'workspace';
}

function normalizeConversation(conv) {
  return { ...conv, permissionMode: normalizePermissionMode(conv) };
}

export const useStore = create((set, get) => ({
  hosts: [],
  activeHostId: null,
  statuses: {},      // hostId -> 'disconnected'|'connecting'|'connected'|'error'
  statusDetails: {}, // hostId -> string
  tab: 'chat',       // chat | brief | files | terminal | setup
  editingHost: null, // null | {} | host

  // 对话历史:conversations 为 convId -> conv
  // conv = {id, hostId, title, agent, cwd, model, permissionMode, autoApprove, messages:[],
  //         claudeSessionId, codexStarted, createdAt, updatedAt}
  conversations: {},
  activeConvByHost: {}, // hostId -> convId(null 表示停留在会话列表)
  agentRunning: {},     // convId -> bool
  queued: {},           // convId -> [{id,text,files}] 排队待发送的消息
  setupLogs: {},        // hostId -> string
  envInfo: {},          // hostId -> {os,node,npm,codex,claude}
  settings: { theme: 'dark', terminalFontSize: 13, defaultPermissionMode: 'workspace', autoConfirmCap: 5, grokModels: [], screenshotShortcut: 'CommandOrControl+Shift+2', screenshotShortcutEnabled: true },
  showSettings: false,

  setShowSettings: (v) => set({ showSettings: v }),
  applySettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    const next = useStore.getState().settings;
    if (patch.theme) document.documentElement.setAttribute('data-theme', next.theme);
    window.api.settings.save(patch).catch(() => {});
  },

  setHosts: (hosts) => set({ hosts }),
  setActiveHost: (id) => set({ activeHostId: id }),
  setTab: (tab) => set({ tab }),
  // 待在终端里自动执行的命令(如「在本机登录 Claude」跳转过去自动敲 claude)
  pendingTermCommand: null,
  setPendingTermCommand: (payload) => set({ pendingTermCommand: payload }),
  // 网络中断后的自动续跑次数(按对话计,用户发新消息时清零)
  autoResumeCount: {},
  setAutoResumeCount: (convId, n) =>
    set((s) => ({ autoResumeCount: { ...s.autoResumeCount, [convId]: n } })),
  setEditingHost: (h) => set({ editingHost: h }),
  setStatus: (hostId, status, detail) =>
    set((s) => ({
      statuses: { ...s.statuses, [hostId]: status },
      statusDetails: { ...s.statusDetails, [hostId]: detail || '' }
    })),

  setActiveConv: (hostId, convId) =>
    set((s) => ({ activeConvByHost: { ...s.activeConvByHost, [hostId]: convId } })),

  createConversation: (hostId, opts) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const conv = {
      id, hostId,
      title: opts.title || (opts.cwd ? opts.cwd.split('/').filter(Boolean).pop() : '新对话') || '新对话',
      agent: opts.agent, cwd: opts.cwd || '', model: opts.model || '',
      permissionMode: normalizePermissionMode(opts),
      autoApprove: !!opts.autoApprove,
      messages: [], claudeSessionId: null, codexSessionId: null, codexStarted: false, grokSessionId: null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    set((s) => ({
      conversations: { ...s.conversations, [id]: conv },
      activeConvByHost: { ...s.activeConvByHost, [hostId]: id }
    }));
    persist();
    return conv;
  },

  pushMessage: (convId, msg) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      // 单对话消息上限:超出后丢弃最旧的,保护渲染与持久化性能
      const MAX_MESSAGES = 2000;
      const messages = [...c.messages, msg];
      const updated = {
        ...c,
        messages: messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages,
        updatedAt: Date.now()
      };
      return { conversations: { ...s.conversations, [convId]: updated } };
    });
    persist();
  },

  /** 累计对话用量(token / 费用) */
  addUsage: (convId, { inputTokens = 0, outputTokens = 0, costUsd = 0 }) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      const u = c.usage || { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...c,
            usage: {
              inputTokens: u.inputTokens + inputTokens,
              outputTokens: u.outputTokens + outputTokens,
              costUsd: u.costUsd + costUsd
            }
          }
        }
      };
    });
    persist();
  },

  /** 流式增量:追加到当前流式气泡,没有则新建 */
  appendStreamDelta: (convId, kind, chunk) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      const msgs = c.messages;
      const last = msgs[msgs.length - 1];
      let next;
      if (last && last.role === 'agent' && last.kind === kind && last.streaming) {
        next = [...msgs.slice(0, -1), { ...last, text: last.text + chunk }];
      } else {
        next = [...msgs, { role: 'agent', kind, text: chunk, streaming: true, ts: Date.now() }];
      }
      return { conversations: { ...s.conversations, [convId]: { ...c, messages: next, updatedAt: Date.now() } } };
    });
    persist();
  },

  /** 完整消息到达:替换对应的流式气泡(避免重复),否则正常追加 */
  finalizeStream: (convId, kind, msg) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      const msgs = c.messages;
      const last = msgs[msgs.length - 1];
      const final = { role: 'agent', ...msg, streaming: false, ts: Date.now() };
      const next = (last && last.role === 'agent' && last.kind === kind && last.streaming)
        ? [...msgs.slice(0, -1), final]
        : [...msgs, final];
      return { conversations: { ...s.conversations, [convId]: { ...c, messages: next, updatedAt: Date.now() } } };
    });
    persist();
  },

  updateConvResume: (convId, { claudeSessionId, codexSessionId, codexStarted, grokSessionId, lastTurnAgent }) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...c, claudeSessionId, codexSessionId, codexStarted, grokSessionId,
            ...(lastTurnAgent ? { lastTurnAgent } : {})
          }
        }
      };
    });
    persist();
  },

  /* ---- 目标模式:跨轮自动推进,直到达成/卡住/触顶 ---- */
  setConversationGoal: (convId, goal) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return { conversations: { ...s.conversations, [convId]: { ...c, goal, updatedAt: Date.now() } } };
    });
    persist();
  },
  updateConversationGoal: (convId, patch) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c || !c.goal) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, goal: { ...c.goal, ...patch }, updatedAt: Date.now() }
        }
      };
    });
    persist();
  },

  updateConversationAutoConfirm: (convId, on) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return { conversations: { ...s.conversations, [convId]: { ...c, autoConfirm: !!on, updatedAt: Date.now() } } };
    });
    persist();
  },

  /** 同一对话内切换引擎(codex / claude / deepseek):目标引擎开新会话,首条消息会自动带上下文接力 */
  updateConversationAgent: (convId, agent) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c || c.agent === agent) return {};
      // 清空目标引擎的 resume(它没经历过中间的对话,旧会话已脱节),模型恢复默认
      // claude 与 deepseek 共用 claude CLI 的会话机制(claudeSessionId)
      const cleared = agent === 'codex'
        ? { codexSessionId: null, codexStarted: false }
        : agent === 'grok'
          ? { grokSessionId: null }
          : { claudeSessionId: null };
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, agent, model: '', ...cleared, updatedAt: Date.now() }
        }
      };
    });
    persist();
  },

  updateConversationModel: (convId, model) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, model: String(model || '').trim(), updatedAt: Date.now() }
        }
      };
    });
    persist();
  },

  updateConversationPermission: (convId, mode) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, permissionMode: normalizePermissionMode(mode), updatedAt: Date.now() }
        }
      };
    });
    persist();
  },

  renameConversation: (convId, title) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return { conversations: { ...s.conversations, [convId]: { ...c, title } } };
    });
    persist();
  },

  deleteConversation: (convId) => {
    set((s) => {
      const conv = s.conversations[convId];
      const rest = { ...s.conversations };
      delete rest[convId];
      const active = { ...s.activeConvByHost };
      if (conv && active[conv.hostId] === convId) active[conv.hostId] = null;
      return { conversations: rest, activeConvByHost: active };
    });
    persist();
  },

  setAgentRunning: (convId, v) =>
    set((s) => ({ agentRunning: { ...s.agentRunning, [convId]: v } })),

  enqueuePrompt: (convId, item) =>
    set((s) => ({ queued: { ...s.queued, [convId]: [...(s.queued[convId] || []), item] } })),
  shiftQueued: (convId) => {
    const q = get().queued[convId] || [];
    if (!q.length) return null;
    const [head, ...rest] = q;
    set((s) => ({ queued: { ...s.queued, [convId]: rest } }));
    return head;
  },
  removeQueued: (convId, id) =>
    set((s) => ({ queued: { ...s.queued, [convId]: (s.queued[convId] || []).filter((x) => x.id !== id) } })),
  clearQueued: (convId) =>
    set((s) => ({ queued: { ...s.queued, [convId]: [] } })),
  appendSetupLog: (hostId, text) =>
    set((s) => ({ setupLogs: { ...s.setupLogs, [hostId]: (s.setupLogs[hostId] || '') + text } })),
  clearSetupLog: (hostId) =>
    set((s) => ({ setupLogs: { ...s.setupLogs, [hostId]: '' } })),
  setEnvInfo: (hostId, info) =>
    set((s) => ({ envInfo: { ...s.envInfo, [hostId]: info } }))
}));

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const convos = Object.values(useStore.getState().conversations);
    window.api.convos.save(convos).catch(() => {});
  }, 300);
}

/**
 * 识别"模型在等确认"(聊天按钮与全自动模式共用)。
 * 只认真正在等答复的句式,并排除「已确认/已完成」等完成时表述,防止确认循环。
 */
export function isAwaitingConfirm(text = '') {
  const tail = String(text).trim().slice(-200);
  if (!tail) return false;
  if (/已(确认|按|完成|部署|生效)/.test(tail) && !/请(您)?确认|是否|吗[??]?\s*$/.test(tail)) return false;
  return /(请(您)?(确认|审阅|过目)|等待(您的)?(确认|指示|回复)|是否(继续|执行|同意|采纳|需要)|需要我(继续|开始|执行|修改)吗|可以开始吗|要不要我|确认后(我|再|立即)|请回复(序号|确认)|如无异议)/.test(tail);
}

/** 全自动模式的防失控状态(内存态,人工发言即重置) */
const MAX_AUTO_REPLIES = 5;
/** 网络中断后最多自动续跑几次(超过则判定链路有问题,交给人处理) */
export const MAX_AUTO_RESUME = 3;
const autoReplyState = new Map(); // convId -> { n, last }
export function resetAutoReplies(convId) { autoReplyState.delete(convId); }
/**
 * 判定是否允许自动确认:
 * - 模型重复发出同一确认请求 -> 拒绝(大概率陷入循环/幻觉流程)
 * - 连续自动确认达到上限 -> 拒绝
 */
export function evaluateAutoConfirm(convId, promptText) {
  const st = autoReplyState.get(convId) || { n: 0, last: '' };
  const sig = String(promptText || '').trim().slice(0, 120);
  const cap = useStore.getState().settings.autoConfirmCap || MAX_AUTO_REPLIES;
  if (st.last && sig === st.last) return { ok: false, reason: 'repeat' };
  if (st.n >= cap) return { ok: false, reason: 'limit' };
  autoReplyState.set(convId, { n: st.n + 1, last: sig });
  return { ok: true };
}
export { MAX_AUTO_REPLIES };

/** 上下文接力摘要:取对话中的用户消息与助手回答,从最新往前拼,总量封顶 */
export function buildContextDigest(messages = [], maxChars = 6000) {
  const lines = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    let line = '';
    if (m.role === 'user' && m.text) line = `用户: ${m.text}`;
    else if (m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text) line = `助手: ${m.text}`;
    if (!line) continue;
    if (line.length > 600) line = line.slice(0, 600) + '…';
    if (lines.join('\n').length + line.length > maxChars) break;
    lines.unshift(line);
  }
  return lines.join('\n');
}

/** 统一的发送入口:处理附件准备、记录用户消息、调用 agent(排队出队也走这里) */
export async function sendToAgent(hostId, convId, text, files = [], opts = {}) {
  const st = useStore.getState();
  const messageId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!opts.auto) {
    resetAutoReplies(convId);        // 人工发言重置自动确认计数
    st.setAutoResumeCount(convId, 0); // 也重置网络续跑计数(新任务从零算)
  }
  st.setAgentRunning(convId, true);
  try {
    const attachments = files.length
      ? await window.api.attachments.prepare({ hostId, convId, messageId, files })
      : [];
    // 引擎切换后的首条消息:注入此前对话摘要,实现 codex/claude 共用上下文
    const conv = st.conversations[convId];
    let prompt = text;
    if (conv && conv.lastTurnAgent && conv.lastTurnAgent !== conv.agent) {
      const digest = buildContextDigest(conv.messages);
      if (digest) {
        const other = conv.lastTurnAgent === 'codex' ? 'Codex' : 'Claude Code';
        prompt = `【上下文接力】本对话此前由 ${other} 处理。以下是至今的对话记录摘要,请阅读后无缝继续,不要重复已完成的工作,也不要重新自我介绍:\n${digest}\n————\n用户新指令: ${text}`;
      }
    }
    // 全自动模式:从源头减少确认式提问
    if (conv?.autoConfirm) {
      prompt += '\n(全自动模式:如需决策请自行选择最合理的方案并直接继续执行,不要停下来向我确认;仅在不可逆的破坏性操作前才询问。)';
    }
    st.pushMessage(convId, { role: 'user', kind: 'text', text, attachments, ts: Date.now() });
    await window.api.agent.send({ hostId, convId, messageId, prompt, attachments });
  } catch (e) {
    st.pushMessage(convId, { role: 'agent', kind: 'error', text: e.message, ts: Date.now() });
    st.setAgentRunning(convId, false);
  }
}

export const LOCAL_HOST = { id: 'local', name: '本地(本机)', host: 'localhost', username: '本机', local: true };

export async function loadHosts() {
  const hosts = await window.api.hosts.list();
  // 本地项目始终置顶,状态恒为已连接
  useStore.getState().setHosts([LOCAL_HOST, ...hosts]);
  useStore.getState().setStatus('local', 'connected');
}

export async function saveHosts(hosts) {
  useStore.getState().setHosts(hosts);
  await window.api.hosts.save(hosts.filter((h) => h.id !== 'local')); // 不持久化本地伪主机
}

export async function loadSettings() {
  try {
    const s = await window.api.settings.get();
    useStore.setState({ settings: s });
    document.documentElement.setAttribute('data-theme', s.theme || 'dark');
  } catch (_) {}
}

export async function loadConversations() {
  const list = await window.api.convos.list();
  const map = {};
  for (const c of list) map[c.id] = normalizeConversation(c);
  useStore.setState({ conversations: map });
  if (list.some((c) => c.permissionMode !== map[c.id].permissionMode)) persist();
}
