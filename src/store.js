import { create } from 'zustand';
import { applyTheme, DEFAULT_THEME } from './themes.js';
import { parsePlan, parseProseProgress } from './planProgress.js';
import { mergePlan, scaleRoundsForPlan } from './goalMode.js';
import { mirrorConversation, buildMirrorPrompt, buildForkPrompt } from './mirrorConversation.js';

/**
 * 主题变化通知。
 *
 * xterm 的配色是在构造时传进去的对象,不吃 CSS 变量 —— 换皮肤后终端会
 * 保持原样,出现「界面变白了、终端还是黑的」。所以换肤时广播一次,
 * 让每个终端实例自己去取新的变量值。
 */
const THEME_EVENT = 'ras:theme';
function notifyTheme() {
  if (typeof window !== 'undefined') window.dispatchEvent(new window.CustomEvent(THEME_EVENT));
}
export function onThemeChange(fn) {
  window.addEventListener(THEME_EVENT, fn);
  return () => window.removeEventListener(THEME_EVENT, fn);
}

/** 读当前生效的配色 token,给 xterm 这类不认 CSS 变量的组件用 */
export function themeVar(name, fallback = '') {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return v || fallback;
}

function normalizePermissionMode(value) {
  if (value === 'system' || value?.permissionMode === 'system') return 'system';
  if (value === 'workspace' || value?.permissionMode === 'workspace') return 'workspace';
  return value?.autoApprove === true ? 'system' : 'workspace';
}

/** grok 引擎已移除:历史对话平滑迁移到 dsh,否则打开时引擎为空、发不出消息 */
const LEGACY_AGENTS = { grok: 'dsh' };

function normalizeConversation(conv) {
  return {
    ...conv,
    agent: LEGACY_AGENTS[conv.agent] || conv.agent,
    permissionMode: normalizePermissionMode(conv)
  };
}

/* 同时最多 4 个面板:再多一屏就小到看不清了,而且每个对话各占一条
   SSH 通道,开太多会把远端的 MaxSessions 吃光,表现为「新对话打不开」。 */
