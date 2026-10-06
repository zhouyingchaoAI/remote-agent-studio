import React, { useState, useRef, useEffect, useMemo } from 'react';
import { outputSummary, looksFailed } from '../toolOutput.js';
import { useStore, sendToAgent, isAwaitingConfirm, refreshGoalPlan, MAX_PANES } from '../store.js';
import { useVoiceInput } from '../useVoiceInput.js';
import { buildPromptHistory, stepPromptHistory } from '../promptHistory.js';
import { extractOptions } from '../quickReplies.js';
import { matchCommands, applyCompletion, parseSlash, parseGoalArgs, helpText } from '../slashCommands.js';
import { buildDecomposePrompt, defaultPlanPath } from '../planProgress.js';
import { toAttachment, attachmentProblem } from '../attachmentFile.js';
import { shortenPath } from '../shortenPath.js';
import ForkDialog from './ForkDialog.jsx';
import { CLAUDE_MODELS, modelVersionProblem } from '../claudeModels.js';
import { mergeModels } from '../mergeModels.js';
import {
  createGoal, buildContinuePrompt, resumeGoalPatch, setGoalMaxRounds, setGoalTokenBudget,
  fmtTokens, GOAL_DEFAULT_MAX_ROUNDS, GOAL_EXTEND_ROUNDS, GOAL_DEFAULT_TOKEN_BUDGET
} from '../goalMode.js';
import { createTeam, engineLabel, TEAM_PRESETS } from '../teamMode.js';
import FilePreview from './FilePreview.jsx';
import EngineStatus from './EngineStatus.jsx';
import GithubBadge from './GithubBadge.jsx';
import Markdown from './Markdown.jsx';
import { fileKind } from '../fileKind.js';
import { REASONING_EFFORTS } from '../reasoningEfforts.js';
import { normalizePastedPath, looksLikePath } from '../pastePath.js';
import { ModelPicker } from './ModelPicker.jsx';
import { GoalBar } from './GoalBar.jsx';
import { Message } from './Message.jsx';
import { conversationToMarkdown, ConversationHome } from './ConversationHome.jsx';


function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M tok';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k tok';
  return n + ' tok';
}


export default function ChatPanel({ hostId }) {
  const activeConvId = useStore((s) => s.activeConvByHost[hostId]);
  const conv = useStore((s) => (activeConvId ? s.conversations[activeConvId] : null));
  const extras = useStore((s) => s.extraConvByHost[hostId]);
  const conversations = useStore((s) => s.conversations);

  // 未选中对话 -> 显示会话列表 / 新建
  if (!activeConvId || !conv) return <ConversationHome hostId={hostId} />;

  /* 分屏:同一台主机上并排跑多个对话。
     后端本来就按 convId 分开、切走也照跑,这里只是让它们同时可见。 */
  const paneConvs = [conv, ...(extras || []).map((id) => conversations[id]).filter(Boolean)];
  if (paneConvs.length === 1) {
    return <ChatView key={conv.id} hostId={hostId} conv={conv} />;
  }
  return (
    <div className={`chat-split panes-${Math.min(paneConvs.length, MAX_PANES)}`}>
      {paneConvs.map((c) => (
        <div key={c.id} className="chat-pane">
          <ChatView hostId={hostId} conv={c} split />
        </div>
      ))}
    </div>
  );
}


/**
 * 分屏控制:再开一个面板 / 关掉本面板。
 *
 * 只列同主机的其他对话 —— 跨主机并排看没有意义,cwd 与引擎都对不上,
 * 而且很容易对着错的机器发指令。
 */
function SplitControls({ hostId, conv, split }) {
  const [open, setOpen] = useState(false);
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConvByHost[hostId]);
  const extras = useStore((s) => s.extraConvByHost[hostId]);
  const onScreen = new Set([activeId, ...(extras || [])]);
  const full = 1 + (extras?.length || 0) >= MAX_PANES;

  const candidates = Object.values(conversations)
    .filter((c) => c.hostId === hostId && !onScreen.has(c.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 12);

  return (
    <span className="split-controls">
      <button className="btn small ghost" title={full ? `最多同时开 ${MAX_PANES} 个` : '再开一个对话并排显示'}
        disabled={full} onClick={() => setOpen((v) => !v)}>⊞ 分屏</button>
      {split && (
        <button className="btn small ghost" title="关掉这一屏(对话本身不会删除,后台照常跑)"
          onClick={() => useStore.getState().closeSplit(hostId, conv.id)}>✕ 本屏</button>
      )}
      {open && (
        <>
          <div className="engine-pop-backdrop" onClick={() => setOpen(false)} />
          <div className="engine-pop">
            <div className="engine-pop-head">
              <b>并排打开</b>
              <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
            </div>
            {candidates.length === 0
              ? <p className="muted small">这台主机没有其他对话了,先新建一个。</p>
              : candidates.map((c) => (
                <button key={c.id} className="btn small ghost block-btn"
                  onClick={() => { useStore.getState().addSplit(hostId, c.id); setOpen(false); }}>
                  {c.title || c.id} · {c.cwd || '~'}
                </button>
              ))}
            <p className="muted small">
              各面板独立跑各自的引擎与目录;最多 {MAX_PANES} 个 ——
              每个对话占一条 SSH 通道,开太多会把远端的连接数吃光。
            </p>
          </div>
        </>
      )}
    </span>
  );
}

/* ---------------- 单个对话视图 ---------------- */
/**
 * 从对话消息里抽出给 dsh 的历史。
 * 只取用户指令与助手正文 —— 错误提示、工具日志喂回去只会误导它。
 */
