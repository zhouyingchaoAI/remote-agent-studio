import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useStore, sendToAgent, isAwaitingConfirm } from '../store.js';
import { useVoiceInput } from '../useVoiceInput.js';
import { buildPromptHistory, stepPromptHistory } from '../promptHistory.js';
import { extractOptions } from '../quickReplies.js';
import { matchCommands, applyCompletion, parseSlash, parseGoalArgs, helpText } from '../slashCommands.js';
import {
  createGoal, buildContinuePrompt, resumeGoalPatch, setGoalMaxRounds,
  GOAL_DEFAULT_MAX_ROUNDS, GOAL_EXTEND_ROUNDS
} from '../goalMode.js';
import FilePreview from './FilePreview.jsx';
import EngineStatus from './EngineStatus.jsx';
import Markdown from './Markdown.jsx';

/* 统一 diff(unified diff)红绿渲染 */
function DiffView({ text = '' }) {
  return (
    <pre className="diff-view">
      {String(text).split('\n').map((line, i) => {
        let cls = '';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-del';
        else if (line.startsWith('@@')) cls = 'diff-hunk';
        else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) cls = 'diff-file';
        return <div key={i} className={`diff-line ${cls}`}>{line || ' '}</div>;
      })}
    </pre>
  );
}

/* 编辑类工具的 old/new 内容 diff */
function EditDiff({ diff }) {
  return (
    <div className="edit-diff">
      {diff.old && (
        <pre className="diff-view">
          {diff.old.split('\n').map((l, i) => <div key={i} className="diff-line diff-del">- {l}</div>)}
        </pre>
      )}
      {diff.new && (
        <pre className="diff-view">
          {diff.new.split('\n').map((l, i) => <div key={i} className="diff-line diff-add">+ {l}</div>)}
        </pre>
      )}
    </div>
  );
}

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M tok';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k tok';
  return n + ' tok';
}


export default function ChatPanel({ hostId }) {
  const activeConvId = useStore((s) => s.activeConvByHost[hostId]);
  const conv = useStore((s) => (activeConvId ? s.conversations[activeConvId] : null));

  // 未选中对话 -> 显示会话列表 / 新建
  if (!activeConvId || !conv) return <ConversationHome hostId={hostId} />;
  return <ChatView key={conv.id} hostId={hostId} conv={conv} />;
}

/* ---------------- 会话列表(历史记录) ---------------- */
function ConversationHome({ hostId }) {
  const conversations = useStore((s) => s.conversations);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const list = Object.values(conversations)
    .filter((c) => c.hostId === hostId)
    .filter((c) => {
      if (!q) return true;
      if ((c.title || '').toLowerCase().includes(q) || (c.cwd || '').toLowerCase().includes(q)) return true;
      // 全文搜索(倒序找,命中即止)
      for (let i = c.messages.length - 1; i >= 0; i -= 1) {
        if ((c.messages[i].text || '').toLowerCase().includes(q)) return true;
      }
      return false;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (creating) return <SessionSetup hostId={hostId} onCancel={() => setCreating(false)} />;

  return (
    <div className="conv-home">
      <div className="conv-home-head">
        <h2>对话记录</h2>
        <input className="conv-search" value={query} placeholder="搜索标题 / 目录 / 内容..."
          onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={() => setCreating(true)}>+ 新建对话</button>
      </div>
      {list.length === 0 ? (
        <div className="muted center pad">{q ? '没有匹配的对话' : '还没有对话。点「新建对话」选择项目目录和 agent 开始。'}</div>
      ) : (
        <div className="conv-list">
          {list.map((c) => <ConvCard key={c.id} conv={c} />)}
        </div>
      )}
    </div>
  );
}

/** 导出对话为 Markdown 文本 */
function conversationToMarkdown(conv) {
  const lines = [`# ${conv.title}`, '', `> 引擎: ${conv.agent} · 目录: ${conv.cwd || '~'} · 导出时间: ${new Date().toLocaleString()}`, ''];
  for (const m of conv.messages) {
    if (m.role === 'user') {
      lines.push(`## 🧑 用户`, '', m.text || '', '');
    } else if (m.kind === 'text' || m.kind === 'result') {
      lines.push(`## 🤖 助手`, '', m.text || '', '');
    } else if (m.kind === 'reasoning') {
      lines.push(`<details><summary>🧠 思考</summary>`, '', m.text || '', '', '</details>', '');
    } else if (m.kind === 'tool') {
      lines.push(`- 🔧 **${m.name}** \`${String(m.detail || '').slice(0, 200)}\``);
    } else if (m.kind === 'diff') {
      lines.push('```diff', m.text || '', '```', '');
    } else if (m.kind === 'error') {
      lines.push(`> ❌ ${m.text}`, '');
    }
  }
  return lines.join('\n');
}

function ConvCard({ conv }) {
  const setActiveConv = useStore((s) => s.setActiveConv);
  const del = useStore((s) => s.deleteConversation);
  const rename = useStore((s) => s.renameConversation);
  // Electron 不支持 window.prompt,重命名用内联输入框实现
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conv.title);
  const last = conv.messages.filter((m) => m.role === 'user').slice(-1)[0];
  const when = new Date(conv.updatedAt).toLocaleString();

  const commitRename = () => {
    const t = draftTitle.trim();
    if (t && t !== conv.title) rename(conv.id, t);
    setEditing(false);
  };

  return (
    <div className="conv-card" onClick={() => !editing && setActiveConv(conv.hostId, conv.id)}>
      <div className="conv-card-top">
        <span className={`badge ${conv.agent}`}>{AGENT_BADGES[conv.agent] || conv.agent}</span>
        {editing ? (
          <input
            className="conv-title-input"
            value={draftTitle}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setDraftTitle(conv.title); setEditing(false); }
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className="conv-title">{conv.title}</span>
        )}
        <span className="flex1" />
        <button className="icon-btn" title="重命名"
          onClick={(e) => { e.stopPropagation(); setDraftTitle(conv.title); setEditing(true); }}>✎</button>
        <button className="icon-btn danger" title="删除"
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`删除对话「${conv.title}」?`)) return;
            await window.api.attachments.cleanup({ hostId: conv.hostId, convId: conv.id }).catch(() => {});
            del(conv.id);
          }}>✕</button>
      </div>
      <div className="conv-card-path muted small">{conv.cwd || '~'}</div>
      {last && <div className="conv-card-last muted small">最近: {last.text.slice(0, 60)}</div>}
      <div className="conv-card-meta muted small">{conv.messages.length} 条消息 · {when}</div>
    </div>
  );
}

