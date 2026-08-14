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
            <tr><td>Grok CLI</td><td>{env?.grok || <Miss />}</td></tr>
          </tbody></table>
          <div className="row gap">
            <button className="btn primary" disabled={busy} onClick={install('codex')}>
              {env?.codex ? '升级 Codex 到最新' : '一键安装 Codex'}
            </button>
            <button className="btn primary" disabled={busy} onClick={install('claude')}>
              {env?.claude ? '升级 Claude Code 到最新' : '一键安装 Claude Code'}
            </button>
            <button className="btn primary" disabled={busy} onClick={install('grok')}
              title="国产模型引擎依赖 grok CLI(xai-org/grok-build 官方独立二进制)">
              {env?.grok ? '升级 Grok CLI 到最新' : '一键安装 Grok CLI'}
            </button>
          </div>
          <p className="muted small">
            {isLocal
              ? '本机通过 npm 安装/升级到最新版;若是 Homebrew 安装的,请在终端运行 brew upgrade。'
              : '缺少 Node.js 时会自动通过 nvm 安装(免 root);安装走下方代理配置。'}
          </p>
        </section>

        {!isLocal && <Fold title="网络代理" hint="远程如何访问外网">

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
        </Fold>}

        <Fold title="认证与下发" hint="本机登录状态,以及把凭据下发到远程" defaultOpen>
          <LocalCodexCard />
          {!isLocal && <div className="row gap" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy}
              onClick={run(() => window.api.setup.syncAuth({ hostId, agent: 'codex' }))}>
              下发 Codex 认证到远程
            </button>
          </div>}
          {!isLocal && <p className="muted small">把本机已登录的 ~/.codex/auth.json(+config.toml)复制到远程同路径,远程免登录直接使用。下发后会自动测试远程可用性。</p>}

          <h3 style={{ marginTop: 18 }}>本机 Claude Code 认证</h3>
          <LocalClaudeCard isLocal={isLocal} busy={busy}
            onSync={run(() => window.api.setup.syncAuth({ hostId, agent: 'claude' }))} />
          {!isLocal && <div className="row gap" style={{ marginTop: 6 }}>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'codex' }))}>
              测试远程 Codex
            </button>
            <button className="btn" disabled={busy}
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'claude' }))}>
              测试远程 Claude
            </button>
            <button className="btn" disabled={busy}
              title="DeepSeek 基于 Claude Code CLI + DeepSeek 官方 Anthropic 兼容端点,需先写入 DEEPSEEK_API_KEY"
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'deepseek' }))}>
              测试远程 DeepSeek
            </button>
            <button className="btn" disabled={busy}
              title="国产模型引擎:grok CLI + 各家 OpenAI 兼容端点,默认用 DeepSeek(需 DEEPSEEK_API_KEY)"
              onClick={run(() => window.api.setup.testRemoteAgent({ hostId, agent: 'grok' }))}>
              测试国产模型(Grok)
            </button>
          </div>}
        </Fold>

        {!isLocal && <Fold title="API Key(可选)" hint="也可在「终端」页交互登录">
          <p className="muted small">也可以在「终端」页运行 codex login / claude 交互登录。</p>
          <div className="row gap">
            <select value={apiAgent} onChange={(e) => setApiAgent(e.target.value)}>
              <option value="claude">ANTHROPIC_API_KEY</option>
              <option value="codex">OPENAI_API_KEY</option>
              <option value="deepseek">DEEPSEEK_API_KEY(DeepSeek)</option>
              <option value="glm">ZHIPU_API_KEY(智谱 GLM)</option>
              <option value="kimi">MOONSHOT_API_KEY(Kimi)</option>
              <option value="qwen">DASHSCOPE_API_KEY(通义 Qwen)</option>
              <option value="minimax">MINIMAX_API_KEY(MiniMax)</option>
            </select>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." style={{ flex: 1 }} />
            <button className="btn" disabled={busy} onClick={saveKey}>写入远程</button>
          </div>
        </Fold>}

        {!isLocal && <GrokModelsManager hostId={hostId} busy={busy} setBusy={setBusy} />}
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

