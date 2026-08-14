import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';

export default function SettingsModal() {
  const show = useStore((s) => s.showSettings);
  const settings = useStore((s) => s.settings);
  const apply = useStore((s) => s.applySettings);
  const close = () => useStore.getState().setShowSettings(false);
  useEffect(() => {
    if (!show) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show]);
  if (!show) return null;

  return (
    <div className="settings-overlay" onClick={close}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <b>设置</b>
          <button className="icon-btn" title="关闭 (Esc)" onClick={close}>✕</button>
        </div>
        <div className="settings-body">
          <label className="settings-row">
            <span>主题</span>
            <select value={settings.theme} onChange={(e) => apply({ theme: e.target.value })}>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
          <label className="settings-row">
            <span>终端字号</span>
            <select value={settings.terminalFontSize} onChange={(e) => apply({ terminalFontSize: Number(e.target.value) })}>
              {[11, 12, 13, 14, 15, 16, 18].map((n) => <option key={n} value={n}>{n}px</option>)}
            </select>
          </label>
          <label className="settings-row">
            <span>新对话默认权限</span>
            <select value={settings.defaultPermissionMode} onChange={(e) => apply({ defaultPermissionMode: e.target.value })}>
              <option value="workspace">工作区(受限,推荐)</option>
              <option value="system">系统权限(放开)</option>
            </select>
          </label>
          <label className="settings-row">
            <span>全自动连续确认上限</span>
            <select value={settings.autoConfirmCap} onChange={(e) => apply({ autoConfirmCap: Number(e.target.value) })}>
              {[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n} 次</option>)}
            </select>
          </label>
          <p className="muted small">终端字号改动对新开的终端标签生效;主题即时切换。</p>

          <hr className="settings-sep" />
          <ScreenshotShortcutSettings settings={settings} apply={apply} />

          <hr className="settings-sep" />
          <SttSettings />

          <hr className="settings-sep" />
          <PrismFlowSettings />

          <hr className="settings-sep" />
          <ObsidianSettings />
        </div>
      </div>
    </div>
  );
}

/* 截图快捷键:显示"实际生效"的键位 —— 被输入法等占用时会自动降级到备选键 */
function ScreenshotShortcutSettings({ settings, apply }) {
  const [status, setStatus] = useState(null);
  const refresh = () => window.api.screenshot.shortcutStatus().then(setStatus).catch(() => {});
  useEffect(() => { refresh(); }, []);
  // 设置变更后主进程会重注册,稍等再查实际结果
  const applyAndRefresh = (patch) => { apply(patch); setTimeout(refresh, 250); };

  return (
    <>
      <label className="settings-row">
        <span>区域截图快捷键</span>
        <input className="settings-input" value={settings.screenshotShortcut || ''}
          placeholder="CommandOrControl+Shift+2"
          onChange={(e) => applyAndRefresh({ screenshotShortcut: e.target.value.trim() })} />
      </label>
      <label className="settings-row">
        <span>启用截图全局快捷键</span>
        <input type="checkbox" checked={settings.screenshotShortcutEnabled !== false}
          onChange={(e) => applyAndRefresh({ screenshotShortcutEnabled: e.target.checked })} />
      </label>
      {status && status.enabled && status.accelerator && (
        <p className="muted small">
          当前生效:<b>{status.accelerator}</b>
          {status.fallback && ' (你填的组合被占用,已自动降级到备选键)'}
        </p>
      )}
      {status && status.error && <p className="error-text">{status.error}</p>}
      <p className="muted small">
        格式如 CommandOrControl+Shift+2、Alt+Shift+A;修改后即时生效。截图完成会自动作为附件加入当前对话并把窗口带到前台。
        输入区的「✂ 截图」按钮不依赖快捷键,随时可用。
      </p>
    </>
  );
}