/* ---------------- 单个对话视图 ---------------- */
/**
 * 从对话消息里抽出给 dsh 的历史。
 * 只取用户指令与助手正文 —— 错误提示、工具日志喂回去只会误导它。
 */
export function dshHistoryFrom(messages = [], maxItems = 12) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.text) continue;
    if (m.role === 'user') { out.push({ role: 'user', text: m.text }); continue; }
    // 引擎侧消息在 store 里是 role:'agent'(不是 'assistant');
    // 只取正文,error/raw/tool/reasoning 喂回去只会误导它
    if (m.role === 'agent' && (m.kind === 'text' || m.kind === 'result')) {
      out.push({ role: 'assistant', text: m.text });
    }
  }
  return out.slice(-maxItems);
}

function ChatView({ hostId, conv }) {
  const running = useStore((s) => s.agentRunning[conv.id] || false);
  const setActiveConv = useStore((s) => s.setActiveConv);
  const updateConversationPermission = useStore((s) => s.updateConversationPermission);
  const updateConversationModel = useStore((s) => s.updateConversationModel);
  const updateConversationAgent = useStore((s) => s.updateConversationAgent);
  const [input, setInput] = useState('');
  const [started, setStarted] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const listRef = useRef(null);
  const composingRef = useRef(false);
  const [filePreview, setFilePreview] = useState(null); // {path, name}
  const [visibleCount, setVisibleCount] = useState(200); // 长对话窗口化渲染
  const [slashIndex, setSlashIndex] = useState(0);       // 斜杠命令菜单选中项
  const permissionMode = conv.permissionMode || (conv.autoApprove ? 'system' : 'workspace');

  // 进入对话/切换模型或权限时,在主进程(重新)初始化 agent 会话(带 resume 状态续聊)
  useEffect(() => {
    window.api.agent.start({
      hostId, convId: conv.id,
      opts: {
        agent: conv.agent, cwd: conv.cwd, model: conv.model, permissionMode,
        /* dsh 没有 resume:重开应用后会话对象是空的,不喂历史就等于从零开始。
           claude/codex 靠各自的 sessionId 续聊,不需要也不该走这条。 */
        history: conv.agent === 'dsh' ? dshHistoryFrom(conv.messages) : []
      },
      resume: { claudeSessionId: conv.claudeSessionId, codexSessionId: conv.codexSessionId, codexStarted: conv.codexStarted }
    }).then(() => setStarted(true)).catch(() => setStarted(true));
    // eslint-disable-next-line
  }, [conv.id, permissionMode, conv.model, conv.agent]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [conv.messages, running]);

  /** 本地消息(命令回执),不发给模型 */
  const localNote = (text) =>
    useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text, ts: Date.now() });

  /** 处理斜杠命令;返回 true 表示已消费,不再发给模型 */
  const runSlashCommand = (raw) => {
    const { isCommand, name, args, known } = parseSlash(raw);
    if (!isCommand) return false;
    if (!known) { localNote(`未知命令 /${name}。输入 /help 查看全部命令。`); return true; }
    const st = useStore.getState();

    switch (name) {
      case 'help': localNote(helpText()); return true;
      case 'clear': setInput(''); return true;
      case 'new': setActiveConv(hostId, null); return true;
      case 'skill': st.setTab('skills'); return true;
      case 'export': {
        window.api.files.saveText({
          defaultName: `${conv.title || '对话'}.md`, content: conversationToMarkdown(conv)
        }).then((r) => { if (r?.saved) localNote(`已导出到 ${r.path}`); }).catch(() => {});
        return true;
      }
      case 'engine': {
        const target = args.trim().toLowerCase();
        if (!['codex', 'claude', 'deepseek', 'dsh'].includes(target)) {
          localNote('用法:/engine codex | claude | deepseek | dsh'); return true;
        }
        setStarted(false); updateConversationAgent(conv.id, target);
        localNote(`已切换引擎:${target}(上下文自动接力)`); return true;
      }
      case 'model': {
        setStarted(false); updateConversationModel(conv.id, args.trim());
        localNote(args.trim() ? `已切换模型:${args.trim()}` : '已恢复默认模型'); return true;
      }
      case 'mode': {
        const target = args.trim().toLowerCase();
        if (!['workspace', 'system'].includes(target)) { localNote('用法:/mode workspace | system'); return true; }
        changePermissionMode(target); localNote(`权限模式:${target}`); return true;
      }
      case 'auto': {
        const on = !/^off|关|0$/i.test(args.trim());
        st.updateConversationAutoConfirm(conv.id, on);
        localNote(`全自动:${on ? '开' : '关'}`); return true;
      }
      case 'goal': {
        const { sub, text, rounds } = parseGoalArgs(args);
        const goal = conv.goal;
        if (sub === 'set') {
          st.setConversationGoal(conv.id, createGoal(text));
          localNote(`🎯 目标已设定:${text}\n每轮结束后会自动推进,直到达成或触发上限(${GOAL_DEFAULT_MAX_ROUNDS} 轮)。\n随时可用 /goal pause 暂停、/goal clear 清除。`);
          // 立刻开跑
          setTimeout(() => sendToAgent(hostId, conv.id, buildContinuePrompt({ ...createGoal(text), rounds: 0 }), [], { auto: true }), 0);
          return true;
        }
        if (!goal?.text) { localNote('当前没有目标。用 /goal <目标描述> 设定一个。'); return true; }
        if (sub === 'status') {
          localNote(`🎯 目标:${goal.text}\n状态:${goal.status} · 已推进 ${goal.rounds || 0}/${goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS} 轮`);
        } else if (sub === 'pause') {
          st.updateConversationGoal(conv.id, { status: 'paused' }); localNote('🎯 目标模式已暂停');
        } else if (sub === 'resume') {
          // 触顶停下的必须同时抬预算,否则跑完一轮又立刻触顶
          const patch = resumeGoalPatch(goal);
          st.updateConversationGoal(conv.id, patch);
          localNote(patch.maxRounds
            ? `🎯 目标模式已继续,轮次预算提到 ${patch.maxRounds}`
            : '🎯 目标模式已继续');
          setTimeout(() => sendToAgent(hostId, conv.id, buildContinuePrompt(goal), [], { auto: true }), 0);
        } else if (sub === 'max') {
          try {
            const patch = setGoalMaxRounds(goal, rounds);
            st.updateConversationGoal(conv.id, patch);
            localNote(`🎯 轮次预算已设为 ${patch.maxRounds}(当前 ${goal.rounds || 0} 轮)`);
          } catch (e) { localNote(`🎯 ${e.message}`); }
        } else if (sub === 'clear') {
          st.setConversationGoal(conv.id, null); localNote('🎯 目标已清除');
        }
        return true;
      }
      default: return false;
    }
  };

  const send = async (textOverride) => {
    const raw = (textOverride ?? input).trim();
    // 斜杠命令在本地执行,不消耗模型
    if (textOverride == null && raw.startsWith('/')) {
      if (runSlashCommand(raw)) { setInput(''); setSlashIndex(0); return; }
    }
    const prompt = raw || (pendingFiles.length ? 'Please process the attached files.' : '');
    if (!prompt) return;
    setAttachmentError('');
    // 发送后回到"草稿"态,下次 ↑ 从最新一条重新开始
    historyRef.current.index = null;
    historyRef.current.draft = '';
    if (textOverride == null) setInput('');
    const files = textOverride == null ? pendingFiles : [];
    if (textOverride == null) setPendingFiles([]);
    // 正在执行/未初始化 -> 进入排队,本轮结束后自动发送
    if (running || !started) {
      useStore.getState().enqueuePrompt(conv.id, {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: prompt, files
      });
      return;
    }
    await sendToAgent(hostId, conv.id, prompt, files);
  };

  const addFiles = (files) => {
    const MAX_MB = 200;   // 与主进程 MAX_ATTACHMENT_BYTES 保持一致
    const limit = MAX_MB * 1024 * 1024;
    const next = files.filter((file) => file.path && file.size <= limit);
    const oversized = files.find((file) => file.size > limit);
    setAttachmentError(oversized
      ? `${oversized.name} 超过 ${MAX_MB} MB 上限(实际 ${Math.round(oversized.size / 1024 / 1024)} MB)`
      : '');
    setPendingFiles((current) => {
      const known = new Set(current.map((file) => file.path));
      return [...current, ...next.filter((file) => !known.has(file.path))];
    });
    // 图片附件:异步生成缩略图供发送前预览
    for (const file of next) {
      if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '')) {
        window.api.files.imageThumb(file.path).then((thumb) => {
          if (thumb) setPendingFiles((items) =>
            items.map((it) => (it.path === file.path ? { ...it, thumb } : it)));
        }).catch(() => {});
      }
    }
  };

  const pickFiles = async () => addFiles(await window.api.dialog.pickFiles());

  /* ---- 历史输入回溯(↑/↓,类似终端):最近发送的在前,连续重复只留一条 ---- */
  const promptHistory = useMemo(() => buildPromptHistory(conv.messages), [conv.messages]);
  // index=null 表示正在编辑草稿;0 为最近一条,越大越早
  const historyRef = useRef({ index: null, draft: '' });
  const inputRef = useRef(null);

  /** step: +1 更早,-1 更新;返回是否消费了这次按键 */
  const recallHistory = (step) => {
    const result = stepPromptHistory(historyRef.current, promptHistory, step, input);
    if (!result.handled) return false;
    historyRef.current = { index: result.index, draft: result.draft };
    setInput(result.value);
    // 光标移到末尾(等 React 应用完新值)
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
    return true;
  };
  const resetHistoryNav = () => { historyRef.current.index = null; };

  // 语音输入:转写结果追加到输入框
  const voice = useVoiceInput((text) => setInput((cur) => (cur ? `${cur} ${text}` : text)));

  // 区域截图:按钮触发 + 全局快捷键回填,统一作为附件加入
  const captureScreenshot = async () => {
    const shot = await window.api.screenshot.capture().catch(() => null);
    if (shot) addFiles([shot]);
  };
  useEffect(() => {
    const off = window.api.screenshot.onCaptured((shot) => { if (shot) addFiles([shot]); });
    return off;
    // eslint-disable-next-line
  }, []);

  /** 粘贴/按钮:把剪贴板中的截图落盘为 PNG 并加入附件 */
  const attachClipboardImage = async () => {
    const img = await window.api.clipboard.saveImage().catch(() => null);
    if (img) { addFiles([img]); return true; }
    return false;
  };
  /**
   * 粘贴:同时支持三种来源
   *  1) 从访达/资源管理器复制的真实文件(有磁盘路径)
   *  2) 截图等剪贴板图片数据(无路径,需先落盘)
   *  3) 普通文本(交给输入框默认行为)
   */
  const onPaste = (event) => {
    const dt = event.clipboardData;
    if (!dt) return;

    // 1) 真实文件:用与拖拽同一套路径解析
    const pasted = [...(dt.files || [])];
    if (pasted.length) {
      const resolved = pasted.map((file) => {
        // 内存中的文件(截图数据)拿不到磁盘路径,getPathForFile 可能返回空或抛错
        let path = '';
        try { path = window.api.dialog.pathForDroppedFile(file) || ''; } catch (_) { path = ''; }
        return { file, path, name: file.name, size: file.size };
      });
      const withPath = resolved.filter((r) => r.path);
      if (withPath.length) {
        event.preventDefault();
        addFiles(withPath.map(({ path, name, size }) => ({ path, name, size })));
        return;
      }
      // 拿不到路径的多半是内存里的图片数据(如截图),走落盘那条路
      if (resolved.some((r) => r.file.type?.startsWith('image/'))) {
        event.preventDefault();
        attachClipboardImage();
        return;
      }
    }

    // 2) 没有 files 但有图片数据(部分应用只提供 items)
    const items = [...(dt.items || [])];
    if (items.some((it) => it.type?.startsWith('image/'))) {
      event.preventDefault();
      attachClipboardImage();
    }
    // 3) 其余情况保持默认粘贴行为
  };
  const dropFiles = (event) => {
    event.preventDefault();
    setDragActive(false);
    addFiles([...event.dataTransfer.files].map((file) => ({
      path: window.api.dialog.pathForDroppedFile(file),
      name: file.name,
      size: file.size
    })));
  };

  const queued = useStore((s) => s.queued[conv.id] || EMPTY_QUEUE);
  const cancel = () => {
    useStore.getState().clearQueued(conv.id); // 手动停止时同时清空排队
    window.api.agent.cancel({ hostId, convId: conv.id });
  };

  const changePermissionMode = (nextMode) => {
    if (nextMode === 'system' && !window.confirm(
      '启用系统权限将允许此对话访问 Docker 和远程主机级命令。命令可修改工作目录之外的文件和服务。是否继续？'
    )) return;
    setStarted(false);
    updateConversationPermission(conv.id, nextMode);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <button className="btn small ghost" onClick={() => setActiveConv(hostId, null)}>← 记录</button>
        <select className={`agent-select ${conv.agent}`} value={conv.agent} disabled={running}
          title="切换引擎(同一对话内共用上下文,切换后首条消息自动携带对话摘要)"
          onChange={(e) => { setStarted(false); updateConversationAgent(conv.id, e.target.value); }}>
          <option value="codex">⬡ Codex</option>
          <option value="claude">✳ Claude Code</option>
          <option value="deepseek">◈ DeepSeek</option>
          <option value="dsh">▣ DeepSeek Harness</option>
        </select>
        {/* 就在干活的地方看到引擎是否可用,并原地安装/下发认证,不用切页 */}
        <EngineStatus hostId={hostId} engine={conv.agent} />
        <b className="conv-title">{conv.title}</b>
        <span className="muted small">{conv.cwd || '~'}</span>
        <ModelPicker
          agent={conv.agent}
          value={conv.model || ''}
          disabled={running}
          onChange={(m) => { setStarted(false); updateConversationModel(conv.id, m); }}
        />
        {conv.usage && (conv.usage.inputTokens > 0 || conv.usage.outputTokens > 0) && (
          <span className="usage-badge muted small"
            title={`累计输入 ${conv.usage.inputTokens.toLocaleString()} / 输出 ${conv.usage.outputTokens.toLocaleString()} tokens${conv.usage.costUsd ? ` · 费用 $${conv.usage.costUsd.toFixed(4)}` : ''}`}>
            Σ {formatTokens(conv.usage.inputTokens + conv.usage.outputTokens)}
            {conv.usage.costUsd > 0 && ` · $${conv.usage.costUsd.toFixed(2)}`}
          </span>
        )}
        <button className="icon-btn" title="存入 Obsidian 知识库(提炼成原子笔记 + 双链)"
          disabled={running}
          onClick={async () => {
            const note = (t) => useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text: t, ts: Date.now() });
            const cfg = await window.api.obsidian.getConfig().catch(() => null);
            if (!cfg || (cfg.transport === 'file' && !cfg.vaultPath)) {
              note('请先到「设置 → Obsidian 知识库」选择 vault 目录。');
              return;
            }
            note('🧠 正在提炼知识笔记…');
            try {
              const r = await window.api.obsidian.saveFromConversation({
                hostId, agent: conv.agent, cwd: conv.cwd, model: conv.model,
                content: conversationToMarkdown(conv), topic: conv.title
              });
              note(`🧠 已写入 ${r.count} 篇笔记到 ${r.folder}/,并更新索引「${r.mocName}」。打开 Obsidian 即可看到图谱。`);
            } catch (e) { note(`❌ 存入知识库失败:${e?.message || e}`); }
          }}>🧠</button>
        <button className="icon-btn" title="导出对话为 Markdown"
          onClick={async () => {
            const r = await window.api.files.saveText({
              defaultName: `${conv.title || '对话'}.md`,
              content: conversationToMarkdown(conv)
            }).catch(() => null);
            if (r?.saved) useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text: `已导出到 ${r.path}`, ts: Date.now() });
          }}>⇩</button>
        {permissionMode === 'system' && <span className="badge system-mode">系统权限</span>}
        <label className="permission-switch auto-switch"
          title="全自动:模型请求确认时自动回复「确认,继续」,并提示模型自行决策;连续 5 次后暂停防失控">
          <input
            type="checkbox"
            checked={!!conv.autoConfirm}
            onChange={(e) => useStore.getState().updateConversationAutoConfirm(conv.id, e.target.checked)}
          />
          <span>全自动</span>
        </label>
        <label className="permission-switch" title="允许此对话使用 Docker 和主机级命令">
          <input
            type="checkbox"
            checked={permissionMode === 'system'}
            disabled={running}
            onChange={(e) => changePermissionMode(e.target.checked ? 'system' : 'workspace')}
          />
          <span>System Mode</span>
        </label>
      </div>
      <GoalBar conv={conv} />
      <div className="chat-list" ref={listRef}>
        {conv.messages.length === 0 && (
          <div className="muted center pad">向{hostId === 'local' ? '本机' : '远程'}的 {conv.agent === 'codex' ? 'Codex' : 'Claude Code'} 发出第一条指令吧</div>
        )}
        {conv.messages.length > visibleCount && (
          <button className="btn small ghost load-earlier"
            onClick={() => setVisibleCount((n) => n + 200)}>
            ↑ 加载更早的 {Math.min(200, conv.messages.length - visibleCount)} 条(共 {conv.messages.length} 条)
          </button>
        )}
        {conv.messages.slice(-visibleCount).map((m, i, arr) => {
          const realIndex = conv.messages.length - arr.length + i;
          return (
            <Message key={`${m.ts || 0}_${realIndex}`} m={m} hostId={hostId} convId={conv.id}
              onEnableSystemMode={() => changePermissionMode('system')}
              isLast={realIndex === conv.messages.length - 1}
              running={running}
              onQuickReply={(t) => send(t)}
              onFileLink={(p) => setFilePreview({ path: p, name: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() })} />
          );
        })}
        {running && <div className="typing"><span /><span /><span /> {hostId === 'local' ? '本地' : '远程'}执行中...</div>}
        {queued.length > 0 && (
          <div className="queue-list">
            {queued.map((q, i) => (
              <div className="queue-item" key={q.id}>
                <span className="chip">⏳ 排队 {i + 1}</span>
                <span className="queue-text">{q.text.slice(0, 80)}</span>
                <button className="icon-btn" title="移出队列"
                  onClick={() => useStore.getState().removeQueued(conv.id, q.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={`chat-input ${dragActive ? 'drag-active' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragActive(false); }}
        onDrop={dropFiles}>
        {pendingFiles.length > 0 && (
          <div className="attachment-queue">
            {pendingFiles.map((file) => file.thumb ? (
              <span className="attachment-thumb-wrap" key={file.path} title={`${file.name}(${(file.size / 1024).toFixed(0)} KB)`}>
                <img className="attachment-thumb" src={file.thumb} alt={file.name} />
                <button type="button" className="attachment-thumb-remove" title="移除"
                  onClick={() => setPendingFiles((items) => items.filter((item) => item.path !== file.path))}>×</button>
              </span>
            ) : (
              <span className="attachment-chip" key={file.path} title={file.path}>
                <span className="attachment-name">{file.name}</span>
                <button type="button" title="Remove attachment" onClick={() => setPendingFiles((items) => items.filter((item) => item.path !== file.path))}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        {dragActive && <div className="drop-hint">Drop files to attach</div>}
        <SlashMenu input={input} index={slashIndex}
          onPick={(c) => { setInput(applyCompletion(c)); setSlashIndex(0); inputRef.current?.focus(); }} />
        <button className="btn attach-button" type="button" onClick={pickFiles} disabled={running} title="Add attachments">附件</button>
        <button className="btn attach-button" type="button" onClick={captureScreenshot}
          title="区域截图(默认快捷键 ⌘/Ctrl+Shift+2)">✂ 截图</button>
        <button className={`btn attach-button mic-button ${voice.state}`} type="button"
          onClick={voice.toggle} disabled={voice.state === 'transcribing'}
          title={voice.state === 'recording' ? '点击停止并转写' : (voice.state === 'transcribing' ? '转写中…' : '语音输入(需在设置里配置转写端点)')}>
          {voice.state === 'recording' ? '● 录音中' : voice.state === 'transcribing' ? '转写中…' : '🎤 语音'}
        </button>
        {voice.error && <span className="voice-error" title={voice.error}>{voice.error}</span>}
        <textarea
          autoFocus
          ref={inputRef}
          value={input}
          placeholder={started ? '输入指令,Enter 发送,↑↓ 调历史,⌘V 粘贴截图/文件,🎤 语音,Shift+Enter 换行' : '正在初始化会话...'}
          onChange={(e) => { setInput(e.target.value); resetHistoryNav(); }}
          onPaste={onPaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || composingRef.current;
            // 斜杠命令菜单:↑↓ 选择,Tab/Enter 补全,Esc 关闭
            const cmds = matchCommands(input);
            if (cmds.length && !composing) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % cmds.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + cmds.length) % cmds.length); return; }
              if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                const picked = cmds[Math.min(slashIndex, cmds.length - 1)];
                // 无参数命令按 Enter 直接执行,有参数的先补全等你填
                if (e.key === 'Tab' || picked.args) {
                  e.preventDefault();
                  setInput(applyCompletion(picked));
                  setSlashIndex(0);
                  return;
                }
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !composing) {
              e.preventDefault();
              send();
              return;
            }
            // ↑/↓ 调历史:仅当光标在首行/末行时接管,避免打断多行编辑与输入法候选
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !composing) {
              const el = e.currentTarget;
              const collapsed = el.selectionStart === el.selectionEnd;
              const onFirstLine = collapsed && !el.value.slice(0, el.selectionStart).includes('\n');
              const onLastLine = collapsed && !el.value.slice(el.selectionEnd).includes('\n');
              if (e.key === 'ArrowUp' && onFirstLine && recallHistory(1)) e.preventDefault();
              else if (e.key === 'ArrowDown' && onLastLine && recallHistory(-1)) e.preventDefault();
            }
          }}
        />
        {running && <button className="btn danger" onClick={cancel}>停止</button>}
        <button className="btn primary" onClick={() => send()}
          disabled={!input.trim() && pendingFiles.length === 0}
          title={running ? '当前轮结束后自动发送' : ''}>
          {running || !started ? '排队发送' : '发送'}
        </button>
      </div>
      {filePreview && (
        <FilePreview hostId={hostId} filePath={filePreview.path} name={filePreview.name}
          onClose={() => setFilePreview(null)} />
      )}
    </div>
  );
}

/* 模型选择器:预设 + 自定义输入,留空表示跟随 CLI 自身配置(~/.codex/config.toml 等)
 * deepseek 留空时后端默认 deepseek-v4-pro[1m] */
const MODEL_PRESETS = {
  codex: ['gpt-5.6-terra', 'gpt-5-codex', 'gpt-5'],
  claude: ['sonnet', 'opus', 'haiku'],
  deepseek: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
  // dsh 没有 --model 开关:模型由它自己的 profile 配置决定,这里给不出可选项
  dsh: []
};
const AGENT_NAMES = {
  codex: '⬡ Codex', claude: '✳ Claude Code',
  deepseek: '◈ DeepSeek', dsh: '▣ DeepSeek Harness'
};
const AGENT_BADGES = { codex: 'Codex', claude: 'Claude', deepseek: 'DeepSeek', dsh: 'dsh' };
/* deepseek 基于 claude CLI 运行;dsh 是 DeepSeek 官方 harness,自带 dsh 二进制 */
const agentCliInstalled = (env, agent) => {
  if (agent === 'codex') return env?.codex;
  if (agent === 'dsh') return env?.dsh;
  return env?.claude;
};
const CUSTOM_MODEL = '__custom__';
const EMPTY_QUEUE = []; // 稳定引用:避免 selector 每次返回新数组导致无限重渲染

function ModelPicker({ agent, value, disabled, onChange }) {
  const presets = (MODEL_PRESETS[agent] || []).map((m) => ({ value: m, label: m }));
  const presetValues = presets.map((p) => p.value);
  const isPreset = value === '' || presetValues.includes(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onChange(next);
  };

  if (editing || !isPreset) {
    return (
      <span className="model-picker" title="自定义模型名,回车确认">
        <input
          className="model-input"
          value={editing ? draft : value}
          autoFocus={editing}
          disabled={disabled}
          placeholder="模型名"
          onFocus={() => { setDraft(value); setEditing(true); }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setDraft(value); setEditing(false); }
          }}
          onBlur={commit}
        />
        <button className="btn small ghost" type="button" disabled={disabled}
          title="回到预设列表" onClick={() => { setEditing(false); onChange(''); }}>预设</button>
      </span>
    );
  }

  return (
    <select
      className="model-select"
      value={value}
      disabled={disabled}
      title="切换模型(立即生效,上下文保留)"
      onChange={(e) => {
        if (e.target.value === CUSTOM_MODEL) { setDraft(value); setEditing(true); return; }
        onChange(e.target.value);
      }}>
      <option value="">{
        agent === 'deepseek' ? '默认(deepseek-v4-pro[1m])' :
        agent === 'dsh' ? '由 dsh profile 决定(此处选择无效)' : '默认模型(跟随 CLI 配置)'}</option>
      {presets.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      <option value={CUSTOM_MODEL}>自定义…</option>
    </select>
  );
}

/* 斜杠命令补全菜单 */
function SlashMenu({ input, index, onPick }) {
  const cmds = matchCommands(input);
  if (!cmds.length) return null;
  return (
    <div className="slash-menu">
      {cmds.map((c, i) => (
        <div key={c.name} className={`slash-item ${i === Math.min(index, cmds.length - 1) ? 'active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(c); }}>
          <span className="slash-name">/{c.name}</span>
          {c.args && <span className="slash-args">{c.args}</span>}
          <span className="slash-desc muted small">{c.desc}</span>
        </div>
      ))}
      <div className="slash-hint muted small">↑↓ 选择 · Tab 补全 · Esc 关闭</div>
    </div>
  );
}

/* 目标模式状态条:显示目标与进度,可暂停/继续/清除 */
function GoalBar({ conv }) {
  const goal = conv.goal;
  if (!goal?.text) return null;
  // 已达成的目标不再显示 —— 它不会推进了。
  // 新流程会在达成时直接清空,这里兜住历史对话里已存的 done 目标。
  if (goal.status === 'done') return null;
  const st = useStore.getState();
  // 核验中要单独标出来,否则用户看到「推进中」不知道它正在自查而不是在干活
  const label = goal.verifying && goal.status === 'active'
    ? '核验中'
    : ({ active: '推进中', paused: '已暂停', done: '已达成' }[goal.status] || goal.status);
  return (
    <div className={`goal-bar ${goal.status}`}>
      <span className="goal-tag">🎯 目标</span>
      <span className="goal-text" title={goal.text}>{goal.text}</span>
      <span className="muted small">{label} · {goal.rounds || 0}/{goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS} 轮</span>
      <span className="flex1" />
      {goal.status === 'active' && (
        <button className="btn small ghost"
          onClick={() => st.updateConversationGoal(conv.id, { status: 'paused' })}>暂停</button>
      )}
      {goal.status !== 'active' && (
        <button className="btn small"
          title="触顶暂停时会自动追加轮次预算,否则跑一轮又会立刻停下"
          onClick={() => {
            st.updateConversationGoal(conv.id, resumeGoalPatch(goal));
            sendToAgent(conv.hostId, conv.id, buildContinuePrompt(goal), [], { auto: true });
          }}>
          {(goal.rounds || 0) >= (goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS)
            ? `继续(+${GOAL_EXTEND_ROUNDS} 轮)` : '继续'}
        </button>
      )}
      <button className="btn small ghost" onClick={() => st.setConversationGoal(conv.id, null)}>清除</button>
    </div>
  );
}

/* 语音确认/选择:录音转写后按关键词匹配「确认/取消/选项号」并触发对应按钮 */
function VoiceReplyButton({ mode, options, onReply }) {
  const [hint, setHint] = useState('');
  const voice = useVoiceInput(async (text) => {
    const value = await window.api.voice.interpret({ transcript: text, ctx: { mode, options } }).catch(() => null);
    if (value != null) { setHint(''); onReply(value); }
    else setHint(`没听懂「${text.slice(0, 20)}」`);
  });
  return (
    <span className="voice-reply-wrap">
      <button className={`btn small quick-reply mic-button ${voice.state}`} type="button"
        onClick={voice.toggle} disabled={voice.state === 'transcribing'}
        title={mode === 'confirm' ? '语音说「确认 / 取消」' : '语音说选项号或名称'}>
        {voice.state === 'recording' ? '● 说话中' : voice.state === 'transcribing' ? '识别中…' : '🎤 语音'}
      </button>
      {(hint || voice.error) && <span className="voice-error">{hint || voice.error}</span>}
    </span>
  );
}

function Message({ m, hostId, convId, onEnableSystemMode, isLast, running, onQuickReply, onFileLink }) {
  const [open, setOpen] = useState(false);
  if (m.role === 'user')
    return (
      <div className="msg user">
        <pre>{m.text}</pre>
        {m.attachments?.length > 0 && (
          <div className="message-attachments">
            {m.attachments.map((file) => file.kind === 'image'
              ? <ImagePreview key={file.remotePath} hostId={hostId} convId={convId} remotePath={file.remotePath} name={file.originalName || file.name} compact />
              : <span className="message-file" key={file.remotePath}>{file.originalName || file.name}</span>)}
          </div>
        )}
      </div>
    );

  switch (m.kind) {
    case 'text':
    case 'result': {
      const opts = (isLast && !running && onQuickReply) ? extractOptions(m.text) : [];
      const asksConfirm = isLast && !running && onQuickReply && !opts.length &&
        isAwaitingConfirm(m.text);
      return (
        <div className="msg agent">
          <Markdown text={m.text} onFileLink={onFileLink} />
          {m.kind === 'result' && m.costUsd != null && (
            <div className="msg-meta">${m.costUsd?.toFixed(4)} · {(m.durationMs / 1000).toFixed(1)}s</div>
          )}
          {opts.length > 0 && (
            <div className="quick-replies">
              {opts.map((o) => (
                <button key={o.n} className="btn small quick-reply"
                  onClick={() => onQuickReply(o.n)}>{o.n}. {o.label}</button>
              ))}
              <VoiceReplyButton mode="options" options={opts} onReply={onQuickReply} />
            </div>
          )}
          {asksConfirm && (
            <div className="quick-replies">
              <button className="btn small quick-reply" onClick={() => onQuickReply('确认')}>✅ 确认</button>
              <button className="btn small quick-reply" onClick={() => onQuickReply('取消')}>✕ 取消</button>
              <VoiceReplyButton mode="confirm" onReply={onQuickReply} />
            </div>
          )}
        </div>
      );
    }
    case 'reasoning':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">🧠 思考 {open ? '▾' : '▸'}</span>
          {open && <pre className="dim">{m.text}</pre>}
        </div>
      );
    case 'tool':
      return (
        <div className={`msg thin ${m.dangerous ? 'tool-dangerous' : ''}`}>
          <span className={`chip tool ${m.dangerous ? 'danger' : ''}`}>{m.dangerous ? '⚠️' : '🔧'} {m.name}</span>
          {m.dangerous && <span className="danger-tag">危险操作</span>}
          {m.detail && <code className="tool-detail">{String(m.detail).slice(0, 200)}</code>}
          {m.diff && <EditDiff diff={m.diff} />}
        </div>
      );
    case 'diff':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">± 本轮文件改动 {open ? '▾' : '▸'}</span>
          {open && <DiffView text={m.text} />}
        </div>
      );
    case 'tool_output':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">📄 输出 {open ? '▾' : '▸'}</span>
          {open && <pre className="dim">{m.output}</pre>}
        </div>
      );
    case 'error':
      return <div className="msg error-msg"><pre>{m.text}</pre></div>;
    case 'stderr':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">⚠ stderr {open ? '▾' : '▸'}</span>
          {open && <pre className="dim">{m.text}</pre>}
        </div>
      );
    case 'permission_hint':
      return (
        <div className="msg permission-hint">
          <pre>{m.text}</pre>
          <button className="btn small permission-hint-action" onClick={onEnableSystemMode}>Enable System Mode</button>
        </div>
      );
    case 'image':
      return <ImagePreview hostId={hostId} convId={convId} remotePath={m.remotePath} name={m.name} />;
    default:
      return <div className="msg thin"><pre className="dim">{m.text || JSON.stringify(m)}</pre></div>;
  }
}