export const MAX_PANES = 4;

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
  /* hostId -> [convId] 额外分屏的对话。主面板仍是 activeConvByHost,
     这里只放"再多开的那几个" —— 这样所有读 activeConvByHost 的地方
     行为不变,不必为了分屏去改一堆无关代码。 */
  extraConvByHost: {},
  agentRunning: {},     // convId -> bool
  queued: {},           // convId -> [{id,text,files}] 排队待发送的消息
  setupLogs: {},        // hostId -> string
  envInfo: {},          // hostId -> {os,node,npm,codex,claude}
  settings: { theme: DEFAULT_THEME, accent: '', terminalFontSize: 13, defaultPermissionMode: 'workspace', autoConfirmCap: 5, screenshotShortcut: 'CommandOrControl+Shift+2', screenshotShortcutEnabled: true },
  showSettings: false,

  setShowSettings: (v) => set({ showSettings: v }),
  applySettings: (patch) => {
    set((s) => ({ settings: { ...s.settings, ...patch } }));
    const next = useStore.getState().settings;
    /* 强调色变了也要重刷 —— 它是叠在主题上的覆盖,不重新 apply 就只改了一半 */
    if (patch.theme !== undefined || patch.accent !== undefined) {
      applyTheme(next.theme, { accent: next.accent });
      notifyTheme();
    }
    window.api.settings.save(patch).catch(() => {});
  },

  setHosts: (hosts) => set({ hosts }),
  setActiveHost: (id) => set({ activeHostId: id }),
  setTab: (tab) => set({ tab }),
  // 待在终端里自动执行的命令(如「在本机登录 Claude」跳转过去自动敲 claude)
  pendingTermCommand: null,
  setPendingTermCommand: (payload) => set({ pendingTermCommand: payload }),
  // 内置浏览器要打开的地址(由 dsh 配置等入口设置)
  pendingBrowserUrl: null,
  setPendingBrowserUrl: (url) => set({ pendingBrowserUrl: url }),
  // 网络中断后的自动续跑次数(按对话计,用户发新消息时清零)
  autoResumeCount: {},
  connectionPaused: {}, // 网络切换后只恢复连接,任务需用户明确继续
  setAutoResumeCount: (convId, n) =>
    set((s) => ({ autoResumeCount: { ...s.autoResumeCount, [convId]: n } })),
  setEditingHost: (h) => set({ editingHost: h }),
  setStatus: (hostId, status, detail, autoReconnect = false) =>
    set((s) => ({
      connectionPaused: autoReconnect && status !== 'connected' && s.statuses[hostId] === 'connected'
        ? { ...s.connectionPaused, ...Object.fromEntries(Object.values(s.conversations)
          .filter((c) => c.hostId === hostId).map((c) => [c.id, true])) }
        : s.connectionPaused,
      statuses: { ...s.statuses, [hostId]: status },
      statusDetails: { ...s.statusDetails, [hostId]: detail || '' }
    })),

  /** 追加一个分屏面板 */
  addSplit: (hostId, convId) => {
    set((s) => {
      const cur = s.extraConvByHost[hostId] || [];
      const primary = s.activeConvByHost[hostId];
      /* 已经在屏上就不重复加 —— 同一个对话渲染两次会各自 agent:start,
         而主进程 agent:start 会 cancel 掉同 convId 的现有会话,
         等于两个面板互相把对方掐死。 */
      if (!convId || convId === primary || cur.includes(convId)) return {};
      // 主面板 + 已有分屏 + 这一个,不能超过上限
      if (1 + cur.length + 1 > MAX_PANES) return {};
      return { extraConvByHost: { ...s.extraConvByHost, [hostId]: [...cur, convId] } };
    });
    persist();
  },

  /** 关掉一个分屏面板;关主面板时把第一个分屏顶上来 */
  closeSplit: (hostId, convId) => {
    set((s) => {
      const cur = s.extraConvByHost[hostId] || [];
      if (s.activeConvByHost[hostId] === convId) {
        const [next, ...rest] = cur;
        return {
          activeConvByHost: { ...s.activeConvByHost, [hostId]: next || null },
          extraConvByHost: { ...s.extraConvByHost, [hostId]: rest }
        };
      }
      return {
        extraConvByHost: { ...s.extraConvByHost, [hostId]: cur.filter((x) => x !== convId) }
      };
    });
    persist();
  },

  setActiveConv: (hostId, convId) =>
    set((s) => ({
      activeConvByHost: { ...s.activeConvByHost, [hostId]: convId },
      /* 换主对话时清掉分屏:否则点开另一个对话,旁边还挂着上一组的面板,
         看着像是同一批,极易对错窗口发消息。 */
      extraConvByHost: { ...s.extraConvByHost, [hostId]: [] }
    })),

  /**
   * 接纳一个由主进程创建的对话(手机端发起的任务)。
   * 用主进程给的 id,这样后续 agent:message 能正常落位 ——
   * pushMessage 对不存在的对话是直接丢弃的,不接纳就等于手机任务在桌面端隐身。
   * 幂等:同 id 重复接纳不覆盖已有消息。
   */
  adoptConversation: (conv) => {
    const s = get();
    if (s.conversations[conv.id]) return conv.id;
    const full = {
      messages: [], claudeSessionId: null, codexSessionId: null,
      codexStarted: false,
      permissionMode: 'workspace', autoApprove: false, model: '', reasoningEffort: '',
      team: null,
      createdAt: Date.now(), ...conv, updatedAt: Date.now()
    };
    set((st) => ({ conversations: { ...st.conversations, [conv.id]: full } }));
    persist();
    return conv.id;
  },

  createConversation: (hostId, opts) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const conv = {
      id, hostId,
      title: opts.title || (opts.cwd ? opts.cwd.split('/').filter(Boolean).pop() : '新对话') || '新对话',
      agent: opts.agent, cwd: opts.cwd || '', model: opts.model || '',
      reasoningEffort: opts.reasoningEffort || '',
      permissionMode: normalizePermissionMode(opts),
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

  /**
   * 镜像一条对话:保留历史,但开一条全新的引擎会话。
   *
   * 关键取舍全在 mirrorConversation.js 里 —— 尤其是**引擎会话 ID 不能复制**,
   * 复制了就是两个对话抢同一条线程的写锁。
   */
  mirrorConversation: (convId, opts = {}) => {
    const src = get().conversations[convId];
    if (!src) return null;
    const copy = mirrorConversation(src, opts);
    set((s) => ({
      conversations: { ...s.conversations, [copy.id]: copy },
      activeConvByHost: { ...s.activeConvByHost, [copy.hostId]: copy.id }
    }));
    persist();
    return copy;
  },

  /**
   * 把一条对话分成几路,每路一个 git worktree、一条分支、一个独立对话。
   *
   * 返回 [{name, ok, convId, path, branch, error}] —— **逐条报结果**,
   * 不是整体成功/失败:建到第三条时仓库出问题,前两条是真的建好了,
   * 笼统报一句"失败"会让人以为什么都没发生,然后重来一次,
   * 结果撞上"目录已存在"。
   */
  forkConversation: async (convId, specs = []) => {
    const src = get().conversations[convId];
    if (!src) return [];

    const detect = await window.api.worktree.detect({ hostId: src.hostId, cwd: src.cwd })
      .catch((e) => ({ ok: false, error: e.message }));
    if (!detect.ok) {
      return specs.map((sp) => ({ name: sp.name, ok: false, error: detect.error || '无法分路' }));
    }

    const names = specs.map((sp) => sp.name);
    const results = [];
    for (const sp of specs) {
      const slug = sp.slug;
      const r = await window.api.worktree.create({
        hostId: src.hostId, root: detect.root, slug, branch: sp.branch
      }).catch((e) => ({ ok: false, error: e.message }));

      if (!r.ok) { results.push({ name: sp.name, ok: false, error: r.error }); continue; }

      const copy = mirrorConversation(src, { title: sp.name, cwd: r.path });
      copy.forkOf = src.id;
      copy.forkFocus = sp.name;
      copy.forkBranch = r.branch;
      /* 兄弟路的名字要带上 —— 提示词里会写明"别碰这些",
         这是防止几路互相越界最直接的一招。 */
      copy.forkSiblings = names.filter((n) => n !== sp.name);
      set((s) => ({ conversations: { ...s.conversations, [copy.id]: copy } }));
      results.push({ name: sp.name, ok: true, convId: copy.id, path: r.path, branch: r.branch, reused: r.reused });
    }
    persist();
    return results;
  },

  /** 通用字段更新:只改几个字段、不想为每个字段单写一个 action 时用 */
  updateConvFields: (convId, patch) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return { conversations: { ...s.conversations, [convId]: { ...c, ...patch } } };
    });
    persist();
  },

  pushMessage: (convId, msg) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      // 单对话消息上限:超出后丢弃最旧的,保护渲染与持久化性能
      const MAX_MESSAGES = 2000;

      /* **同一条命令的后续事件要就地更新,不能追加。**
         引擎在命令跑的过程中会不断发同一条 item(输出越来越长),
         无脑追加的话对话里会出现一串几乎一样的「执行命令」;
         而按 id 合并,它就变成一块**原地刷新的日志**。 */
      const idx = msg.id
        ? c.messages.findIndex((m) => m.id === msg.id && m.kind === msg.kind)
        : -1;
      if (idx >= 0) {
        const next = [...c.messages];
        /* 保留原来的 ts —— 用新时间会让这条消息在按时间排序时跳位,
           而它其实还是原来那条。 */
        next[idx] = { ...next[idx], ...msg, ts: next[idx].ts };
        return {
          conversations: {
            ...s.conversations, [convId]: { ...c, messages: next, updatedAt: Date.now() }
          }
        };
      }
      /* end 事件单独发 tool_output,但它属于前面那条 tool。
         找得到就合进去,找不到再退回追加(兼容老对话)。 */
      if (msg.kind === 'tool_output' && msg.id) {
        const ti = c.messages.findIndex((m) => m.id === msg.id && m.kind === 'tool');
        if (ti >= 0) {
          const next = [...c.messages];
          next[ti] = {
            ...next[ti], running: false,
            output: msg.output || next[ti].output, exitCode: msg.exitCode
          };
          return {
            conversations: {
              ...s.conversations, [convId]: { ...c, messages: next, updatedAt: Date.now() }
            }
          };
        }
      }

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
  /**
   * 命令还在跑时的增量输出。
   *
   * 老格式(exec_command_output_delta)只给一小块新增文本,不给全量,
   * 所以这里必须**追加**而不是替换。
   *
   * 只留最后一段:一条 `docker build` 能刷出几十万字符,
   * 全存进对话既会把渲染拖垮,也会被写进持久化文件。
   * 实时日志要看的本来就是**最新那几屏**。
   */
  appendToolDelta: (convId, id, chunk) => {
    if (!id || !chunk) return;
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      const i = c.messages.findIndex((m) => m.id === id && m.kind === 'tool');
      if (i < 0) return {};
      const LIVE_LIMIT = 20000;
      const merged = (c.messages[i].output || '') + chunk;
      const next = [...c.messages];
      next[i] = {
        ...next[i], running: true,
        output: merged.length > LIVE_LIMIT ? merged.slice(-LIVE_LIMIT) : merged
      };
      return {
        conversations: {
          ...s.conversations, [convId]: { ...c, messages: next, updatedAt: Date.now() }
        }
      };
    });
    persist();
  },

  /** 本轮结束时,把还挂着"运行中"的工具调用收尾 */
  clearRunningTools: (convId) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c || !c.messages.some((m) => m.running)) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, messages: c.messages.map((m) => (m.running ? { ...m, running: false } : m)) }
        }
      };
    });
  },

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
            ...c,
            ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
            ...(codexSessionId !== undefined ? { codexSessionId } : {}),
            ...(codexStarted !== undefined ? { codexStarted } : {}),
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
  updateConversationAgent: (convId, agent, opts = {}) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c || c.agent === agent) return {};
      // 清空目标引擎的 resume(它没经历过中间的对话,旧会话已脱节),模型恢复默认
      // claude 与 deepseek 共用 claude CLI 的会话机制(claudeSessionId)
      const cleared = agent === 'codex'
        ? { codexSessionId: null, codexStarted: false }
        : agent === 'dsh'
          ? {}   // dsh 每轮都是新会话,没有 resume 状态需要清
          : { claudeSessionId: null };
      return {
        conversations: {
          ...s.conversations,
          /* 默认清空模型:换引擎后旧模型名多半不存在。
             但团队模式来回切时会显式带上该引擎自己的模型,不能一并抹掉。 */
          [convId]: {
            ...c, agent, model: opts.model !== undefined ? opts.model : '',
            ...cleared, updatedAt: Date.now()
          }
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

  /** codex 的推理强度(model_reasoning_effort);其他引擎没有对应开关 */
  /** 团队模式:整体设定/清除 */
  setConversationTeam: (convId, team) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return { conversations: { ...s.conversations, [convId]: { ...c, team, updatedAt: Date.now() } } };
    });
    persist();
  },

  /** 团队模式:打补丁(阶段/计数),不覆盖其余字段 */
  updateConversationTeam: (convId, patch) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c || !c.team) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, team: { ...c.team, ...patch }, updatedAt: Date.now() }
        }
      };
    });
    persist();
  },

  updateConversationReasoning: (convId, effort) => {
    set((s) => {
      const c = s.conversations[convId];
      if (!c) return {};
      return {
        conversations: {
          ...s.conversations,
          [convId]: { ...c, reasoningEffort: String(effort || '').trim(), updatedAt: Date.now() }
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
      // 删掉的对话若还挂在分屏里,会渲染成一个空壳
      const extras = Object.fromEntries(Object.entries(s.extraConvByHost || {})
        .map(([h, ids]) => [h, (ids || []).filter((x) => x !== convId)]));
      if (conv && active[conv.hostId] === convId) active[conv.hostId] = null;
      return { conversations: rest, activeConvByHost: active, extraConvByHost: extras };
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
/* 上次送去持久化时各对话的 updatedAt。
   只把变过的送过 IPC —— 原来每 300ms 把全部对话整个结构化克隆一遍发过去,
   对话一多就是每秒几 MB 的无谓序列化。磁盘那层本来就按对话分文件、
   按 updatedAt 跳过,瓶颈只在这段 IPC。 */
const sentAt = new Map();

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const all = Object.values(useStore.getState().conversations);
    const changed = all.filter((c) => sentAt.get(c.id) !== c.updatedAt);
    /* ids 必须每次都带全:主进程靠它清理已删除对话的文件。
       只发脏对话而不发 id 列表,删掉的对话会在磁盘上永远留着。 */
    const ids = all.map((c) => c.id);
    if (!changed.length && sentAt.size === ids.length) return;
    window.api.convos.save({ changed, ids })
      .then(() => { for (const c of changed) sentAt.set(c.id, c.updatedAt); })
      .catch(() => {});
    // 删掉的对话从记录里清掉,否则 size 对不上会一直触发空保存
    for (const id of [...sentAt.keys()]) if (!ids.includes(id)) sentAt.delete(id);
  }, 300);
}

/** 持久化记录重置:加载对话后调用,避免把刚从磁盘读出来的东西再原样写回去 */
export function markPersisted(convos) {
  sentAt.clear();
  for (const c of convos || []) if (c?.id) sentAt.set(c.id, c.updatedAt);
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
 * 读一次计划文件,把「第 N / M 步」并进目标。
 *
 * **永不抛错、永不阻断对话。** 计划文件可能还没被创建、路径写错、
 * 主机刚好断了 —— 这些都只是"这次没读到",不该把目标模式打断,
 * 更不该被当成"进度没推进"(那会让停滞判定凭空提前触发)。
 * 所以读失败时**连历史都不写**,让判据只吃真实数据。
 */
export async function refreshGoalPlan(hostId, convId) {
  const st = useStore.getState();
  const goal = st.conversations[convId]?.goal;
  if (!goal?.planPath) return;
  try {
    const r = await window.api.goal.readPlan({ hostId, path: goal.planPath });
    if (!r?.ok) return fallbackToProse(convId);
    const steps = parsePlan(r.text);
    if (!steps.length) return fallbackToProse(convId);   // 不是清单格式,当作没读到

    const patch = mergePlan(goal, steps);
    /* 67 步的活儿配 25 轮上限注定反复触顶,而这个功能本来就是为了不用人守着。
       只抬一次,并且把消息发出来 —— 悄悄放大用户设的上限,
       等于替他决定多花多少钱。 */
    const scaled = scaleRoundsForPlan(goal, patch.plan);
    if (scaled?.message) {
      useStore.getState().pushMessage(convId, {
        role: 'agent', kind: 'raw', text: scaled.message, ts: Date.now()
      });
    }
    const { message, ...scalePatch } = scaled || {};
    useStore.getState().updateConversationGoal(convId, {
      ...patch, ...scalePatch, planSource: 'file'
    });
  } catch {
    fallbackToProse(convId);
  }
}

/**
 * 读不到计划文件时,退回从模型正文里捞进度。
 *
 * 起因是一次很刺眼的对比:模型在回复里写着「当前仍在第 12/67 步」,
 * 而状态条显示「0/25 轮」—— **信息就在眼前,应用却视而不见。**
 *
 * 这条路**只有步数、没有清单内容**,而且来源是模型的一面之词,
 * 所以标成 planSource: 'prose',界面上会注明是自述、不能点开看条目。
 * 不写 planHistory:模型可能把上一轮的数字原样复读,
 * 拿它喂停滞判定会得出一个看似确凿、实则没有依据的结论。
 */
function fallbackToProse(convId) {
  const conv = useStore.getState().conversations[convId];
  if (!conv || conv.goal?.planSource === 'file') return;   // 有过文件就不退回猜的
  const last = [...conv.messages].reverse()
    .find((m) => m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text);
  const hit = last && parseProseProgress(last.text);
  if (!hit) return;
  useStore.getState().updateConversationGoal(convId, {
    plan: {
      total: hit.total, done: hit.current - 1, current: hit.current,
      percent: Math.round(((hit.current - 1) / hit.total) * 100),
      text: `第 ${hit.current} / ${hit.total} 步`, currentText: '', steps: []
    },
    planSource: 'prose'
  });
}
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
/**
 * 换一个引擎跑这一轮(团队模式用)。
 *
 * 为什么不能「改完 agent 直接 sendToAgent」:ChatPanel 有个 effect 监听
 * conv.agent,一变就调 agent:start,而主进程的 agent:start 会 cancel 掉
 * 已存在的会话 —— 正好把我们刚发出去的这一轮掐死。
 *
 * 所以这里先把 running 置起来(effect 侧据此跳过重启),自己显式 start
 * 并等它返回,再发送。顺带把该引擎自己的模型带回去,避免来回切时被清空。
 */
export async function runAsAgent(hostId, convId, agent, model, prompt) {
  const st = useStore.getState();
  if (st.connectionPaused[convId]) return;
  const conv = st.conversations[convId];
  if (!conv) return;
  st.setAgentRunning(convId, true);
  try {
    if (conv.agent !== agent) st.updateConversationAgent(convId, agent, { model: model || '' });
    const next = useStore.getState().conversations[convId];
    await window.api.agent.start({
      hostId, convId,
      opts: {
        agent, cwd: next.cwd, model: model || '',
        permissionMode: next.permissionMode || 'workspace',
        history: [], reasoningEffort: agent === 'codex' ? (next.reasoningEffort || '') : ''
      },
      resume: {
        claudeSessionId: next.claudeSessionId,
        codexSessionId: next.codexSessionId,
        codexStarted: next.codexStarted
      }
    });
    await sendToAgent(hostId, convId, prompt, [], { auto: true });
  } catch (e) {
    st.pushMessage(convId, {
      role: 'agent', kind: 'error',
      text: `团队模式切换到 ${agent} 失败:${e.message}`, ts: Date.now()
    });
    st.setAgentRunning(convId, false);
  }
}

export async function sendToAgent(hostId, convId, text, files = [], opts = {}) {
  const st = useStore.getState();
  if (opts.auto && st.connectionPaused[convId]) return;
  if (!opts.auto && st.connectionPaused[convId]) {
    if (st.statuses[hostId] !== 'connected') {
      st.pushMessage(convId, { role: 'agent', kind: 'error', text: '正在恢复网络连接,请连接成功后再继续。', ts: Date.now() });
      return;
    }
    useStore.setState({ connectionPaused: { ...st.connectionPaused, [convId]: false } });
  }
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
    if (useStore.getState().connectionPaused[convId]) {
      st.setAgentRunning(convId, false);
      st.pushMessage(convId, { role: 'agent', kind: 'error', text: '准备发送时网络中断，本条未发送，请连接恢复后重试。', ts: Date.now() });
      return;
    }
    const conv = st.conversations[convId];
    let prompt = text;
    /* 镜像出来的对话,第一轮要把历史交接给新线程。
       引擎侧的线程不支持分叉,所以上下文只能由我们这边补 ——
       这和切换引擎是同一个问题的两种形态,共用 buildContextDigest。
       用完立刻清掉标记,否则每一轮都会重发一遍摘要(白烧 token)。 */
    if (conv?.needsContextReplay) {
      const digest = buildContextDigest(conv.messages);
      /* 分路比普通镜像多一层:要划清边界(本路做什么、别路做什么),
         否则模型会顺手去改别路正在做的东西。 */
      if (conv.forkOf) {
        prompt = `${buildForkPrompt({
          digest, focus: conv.forkFocus || conv.title,
          branch: conv.forkBranch, path: conv.cwd, siblings: conv.forkSiblings || []
        })}\n————\n用户新指令: ${text}`;
      } else if (digest) {
        prompt = buildMirrorPrompt(digest, text);
      }
      st.updateConvFields(convId, { needsContextReplay: false });
    } else if (conv && conv.lastTurnAgent && conv.lastTurnAgent !== conv.agent) {
      // 引擎切换后的首条消息:注入此前对话摘要,实现 codex/claude 共用上下文
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
    applyTheme(s.theme || DEFAULT_THEME, { accent: s.accent });
    notifyTheme();
  } catch (_) {}
}

export async function loadConversations() {
  const list = await window.api.convos.list();
  const map = {};
  for (const c of list) map[c.id] = normalizeConversation(c);
  useStore.setState({ conversations: map });
  // 刚从磁盘读出来的,不需要再原样写回去
  markPersisted(Object.values(map));
  if (list.some((c) => c.permissionMode !== map[c.id].permissionMode)) persist();
}