/* Obsidian 知识库:原子笔记 + 双链 + MOC,写进你本机 vault */
function ObsidianSettings() {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState('');
  const [key, setKey] = useState('');
  useEffect(() => { window.api.obsidian.getConfig().then(setCfg).catch(() => {}); }, []);
  if (!cfg) return null;

  const patch = (p) => { setCfg({ ...cfg, ...p }); window.api.obsidian.setConfig(p).catch(() => {}); };
  const pick = async () => {
    const next = await window.api.obsidian.pickVault().catch(() => null);
    if (next) { setCfg(next); setStatus('已选择 vault'); }
  };
  const test = async () => {
    setStatus('检测中…');
    const r = await window.api.obsidian.test().catch((e) => ({ ok: false, detail: e?.message }));
    setStatus(`${r.ok ? '✅' : '❌'} ${r.detail || ''}`);
  };

  return (
    <div className="stt-settings">
      <div className="settings-row"><span><b>Obsidian 知识库</b></span></div>
      <p className="muted small">
        把对话精华与每日速览沉淀成**原子笔记 + [[双链]] + 主题索引(MOC)**,Obsidian 图谱视图会自动长出来。
      </p>
      <label className="settings-row">
        <span>写入方式</span>
        <select value={cfg.transport} onChange={(e) => patch({ transport: e.target.value })}>
          <option value="file">直写 vault 目录(零依赖,推荐)</option>
          <option value="rest">Local REST API 插件</option>
        </select>
      </label>
      {cfg.transport === 'file' ? (
        <div className="settings-row">
          <span>vault 目录</span>
          <span className="row gap" style={{ flex: 1 }}>
            <input className="settings-input" value={cfg.vaultPath || ''} placeholder="尚未选择"
              onChange={(e) => patch({ vaultPath: e.target.value })} />
            <button className="btn small" onClick={pick}>选择…</button>
          </span>
        </div>
      ) : (
        <>
          <label className="settings-row">
            <span>REST 地址</span>
            <input className="settings-input" value={cfg.restBaseUrl || ''} placeholder="http://127.0.0.1:27123"
              onChange={(e) => patch({ restBaseUrl: e.target.value })} />
          </label>
          <label className="settings-row">
            <span>API Key {cfg.hasKey && <span className="muted small">(已设置)</span>}</span>
            <span className="row gap" style={{ flex: 1 }}>
              <input className="settings-input" type="password" value={key}
                placeholder={cfg.hasKey ? '••••(留空不改)' : '插件设置里复制'}
                onChange={(e) => setKey(e.target.value)} />
              <button className="btn small" disabled={!key.trim()}
                onClick={() => window.api.obsidian.setConfig({ apiKey: key.trim() }).then((c) => { setCfg(c); setKey(''); setStatus('Key 已保存'); })}>保存</button>
            </span>
          </label>
        </>
      )}
      <label className="settings-row">
        <span>落地子目录</span>
        <input className="settings-input" value={cfg.folder || ''} placeholder="RemoteAgentStudio"
          onChange={(e) => patch({ folder: e.target.value })} />
      </label>
      <div className="settings-row">
        <span />
        <span className="row gap"><button className="btn small" onClick={test}>测试连通与可写</button></span>
      </div>
      {status && <p className="muted small">{status}</p>}
      <p className="muted small">
        笔记只写进 vault 里的这个子目录;MOC 索引用标记块增量合并,你手写的内容不会被覆盖。
      </p>
      <AutoCaptureSettings />
    </div>
  );
}

