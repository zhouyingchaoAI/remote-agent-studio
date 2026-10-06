import { useState, useEffect } from 'react';
import { useStore } from '../store.js';
import { shortenPath } from '../shortenPath.js';
import ForkDialog from './ForkDialog.jsx';
import { normalizePastedPath, looksLikePath } from '../pastePath.js';
import { ModelPicker } from './ModelPicker.jsx';

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
        <label>模型(可选)<ModelPicker agent={agent} value={model} onChange={setModel} hostId={hostId} disabled={agent === 'dsh'} /></label>
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

export { AGENT_NAMES, AGENT_BADGES, agentCliInstalled, conversationToMarkdown, RemoteDirPicker, SessionSetup, ConvCard, ConversationHome };
