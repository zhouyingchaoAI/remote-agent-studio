import React, { useEffect } from 'react';
import { useStore } from '../store.js';
import { translate as tr } from '../i18n.mjs';

export default function SettingsModal() {
  const show = useStore((s) => s.showSettings);
  const settings = useStore((s) => s.settings);
  const apply = useStore((s) => s.applySettings);
  const t = (key) => tr(settings.language, key);
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
          <b>{t('settings')}</b>
          <button className="icon-btn" title="关闭 (Esc)" onClick={close}>✕</button>
        </div>
        <div className="settings-body">
          <label className="settings-row">
            <span>{t('language')}</span>
            <select value={settings.language || 'zh-CN'} onChange={(e) => apply({ language: e.target.value })}>
              <option value="zh-CN">{t('chinese')}</option>
              <option value="en">{t('english')}</option>
            </select>
          </label>
          <label className="settings-row">
            <span>{t('theme')}</span>
            <select value={settings.theme} onChange={(e) => apply({ theme: e.target.value })}>
              <option value="dark">{t('dark')}</option>
              <option value="light">{t('light')}</option>
            </select>
          </label>
          <label className="settings-row">
            <span>{t('terminalFontSize')}</span>
            <select value={settings.terminalFontSize} onChange={(e) => apply({ terminalFontSize: Number(e.target.value) })}>
              {[11, 12, 13, 14, 15, 16, 18].map((n) => <option key={n} value={n}>{n}px</option>)}
            </select>
          </label>
          <label className="settings-row">
            <span>{t('defaultPermission')}</span>
            <select value={settings.defaultPermissionMode} onChange={(e) => apply({ defaultPermissionMode: e.target.value })}>
              <option value="workspace">{t('workspace')}</option>
              <option value="plan">{t('plan')}</option>
              <option value="system">{t('system')}</option>
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
