import React, { useEffect, useState } from 'react';

/**
 * 镜像仓库登录(Harbor / Docker Hub / 任意 registry)。
 *
 * 与 GitHub 那套的关键差别:registry 没有设备流,只能账号密码。所以界面上
 * 的重点是把"密码去哪了"讲清楚 —— 它走 stdin 直达 docker,不上命令行;
 * 勾了保存才会加密存在本机,而且系统加密不可用时会明确拒绝,不悄悄降级。
 */

const HUB = 'docker.io';

export default function RegistryLogin({ hostId, isLocal, hostLabel }) {
  const [status, setStatus] = useState(null);
  const [saved, setSaved] = useState({ items: [], encryptionAvailable: true });
  const [form, setForm] = useState({ id: '', registry: '', username: '', secret: '', remember: true });
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [advice, setAdvice] = useState('');

  const refresh = () => {
    window.api.registry.status({ hostId }).then(setStatus).catch((e) => setNote(e.message));
    window.api.registry.list().then(setSaved).catch(() => {});
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [hostId]);

  const pickSaved = (id) => {
    const it = saved.items.find((x) => x.id === id);
    if (!it) { setForm({ id: '', registry: '', username: '', secret: '', remember: true }); return; }
    // 不回填密码 —— 界面拿不到它,也不该假装拿得到
    setForm({ id: it.id, registry: it.registry, username: it.username, secret: '', remember: true });
  };

  const login = async () => {
    setBusy('login'); setNote(''); setAdvice('');
    try {
      /* 先存后登:存失败(比如系统加密不可用)要让用户当场知道,
         而不是登录成功之后才发现"怎么没记住"。 */
      let id = form.id;
      if (form.remember && form.secret) {
        const r = await window.api.registry.save({
          id: id || undefined, registry: form.registry || HUB,
          username: form.username, secret: form.secret
        });
        id = r.id;
      }
      const r = await window.api.registry.login({
        hostId, id: id || undefined,
        registry: form.registry || HUB, username: form.username,
        secret: form.secret || undefined
      });
      setNote(r.ok ? `✓ ${r.message}(${r.registry || 'Docker Hub'} · ${r.username})` : `✗ ${r.message}`);
      if (r.advice) setAdvice(r.advice);
      // 密码用完即从界面清掉,不在输入框里长期驻留
      setForm((f) => ({ ...f, id, secret: '' }));
    } catch (e) { setNote(`登录失败:${e.message}`); }
    finally { setBusy(''); refresh(); }
  };

  const diagnose = async () => {
    setBusy('diag'); setNote(''); setAdvice('');
    try {
      const r = await window.api.registry.diagnose({ hostId, registry: form.registry || HUB });
      setNote(`${r.facts}\n\n${r.ok ? '✓ ' : '✗ '}${r.message}`);
      if (r.advice) setAdvice(r.advice);
    } catch (e) { setNote(`诊断失败:${e.message}`); }
    finally { setBusy(''); }
  };

  const loginAllHosts = async () => {
    if (!form.id) { setNote('先保存一条凭据,才能一键登录多台主机'); return; }
    setBusy('many'); setNote('');
    try {
      const hosts = await window.api.hosts.list();
      const ids = ['local', ...hosts.map((h) => h.id)];
      const { results } = await window.api.registry.loginMany({ hostIds: ids, id: form.id });
      setNote(results.map((r) => `${r.hostId}: ${r.ok ? '✓ 成功' : `✗ ${r.message}`}`).join('\n'));
    } catch (e) { setNote(`批量登录失败:${e.message}`); }
    finally { setBusy(''); refresh(); }
  };

  const dockerBad = status && (!status.installed || status.daemonUp === false);

  return (
    <div className="gh-card">
      <div className="row gap">
        <b>镜像仓库 · {isLocal ? '本机' : (hostLabel || '这台远程主机')}</b>
        <span className={`dot ${status?.logins?.length ? 'ready' : ''}`} />
        <span className="muted small">
          {!status ? '检测中…'
            : !status.installed ? '未安装 docker'
              : status.daemonUp === false ? 'docker 未运行'
                : status.logins.length ? `已登录 ${status.logins.length} 个仓库` : '未登录任何仓库'}
        </span>
        <span className="flex1" />
        <button className="btn small ghost" disabled={!!busy} onClick={refresh}>重新检测</button>
      </div>

      {dockerBad && <p className="error-text small">{status.message}</p>}

      {status?.logins?.length > 0 && (
        <div className="reg-list">
          {status.logins.map((l) => (
            <div key={l.configKey} className="reg-row">
              <span className="reg-name">{l.label}</span>
              <span className="muted small">
                {l.username || (l.viaHelper ? '(凭据助手托管)' : '(无用户名)')}
              </span>
              <span className="flex1" />
              <button className="btn tiny ghost" disabled={!!busy} onClick={async () => {
                await window.api.registry.logout({ hostId, registry: l.configKey });
                refresh();
              }}>登出</button>
            </div>
          ))}
        </div>
      )}

      <div className="reg-form">
        {saved.items.length > 0 && (
          <label className="reg-field">
            <span className="muted small">已存凭据</span>
            <select value={form.id} onChange={(e) => pickSaved(e.target.value)}>
              <option value="">— 新建 —</option>
              {saved.items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.registry || 'Docker Hub'} · {it.username}{it.hasSecret ? '' : '(无密码)'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="reg-field">
          <span className="muted small">仓库地址</span>
          <input value={form.registry} placeholder="留空 = Docker Hub;Harbor 填 harbor.example.com"
            onChange={(e) => setForm({ ...form, registry: e.target.value })} />
        </label>
        <label className="reg-field">
          <span className="muted small">用户名</span>
          <input value={form.username} placeholder="Harbor 机器人账号形如 robot$ci"
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </label>
        <label className="reg-field">
          <span className="muted small">密码 / 令牌</span>
          <input type="password" value={form.secret}
            placeholder={form.id && !form.secret ? '留空则用已保存的密码' : '密码或访问令牌'}
            onChange={(e) => setForm({ ...form, secret: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') login(); }} />
        </label>
        <div className="row gap">
          <label className="check-row inline" title={saved.encryptionAvailable
            ? '用系统钥匙串加密后存在本机'
            : '系统加密不可用,保存会被拒绝'}>
            <input type="checkbox" checked={form.remember} disabled={!saved.encryptionAvailable}
              onChange={(e) => setForm({ ...form, remember: e.target.checked })} />
            <span className="small">记住(加密存本机)</span>
          </label>
          <span className="flex1" />
          {form.id && (
            <button className="btn small" disabled={!!busy} onClick={loginAllHosts}
              title="用这条凭据依次登录本机与所有远程主机">
              {busy === 'many' ? '批量登录中…' : '登录到所有主机'}
            </button>
          )}
          <button className="btn small ghost" disabled={!!busy} onClick={diagnose}
            title="分别检查 shell 与 docker 守护进程能不能连到这个仓库">
            {busy === 'diag' ? '诊断中…' : '诊断网络'}
          </button>
          <button className="btn small primary" disabled={!!busy || !form.username} onClick={login}>
            {busy === 'login' ? '登录中…' : '登录'}
          </button>
          {form.id && (
            <button className="btn small ghost danger" disabled={!!busy} onClick={async () => {
              if (!window.confirm('删除这条已保存的凭据?')) return;
              await window.api.registry.remove({ id: form.id });
              setForm({ id: '', registry: '', username: '', secret: '', remember: true });
              refresh();
            }}>删除凭据</button>
          )}
        </div>
      </div>

      {!saved.encryptionAvailable && (
        <p className="error-text small">
          系统加密不可用(Linux 上多为缺 keyring/libsecret),保存密码会被拒绝 ——
          明文存密码比不提供这个功能更糟。你仍可以每次手动输入登录。
        </p>
      )}
      {note && <pre className="gh-note muted small">{note}</pre>}
      {advice && <pre className="gh-note">{advice}</pre>}
      <p className="muted small">
        密码走 stdin 直达 docker,不拼进命令行 —— 命令行在 `ps` 里对同机所有进程可见,
        还会进 shell history。登录态由 docker 保存在这台主机的 ~/.docker/config.json。
      </p>
    </div>
  );
}
