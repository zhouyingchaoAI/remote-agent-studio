import React, { useState, useRef, useEffect, useMemo } from 'react';
import { outputSummary, looksFailed } from '../toolOutput.js';
import { useStore, sendToAgent, isAwaitingConfirm, refreshGoalPlan, MAX_PANES } from '../store.js';
import { useVoiceInput } from '../useVoiceInput.js';
import { buildPromptHistory, stepPromptHistory } from '../promptHistory.js';
import { extractOptions } from '../quickReplies.js';
import { matchCommands, applyCompletion, parseSlash, parseGoalArgs, helpText } from '../slashCommands.js';
import { buildDecomposePrompt, defaultPlanPath } from '../planProgress.js';
import { toAttachment, attachmentProblem } from '../attachmentFile.js';
import { shortenPath } from '../shortenPath.js';
import ForkDialog from './ForkDialog.jsx';
import { CLAUDE_MODELS, modelVersionProblem } from '../claudeModels.js';
import {
  createGoal, buildContinuePrompt, resumeGoalPatch, setGoalMaxRounds, setGoalTokenBudget,
  fmtTokens, GOAL_DEFAULT_MAX_ROUNDS, GOAL_EXTEND_ROUNDS, GOAL_DEFAULT_TOKEN_BUDGET
} from '../goalMode.js';
import { createTeam, engineLabel, TEAM_PRESETS } from '../teamMode.js';
import FilePreview from './FilePreview.jsx';
import EngineStatus from './EngineStatus.jsx';
import GithubBadge from './GithubBadge.jsx';
import Markdown from './Markdown.jsx';
import { fileKind } from '../fileKind.js';
import { REASONING_EFFORTS } from '../reasoningEfforts.js';
import { normalizePastedPath, looksLikePath } from '../pastePath.js';

/* 统一 diff(unified diff)红绿渲染 */
/**
 * 命令输出。
 *
 * 之前这里是整个"看不到中间过程"的根源:codex 新格式把输出挂在 tool 消息的
 * output 字段上,而渲染器只画命令、**根本不看 output** —— 于是对话里只剩
 * 一行命令和一段结论,你没法验证结论对不对。
 *
 * 折叠但给一行摘要:全展开会把对话冲垮,全折起来等于没有中间过程。
 * 失败的默认展开 —— 那正是你想看的那种。
 */
