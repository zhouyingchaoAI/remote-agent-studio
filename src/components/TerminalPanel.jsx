import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../store.js';
import { translate as tr } from '../i18n.mjs';

/** 终端页:多标签,每个标签一个独立远程 shell */
export default function TerminalPanel({ hostId, active }) {
  const language = useStore((s) => s.settings.language);
  const t = (key) => tr(language, key);
  const [tabs, setTabs] = useState([{ id: 't1', number: 1 }]);
  const [activeTab, setActiveTab] = useState('t1');
  const nextIdRef = useRef(2);

  const addTab = () => {
    const id = `t${nextIdRef.current}`;
    nextIdRef.current += 1;
    setTabs((ts) => [...ts, { id, number: nextIdRef.current - 1 }]);
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
        {tabs.map((tab) => (
          <div key={tab.id}
            className={`terminal-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}>
            <span>{t('terminalTab')} {tab.number}</span>
            {tabs.length > 1 && (
              <button className="icon-btn" title={t('closeTab')}
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}>✕</button>
            )}
          </div>
        ))}
        <button className="btn small ghost" title={t('newTerminalTab')} onClick={addTab}>+</button>
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} className="terminal-layer" style={{ display: activeTab === tab.id ? 'flex' : 'none' }}>
          <TermView hostId={hostId} termId={`${hostId}:${tab.id}`} active={active && activeTab === tab.id} />
        </div>
      ))}
    </div>
  );
}

function TermView({ hostId, termId, active }) {
  const language = useStore((s) => s.settings.language);
  const t = (key) => tr(language, key);
  const runtimeText = (key) => tr(useStore.getState().settings.language, key);
  const boxRef = useRef(null);
  const wrapRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const searchRef = useRef(null);
  const searchInputRef = useRef(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');

  useEffect(() => {
    const fontSize = useStore.getState().settings.terminalFontSize || 13;
    const term = new Terminal({
      fontSize,
      fontFamily: 'Menlo, Consolas, monospace',
      theme: { background: '#0b0d12' },
      cursorBlink: true
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(boxRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

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
      if (key === 'f') {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
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
        term.write(`\r\n\x1b[33m[${runtimeText('terminalClosed')}]\x1b[0m\r\n`);
    });

    window.api.term.open({ hostId, termId, cols: term.cols, rows: term.rows }).catch((e) =>
      term.write(`\x1b[31m${e.message}\x1b[0m\r\n`));

    const disp = term.onData((data) => window.api.term.write({ hostId, termId, data }));
    const onResize = () => {
      fit.fit();
      window.api.term.resize({ hostId, termId, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    window.addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(boxRef.current);

    return () => {
      offData(); offClosed(); disp.dispose(); ro.disconnect();
      window.removeEventListener('resize', onResize);
      if (searchRef.current === search) searchRef.current = null;
      search.dispose();
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

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

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
    term.write(`\x1b[36m${runtimeText('reconnectingTerminal')}\x1b[0m\r\n`);
    window.api.term.reconnect({ hostId, termId, cols: term.cols, rows: term.rows })
      .then(() => fit && fit.fit())
      .catch((e) => term.write(`\x1b[31m${e.message}\x1b[0m\r\n`));
  };

  const search = (forward) => {
    const addon = searchRef.current;
    if (!addon || !searchValue) return;
    if (forward) addon.findNext(searchValue, { incremental: false });
    else addon.findPrevious(searchValue, { incremental: false });
  };

  return (
    <div className="terminal-wrap" ref={wrapRef} onMouseDown={() => setContextMenu(null)}>
      <div className="terminal-bar">
        <span className="muted small">{t('terminalReady')}</span>
        <span className="flex1" />
        {searchOpen && <div className="terminal-search">
          <input ref={searchInputRef} value={searchValue} aria-label={t('searchTerminal')} placeholder={t('searchTerminal')}
            onChange={(event) => setSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); search(!event.shiftKey); }
              if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); termRef.current?.focus(); }
            }} />
          <button className="icon-btn" title={t('previousMatch')} onClick={() => search(false)}>↑</button>
          <button className="icon-btn" title={t('nextMatch')} onClick={() => search(true)}>↓</button>
          <button className="icon-btn" title={t('closeSearch')} onClick={() => { setSearchOpen(false); termRef.current?.focus(); }}>✕</button>
        </div>}
        <button className="btn small ghost" title={`${t('searchTerminal')} (⌘/Ctrl+F)`} onClick={() => setSearchOpen(true)}>{t('search')}</button>
        <button className="btn small" onClick={reconnect}>{t('reconnectTerminal')}</button>
      </div>
      <div className="terminal-box" ref={boxRef} onContextMenu={openContextMenu} />
      {contextMenu && (
        <div
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" disabled={!contextMenu.canCopy} onClick={copySelection}>{t('copy')}</button>
          <button type="button" onClick={pasteClipboard}>{t('paste')}</button>
        </div>
      )}
    </div>
  );
}