/* 每日自动沉淀:无感知地把当天经验积累进知识库 */
function AutoCaptureSettings() {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => window.api.autocapture.getConfig().then(setCfg).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!cfg) return null;

  const patch = (p) => { setCfg({ ...cfg, ...p }); window.api.autocapture.setConfig(p).catch(() => {}); };
  const runNow = async () => {
    setBusy(true); setStatus('正在提炼当天经验…(耗时取决于对话量)');
    try {
      const r = await window.api.autocapture.runNow({});
      setStatus(r?.ok === false ? `失败:${r.error}`
        : r?.count ? `✅ 沉淀 ${r.count} 篇(新建 ${r.created} / 补充 ${r.merged})`
          : `没有可沉淀的内容${r?.note ? ` —— ${r.note}` : ''}`);
      load();
    } catch (e) { setStatus(`失败:${e?.message || e}`); }
    setBusy(false);
  };

  const last = cfg.lastResult;
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
      <div className="settings-row"><span><b>每日自动沉淀</b></span></div>
      <p className="muted small">
        每天定时把当天对话里的**可复用经验**提炼进知识库,全程无需你操作。已有笔记会追加补充而不是覆盖,
        并优先复用已有标题建立双链,图谱会随时间越长越密。
      </p>
      <label className="settings-row">
        <span>开启自动沉淀</span>
        <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
      </label>
      <label className="settings-row">
        <span>每日时间</span>
        <input className="settings-input" value={cfg.time || ''} placeholder="22:00"
          onChange={(e) => patch({ time: e.target.value.trim() })} />
      </label>
      <label className="settings-row">
        <span>抽取引擎</span>
        <select value={cfg.agent || ''} onChange={(e) => patch({ agent: e.target.value })}>
          <option value="">自动选择(推荐,实测哪个能用就用哪个)</option>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="dsh">DeepSeek Harness</option>
          <option value="deepseek">DeepSeek</option>
        </select>
      </label>
      <label className="settings-row">
        <span>抽取模型</span>
        <input className="settings-input" value={cfg.model || ''} placeholder="minimax/minimax-m2.5"
          onChange={(e) => patch({ model: e.target.value.trim() })} />
      </label>
      <div className="settings-row">
        <span>上次运行</span>
        <span className="muted small">
          {cfg.lastRunAt
            ? `${new Date(cfg.lastRunAt).toLocaleString()} · ${last?.ok ? `沉淀 ${last.count} 篇(新建 ${last.created}/补充 ${last.merged})` : `失败:${last?.error || ''}`}`
            : '尚未运行'}
        </span>
      </div>
      <div className="settings-row">
        <span />
        <span className="row gap"><button className="btn small" disabled={busy} onClick={runNow}>立即沉淀一次</button></span>
      </div>
      {status && <p className="muted small">{status}</p>}
      <p className="muted small">
        抽取是总结类任务,小模型足够,建议用便宜的(如 MiniMax、deepseek-v4-flash)。
        应用当时没开机也不会丢:下次启动会自动补跑当天遗漏的那次。
      </p>
    </div>
  );
}

/* 资讯聚合:接入开源项目 PrismFlowAgent(流光)。
   通过 HTTP 调用,不并入本项目源码 —— 流光是 GPL-3.0,进程分离不影响本项目 MIT。 */
function PrismFlowSettings() {
  const [cfg, setCfg] = useState(null);
  const [health, setHealth] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setCfg(await window.api.prism.getConfig().catch(() => null));
    setHealth(await window.api.prism.health().catch(() => null));
  };
  useEffect(() => { refresh(); }, []);
  if (!cfg) return null;

  const register = async () => {
    setBusy(true); setStatus('注册中…');
    try {
      const { verificationUrl } = await window.api.prism.register({ name: cfg.agentName });
      await refresh();
      if (verificationUrl) {
        setStatus('已注册,请在浏览器里点「确认并批准接入」完成激活');
        window.api.shell.openExternal(verificationUrl);
      } else setStatus('已注册');
    } catch (e) { setStatus(e?.message || '注册失败'); }
    setBusy(false);
  };

  const copyDeploy = async () => {
    const prompt = await window.api.prism.deployPrompt({}).catch(() => '');
    if (prompt) {
      await window.api.clipboard.writeText(prompt);
      setStatus('部署指令已复制,粘贴到对话里发给 codex 即可');
    }
  };

  return (
    <div className="stt-settings">
      <div className="settings-row"><span><b>资讯聚合(PrismFlowAgent)</b></span></div>
      <p className="muted small">
        开源自动化资讯系统,抓 GitHub Trending / 论文 / RSS / 社媒并 AI 总结。本应用通过它的 API 调用,
        没把源码并进来(它是 GPL-3.0,进程分离调用不影响本项目 MIT 许可)。
      </p>
      <label className="settings-row">
        <span>服务地址</span>
        <input className="settings-input" value={cfg.baseUrl || ''} placeholder="http://localhost:3000"
          onChange={(e) => { const v = e.target.value; setCfg({ ...cfg, baseUrl: v }); window.api.prism.setConfig({ baseUrl: v }); }}
          onBlur={refresh} />
      </label>
      <label className="settings-row">
        <span>接入名称</span>
        <input className="settings-input" value={cfg.agentName || ''} placeholder="RemoteAgentStudio"
          onChange={(e) => { const v = e.target.value; setCfg({ ...cfg, agentName: v }); window.api.prism.setConfig({ agentName: v }); }} />
      </label>
      <div className="settings-row">
        <span>状态</span>
        <span className="muted small">
          {health == null ? '检测中…'
            : health.authorized ? '✅ 已连接并授权'
              : health.online ? '⚠️ 服务在线,未授权' : `❌ 未连接:${health.error || ''}`}
        </span>
      </div>
      <div className="settings-row">
        <span />
        <span className="row gap">
          <button className="btn small" disabled={busy} onClick={register}>
            {cfg.hasKey ? '重新注册并授权' : '注册并授权'}
          </button>
          <button className="btn small" onClick={refresh}>重新检测</button>
          <button className="btn small ghost" onClick={copyDeploy}>复制部署指令</button>
          {cfg.hasKey && (
            <button className="btn small ghost"
              onClick={() => window.api.prism.setConfig({ apiKey: null }).then(refresh)}>清除授权</button>
          )}
        </span>
      </div>
      {cfg.verificationUrl && !health?.authorized && (
        <p className="muted small">
          激活链接:<a href="#" onClick={(e) => { e.preventDefault(); window.api.shell.openExternal(cfg.verificationUrl); }}>
            {cfg.verificationUrl}</a>
        </p>
      )}
      {status && <p className="muted small">{status}</p>}
    </div>
  );
}

