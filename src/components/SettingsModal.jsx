import React, { useEffect } from 'react';
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
        </div>
      </div>
    </div>
  );
}
