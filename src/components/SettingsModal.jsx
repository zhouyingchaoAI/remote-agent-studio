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
          <label className="settings-row">
            <span>区域截图快捷键</span>
            <input className="settings-input" value={settings.screenshotShortcut || ''}
              placeholder="CommandOrControl+Shift+2"
              onChange={(e) => apply({ screenshotShortcut: e.target.value.trim() })} />
          </label>
          <label className="settings-row">
            <span>启用截图全局快捷键</span>
            <input type="checkbox" checked={settings.screenshotShortcutEnabled !== false}
              onChange={(e) => apply({ screenshotShortcutEnabled: e.target.checked })} />
          </label>
          <p className="muted small">格式如 CommandOrControl+Shift+2;修改后即时生效。截图会作为附件加入当前对话。</p>

          <hr className="settings-sep" />
          <SttSettings />
        </div>
      </div>
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
