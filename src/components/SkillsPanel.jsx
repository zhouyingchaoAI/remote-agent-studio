import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 技能(Agent Skills)管理。
 *
 * SKILL.md 是跨引擎开放标准,一份技能对 claude / codex / grok 同时生效。
 * 远程主机默认是裸环境,一条技能都没有 —— 这个面板就是把技能装过去的地方。
 */

const ENGINES = [
  { key: 'claude', label: 'Claude Code', dir: '~/.claude/skills' },
  { key: 'codex', label: 'Codex', dir: '~/.codex/skills' },
  { key: 'grok', label: 'Grok / 国产模型', dir: '~/.grok/skills' }
];

export default function SkillsPanel({ hostId, connected }) {
  const [view, setView] = useState('builtin'); // builtin | installed | market
  const [builtin, setBuiltin] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [engines, setEngines] = useState(() => new Set(['claude', 'codex']));
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [preview, setPreview] = useState(null);
  const logRef = useRef(null);

  useEffect(() => {
    window.api.skills.listBuiltin()
      .then((list) => {
        setBuiltin(list);
        // 默认全选内置技能:它们都是通用工程纪律,装上没有副作用
        setPicked(new Set(list.filter((s) => s.ok).map((s) => s.id)));
      })
      .catch(() => setBuiltin([]));
  }, []);

  useEffect(() => window.api.skills.onLog((e) => {
    if (e.hostId !== hostId) return;
    setLog((prev) => prev + e.text);
    requestAnimationFrame(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });
  }), [hostId]);

  const toggle = (set, key) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  };

  const selected = useMemo(
    () => builtin.filter((s) => picked.has(s.id) && s.ok),
    [builtin, picked]
  );

  const install = async () => {
    if (!connected) { setLog('主机未连接,请先在「环境配置」里连接。\n'); return; }
    if (!selected.length) { setLog('没有勾选任何技能。\n'); return; }
    if (!engines.size) { setLog('没有勾选目标引擎。\n'); return; }
    setBusy(true);
    setLog(`开始下发 ${selected.length} 条技能到 ${[...engines].join('、')} ...\n`);
    try {
      await window.api.skills.install({
        hostId,
        engines: [...engines],
        skills: selected.map((s) => ({ name: s.name, content: s.content }))
      });
    } catch (e) {
      setLog((p) => p + `失败:${e.message}\n`);
    } finally { setBusy(false); }
  };

  return (
    <div className="skills-panel">
      <div className="skills-main">
        <div className="skills-tabs">
          {[['builtin', `内置技能 (${builtin.length})`], ['installed', '主机已装'], ['market', '技能市场']].map(([k, label]) => (
            <button key={k} className={`tab small ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>

        {view === 'builtin' && (
          <BuiltinList list={builtin} picked={picked} onToggle={(id) => setPicked((s) => toggle(s, id))}
            onPreview={(s) => setPreview({ title: s.name, content: s.content })} />
        )}
        {view === 'installed' && <InstalledList hostId={hostId} connected={connected} />}
        {view === 'market' && <Market onImport={(skill) => {
          setBuiltin((list) => list.some((x) => x.id === skill.id) ? list : [...list, skill]);
          setPicked((s) => new Set([...s, skill.id]));
          setView('builtin');
        }} />}
      </div>

      <div className="skills-side">
        <section>
          <h3>下发目标</h3>
          <p className="muted small">同一份 SKILL.md 各引擎通用,勾哪个就写进哪个目录。</p>
          {ENGINES.map((e) => (
            <label key={e.key} className="check-row">
              <input type="checkbox" checked={engines.has(e.key)}
                onChange={() => setEngines((s) => toggle(s, e.key))} />
              <span>{e.label}</span>
              <code className="muted small">{e.dir}</code>
            </label>
          ))}
        </section>

        <section>
          <button className="btn primary skill-install-btn" onClick={install} disabled={busy || !selected.length}>
            {busy ? '下发中…' : `下发 ${selected.length} 条技能`}
          </button>
          {!connected && <p className="muted small">主机未连接,连接后才能下发。</p>}
        </section>

        <section className="flex1">
          <h3>日志</h3>
          <pre className="log-box" ref={logRef}>{log || '尚未下发。\n\n技能会被引擎按需自动加载 —— 描述匹配上当前任务时才进上下文,平时不占 token。'}</pre>
        </section>
      </div>

      {preview && <PreviewModal {...preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function BuiltinList({ list, picked, onToggle, onPreview }) {
  if (!list.length) return <p className="muted">内置技能库为空。</p>;
  return (
    <div className="skill-list">
      {list.map((s) => (
        <div className={`skill-card ${picked.has(s.id) ? 'picked' : ''}`} key={s.id}>
          <label className="skill-head">
            <input type="checkbox" checked={picked.has(s.id)} disabled={!s.ok} onChange={() => onToggle(s.id)} />
            <b>{s.name}</b>
            {s.builtin && <span className="badge">内置</span>}
            {!s.ok && <span className="badge error">{s.error}</span>}
          </label>
          <p className="skill-desc">{s.description}</p>
          {!!s.warnings?.length && <p className="warn-text small">{s.warnings.join(';')}</p>}
          <button className="btn small ghost" onClick={() => onPreview(s)}>查看内容</button>
        </div>
      ))}
    </div>
  );
}

function InstalledList({ hostId, connected }) {
  const [engine, setEngine] = useState('claude');
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!connected) { setErr('主机未连接'); setItems([]); return; }
    setLoading(true); setErr('');
    try { setItems(await window.api.skills.listInstalled({ hostId, engine })); }
    catch (e) { setErr(e.message); setItems([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [engine, connected, hostId]);

  const remove = async (name) => {
    await window.api.skills.remove({ hostId, engine, name }).catch(() => {});
    refresh();
  };

  return (
    <div>
      <div className="row gap">
        <select value={engine} onChange={(e) => setEngine(e.target.value)}>
          {ENGINES.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
        </select>
        <button className="btn small ghost" onClick={refresh} disabled={loading}>刷新</button>
      </div>
      {err && <p className="error-text">{err}</p>}
      {!err && !items.length && !loading && <p className="muted">该引擎目录下还没有技能。</p>}
      <div className="skill-list">
        {items.map((s) => (
          <div className="skill-card" key={s.name}>
            <div className="skill-head"><b>{s.name}</b></div>
            {s.description && <p className="skill-desc">{s.description}</p>}
            <button className="btn small danger" onClick={() => remove(s.name)}>删除</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Market({ onImport }) {
  const [sources, setSources] = useState([]);
  const [repo, setRepo] = useState('anthropics/skills');
  const [list, setList] = useState([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => { window.api.skills.marketSources().then(setSources).catch(() => {}); }, []);

  const load = async (spec = repo) => {
    setLoading(true); setErr(''); setList([]);
    try {
      const r = await window.api.skills.marketList({ repo: spec });
      setList(r.skills);
      if (r.truncated) setErr('仓库过大,GitHub 返回的列表被截断,可能不完整。');
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const importOne = async (entry) => {
    try {
      const r = await window.api.skills.marketFetch({ repo: entry.repo, path: entry.path });
      if (!r.ok) { setErr(`${entry.name}:${r.error}`); return; }
      onImport({
        id: r.name, name: r.name, description: r.description,
        ok: true, warnings: r.warnings || [], content: r.content, builtin: false
      });
    } catch (e) { setErr(e.message); }
  };

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return kw ? list.filter((s) => (s.name + s.category).toLowerCase().includes(kw)) : list;
  }, [list, q]);

  return (
    <div>
      <p className="muted small">
        技能不打包进本应用,而是从上游仓库实时拉取 —— 上游更新即刻可用,也避免许可证与体积问题。
      </p>
      <div className="row gap">
        <select value={repo} onChange={(e) => { setRepo(e.target.value); load(e.target.value); }}>
          {sources.map((s) => <option key={s.id} value={s.repo}>{s.label} · {s.repo}</option>)}
          {!sources.some((s) => s.repo === repo) && <option value={repo}>{repo}</option>}
        </select>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" style={{ width: 200 }} />
        <button className="btn small" onClick={() => load()} disabled={loading}>{loading ? '加载中…' : '加载'}</button>
      </div>
      {err && <p className="error-text small">{err}</p>}
      {!!list.length && (
        <input className="skill-search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={`在 ${list.length} 条技能中搜索…`} />
      )}
      <div className="skill-list">
        {shown.map((s) => (
          <div className="skill-card" key={s.path}>
            <div className="skill-head">
              <b>{s.name}</b>
              {s.category && <span className="badge muted">{s.category}</span>}
            </div>
            <button className="btn small" onClick={() => importOne(s)}>导入</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewModal({ title, content, onClose }) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal skill-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <b>{title}</b>
          <button className="icon-btn" title="关闭" onClick={onClose}>✕</button>
        </div>
        <pre className="skill-source">{content}</pre>
      </div>
    </div>
  );
}
