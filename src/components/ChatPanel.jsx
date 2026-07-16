import React, { useState, useRef, useEffect } from 'react';
import { useStore, sendToAgent, isAwaitingConfirm, TASK_TEMPLATES } from '../store.js';
import FilePreview from './FilePreview.jsx';
import Markdown from './Markdown.jsx';
import { translate as tr } from '../i18n.mjs';

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

const RISK_LABELS = { read: '只读', workspace_write: '项目写入', external_side_effect: '外部影响', system: '系统级' };

/* 从消息文本中提取「1. xxx / 2. xxx」式选项(序号从 1 连续才算) */
function extractOptions(text = '') {
  const opts = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d{1,2})[.)、::]\s*(.+)$/);
    if (m) opts.push({ n: m[1], label: m[2].trim().slice(0, 50) });
  }
  if (opts.length >= 2 && opts[0].n === '1') return opts.slice(0, 8);
  return [];
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
  const language = useStore((s) => s.settings.language);
  const t = (key) => tr(language, key);
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
        <h2>{t('conversationHistory')}</h2>
        <input className="conv-search" value={query} placeholder={t('searchConversations')}
          onChange={(e) => setQuery(e.target.value)} />
        <button className="btn primary" onClick={() => setCreating(true)}>+ {t('newConversation')}</button>
      </div>
      {list.length === 0 ? (
        <div className="muted center pad">{q ? t('noMatchingConversations') : t('noConversations')}</div>
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
  const language = useStore((s) => s.settings.language);
  const t = (key) => tr(language, key);
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
        <span className={`badge ${conv.agent}`}>{conv.agent === 'codex' ? 'Codex' : 'Claude'}</span>
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
        <button className="icon-btn" title={t('rename')}
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
      {last && <div className="conv-card-last muted small">{t('recent')}: {last.text.slice(0, 60)}</div>}
      <div className="conv-card-meta muted small">{conv.messages.length} {t('messages')} · {when}</div>
    </div>
  );
}