function ImagePreview({ hostId, convId, remotePath, name, compact = false }) {
  const [image, setImage] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setImage(null);
    setError('');
    window.api.attachments.resolveImage({ hostId, convId, remotePath })
      .then((result) => { if (active) setImage(result); })
      .catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [hostId, convId, remotePath, attempt]);

  if (error) return (
    <div className="image-error">
      <span>{name || '图片'} 加载失败</span>
      <button className="btn small" onClick={() => setAttempt((value) => value + 1)}>重试</button>
    </div>
  );
  if (!image) return <div className="image-loading">图片加载中...</div>;
  const label = name || image.name;
  return (
    <>
      <div className="image-block">
        <button className={`image-preview ${compact ? 'compact' : ''}`} onClick={() => setOpen(true)} title="查看大图">
          <img src={image.src} alt={label} />
          <span>{label}</span>
        </button>
        {/* 悬停才出现,免得挡住图 */}
        <div className="image-tools">
          <ImageActions image={image} name={label} />
        </div>
      </div>
      {open && (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <button className="lightbox-close" title="关闭" onClick={() => setOpen(false)}>×</button>
          <img src={image.src} alt={label} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span>{label}</span>
            <ImageActions image={image} name={label} />
          </div>
        </div>
      )}
    </>
  );
}