export function dshHistoryFrom(messages = [], maxItems = 12) {
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.text) continue;
    if (m.role === 'user') { out.push({ role: 'user', text: m.text }); continue; }
    // 引擎侧消息在 store 里是 role:'agent'(不是 'assistant');
    // 只取正文,error/raw/tool/reasoning 喂回去只会误导它
    if (m.role === 'agent' && (m.kind === 'text' || m.kind === 'result')) {
      out.push({ role: 'assistant', text: m.text });
    }
  }
  return out.slice(-maxItems);
}

function ChatView({ hostId, conv, split = false }) {
  const running = useStore((s) => s.agentRunning[conv.id] || false);
  // 主机名给 GitHub 徽标用:弹层里要写清是给哪台主机登录
  const ghFromChat = useRef(false);
  const hostName = useStore((s) => {
    const h = (s.hosts || []).find((x) => x.id === hostId);
    return h?.name || h?.host || '';
  });
  const setActiveConv = useStore((s) => s.setActiveConv);
  const updateConversationPermission = useStore((s) => s.updateConversationPermission);
  const updateConversationModel = useStore((s) => s.updateConversationModel);
  const updateConversationAgent = useStore((s) => s.updateConversationAgent);
  /* 这台机器的环境检测结果。这里只用它的 claude 版本号 ——
     新模型对 CLI 有最低版本要求,拿它在选之前就能提示。 */
  const hostEnv = useStore((s) => s.envInfo[hostId]);
  const [input, setInput] = useState('');
  const [started, setStarted] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const listRef = useRef(null);
  const composingRef = useRef(false);
  const [filePreview, setFilePreview] = useState(null); // {path, name}
  /* 传给 Message 的回调必须引用稳定,否则 React.memo 形同虚设:
     每次渲染新建一个箭头函数,200 条消息就全部重渲染。
     send / changePermissionMode 本身每次渲染都是新的,所以用 ref 中转。 */
  const sendRef = useRef(null);
  const permRef = useRef(null);
  const onQuickReply = React.useCallback((t) => sendRef.current?.(t), []);
  const onEnableSystemMode = React.useCallback(() => permRef.current?.('system'), []);
  const onFileLink = React.useCallback((p) => setFilePreview({
    path: p, name: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  }), []);
  const [visibleCount, setVisibleCount] = useState(200); // 长对话窗口化渲染
  const [slashIndex, setSlashIndex] = useState(0);       // 斜杠命令菜单选中项
  const permissionMode = conv.permissionMode || (conv.autoApprove ? 'system' : 'workspace');

  /* /github login 的一次性码是异步推过来的。只有从聊天里发起时才贴进对话 ——
     从顶栏徽标登录的人正看着弹层,再往对话里插一条纯属噪音。 */
  useEffect(() => window.api.github.onProgress((p) => {
    if (p.hostId !== hostId || !ghFromChat.current) return;
    if (p.code && !p.done) {
      localNote(`GitHub 一次性码:${p.code}\n在这里授权(码已填好):${p.openUrl}`);
    }
    // eslint-disable-next-line
  }), [hostId]);

  // 进入对话/切换模型或权限时,在主进程(重新)初始化 agent 会话(带 resume 状态续聊)
  useEffect(() => {
    /* 有轮次在途时绝不重启:agent:start 会 cancel 掉现有会话。
       团队模式换引擎时正处于在途状态,不挡住的话会把刚发出的那一轮掐死。 */
    if (useStore.getState().agentRunning[conv.id]) { setStarted(true); return; }
    window.api.agent.start({
      hostId, convId: conv.id,
      opts: {
        agent: conv.agent, cwd: conv.cwd, model: conv.model, permissionMode,
        /* dsh 没有 resume:重开应用后会话对象是空的,不喂历史就等于从零开始。
           claude/codex 靠各自的 sessionId 续聊,不需要也不该走这条。 */
        history: conv.agent === 'dsh' ? dshHistoryFrom(conv.messages) : [],
        // 只有 codex 有 model_reasoning_effort
        reasoningEffort: conv.agent === 'codex' ? (conv.reasoningEffort || '') : ''
      },
      resume: { claudeSessionId: conv.claudeSessionId, codexSessionId: conv.codexSessionId, codexStarted: conv.codexStarted }
    }).then(() => setStarted(true)).catch(() => setStarted(true));
    // eslint-disable-next-line
  }, [conv.id, permissionMode, conv.model, conv.agent, conv.reasoningEffort]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [conv.messages, running]);

  /** 本地消息(命令回执),不发给模型 */
  const localNote = (text) =>
    useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text, ts: Date.now() });

  /** 处理斜杠命令;返回 true 表示已消费,不再发给模型 */
  const runSlashCommand = (raw) => {
    const { isCommand, name, args, known } = parseSlash(raw);
    if (!isCommand) return false;
    if (!known) { localNote(`未知命令 /${name}。输入 /help 查看全部命令。`); return true; }
    const st = useStore.getState();

    switch (name) {
      case 'help': localNote(helpText()); return true;
      case 'clear': setInput(''); return true;
      case 'new': setActiveConv(hostId, null); return true;
      case 'skill': st.setTab('skills'); return true;
      case 'export': {
        window.api.files.saveText({
          defaultName: `${conv.title || '对话'}.md`, content: conversationToMarkdown(conv)
        }).then((r) => { if (r?.saved) localNote(`已导出到 ${r.path}`); }).catch(() => {});
        return true;
      }
      case 'github': {
        const sub = (args.trim() || 'status').toLowerCase();
        if (sub === 'status') {
          window.api.github.status({ hostId }).then((r) => localNote(
            r.loggedIn
              ? `GitHub(${hostId === 'local' ? '本机' : hostName || '当前主机'}):已登录 ${r.username}`
                + `${r.scopes ? ` · ${r.scopes}` : ''}`
              : r.installed ? 'GitHub:已装 gh 但未登录,用 /github login 登录'
                : 'GitHub:这台主机没装 gh,到「环境配置」页点「安装 gh」'
          )).catch((e) => localNote(`查询失败:${e.message}`));
          return true;
        }
        if (sub === 'login') {
          // 一次性码是异步事件推过来的,这里先挂个标记,收到再贴进对话
          ghFromChat.current = true;
          localNote('正在申请一次性码…');
          window.api.github.login({ hostId })
            .then((r) => {
              ghFromChat.current = false;
              localNote(r.done
                ? `✓ 已登录 ${r.username}${r.gitConfigured ? ' · git push 免密已配好' : ''}`
                : `登录未完成${r.error ? `:${r.error}` : ''}`);
            })
            .catch((e) => { ghFromChat.current = false; localNote(`登录失败:${e.message}`); });
          return true;
        }
        if (sub === 'sync') {
          if (hostId === 'local') { localNote('当前就是本机,无需下发'); return true; }
          window.api.github.syncToRemote({ hostId })
            .then((r) => localNote(r.message))
            .catch((e) => localNote(`下发失败:${e.message}`));
          return true;
        }
        localNote('用法:/github status | login | sync');
        return true;
      }
      case 'team': {
        const a = args.trim().toLowerCase();
        if (!a || a === 'status') {
          const t = conv.team;
          localNote(t
            ? `团队模式:${engineLabel(t.worker)} 干活 · ${engineLabel(t.reviewer)} 审查`
              + `(已审查 ${t.reviews || 0} 次,当前${t.phase === 'review' ? '审查中' : '执行中'})`
            : `团队模式未开启。可用搭配:\n${TEAM_PRESETS.map((p) => `  /team ${p.worker}+${p.reviewer}  —— ${p.label}`).join('\n')}`);
          return true;
        }
        if (a === 'off') {
          useStore.getState().setConversationTeam(conv.id, null);
          localNote('团队模式已关闭'); return true;
        }
        const [worker, reviewer] = a.split(/[+/,\s]+/).filter(Boolean);
        try {
          // 记住各自的模型:来回切引擎时不能把用户选的模型清掉
          const team = createTeam({
            worker, reviewer,
            workerModel: worker === conv.agent ? (conv.model || '') : '',
            reviewerModel: ''
          });
          if (!['codex', 'claude', 'deepseek', 'dsh'].includes(worker)
            || !['codex', 'claude', 'deepseek', 'dsh'].includes(reviewer)) {
            localNote('引擎只能是 codex / claude / deepseek / dsh'); return true;
          }
          useStore.getState().setConversationTeam(conv.id, team);
          if (conv.agent !== worker) { setStarted(false); updateConversationAgent(conv.id, worker); }
          localNote([
            `👥 团队模式已开启:${engineLabel(worker)} 干活 · ${engineLabel(reviewer)} 审查`,
            '需要配合目标模式使用 —— 用 /goal <目标> 设定目标后,两方会自动轮转推进。',
            '注意:每轮审查也要花 token,成本大约是单引擎的两倍。'
          ].join('\n'));
        } catch (e) { localNote(`开启失败:${e.message}`); }
        return true;
      }
      case 'engine': {
        const target = args.trim().toLowerCase();
        if (!['codex', 'claude', 'deepseek', 'dsh'].includes(target)) {
          localNote('用法:/engine codex | claude | deepseek | dsh'); return true;
        }
        setStarted(false); updateConversationAgent(conv.id, target);
        localNote(`已切换引擎:${target}(上下文自动接力)`); return true;
      }
      case 'model': {
        setStarted(false); updateConversationModel(conv.id, args.trim());
        localNote(args.trim() ? `已切换模型:${args.trim()}` : '已恢复默认模型'); return true;
      }
      case 'mode': {
        const target = args.trim().toLowerCase();
        if (!['workspace', 'system'].includes(target)) { localNote('用法:/mode workspace | system'); return true; }
        changePermissionMode(target); localNote(`权限模式:${target}`); return true;
      }
      case 'auto': {
        const on = !/^off|关|0$/i.test(args.trim());
        st.updateConversationAutoConfirm(conv.id, on);
        localNote(`全自动:${on ? '开' : '关'}`); return true;
      }
      case 'goal': {
        const { sub, text, rounds, raw, command, verifyCommand, planPath } = parseGoalArgs(args);
        const goal = conv.goal;
        if (sub === 'set') {
          /* **拆解默认发生。** 没给路径就用默认的 —— 要用户先想出一个路径
             再手敲 --plan,这个功能就只有极少数人会用到,而它恰恰是
             "目标模式"和"跑 25 轮然后停"之间的全部差别。 */
          const file = planPath || defaultPlanPath(conv.id);
          const fresh = createGoal(text, { verifyCommand, planPath: file });
          st.setConversationGoal(conv.id, fresh);
          localNote([
            `🎯 目标已设定:${text}`,
            verifyCommand
              /* 有验收命令 = 硬判据。这条差别值得在设定时就说清楚,
                 因为它决定了"达成"这两个字有多可信。 */
              ? `验收命令(退出码 0 才算达成):${verifyCommand}`
              : '⚠ 没有验收命令,达成只能靠模型自述 —— 建议用 /goal check <命令> 补一条,'
                + '\n  比如 `npm test`、`curl -fsS localhost:8000/v1/models`、`test -f /path/to/产物`。',
            `第一轮先拆解成清单并写入 ${file},之后状态条按「第 N / M 步」走。`,
            `预算:${fmtTokens(GOAL_DEFAULT_TOKEN_BUDGET)} token(/goal budget 5m 可调);`
              + `轮次兜底 ${GOAL_DEFAULT_MAX_ROUNDS},读到计划后会按步数自动上调。`,
            '随时可用 /goal pause 暂停、/goal clear 清除。'
          ].join('\n'));
          /* 第 0 轮是**拆解**,不是"继续推进"。
             原来一上来就说"继续推进",模型只能边想边做,
             于是进度永远只能用轮次表示 —— 而轮次说不出还剩多少活儿。 */
          setTimeout(() => sendToAgent(hostId, conv.id, buildDecomposePrompt(fresh), [], { auto: true }), 0);
          return true;
        }
        if (!goal?.text) { localNote('当前没有目标。用 /goal <目标描述> 设定一个。'); return true; }
        if (sub === 'status') {
          localNote([
            `🎯 目标:${goal.text}`,
            `状态:${goal.status} · 已推进 ${goal.rounds || 0}/${goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS} 轮`,
            goal.plan?.total
              ? `计划:${goal.plan.text} · 当前「${goal.plan.currentText || '?'}」(${goal.planPath})`
              : (goal.planPath ? `计划文件:${goal.planPath}(还没读到内容)` : '')
          ].filter(Boolean).join('\n'));
        } else if (sub === 'plan') {
          /* 计划文件是把"第 12 轮"换成「第 3 / 18 步」的唯一来源。
             设完立刻读一次,免得人要等下一轮结束才知道路径写对没有。 */
          st.updateConversationGoal(conv.id, {
            planPath, plan: null, planHistory: [], planPushback: 0, planScaled: false, planSource: ''
          });
          localNote(`🎯 计划文件已设为 ${planPath},正在读取…`);
          refreshGoalPlan(hostId, conv.id).then(() => {
            const g = useStore.getState().conversations[conv.id]?.goal;
            localNote(g?.planSource === 'file'
              ? `🎯 已读到计划:${g.plan.text}(当前「${g.plan.currentText}」)`
              : `🎯 这个文件里没有 \`- [ ] xxx\` 形式的清单。`
                + `\n用 /goal replan 让它按当前目标拆一份出来。`);
          });
        } else if (sub === 'replan') {
          /* 拆坏了要能重来:粒度太粗看不出进度、太细全是琐事,
             都得靠人看一眼才知道。没有这条命令的话,唯一办法是清掉目标重设,
             那会把已经推进的轮次和预算一起丢掉。 */
          st.updateConversationGoal(conv.id, {
            plan: null, planHistory: [], planPushback: 0, planScaled: false, planSource: ''
          });
          localNote(`🎯 重新拆解中,清单会写到 ${goal.planPath || '(未设置计划文件)'}`);
          setTimeout(() => sendToAgent(hostId, conv.id, buildDecomposePrompt(goal), [], { auto: true }), 0);
        } else if (sub === 'pause') {
          st.updateConversationGoal(conv.id, { status: 'paused' }); localNote('🎯 目标模式已暂停');
        } else if (sub === 'resume') {
          // 触顶停下的必须同时抬预算,否则跑完一轮又立刻触顶
          const patch = resumeGoalPatch(goal);
          st.updateConversationGoal(conv.id, patch);
          localNote(patch.maxRounds
            ? `🎯 目标模式已继续,轮次预算提到 ${patch.maxRounds}`
            : '🎯 目标模式已继续');
          setTimeout(() => sendToAgent(hostId, conv.id, buildContinuePrompt(goal), [], { auto: true }), 0);
        } else if (sub === 'max') {
          try {
            const patch = setGoalMaxRounds(goal, rounds);
            st.updateConversationGoal(conv.id, patch);
            localNote(`🎯 轮次预算已设为 ${patch.maxRounds}(当前 ${goal.rounds || 0} 轮)`);
          } catch (e) { localNote(`🎯 ${e.message}`); }
        } else if (sub === 'budget') {
          /* token 预算才是真闸门 —— 轮次上限只是防死循环的兜底 */
          try {
            const patch = setGoalTokenBudget(goal, raw);
            st.updateConversationGoal(conv.id, patch);
            localNote(`🎯 token 预算已设为 ${fmtTokens(patch.tokenBudget)}`);
          } catch (e) { localNote(`🎯 ${e.message}`); }
        } else if (sub === 'check') {
          /* 给目标装上硬判据。这是目标模式里最值得设的一项:
             模型说"已完成"的成本是零,而这条命令的退出码不会撒谎。 */
          st.updateConversationGoal(conv.id, { verifyCommand: command, verifying: false });
          localNote(`🎯 验收命令已设定,今后以它的退出码为准:\n${command}`);
        } else if (sub === 'clear') {
          st.setConversationGoal(conv.id, null); localNote('🎯 目标已清除');
        }
        return true;
      }
      default: return false;
    }
  };

  const send = async (textOverride) => {
    const raw = (textOverride ?? input).trim();
    // 斜杠命令在本地执行,不消耗模型
    if (textOverride == null && raw.startsWith('/')) {
      if (runSlashCommand(raw)) { setInput(''); setSlashIndex(0); return; }
    }
    const prompt = raw || (pendingFiles.length ? 'Please process the attached files.' : '');
    if (!prompt) return;
    setAttachmentError('');
    // 发送后回到"草稿"态,下次 ↑ 从最新一条重新开始
    historyRef.current.index = null;
    historyRef.current.draft = '';
    if (textOverride == null) setInput('');
    const files = textOverride == null ? pendingFiles : [];
    /* 附件信息不全就**别发**,而且别清空输入框。
       让它发出去的话,要到主进程上传时才抛一句「附件信息不完整」——
       那时候用户既不知道是哪个文件,也不知道为什么,而消息已经没了。 */
    const broken = files.map((f) => [f, attachmentProblem(f)]).find(([, p]) => p);
    if (broken) {
      setAttachmentError(`${broken[0].name || '附件'}:${broken[1]}`);
      if (textOverride == null) setInput(raw);
      return;
    }
    if (textOverride == null) setPendingFiles([]);
    // 正在执行/未初始化 -> 进入排队,本轮结束后自动发送
    if (running || !started) {
      useStore.getState().enqueuePrompt(conv.id, {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: prompt, files
      });
      return;
    }
    await sendToAgent(hostId, conv.id, prompt, files);
  };

  const addFiles = (rawFiles) => {
    const MAX_MB = 200;   // 与主进程 MAX_ATTACHMENT_BYTES 保持一致
    const limit = MAX_MB * 1024 * 1024;
    /* **一进来就抄成普通对象,后面不再持有 File 实例。**
       File 的 name/size 是原型 getter,`{ ...file, thumb }` 展开后会
       悄无声息地只剩 path —— 附件到了主进程才报「信息不完整」。
       在入口归一化,后面怎么展开都不会掉东西。 */
    const files = Array.from(rawFiles || []).map(toAttachment).filter(Boolean);
    const next = files.filter((file) => file.path && file.size <= limit);
    const oversized = files.find((file) => file.size > limit);
    /* **拿不到路径的要说出来。**
       原来这类文件被 `file.path &&` 直接滤掉,一声不吭 —— 从浏览器里
       拖过来的图片、某些应用给的内存数据都会走到这儿,用户看到的就是
       "图片拖进去没了"。丢东西可以,但不能不告诉人。 */
    const noPath = files.find((file) => !file.path);
    setAttachmentError(
      oversized
        ? `${oversized.name} 超过 ${MAX_MB} MB 上限(实际 ${Math.round(oversized.size / 1024 / 1024)} MB)`
        : noPath
          ? `${noPath.name || '这个文件'}拿不到磁盘路径,没能加进来 —— `
            + '它可能是网页里的图片或内存数据,先存成本地文件再拖进来,或直接复制后粘贴。'
          : ''
    );
    setPendingFiles((current) => {
      const known = new Set(current.map((file) => file.path));
      return [...current, ...next.filter((file) => !known.has(file.path))];
    });
    // 图片附件:异步生成缩略图供发送前预览
    for (const file of next) {
      if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || '')) {
        window.api.files.imageThumb(file.path).then((thumb) => {
          if (thumb) setPendingFiles((items) =>
            items.map((it) => (it.path === file.path ? { ...it, thumb } : it)));
        }).catch(() => {});
      }
    }
  };

  const pickFiles = async () => addFiles(await window.api.dialog.pickFiles());

  /* ---- 历史输入回溯(↑/↓,类似终端):最近发送的在前,连续重复只留一条 ---- */
  const promptHistory = useMemo(() => buildPromptHistory(conv.messages), [conv.messages]);
  // index=null 表示正在编辑草稿;0 为最近一条,越大越早
  const historyRef = useRef({ index: null, draft: '' });
  const inputRef = useRef(null);

  /** step: +1 更早,-1 更新;返回是否消费了这次按键 */
  const recallHistory = (step) => {
    const result = stepPromptHistory(historyRef.current, promptHistory, step, input);
    if (!result.handled) return false;
    historyRef.current = { index: result.index, draft: result.draft };
    setInput(result.value);
    // 光标移到末尾(等 React 应用完新值)
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
    return true;
  };
  const resetHistoryNav = () => { historyRef.current.index = null; };

  // 语音输入:转写结果追加到输入框
  const voice = useVoiceInput((text) => setInput((cur) => (cur ? `${cur} ${text}` : text)));

  // 区域截图:按钮触发 + 全局快捷键回填,统一作为附件加入
  const captureScreenshot = async () => {
    const shot = await window.api.screenshot.capture().catch(() => null);
    if (shot) addFiles([shot]);
  };
  useEffect(() => {
    const off = window.api.screenshot.onCaptured((shot) => { if (shot) addFiles([shot]); });
    return off;
    // eslint-disable-next-line
  }, []);

  /** 粘贴/按钮:把剪贴板中的截图落盘为 PNG 并加入附件 */
  const attachClipboardImage = async () => {
    const img = await window.api.clipboard.saveImage().catch(() => null);
    if (img) { addFiles([img]); return true; }
    return false;
  };
  /**
   * 粘贴:同时支持三种来源
   *  1) 从访达/资源管理器复制的真实文件(有磁盘路径)
   *  2) 截图等剪贴板图片数据(无路径,需先落盘)
   *  3) 普通文本(交给输入框默认行为)
   */
  const onPaste = (event) => {
    const dt = event.clipboardData;
    if (!dt) return;

    // 1) 真实文件:用与拖拽同一套路径解析
    const pasted = [...(dt.files || [])];
    if (pasted.length) {
      const resolved = pasted.map((file) => {
        // 内存中的文件(截图数据)拿不到磁盘路径,getPathForFile 可能返回空或抛错
        let path = '';
        try { path = window.api.dialog.pathForDroppedFile(file) || ''; } catch (_) { path = ''; }
        return { file, path, name: file.name, size: file.size };
      });
      const withPath = resolved.filter((r) => r.path);
      if (withPath.length) {
        event.preventDefault();
        addFiles(withPath.map(({ path, name, size }) => ({ path, name, size })));
        return;
      }
      // 拿不到路径的多半是内存里的图片数据(如截图),走落盘那条路
      if (resolved.some((r) => r.file.type?.startsWith('image/'))) {
        event.preventDefault();
        attachClipboardImage();
        return;
      }
    }

    // 2) 没有 files 但有图片数据(部分应用只提供 items)
    const items = [...(dt.items || [])];
    if (items.some((it) => it.type?.startsWith('image/'))) {
      event.preventDefault();
      attachClipboardImage();
    }
    // 3) 其余情况保持默认粘贴行为
  };
  const dropFiles = (event) => {
    event.preventDefault();
    setDragActive(false);
    addFiles([...event.dataTransfer.files].map((file) => ({
      path: window.api.dialog.pathForDroppedFile(file),
      name: file.name,
      size: file.size
    })));
  };

  const queued = useStore((s) => s.queued[conv.id] || EMPTY_QUEUE);
  const cancel = () => {
    useStore.getState().clearQueued(conv.id); // 手动停止时同时清空排队
    window.api.agent.cancel({ hostId, convId: conv.id });
  };

  const changePermissionMode = (nextMode) => {
    if (nextMode === 'system' && !window.confirm(
      '启用系统权限将允许此对话访问 Docker 和远程主机级命令。命令可修改工作目录之外的文件和服务。是否继续？'
    )) return;
    setStarted(false);
    updateConversationPermission(conv.id, nextMode);
  };

  sendRef.current = send;
  permRef.current = changePermissionMode;

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <button className="btn small ghost" onClick={() => setActiveConv(hostId, null)}>← 记录</button>
        <SplitControls hostId={hostId} conv={conv} split={split} />
        <select className={`agent-select ${conv.agent}`} value={conv.agent} disabled={running}
          title="切换引擎(同一对话内共用上下文,切换后首条消息自动携带对话摘要)"
          onChange={(e) => { setStarted(false); updateConversationAgent(conv.id, e.target.value); }}>
          <option value="codex">⬡ Codex</option>
          <option value="claude">✳ Claude Code</option>
          <option value="deepseek">◈ DeepSeek</option>
          <option value="dsh">▣ DeepSeek Harness</option>
        </select>
        {/* 就在干活的地方看到引擎是否可用,并原地安装/下发认证,不用切页 */}
        <EngineStatus hostId={hostId} engine={conv.agent} />
        {/* 同理:要 push 的时候人在这里,没登录不该逼人切去环境配置 */}
        <GithubBadge hostId={hostId} isLocal={hostId === 'local'} hostLabel={hostName} />
        <b className="conv-title">{conv.title}</b>
        {/* 路径缩短显示:保尾不保头 —— 有信息量的是项目名,
            而 `/Users/<用户名>/` 每条路径都一样。完整路径在 tooltip 里,
            点一下复制(要粘到终端里的时候不用手抄)。 */}
        <span className="muted small conv-cwd" title={`${conv.cwd || '~'}\n(点击复制)`}
          onClick={() => window.api.clipboard.writeText(conv.cwd || '')}>
          {shortenPath(conv.cwd)}
        </span>
        <ModelPicker
          agent={conv.agent}
          value={conv.model || ''}
          disabled={running}
          hostId={hostId}
          /* 环境检测本来就拿到了 claude 版本号,拿来比一下就能在选之前提示 */
          cliVersion={hostEnv?.claude || ''}
          onChange={(m) => { setStarted(false); updateConversationModel(conv.id, m); }}
        />
        {/* 推理强度只有 codex 有(model_reasoning_effort);
            放在模型旁边,因为这两个是同一件事的两个维度 */}
        {conv.agent === 'codex' && (
          <select className="reasoning-picker" disabled={running}
            title="推理强度取决于模型支持；GPT-6 Astra 最低为 low，支持 max。默认跟随 CLI 配置。"
            value={conv.model === 'gpt-6-astra' && conv.reasoningEffort === 'minimal' ? 'low' : (conv.reasoningEffort || '')}
            onChange={(e) => {
              setStarted(false);
              useStore.getState().updateConversationReasoning(conv.id, e.target.value);
            }}>
            {REASONING_EFFORTS.filter((r) => conv.model !== 'gpt-6-astra' || r.value !== 'minimal').map((r) => (
              <option key={r.value} value={r.value}>
                {r.value ? `🧠 ${r.label}` : '🧠 默认'}
              </option>
            ))}
          </select>
        )}
        {conv.usage && (conv.usage.inputTokens > 0 || conv.usage.outputTokens > 0) && (
          <span className="usage-badge muted small"
            title={`累计输入 ${conv.usage.inputTokens.toLocaleString()} / 输出 ${conv.usage.outputTokens.toLocaleString()} tokens${conv.usage.costUsd ? ` · 费用 $${conv.usage.costUsd.toFixed(4)}` : ''}`}>
            Σ {formatTokens(conv.usage.inputTokens + conv.usage.outputTokens)}
            {conv.usage.costUsd > 0 && ` · $${conv.usage.costUsd.toFixed(2)}`}
          </span>
        )}
        <button className="icon-btn" title="存入 Obsidian 知识库(提炼成原子笔记 + 双链)"
          disabled={running}
          onClick={async () => {
            const note = (t) => useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text: t, ts: Date.now() });
            const cfg = await window.api.obsidian.getConfig().catch(() => null);
            if (!cfg || (cfg.transport === 'file' && !cfg.vaultPath)) {
              note('请先到「设置 → Obsidian 知识库」选择 vault 目录。');
              return;
            }
            note('🧠 正在提炼知识笔记…');
            try {
              const r = await window.api.obsidian.saveFromConversation({
                hostId, agent: conv.agent, cwd: conv.cwd, model: conv.model,
                content: conversationToMarkdown(conv), topic: conv.title
              });
              note(`🧠 已写入 ${r.count} 篇笔记到 ${r.folder}/,并更新索引「${r.mocName}」。打开 Obsidian 即可看到图谱。`);
            } catch (e) { note(`❌ 存入知识库失败:${e?.message || e}`); }
          }}>🧠</button>
        <button className="icon-btn" title="导出对话为 Markdown"
          onClick={async () => {
            const r = await window.api.files.saveText({
              defaultName: `${conv.title || '对话'}.md`,
              content: conversationToMarkdown(conv)
            }).catch(() => null);
            if (r?.saved) useStore.getState().pushMessage(conv.id, { role: 'agent', kind: 'raw', text: `已导出到 ${r.path}`, ts: Date.now() });
          }}>⇩</button>
        {/* 「系统权限」徽标 + 「System Mode」复选框原来是**同一个状态显示两遍**
            (都由 permissionMode === 'system' 驱动),白占一大截宽度,
            也是这一行被挤到换行的直接原因。合成一个开关:开着就是红的,
            警示作用由它自己承担,不需要旁边再挂个徽标。
            顺带把 System Mode 改成中文 —— 徽标本来就叫「系统权限」,
            同一件事在同一行里有两个名字,只会让人以为是两回事。 */}
        <button type="button"
          className={`chip-toggle push-right${conv.autoConfirm ? ' on' : ''}`}
          title="全自动:模型请求确认时自动回复「确认,继续」,并提示模型自行决策;连续 5 次后暂停防失控"
          onClick={() => useStore.getState().updateConversationAutoConfirm(conv.id, !conv.autoConfirm)}>
          ⚡ 全自动
        </button>
        <button type="button"
          className={`chip-toggle${permissionMode === 'system' ? ' on danger' : ''}`}
          disabled={running}
          title="系统权限:允许此对话使用 Docker 和主机级命令,可修改工作目录之外的文件与服务"
          onClick={() => changePermissionMode(permissionMode === 'system' ? 'workspace' : 'system')}>
          {permissionMode === 'system' ? '🔓 系统权限' : '🔒 工作区'}
        </button>
      </div>
      <TeamBar conv={conv} />
      <GoalBar conv={conv} />
      <div className="chat-list" ref={listRef}>
        {conv.messages.length === 0 && (
          <div className="muted center pad">向{hostId === 'local' ? '本机' : '远程'}的 {conv.agent === 'codex' ? 'Codex' : 'Claude Code'} 发出第一条指令吧</div>
        )}
        {conv.messages.length > visibleCount && (
          <button className="btn small ghost load-earlier"
            onClick={() => setVisibleCount((n) => n + 200)}>
            ↑ 加载更早的 {Math.min(200, conv.messages.length - visibleCount)} 条(共 {conv.messages.length} 条)
          </button>
        )}
        {conv.messages.slice(-visibleCount).map((m, i, arr) => {
          const realIndex = conv.messages.length - arr.length + i;
          return (
            <Message key={`${m.ts || 0}_${realIndex}`} m={m} hostId={hostId} convId={conv.id}
              onEnableSystemMode={onEnableSystemMode}
              isLast={realIndex === conv.messages.length - 1}
              running={running}
              onQuickReply={onQuickReply}
              onFileLink={onFileLink} />
          );
        })}
        {running && <div className="typing"><span /><span /><span /> {hostId === 'local' ? '本地' : '远程'}执行中...</div>}
        {queued.length > 0 && (
          <div className="queue-list">
            {queued.map((q, i) => (
              <div className="queue-item" key={q.id}>
                <span className="chip">⏳ 排队 {i + 1}</span>
                <span className="queue-text">{q.text.slice(0, 80)}</span>
                {/* 把附件数显示出来 —— 排队时看不到附件,人根本无从发现它丢了。
                    这次这个 bug 之所以拖到现在,一半原因就是它不可见。 */}
                {q.files?.length > 0 && (
                  <span className="muted small" title={q.files.map((f) => f.name).join('\n')}>
                    📎 {q.files.length}
                  </span>
                )}
                <button className="icon-btn" title="移出队列"
                  onClick={() => useStore.getState().removeQueued(conv.id, q.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={`chat-input ${dragActive ? 'drag-active' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragActive(false); }}
        onDrop={dropFiles}>
        {pendingFiles.length > 0 && (
          <div className="attachment-queue">
            {pendingFiles.map((file) => file.thumb ? (
              <span className="attachment-thumb-wrap" key={file.path} title={`${file.name}(${(file.size / 1024).toFixed(0)} KB)`}>
                <img className="attachment-thumb" src={file.thumb} alt={file.name} />
                <button type="button" className="attachment-thumb-remove" title="移除"
                  onClick={() => setPendingFiles((items) => items.filter((item) => item.path !== file.path))}>×</button>
              </span>
            ) : (
              <span className="attachment-chip" key={file.path} title={file.path}>
                <span className="attachment-name">{file.name}</span>
                <button type="button" title="Remove attachment" onClick={() => setPendingFiles((items) => items.filter((item) => item.path !== file.path))}>×</button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        {dragActive && <div className="drop-hint">Drop files to attach</div>}
        <SlashMenu input={input} index={slashIndex}
          onPick={(c) => { setInput(applyCompletion(c)); setSlashIndex(0); inputRef.current?.focus(); }} />
        <button className="btn attach-button" type="button" onClick={pickFiles} disabled={running} title="Add attachments">附件</button>
        <button className="btn attach-button" type="button" onClick={captureScreenshot}
          title="区域截图(默认快捷键 ⌘/Ctrl+Shift+2)">✂ 截图</button>
        <button className={`btn attach-button mic-button ${voice.state}`} type="button"
          onClick={voice.toggle} disabled={voice.state === 'transcribing'}
          title={voice.state === 'recording' ? '点击停止并转写' : (voice.state === 'transcribing' ? '转写中…' : '语音输入(需在设置里配置转写端点)')}>
          {voice.state === 'recording' ? '● 录音中' : voice.state === 'transcribing' ? '转写中…' : '🎤 语音'}
        </button>
        {voice.error && <span className="voice-error" title={voice.error}>{voice.error}</span>}
        <textarea
          autoFocus
          ref={inputRef}
          value={input}
          placeholder={started ? '输入指令,Enter 发送,↑↓ 调历史,⌘V 粘贴截图/文件,🎤 语音,Shift+Enter 换行' : '正在初始化会话...'}
          onChange={(e) => { setInput(e.target.value); resetHistoryNav(); }}
          onPaste={onPaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing || composingRef.current;
            // 斜杠命令菜单:↑↓ 选择,Tab/Enter 补全,Esc 关闭
            const cmds = matchCommands(input);
            if (cmds.length && !composing) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % cmds.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + cmds.length) % cmds.length); return; }
              if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                const picked = cmds[Math.min(slashIndex, cmds.length - 1)];
                // 无参数命令按 Enter 直接执行,有参数的先补全等你填
                if (e.key === 'Tab' || picked.args) {
                  e.preventDefault();
                  setInput(applyCompletion(picked));
                  setSlashIndex(0);
                  return;
                }
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !composing) {
              e.preventDefault();
              send();
              return;
            }
            // ↑/↓ 调历史:仅当光标在首行/末行时接管,避免打断多行编辑与输入法候选
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !composing) {
              const el = e.currentTarget;
              const collapsed = el.selectionStart === el.selectionEnd;
              const onFirstLine = collapsed && !el.value.slice(0, el.selectionStart).includes('\n');
              const onLastLine = collapsed && !el.value.slice(el.selectionEnd).includes('\n');
              if (e.key === 'ArrowUp' && onFirstLine && recallHistory(1)) e.preventDefault();
              else if (e.key === 'ArrowDown' && onLastLine && recallHistory(-1)) e.preventDefault();
            }
          }}
        />
        {running && <button className="btn danger" onClick={cancel}>停止</button>}
        <button className="btn primary" onClick={() => send()}
          disabled={!input.trim() && pendingFiles.length === 0}
          title={running ? '当前轮结束后自动发送' : ''}>
          {running || !started ? '排队发送' : '发送'}
        </button>
      </div>
      {filePreview && (
        <FilePreview hostId={hostId} filePath={filePreview.path} name={filePreview.name}
          onClose={() => setFilePreview(null)} />
      )}
    </div>
  );
}


const EMPTY_QUEUE = [];    


/* 斜杠命令补全菜单 */
function SlashMenu({ input, index, onPick }) {
  const cmds = matchCommands(input);
  if (!cmds.length) return null;
  return (
    <div className="slash-menu">
      {cmds.map((c, i) => (
        <div key={c.name} className={`slash-item ${i === Math.min(index, cmds.length - 1) ? 'active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(c); }}>
          <span className="slash-name">/{c.name}</span>
          {c.args && <span className="slash-args">{c.args}</span>}
          <span className="slash-desc muted small">{c.desc}</span>
        </div>
      ))}
      <div className="slash-hint muted small">↑↓ 选择 · Tab 补全 · Esc 关闭</div>
    </div>
  );
}

/* 团队模式状态条:当前谁在干活、审查了几次、被打回几次 */
function TeamBar({ conv }) {
  const team = conv.team;
  if (!team?.worker) return null;
  const reviewing = team.phase === 'review';
  return (
    <div className="team-bar">
      <span className="team-tag">👥 团队</span>
      <span className={`team-role ${reviewing ? '' : 'active'}`}>
        {engineLabel(team.worker)} 干活
      </span>
      <span className="team-arrow">{reviewing ? '→' : '←'}</span>
      <span className={`team-role ${reviewing ? 'active' : ''}`}>
        {engineLabel(team.reviewer)} 审查
      </span>
      <span className="muted small">
        已审查 {team.reviews || 0} 次
        {team.rejects > 0 && ` · 连续打回 ${team.rejects} 次`}
      </span>
      <span className="flex1" />
      <button className="btn tiny ghost"
        onClick={() => useStore.getState().setConversationTeam(conv.id, null)}>关闭</button>
    </div>
  );
}


