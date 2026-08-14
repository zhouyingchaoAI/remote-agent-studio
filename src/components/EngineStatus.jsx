import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';

/**
 * 引擎就绪状态徽标 —— 直接放在对话框顶栏。
 *
 * 原来要判断「当前模型能不能用」得切到环境配置页去翻,
 * 修一下还得再切回来。状态和操作都应该出现在干活的地方。
 */

const ENGINE_LABEL = { codex: 'Codex', claude: 'Claude Code', deepseek: 'DeepSeek', grok: 'Grok' };
/** deepseek 复用 claude CLI,grok 及国产模型走 grok CLI */
const ENGINE_BIN = { codex: 'codex', claude: 'claude', deepseek: 'claude', grok: 'grok' };

/** 由检测结果算出状态,纯函数便于单测 */
export function engineReadiness(engine, env) {
  const bin = ENGINE_BIN[engine] || engine;
  if (!env) return { level: 'unknown', text: '未检测', hint: '点一下检测当前环境' };
  const version = env[bin];
  if (!version) {
    return {
      level: 'missing', text: '未安装',
      hint: `远程没有 ${bin} 命令,先装上才能对话`, canInstall: true
    };
  }
  return { level: 'ready', text: version.split(/\s+/)[0] || version, hint: `${bin} ${version}`, version };
}

export default function EngineStatus({ hostId, engine }) {
  const env = useStore((s) => s.envInfo[hostId]);
  const status = useStore((s) => s.statuses[hostId] || 'disconnected');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const ready = engineReadiness(engine, env);
  const connected = status === 'connected' || hostId === 'local';

  // 没检测过就自动检测一次,免得用户永远看到「未检测」
  useEffect(() => {
    if (!connected || env) return;
    window.api.setup.detect(hostId)
      .then((info) => useStore.getState().setEnvInfo(hostId, info))
      .catch(() => {});
  }, [hostId, connected, env]);

  const run = (label, fn) => async () => {
    setBusy(label); setNote('');
    try {
      const r = await fn();
      setNote(typeof r === 'string' ? r : `${label}完成`);
      const info = await window.api.setup.detect(hostId).catch(() => null);
      if (info) useStore.getState().setEnvInfo(hostId, info);
    } catch (e) {
      setNote(`${label}失败:${e.message}`);
    } finally { setBusy(''); }
  };

  const bin = ENGINE_BIN[engine] || engine;

  return (
    <div className="engine-status">
      <button className={`engine-badge ${ready.level}`} title={ready.hint}
        onClick={() => setOpen((v) => !v)}>
        <span className="dot" />
        {ENGINE_LABEL[engine] || engine} · {connected ? ready.text : '未连接'}
      </button>

      {open && (
        <>
          <div className="engine-pop-backdrop" onClick={() => setOpen(false)} />
          <div className="engine-pop">
            <div className="engine-pop-head">
              <b>{ENGINE_LABEL[engine] || engine}</b>
              <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
            </div>

            <dl className="engine-facts">
              <dt>主机</dt><dd>{connected ? '已连接' : <span className="error-text">未连接</span>}</dd>
              <dt>命令</dt><dd>{env?.[bin] || <span className="error-text">未安装</span>}</dd>
              <dt>Node</dt><dd>{env?.node || '—'}</dd>
            </dl>

            <div className="engine-actions">
              <button className="btn small" disabled={!!busy || !connected}
                onClick={run('检测', () => window.api.setup.detect(hostId))}>
                重新检测
              </button>
              <button className="btn small" disabled={!!busy || !connected}
                onClick={run('安装', () => window.api.setup.installAgent({ hostId, agent: bin }))}>
                {ready.level === 'missing' ? `安装 ${bin}` : `升级 ${bin}`}
              </button>
              <button className="btn small" disabled={!!busy || !connected || hostId === 'local'}
                title="把本机已登录的凭据下发到这台远程主机"
                onClick={run('下发认证', () => window.api.setup.syncAuth({ hostId, agent: bin }))}>
                下发认证
              </button>
              <button className="btn small ghost" disabled={!!busy || !connected}
                onClick={run('测试', () => window.api.setup.testRemoteAgent({ hostId, agent: bin }))}>
                测试可用性
              </button>
            </div>

            {busy && <p className="muted small">{busy}中…(详细日志在「环境配置」页)</p>}
            {note && <p className="muted small">{note}</p>}
            <button className="btn small ghost block-btn"
              onClick={() => { setOpen(false); useStore.getState().setTab('setup'); }}>
              打开完整环境配置 →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
