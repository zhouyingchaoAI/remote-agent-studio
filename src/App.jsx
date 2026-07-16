import React, { useEffect, useState } from 'react';

/** 错误边界:渲染出错时显示报错信息而不是黑屏 */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 30, color: '#ff5c5c', fontSize: 13 }}>
          <h3>界面渲染出错</h3>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button className="btn" style={{ marginTop: 12 }}
            onClick={() => this.setState({ error: null })}>重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}
import {
  useStore, loadHosts, loadConversations, loadSettings, sendToAgent,
  isAwaitingConfirm, evaluateAutoConfirm, MAX_AUTO_REPLIES
} from './store.js';
import Sidebar from './components/Sidebar.jsx';
import HostForm from './components/HostForm.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import FilePanel from './components/FilePanel.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import SetupPanel from './components/SetupPanel.jsx';
import SettingsModal from './components/SettingsModal.jsx';

const TABS = [
  { key: 'chat', label: '对话', icon: '💬' },
  { key: 'files', label: '文件', icon: '📁' },
  { key: 'terminal', label: '终端', icon: '⌨️' },
  { key: 'setup', label: '环境配置', icon: '⚙️' }
];

export default function App() {
  const { activeHostId, tab, setTab, editingHost, statuses, hosts } = useStore();
  const activeHost = hosts.find((h) => h.id === activeHostId);
  const status = statuses[activeHostId] || 'disconnected';

  useEffect(() => {
    loadSettings();
    loadHosts();
    loadConversations();
    const offStatus = window.api.ssh.onStatus(({ hostId, status, detail }) =>
      useStore.getState().setStatus(hostId, status, detail));
    const offLog = window.api.setup.onLog(({ hostId, text }) =>
      useStore.getState().appendSetupLog(hostId, text));
    const offMsg = window.api.agent.onMessage(({ convId, msg }) => {
      const st = useStore.getState();
      if (msg.kind === 'done') {
        st.setAgentRunning(convId, false);
        st.updateConvResume(convId, {
          claudeSessionId: msg.claudeSessionId,
          codexSessionId: msg.codexSessionId,
          codexStarted: msg.codexStarted,
          lastTurnAgent: msg.agent
        });
        // 有排队消息则自动发送下一条
        const next = st.shiftQueued(convId);
        const conv = st.conversations[convId];
        if (next && conv) { sendToAgent(conv.hostId, convId, next.text, next.files || []); return; }
        // 全自动模式:模型在等确认 -> 自动回复继续(连续 MAX 次后暂停防失控)
        if (conv?.autoConfirm) {
          const lastReply = [...conv.messages].reverse()
            .find((m) => m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text);
          // 全自动刹车:本轮若出现危险命令,不自动确认,提示人工复核
          const sinceLastUser = [];
          for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
            if (conv.messages[i].role === 'user') break;
            sinceLastUser.push(conv.messages[i]);
          }
          const dangerHit = sinceLastUser.find((m) => m.dangerous);
          if (dangerHit) {
            st.pushMessage(convId, {
              role: 'agent', kind: 'raw',
              text: `🛑 全自动已暂停:本轮包含危险命令「${String(dangerHit.detail || '').slice(0, 80)}」,请人工确认后再继续。`,
              ts: Date.now()
            });
          } else if (lastReply && isAwaitingConfirm(lastReply.text)) {
            const verdict = evaluateAutoConfirm(convId, lastReply.text);
            if (verdict.ok) {
              sendToAgent(conv.hostId, convId,
                '确认,请继续执行;后续决策请自行选择最合理的方案,不要再次询问。', [], { auto: true });
            } else {
              st.pushMessage(convId, {
                role: 'agent', kind: 'raw',
                text: verdict.reason === 'repeat'
                  ? '🤖 模型重复发出同一确认请求,全自动已暂停(可能陷入循环或不可行的流程),请人工核实后再继续。'
                  : `🤖 全自动模式已连续自动确认 ${MAX_AUTO_REPLIES} 次,已暂停,请人工查看后继续。`,
                ts: Date.now()
              });
            }
          }
        }
        return;
      }
      if (msg.kind === 'status') return;
      if (msg.kind === 'usage') return st.addUsage(convId, msg);
      // 流式增量与收尾
      if (msg.kind === 'text_delta') return st.appendStreamDelta(convId, 'text', msg.text);
      if (msg.kind === 'reasoning_delta') return st.appendStreamDelta(convId, 'reasoning', msg.text);
      if (msg.kind === 'text' || msg.kind === 'reasoning')
        return st.finalizeStream(convId, msg.kind, msg);
      st.pushMessage(convId, { role: 'agent', ...msg, ts: Date.now() });
    });
    return () => { offStatus(); offLog(); offMsg(); };
  }, []);

  return (
    <div className="app">
      <ErrorBoundary>
      <SettingsModal />
      <Sidebar />
      <div className="main">
        {editingHost !== null ? (
          <HostForm />
        ) : !activeHost ? (
          <div className="empty-state">
            <div className="empty-logo">🛰️</div>
            <h2>Remote Agent Studio</h2>
            <p>在左侧添加一台 SSH 主机,即可远程使用 Codex / Claude Code</p>
            <button className="btn primary" onClick={() => useStore.getState().setEditingHost({})}>
              + 添加主机
            </button>
          </div>
        ) : (
          <>
            <div className="topbar">
              <div className="host-title">
                <span className={`dot ${status}`} />
                <b>{activeHost.name || activeHost.host}</b>
                {activeHost.local
                  ? <span className="muted">本机项目(直接在本地运行 codex / claude)</span>
                  : <span className="muted">{activeHost.username}@{activeHost.host}:{activeHost.port || 22}</span>}
              </div>
              <div className="tabs">
                {(activeHost.local ? TABS.filter((t) => t.key === 'chat' || t.key === 'setup') : TABS).map((t) => (
                  <button key={t.key}
                    className={`tab ${tab === t.key ? 'active' : ''}`}
                    onClick={() => setTab(t.key)}>
                    {t.icon} {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="content">
              <PersistentWorkspace
                hosts={hosts}
                activeHostId={activeHostId}
                activeView={activeHost.local && tab !== 'setup' ? 'chat' : tab}
                statuses={statuses}
              />
            </div>
          </>
        )}
      </div>
      </ErrorBoundary>
    </div>
  );
}

const PERSISTENT_VIEWS = new Set(['chat', 'files', 'terminal']);

function PersistentWorkspace({ hosts, activeHostId, activeView, statuses }) {
  const [visitedViews, setVisitedViews] = useState([]);
  const activeHost = hosts.find((host) => host.id === activeHostId);
  const status = statuses[activeHostId] || 'disconnected';
  const canOpenView = activeView === 'setup' || status === 'connected';
  const viewKey = `${activeHostId}:${activeView}`;
  const shouldPersist = canOpenView && PERSISTENT_VIEWS.has(activeView);

  useEffect(() => {
    if (!shouldPersist) return;
    setVisitedViews((items) => items.some((item) => item.viewKey === viewKey)
      ? items
      : [...items, { viewKey, hostId: activeHostId, view: activeView }]);
  }, [activeHostId, activeView, shouldPersist, viewKey]);

  const renderedViews = shouldPersist && !visitedViews.some((item) => item.viewKey === viewKey)
    ? [...visitedViews, { viewKey, hostId: activeHostId, view: activeView }]
    : visitedViews;

  return (
    <>
      {renderedViews.map(({ viewKey, hostId, view }) => {
        const hostStillExists = hosts.some((host) => host.id === hostId);
        if (!hostStillExists) return null;
        const isActive = canOpenView && hostId === activeHostId && view === activeView;
        return (
          <div
            className={`workspace-layer ${isActive ? 'active' : ''}`}
            key={viewKey}
            aria-hidden={!isActive}
          >
            {view === 'chat' && <ChatPanel hostId={hostId} />}
            {view === 'files' && <FilePanel hostId={hostId} />}
            {view === 'terminal' && <TerminalPanel hostId={hostId} active={isActive} />}
          </div>
        );
      })}
      {activeHost && activeView === 'setup' && (
        <div className="workspace-layer active">
          <SetupPanel hostId={activeHostId} host={activeHost} />
        </div>
      )}
      {activeHost && status !== 'connected' && activeView !== 'setup' && (
        <ConnectGate host={activeHost} status={status} />
      )}
    </>
  );
}

function ConnectGate({ host, status }) {
  const detail = useStore((s) => s.statusDetails[host.id]);
  const connect = async () => {
    try { await window.api.ssh.connect(host); }
    catch (e) { useStore.getState().setStatus(host.id, 'error', e.message); }
  };
  return (
    <div className="empty-state">
      {status === 'connecting' ? (
        <><div className="spinner" /><p>正在连接 {host.host} ...</p></>
      ) : (
        <>
          <p className="muted">{status === 'error' ? `连接失败: ${detail}` : '尚未连接'}</p>
          <button className="btn primary" onClick={connect}>连接</button>
        </>
      )}
    </div>
  );
}
