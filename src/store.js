import { create } from 'zustand';
import { normalizeLanguage } from './i18n.mjs';

export const TASK_TEMPLATES = [
  { id: 'research', label: '研究', stages: [{ id: 'research', role: 'research' }, { id: 'review', role: 'review' }] },
  { id: 'implementation', label: '实现', stages: [{ id: 'plan', role: 'research' }, { id: 'implement', role: 'implementation' }, { id: 'review', role: 'review' }] },
  { id: 'review', label: '审查', stages: [{ id: 'review', role: 'review' }] }
];

function createTaskStages(templateId, cwd = '') {
  const template = TASK_TEMPLATES.find((item) => item.id === templateId) || TASK_TEMPLATES[1];
  return template.stages.map((stage) => ({ ...stage, status: 'pending', cwd, convId: null, startedAt: null, finishedAt: null }));
}

function normalizePermissionMode(value) {
  if (value === 'system' || value?.permissionMode === 'system') return 'system';
  if (value === 'approval' || value?.permissionMode === 'approval') return 'approval';
  if (value === 'plan' || value?.permissionMode === 'plan') return 'plan';
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
  tab: 'chat',       // chat | files | terminal | setup
  editingHost: null, // null | {} | host

  // 对话历史:conversations 为 convId -> conv
  // conv = {id, hostId, title, agent, cwd, model, permissionMode, autoApprove, messages:[],
  //         claudeSessionId, codexStarted, createdAt, updatedAt}
  conversations: {},
  activeConvByHost: {}, // hostId -> convId(null 表示停留在会话列表)
  tasks: {},
  projects: {},
  activeTaskByHost: {},
  // 文件传输任务在同一应用会话中跨面板保留；不落盘，避免重启后展示不可恢复的远端操作。
  transfers: {},
  agentRunning: {},     // convId -> bool
  queued: {},           // convId -> [{id,text,files}] 排队待发送的消息
  setupLogs: {},        // hostId -> string
  envInfo: {},          // hostId -> {os,node,npm,codex,claude}
  settings: { language: 'zh-CN', theme: 'dark', terminalFontSize: 13, defaultPermissionMode: 'workspace', autoConfirmCap: 5 },
  showSettings: false,

  setShowSettings: (v) => set({ showSettings: v }),
  applySettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    const next = useStore.getState().settings;
    if (patch.theme) document.documentElement.setAttribute('data-theme', next.theme);
    if (patch.language) document.documentElement.lang = normalizeLanguage(next.language);
    window.api.settings.save(patch).catch(() => {});
  },

  setHosts: (hosts) => set({ hosts }),
  setActiveHost: (id) => set({ activeHostId: id }),
  setTab: (tab) => set({ tab }),
  setEditingHost: (h) => set({ editingHost: h }),
  setStatus: (hostId, status, detail) =>
    set((s) => ({
      statuses: { ...s.statuses, [hostId]: status },
      statusDetails: { ...s.statusDetails, [hostId]: detail || '' }
    })),

  createTransfer: (fields) => {
    const transfer = { ...fields, createdAt: Date.now(), updatedAt: Date.now() };
    set((s) => ({ transfers: { ...s.transfers, [transfer.id]: transfer } }));
    return transfer;
  },

  updateTransferProgress: (transferId, transferred, total) =>
    set((s) => {
      const transfer = s.transfers[transferId];
      if (!transfer) return {};
      return { transfers: { ...s.transfers, [transferId]: { ...transfer, transferred, total, updatedAt: Date.now() } } };
    }),

  finishTransfer: (transferId, patch = {}) =>
    set((s) => {
      const transfer = s.transfers[transferId];
      if (!transfer) return {};
      return { transfers: { ...s.transfers, [transferId]: { ...transfer, ...patch, updatedAt: Date.now() } } };
    }),

  setActiveConv: (hostId, convId) =>
    set((s) => ({ activeConvByHost: { ...s.activeConvByHost, [hostId]: convId } })),
  setActiveTask: (hostId, taskId) => set((s) => ({ activeTaskByHost: { ...s.activeTaskByHost, [hostId]: taskId } })),

  setProjects: (projects) => set({ projects }),
  createProject: (fields = {}) => {
    const now = Date.now();
    const id = fields.id || `p_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const project = { id, hostId: fields.hostId, cwd: fields.cwd, name: fields.name || fields.cwd.split(/[\\/]/).filter(Boolean).pop() || '项目', rules: fields.rules || '', skills: fields.skills || '', defaultAgent: fields.defaultAgent || 'codex', defaultModel: fields.defaultModel || '', permissionMode: normalizePermissionMode(fields), updatedAt: now };
    set((s) => ({ projects: { ...s.projects, [id]: project } }));
    persistProjects();
    return project;
  },

  createTask: (hostId, convId, fields = {}) => {
    const now = Date.now();
    const id = `t_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      id, hostId, convId, title: fields.title || '未命名任务', status: 'draft', templateId: fields.templateId || 'implementation',
      createdAt: now, updatedAt: now, runStartedAt: null, runFinishedAt: null,
      delivery: { diffs: [], artifacts: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, dangerousCommands: [], auditEvents: [] },
      review: null, approvalRequests: [], projectContext: fields.projectContext || null, stages: createTaskStages(fields.templateId || 'implementation', fields.cwd || '')
    };
    set((s) => ({ tasks: { ...s.tasks, [id]: task }, activeTaskByHost: { ...s.activeTaskByHost, [hostId]: id } }));
    persistTasks();
    return task;
  },

  updateTaskStatus: (taskId, status) => {
    set((s) => {
      const task = s.tasks[taskId];
      if (!task || (status === 'accepted' && task.status === 'running')) return {};
      const now = Date.now();
      return { tasks: { ...s.tasks, [taskId]: { ...task, status, updatedAt: now,
        ...(status === 'running' ? { runStartedAt: now } : {}),
        ...(status === 'review_ready' || status === 'failed' ? { runFinishedAt: now } : {}) } } };
    });
    persistTasks();
  },

  recordTaskDelivery: (taskId, patch) => {
    set((s) => {
      const task = s.tasks[taskId];
      if (!task) return {};
      const current = task.delivery || {};
      return { tasks: { ...s.tasks, [taskId]: { ...task, updatedAt: Date.now(), delivery: {
        ...current, ...patch,
        diffs: [...(current.diffs || []), ...(patch.diffs || [])],
        artifacts: [...(current.artifacts || []), ...(patch.artifacts || [])],
        dangerousCommands: [...(current.dangerousCommands || []), ...(patch.dangerousCommands || [])],
        auditEvents: [...(current.auditEvents || []), ...(patch.auditEvents || [])]
      } } } };
    });
    persistTasks();
  },

  finalizeTaskDelivery: (taskId) => {
    set((s) => {
      const task = s.tasks[taskId];
      if (!task) return {};
      const delivery = task.delivery || {};
      const now = Date.now();
      const deliveryPackage = {
        generatedAt: now,
        diffs: [...(delivery.diffs || [])], artifacts: [...(delivery.artifacts || [])],
        usage: { ...(delivery.usage || {}) }, dangerousCommands: [...(delivery.dangerousCommands || [])],
        auditEvents: [...(delivery.auditEvents || [])]
      };
      return { tasks: { ...s.tasks, [taskId]: { ...task, updatedAt: now, deliveryPackage } } };
    });
    persistTasks();
  },

  reviewTask: (taskId, decision, note = '') => {
    set((s) => {
      const task = s.tasks[taskId];
      if (!task || task.status === 'running') return {};
      const status = decision === 'accept' ? 'accepted' : 'changes_requested';
      return { tasks: { ...s.tasks, [taskId]: { ...task, status, updatedAt: Date.now(), review: { decision, note, at: Date.now() } } } };
    });
    persistTasks();
  },

  retryTask: (taskId) => {
    let retried = null;
    set((s) => {
      const task = s.tasks[taskId];
      if (!task || !['failed', 'needs_input', 'changes_requested'].includes(task.status)) return {};
      const now = Date.now();
      const retryCount = (task.retryCount || 0) + 1;
      retried = { ...task, status: 'queued', retryCount, updatedAt: now, runFinishedAt: null,
        delivery: { ...(task.delivery || {}), auditEvents: [...(task.delivery?.auditEvents || []), {
          type: 'task_retry', level: 'workspace_write', detail: `任务恢复执行（第 ${retryCount} 次）`, ts: now
        }] } };
      return { tasks: { ...s.tasks, [taskId]: retried } };
    });
    persistTasks();
    return retried;
  },

  startTaskStage: (taskId, stageId, fields = {}) => {
    let started = null;
    set((s) => {
      const task = s.tasks[taskId];
      const stage = task?.stages?.find((item) => item.id === stageId);
      if (!task || !stage || stage.status === 'running') return {};
      const now = Date.now();
      started = { ...stage, status: 'running', cwd: fields.cwd || stage.cwd || '', convId: fields.convId || stage.convId || null, startedAt: now };
      const delivery = task.delivery || {};
      return { tasks: { ...s.tasks, [taskId]: { ...task, updatedAt: now,
        stages: task.stages.map((item) => item.id === stageId ? started : item),
        delivery: { ...delivery, auditEvents: [...(delivery.auditEvents || []), {
          type: 'stage_started', level: 'workspace_write', detail: `阶段启动：${stage.role}`, ts: now
        }] }
      } } };
    });
    persistTasks();
    return started;
  },

  finishTaskStage: (taskId, stageId, status = 'review_ready') => {
    set((s) => {
      const task = s.tasks[taskId];
      const stage = task?.stages?.find((item) => item.id === stageId);
      if (!task || !stage) return {};
      const now = Date.now();
      return { tasks: { ...s.tasks, [taskId]: { ...task, updatedAt: now,
        stages: task.stages.map((item) => item.id === stageId ? { ...item, status, finishedAt: now } : item)
      } } };
    });
    persistTasks();
  },

  createTaskApproval: (taskId, fields = {}) => {
    let created = null;
    set((s) => {
      const task = s.tasks[taskId];
      if (!task) return {};
      const now = Date.now();
      created = {
        id: `a_${now}_${Math.random().toString(36).slice(2, 6)}`,
        scope: fields.scope || 'system', reason: fields.reason || '请求系统权限',
        status: 'pending', requestedAt: now, resolvedAt: null, resolvedBy: null
      };
      const delivery = task.delivery || {};
      return { tasks: { ...s.tasks, [taskId]: { ...task, status: 'needs_approval', updatedAt: now,
        approvalRequests: [...(task.approvalRequests || []), created],
        delivery: { ...delivery, auditEvents: [...(delivery.auditEvents || []), {
          type: 'approval_requested', level: 'system', detail: `审批请求：${created.reason}`, ts: now
        }] }
      } } };
    });
    persistTasks();
    return created;
  },

  resolveTaskApproval: (taskId, approvalId, decision) => {
    let resolved = null;
    set((s) => {
      const task = s.tasks[taskId];
      const approval = task?.approvalRequests?.find((item) => item.id === approvalId && item.status === 'pending');
      if (!task || !approval || !['approved', 'rejected'].includes(decision)) return {};
      const now = Date.now();
      resolved = { ...approval, status: decision, resolvedAt: now, resolvedBy: 'local_user' };
      const delivery = task.delivery || {};
      const nextTasks = { ...s.tasks, [taskId]: { ...task, status: 'needs_input', updatedAt: now,
        approvalRequests: task.approvalRequests.map((item) => item.id === approvalId ? resolved : item),
        delivery: { ...delivery, auditEvents: [...(delivery.auditEvents || []), {
          type: 'approval_resolved', level: 'system', detail: `审批${decision === 'approved' ? '通过' : '拒绝'}：${approval.reason}`, ts: now
        }] }
      } };
      if (decision !== 'approved') return { tasks: nextTasks };
      const conv = s.conversations[task.convId];
      if (!conv) return { tasks: nextTasks };
      return { tasks: nextTasks, conversations: { ...s.conversations, [conv.id]: {
        ...conv, permissionMode: 'system', updatedAt: now
      } } };
    });
    persistTasks();
    if (resolved?.status === 'approved') persist();
    return resolved;
  },

  createConversation: (hostId, opts) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const conv = {
      id, hostId,
      title: opts.title || (opts.cwd ? opts.cwd.split('/').filter(Boolean).pop() : '新对话') || '新对话',
      agent: opts.agent, cwd: opts.cwd || '', model: opts.model || '',
      permissionMode: normalizePermissionMode(opts), projectContext: opts.projectContext || null,
      autoApprove: !!opts.autoApprove,
      messages: [], claudeSessionId: null, codexSessionId: null, codexStarted: false,
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

  updateConvResume: (convId, { claudeSessionId, codexSessionId, codexStarted, lastTurnAgent }) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: {
            ...c, claudeSessionId, codexSessionId, codexStarted,
            ...(lastTurnAgent ? { lastTurnAgent } : {})
          }
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

  /** 同一对话内切换引擎(codex <-> claude):目标引擎开新会话,首条消息会自动带上下文接力 */
  updateConversationAgent: (convId, agent) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c || c.agent === agent) return {};
      // 清空目标引擎的 resume(它没经历过中间的对话,旧会话已脱节),模型恢复默认
      const cleared = agent === 'claude'
        ? { claudeSessionId: null }
        : { codexSessionId: null, codexStarted: false };
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