/* ---------------- 单个对话视图 ---------------- */
function ChatView({ hostId, conv }) {
  const running = useStore((s) => s.agentRunning[conv.id] || false);
  const executionTrace = useStore((s) => s.executionTraces[conv.id]);
  const setActiveConv = useStore((s) => s.setActiveConv);
  const updateConversationPermission = useStore((s) => s.updateConversationPermission);
  const updateConversationModel = useStore((s) => s.updateConversationModel);
  const updateConversationAgent = useStore((s) => s.updateConversationAgent);
  const tasks = useStore((s) => s.tasks);
  const [input, setInput] = useState('');
  const [started, setStarted] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const listRef = useRef(null);
  const composingRef = useRef(false);
  const [filePreview, setFilePreview] = useState(null); // {path, name}
  const [visibleCount, setVisibleCount] = useState(200); // 长对话窗口化渲染
  const [taskTemplate, setTaskTemplate] = useState('implementation');
  const [watchMode, setWatchMode] = useState(false);
  const permissionMode = conv.permissionMode || (conv.autoApprove ? 'system' : 'workspace');
  const task = Object.values(tasks).find((item) => item.convId === conv.id && item.status !== 'archived');
  const createTask = () => useStore.getState().createTask(hostId, conv.id, { title: conv.title, templateId: taskTemplate, cwd: conv.cwd, projectContext: conv.projectContext });

  // 进入对话/切换模型或权限时,在主进程(重新)初始化 agent 会话(带 resume 状态续聊)
  useEffect(() => {
    window.api.agent.start({
      hostId, convId: conv.id,
      opts: { agent: conv.agent, cwd: conv.cwd, model: conv.model, permissionMode },
      resume: { claudeSessionId: conv.claudeSessionId, codexSessionId: conv.codexSessionId, codexStarted: conv.codexStarted }
    }).then(() => setStarted(true)).catch(() => setStarted(true));
    // eslint-disable-next-line
  }, [conv.id, permissionMode, conv.model, conv.agent]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [conv.messages, running]);

  const send = async (textOverride) => {
    const prompt = (textOverride ?? input).trim() ||
      (pendingFiles.length ? 'Please process the attached files.' : '');
    if (!prompt) return;
    setAttachmentError('');
    if (textOverride == null) setInput('');
    const files = textOverride == null ? pendingFiles : [];
    if (textOverride == null) setPendingFiles([]);
    // 正在执行/未初始化 -> 进入排队,本轮结束后自动发送
    if (running || !started) {
      useStore.getState().enqueuePrompt(conv.id, {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: prompt, files, projectContext: conv.projectContext
      });
      return;
    }
    if (task?.status === 'needs_approval') {
      setAttachmentError('任务正在等待权限审批；请先到任务中心处理该请求。');
      return;
    }
    if (task && task.status !== 'running') useStore.getState().updateTaskStatus(task.id, 'running');
    await sendToAgent(hostId, conv.id, prompt, files);
  };

  const addFiles = (files) => {
    const next = files.filter((file) => file.path && file.size <= 20 * 1024 * 1024);
    const oversized = files.find((file) => file.size > 20 * 1024 * 1024);
    setAttachmentError(oversized ? `${oversized.name} exceeds 20 MB` : '');
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

  /** 粘贴/按钮:把剪贴板中的截图落盘为 PNG 并加入附件 */
  const attachClipboardImage = async () => {
    const img = await window.api.clipboard.saveImage().catch(() => null);
    if (img) { addFiles([img]); return true; }
    return false;
  };
  const onPaste = (event) => {
    const items = [...(event.clipboardData?.items || [])];
    if (items.some((it) => it.type?.startsWith('image/'))) {
      event.preventDefault(); // 是图片就不当文本粘贴
      attachClipboardImage();
    }
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
    if (nextMode === 'system' && task) {
      const approval = useStore.getState().createTaskApproval(task.id, {
        scope: 'system',
        reason: '允许 Docker、主机级命令及工作目录外的文件或服务变更'
      });
      if (approval) useStore.getState().updateTaskStatus(task.id, 'needs_approval');
      return;
    }
    if (nextMode === 'system' && !window.confirm(
      '启用系统权限将允许此对话访问 Docker 和远程主机级命令。命令可修改工作目录之外的文件和服务。是否继续？'
    )) return;
    if (task) useStore.getState().recordTaskDelivery(task.id, {
      auditEvents: [{
        type: 'permission_change',
        level: nextMode === 'system' ? 'system' : 'workspace_write',
        detail: `权限模式：${permissionMode === 'system' ? '系统权限' : '工作区'} → ${nextMode === 'system' ? '系统权限' : '工作区'}`,
        ts: Date.now()
      }]
    });
    setStarted(false);
    updateConversationPermission(conv.id, nextMode);
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <button className="btn small ghost" onClick={() => setActiveConv(hostId, null)}>← 记录</button>
        {!task && <><select className="agent-select" value={taskTemplate} onChange={(e) => setTaskTemplate(e.target.value)} title="选择任务模板">
          {TASK_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}
        </select><button className="btn small ghost" onClick={createTask}>+ 任务</button></>}
        <select className={`agent-select ${conv.agent}`} value={conv.agent} disabled={running}
          title="切换引擎(同一对话内共用上下文,切换后首条消息自动携带对话摘要)"
          onChange={(e) => { setStarted(false); updateConversationAgent(conv.id, e.target.value); }}>
          <option value="codex">⬡ Codex</option>
          <option value="claude">✳ Claude Code</option>
        </select>
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
        <button className="icon-btn" title="导出对话为 Markdown"
          onClick={async () => {
            const r = await window.api.files.saveText({
              defaultName: `${conv.title || '对话'}.md`,
              content: conversationToMarkdown(conv)
            }).catch(() => null);
            if (r?.saved) useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text: `已导出到 ${r.path}`, ts: Date.now() });
          }}>⇩</button>
        {permissionMode === 'system' && <span className="badge system-mode">系统权限</span>}
        {permissionMode === 'plan' && <span className="badge plan-mode">计划模式</span>}
        {permissionMode === 'approval' && <span className="badge plan-mode">审批模式</span>}
        <label className="permission-switch" title="只读监督会禁用本窗口的发送操作；可查看远程 Agent 的流式输出和任务审计">
          <input type="checkbox" checked={watchMode} onChange={(e) => setWatchMode(e.target.checked)} />
          <span>只读监督</span>
        </label>
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
        <label className="permission-switch" title="在工作区沙箱执行；提升到系统权限必须绑定具体任务并在任务页审批">
          <input
            type="checkbox"
            checked={permissionMode === 'approval'}
            disabled={running}
            onChange={(e) => changePermissionMode(e.target.checked ? 'approval' : 'workspace')}
          />
          <span>Approval Mode</span>
        </label>
        <label className="permission-switch" title="只允许分析和制定计划，不允许修改文件或执行会产生副作用的命令">
          <input
            type="checkbox"
            checked={permissionMode === 'plan'}
            disabled={running}
            onChange={(e) => changePermissionMode(e.target.checked ? 'plan' : 'workspace')}
          />
          <span>Plan Mode</span>
        </label>
      </div>
      <div className="chat-list" ref={listRef}>
        {executionTrace && <ExecutionTrace executionTrace={executionTrace} />}
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
        <button className="btn attach-button" type="button" onClick={pickFiles} disabled={running} title="Add attachments">附件</button>
        <textarea
          autoFocus
          value={input}
          disabled={watchMode}
          placeholder={started ? '输入指令,Enter 发送,⌘V 可粘贴截图,Shift+Enter 换行' : '正在初始化会话...'}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composingRef.current) {
              e.preventDefault();
              send();
            }
          }}
        />
        {running && <button className="btn danger" onClick={cancel}>停止</button>}
        <button className="btn primary" onClick={() => send()}
          disabled={watchMode || (!input.trim() && pendingFiles.length === 0)}
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