/* 语音输入(STT)配置:端点/模型/Key,Key 经加密存本机、不回传界面 */
function SttSettings() {
  const [cfg, setCfg] = useState(null);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => { window.api.stt.getConfig().then(setCfg).catch(() => {}); }, []);
  if (!cfg) return null;

  const saveField = (patch) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    window.api.stt.setConfig(patch).catch(() => {});
  };
  const saveKey = async () => {
    if (!key.trim()) return;
    setStatus('保存中…');
    try { const c = await window.api.stt.setConfig({ apiKey: key.trim() }); setCfg(c); setKey(''); setStatus('已保存 ✓'); }
    catch (e) { setStatus(e?.message || '保存失败'); }
  };
  const test = async () => {
    setStatus('测试中…(会发一次极短请求)');
    try { await window.api.stt.test(); setStatus('端点与 Key 可用 ✓'); }
    catch (e) { setStatus(e?.message?.slice(0, 120) || '测试失败'); }
  };

  return (
    <div className="stt-settings">
      <div className="settings-row"><span><b>语音输入(STT)</b></span></div>
      <p className="muted small">录音经 OpenAI 兼容 <code>/audio/transcriptions</code> 端点转写(OpenAI Whisper / 通义 ASR / 中转站通用)。Key 加密存本机,不上传、不回显。</p>
      <label className="settings-row">
        <span>端点 base_url</span>
        <input className="settings-input" value={cfg.baseUrl || ''} placeholder="https://api.openai.com/v1"
          onChange={(e) => saveField({ baseUrl: e.target.value })} />
      </label>
      <label className="settings-row">
        <span>转写模型</span>
        <input className="settings-input" value={cfg.model || ''} placeholder="gpt-4o-mini-transcribe / whisper-1"
          onChange={(e) => saveField({ model: e.target.value })} />
      </label>
      <label className="settings-row">
        <span>语言(可选)</span>
        <input className="settings-input" value={cfg.language || ''} placeholder="zh / en,留空自动"
          onChange={(e) => saveField({ language: e.target.value })} />
      </label>
      <label className="settings-row">
        <span>API Key {cfg.hasKey && <span className="muted small">(已设置)</span>}</span>
        <input className="settings-input" type="password" value={key} placeholder={cfg.hasKey ? '••••(留空不改)' : 'sk-...'}
          onChange={(e) => setKey(e.target.value)} />
      </label>
      <div className="settings-row">
        <span />
        <span className="row gap">
          <button className="btn small" onClick={saveKey} disabled={!key.trim()}>保存 Key</button>
          <button className="btn small" onClick={test} disabled={!cfg.hasKey}>测试</button>
          {cfg.hasKey && <button className="btn small ghost" onClick={() => { window.api.stt.setConfig({ apiKey: null }).then(setCfg); }}>清除 Key</button>}
        </span>
      </div>
      {status && <p className="muted small">{status}</p>}
    </div>
  );
}
