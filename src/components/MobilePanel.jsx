import React, { useEffect, useRef, useState } from 'react';
import SetupTerminal from './SetupTerminal.jsx';

/**
 * 移动接入:通过 OpenClaw + 腾讯官方微信通道,用手机微信驱动远程 agent。
 *
 * 三步走 —— 装 OpenClaw、接微信、装桥接技能。
 * 每一步都显示实际检测结果,而不是让用户照着文档盲敲。
 */

const INSTALL_OPENCLAW = 'npm install -g openclaw@latest && openclaw onboard --install-daemon';
const INSTALL_WEIXIN = 'npx -y @tencent-weixin/openclaw-weixin-cli@latest install';

export default function MobilePanel() {
  const [cfg, setCfg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState('');
  const [termOpen, setTermOpen] = useState(false);
  const [qrZoom, setQrZoom] = useState(false); // 扫码时放大字号
  const termRef = useRef(null);

  const refresh = async () => setCfg(await window.api.mobile.getConfig());
  useEffect(() => { refresh(); }, []);

  /** 在内嵌终端里执行命令。终端没开就先开,等挂载好再敲 */
  const runInTerm = (command) => {
    setNote('');
    if (!termOpen) {
      setTermOpen(true);
      setTimeout(() => termRef.current?.run(command), 400);
    } else {
      termRef.current?.run(command);
    }
    // 装完 OpenClaw / 扫完码后状态会变,过一会儿自动刷新检测结果
    setTimeout(refresh, 8000);
  };

  const patch = async (p) => {
    setBusy(true); setNote('');
    try { setCfg(await window.api.mobile.setConfig(p)); await refresh(); }
    catch (e) { setNote(`失败:${e.message}`); }
    finally { setBusy(false); }
  };

  const installBridge = async () => {
    setBusy(true); setNote('');
    try {
      const r = await window.api.mobile.installBridge();
      setNote(`桥接技能已写入 ${r.skill}`);
      await refresh();
    } catch (e) { setNote(`失败:${e.message}(OpenClaw 可能还没装)`); }
    finally { setBusy(false); }
  };

  const rotate = async () => {
    setBusy(true);
    try { await window.api.mobile.rotateToken(); setNote('凭据已重置,并同步给了 OpenClaw'); await refresh(); }
    finally { setBusy(false); }
  };

  if (!cfg) return <div className="mobile-panel"><p className="muted">加载中…</p></div>;

  const oc = cfg.openclaw || {};

  return (
    <div className="mobile-panel">
      <section>
        <h3>移动接入(微信)</h3>
        <p className="muted small">
          手机微信发一句话,就能驱动远程主机上的 codex / claude。
          微信接入与内网穿透由 OpenClaw 和腾讯官方通道插件负责 ——
          <b>本机不需要暴露任何端口</b>,控制接口只绑 127.0.0.1。
        </p>
      </section>

      <Step n="1" title="启用本机控制接口" done={cfg.running}>
        <label className="check-row">
          <input type="checkbox" checked={cfg.enabled} disabled={busy}
            onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>{cfg.running ? `已启用 · 监听 127.0.0.1:${cfg.port}` : '未启用'}</span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={cfg.allowSystemMode} disabled={busy}
            onChange={(e) => patch({ allowSystemMode: e.target.checked })} />
          <span>允许手机端任务使用系统权限模式</span>
        </label>
        <p className="warn-text small">
          ⚠️ 系统权限模式会给 CLI 加上 <code>--dangerously-bypass-approvals-and-sandbox</code>,
          手机上一句话即可在服务器上全权执行。默认关闭,除非你清楚风险。
        </p>
        {cfg.hasToken && (
          <button className="btn small ghost" onClick={rotate} disabled={busy}>重置访问凭据</button>
        )}
      </Step>

      <Step n="2" title="安装 OpenClaw" done={oc.installed}>
        {oc.installed
          ? <p className="ok-text small">✓ 已检测到 {oc.dir}</p>
          : <p className="muted small">需要 Node ≥ 22。点一下就在下方终端里执行,不用切到外面:</p>}
        <Cmd text={INSTALL_OPENCLAW} onRun={() => runInTerm(INSTALL_OPENCLAW)} />
      </Step>

      <Step n="3" title="接入微信(扫码)" done={oc.installed}>
        <p className="muted small">
          腾讯官方通道插件(MIT 开源)。执行后<b>下方终端里会打印二维码</b>,
          用你自己的微信扫它登录:
        </p>
        <Cmd text={INSTALL_WEIXIN} onRun={() => { setQrZoom(true); runInTerm(INSTALL_WEIXIN); }} />
        <p className="muted small">
          扫码用的微信号即为唯一能指挥它的人。OpenClaw 默认对陌生人启用配对码策略,
          别改成对所有人开放。
        </p>
      </Step>

      <Step n="4" title="安装桥接技能" done={oc.skillInstalled}>
        <p className="muted small">
          把「怎么调用本平台」教给 OpenClaw。凭据会单独写到同目录的 <code>.token</code>(600 权限),
          不会出现在技能正文里。
        </p>
        <div className="row gap">
          <button className="btn" onClick={installBridge} disabled={busy || !oc.installed}>
            {oc.skillInstalled ? '重新写入技能' : '写入桥接技能'}
          </button>
          <button className="btn small ghost" disabled={busy}
            onClick={async () => setPreview(await window.api.mobile.previewBridge())}>
            预览技能内容
          </button>
        </div>
        {oc.skillInstalled && <p className="ok-text small">✓ 已安装到 ~/.openclaw/workspace/skills/remote-agent-studio/</p>}
      </Step>

      {note && <p className="muted small">{note}</p>}

      <section className="term-section">
        <h3>
          执行终端
          <span className="flex1" />
          {termOpen && (
            <>
              <label className="check-row inline" title="二维码太小扫不动时打开">
                <input type="checkbox" checked={qrZoom} onChange={(e) => setQrZoom(e.target.checked)} />
                <span className="small">放大二维码</span>
              </label>
              <button className="btn small ghost" onClick={() => termRef.current?.interrupt()}>中断</button>
              <button className="btn small ghost" onClick={() => termRef.current?.clear()}>清屏</button>
            </>
          )}
          <button className="btn small ghost" onClick={() => setTermOpen((v) => !v)}>
            {termOpen ? '收起' : '展开'}
          </button>
        </h3>
        {termOpen ? (
          <div className={`term-host ${qrZoom ? 'zoom' : ''}`}>
            <SetupTerminal ref={termRef} termId="mobile-setup" fontSize={qrZoom ? 17 : 12} />
          </div>
        ) : (
          <p className="muted small">上面任一步骤点「执行」都会在这里跑,微信二维码也在这里显示。</p>
        )}
      </section>

      <section>
        <h3>装好之后怎么用</h3>
        <p className="muted small">在微信里对你的 OpenClaw 说:</p>
        <ul className="muted small mobile-examples">
          <li>「看看我有哪些机器」</li>
          <li>「在 230 那台上跑一下测试,失败的话把原因告诉我」</li>
          <li>「远程那个项目的构建挂了,帮我查一下」</li>
        </ul>
        <p className="muted small">
          任务在手机上发起,桌面端的对话里也能同步看到全过程 —— 不会变成黑盒。
        </p>
      </section>

      {preview && (
        <div className="settings-overlay" onClick={() => setPreview('')}>
          <div className="settings-modal skill-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-head">
              <b>桥接技能内容</b>
              <button className="icon-btn" onClick={() => setPreview('')}>✕</button>
            </div>
            <pre className="skill-source">{preview}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, done, children }) {
  return (
    <section className={`mobile-step ${done ? 'done' : ''}`}>
      <h3><span className="step-num">{done ? '✓' : n}</span> {title}</h3>
      {children}
    </section>
  );
}

function Cmd({ text, onRun }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd-row">
      <code>{text}</code>
      {onRun && <button className="btn small primary" onClick={onRun}>执行</button>}
      <button className="btn small ghost" onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }}>{copied ? '已复制' : '复制'}</button>
    </div>
  );
}
