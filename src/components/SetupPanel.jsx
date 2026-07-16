import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store.js';
import { translate as tr } from '../i18n.mjs';

export default function SetupPanel({ hostId, host }) {
  const isLocal = hostId === 'local';
  const language = useStore((s) => s.settings.language);
  const t = (key) => tr(language, key);
  const env = useStore((s) => s.envInfo[hostId]);
  const log = useStore((s) => s.setupLogs[hostId] || '');
  const status = useStore((s) => s.statuses[hostId] || 'disconnected');
  const [busy, setBusy] = useState(false);
  const [proxyMode, setProxyMode] = useState('direct');
  const [localProxyHost, setLocalProxyHost] = useState('127.0.0.1');
  const [localProxyPort, setLocalProxyPort] = useState('7890');
  const [directProxyUrl, setDirectProxyUrl] = useState('');
  const [directAutoIp, setDirectAutoIp] = useState(true); // 自动用本机当前IP
  const [directPort, setDirectPort] = useState('7890');
  const [lanIp, setLanIp] = useState('');
  const [remotePort, setRemotePort] = useState('18080');
  const [apiAgent, setApiAgent] = useState('claude');
  const [apiKey, setApiKey] = useState('');
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const detect = async () => {
    setBusy(true);
    try {
      const info = await window.api.setup.detect(hostId);
      useStore.getState().setEnvInfo(hostId, info);
    } catch (e) { useStore.getState().appendSetupLog(hostId, `${t('detectionFailed')}: ${e.message}\n`); }
    setBusy(false);
  };

  useEffect(() => { if (status === 'connected' && !env) detect(); }, [status]);

  const run = (fn) => async () => {
    setBusy(true);
    try { await fn(); await detect(); }
    catch (e) { useStore.getState().appendSetupLog(hostId, `❌ ${e.message}\n`); }
    setBusy(false);
  };

  // 进入页面/切到直连模式时实时检测本机当前 IP
  const refreshLanIp = async () => {
    try { const { ip } = await window.api.setup.lanIp(hostId); setLanIp(ip || ''); }
    catch (_) {}
  };
  useEffect(() => { refreshLanIp(); }, []);
  useEffect(() => { if (proxyMode === 'direct') refreshLanIp(); }, [proxyMode]);

  const configureProxy = run(async () => {
    let cfg;
    if (proxyMode === 'none') cfg = { mode: 'none' };
    else if (proxyMode === 'tunnel')
      cfg = { mode: 'tunnel', localProxyHost, localProxyPort: Number(localProxyPort), remotePort: Number(remotePort) };
    else if (directAutoIp)
      cfg = { mode: 'direct', autoLanIp: true, port: Number(directPort) || 7890 };
    else
      cfg = { mode: 'direct', directProxyUrl };
    await window.api.setup.configureProxy({ hostId, cfg });
  });

  const install = (agent) => run(async () => {
    await window.api.setup.installAgent({ hostId, agent });
  });

  const saveKey = run(async () => {
    if (!apiKey.trim()) throw new Error(t('apiKeyRequired'));
    await window.api.setup.setApiKey({ hostId, agent: apiAgent, key: apiKey.trim() });
    setApiKey('');
  });

  if (status !== 'connected')
    return <div className="empty-state"><p className="muted">{t('connectHostFirst')}</p></div>;

  return (
    <div className="setup-panel">
      <div className="setup-left">
        <section>
          <h3>{isLocal ? t('localEnvironment') : t('remoteEnvironment')} <button className="btn small ghost" onClick={detect} disabled={busy}>{t('refresh')}</button></h3>
          <table className="env-table"><tbody>
            <tr><td>{t('operatingSystem')}</td><td>{env?.os || '-'}</td></tr>
            <tr><td>Node.js</td><td>{env?.node || <Miss t={t} />}</td></tr>
            <tr><td>Codex</td><td>{env?.codex || <Miss t={t} />}</td></tr>
            <tr><td>Claude Code</td><td>{env?.claude || <Miss t={t} />}</td></tr>
          </tbody></table>
          <div className="row gap">
            <button className="btn primary" disabled={busy} onClick={install('codex')}>
              {env?.codex ? t('upgradeCodex') : t('installCodex')}
            </button>
            <button className="btn primary" disabled={busy} onClick={install('claude')}>
              {env?.claude ? t('upgradeClaude') : t('installClaude')}
            </button>
          </div>
          <p className="muted small">
            {isLocal
              ? t('localInstallHint') : t('remoteInstallHint')}
          </p>
        </section>

        {!isLocal && <section>
          <h3>{t('networkProxy')}</h3>
          <label className="radio">
            <input type="radio" checked={proxyMode === 'direct'} onChange={() => setProxyMode('direct')} />
            <b>{t('directProxy')}</b> — {t('directProxyHint')}
          </label>
          {proxyMode === 'direct' && (
            <div className="form-grid indent">
              <label className="row checkbox">
                <input type="checkbox" checked={directAutoIp} onChange={(e) => setDirectAutoIp(e.target.checked)} />
                {t('autoLanIp')}
              </label>
              {directAutoIp ? (
                <label>{t('proxyPort')}
                  <div className="row" style={{ gap: 8 }}>
                    <input value={directPort} onChange={(e) => setDirectPort(e.target.value)} placeholder="7890" style={{ maxWidth: 120 }} />
                    <span className="muted small">
                      {t('currentResolution')}: {lanIp ? `http://${lanIp}:${directPort || '7890'}` : t('resolving')}
                      <button className="btn small ghost" type="button" onClick={refreshLanIp} style={{ marginLeft: 6 }}>{t('refresh')}</button>
                    </span>
                  </div>
                </label>
              ) : (
                <label>{t('fixedProxyAddress')}
                  <input value={directProxyUrl} onChange={(e) => setDirectProxyUrl(e.target.value)} placeholder="http://192.168.1.10:7890" />
                </label>
              )}
              <p className="muted small">{t('proxyExplanation')}</p>
            </div>
          )}
          <label className="radio">
            <input type="radio" checked={proxyMode === 'tunnel'} onChange={() => setProxyMode('tunnel')} />
            <b>{t('reverseTunnel')}</b> — {t('reverseTunnelHint')}
          </label>
          {proxyMode === 'tunnel' && (
            <div className="form-grid indent">
              <label>{t('localProxyAddress')}<input value={localProxyHost} onChange={(e) => setLocalProxyHost(e.target.value)} placeholder="127.0.0.1" /></label>
              <label>{t('localProxyPort')}<input value={localProxyPort} onChange={(e) => setLocalProxyPort(e.target.value)} placeholder="7890" /></label>
              <label>{t('remoteListenPort')}<input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="18080" /></label>
            </div>
          )}
          <label className="radio">
            <input type="radio" checked={proxyMode === 'none'} onChange={() => setProxyMode('none')} />
            {t('noProxy')}
          </label>
          <button className="btn primary" disabled={busy} onClick={configureProxy}>{t('applyProxy')}</button>
        </section>}

        <section>
          <h3>{t('localCodexAuth')}</h3>
          <LocalCodexCard language={language} />
          {!isLocal && <div className="row gap" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy}
              onClick={run(() => window.api.setup.syncAuth({ hostId, agent: 'codex' }))}>
              {t('syncCodexAuth')}
            </button>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.syncAuth({ hostId, agent: 'claude' }))}>
              {t('syncClaudeAuth')}
            </button>
          </div>}
          {!isLocal && <p className="muted small">{t('authSyncHint')}</p>}
          {!isLocal && <div className="row gap" style={{ marginTop: 6 }}>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'codex' }))}>
              {t('testRemoteCodex')}
            </button>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'claude' }))}>
              {t('testRemoteClaude')}
            </button>
          </div>}
        </section>

        {!isLocal && <section>
          <h3>{t('optionalApiKey')}</h3>
          <p className="muted small">{t('apiKeyHint')}</p>
          <div className="row gap">
            <select value={apiAgent} onChange={(e) => setApiAgent(e.target.value)}>
              <option value="claude">ANTHROPIC_API_KEY</option>
              <option value="codex">OPENAI_API_KEY</option>
            </select>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." style={{ flex: 1 }} />
            <button className="btn" disabled={busy} onClick={saveKey}>{t('saveToRemote')}</button>
          </div>
        </section>}
      </div>

      <div className="setup-right">
        <div className="row">
          <h3 className="flex1">{t('logs')}</h3>
          <button className="btn small ghost" title={t('diagnosticsTitle')}
            onClick={async () => {
              const r = await window.api.setup.exportDiagnostics().catch(() => null);
              if (r?.saved) useStore.getState().appendSetupLog(hostId, `${t('diagnosticsExported')}: ${r.path}\n`);
            }}>{t('exportDiagnostics')}</button>
          <button className="btn small ghost" onClick={() => useStore.getState().clearSetupLog(hostId)}>{t('clear')}</button>
        </div>
        <pre className="log-box" ref={logRef}>{log || t('noLogs')}</pre>
      </div>
    </div>
  );
}