/** 图片操作:复制到剪贴板 / 另存为。两处(缩略图与大图)共用 */
function ImageActions({ image, name }) {
  const [hint, setHint] = useState('');
  const flash = (t) => { setHint(t); setTimeout(() => setHint(''), 1500); };

  const copy = async (e) => {
    e.stopPropagation();
    try { await window.api.clipboard.writeImage(image.src); flash('已复制'); }
    catch (err) { flash(`失败:${err.message}`); }
  };
  const saveAs = async (e) => {
    e.stopPropagation();
    try {
      const r = await window.api.clipboard.saveImageAs({ dataUrl: image.src, name });
      if (r?.saved) flash('已保存');
    } catch (err) { flash(`失败:${err.message}`); }
  };

  return (
    <>
      <button className="btn tiny ghost" onClick={copy} title="复制图片,可直接粘贴到别处">复制</button>
      <button className="btn tiny ghost" onClick={saveAs} title="另存为文件">保存</button>
      {hint && <span className="muted small">{hint}</span>}
    </>
  );
}

/* 远程目录下拉选择器 */
function RemoteDirPicker({ hostId, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(null);
  const [err, setErr] = useState('');

  const load = async (p) => {
    setErr('');
    try {
      const d = await window.api.files.listRemote({ hostId, dirPath: p || '~' });
      setDir({ path: d.path, entries: d.entries.filter((e) => e.isDir || e.isLink) });
    } catch (e) { setErr(e.message); }
  };
  const toggle = () => { if (!open) load('~'); setOpen(!open); };
  const parent = () => {
    const parts = (dir?.path || '/').split('/').filter(Boolean);
    parts.pop();
    load('/' + parts.join('/'));
  };

  return (
    <div className="dir-picker-wrap">
      <div className="row" style={{ gap: 8 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="~/my-project(留空为 HOME)" />
        <button className="btn" type="button" onClick={toggle}>{open ? '收起' : '浏览'}</button>
      </div>
      {open && (
        <div className="dir-picker">
          <div className="dir-picker-head">
            <span className="muted small" title={dir?.path}>{dir?.path || '...'}</span>
            <span className="flex1" />
            <button className="btn small" type="button" onClick={parent}>上级</button>
            <button className="btn small primary" type="button"
              onClick={() => { onChange(dir?.path || ''); setOpen(false); }}>选用此目录</button>
          </div>
          {err && <p className="error-text">{err}</p>}
          <div className="dir-picker-list">
            {(dir?.entries || []).map((e) => (
              <div key={e.name} className="file-row"
                onClick={() => load(`${dir.path}/${e.name}`.replace(/\/+/g, '/'))}>
                <span className="fname">📁 {e.name}</span>
              </div>
            ))}
            {dir && dir.entries.length === 0 && <div className="muted small pad">无子目录</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionSetup({ hostId, onCancel }) {
  const env = useStore((s) => s.envInfo[hostId]);
  const createConversation = useStore((s) => s.createConversation);
  const [agent, setAgent] = useState('codex');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState(
    () => useStore.getState().settings.defaultPermissionMode || 'workspace');

  useEffect(() => {
    window.api.setup.detect(hostId)
      .then((info) => useStore.getState().setEnvInfo(hostId, info))
      .catch(() => {});
  }, [hostId]);

  const installed = env && agentCliInstalled(env, agent);

  const start = () => {
    if (permissionMode === 'system' && !window.confirm(
      '系统权限允许 Docker 和主机级命令，并可修改工作目录之外的文件或服务。是否继续？'
    )) return;
    createConversation(hostId, { agent, cwd: cwd.trim(), model: model.trim(), permissionMode, title: title.trim() });
  };

  return (
    <div className="form-page">
      <div className="row">
        <h2 className="flex1">新建对话</h2>
        {onCancel && <button className="btn ghost" onClick={onCancel}>取消</button>}
      </div>
      <div className="agent-cards">
        {['codex', 'claude', 'deepseek', 'dsh'].map((a) => (
          <div key={a} className={`agent-card ${agent === a ? 'selected' : ''}`} onClick={() => setAgent(a)}>
            <div className="agent-name">{AGENT_NAMES[a]}</div>
            <div className="muted small">
              {env == null ? '检测中...' :
                agentCliInstalled(env, a) ? `已安装 ${agentCliInstalled(env, a)}` : '未安装'}
            </div>
            {a === 'deepseek' && <div className="muted small">deepseek-v4 · 基于 Claude Code CLI</div>}
            {a === 'dsh' && <div className="muted small">DeepSeek 官方 harness · 无流式/无多轮 resume</div>}
          </div>
        ))}
      </div>
      {env && !installed && (
        <p className="error-text">
          {hostId === 'local' ? '本机' : '远程'}未检测到 {
            agent === 'deepseek' ? 'claude(DeepSeek 基于 Claude Code CLI 运行)' :
            agent === 'dsh' ? 'dsh(DeepSeek Harness)' : agent
          },请先到「环境配置」页{hostId === 'local' ? '检查(本机请直接在终端安装)' : '一键安装'}。
          <button className="btn small" onClick={() => useStore.getState().setTab('setup')}>去检查</button>
        </p>
      )}
      <div className="form-grid">
        <label>对话名称(可选)<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空则用目录名" /></label>
        <label>工作目录({hostId === 'local' ? '本机' : '远程'})
          <RemoteDirPicker hostId={hostId} value={cwd} onChange={setCwd} />
        </label>
        <label>模型(可选)<input value={model} onChange={(e) => setModel(e.target.value)} placeholder={
          agent === 'codex' ? '如 gpt-5-codex' :
          agent === 'deepseek' ? '默认 deepseek-v4-pro[1m]' :
          agent === 'dsh' ? '(dsh 不支持指定模型)' : '如 sonnet / opus'} /></label>
        <div className="system-mode-setting">
          <label className="row checkbox">
            <input
              type="checkbox"
              checked={permissionMode === 'system'}
              onChange={(e) => setPermissionMode(e.target.checked ? 'system' : 'workspace')}
            />
            System Mode
          </label>
          <p className="system-mode-notice">系统权限允许 Docker 与远程主机级命令，可能修改工作目录之外的文件或服务。</p>
        </div>
      </div>
      <button className="btn primary" onClick={start} disabled={env && !installed}>开始对话</button>
    </div>
  );
}
