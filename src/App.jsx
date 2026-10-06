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
  useStore, loadHosts, loadConversations, loadSettings, sendToAgent, runAsAgent,
  isAwaitingConfirm, evaluateAutoConfirm, refreshGoalPlan, MAX_AUTO_REPLIES, MAX_AUTO_RESUME
} from './store.js';
import { decideGoalStep } from './goalMode.js';
import { decideTeamStep } from './teamMode.js';
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
import BrowserPanel from './components/BrowserPanel.jsx';
import ErrorLogPanel from './components/ErrorLogPanel.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import BgTasksDrawer, { BgTasksBadge } from './components/BgTasksDrawer.jsx';
import { runE2E } from './e2e.js';

/* 按使用频次排:对话、终端、文件是日常主力,放最左边(离鼠标最近、
   也最先被眼睛扫到);速览/图谱/技能是偶尔用;配置类沉到最右。 */
const TABS = [
  { key: 'chat', label: '对话', icon: '💬' },
  { key: 'terminal', label: '终端', icon: '⌨️' },
  { key: 'files', label: '文件', icon: '📁' },
  { key: 'brief', label: '速览', icon: '🗞️' },
  { key: 'graph', label: '图谱', icon: '🕸️' },
  { key: 'skills', label: '技能', icon: '🧩' },
  { key: 'browser', label: '浏览', icon: '🌐' },
  { key: 'mobile', label: '移动接入', icon: '📱' },
  { key: 'errors', label: '异常日志', icon: '🩺' },
  /* 图标特意不用齿轮:这里配的是**主机上的运行环境**(装引擎、下发密钥),
     和「设置」(皮肤、字号这些应用自己的偏好)是两回事。
     两个都用齿轮的话,找皮肤的人一定会先点这个显眼的,然后以为功能不存在。 */
  { key: 'setup', label: '环境配置', icon: '🧰' }
];