function ToolOutput({ output = '', exitCode, running = false, onStop = null }) {
  const failed = looksFailed(output, exitCode);
  /* 跑着的默认展开。命令跑了十分钟你却要先点一下才能看见它在干什么,
     等于这个日志不存在 —— 想看进度的时刻正是它还在跑的时刻。 */
  const [open, setOpen] = useState(failed || running);
  const bodyRef = useRef(null);
  const followRef = useRef(true);

  /* 跟随到底部,但**只在用户本来就贴着底部时**。
     日志一直在长,如果不管三七二十一都滚到底,
     人正往上翻看某一行报错时会被反复拽回去 —— 那比不自动滚更烦。 */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !running) return;
    if (followRef.current) el.scrollTop = el.scrollHeight;
  }, [output, open, running]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const { lines, preview } = outputSummary(output);
  // 跑着但还没有输出时也要出现:否则界面上什么都没有,和卡死没区别
  if (!String(output).trim() && !running) return null;
  return (
    <div className={`tool-output${failed ? ' failed' : ''}${running ? ' running' : ''}`}>
      <button className="tool-output-head" onClick={() => setOpen(!open)}>
        <span className="chip">
          {running ? <span className="live-dot" /> : (failed ? '⚠' : '📄')} 输出 {open ? '▾' : '▸'}
        </span>
        <span className="muted small">{lines} 行{running ? ' · 持续输出中' : ''}</span>
        {exitCode != null && (
          <span className={`small ${Number(exitCode) === 0 ? 'muted' : 'exit-bad'}`}>退出码 {exitCode}</span>
        )}
        {/* 折叠时也让人看见点东西:取最后一行非空输出 —— 结论在末尾,不在开头 */}
        {!open && preview && <code className="tool-output-preview">{preview}</code>}
      </button>
      {open && (
        <>
          <pre className="dim tool-output-body" ref={bodyRef} onScroll={onScroll}>
            {output || '(还没有输出)'}
          </pre>
          <div className="row gap">
            <button className="btn tiny ghost" onClick={() => window.api.clipboard.writeText(output)}>
              复制输出
            </button>
            {running && onStop && (
              /* 复用会话本身的取消通道 —— 它会 kill 远端进程。
                 在这儿另写一套"停止命令"必然和它不一致。 */
              <button className="btn tiny ghost" onClick={onStop} title="中断当前这一轮,并结束远端进程">
                停止
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 一次工具调用:命令 + 它的输出 */
function ToolCall({ m, hostId = '', convId = '' }) {
  const [showFull, setShowFull] = useState(false);
  const detail = String(m.detail || '');
  const stop = (hostId && convId)
    ? () => window.api.agent.cancel({ hostId, convId }).catch(() => {})
    : null;
  // 200 字符经常正好把命令切在关键参数上,所以留一个"看全"的出口
  const long = detail.length > 200;
  return (
    <div className={`msg thin ${m.dangerous ? 'tool-dangerous' : ''}`}>
      <div className="row gap tool-head">
        <span className={`chip tool ${m.dangerous ? 'danger' : ''}`}>{m.dangerous ? '⚠️' : '🔧'} {m.name}</span>
        {m.dangerous && <span className="danger-tag">危险操作</span>}
        {detail && (
          <code className="tool-detail" onClick={() => long && setShowFull(!showFull)}
            title={long ? '点击展开完整命令' : ''}>
            {showFull || !long ? detail : `${detail.slice(0, 200)}…`}
          </code>
        )}
        {long && (
          <button className="btn tiny ghost" onClick={() => window.api.clipboard.writeText(detail)}>复制</button>
        )}
      </div>
      {m.diff && <EditDiff diff={m.diff} />}
      {/* 这一行是这次修复的核心:输出本来就传过来了,只是从没被画出来 */}
      <ToolOutput output={m.output} exitCode={m.exitCode} running={m.running} onStop={stop} />
    </div>
  );
}

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
  const extras = useStore((s) => s.extraConvByHost[hostId]);
  const conversations = useStore((s) => s.conversations);

  // 未选中对话 -> 显示会话列表 / 新建
  if (!activeConvId || !conv) return <ConversationHome hostId={hostId} />;

  /* 分屏:同一台主机上并排跑多个对话。
     后端本来就按 convId 分开、切走也照跑,这里只是让它们同时可见。 */
  const paneConvs = [conv, ...(extras || []).map((id) => conversations[id]).filter(Boolean)];
  if (paneConvs.length === 1) {
    return <ChatView key={conv.id} hostId={hostId} conv={conv} />;
  }
  return (
    <div className={`chat-split panes-${Math.min(paneConvs.length, MAX_PANES)}`}>
      {paneConvs.map((c) => (
        <div key={c.id} className="chat-pane">
          <ChatView hostId={hostId} conv={c} split />
        </div>
      ))}
    </div>
  );
}

/* ---------------- 会话列表(历史记录) ---------------- */
function ConversationHome({ hostId }) {
  const conversations = useStore((s) => s.conversations);
  const [creating, setCreating] = useState(false);
  const [forking, setForking] = useState(null);   // 正在分路的那条对话
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
          {list.map((c) => <ConvCard key={c.id} conv={c} onFork={setForking} />)}
        </div>
      )}
      {forking && <ForkDialog conv={forking} onClose={() => setForking(null)} />}
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

function ConvCard({ conv, onFork }) {
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
        <button className="icon-btn" title="并排打开(与当前对话同屏)"
          onClick={(e) => { e.stopPropagation(); useStore.getState().addSplit(conv.hostId, conv.id); }}>⊞</button>
        <button className="icon-btn" title="重命名"
          onClick={(e) => { e.stopPropagation(); setDraftTitle(conv.title); setEditing(true); }}>✎</button>
        {/* 分路:一条对话拆成几路,各做一个功能,各自一个 git worktree。
            和镜像的差别是**目录也独立** —— 几路同时改同一批文件就是竞态。 */}
        <button className="icon-btn" title="分路(拆成几条并行,各自独立工作区)"
          onClick={(e) => { e.stopPropagation(); onFork(conv); }}>⑂</button>
        {/* 镜像:留着原对话不动,复制一份接着试。
            引擎那边会开一条**新线程** —— 复制会话 ID 的话两个对话会抢同一把
            写锁,正是之前查了很久的「一直连不上」。 */}
        <button className="icon-btn" title="镜像这条对话(保留历史,开新会话)"
          onClick={(e) => {
            e.stopPropagation();
            const copy = useStore.getState().mirrorConversation(conv.id);
            if (copy) useStore.getState().setActiveConv(conv.hostId, copy.id);
          }}>⧉</button>
        <button className="icon-btn danger" title="删除"
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`删除对话「${conv.title}」?`)) return;
            await window.api.attachments.cleanup({ hostId: conv.hostId, convId: conv.id }).catch(() => {});
            del(conv.id);
          }}>✕</button>
      </div>
      {/* 标明来历。镜像出来的对话和原对话共用同一个工作目录,
          不标的话很容易对着"以为是副本"的那个做破坏性操作。 */}
      {conv.mirrorOf && <div className="conv-card-mirror muted small">⧉ 镜像副本 · 与源对话共用工作目录</div>}
      <div className="conv-card-path muted small" title={conv.cwd || '~'}>{shortenPath(conv.cwd)}</div>
      {last && <div className="conv-card-last muted small">最近: {last.text.slice(0, 60)}</div>}
      <div className="conv-card-meta muted small">{conv.messages.length} 条消息 · {when}</div>
    </div>
  );
}