/* 预设国产 provider(仅用于界面展示/一键填充,真正配置由后端受管块生成) */
const GROK_PRESETS = [
  { label: 'DeepSeek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY' },
  { label: '智谱 GLM', model: 'glm-5', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', envKey: 'ZHIPU_API_KEY' },
  { label: '月之暗面 Kimi', model: 'kimi-k2.5', baseUrl: 'https://api.moonshot.cn/v1', envKey: 'MOONSHOT_API_KEY' },
  { label: '通义 Qwen', model: 'qwen3.5-coder', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY' },
  { label: 'MiniMax', model: 'minimax-m2.5', baseUrl: 'https://api.minimax.chat/v1', envKey: 'MINIMAX_API_KEY' }
];
const BLANK_MODEL = { label: '', model: '', baseUrl: '', apiBackend: 'chat_completions', envKey: '', apiKey: '' };

/**
 * 国产模型(Grok)端点可视化管理:全部在界面完成,不需手改 config.toml。
 * - 预设 provider 一键写 Key
 * - 自定义端点(中转站/其它兼容服务)增删:显示名/模型ID/base_url/协议/env 变量/Key
 * - 一键同步到远程 ~/.grok/config.toml
 */
function GrokModelsManager({ hostId, busy, setBusy }) {
  const grokModels = useStore((s) => s.settings.grokModels || []);
  const apply = useStore((s) => s.applySettings);
  const [form, setForm] = useState(BLANK_MODEL);
  const [presetKeys, setPresetKeys] = useState({}); // envKey -> 输入中的 key

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const wrap = (fn) => async () => {
    setBusy(true);
    try { await fn(); }
    catch (e) { useStore.getState().appendSetupLog(hostId, `❌ ${e.message}\n`); }
    setBusy(false);
  };

  const savePresetKey = (envKey) => wrap(async () => {
    const key = (presetKeys[envKey] || '').trim();
    if (!key) throw new Error('请输入 API Key');
    await window.api.setup.setEnvKey({ hostId, envKey, key });
    setPresetKeys((m) => ({ ...m, [envKey]: '' }));
    await window.api.setup.syncGrokConfig({ hostId });
  })();

  const addModel = wrap(async () => {
    const label = form.label.trim(), model = form.model.trim(), baseUrl = form.baseUrl.trim();
    const envKey = form.envKey.trim();
    if (!label || !model || !baseUrl) throw new Error('显示名 / 模型 ID / base_url 必填');
    if (envKey && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) throw new Error('env 变量名不合法');
    const next = [...grokModels, { id: `gm_${Date.now()}`, label, model, baseUrl, apiBackend: form.apiBackend, envKey }];
    apply({ grokModels: next });
    if (envKey && form.apiKey.trim()) await window.api.setup.setEnvKey({ hostId, envKey, key: form.apiKey.trim() });
    await window.api.setup.syncGrokConfig({ hostId });
    setForm(BLANK_MODEL);
    useStore.getState().appendSetupLog(hostId, `✓ 已添加自定义模型「${label}」并同步到远程\n`);
  });

  const removeModel = (id) => wrap(async () => {
    apply({ grokModels: grokModels.filter((m) => m.id !== id) });
    await window.api.setup.syncGrokConfig({ hostId });
  })();

  const syncNow = wrap(async () => {
    await window.api.setup.syncGrokConfig({ hostId });
  });

  return (
    <Fold title="国产模型(Grok)端点配置" hint="DeepSeek / GLM / Kimi 等自定义端点">
      <p className="muted small">
        全部在此配置,自动写入远程 <code>~/.grok/config.toml</code>,无需手改文件。API Key 存 600 权限 env 文件,不落配置明文。
      </p>

      <div className="grok-presets">
        {GROK_PRESETS.map((p) => (
          <div key={p.envKey} className="grok-preset-row">
            <span className="grok-preset-name">{p.label}</span>
            <code className="muted small">{p.model}</code>
            <input type="password" placeholder={`${p.envKey} = sk-...`} value={presetKeys[p.envKey] || ''}
              onChange={(e) => setPresetKeys((m) => ({ ...m, [p.envKey]: e.target.value }))} />
            <button className="btn small" disabled={busy} onClick={() => savePresetKey(p.envKey)}>写入 Key</button>
          </div>
        ))}
      </div>

      <details className="grok-add">
        <summary>+ 添加自定义端点(中转站 / 其它 OpenAI 兼容服务)</summary>
        <div className="grok-add-grid">
          <label>显示名<input value={form.label} onChange={(e) => setField('label', e.target.value)} placeholder="如 我的中转站" /></label>
          <label>模型 ID<input value={form.model} onChange={(e) => setField('model', e.target.value)} placeholder="如 deepseek-v4-pro" /></label>
          <label>base_url<input value={form.baseUrl} onChange={(e) => setField('baseUrl', e.target.value)} placeholder="https://.../v1" /></label>
          <label>协议
            <select value={form.apiBackend} onChange={(e) => setField('apiBackend', e.target.value)}>
              <option value="chat_completions">chat_completions(OpenAI 兼容,推荐)</option>
              <option value="responses">responses(OpenAI Responses)</option>
              <option value="messages">messages(Anthropic)</option>
            </select>
          </label>
          <label>env 变量名<input value={form.envKey} onChange={(e) => setField('envKey', e.target.value)} placeholder="如 MY_RELAY_API_KEY" /></label>
          <label>API Key(可选,写入远程)<input type="password" value={form.apiKey} onChange={(e) => setField('apiKey', e.target.value)} placeholder="sk-..." /></label>
        </div>
        <button className="btn primary" disabled={busy} onClick={addModel}>添加并同步</button>
      </details>

      {grokModels.length > 0 && (
        <div className="grok-custom-list">
          {grokModels.map((m) => (
            <div key={m.id} className="grok-custom-row">
              <span className="grok-preset-name">{m.label}</span>
              <code className="muted small">{m.model}</code>
              <span className="muted small flex1">{m.baseUrl}</span>
              <button className="icon-btn danger" title="删除" disabled={busy} onClick={() => removeModel(m.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <button className="btn small ghost" disabled={busy} onClick={syncNow} style={{ marginTop: 8 }}>
        重新同步到远程 config.toml
      </button>
    </Fold>
  );
}

/**
 * 可折叠分区。
 * 这一页原本七八块内容全部平铺,一屏看不完也找不到东西 ——
 * 只有「环境概览」和「认证」是常用的,其余默认收起。
 */
function Fold({ title, hint, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`fold ${open ? 'open' : ''}`}>
      <button className="fold-head" onClick={() => setOpen((v) => !v)}>
        <span className="fold-caret">{open ? '▾' : '▸'}</span>
        <b>{title}</b>
        {hint && <span className="muted small">{hint}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

/* 本机 Claude Code 认证卡片:检测凭据来源/有效性/到期时间,再决定能不能下发 */
function LocalClaudeCard({ isLocal, busy, onSync }) {
  const [info, setInfo] = useState(null);
  const [testing, setTesting] = useState(false);

  const detect = async () => {
    setTesting(true);
    try { setInfo(await window.api.setup.detectLocalClaude()); }
    catch (e) { setInfo({ error: e.message }); }
    setTesting(false);
  };
  useEffect(() => { detect(); }, []);

  const sourceLabel = { keychain: 'macOS 钥匙串', file: '~/.claude/.credentials.json' }[info?.source] || '';
  const hoursLeft = info?.expiresAt ? Math.round((info.expiresAt - Date.now()) / 3600000) : null;
  const canSync = info && info.hasAuth && info.authValid;

  return (
    <div className="local-codex-card">
      <table className="env-table"><tbody>
        <tr><td>本机 CLI</td><td>{info?.cliVersion || <span className="muted">未在 PATH 找到</span>}</td></tr>
        <tr><td>凭据来源</td><td>
          {!info ? '检测中...' : info.hasAuth
            ? <span className="ok">{sourceLabel}</span>
            : <span className="error-text">未找到登录凭据</span>}
        </td></tr>
        <tr><td>登录状态</td><td>
          {!info ? '-'
            : info.authValid
              ? <span className="ok">✓ 有效{info.subscription ? `(${info.subscription})` : ''}{info.account ? ` · ${info.account}` : ''}</span>
              : info.expired
                ? <span className="error-text">已过期,请在本机运行 claude 重新登录</span>
                : <span className="error-text">未登录或凭据无效</span>}
        </td></tr>
        {info?.expiresAt > 0 && (
          <tr><td>到期时间</td><td className={hoursLeft <= 0 ? 'error-text' : ''}>
            {new Date(info.expiresAt).toLocaleString()}
            {hoursLeft > 0 ? `(约 ${hoursLeft} 小时后)` : '(已过期)'}
          </td></tr>
        )}
      </tbody></table>

      {info && !info.hasAuth && info.platform === 'darwin' && (
        <p className="muted small">
          {info.keychainError || '钥匙串里没有 Claude Code 凭据'}。先在本机终端运行一次 <code>claude</code> 完成登录;
          若弹出钥匙串授权请点「允许」。
        </p>
      )}

      <div className="row gap" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={detect} disabled={testing}>
          {testing ? '检测中...' : '测试本机 Claude 配置'}
        </button>
        {/* 未登录/已过期时,直接跳到本机终端并自动执行 claude 完成登录 */}
        {info && !info.authValid && info.platform !== 'win32' && (
          <button className="btn small primary" onClick={() => {
            const st = useStore.getState();
            st.setPendingTermCommand({ hostId: 'local', command: 'claude' });
            st.setActiveHost('local');
            st.setTab('terminal');
          }} title="在本机终端里启动 claude 完成登录(登录后回来点「测试本机 Claude 配置」)">
            在本机登录 Claude
          </button>
        )}
        {!isLocal && (
          <button className="btn small primary" disabled={busy || !canSync} onClick={onSync}
            title={canSync ? '把本机登录态复制到远程,免去远程 OAuth 登录'
              : '本机凭据无效或已过期,先在本机登录'}>
            下发 Claude 认证到远程
          </button>
        )}
      </div>
      {!isLocal && (
        <p className="muted small">
          macOS 的登录态存在钥匙串里,下发时会自动导出成远程的 <code>~/.claude/.credentials.json</code>(600 权限),
          订阅会员无需额外 API Key。token 到期后需回来重新下发一次。
        </p>
      )}
    </div>
  );
}

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