function ExecutionTrace({ executionTrace }) {
  const [open, setOpen] = useState(true);
  return <div className="execution-trace"><button className="execution-trace-head" onClick={() => setOpen((value) => !value)}>
    <span>◉ 当前后台执行</span><span className="muted small">{executionTrace.status} {open ? '▾' : '▸'}</span>
  </button>{open && <div className="execution-trace-events">
    {executionTrace.events.length === 0 ? <p className="muted small">正在等待 Agent 返回执行事件…</p> : executionTrace.events.map((event, index) => <div key={`${event.ts}_${index}`} className="execution-trace-event">
      <b>{event.name || (event.kind === 'tool_output' ? '命令输出' : event.kind)}</b>{event.riskLevel && <span className={`risk-tag ${event.riskLevel}`}>{RISK_LABELS[event.riskLevel] || event.riskLevel}</span>}
      {event.detail && <code>{String(event.detail).slice(0, 500)}</code>}{event.output && <pre>{event.output}</pre>}
    </div>)}
  </div>}</div>;
}

/* 模型选择器:预设 + 自定义输入,留空表示跟随 CLI 自身配置(~/.codex/config.toml 等) */
const MODEL_PRESETS = {
  codex: ['gpt-5.6-terra', 'gpt-5-codex', 'gpt-5'],
  claude: ['sonnet', 'opus', 'haiku']
};
const CUSTOM_MODEL = '__custom__';
const EMPTY_QUEUE = []; // 稳定引用:避免 selector 每次返回新数组导致无限重渲染