const Miss = ({ t }) => <span className="error-text">{t('notInstalled')}</span>;

function LocalCodexCard({ language }) {
  const t = (key) => tr(language, key);
  const [info, setInfo] = useState(null);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try { setInfo(await window.api.setup.detectLocalCodex()); }
    catch (e) { setInfo({ error: e.message }); }
    setTesting(false);
  };
  useEffect(() => { test(); }, []);

  const ok = info && info.hasAuth && info.authValid;
  return (
    <div className="local-codex-card">
      <table className="env-table"><tbody>
        <tr><td>{t('localCli')}</td><td>{info?.cliVersion || <span className="muted">{t('notFoundInPath')}</span>}</td></tr>
        <tr><td>{t('authFile')}</td><td>
          {!info ? t('resolving') :
            info.hasAuth ? <span className="ok">{t('exists')}</span> : <span className="error-text">~/.codex/auth.json</span>}
        </td></tr>
        <tr><td>{t('authStatus')}</td><td>
          {!info ? '-' :
            ok ? <span className="ok">✓ {info.account || t('valid')}</span>
               : <span className="error-text">{t('invalidAuth')}</span>}
        </td></tr>
      </tbody></table>
      <button className="btn small" onClick={test} disabled={testing}>
        {testing ? t('resolving') : t('testLocalCodex')}
      </button>
    </div>
  );
}