let taskSaveTimer = null;
function persistTasks() {
  clearTimeout(taskSaveTimer);
  taskSaveTimer = setTimeout(() => {
    window.api.tasks.save(Object.values(useStore.getState().tasks)).catch(() => {});
  }, 300);
}

let projectSaveTimer = null;
function persistProjects() {
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(() => window.api.projects.save(Object.values(useStore.getState().projects)).catch(() => {}), 300);
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
  if (!opts.auto) resetAutoReplies(convId); // 人工发言重置自动确认计数
  const linkedTask = Object.values(st.tasks).find((task) => (task.convId === convId || task.stages?.some((stage) => stage.convId === convId)) && task.status !== 'archived');
  if (linkedTask?.status === 'needs_approval') {
    st.pushMessage(convId, { role: 'agent', kind: 'error', text: '任务正在等待权限审批；请先在任务中心批准或拒绝该请求。', ts: Date.now() });
    return false;
  }
  if (linkedTask && linkedTask.status !== 'running') st.updateTaskStatus(linkedTask.id, 'running');
  st.setAgentRunning(convId, true);
  try {
    const attachments = files.length
      ? await window.api.attachments.prepare({ hostId, convId, messageId, files })
      : [];
    // 引擎切换后的首条消息:注入此前对话摘要,实现 codex/claude 共用上下文
    const conv = st.conversations[convId];
    let prompt = text;
    const projectContext = opts.projectContext || conv?.projectContext;
    if (projectContext) {
      const { name, cwd, rules, skills } = projectContext;
      const contextLines = [`【项目上下文】${name || cwd || '当前项目'}`, cwd ? `工作目录：${cwd}` : '', rules ? `项目规则：${rules}` : '', skills ? `Skills：${skills}` : ''].filter(Boolean);
      if (contextLines.length > 1) prompt = `${contextLines.join('\n')}\n——\n${prompt}`;
    }
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
    document.documentElement.lang = normalizeLanguage(s.language);
  } catch (_) {}
}

export async function loadConversations() {
  const list = await window.api.convos.list();
  const map = {};
  for (const c of list) map[c.id] = normalizeConversation(c);
  useStore.setState({ conversations: map });
  if (list.some((c) => c.permissionMode !== map[c.id].permissionMode)) persist();
}

export async function loadTasks() {
  try {
    const list = await window.api.tasks.list();
    const tasks = {};
    for (const task of list) tasks[task.id] = task;
    useStore.setState({ tasks });
  } catch (_) {}
}

export async function loadProjects() {
  try {
    const list = await window.api.projects.list();
    useStore.setState({ projects: Object.fromEntries(list.map((project) => [project.id, project])) });
  } catch (_) {}
}
