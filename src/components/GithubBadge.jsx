import React, { useEffect, useState } from 'react';
import GithubLogin from './GithubLogin.jsx';

/**
 * 对话顶栏的 GitHub 状态徽标。
 *
 * 和旁边的引擎徽标一个道理:要 push 代码的时候人在对话页,发现没登录还得
 * 切到环境配置、找到卡片、登完再切回来。状态和操作都该出现在干活的地方。
 *
 * 弹层里直接复用环境配置页那张卡片 —— 登录流程只有一份实现,
 * 两处的行为不会漂移。
 */
export default function GithubBadge({ hostId, isLocal, hostLabel }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);

  const refresh = () => window.api.github.status({ hostId })
    .then(setStatus).catch(() => setStatus(null));

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [hostId]);
  // 弹层里登录成功后徽标要跟着变,否则得手动关开一次才刷新
  useEffect(() => window.api.github.onProgress((p) => {
    if (p.hostId === hostId && p.finished) refresh();
  }), [hostId]);

  const level = !status ? 'unknown' : status.loggedIn ? 'ready' : 'missing';
  const text = !status ? 'GitHub'
    : status.loggedIn ? status.username
      : status.installed ? '未登录' : '未装 gh';

  return (
    <div className="engine-status">
      <button className={`engine-badge ${level}`} onClick={() => setOpen((v) => !v)}
        title={status?.loggedIn
          ? `GitHub 已登录 ${status.username}${status.scopes ? ` · ${status.scopes}` : ''}`
          : 'GitHub 登录(点开可直接登录,不用切到环境配置)'}>
        <span className="dot" />
        {text}
      </button>

      {open && (
        <>
          <div className="engine-pop-backdrop" onClick={() => setOpen(false)} />
          <div className="engine-pop wide">
            <div className="engine-pop-head">
              <b>GitHub</b>
              <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
            </div>
            <GithubLogin hostId={hostId} isLocal={isLocal} hostLabel={hostLabel} />
          </div>
        </>
      )}
    </div>
  );
}
