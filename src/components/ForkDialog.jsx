import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { slugify, slugProblem } from '../forkNames.js';

/**
 * 分路对话框:把一条攒了上下文的对话拆成几路,各做一个功能。
 *
 * 每路 = 一个 git worktree + 一条分支 + 一条独立对话。
 * **独立目录是前提**:共用目录的话几个智能体会同时改同一批文件,
 * 互相覆盖且事后查不出是谁改的 —— 那不是并行,是竞态。
 */
export default function ForkDialog({ conv, onClose }) {
  const [names, setNames] = useState(['', '']);
  const [repo, setRepo] = useState(null);      // null=检测中
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);

  useEffect(() => {
    let alive = true;
    window.api.worktree.detect({ hostId: conv.hostId, cwd: conv.cwd })
      .then((r) => { if (alive) setRepo(r); })
      .catch((e) => { if (alive) setRepo({ ok: false, error: e.message }); });
    return () => { alive = false; };
  }, [conv.hostId, conv.cwd]);

  const setName = (i, v) => setNames((cur) => cur.map((x, k) => (k === i ? v : x)));
  const filled = names.map((n) => n.trim()).filter(Boolean);
  /* 同名两路会指向同一个目录 —— 第二条必然报"已存在",
     不如在这儿就挡住,顺便把原因说清楚。 */
  const slugs = filled.map(slugify);
  const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
  const problem = filled.map(slugProblem).find(Boolean)
    || (dup ? `有两路的名字会变成同一个目录(${dup})` : '');

  const run = async () => {
    setBusy(true);
    const specs = filled.map((name) => ({ name, slug: slugify(name) }));
    const r = await useStore.getState().forkConversation(conv.id, specs);
    setResults(r);
    setBusy(false);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <b>分路「{conv.title}」</b>
          <button className="icon-btn" title="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          {repo === null && <p className="muted">正在检查工作目录…</p>}

          {repo && !repo.ok && (
            /* 说清楚为什么不能分路,以及怎么办 —— 只说"失败"等于没说 */
            <div className="fork-warn">
              <b>这个目录不能分路:{repo.error}</b>
              <p className="muted small">
                分路依赖 git worktree,需要工作目录在一个 git 仓库里。
                可以先在该目录执行 <code>git init</code> 并提交一次,再回来分路。
              </p>
            </div>
          )}

          {repo?.ok && !results && (
            <>
              <p className="muted small">
                仓库 <code>{repo.root}</code> · 当前分支 <code>{repo.branch}</code>
              </p>
              {repo.dirty && (
                /* 这条必须说:worktree 从**提交点**切出去,没提交的改动不会跟过去。
                   不提醒的话,分路里会发现"我刚改的东西不见了"。 */
                <div className="fork-warn">
                  ⚠ 当前有未提交的改动。分路是从最近一次提交切出去的,
                  这些改动<b>不会</b>出现在新分路里 —— 建议先提交再分路。
                </div>
              )}
              <p className="muted small">
                每一路会建一个 git worktree(<code>.worktrees/名字</code>)和一条分支,
                各自独立改代码,互不覆盖。主线对话的历史会作为背景带过去。
              </p>
              {names.map((n, i) => (
                <label className="settings-row" key={i}>
                  <span>第 {i + 1} 路</span>
                  <input value={n} placeholder="这一路做什么(如:登录优化)"
                    onChange={(e) => setName(i, e.target.value)} />
                </label>
              ))}
              <button className="btn small ghost" onClick={() => setNames((c) => [...c, ''])}>
                + 再加一路
              </button>
              {problem && <p className="error-text small">{problem}</p>}
              <div className="row gap" style={{ marginTop: 12 }}>
                <button className="btn" disabled={busy || filled.length < 1 || !!problem} onClick={run}>
                  {busy ? '创建中…' : `创建 ${filled.length} 路`}
                </button>
                <button className="btn ghost" onClick={onClose}>取消</button>
              </div>
            </>
          )}

          {results && (
            <>
              {/* 逐条报结果:建到第三条才失败时,前两条是真的建好了。
                  笼统一句"失败"会让人重来一次,然后撞上"目录已存在"。 */}
              <ul className="fork-results">
                {results.map((r) => (
                  <li key={r.name} className={r.ok ? 'ok' : 'bad'}>
                    {r.ok ? '✓' : '✗'} {r.name}
                    {r.ok
                      ? <span className="muted small"> → {r.branch}{r.reused ? '(复用已有分支)' : ''}</span>
                      : <span className="muted small"> {r.error}</span>}
                  </li>
                ))}
              </ul>
              <button className="btn" onClick={onClose}>完成</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
