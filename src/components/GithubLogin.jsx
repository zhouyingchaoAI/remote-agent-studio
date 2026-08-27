import React, { useEffect, useState } from 'react';

/**
 * GitHub 快捷登录卡片。
 *
 * 核心是把一次性码显示得足够大、足够好复制 —— 这是整个流程里唯一
 * 需要人动手的一步,其余全自动。授权链接会带上码,手机上点开就已填好,
 * 在 GitHub App 里点一下确认即可。
 *
 * token 全程由主机上的 gh 保管,不经过界面,所以这里也没有任何地方
 * 会显示或存储它。
 */
export default function GithubLogin({ hostId, isLocal }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [note, setNote] = useState('');

  const refresh = () => window.api.github.status({ hostId })
    .then(setStatus).catch((e) => setNote(e.message));

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [hostId]);
  useEffect(() => window.api.github.onProgress((p) => {
    if (p.hostId !== hostId) return;
    setProgress(p);
    if (p.finished) { setBusy(''); refresh(); }
  }), [hostId]);

  const login = async () => {
    setBusy('login'); setProgress(null); setNote('');
    try {
      const r = await window.api.github.login({ hostId });
      if (!r.done) setNote(`登录未完成${r.error ? `:${r.error}` : ''}\n${r.output || ''}`);
    } catch (e) { setNote(`登录失败:${e.message}`); }
    finally { setBusy(''); refresh(); }
  };

  const install = async () => {
    setBusy('install'); setNote('');
    try {
      const r = await window.api.github.install({ hostId });
      if (r.manual) setNote(`${r.note}\n${r.command}`);
      else setNote(r.ok ? `安装完成:${r.output}` : `安装失败:${r.output}`);
    } catch (e) { setNote(`安装失败:${e.message}`); }
    finally { setBusy(''); refresh(); }
  };

  const code = progress?.code;
  const openUrl = progress?.openUrl;

  return (
    <div className="gh-card">
      <div className="row gap">
        <b>GitHub 登录</b>
        <span className={`dot ${status?.loggedIn ? 'ready' : ''}`} />
        <span className="muted small">
          {!status ? '检测中…'
            : !status.installed ? '未安装 gh'
              : status.loggedIn
                ? `已登录 ${status.username}${status.scopes ? ` · ${status.scopes}` : ''}`
                : '已安装,未登录'}
        </span>
        <span className="flex1" />
        <button className="btn small ghost" disabled={!!busy} onClick={refresh}>重新检测</button>
        {status && !status.installed && (
          <button className="btn small" disabled={!!busy} onClick={install}>
            {busy === 'install' ? '安装中…' : '安装 gh'}
          </button>
        )}
        {status?.installed && (
          <button className="btn small primary" disabled={!!busy} onClick={login}>
            {busy === 'login' ? '等待授权…' : (status.loggedIn ? '重新登录' : '登录 GitHub')}
          </button>
        )}
        {busy === 'login' && (
          <button className="btn small ghost" onClick={() => {
            window.api.github.cancel({ hostId }); setBusy(''); setProgress(null);
          }}>取消</button>
        )}
      </div>

      {busy === 'login' && !code && (
        <p className="muted small">正在向 GitHub 申请一次性码…</p>
      )}

      {code && !progress?.done && (
        <div className="gh-device">
          <div className="gh-code-label muted small">在 GitHub 上输入这个一次性码:</div>
          <div className="gh-code" onClick={() => {
            window.api.clipboard.writeText(code); setNote('一次性码已复制');
          }} title="点击复制">{code}</div>
          <div className="row gap">
            <button className="btn small primary"
              onClick={() => window.api.shell.openExternal(openUrl)}>
              打开授权页(已填好码)
            </button>
            <button className="btn small ghost"
              onClick={() => { window.api.clipboard.writeText(openUrl); setNote('链接已复制,可发到手机上打开'); }}>
              复制链接
            </button>
          </div>
          <p className="muted small">
            手机上打开这个链接会直接唤起 GitHub App,码已经填好,点一下确认即可。
            确认后这里会自动完成,不用回来点任何按钮。
          </p>
        </div>
      )}

      {progress?.done && (
        <p className="small">
          ✓ 已登录 <b>{progress.username}</b>
          {progress.gitConfigured
            ? ' · git push/pull 免密已配好'
            : <span className="error-text"> · git 凭据助手没配上:{progress.gitMessage}</span>}
        </p>
      )}

      {note && <pre className="gh-note muted small">{note}</pre>}
      <p className="muted small">
        登录走 gh 自己的设备流,{isLocal ? '凭据存在本机' : '凭据存在这台远程主机上'} ——
        token 不经过本应用,也不会写进日志。
      </p>
    </div>
  );
}