function ModelPicker({ agent, value, disabled, onChange }) {
  const presets = MODEL_PRESETS[agent] || [];
  const isPreset = value === '' || presets.includes(value);
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
      <option value="">默认模型(跟随 CLI 配置)</option>
      {presets.map((m) => <option key={m} value={m}>{m}</option>)}
      <option value={CUSTOM_MODEL}>自定义…</option>
    </select>
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
            </div>
          )}
          {asksConfirm && (
            <div className="quick-replies">
              <button className="btn small quick-reply" onClick={() => onQuickReply('确认')}>✅ 确认</button>
              <button className="btn small quick-reply" onClick={() => onQuickReply('取消')}>✕ 取消</button>
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
          {m.riskLevel && <span className={`risk-tag ${m.riskLevel}`} title="安全级别">{RISK_LABELS[m.riskLevel] || m.riskLevel}</span>}
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
  return (
    <>
      <button className={`image-preview ${compact ? 'compact' : ''}`} onClick={() => setOpen(true)} title="查看大图">
        <img src={image.src} alt={name || image.name} />
        <span>{name || image.name}</span>
      </button>
      {open && (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <button className="lightbox-close" title="关闭" onClick={() => setOpen(false)}>×</button>
          <img src={image.src} alt={name || image.name} onClick={(e) => e.stopPropagation()} />
          <div>{name || image.name}</div>
        </div>
      )}
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
  const projects = useStore((s) => Object.values(s.projects).filter((project) => project.hostId === hostId));
  const createConversation = useStore((s) => s.createConversation);
  const createProject = useStore((s) => s.createProject);
  const [agent, setAgent] = useState('codex');
  const [cwd, setCwd] = useState('');
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectRules, setProjectRules] = useState('');
  const [projectSkills, setProjectSkills] = useState('');
  const [permissionMode, setPermissionMode] = useState(
    () => useStore.getState().settings.defaultPermissionMode || 'workspace');

  useEffect(() => {
    window.api.setup.detect(hostId)
      .then((info) => useStore.getState().setEnvInfo(hostId, info))
      .catch(() => {});
  }, [hostId]);

  const installed = env && (agent === 'codex' ? env.codex : env.claude);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const selectProject = (id) => {
    setSelectedProjectId(id);
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    setCwd(project.cwd); setAgent(project.defaultAgent || 'codex'); setModel(project.defaultModel || '');
    setPermissionMode(project.permissionMode || 'workspace'); setProjectRules(project.rules || ''); setProjectSkills(project.skills || '');
  };
  const saveProjectContext = () => {
    if (!cwd.trim()) return;
    const project = createProject({ id: selectedProjectId || undefined, hostId, cwd: cwd.trim(), name: title.trim(), rules: projectRules.trim(), skills: projectSkills.trim(), defaultAgent: agent, defaultModel: model.trim(), permissionMode });
    setSelectedProjectId(project.id);
  };

  const start = () => {
    if (permissionMode === 'system' && !window.confirm(
      '系统权限允许 Docker 和主机级命令，并可修改工作目录之外的文件或服务。是否继续？'
    )) return;
    const projectContext = selectedProject ? { ...selectedProject, rules: projectRules.trim(), skills: projectSkills.trim() } : null;
    createConversation(hostId, { agent, cwd: cwd.trim(), model: model.trim(), permissionMode, title: title.trim(), projectContext });
  };

  return (
    <div className="form-page">
      <div className="row">
        <h2 className="flex1">新建对话</h2>
        {onCancel && <button className="btn ghost" onClick={onCancel}>取消</button>}
      </div>
      <div className="agent-cards">
        {['codex', 'claude'].map((a) => (
          <div key={a} className={`agent-card ${agent === a ? 'selected' : ''}`} onClick={() => setAgent(a)}>
            <div className="agent-name">{a === 'codex' ? '⬡ Codex' : '✳ Claude Code'}</div>
            <div className="muted small">
              {env == null ? '检测中...' :
                (a === 'codex' ? env.codex : env.claude) ? `已安装 ${a === 'codex' ? env.codex : env.claude}` : '未安装'}
            </div>
          </div>
        ))}
      </div>
      {env && !installed && (
        <p className="error-text">
          {hostId === 'local' ? '本机' : '远程'}未检测到 {agent},请先到「环境配置」页{hostId === 'local' ? '检查(本机请直接在终端安装)' : '一键安装'}。
          <button className="btn small" onClick={() => useStore.getState().setTab('setup')}>去检查</button>
        </p>
      )}
      <div className="form-grid">
        <label>项目上下文
          <select value={selectedProjectId} onChange={(e) => selectProject(e.target.value)}><option value="">不继承项目上下文</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.cwd}</option>)}</select>
        </label>
        <label>对话名称(可选)<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空则用目录名" /></label>
        <label>工作目录({hostId === 'local' ? '本机' : '远程'})
          <RemoteDirPicker hostId={hostId} value={cwd} onChange={setCwd} />
        </label>
        <label>模型(可选)<input value={model} onChange={(e) => setModel(e.target.value)} placeholder={agent === 'codex' ? '如 gpt-5-codex' : '如 sonnet / opus'} /></label>
        <label>项目规则<textarea value={projectRules} onChange={(e) => setProjectRules(e.target.value)} placeholder="例如：先运行测试；不要修改 API 契约" /></label>
        <label>Skills<textarea value={projectSkills} onChange={(e) => setProjectSkills(e.target.value)} placeholder="例如：repo 约定、技能名称或操作说明" /></label>
        <button type="button" className="btn small ghost" onClick={saveProjectContext} disabled={!cwd.trim()}>保存项目上下文</button>
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
          <label className="row checkbox">
            <input
              type="checkbox"
              checked={permissionMode === 'plan'}
              onChange={(e) => setPermissionMode(e.target.checked ? 'plan' : 'workspace')}
            />
            Plan Mode（只读规划）
          </label>
          <p className="system-mode-notice">计划模式禁止修改文件和执行有副作用的命令，适合先获取方案与风险评估。</p>
          <label className="row checkbox">
            <input
              type="checkbox"
              checked={permissionMode === 'approval'}
              onChange={(e) => setPermissionMode(e.target.checked ? 'approval' : 'workspace')}
            />
            Approval Mode（任务审批）
          </label>
          <p className="system-mode-notice">审批模式使用工作区沙箱；请求系统权限时必须先创建任务，再在任务页批准。</p>
        </div>
      </div>
      <button className="btn primary" onClick={start} disabled={env && !installed}>开始对话</button>
    </div>
  );
}
