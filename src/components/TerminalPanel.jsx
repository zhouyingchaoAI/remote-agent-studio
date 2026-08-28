import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import AskShell from './AskShell.jsx';
import { useStore, onThemeChange, themeVar } from '../store.js';

/**
 * 终端配色跟随皮肤。
 *
 * 背景用 --bg 而不是 --bg2:终端占满整块区域,用面板色会和外框差一档,
 * 看着像没铺满。前景/光标取正文色和强调色,ANSI 基色沿用主题的语义色,
 * 这样红=错误、绿=成功在任何皮肤下都一致。
 */
function xtermTheme() {
  return {
    background: themeVar('bg', '#0b0d12'),
    foreground: themeVar('text', '#e6e6e6'),
    cursor: themeVar('accent', '#4f8cff'),
    selectionBackground: `${themeVar('accent', '#4f8cff')}44`,
    red: themeVar('red', '#ff5c5c'),
    green: themeVar('green', '#3ecf8e'),
    yellow: themeVar('yellow', '#f0b429'),
    blue: themeVar('accent', '#4f8cff'),
    magenta: themeVar('accent2', '#7c5cff')
  };
}

/** 终端页:多标签,每个标签一个独立远程 shell */
export default function TerminalPanel({ hostId, active }) {
  const [tabs, setTabs] = useState([{ id: 't1', title: '终端 1' }]);
  const [activeTab, setActiveTab] = useState('t1');
  const nextIdRef = useRef(2);

  const addTab = () => {
    const id = `t${nextIdRef.current}`;
    const title = `终端 ${nextIdRef.current}`;
    nextIdRef.current += 1;
    setTabs((ts) => [...ts, { id, title }]);
    setActiveTab(id);
  };

  const closeTab = (id) => {
    window.api.term.close({ hostId, termId: `${hostId}:${id}` }).catch(() => {});
    setTabs((ts) => {
      const rest = ts.filter((t) => t.id !== id);
      if (rest.length === 0) return ts; // 至少保留一个
      if (activeTab === id) setActiveTab(rest[rest.length - 1].id);
      return rest;
    });
  };

  return (
    <div className="terminal-tabs-wrap">
      <div className="terminal-tabbar">
        {tabs.map((t) => (
          <div key={t.id}
            className={`terminal-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}>
            <span>{t.title}</span>
            {tabs.length > 1 && (
              <button className="icon-btn" title="关闭标签"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>
            )}
          </div>
        ))}
        <button className="btn small ghost" title="新建终端标签" onClick={addTab}>+</button>
      </div>
      {tabs.map((t) => (
        <div key={t.id} className="terminal-layer" style={{ display: activeTab === t.id ? 'flex' : 'none' }}>
          <TermView hostId={hostId} termId={`${hostId}:${t.id}`} active={active && activeTab === t.id} />
        </div>
      ))}
    </div>
  );
}

function TermView({ hostId, termId, active }) {
  const boxRef = useRef(null);
  const wrapRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);

  useEffect(() => {
    const fontSize = useStore.getState().settings.terminalFontSize || 13;
    const term = new Terminal({
      fontSize,
      fontFamily: 'Menlo, Consolas, monospace',
      theme: xtermTheme(),
      cursorBlink: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    /* 换肤时跟着变。xterm 的配色是构造时传进去的普通对象,不认 CSS 变量 ——
       不监听的话会出现「界面切成浅色了、终端还是一块黑」。 */
    const offTheme = onThemeChange(() => { term.options.theme = xtermTheme(); });

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true;
      const key = event.key.toLowerCase();
      if (key === 'c' && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        event.stopPropagation();
        if (term.hasSelection()) window.api.clipboard.writeText(term.getSelection());
        return false;
      }
      if (key === 'v') {
        event.preventDefault();
        event.stopPropagation();
        window.api.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });

    const b64ToBytes = (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    };
    const offData = window.api.term.onData(({ hostId: h, termId: t, data }) => {
      if (h === hostId && t === termId) term.write(b64ToBytes(data));
    });
    const offClosed = window.api.term.onClosed(({ hostId: h, termId: t }) => {
      if (h === hostId && t === termId)
        term.write('\r\n\x1b[33m[会话已关闭,可点右上角「重连终端」]\x1b[0m\r\n');
    });

    window.api.term.open({ hostId, termId, cols: term.cols, rows: term.rows })
      .then(() => {
        // 有待执行命令(如从认证卡片点「在本机登录」跳过来)则自动敲进去
        const pending = useStore.getState().pendingTermCommand;
        if (pending && pending.hostId === hostId) {
          useStore.getState().setPendingTermCommand(null);
          // 等 shell 初始化完再发,否则会被启动输出吞掉
          setTimeout(() => window.api.term.write({ hostId, termId, data: `${pending.command}\n` }), 1200);
        }
      })
      .catch((e) => term.write(`\x1b[31m${e.message}\x1b[0m\r\n`));

    const disp = term.onData((data) => window.api.term.write({ hostId, termId, data }));
    const onResize = () => {
      fit.fit();
      window.api.term.resize({ hostId, termId, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(boxRef.current);

    return () => {
      offData(); offClosed(); offTheme(); disp.dispose(); ro.disconnect();
      window.removeEventListener('resize', onResize);
      term.dispose();
    };
  }, [hostId, termId]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      fit.fit();
      window.api.term.resize({ hostId, termId, cols: term.cols, rows: term.rows }).catch(() => {});
      term.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, hostId, termId]);

  useEffect(() => {
    if (!active) setContextMenu(null);
  }, [active]);

  const copySelection = async () => {
    const term = termRef.current;
    if (term?.hasSelection()) await window.api.clipboard.writeText(term.getSelection());
    setContextMenu(null);
    term?.focus();
  };

  const pasteClipboard = async () => {
    const term = termRef.current;
    const text = await window.api.clipboard.readText();
    if (term && text) term.paste(text);
    setContextMenu(null);
    term?.focus();
  };

  const openContextMenu = (event) => {
    event.preventDefault();
    const bounds = wrapRef.current.getBoundingClientRect();
    setContextMenu({
      x: Math.min(Math.max(4, event.clientX - bounds.left), Math.max(4, bounds.width - 128)),
      y: Math.min(Math.max(4, event.clientY - bounds.top), Math.max(4, bounds.height - 76)),
      canCopy: !!termRef.current?.hasSelection()
    });
  };

  const reconnect = () => {
    const term = termRef.current, fit = fitRef.current;
    if (!term) return;
    term.reset();
    term.write('\x1b[36m正在重连终端并加载最新代理/环境...\x1b[0m\r\n');
    window.api.term.reconnect({ hostId, termId, cols: term.cols, rows: term.rows })
      .then(() => fit && fit.fit())
      .catch((e) => term.write(`\x1b[31m${e.message}\x1b[0m\r\n`));
  };

  return (
    <div className="terminal-wrap" ref={wrapRef} onMouseDown={() => setContextMenu(null)}>
      <div className="terminal-bar">
        <span className="muted small">远程终端(已自动加载代理与 codex/claude 路径)</span>
        <span className="flex1" />
        <button className="btn small" onClick={reconnect}>重连终端</button>
      </div>
      <div className="terminal-box" ref={boxRef} onContextMenu={openContextMenu} />
      {/* 命令记不清时就地问一句,不用切出去 */}
      <AskShell
        hostId={hostId} termId={termId}
        getTail={() => {
          /* 从 xterm 的缓冲区取最近若干行。这是终端里真正显示过的内容,
             比截图准 —— 模型不用认字,还能直接引用报错原文。 */
          const term = termRef.current;
          if (!term) return '';
          const buf = term.buffer.active;
          const lines = [];
          const start = Math.max(0, buf.length - 80);
          for (let i = start; i < buf.length; i += 1) {
            lines.push(buf.getLine(i)?.translateToString(true) ?? '');
          }
          return lines.join('\n');
        }}
        onInsert={(cmd) => {
          /* 只填不回车。模型给的可能是 rm -rf,也可能只是版本对不上 ——
             让人看一眼再自己按回车。 */
          window.api.term.write({ hostId, termId, data: cmd });
          termRef.current?.focus();
        }}
      />
      {contextMenu && (
        <div
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" disabled={!contextMenu.canCopy} onClick={copySelection}>复制</button>
          <button type="button" onClick={pasteClipboard}>粘贴</button>
        </div>
      )}
    </div>
  );
}
