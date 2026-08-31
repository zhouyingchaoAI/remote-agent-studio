import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { fitExact } from '../termFit.js';

/**
 * 嵌入式本机终端 —— 给引导流程用(安装 OpenClaw、微信扫码登录等)。
 *
 * 为什么不去解析二维码格式:微信 CLI 的二维码是用半块字符直接打在终端里的,
 * 把终端原样渲染出来最稳,不用猜它未来会不会换输出方式。
 * 字号可调是因为二维码太小手机扫不动,太大又超出可视区。
 */
const SetupTerminal = forwardRef(function SetupTerminal({ termId, fontSize = 12, onExit }, ref) {
  const boxRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const readyRef = useRef(false);
  const [error, setError] = useState('');

  useImperativeHandle(ref, () => ({
    /** 敲一条命令进去(自动补回车) */
    run(command) {
      const send = () => window.api.term.write({
        hostId: 'local', termId, data: `${command}\n`
      }).catch(() => {});
      // shell 还没起来就发会被启动输出吞掉
      if (readyRef.current) send(); else setTimeout(send, 1200);
    },
    clear() { termRef.current?.clear(); },
    /** Ctrl+C */
    interrupt() {
      window.api.term.write({ hostId: 'local', termId, data: '' }).catch(() => {});
    }
  }), [termId]);

  useEffect(() => {
    const term = new Terminal({
      fontSize,
      fontFamily: 'Menlo, Consolas, monospace',
      // 二维码是半块字符拼的,行高必须贴紧,否则模块被拉长扫不出来
      lineHeight: 1,
      letterSpacing: 0,
      /* 这里**故意不跟随皮肤**:登录二维码是半块字符拼的,浅色皮肤会把它
         渲染成反色(浅底深码),不少手机扫码器认不出反色 QR。
         宁可这一块和主界面配色不一致,也不能让人扫不出来。 */
      theme: { background: '#0b0d12', foreground: '#e6e6e6' },
      cursorBlink: true,
      scrollback: 4000
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fitExact(term, fit, boxRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const b64ToBytes = (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    };

    const offData = window.api.term.onData(({ hostId, termId: t, data }) => {
      if (hostId === 'local' && t === termId) term.write(b64ToBytes(data));
    });
    const offClosed = window.api.term.onClosed(({ hostId, termId: t }) => {
      if (hostId === 'local' && t === termId) {
        readyRef.current = false;
        term.write('\r\n\x1b[33m[会话已结束]\x1b[0m\r\n');
        onExit?.();
      }
    });

    window.api.term.open({ hostId: 'local', termId, cols: term.cols, rows: term.rows })
      .then(() => { readyRef.current = true; })
      .catch((e) => { setError(e.message); term.write(`\x1b[31m${e.message}\x1b[0m\r\n`); });

    const disp = term.onData((d) => window.api.term.write({ hostId: 'local', termId, data: d }).catch(() => {}));
    const onResize = () => {
      // 和主终端同一套:fit 之后实测渲染高度,超出容器就减一行
      fitExact(term, fit, boxRef.current);
      window.api.term.resize({ hostId: 'local', termId, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(boxRef.current);

    return () => {
      offData(); offClosed(); disp.dispose(); ro.disconnect();
      window.removeEventListener('resize', onResize);
      term.dispose();
      window.api.term.close({ hostId: 'local', termId }).catch(() => {});
    };
    // fontSize 变化不重建终端(会丢掉已打印的二维码),由下面的 effect 热更新
  }, [termId]);

  // 字号变化时热更新并重新适配,不用重建终端(重建会丢掉二维码)
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.fontSize = fontSize;
    fitExact(termRef.current, fitRef.current, boxRef.current);
    window.api.term.resize({
      hostId: 'local', termId,
      cols: termRef.current.cols, rows: termRef.current.rows
    }).catch(() => {});
  }, [fontSize, termId]);

  return (
    <div className="setup-term">
      <div className="setup-term-box" ref={boxRef} />
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
});

export default SetupTerminal;
