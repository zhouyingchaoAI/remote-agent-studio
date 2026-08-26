import React, { useEffect, useState, useMemo } from 'react';

/**
 * 异常日志页。
 *
 * 默认按指纹聚合而不是流水:同一个 bug 会产出几十条只有路径和行号不同的
 * 记录,「这个错出了 27 次、最近一次在 3 分钟前」才是能拿来排修复优先级的信息。
 * 需要看原始上下文时再展开单条。
 */

const CATEGORY_LABEL = {
  crash: '代码崩溃', auth: '认证', network: '网络/代理', quota: '额度/限流',
  install: '未安装', ssh: 'SSH', transfer: '文件传输', permission: '权限',
  unknown: '未分类'
};
/** 崩溃类是唯一必须改代码的,给它最扎眼的颜色 */
const CATEGORY_CLASS = {
  crash: 'cat-crash', auth: 'cat-warn', quota: 'cat-warn',
  network: 'cat-net', install: 'cat-warn', permission: 'cat-warn'
};

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

export default function ErrorLogPanel() {
  const [data, setData] = useState({ entries: [], groups: [] });
  const [cat, setCat] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [note, setNote] = useState('');

  const refresh = () => window.api.errors.list({ limit: 5000 })
    .then(setData).catch((e) => setNote(`读取失败:${e.message}`));

  useEffect(() => { refresh(); }, []);
  // 新异常实时插进来,不用手动刷
  useEffect(() => window.api.errors.onNew(() => refresh()), []);

  const counts = useMemo(() => {
    const m = {};
    for (const g of data.groups) m[g.category] = (m[g.category] || 0) + g.count;
    return m;
  }, [data.groups]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.groups.filter((g) => {
      if (cat && g.category !== cat) return false;
      if (!q) return true;
      return `${g.sample} ${g.sources.join(' ')}`.toLowerCase().includes(q);
    });
  }, [data.groups, cat, query]);

  const total = data.entries.length;

  return (
    <div className="errlog-panel">
      <div className="errlog-head">
        <h2 className="flex1">异常日志</h2>
        <span className="muted small">共 {total} 条 · {data.groups.length} 类</span>
        <button className="btn small" onClick={refresh}>刷新</button>
        <button className="btn small" onClick={async () => {
          const r = await window.api.errors.export().catch((e) => ({ error: e.message }));
          if (r?.path) setNote(`已导出到 ${r.path}`);
          else if (r?.error) setNote(`导出失败:${r.error}`);
        }}>导出</button>
        <button className="btn small ghost danger" onClick={async () => {
          if (!window.confirm(`清空全部 ${total} 条异常日志?此操作不可撤销。`)) return;
          await window.api.errors.clear();
          refresh();
        }}>清空</button>
      </div>

      <div className="errlog-filters">
        <button className={`chip ${cat === '' ? 'on' : ''}`} onClick={() => setCat('')}>全部</button>
        {Object.keys(CATEGORY_LABEL)
          .filter((c) => counts[c])
          .sort((a, b) => counts[b] - counts[a])
          .map((c) => (
            <button key={c} className={`chip ${CATEGORY_CLASS[c] || ''} ${cat === c ? 'on' : ''}`}
              onClick={() => setCat(cat === c ? '' : c)}>
              {CATEGORY_LABEL[c]} {counts[c]}
            </button>
          ))}
        <input className="errlog-search" value={query} placeholder="搜索报错内容 / 来源…"
          onChange={(e) => setQuery(e.target.value)} />
      </div>

      {note && <p className="muted small pad">{note}</p>}

      {groups.length === 0 ? (
        <div className="muted center pad">
          {total === 0
            ? '还没有记录到异常。对话报错、引擎崩溃、SSH 断连、传输失败都会自动进来。'
            : '没有匹配的记录'}
        </div>
      ) : (
        <div className="errlog-list">
          {groups.map((g) => (
            <div key={g.key} className="errlog-group">
              <div className="errlog-row" onClick={() => setExpanded(expanded === g.key ? null : g.key)}>
                <span className={`errlog-cat ${CATEGORY_CLASS[g.category] || ''}`}>
                  {CATEGORY_LABEL[g.category] || g.category}
                </span>
                <span className="errlog-count" title={`共出现 ${g.count} 次`}>×{g.count}</span>
                <span className="errlog-sample" title={g.sample}>{g.sample}</span>
                <span className="muted small errlog-time">{ago(g.lastSeen)}</span>
              </div>
              {expanded === g.key && (
                <div className="errlog-detail">
                  <dl className="engine-facts">
                    <dt>来源</dt><dd>{g.sources.join('、') || '—'}</dd>
                    <dt>主机</dt><dd>{g.hosts.join('、') || '—'}</dd>
                    <dt>首次</dt><dd>{new Date(g.firstSeen).toLocaleString()}</dd>
                    <dt>最近</dt><dd>{new Date(g.lastSeen).toLocaleString()}</dd>
                  </dl>
                  <pre className="errlog-text">{g.sample}</pre>
                  {g.detail && <pre className="errlog-text dim">{g.detail}</pre>}
                  <button className="btn small ghost" onClick={() => {
                    window.api.clipboard.writeText(
                      `[${CATEGORY_LABEL[g.category]}] ×${g.count}\n来源: ${g.sources.join('、')}\n\n${g.sample}\n\n${g.detail || ''}`
                    );
                    setNote('已复制(内容已脱敏,可直接贴 issue)');
                  }}>复制</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
