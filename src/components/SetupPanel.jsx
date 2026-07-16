import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store.js';

export default function SetupPanel({ hostId, host }) {
  const isLocal = hostId === 'local';
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
    } catch (e) { useStore.getState().appendSetupLog(hostId, `检测失败: ${e.message}\n`); }
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
    if (!apiKey.trim()) throw new Error('请输入 API Key');
    await window.api.setup.setApiKey({ hostId, agent: apiAgent, key: apiKey.trim() });
    setApiKey('');
  });

  if (status !== 'connected')
    return <div className="empty-state"><p className="muted">请先连接主机</p></div>;

  return (
    <div className="setup-panel">
      <div className="setup-left">
        <section>
          <h3>{isLocal ? '本机环境' : '远程环境'} <button className="btn small ghost" onClick={detect} disabled={busy}>刷新</button></h3>
          <table className="env-table"><tbody>
            <tr><td>系统</td><td>{env?.os || '-'}</td></tr>
            <tr><td>Node.js</td><td>{env?.node || <Miss />}</td></tr>
            <tr><td>Codex</td><td>{env?.codex || <Miss />}</td></tr>
            <tr><td>Claude Code</td><td>{env?.claude || <Miss />}</td></tr>
          </tbody></table>
          <div className="row gap">
            <button className="btn primary" disabled={busy} onClick={install('codex')}>
              {env?.codex ? '升级 Codex 到最新' : '一键安装 Codex'}
            </button>
            <button className="btn primary" disabled={busy} onClick={install('claude')}>
              {env?.claude ? '升级 Claude Code 到最新' : '一键安装 Claude Code'}
            </button>
          </div>
          <p className="muted small">
            {isLocal
              ? '本机通过 npm 安装/升级到最新版;若是 Homebrew 安装的,请在终端运行 brew upgrade。'
              : '缺少 Node.js 时会自动通过 nvm 安装(免 root);安装走下方代理配置。'}
          </p>
        </section>

        {!isLocal && <section>
          <h3>网络代理</h3>
          <label className="radio">
            <input type="radio" checked={proxyMode === 'direct'} onChange={() => setProxyMode('direct')} />
            <b>局域网代理直连(默认)</b> — 远程直接访问本机/局域网代理
          </label>
          {proxyMode === 'direct' && (
            <div className="form-grid indent">
              <label className="row checkbox">
                <input type="checkbox" checked={directAutoIp} onChange={(e) => setDirectAutoIp(e.target.checked)} />
                自动使用本机当前 IP(推荐,IP 变化后每次连接自动重新解析)
              </label>
              {directAutoIp ? (
                <label>代理端口
                  <div className="row" style={{ gap: 8 }}>
                    <input value={directPort} onChange={(e) => setDirectPort(e.target.value)} placeholder="7890" style={{ maxWidth: 120 }} />
                    <span className="muted small">
                      当前解析: {lanIp ? `http://${lanIp}:${directPort || '7890'}` : '检测中...'}
                      <button className="btn small ghost" type="button" onClick={refreshLanIp} style={{ marginLeft: 6 }}>刷新</button>
                    </span>
                  </div>
                </label>
              ) : (
                <label>代理地址(固定)
                  <input value={directProxyUrl} onChange={(e) => setDirectProxyUrl(e.target.value)} placeholder="http://192.168.1.10:7890" />
                </label>
              )}
              <p className="muted small">远程会 export HTTP_PROXY/HTTPS_PROXY 指向此地址。需确保本机 Clash 已开启「允许局域网连接」,且远程与本机网络可达。</p>
            </div>
          )}
          <label className="radio">
            <input type="radio" checked={proxyMode === 'tunnel'} onChange={() => setProxyMode('tunnel')} />
            <b>SSH 反向隧道</b> — 远程借道本机代理上网(远程连不上本机 IP 时用)
          </label>
          {proxyMode === 'tunnel' && (
            <div className="form-grid indent">
              <label>本机侧代理地址<input value={localProxyHost} onChange={(e) => setLocalProxyHost(e.target.value)} placeholder="127.0.0.1 或局域网 IP" /></label>
              <label>本机侧代理端口<input value={localProxyPort} onChange={(e) => setLocalProxyPort(e.target.value)} placeholder="7890" /></label>
              <label>远程监听端口<input value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="18080" /></label>
            </div>
          )}
          <label className="radio">
            <input type="radio" checked={proxyMode === 'none'} onChange={() => setProxyMode('none')} />
            不使用代理 / 清除配置
          </label>
          <button className="btn primary" disabled={busy} onClick={configureProxy}>应用代理配置并测试</button>
        </section>}

        <section>
          <h3>本机 Codex 认证</h3>
          <LocalCodexCard />
          {!isLocal && <div className="row gap" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy}
              onClick={run(() => window.api.setup.syncAuth({ hostId, agent: 'codex' }))}>
              下发 Codex 认证到远程
            </button>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.syncAuth({ hostId, agent: 'claude' }))}>
              下发 Claude 认证
            </button>
          </div>}
          {!isLocal && <p className="muted small">把本机已登录的 ~/.codex/auth.json(+config.toml)复制到远程同路径,远程免登录直接使用。下发后会自动测试远程可用性。</p>}
          {!isLocal && <div className="row gap" style={{ marginTop: 6 }}>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'codex' }))}>
              测试远程 Codex
            </button>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'claude' }))}>
              测试远程 Claude
            </button>
          </div>}
        </section>

        {!isLocal && <section>
          <h3>API Key(可选)</h3>
          <p className="muted small">也可以在「终端」页运行 codex login / claude 交互登录。</p>
          <div className="row gap">
            <select value={apiAgent} onChange={(e) => setApiAgent(e.target.value)}>
              <option value="claude">ANTHROPIC_API_KEY</option>
              <option value="codex">OPENAI_API_KEY</option>
            </select>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." style={{ flex: 1 }} />
            <button className="btn" disabled={busy} onClick={saveKey}>写入远程</button>
          </div>
        </section>}
      </div>

      <div className="setup-right">
        <div className="row">
          <h3 className="flex1">日志</h3>
          <button className="btn small ghost" title="导出应用诊断信息(版本/平台/最近日志)"
            onClick={async () => {
              const r = await window.api.setup.exportDiagnostics().catch(() => null);
              if (r?.saved) useStore.getState().appendSetupLog(hostId, `诊断信息已导出: ${r.path}\n`);
            }}>导出诊断</button>
          <button className="btn small ghost" onClick={() => useStore.getState().clearSetupLog(hostId)}>清空</button>
        </div>
        <pre className="log-box" ref={logRef}>{log || '(暂无日志)'}</pre>
      </div>
    </div>
  );
}

const Miss = () => <span className="error-text">未安装</span>;

function LocalCodexCard() {
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
        <tr><td>本机 CLI</td><td>{info?.cliVersion || <span className="muted">未在 PATH 找到</span>}</td></tr>
        <tr><td>认证文件</td><td>
          {!info ? '检测中...' :
            info.hasAuth ? <span className="ok">存在</span> : <span className="error-text">未找到 ~/.codex/auth.json</span>}
        </td></tr>
        <tr><td>认证状态</td><td>
          {!info ? '-' :
            ok ? <span className="ok">✓ 已配置({info.account || '有效'})</span>
               : <span className="error-text">无效或未登录,请先在本机运行 codex 登录</span>}
        </td></tr>
      </tbody></table>
      <button className="btn small" onClick={test} disabled={testing}>
        {testing ? '检测中...' : '测试本机 Codex 配置'}
      </button>
    </div>
  );
}
