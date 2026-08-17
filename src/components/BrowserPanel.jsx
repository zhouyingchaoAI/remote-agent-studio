import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';

/**
 * 内置浏览器。
 *
 * 直接动机是 dsh 的模型配置只能在它自己的 Web UI 里做,但更普遍的用处是
 * 本地/远程起的 dashboard、预览页,不必切出去再切回来。
 *
 * 用 <webview>:它自带独立的进程与会话,不开 nodeIntegration,
 * 页面里的脚本碰不到 window.api —— 这点很重要,内置浏览器会加载外部页面。
 */

const HOME = 'http://127.0.0.1:3080';

export default function BrowserPanel() {
  const pending = useStore((s) => s.pendingBrowserUrl);
  const [url, setUrl] = useState(pending || HOME);
  const [input, setInput] = useState(pending || HOME);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [services, setServices] = useState([]);
  const viewRef = useRef(null);

  const refreshServices = () => window.api.web.list().then(setServices).catch(() => {});
  useEffect(() => { refreshServices(); }, []);

  // 别处(如 dsh 配置按钮)指定了要打开的地址
  useEffect(() => {
    if (!pending) return;
    setUrl(pending); setInput(pending); setFailure('');
    useStore.getState().setPendingBrowserUrl(null);
  }, [pending]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onStart = () => { setLoading(true); setFailure(''); };
    const onStop = () => { setLoading(false); setInput(el.getURL()); };
    const onFail = (e) => {
      setLoading(false);
      // -3 是被主动中断(比如又点了别的链接),不算错误
      if (e.errorCode === -3 || !e.isMainFrame) return;
      setFailure(`${e.errorDescription || '加载失败'}(${e.errorCode})`);
    };
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('did-fail-load', onFail);
    };
  }, []);

  const go = (raw) => {
    let next = String(raw || '').trim();
    if (!next) return;
    if (!/^https?:\/\//i.test(next)) next = `http://${next}`;
    setFailure('');
    setUrl(next); setInput(next);
    // url 没变时 setUrl 不触发重载,显式 loadURL 兜住「再点一次」的场景
    try { viewRef.current?.loadURL(next); } catch (_) {}
  };

  const startService = async (id) => {
    setFailure('');
    try {
      const s = await window.api.web.start({ id });
      await refreshServices();
      // 服务要几秒才起得来,直接跳过去会白屏 —— 等一下再导航
      setTimeout(() => go(s.url), 2500);
    } catch (e) { setFailure(`启动失败:${e.message}`); }
  };

  return (
    <div className="browser-panel">
      <div className="browser-bar">
        <button className="btn small ghost" title="后退"
          onClick={() => viewRef.current?.canGoBack() && viewRef.current.goBack()}>←</button>
        <button className="btn small ghost" title="前进"
          onClick={() => viewRef.current?.canGoForward() && viewRef.current.goForward()}>→</button>
        <button className="btn small ghost" title="刷新"
          onClick={() => viewRef.current?.reload()}>{loading ? '×' : '⟳'}</button>
        <input className="browser-url" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(input); }}
          placeholder="输入地址,回车打开" />
        <button className="btn small" onClick={() => go(input)}>打开</button>
        <button className="btn small ghost" title="在系统浏览器中打开"
          onClick={() => window.api.shell.openExternal(url)}>↗</button>
      </div>

      {/* 本机服务快捷入口:这些 UI 只监听回环地址,外部浏览器同样能开,
          但放在这里省掉「先去终端把它跑起来」那一步 */}
      <div className="browser-services">
        {services.map((s) => (
          <span key={s.id} className="svc">
            <span className={`dot ${s.running ? 'ready' : ''}`} />
            {s.label}
            {s.running ? (
              <>
                <button className="btn tiny ghost" onClick={() => go(s.url)}>打开</button>
                <button className="btn tiny ghost" onClick={async () => {
                  await window.api.web.stop({ id: s.id }); refreshServices();
                }}>停止</button>
              </>
            ) : (
              <button className="btn tiny" onClick={() => startService(s.id)}>启动并打开</button>
            )}
          </span>
        ))}
        <span className="muted small">只能打开本机的服务;远程主机的 Web UI 需要端口转发</span>
      </div>

      {failure && (
        <div className="browser-error">
          {failure}
          <span className="muted small">
            {/127\.0\.0\.1|localhost/.test(url)
              ? ' —— 该服务可能还没起来,点上面的「启动并打开」,或等几秒后刷新'
              : ' —— 检查地址,或该站点需要代理'}
          </span>
        </div>
      )}

      {/* webview 是 Electron 提供的标签,不是标准 DOM 元素 */}
      <webview ref={viewRef} src={url} className="browser-view" partition="persist:ras-browser" />
    </div>
  );
}