/**
 * 分屏控制:再开一个面板 / 关掉本面板。
 *
 * 只列同主机的其他对话 —— 跨主机并排看没有意义,cwd 与引擎都对不上,
 * 而且很容易对着错的机器发指令。
 */
function SplitControls({ hostId, conv, split }) {
  const [open, setOpen] = useState(false);
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConvByHost[hostId]);
  const extras = useStore((s) => s.extraConvByHost[hostId]);
  const onScreen = new Set([activeId, ...(extras || [])]);
  const full = 1 + (extras?.length || 0) >= MAX_PANES;

  const candidates = Object.values(conversations)
    .filter((c) => c.hostId === hostId && !onScreen.has(c.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 12);

  return (
    <span className="split-controls">
      <button className="btn small ghost" title={full ? `最多同时开 ${MAX_PANES} 个` : '再开一个对话并排显示'}
        disabled={full} onClick={() => setOpen((v) => !v)}>⊞ 分屏</button>
      {split && (
        <button className="btn small ghost" title="关掉这一屏(对话本身不会删除,后台照常跑)"
          onClick={() => useStore.getState().closeSplit(hostId, conv.id)}>✕ 本屏</button>
      )}
      {open && (
        <>
          <div className="engine-pop-backdrop" onClick={() => setOpen(false)} />
          <div className="engine-pop">
            <div className="engine-pop-head">
              <b>并排打开</b>
              <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
            </div>
            {candidates.length === 0
              ? <p className="muted small">这台主机没有其他对话了,先新建一个。</p>
              : candidates.map((c) => (
                <button key={c.id} className="btn small ghost block-btn"
                  onClick={() => { useStore.getState().addSplit(hostId, c.id); setOpen(false); }}>
                  {c.title || c.id} · {c.cwd || '~'}
                </button>
              ))}
            <p className="muted small">
              各面板独立跑各自的引擎与目录;最多 {MAX_PANES} 个 ——
              每个对话占一条 SSH 通道,开太多会把远端的连接数吃光。
            </p>
          </div>
        </>
      )}
    </span>
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

function ChatView({ hostId, conv, split = false }) {
  const running = useStore((s) => s.agentRunning[conv.id] || false);
  // 主机名给 GitHub 徽标用:弹层里要写清是给哪台主机登录
  const ghFromChat = useRef(false);
  const hostName = useStore((s) => {
    const h = (s.hosts || []).find((x) => x.id === hostId);
    return h?.name || h?.host || '';
  });
  const setActiveConv = useStore((s) => s.setActiveConv);
  const updateConversationPermission = useStore((s) => s.updateConversationPermission);
  const updateConversationModel = useStore((s) => s.updateConversationModel);
  const updateConversationAgent = useStore((s) => s.updateConversationAgent);
  /* 这台机器的环境检测结果。这里只用它的 claude 版本号 ——
     新模型对 CLI 有最低版本要求,拿它在选之前就能提示。 */
  const hostEnv = useStore((s) => s.envInfo[hostId]);
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

  /* /github login 的一次性码是异步推过来的。只有从聊天里发起时才贴进对话 ——
     从顶栏徽标登录的人正看着弹层,再往对话里插一条纯属噪音。 */
  useEffect(() => window.api.github.onProgress((p) => {
    if (p.hostId !== hostId || !ghFromChat.current) return;
    if (p.code && !p.done) {
      localNote(`GitHub 一次性码:${p.code}\n在这里授权(码已填好):${p.openUrl}`);
    }
    // eslint-disable-next-line
  }), [hostId]);

  // 进入对话/切换模型或权限时,在主进程(重新)初始化 agent 会话(带 resume 状态续聊)
  useEffect(() => {
    /* 有轮次在途时绝不重启:agent:start 会 cancel 掉现有会话。
       团队模式换引擎时正处于在途状态,不挡住的话会把刚发出的那一轮掐死。 */
    if (useStore.getState().agentRunning[conv.id]) { setStarted(true); return; }
    window.api.agent.start({
      hostId, convId: conv.id,
      opts: {
        agent: conv.agent, cwd: conv.cwd, model: conv.model, permissionMode,
        /* dsh 没有 resume:重开应用后会话对象是空的,不喂历史就等于从零开始。
           claude/codex 靠各自的 sessionId 续聊,不需要也不该走这条。 */
        history: conv.agent === 'dsh' ? dshHistoryFrom(conv.messages) : [],
        // 只有 codex 有 model_reasoning_effort
        reasoningEffort: conv.agent === 'codex' ? (conv.reasoningEffort || '') : ''
      },
      resume: { claudeSessionId: conv.claudeSessionId, codexSessionId: conv.codexSessionId, codexStarted: conv.codexStarted }
    }).then(() => setStarted(true)).catch(() => setStarted(true));
    // eslint-disable-next-line
  }, [conv.id, permissionMode, conv.model, conv.agent, conv.reasoningEffort]);

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
      case 'github': {
        const sub = (args.trim() || 'status').toLowerCase();
        if (sub === 'status') {
          window.api.github.status({ hostId }).then((r) => localNote(
            r.loggedIn
              ? `GitHub(${hostId === 'local' ? '本机' : hostName || '当前主机'}):已登录 ${r.username}`
                + `${r.scopes ? ` · ${r.scopes}` : ''}`
              : r.installed ? 'GitHub:已装 gh 但未登录,用 /github login 登录'
                : 'GitHub:这台主机没装 gh,到「环境配置」页点「安装 gh」'
          )).catch((e) => localNote(`查询失败:${e.message}`));
          return true;
        }
        if (sub === 'login') {
          // 一次性码是异步事件推过来的,这里先挂个标记,收到再贴进对话
          ghFromChat.current = true;
          localNote('正在申请一次性码…');
          window.api.github.login({ hostId })
            .then((r) => {
              ghFromChat.current = false;
              localNote(r.done
                ? `✓ 已登录 ${r.username}${r.gitConfigured ? ' · git push 免密已配好' : ''}`
                : `登录未完成${r.error ? `:${r.error}` : ''}`);
            })
            .catch((e) => { ghFromChat.current = false; localNote(`登录失败:${e.message}`); });
          return true;
        }
        if (sub === 'sync') {
          if (hostId === 'local') { localNote('当前就是本机,无需下发'); return true; }
          window.api.github.syncToRemote({ hostId })
            .then((r) => localNote(r.message))
            .catch((e) => localNote(`下发失败:${e.message}`));
          return true;
        }
        localNote('用法:/github status | login | sync');
        return true;
      }
      case 'team': {
        const a = args.trim().toLowerCase();
        if (!a || a === 'status') {
          const t = conv.team;
          localNote(t
            ? `团队模式:${engineLabel(t.worker)} 干活 · ${engineLabel(t.reviewer)} 审查`
              + `(已审查 ${t.reviews || 0} 次,当前${t.phase === 'review' ? '审查中' : '执行中'})`
            : `团队模式未开启。可用搭配:\n${TEAM_PRESETS.map((p) => `  /team ${p.worker}+${p.reviewer}  —— ${p.label}`).join('\n')}`);
          return true;
        }
        if (a === 'off') {
          useStore.getState().setConversationTeam(conv.id, null);
          localNote('团队模式已关闭'); return true;
        }
        const [worker, reviewer] = a.split(/[+/,\s]+/).filter(Boolean);
        try {
          // 记住各自的模型:来回切引擎时不能把用户选的模型清掉
          const team = createTeam({
            worker, reviewer,
            workerModel: worker === conv.agent ? (conv.model || '') : '',
            reviewerModel: ''
          });
          if (!['codex', 'claude', 'deepseek', 'dsh'].includes(worker)
            || !['codex', 'claude', 'deepseek', 'dsh'].includes(reviewer)) {
            localNote('引擎只能是 codex / claude / deepseek / dsh'); return true;
          }
          useStore.getState().setConversationTeam(conv.id, team);
          if (conv.agent !== worker) { setStarted(false); updateConversationAgent(conv.id, worker); }
          localNote([
            `👥 团队模式已开启:${engineLabel(worker)} 干活 · ${engineLabel(reviewer)} 审查`,
            '需要配合目标模式使用 —— 用 /goal <目标> 设定目标后,两方会自动轮转推进。',
            '注意:每轮审查也要花 token,成本大约是单引擎的两倍。'
          ].join('\n'));
        } catch (e) { localNote(`开启失败:${e.message}`); }
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
        const { sub, text, rounds, raw, command, verifyCommand, planPath } = parseGoalArgs(args);
        const goal = conv.goal;
        if (sub === 'set') {
          /* **拆解默认发生。** 没给路径就用默认的 —— 要用户先想出一个路径
             再手敲 --plan,这个功能就只有极少数人会用到,而它恰恰是
             "目标模式"和"跑 25 轮然后停"之间的全部差别。 */
          const file = planPath || defaultPlanPath(conv.id);
          const fresh = createGoal(text, { verifyCommand, planPath: file });
          st.setConversationGoal(conv.id, fresh);
          localNote([
            `🎯 目标已设定:${text}`,
            verifyCommand
              /* 有验收命令 = 硬判据。这条差别值得在设定时就说清楚,
                 因为它决定了"达成"这两个字有多可信。 */
              ? `验收命令(退出码 0 才算达成):${verifyCommand}`
              : '⚠ 没有验收命令,达成只能靠模型自述 —— 建议用 /goal check <命令> 补一条,'
                + '\n  比如 `npm test`、`curl -fsS localhost:8000/v1/models`、`test -f /path/to/产物`。',
            `第一轮先拆解成清单并写入 ${file},之后状态条按「第 N / M 步」走。`,
            `预算:${fmtTokens(GOAL_DEFAULT_TOKEN_BUDGET)} token(/goal budget 5m 可调);`
              + `轮次兜底 ${GOAL_DEFAULT_MAX_ROUNDS},读到计划后会按步数自动上调。`,
            '随时可用 /goal pause 暂停、/goal clear 清除。'
          ].join('\n'));
          /* 第 0 轮是**拆解**,不是"继续推进"。
             原来一上来就说"继续推进",模型只能边想边做,
             于是进度永远只能用轮次表示 —— 而轮次说不出还剩多少活儿。 */
          setTimeout(() => sendToAgent(hostId, conv.id, buildDecomposePrompt(fresh), [], { auto: true }), 0);
          return true;
        }
        if (!goal?.text) { localNote('当前没有目标。用 /goal <目标描述> 设定一个。'); return true; }
        if (sub === 'status') {
          localNote([
            `🎯 目标:${goal.text}`,
            `状态:${goal.status} · 已推进 ${goal.rounds || 0}/${goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS} 轮`,
            goal.plan?.total
              ? `计划:${goal.plan.text} · 当前「${goal.plan.currentText || '?'}」(${goal.planPath})`
              : (goal.planPath ? `计划文件:${goal.planPath}(还没读到内容)` : '')
          ].filter(Boolean).join('\n'));
        } else if (sub === 'plan') {
          /* 计划文件是把"第 12 轮"换成「第 3 / 18 步」的唯一来源。
             设完立刻读一次,免得人要等下一轮结束才知道路径写对没有。 */
          st.updateConversationGoal(conv.id, {
            planPath, plan: null, planHistory: [], planPushback: 0, planScaled: false, planSource: ''
          });
          localNote(`🎯 计划文件已设为 ${planPath},正在读取…`);
          refreshGoalPlan(hostId, conv.id).then(() => {
            const g = useStore.getState().conversations[conv.id]?.goal;
            localNote(g?.planSource === 'file'
              ? `🎯 已读到计划:${g.plan.text}(当前「${g.plan.currentText}」)`
              : `🎯 这个文件里没有 \`- [ ] xxx\` 形式的清单。`
                + `\n用 /goal replan 让它按当前目标拆一份出来。`);
          });
        } else if (sub === 'replan') {
          /* 拆坏了要能重来:粒度太粗看不出进度、太细全是琐事,
             都得靠人看一眼才知道。没有这条命令的话,唯一办法是清掉目标重设,
             那会把已经推进的轮次和预算一起丢掉。 */
          st.updateConversationGoal(conv.id, {
            plan: null, planHistory: [], planPushback: 0, planScaled: false, planSource: ''
          });
          localNote(`🎯 重新拆解中,清单会写到 ${goal.planPath || '(未设置计划文件)'}`);
          setTimeout(() => sendToAgent(hostId, conv.id, buildDecomposePrompt(goal), [], { auto: true }), 0);
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
        } else if (sub === 'budget') {
          /* token 预算才是真闸门 —— 轮次上限只是防死循环的兜底 */
          try {
            const patch = setGoalTokenBudget(goal, raw);
            st.updateConversationGoal(conv.id, patch);
            localNote(`🎯 token 预算已设为 ${fmtTokens(patch.tokenBudget)}`);
          } catch (e) { localNote(`🎯 ${e.message}`); }
        } else if (sub === 'check') {
          /* 给目标装上硬判据。这是目标模式里最值得设的一项:
             模型说"已完成"的成本是零,而这条命令的退出码不会撒谎。 */
          st.updateConversationGoal(conv.id, { verifyCommand: command, verifying: false });
          localNote(`🎯 验收命令已设定,今后以它的退出码为准:\n${command}`);
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
    /* 附件信息不全就**别发**,而且别清空输入框。
       让它发出去的话,要到主进程上传时才抛一句「附件信息不完整」——
       那时候用户既不知道是哪个文件,也不知道为什么,而消息已经没了。 */
    const broken = files.map((f) => [f, attachmentProblem(f)]).find(([, p]) => p);
    if (broken) {
      setAttachmentError(`${broken[0].name || '附件'}:${broken[1]}`);
      if (textOverride == null) setInput(raw);
      return;
    }
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

  const addFiles = (rawFiles) => {
    const MAX_MB = 200;   // 与主进程 MAX_ATTACHMENT_BYTES 保持一致
    const limit = MAX_MB * 1024 * 1024;
    /* **一进来就抄成普通对象,后面不再持有 File 实例。**
       File 的 name/size 是原型 getter,`{ ...file, thumb }` 展开后会
       悄无声息地只剩 path —— 附件到了主进程才报「信息不完整」。
       在入口归一化,后面怎么展开都不会掉东西。 */
    const files = Array.from(rawFiles || []).map(toAttachment).filter(Boolean);
    const next = files.filter((file) => file.path && file.size <= limit);
    const oversized = files.find((file) => file.size > limit);
    /* **拿不到路径的要说出来。**
       原来这类文件被 `file.path &&` 直接滤掉,一声不吭 —— 从浏览器里
       拖过来的图片、某些应用给的内存数据都会走到这儿,用户看到的就是
       "图片拖进去没了"。丢东西可以,但不能不告诉人。 */
    const noPath = files.find((file) => !file.path);
    setAttachmentError(
      oversized
        ? `${oversized.name} 超过 ${MAX_MB} MB 上限(实际 ${Math.round(oversized.size / 1024 / 1024)} MB)`
        : noPath
          ? `${noPath.name || '这个文件'}拿不到磁盘路径,没能加进来 —— `
            + '它可能是网页里的图片或内存数据,先存成本地文件再拖进来,或直接复制后粘贴。'
          : ''
    );
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
        <SplitControls hostId={hostId} conv={conv} split={split} />
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
        {/* 同理:要 push 的时候人在这里,没登录不该逼人切去环境配置 */}
        <GithubBadge hostId={hostId} isLocal={hostId === 'local'} hostLabel={hostName} />
        <b className="conv-title">{conv.title}</b>
        {/* 路径缩短显示:保尾不保头 —— 有信息量的是项目名,
            而 `/Users/<用户名>/` 每条路径都一样。完整路径在 tooltip 里,
            点一下复制(要粘到终端里的时候不用手抄)。 */}
        <span className="muted small conv-cwd" title={`${conv.cwd || '~'}\n(点击复制)`}
          onClick={() => window.api.clipboard.writeText(conv.cwd || '')}>
          {shortenPath(conv.cwd)}
        </span>
        <ModelPicker
          agent={conv.agent}
          value={conv.model || ''}
          disabled={running}
          /* 环境检测本来就拿到了 claude 版本号,拿来比一下就能在选之前提示 */
          cliVersion={hostEnv?.claude || ''}
          onChange={(m) => { setStarted(false); updateConversationModel(conv.id, m); }}
        />
        {/* 推理强度只有 codex 有(model_reasoning_effort);
            放在模型旁边,因为这两个是同一件事的两个维度 */}
        {conv.agent === 'codex' && (
          <select className="reasoning-picker" disabled={running}
            title="推理强度取决于模型支持；GPT-6 Astra 最低为 low，支持 max。默认跟随 CLI 配置。"
            value={conv.model === 'gpt-6-astra' && conv.reasoningEffort === 'minimal' ? 'low' : (conv.reasoningEffort || '')}
            onChange={(e) => {
              setStarted(false);
              useStore.getState().updateConversationReasoning(conv.id, e.target.value);
            }}>
            {REASONING_EFFORTS.filter((r) => conv.model !== 'gpt-6-astra' || r.value !== 'minimal').map((r) => (
              <option key={r.value} value={r.value}>
                {r.value ? `🧠 ${r.label}` : '🧠 默认'}
              </option>
            ))}
          </select>
        )}
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
        {/* 「系统权限」徽标 + 「System Mode」复选框原来是**同一个状态显示两遍**
            (都由 permissionMode === 'system' 驱动),白占一大截宽度,
            也是这一行被挤到换行的直接原因。合成一个开关:开着就是红的,
            警示作用由它自己承担,不需要旁边再挂个徽标。
            顺带把 System Mode 改成中文 —— 徽标本来就叫「系统权限」,
            同一件事在同一行里有两个名字,只会让人以为是两回事。 */}
        <button type="button"
          className={`chip-toggle push-right${conv.autoConfirm ? ' on' : ''}`}
          title="全自动:模型请求确认时自动回复「确认,继续」,并提示模型自行决策;连续 5 次后暂停防失控"
          onClick={() => useStore.getState().updateConversationAutoConfirm(conv.id, !conv.autoConfirm)}>
          ⚡ 全自动
        </button>
        <button type="button"
          className={`chip-toggle${permissionMode === 'system' ? ' on danger' : ''}`}
          disabled={running}
          title="系统权限:允许此对话使用 Docker 和主机级命令,可修改工作目录之外的文件与服务"
          onClick={() => changePermissionMode(permissionMode === 'system' ? 'workspace' : 'system')}>
          {permissionMode === 'system' ? '🔓 系统权限' : '🔒 工作区'}
        </button>
      </div>
      <TeamBar conv={conv} />
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
                {/* 把附件数显示出来 —— 排队时看不到附件,人根本无从发现它丢了。
                    这次这个 bug 之所以拖到现在,一半原因就是它不可见。 */}
                {q.files?.length > 0 && (
                  <span className="muted small" title={q.files.map((f) => f.name).join('\n')}>
                    📎 {q.files.length}
                  </span>
                )}
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
  codex: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5-codex', 'gpt-5'],
  /* claude 这份带版本门槛(新模型对 CLI 有最低版本要求),
     所以单独放在 claudeModels.js 里,是 {value,label,minCli} 结构。 */
  claude: CLAUDE_MODELS,
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

function ModelPicker({ agent, value, disabled, onChange, cliVersion = '' }) {
  /* 预设项既可能是纯字符串(codex/deepseek),也可能是 {value,label,minCli}
     (claude —— 新模型有 CLI 版本门槛)。两种都认,省得为了加一个字段
     把另外两个引擎的列表也改一遍。 */
  const presets = (MODEL_PRESETS[agent] || []).map(
    (m) => (typeof m === 'string' ? { value: m, label: m } : m)
  );
  const presetValues = presets.map((p) => p.value);
  /* 版本不够时在**选之前**就说清楚。
     不拦着不让选 —— 检测可能不准,而拦错了是凭空堵住一个本来能用的模型;
     但也不能不说,否则 CLI 甩一句自己的错误,人完全联想不到是版本太旧。 */
  const versionNote = agent === 'claude' ? modelVersionProblem(value, cliVersion) : '';
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
    <>
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
      {versionNote && <span className="model-warn" title={versionNote}>⚠ 版本不足</span>}
    </>
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

/* 团队模式状态条:当前谁在干活、审查了几次、被打回几次 */
function TeamBar({ conv }) {
  const team = conv.team;
  if (!team?.worker) return null;
  const reviewing = team.phase === 'review';
  return (
    <div className="team-bar">
      <span className="team-tag">👥 团队</span>
      <span className={`team-role ${reviewing ? '' : 'active'}`}>
        {engineLabel(team.worker)} 干活
      </span>
      <span className="team-arrow">{reviewing ? '→' : '←'}</span>
      <span className={`team-role ${reviewing ? 'active' : ''}`}>
        {engineLabel(team.reviewer)} 审查
      </span>
      <span className="muted small">
        已审查 {team.reviews || 0} 次
        {team.rejects > 0 && ` · 连续打回 ${team.rejects} 次`}
      </span>
      <span className="flex1" />
      <button className="btn tiny ghost"
        onClick={() => useStore.getState().setConversationTeam(conv.id, null)}>关闭</button>
    </div>
  );
}

/* 目标模式状态条:显示目标与进度,可暂停/继续/清除 */
function GoalBar({ conv }) {
  const goal = conv.goal;
  /* 步骤清单默认收起。它可能有二三十条,一直摊开会把对话挤走 ——
     而人大多数时候只需要看那句「第 3 / 18 步」。 */
  const [openPlan, setOpenPlan] = useState(false);
  if (!goal?.text) return null;
  // 已达成的目标不再显示 —— 它不会推进了。
  // 新流程会在达成时直接清空,这里兜住历史对话里已存的 done 目标。
  if (goal.status === 'done') return null;
  const st = useStore.getState();
  // 核验中要单独标出来,否则用户看到「推进中」不知道它正在自查而不是在干活
  const label = goal.verifying && goal.status === 'active'
    ? '核验中'
    : ({ active: '推进中', paused: '已暂停', done: '已达成' }[goal.status] || goal.status);
  const plan = goal.plan;
  const hasSteps = plan?.steps?.length > 0;
  return (
    <div className={`goal-bar ${goal.status}`}>
      <span className="goal-tag">🎯 目标</span>
      <span className="goal-text" title={goal.text}>{goal.text}</span>
      {/* **步数排在轮次前面。**「第 3 / 18 步」有信息量,「第 12 轮」没有 ——
          后者说不出在做第几件事、还剩几件。有计划时轮次退居次要。 */}
      {plan?.total > 0 && (
        /* **来源要看得出来。** 从计划文件读到的是可核对的事实,
           从模型正文里捞的("我在第 12/67 步")只是它的一面之词 ——
           两者长得一样的话,人会把后者也当成确凿进度。 */
        <button className="goal-step" disabled={!hasSteps}
          onClick={() => hasSteps && setOpenPlan((v) => !v)}
          title={hasSteps
            ? (plan.currentText ? `当前:${plan.currentText}` : '展开步骤清单')
            : '这个步数是模型在回复里自己说的,没有对应的计划文件 —— 用 /goal replan 让它拆一份'}>
          <span className="goal-step-bar">
            <i style={{ width: `${plan.percent}%` }} />
          </span>
          {plan.text}
          <span className="muted"> {hasSteps ? (openPlan ? '▾' : '▸') : '(自述)'}</span>
        </button>
      )}
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
      {openPlan && hasSteps && <PlanList plan={plan} planPath={goal.planPath} />}
    </div>
  );
}

/**
 * 步骤清单。
 *
 * 这份清单的**唯一来源是主机上那个文件**,不是应用自己记的账。
 * 所以要把路径显示出来 —— 人看到某一步状态不对时,可以直接去改文件,
 * 下一轮就生效。应用记账的话,人就只能干看着。
 */
function PlanList({ plan, planPath }) {
  const ICON = { done: '✓', doing: '◐', todo: '○' };
  return (
    <div className="goal-plan">
      <div className="goal-plan-head muted small">
        {planPath}
        <span> · 已完成 {plan.done} / {plan.total}</span>
      </div>
      <ol className="goal-plan-list">
        {plan.steps.map((s, i) => (
          <li key={i} className={`plan-step ${s.state}`}>
            <span className="plan-mark">{ICON[s.state] || '○'}</span>
            <span className="plan-text">{s.text}</span>
          </li>
        ))}
      </ol>
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
      /* 引擎的收尾事件与最后一段回复重复时,后端只留下费用/耗时。
         这里就渲染成一行元信息,不要套一个空气泡。 */
      if (!m.text) {
        return m.costUsd != null ? (
          <div className="msg-meta standalone">
            ${m.costUsd?.toFixed(4)}{m.durationMs != null && ` · ${(m.durationMs / 1000).toFixed(1)}s`}
          </div>
        ) : null;
      }
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
      return <ToolCall m={m} hostId={hostId} convId={convId} />;
    case 'diff':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">± 本轮文件改动 {open ? '▾' : '▸'}</span>
          {open && <DiffView text={m.text} />}
        </div>
      );
    case 'tool_output':
      return <ToolOutput output={m.output} exitCode={m.exitCode} />;
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
    case 'file':
      return <ArtifactFile hostId={hostId} remotePath={m.remotePath} name={m.name} />;
    default:
      return <div className="msg thin"><pre className="dim">{m.text || JSON.stringify(m)}</pre></div>;
  }
}

/**
 * 非图片产物(docx/pdf/xlsx/zip…)的下载入口。
 *
 * 这类文件以前根本到不了界面:产物扫描只认图片扩展名,
 * 模型写的那句「下载 xxx」只是纯文本,点了当然没反应。
 */
function ArtifactFile({ hostId, remotePath, name }) {
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind = fileKind(name);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await window.api.artifacts.saveAs({ hostId, remotePath, name });
      if (!r.canceled) setSaved(r.localPath);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="artifact-card" title={remotePath}>
      <span className="artifact-badge" style={{ background: kind.color }}>{kind.letter}</span>
      <div className="artifact-body">
        <div className="artifact-title">{name}</div>
        <div className="artifact-sub">
          {error
            ? <span className="error-text">{error}</span>
            : saved ? `已保存到 ${saved}` : `${kind.label} · ${kind.ext}`}
        </div>
      </div>
      {saved
        ? <button className="btn small ghost"
          onClick={() => window.api.artifacts.reveal({ localPath: saved })}>在文件夹中显示</button>
        : <button className="btn small" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存'}
        </button>}
    </div>
  );
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
  // 从当前填的目录开始浏览,而不是永远回到 HOME ——
  // 刚粘完一个路径就被弹回 ~,等于白粘
  const toggle = () => { if (!open) load(value?.trim() || '~'); setOpen(!open); };

  /**
   * 处理粘贴。
   * 在 Finder 里 ⌘C 一个文件夹,剪贴板上是文件引用而不是文本,
   * 直接 ⌘V 什么都不会出现 —— 那正是「不能直接复制进去」的样子。
   */
  /** 粘贴/拖入后统一走这里:落值 + 顺手把目录列表打开停在那儿 */
  const applyPasted = (raw, opts) => {
    const next = normalizePastedPath(raw, opts);
    if (!next) return;
    onChange(next);
    setOpen(true);
    load(next);
  };

  const onPastePath = async (e) => {
    const dt = e.clipboardData;
    // 先看有没有真实文件(Finder 复制/拖拽)
    const file = dt?.files?.[0];
    if (file) {
      e.preventDefault();
      try {
        const full = window.api.dialog.pathForDroppedFile(file);
        // 复制的是文件就退到它所在目录
        const isFile = !!file.type || /\.[A-Za-z0-9]+$/.test(full);
        applyPasted(full, { isFile });
        return;
      } catch (_) { /* 拿不到就走下面的文本分支 */ }
    }
    const text = dt?.getData('text/plain') || '';
    if (text && looksLikePath(text)) {
      e.preventDefault();
      applyPasted(text);
      return;
    }
    // 文本和文件都拿不到:去问主进程读 file-url(纯 ⌘V 时 clipboardData 可能是空的)
    if (!text) {
      e.preventDefault();
      const r = await window.api.clipboard.readPath().catch(() => null);
      // 从 file-url 拿到的是被复制的那个条目本身,可能是文件
      if (r?.path) applyPasted(r.path, { isFile: r.source === 'file' && /\.[A-Za-z0-9]+$/.test(r.path) });
    }
  };
  const parent = () => {
    const parts = (dir?.path || '/').split('/').filter(Boolean);
    parts.pop();
    load('/' + parts.join('/'));
  };

  return (
    <div className="dir-picker-wrap">
      <div className="row" style={{ gap: 8 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)}
          onPaste={onPastePath}
          onDrop={(e) => {
            // 从 Finder 直接拖一个文件夹进来
            const f = e.dataTransfer?.files?.[0];
            if (!f) return;
            e.preventDefault();
            try {
              const full = window.api.dialog.pathForDroppedFile(f);
              applyPasted(full, { isFile: !!f.type });
            } catch (_) {}
          }}
          placeholder="粘贴或拖入目录,也可点「浏览」" />
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
        <label>模型(可选)<ModelPicker agent={agent} value={model} onChange={setModel} disabled={agent === 'dsh'} /></label>
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
