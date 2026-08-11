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
  isAwaitingConfirm, evaluateAutoConfirm, MAX_AUTO_REPLIES, MAX_AUTO_RESUME
} from './store.js';
import { decideGoalStep } from './goalMode.js';
import { autoConfirmOutcome, autoPauseMessage } from './turnFlow.js';
import Sidebar from './components/Sidebar.jsx';
import HostForm from './components/HostForm.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import FilePanel from './components/FilePanel.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import SetupPanel from './components/SetupPanel.jsx';
import BriefPanel from './components/BriefPanel.jsx';
import GraphPanel from './components/GraphPanel.jsx';
import SkillsPanel from './components/SkillsPanel.jsx';
import MobilePanel from './components/MobilePanel.jsx';
import SettingsModal from './components/SettingsModal.jsx';

const TABS = [
  { key: 'chat', label: '对话', icon: '💬' },
  { key: 'brief', label: '速览', icon: '🗞️' },
  { key: 'graph', label: '图谱', icon: '🕸️' },
  { key: 'files', label: '文件', icon: '📁' },
  { key: 'terminal', label: '终端', icon: '⌨️' },
  { key: 'skills', label: '技能', icon: '🧩' },
  { key: 'mobile', label: '移动接入', icon: '📱' },
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
          grokSessionId: msg.grokSessionId,
          lastTurnAgent: msg.agent
        });
        // 有排队消息则自动发送下一条
        const next = st.shiftQueued(convId);
        const conv = st.conversations[convId];
        if (next && conv) { sendToAgent(conv.hostId, convId, next.text, next.files || []); return; }

        /* 网络/代理把长响应掐断(如 Connection closed mid-response):
           会话 ID 还在,自动 resume 续跑,不用人守着点「继续」。
           必须排在全自动/目标模式之前 —— 这一轮是"被打断"而不是"完成了"。 */
        if (msg.transient && conv) {
          const done = st.autoResumeCount?.[convId] || 0;
          if (done < MAX_AUTO_RESUME) {
            const delay = Math.min(2000 * (2 ** done), 20000); // 指数退避,避免上游繁忙时火上浇油
            st.setAutoResumeCount(convId, done + 1);
            st.pushMessage(convId, {
              role: 'agent', kind: 'raw',
              text: `🔌 ${msg.transient},${Math.round(delay / 1000)} 秒后自动续跑(第 ${done + 1}/${MAX_AUTO_RESUME} 次)`,
              ts: Date.now()
            });
            setTimeout(() => {
              const fresh = useStore.getState().conversations[convId];
              if (fresh) {
                sendToAgent(fresh.hostId, convId,
                  '刚才的响应被网络中断了。请检查当前实际进度,从中断处继续完成未完成的部分,不要重复已经做完的改动。',
                  [], { auto: true });
              }
            }, delay);
          } else {
            st.setAutoResumeCount(convId, 0);
            st.pushMessage(convId, {
              role: 'agent', kind: 'raw',
              text: `🔌 连接已中断 ${MAX_AUTO_RESUME} 次,自动续跑暂停。多为代理对长连接超时,建议调大代理超时或拆小任务后手动继续。`,
              ts: Date.now()
            });
          }
          return;
        }
        // 本轮正常结束 -> 重置续跑计数
        if (conv && (st.autoResumeCount?.[convId] || 0) > 0) st.setAutoResumeCount(convId, 0);
        // 本轮(上一条用户消息之后)产生的消息,危险命令判定用
        const sinceLastUser = [];
        for (let i = (conv?.messages?.length || 0) - 1; i >= 0; i -= 1) {
          if (conv.messages[i].role === 'user') break;
          sinceLastUser.push(conv.messages[i]);
        }
        const danger = sinceLastUser.find((m) => m.dangerous);

        /* 全自动:只负责「模型反问要不要继续」时替你点头。
         * 它没事可做时必须把控制权交给目标模式 —— 早先这里无条件 return,
         * 导致开了全自动之后目标模式永远不执行,目标停住、轮次不涨。 */
        if (conv?.autoConfirm) {
          const lastReply = [...conv.messages].reverse()
            .find((m) => m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text);
          const awaiting = !!(lastReply && isAwaitingConfirm(lastReply.text));
          // evaluateAutoConfirm 会累加计数,只在确实要应答时才调用
          const verdict = (!danger && awaiting) ? evaluateAutoConfirm(convId, lastReply.text) : null;
          const outcome = autoConfirmOutcome({
            enabled: true, dangerHit: danger, awaitingConfirm: awaiting, verdictOk: verdict?.ok
          });

          if (outcome === 'sent') {
            sendToAgent(conv.hostId, convId,
              '确认,请继续执行;后续决策请自行选择最合理的方案,不要再次询问。', [], { auto: true });
            return;
          }
          if (outcome === 'paused') {
            st.pushMessage(convId, {
              role: 'agent', kind: 'raw',
              text: autoPauseMessage({
                dangerHit: danger ? (danger.detail || '危险命令') : null,
                verdictReason: verdict?.reason, maxReplies: MAX_AUTO_REPLIES
              }),
              ts: Date.now()
            });
            // 目标模式也一并暂停,否则它会立刻再踢一轮,把刹车抵消掉
            if (conv?.goal?.status === 'active') st.updateConversationGoal(convId, { status: 'paused' });
            return;
          }
          // outcome === 'idle' -> 落到下面的目标模式
        }

        // 目标模式:未达成则自动追一轮,直到达成/卡住/触顶
        if (conv?.goal?.status === 'active' && conv.goal.text) {
          const agentTexts = conv.messages
            .filter((m) => m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text)
            .map((m) => m.text);
          const step = decideGoalStep(conv.goal, {
            lastText: agentTexts[agentTexts.length - 1] || '',
            recentTexts: agentTexts,
            dangerHit: danger ? (danger.detail || '危险命令') : null
          });
          if (step.action === 'continue') {
            st.updateConversationGoal(convId, { rounds: (conv.goal.rounds || 0) + 1 });
            sendToAgent(conv.hostId, convId, step.prompt, [], { auto: true });
          } else if (step.action === 'complete') {
            st.updateConversationGoal(convId, { status: 'done' });
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
          } else if (step.action === 'stop') {
            st.updateConversationGoal(convId, { status: 'paused' });
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
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
                {(activeHost.local
                  ? TABS.filter((t) => ['chat', 'brief', 'graph', 'terminal', 'skills', 'mobile', 'setup'].includes(t.key))
                  : TABS).map((t) => (
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
                activeView={activeHost.local && !['setup', 'brief', 'graph', 'terminal', 'skills', 'mobile'].includes(tab) ? 'chat' : tab}
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

const PERSISTENT_VIEWS = new Set(['chat', 'brief', 'graph', 'files', 'terminal']);

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
            {view === 'brief' && <BriefPanel hostId={hostId} />}
            {view === 'graph' && <GraphPanel active={isActive} />}
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
      {/* 技能页未连接也能浏览内置库与市场,只有「下发」需要连接 */}
      {activeHost && activeView === 'skills' && (
        <div className="workspace-layer active">
          <SkillsPanel hostId={activeHostId} connected={status === 'connected'} />
        </div>
      )}
      {/* 移动接入是全局配置,与是否连上某台主机无关 */}
      {activeHost && activeView === 'mobile' && (
        <div className="workspace-layer active"><MobilePanel /></div>
      )}
      {activeHost && status !== 'connected' && !['setup', 'skills', 'mobile'].includes(activeView) && (
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