export default function App() {
  const { activeHostId, tab, setTab, editingHost, statuses, hosts } = useStore();
  const activeHost = hosts.find((h) => h.id === activeHostId);
  const status = statuses[activeHostId] || 'disconnected';
  const [bgOpen, setBgOpen] = useState(false);
  /* 面板默认只显示当前主机 / 当前对话的任务。
     注意主机上扫到的进程归不到某一轮对话(智能体是自己在远端起进程的),
     所以 convId 只对应用侧任务生效 —— 见 taskRegistry.matchesScope。 */
  const activeConvId = useStore((s) => s.activeConvByHost?.[s.activeHostId] || '');

  useEffect(() => {
    loadSettings();
    loadHosts();
    loadConversations();
    /* 端到端冒烟:只在 --ras-e2e 下真的跑,平时这行什么都不做。
       放在三个 load 之后、监听器之前 —— 它要等 hosts 加载完,
       而回复要靠下面的 onMessage 监听才能落到 store。 */
    runE2E();
    const offStatus = window.api.ssh.onStatus(({ hostId, status, detail, autoReconnect }) =>
      useStore.getState().setStatus(hostId, status, detail, autoReconnect));
    const offLog = window.api.setup.onLog(({ hostId, text }) =>
      useStore.getState().appendSetupLog(hostId, text));
    // 手机端新开的对话:接纳进来,否则它的消息会因对话不存在而被丢弃
    const offMobileConv = window.api.mobile.onConversation(({ conv }) => {
      if (conv?.id) useStore.getState().adoptConversation(conv);
    });
    const offMsg = window.api.agent.onMessage(({ convId, msg }) => {
      const st = useStore.getState();
      if (msg.kind === 'done') {
        st.setAgentRunning(convId, false);
        /* 本轮结束时把还标着"运行中"的命令收掉。
           不清的话,一条被中断的命令会永远转着圈 ——
           而"永远在跑"和"跑了很久"在界面上长得一模一样。 */
        st.clearRunningTools(convId);
        st.updateConvResume(convId, {
          claudeSessionId: msg.claudeSessionId,
          codexSessionId: msg.codexSessionId,
          codexStarted: msg.codexStarted,
          lastTurnAgent: msg.agent
        });
        if (st.connectionPaused[convId]) {
          st.pushMessage(convId, { role: 'agent', kind: 'raw',
            text: '网络连接曾中断。连接及代理会自动恢复；本轮执行结果可能不完整，请确认进度后手动继续，排队消息暂不发送。', ts: Date.now() });
          return;
        }
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

        /* 目标模式:未达成则自动追一轮,直到达成/卡住/触顶。
         *
         * 抽成函数是因为下面要**先异步读计划文件再决策**。
         * 注意它自己重新从 store 取 conv —— 读计划会写回 goal.plan,
         * 用闭包里那份旧的就等于白读了。 */
        const goalStep = () => {
          const st = useStore.getState();
          if (st.connectionPaused[convId]) return;
          const conv = st.conversations[convId];
          if (!(conv?.goal?.status === 'active' && conv.goal.text)) return;
          const agentTexts = conv.messages
            .filter((m) => m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text)
            .map((m) => m.text);
          const step = decideGoalStep(conv.goal, {
            lastText: agentTexts[agentTexts.length - 1] || '',
            recentTexts: agentTexts,
            /* token 才是真闸门:一轮可能烧 2k 也可能 200k,轮次是很差的代理指标。
               用的是对话已有的累计用量(顶栏那个 Σ … tok 就是它)。 */
            tokensUsed: (conv.usage?.inputTokens || 0) + (conv.usage?.outputTokens || 0),
            dangerHit: danger ? (danger.detail || '危险命令') : null
          });
          /* 团队模式:目标模式说「还要继续」时,由它决定下一轮谁上。
             熔断(危险命令/触顶/原地打转)仍归目标模式,这里不重复实现 ——
             两套独立的熔断在边界情况一定会互相抵消。 */
          if (conv.team && (step.action === 'continue' || step.action === 'verify')) {
            const teamStep = decideTeamStep(conv.team, {
              goalText: conv.goal.text,
              lastText: agentTexts[agentTexts.length - 1] || '',
              turnMessages: [...sinceLastUser].reverse()
            });
            if (teamStep.patch) st.updateConversationTeam(convId, teamStep.patch);
            if (teamStep.action === 'review' || teamStep.action === 'rework') {
              st.updateConversationGoal(convId, { rounds: (conv.goal.rounds || 0) + 1 });
              st.pushMessage(convId, { role: 'agent', kind: 'raw', text: teamStep.message, ts: Date.now() });
              runAsAgent(conv.hostId, convId, teamStep.agent, teamStep.model, teamStep.prompt);
              return;
            }
            if (teamStep.action === 'stop') {
              st.updateConversationGoal(convId, { status: 'paused' });
              st.pushMessage(convId, { role: 'agent', kind: 'raw', text: teamStep.message, ts: Date.now() });
              return;
            }
            // 'passed' -> 审查通过,落回目标模式自己的达成核验
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: teamStep.message, ts: Date.now() });
          }
          if (step.action === 'check') {
            /* **达成判据换成了机器可验的。**
               模型说"已完成"的成本是零;这条命令的退出码不会撒谎。
               跑完再把结果塞回 decideGoalStep,由它决定是完成还是接着修。 */
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
            window.api.goal.check({ hostId: conv.hostId, command: step.command })
              .then((res) => {
                const next = decideGoalStep(conv.goal, {
                  lastText: agentTexts[agentTexts.length - 1] || '',
                  recentTexts: agentTexts,
                  tokensUsed: (conv.usage?.inputTokens || 0) + (conv.usage?.outputTokens || 0),
                  checkResult: res
                });
                st.pushMessage(convId, {
                  role: 'agent', kind: 'tool_output',
                  output: res.output, exitCode: res.code, ts: Date.now()
                });
                if (next.message) {
                  st.pushMessage(convId, { role: 'agent', kind: 'raw', text: next.message, ts: Date.now() });
                }
                if (next.action === 'complete') {
                  st.updateConversationGoal(convId, { status: 'done' });
                  return;
                }
                st.updateConversationGoal(convId, { rounds: (conv.goal.rounds || 0) + 1, verifying: false });
                sendToAgent(conv.hostId, convId, next.prompt, [], { auto: true });
              })
              .catch((e) => {
                /* 验收命令本身跑不起来(主机断了、命令写错)不能当成"未达成"——
                   那会让模型去修一个根本不存在的问题。暂停,让人看一眼。 */
                st.updateConversationGoal(convId, { status: 'paused' });
                st.pushMessage(convId, {
                  role: 'agent', kind: 'raw', ts: Date.now(),
                  text: `🎯 验收命令没能执行(${e.message}),目标模式已暂停 —— `
                    + '这不代表目标没达成,先确认命令本身写对了。'
                });
              });
            return;
          }
          if (step.action === 'continue') {
            st.updateConversationGoal(convId, {
              rounds: (conv.goal.rounds || 0) + 1,
              ...(step.clearVerifying ? { verifying: false } : {}),
              /* 拿计划驳回"已达成"的次数要记下来 —— 不记的话每轮都从 0 开始,
                 一份陈旧的清单就能把目标永远卡在最后一步。 */
              ...(step.planPushback != null ? { planPushback: step.planPushback } : {})
            });
            if (step.message) {
              st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
            }
            sendToAgent(conv.hostId, convId, step.prompt, [], { auto: true });
          } else if (step.action === 'verify') {
            // 宣称达成先不采信,追一轮逐条核验
            st.updateConversationGoal(convId, { verifying: true, rounds: (conv.goal.rounds || 0) + 1 });
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
            sendToAgent(conv.hostId, convId, step.prompt, [], { auto: true });
          } else if (step.action === 'complete') {
            // 达成后直接清掉目标:它已经不会再推进,留着只是占地方。
            // 目标原文写进消息里,万一判断有误还能找回来重设。
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
            st.setConversationGoal(convId, null);
          } else if (step.action === 'stop') {
            st.updateConversationGoal(convId, { status: 'paused' });
            st.pushMessage(convId, { role: 'agent', kind: 'raw', text: step.message, ts: Date.now() });
          }
        };

        /* 有计划文件就先读一遍再决策。
           读它一是为了拿到「第 N / M 步」显示出来,二是给"计划长时间没推进"
           那条硬停滞判据喂数据 —— 比"连续多轮输出雷同"能抓到更多真卡住的情况
           (模型每轮都在说不同的话、却一步没勾掉,是更常见也更烧钱的那种)。

           读失败不阻断:refreshGoalPlan 内部吞掉错误,计划只是观察窗口。 */
        if (conv?.goal?.status === 'active' && conv.goal.planPath) {
          refreshGoalPlan(conv.hostId, convId).then(goalStep);
        } else {
          goalStep();
        }
        return;
      }
      if (msg.kind === 'status') return;
      if (msg.kind === 'usage') return st.addUsage(convId, msg);
      /* 命令跑到一半的增量输出 —— 追加到对应那条工具调用上,
         让它变成一块实时刷新的日志,而不是等命令结束才一次性出现。 */
      if (msg.kind === 'tool_delta') return st.appendToolDelta(convId, msg.id, msg.text);
      // 流式增量与收尾
      if (msg.kind === 'text_delta') return st.appendStreamDelta(convId, 'text', msg.text);
      if (msg.kind === 'reasoning_delta') return st.appendStreamDelta(convId, 'reasoning', msg.text);
      if (msg.kind === 'text' || msg.kind === 'reasoning')
        return st.finalizeStream(convId, msg.kind, msg);
      st.pushMessage(convId, { role: 'agent', ...msg, ts: Date.now() });
    });
    /* 渲染进程的未捕获错误同样要留痕 —— 白屏/组件崩掉时,
       用户什么都看不到,日志是唯一的线索 */
    const onWinError = (e) => window.api.errors.report({
      source: 'renderer', text: e?.message || String(e?.error || e),
      detail: e?.error?.stack
    }).catch(() => {});
    const onRejection = (e) => window.api.errors.report({
      source: 'renderer:unhandledRejection',
      text: e?.reason?.message || String(e?.reason), detail: e?.reason?.stack
    }).catch(() => {});
    window.addEventListener('error', onWinError);
    window.addEventListener('unhandledrejection', onRejection);

    /* ⌘, / Ctrl+, 打开设置(皮肤在第一项)。
       这是各家桌面应用的通用位置,找不到入口的人第一反应就是按它。 */
    const onSettingsKey = (e) => {
      if (e.key !== ',' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      useStore.getState().setShowSettings(true);
    };
    window.addEventListener('keydown', onSettingsKey);

    return () => {
      offStatus(); offLog(); offMsg(); offMobileConv(); 
      window.removeEventListener('error', onWinError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('keydown', onSettingsKey);
    };
  }, []);

  return (
    <div className="app">
      <ErrorBoundary>
      <SettingsModal />
      <BgTasksDrawer open={bgOpen} onClose={() => setBgOpen(false)}
        hostId={activeHostId} convId={activeConvId}
        hostName={(id) => (hosts.find((h) => h.id === id) || {}).name || id} />
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
                  ? TABS.filter((t) => ['chat', 'brief', 'graph', 'terminal', 'skills', 'browser', 'mobile', 'setup'].includes(t.key))
                  : TABS).map((t) => (
                  <button key={t.key}
                    className={`tab ${tab === t.key ? 'active' : ''}`}
                    onClick={() => setTab(t.key)}>
                    {t.icon} {t.label}
                  </button>
                ))}
                {/* 后台下载任务:放角标而不是占一个标签页 ——
                    导航栏的位置要留给对话/终端/文件这三个最常用的 */}
                <BgTasksBadge onClick={() => setBgOpen(true)} hostId={activeHostId} convId={activeConvId} />
              </div>
            </div>
            <div className="content">
              <PersistentWorkspace
                hosts={hosts}
                activeHostId={activeHostId}
                activeView={activeHost.local && !['setup', 'brief', 'graph', 'terminal', 'skills', 'mobile', 'browser'].includes(tab) ? 'chat' : tab}
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
      {/* 内置浏览器与主机连接无关:开的是本机或任意地址 */}
      {activeHost && activeView === 'browser' && (
        <div className="workspace-layer active"><BrowserPanel /></div>
      )}
      {activeHost && activeView === 'mobile' && (
        <div className="workspace-layer active"><MobilePanel /></div>
      )}
      {activeHost && status !== 'connected' && !['setup', 'skills', 'mobile', 'browser', 'errors'].includes(activeView) && (
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
