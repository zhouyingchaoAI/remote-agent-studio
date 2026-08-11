import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store.js';

const SECTIONS = [
  { key: 'news', label: 'AI 资讯', icon: '📰', hint: '模型发布 · 产品更新 · 行业动态' },
  { key: 'ideas', label: '产品创意', icon: '💡', hint: '可落地的 AI 产品点子' },
  { key: 'papers', label: '最新论文', icon: '📄', hint: 'arXiv 近期值得读的' },
  { key: 'repos', label: '开源项目', icon: '🐙', hint: 'GitHub 近期优秀项目' }
];

export default function BriefPanel({ hostId }) {
  const [brief, setBrief] = useState(null);
  const [date, setDate] = useState('');
  const [dates, setDates] = useState([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [topics, setTopics] = useState('');
  // 数据源:codex 直接检索 / PrismFlowAgent(开源聚合系统)
  const [source, setSource] = useState('codex');
  const [caps, setCaps] = useState([]);
  const [capId, setCapId] = useState('');
  const [prismHealth, setPrismHealth] = useState(null);

  const conversations = useStore((s) => s.conversations);
  // 沿用该主机上最近一次对话的引擎/目录/模型,省得再配一遍
  const lastConv = Object.values(conversations)
    .filter((c) => c.hostId === hostId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  const loadDate = useCallback(async (d) => {
    const data = await window.api.brief.get({ date: d }).catch(() => null);
    setBrief(data);
    setError('');
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const today = await window.api.brief.today().catch(() => '');
      if (!alive) return;
      setDate(today);
      const list = await window.api.brief.dates().catch(() => []);
      if (!alive) return;
      setDates(list);
      loadDate(today);
    })();
    const off = window.api.brief.onProgress(({ text }) => setProgress(text || ''));
    return () => { alive = false; off && off(); };
  }, [loadDate]);

  // 切到流光时探活并拉取可执行的 agents/workflows
  const loadPrism = useCallback(async () => {
    const h = await window.api.prism.health().catch((e) => ({ online: false, error: e?.message }));
    setPrismHealth(h);
    if (!h?.authorized) { setCaps([]); return; }
    const list = await window.api.prism.capabilities().catch(() => []);
    setCaps(list);
    setCapId((cur) => cur || list[0]?.id || '');
  }, []);
  useEffect(() => { if (source === 'prism') loadPrism(); }, [source, loadPrism]);

  const run = async () => {
    setRunning(true);
    setError('');
    setProgress('准备中…');
    try {
      if (source === 'prism') {
        const cap = caps.find((c) => c.id === capId);
        if (!cap) throw new Error('请先选择要运行的流光 Agent / Workflow');
        setProgress(`正在通过 PrismFlowAgent 运行「${cap.name}」…`);
        const res = await window.api.prism.execute({
          action: cap.action, id: cap.id, input: topics ? { topics } : {}
        });
        if (res.sections) {
          const payload = await window.api.prism.saveAsBrief({
            sections: res.sections, text: res.text, source: `PrismFlowAgent · ${cap.name}`
          });
          setBrief(payload);
          setDate(payload.date);
          setDates(await window.api.brief.dates().catch(() => []));
        } else {
          // 输出不是结构化速览:原样展示,不硬塞进卡片
          setBrief({ date, generatedAt: Date.now(), agent: `PrismFlowAgent · ${cap.name}`, sections: null, text: res.text });
        }
      } else {
        const payload = await window.api.brief.run({
          hostId,
          agent: lastConv?.agent || 'codex',
          cwd: lastConv?.cwd || '',
          model: lastConv?.model || '',
          topics
        });
        setBrief(payload);
        setDate(payload.date);
        setDates(await window.api.brief.dates().catch(() => []));
      }
    } catch (e) {
      setError(e?.message || '生成失败');
    } finally {
      setRunning(false);
      setProgress('');
    }
  };

  const openLink = (url) => url && window.api.shell.openExternal(url);
  const stale = brief && brief.date !== date;

  return (
    <div className="brief-panel">
      <div className="brief-head">
        <h2>每日速览</h2>
        <select className="brief-date" value={brief?.date || date}
          onChange={(e) => { setDate(e.target.value); loadDate(e.target.value); }}>
          {(dates.length ? dates : [date]).filter(Boolean).map((d) => (
            <option key={d} value={d}>{d}{d === date ? '(今天)' : ''}</option>
          ))}
        </select>
        <input className="brief-topics" value={topics} placeholder="关注方向(可选),如 Agent、多模态、RAG"
          onChange={(e) => setTopics(e.target.value)} />
        <select className="brief-date" value={source} onChange={(e) => setSource(e.target.value)}
          title="数据来源">
          <option value="codex">codex 直接检索</option>
          <option value="prism">PrismFlowAgent(开源聚合)</option>
        </select>
        {source === 'prism' && caps.length > 0 && (
          <select className="brief-date" value={capId} onChange={(e) => setCapId(e.target.value)}
            title="选择要运行的 Agent / Workflow">
            {caps.map((c) => (
              <option key={`${c.action}:${c.id}`} value={c.id}>{c.action} · {c.name}</option>
            ))}
          </select>
        )}
        <span className="flex1" />
        {brief && (
          <button className="btn" disabled={running} title="归档到 Obsidian 知识库"
            onClick={async () => {
              try {
                const r = await window.api.obsidian.saveBrief({ date: brief.date });
                setError(''); setProgress(`已归档到 Obsidian:${r.path}`);
                setTimeout(() => setProgress(''), 4000);
              } catch (e) { setError(e?.message || '归档失败'); }
            }}>🧠 存入知识库</button>
        )}
        <button className="btn primary" disabled={running} onClick={run}>
          {running ? '生成中…' : (brief ? '重新生成' : '生成今日速览')}
        </button>
      </div>

      {source === 'prism' && prismHealth && !prismHealth.authorized && (
        <div className="brief-error error-text">
          {prismHealth.online
            ? '流光已在线但尚未授权:到「设置 → 资讯聚合」点「注册并授权」。'
            : `连不上流光:${prismHealth.error || '未知错误'}。可在设置里复制部署指令,让 codex 帮你装。`}
        </div>
      )}

      {running && <div className="brief-progress muted small">{progress || '正在检索…'}</div>}
      {error && <div className="error-text brief-error">{error}</div>}

      {!brief && !running && !error && (
        <div className="muted center pad">
          还没有 {date} 的速览。点右上角「生成今日速览」,让 {lastConv?.agent || 'codex'} 联网检索一次。
          <div className="muted small" style={{ marginTop: 8 }}>
            结果按日期缓存,同一天再打开直接读缓存,不会重复消耗。
          </div>
        </div>
      )}

      {brief && (
        <>
          <div className="brief-meta muted small">
            {brief.date} · {brief.agent || 'codex'}{brief.model ? ` · ${brief.model}` : ''}
            {brief.generatedAt ? ` · 生成于 ${new Date(brief.generatedAt).toLocaleString()}` : ''}
            {stale && ' · 历史存档'}
          </div>
          {!brief.sections && brief.text && (
            <pre className="brief-raw">{brief.text}</pre>
          )}
          {brief.sections && <div className="brief-grid">
            {SECTIONS.map(({ key, label, icon, hint }) => {
              const items = brief.sections?.[key] || [];
              return (
                <section className="brief-card" key={key}>
                  <div className="brief-card-head">
                    <b>{icon} {label}</b>
                    <span className="muted small">{items.length ? `${items.length} 条` : hint}</span>
                  </div>
                  {items.length === 0 && <div className="muted small pad">本次没有检索到内容</div>}
                  {items.map((item, i) => (
                    <div className="brief-item" key={`${key}-${i}`}>
                      <div className="brief-item-title">
                        {item.url ? (
                          <a href="#" onClick={(e) => { e.preventDefault(); openLink(item.url); }}
                            title={item.url}>{item.title}</a>
                        ) : item.title}
                      </div>
                      {item.summary && <div className="brief-item-summary">{item.summary}</div>}
                      {item.meta && <div className="brief-item-meta muted small">{item.meta}</div>}
                    </div>
                  ))}
                </section>
              );
            })}
          </div>}
        </>
      )}
    </div>
  );
}
