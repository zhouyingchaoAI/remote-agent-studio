import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createSimulation, nodeRadius } from '../useForceGraph.js';
import Markdown from './Markdown.jsx';

/**
 * 知识图谱:可视化 + 管理。
 * 图谱的意义在于暴露结构问题(孤点、断链),所以统计条和筛选是一等公民,
 * 不只是画个好看的球。
 */
export default function GraphPanel({ active = true }) {
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState('vault');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [onlyOrphans, setOnlyOrphans] = useState(false);
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async (nextScope = scope) => {
    setLoading(true); setError('');
    try {
      const g = await window.api.obsidian.graph({ scope: nextScope });
      setGraph(g);
      if (g.error) setError(g.error);
    } catch (e) { setError(e?.message || '扫描失败'); }
    setLoading(false);
  }, [scope]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // 打开某篇笔记的正文与反向链接
  const openNote = useCallback(async (node) => {
    setSelected(node);
    setNote(null);
    if (!node?.relPath) return;
    try {
      const r = await window.api.obsidian.readNoteFile({ relPath: node.relPath });
      setNote(r);
    } catch (e) { setNote({ content: `读取失败:${e?.message || e}` }); }
  }, []);

  const filtered = useMemo(() => {
    if (!graph) return [];
    const q = query.trim().toLowerCase();
    return graph.nodes.filter((n) => {
      if (onlyOrphans && n.degree > 0) return false;
      if (tagFilter && !n.tags.includes(tagFilter)) return false;
      if (q && !n.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [graph, query, tagFilter, onlyOrphans]);

  const del = async (node) => {
    if (!window.confirm(`把笔记「${node.id}」移到废纸篓?`)) return;
    try {
      await window.api.obsidian.deleteNote({ relPath: node.relPath });
      setSelected(null); setNote(null);
      load();
    } catch (e) { setError(e?.message || '删除失败'); }
  };

  const s = graph?.stats;
  return (
    <div className="graph-panel">
      <div className="graph-head">
        <h2>知识图谱</h2>
        <select className="brief-date" value={scope}
          onChange={(e) => { setScope(e.target.value); load(e.target.value); }}>
          <option value="vault">整个 vault</option>
          <option value="folder">只看本工具目录</option>
        </select>
        <input className="brief-topics" value={query} placeholder="搜索笔记标题…"
          onChange={(e) => setQuery(e.target.value)} />
        <select className="brief-date" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
          <option value="">全部标签</option>
          {(graph?.tags || []).slice(0, 40).map((t) => (
            <option key={t.tag} value={t.tag}>#{t.tag} ({t.count})</option>
          ))}
        </select>
        <label className="row" style={{ gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={onlyOrphans} onChange={(e) => setOnlyOrphans(e.target.checked)} />
          只看孤立笔记
        </label>
        <span className="flex1" />
        <button className="btn" disabled={loading} onClick={() => load()}>
          {loading ? '扫描中…' : '重新扫描'}
        </button>
      </div>

      {error && <div className="error-text brief-error">{error}</div>}

      <AutoCaptureBar onRan={() => load()} />

      {s && (
        <div className="graph-stats muted small">
          <span><b>{s.notes}</b> 篇笔记</span>
          <span><b>{s.links}</b> 条双链</span>
          <span className={s.orphans ? 'warn-text' : ''}><b>{s.orphans}</b> 篇孤立</span>
          <span className={s.broken ? 'warn-text' : ''}><b>{s.broken}</b> 处断链</span>
          <span><b>{s.tags}</b> 个标签</span>
          {graph.truncated && <span className="warn-text">已达扫描上限,仅显示部分</span>}
          {filtered.length !== s.notes && <span>· 当前筛选 {filtered.length} 篇</span>}
        </div>
      )}

      <div className="graph-body">
        <GraphCanvas graph={graph} visible={filtered} selected={selected} onSelect={openNote} active={active} />

        <aside className="graph-side">
          {!selected && (
            <>
              <div className="graph-side-head">笔记列表({filtered.length})</div>
              <div className="graph-list">
                {filtered.slice(0, 300).map((n) => (
                  <div key={n.id} className={`graph-list-item ${n.degree === 0 ? 'orphan' : ''}`}
                    onClick={() => openNote(n)} title={n.relPath}>
                    <span className="graph-list-title">{n.id}</span>
                    <span className="muted small">{n.degree} 链</span>
                  </div>
                ))}
                {filtered.length === 0 && <div className="muted small pad">没有匹配的笔记</div>}
              </div>
              {graph?.broken?.length > 0 && (
                <>
                  <div className="graph-side-head">断链({graph.broken.length})</div>
                  <div className="graph-list">
                    {graph.broken.slice(0, 50).map((b, i) => (
                      <div className="graph-list-item" key={i}>
                        <span className="muted small">{b.from} → </span>
                        <span className="warn-text">{b.to}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {selected && (
            <div className="graph-detail">
              <div className="graph-side-head">
                <button className="btn small ghost" onClick={() => { setSelected(null); setNote(null); }}>← 返回</button>
              </div>
              <h3 className="graph-detail-title">{selected.id}</h3>
              <div className="muted small">{selected.relPath}</div>
              {selected.tags.length > 0 && (
                <div className="graph-tags">{selected.tags.map((t) => <span className="chip" key={t}>#{t}</span>)}</div>
              )}
              <div className="graph-links-info muted small">
                出链 {selected.links.length} · 反向链接 {selected.backlinks.length}
                {selected.degree === 0 && <span className="warn-text"> · 孤立笔记</span>}
              </div>
              {selected.backlinks.length > 0 && (
                <div className="graph-backlinks">
                  {selected.backlinks.map((b) => (
                    <button className="btn small ghost" key={b}
                      onClick={() => {
                        const n = graph.nodes.find((x) => x.id === b);
                        if (n) openNote(n);
                      }}>← {b}</button>
                  ))}
                </div>
              )}
              <div className="row gap" style={{ margin: '10px 0' }}>
                <button className="btn small" onClick={() => window.api.obsidian.openInApp({ relPath: selected.relPath })}>
                  在 Obsidian 打开
                </button>
                <button className="btn small danger" onClick={() => del(selected)}>移到废纸篓</button>
              </div>
              <div className="graph-note-body">
                {note ? <Markdown text={note.content} /> : <div className="muted small">加载中…</div>}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * 自动沉淀状态条:放在图谱页最显眼处。
 * 长期积累的前提是"它真的在跑",所以这里既显示状态,也做前置条件自检 ——
 * 缺 vault、缺 CLI 这类问题必须提前暴露,否则到点只会静默失败。
 */
function AutoCaptureBar({ onRan }) {
  const [cfg, setCfg] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [estimate, setEstimate] = useState(null);

  const load = () => window.api.autocapture.getConfig().then(setCfg).catch(() => {});
  useEffect(() => {
    load();
    // 回溯是长任务,实时显示进度,免得看着像卡死
    const off = window.api.autocapture.onProgress(({ text }) => { if (text) setMsg(text); });
    return off;
  }, []);

  const doCheck = async () => {
    setBusy(true); setMsg('');
    const r = await window.api.autocapture.check().catch((e) => ({ ok: false, notes: [e?.message || '检查失败'] }));
    setCheck(r); setBusy(false);
    return r;
  };

  const toggle = async (on) => {
    if (on) {
      const r = await doCheck();
      if (!r.ok) { setMsg('前置条件不满足,先按下面的提示处理'); return; }
    }
    const next = await window.api.autocapture.setConfig({ enabled: on }).catch(() => null);
    if (next) { setCfg(next); setMsg(on ? '已开启,之后每天自动沉淀' : '已关闭'); }
  };

  const runNow = async () => {
    setBusy(true); setMsg('正在提炼当天经验…(取决于对话量,可能要一两分钟)');
    try {
      const r = await window.api.autocapture.runNow({});
      setMsg(r?.ok === false ? `失败:${r.error}`
        : r?.count ? `✅ 沉淀 ${r.count} 篇(新建 ${r.created} / 补充 ${r.merged})`
          : `没有可沉淀的内容${r?.note ? ` —— ${r.note}` : ''}`);
      load(); onRan && onRan();
    } catch (e) { setMsg(`失败:${e?.message || e}`); }
    setBusy(false);
  };

  /** 远程诊断:把每台主机上会话记录的真实情况打出来 */
  const diagnoseRemote = async () => {
    setBusy(true); setMsg('正在诊断各远程主机…');
    try {
      const rows = await window.api.autocapture.diagnoseRemote();
      if (!rows.length) { setMsg('没有配置远程主机'); setBusy(false); return; }
      const lines = rows.map((r) => {
        if (!r.connected) return `${r.hostId}:未连接(请在侧边栏点开连接)`;
        if (r.error) return `${r.hostId}:诊断失败 ${r.error}`;
        const dirs = (r.dirs || []).filter((d) => d.exists)
          .map((d) => `${d.dir.replace(r.home, '~')}(${d.count} 个)`).join('、') || '无相关目录';
        const clis = (r.clis || []).map((c) => `${c.name}:${c.path === '未安装' ? '未装' : '已装'}`).join(' ');
        return `${r.hostId} [${r.user}@${r.home}] 共 ${r.totalJsonl} 个会话文件\n  目录:${dirs}\n  CLI:${clis}`;
      });
      const totals = rows.reduce((n, r) => n + (r.totalJsonl || 0), 0);
      setMsg(`${lines.join('\n')}\n\n${totals > 0
        ? `合计 ${totals} 个会话文件,可以点「沉淀全部历史」了`
        : '所有主机上都没有会话记录 —— 说明这些机器上还没通过 CLI 跑过对话,或对话是在别的账号下跑的'}`);
    } catch (e) { setMsg(`诊断失败:${e?.message || e}`); }
    setBusy(false);
  };

  /** 全量回溯:先给出规模与成本预估,确认后再跑 */
  const backfill = async () => {
    setBusy(true); setMsg('正在扫描各来源(含远程主机)…');
    const est = await window.api.autocapture.backfillEstimate({}).catch(() => null);
    setBusy(false);
    const totalItems = (est?.conversations || 0) + (est?.cliSessions || 0) + (est?.remoteSessions || 0);
    setEstimate(est);   // 结果留在界面上,便于核对到底扫到了什么
    if (!est || !totalItems) {
      setMsg('没有扫到可沉淀的内容。若你的项目在远程机上,请先连接该主机再试。');
      return;
    }
    const projects = (est.topProjects || []).slice(0, 6)
      .map((p) => `  · ${p.project}(${p.count} 个会话)`).join('\n');
    const ok = window.confirm(
      `将沉淀:\n`
      + `  应用内对话 ${est.conversations} 段\n`
      + `  本机项目会话 ${est.cliSessions} 个\n`
      + `  远程项目会话 ${est.remoteSessions || 0} 个\n`
      + `  共覆盖 ${est.projects} 个项目\n`
      + (projects ? `${projects}\n` : '')
      + `\n合计约 ${Math.round(est.chars / 10000)} 万字,分 ${est.batches} 批调用模型。\n\n继续?`
    );
    if (!ok) return;
    setBusy(true); setMsg('开始回溯…');
    try {
      const r = await window.api.autocapture.backfill({});
      const head = r.count > 0
        ? `✅ 回溯完成:${r.conversations} 段来源 → 沉淀 ${r.count} 篇(新建 ${r.created} / 补充 ${r.merged})`
        : `⚠️ 处理了 ${r.conversations} 段来源,但一篇也没沉淀成。原因:`;
      // 一篇都没出时,把每批的失败原因摊开,不让用户对着 0 发呆
      const detail = r.count === 0 && r.errors?.length ? `\n${r.errors.slice(0, 4).join('\n')}` : '';
      setMsg(head + detail);
      onRan && onRan();
    } catch (e) { setMsg(`回溯失败:${e?.message || e}`); }
    setBusy(false);
  };

  if (!cfg) return null;
  const last = cfg.lastResult;
  return (
    <div className={`autocap-bar ${cfg.enabled ? 'on' : ''}`}>
      <span className="autocap-dot" />
      <b>自动沉淀</b>
      <span className="muted small">
        {cfg.enabled
          ? `已开启 · 每天 ${cfg.time} · ${cfg.agent}${cfg.model ? ` / ${cfg.model}` : ''}`
          : '未开启 —— 开启后每天自动把当天对话里的可复用经验写进知识库'}
      </span>
      {cfg.lastRunAt && (
        <span className="muted small">
          · 上次 {new Date(cfg.lastRunAt).toLocaleDateString()}
          {last?.ok ? ` 沉淀 ${last.count} 篇` : ` 失败`}
        </span>
      )}
      <span className="flex1" />
      <button className="btn small ghost" disabled={busy} onClick={diagnoseRemote}
        title="查看各远程主机上到底有没有会话记录">诊断远程</button>
      <button className="btn small" disabled={busy} onClick={backfill}
        title="把全部历史对话一次性提炼进知识库(分批进行)">沉淀全部历史</button>
      <button className="btn small" disabled={busy} onClick={runNow}>沉淀今天</button>
      <button className={`btn small ${cfg.enabled ? 'ghost' : 'primary'}`} disabled={busy}
        onClick={() => toggle(!cfg.enabled)}>
        {cfg.enabled ? '关闭' : '开启自动沉淀'}
      </button>
      {(msg || check || estimate) && (
        <div className="autocap-notes">
          {msg && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{msg}</div>}
          {check?.notes?.map((n, i) => (
            <div key={i} className={`small ${check.ok ? 'muted' : 'warn-text'}`}>· {n}</div>
          ))}
          {estimate && (
            <div className="small muted" style={{ marginTop: 4 }}>
              扫描结果:应用对话 {estimate.conversations} 段 · 本机项目会话 {estimate.cliSessions} 个
              · 远程项目会话 {estimate.remoteSessions || 0} 个 · 覆盖 {estimate.projects} 个项目
              {estimate.topProjects?.length > 0 && (
                <div style={{ marginTop: 2 }}>
                  {estimate.topProjects.slice(0, 5).map((p) => `${p.project}(${p.count})`).join(' · ')}
                </div>
              )}
              {(estimate.remoteSessions || 0) === 0 && (
                <div className="warn-text" style={{ marginTop: 2 }}>
                  没扫到远程项目会话——若你的项目在远程机上,请先在侧边栏连接该主机再点一次
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* 空状态:精确说明「为什么是空的」,并给出对应的一键操作 */
function GraphEmptyState({ onReload }) {
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const refresh = () => window.api.obsidian.diagnose().then(setD).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const after = (next, text) => { if (next) { setMsg(text); refresh(); onReload && onReload(); } };
  const pick = async () => after(await window.api.obsidian.pickVault().catch(() => null), '已选择 vault ✓');
  const create = async () => after(await window.api.obsidian.createVault().catch(() => null),
    '已创建 vault 并写入一篇说明笔记 ✓');

  /** 一键搞定:建库 → 回溯全部历史 → 开启自动沉淀,中间不用你做任何选择 */
  const quickStart = async () => {
    setMsg('① 正在准备知识库…');
    try {
      const v = await window.api.obsidian.quickStart();
      setMsg(`① 知识库就绪:${v.vaultPath}\n② 正在扫描所有历史对话(含远程主机)…`);
      const r = await window.api.autocapture.backfill({});
      if (!r.count && r.errors?.length) {
        setMsg(`① 知识库已就绪:${v.vaultPath}\n② 处理了 ${r.conversations} 段来源但没沉淀出笔记:\n${r.errors.slice(0, 3).join('\n')}`);
        return;
      }
      setMsg(`② 已沉淀 ${r.count} 篇笔记(来自 ${r.conversations} 段对话)\n③ 正在开启每日自动沉淀…`);
      await window.api.autocapture.setConfig({ enabled: true }).catch(() => {});
      setMsg(`✅ 全部完成:知识库 ${v.vaultPath},已沉淀 ${r.count} 篇,并已开启每日自动沉淀。点上方「重新扫描」查看图谱。`);
      refresh();
    } catch (e) { setMsg(`失败:${e?.message || e}`); }
  };

  if (!d) return <div className="graph-canvas-wrap muted center pad">检测中…</div>;

  // 分情况给出准确诊断与对应操作
  let title, hint, actions;
  if (!d.vaultPath) {
    title = '还没有配置知识库(vault)';
    hint = '如果你已经在用 Obsidian,选中它打开的那个文件夹;没用过就直接新建一个,之后照样能用 Obsidian 打开。';
    actions = (
      <>
        <button className="btn primary" onClick={quickStart}>一键开始积累知识</button>
        <button className="btn" onClick={pick}>选择已有 vault…</button>
      </>
    );
    hint = '点「一键开始积累知识」:自动建库 → 把所有历史对话(含远程主机上各项目的会话)提炼入库 → 开启每日自动沉淀,全程不用你选。已经在用 Obsidian 的话,选右边指定你的 vault。';
  } else if (!d.exists) {
    title = '配置的目录不存在了';
    hint = `原路径:${d.vaultPath}(可能被移动或改名)`;
    actions = <button className="btn primary" onClick={pick}>重新选择…</button>;
  } else if (d.mdInVault === 0) {
    title = '知识库还是空的';
    hint = '用对话页的 🧠 存一次,或到「设置 → Obsidian 知识库」打开每日自动沉淀,内容会自动积累起来。';
    actions = <button className="btn" onClick={create}>新建一个带说明的 vault…</button>;
  } else if (d.mdInFolder === 0) {
    title = '当前范围里没有笔记';
    hint = `vault 里有 ${d.mdInVault} 篇笔记,但子目录「${d.folder}」还是空的。把上方范围切到「整个 vault」即可看到。`;
    actions = null;
  } else {
    title = '没有匹配的笔记';
    hint = '试试清空搜索关键词或标签筛选。';
    actions = null;
  }

  return (
    <div className="graph-canvas-wrap muted center pad">
      <p style={{ fontSize: 15, color: 'var(--text)' }}>{title}</p>
      <p className="small" style={{ marginTop: 6, maxWidth: 520, whiteSpace: 'pre-wrap' }}>{hint}</p>
      {actions && <div className="row gap" style={{ marginTop: 12, justifyContent: 'center' }}>{actions}</div>}
      {d.vaultPath && (
        <p className="small" style={{ marginTop: 12, opacity: 0.7 }}>
          当前:{d.vaultPath}{d.isVault ? '(已识别为 Obsidian vault)' : '(未发现 .obsidian 子目录)'}
          {` · 全库 ${d.mdInVault} 篇 · 子目录 ${d.mdInFolder} 篇`}
        </p>
      )}
      {msg && <p className="small" style={{ marginTop: 10, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{msg}</p>}
    </div>
  );
}

/* 力导向画布:拖拽移动节点、滚轮缩放、点击选中、悬停高亮邻居 */
function GraphCanvas({ graph, visible, selected, onSelect, active = true }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const simRef = useRef(null);
  const viewRef = useRef({ scale: 1, ox: 0, oy: 0 });
  const dragRef = useRef(null);
  const hoverRef = useRef(null);
  // 标签页被切走 / 窗口隐藏时,渲染循环必须停,否则常驻页面会一直烧 CPU
  const visibleRef = useRef(active);
  useEffect(() => { visibleRef.current = active && !document.hidden; }, [active]);

  useEffect(() => {
    if (!graph || !canvasRef.current || !wrapRef.current) return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const dpr = window.devicePixelRatio || 1;

    const visibleIds = new Set(visible.map((n) => n.id));
    const nodes = graph.nodes.filter((n) => visibleIds.has(n.id));
    const edges = graph.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));

    const resize = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      return { w, h };
    };
    let { w, h } = resize();
    const sim = createSimulation(nodes, edges, { width: w, height: h });
    simRef.current = sim;

    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
    const C = {
      edge: 'rgba(139,147,167,0.25)',
      edgeHot: color('--accent', '#4f8cff'),
      node: color('--accent', '#4f8cff'),
      moc: color('--accent2', '#7c5cff'),
      orphan: color('--red', '#ff5c5c'),
      text: color('--text', '#e4e8f1')
    };

    /* 省电的关键:布局收敛后彻底停掉 rAF,不再逐帧空转。
       任何交互(拖拽/悬停/缩放/数据变化)通过 kick() 唤醒,画完再自动停。
       之前一直跑循环导致明显耗电 —— 图谱页还是常驻的,切走也停不下来。 */
    let raf = 0;
    let running = false;
    const kick = () => {
      if (running || !visibleRef.current) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const frame = () => {
      if (!visibleRef.current) { running = false; return; }   // 页面不可见:停机
      draw();
      const busy = !!dragRef.current || !sim.settled();
      if (busy) { sim.step(); raf = requestAnimationFrame(frame); }
      else running = false;                                   // 收敛:停机
    };

    const draw = () => {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { scale, ox, oy } = viewRef.current;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      const hot = hoverRef.current || selected;
      const neighbors = new Set();
      if (hot) {
        for (const l of sim.links) {
          if (l.source.id === hot.id) neighbors.add(l.target.id);
          if (l.target.id === hot.id) neighbors.add(l.source.id);
        }
      }

      for (const l of sim.links) {
        const lit = hot && (l.source.id === hot.id || l.target.id === hot.id);
        ctx.strokeStyle = lit ? C.edgeHot : C.edge;
        ctx.lineWidth = lit ? 1.6 / scale : 0.8 / scale;
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.stroke();
      }

      for (const n of sim.nodes) {
        const r = nodeRadius(n);
        const dim = hot && n.id !== hot.id && !neighbors.has(n.id);
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.fillStyle = n.degree === 0 ? C.orphan : (n.isMoc ? C.moc : C.node);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (selected && n.id === selected.id) {
          ctx.strokeStyle = C.text; ctx.lineWidth = 2 / scale; ctx.stroke();
        }
        // 放大到一定程度或是重要节点才显示标题,避免糊成一片
        if (!dim && (scale > 0.9 || n.degree >= 3 || (hot && (n.id === hot.id || neighbors.has(n.id))))) {
          ctx.globalAlpha = dim ? 0.3 : 0.95;
          ctx.fillStyle = C.text;
          ctx.font = `${11 / scale}px -apple-system, "PingFang SC", sans-serif`;
          ctx.textAlign = 'center';
          const label = n.id.length > 14 ? `${n.id.slice(0, 13)}…` : n.id;
          ctx.fillText(label, n.x, n.y + r + 11 / scale);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    };
    kick();

    const toWorld = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const { scale, ox, oy } = viewRef.current;
      return { x: (ev.clientX - rect.left - ox) / scale, y: (ev.clientY - rect.top - oy) / scale };
    };
    const onDown = (ev) => {
      const p = toWorld(ev);
      const n = sim.nodeAt(p.x, p.y, nodeRadius);
      if (n) { dragRef.current = { node: n, moved: false }; n.fixed = true; }
      else dragRef.current = { pan: true, sx: ev.clientX, sy: ev.clientY, ox: viewRef.current.ox, oy: viewRef.current.oy };
      kick();
    };
    const onMove = (ev) => {
      const d = dragRef.current;
      if (d?.node) {
        const p = toWorld(ev);
        d.node.x = p.x; d.node.y = p.y; d.moved = true;
        sim.reheat(3);
      } else if (d?.pan) {
        viewRef.current.ox = d.ox + (ev.clientX - d.sx);
        viewRef.current.oy = d.oy + (ev.clientY - d.sy);
      } else {
        const p = toWorld(ev);
        const n = sim.nodeAt(p.x, p.y, nodeRadius);
        const changed = (hoverRef.current?.id || null) !== (n?.id || null);
        hoverRef.current = n;
        canvas.style.cursor = n ? 'pointer' : 'grab';
        if (!changed) return;  // 悬停对象没变就不必重绘,避免鼠标一动就狂刷
      }
      kick();
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d?.node) {
        d.node.fixed = false;
        if (!d.moved) onSelect(graph.nodes.find((x) => x.id === d.node.id) || d.node);
      }
      dragRef.current = null;
    };
    const onWheel = (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      const v = viewRef.current;
      const next = Math.max(0.2, Math.min(4, v.scale * (ev.deltaY < 0 ? 1.12 : 0.89)));
      // 以鼠标为锚点缩放
      v.ox = mx - ((mx - v.ox) / v.scale) * next;
      v.oy = my - ((my - v.oy) / v.scale) * next;
      v.scale = next;
      kick();
    };
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(() => { const d2 = resize(); w = d2.w; h = d2.h; kick(); });
    ro.observe(wrap);
    // 窗口最小化/切到后台时停机,回来再唤醒
    const onVis = () => { if (!document.hidden) kick(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
    };
  }, [graph, visible, selected, onSelect]);

  if (!graph) return <div className="graph-canvas-wrap muted center pad">正在扫描 vault…</div>;
  if (!graph.nodes.length) return <GraphEmptyState />;
  return (
    <div className="graph-canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />
      <div className="graph-legend muted small">
        <span><i className="dot node" /> 普通</span>
        <span><i className="dot moc" /> 索引</span>
        <span><i className="dot orphan" /> 孤立</span>
        <span>滚轮缩放 · 拖拽移动 · 点击查看</span>
      </div>
    </div>
  );
}
