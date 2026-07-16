import React, { useMemo, useState } from 'react';
import { useStore, sendToAgent } from '../store.js';
import { translate as tr } from '../i18n.mjs';

const labelStatus = (status, t) => t(`status_${status}`);
const labelRisk = (risk, t) => t(`risk_${risk}`);

export default function TaskPanel({ hostId }) {
  const tasks = useStore((s) => s.tasks);
  const activeTaskId = useStore((s) => s.activeTaskByHost[hostId]);
  const setActiveTask = useStore((s) => s.setActiveTask);
  const conversations = useStore((s) => s.conversations);
  const setActiveConv = useStore((s) => s.setActiveConv);
  const reviewTask = useStore((s) => s.reviewTask);
  const updateTaskStatus = useStore((s) => s.updateTaskStatus);
  const recordTaskDelivery = useStore((s) => s.recordTaskDelivery);
  const retryTask = useStore((s) => s.retryTask);
  const resolveTaskApproval = useStore((s) => s.resolveTaskApproval);
  const startTaskStage = useStore((s) => s.startTaskStage);
  const createConversation = useStore((s) => s.createConversation);
  const language = useStore((s) => s.settings.language);
  const t = (key) => tr(language, key);
  const [selected, setSelected] = useState(null);
  const [inboxOnly, setInboxOnly] = useState(false);
  const list = useMemo(() => Object.values(tasks).filter((task) => task.hostId === hostId)
    .filter((task) => !inboxOnly || ['needs_approval', 'review_ready'].includes(task.status))
    .sort((a, b) => b.updatedAt - a.updatedAt), [tasks, hostId, inboxOnly]);
  const hostUsage = useMemo(() => Object.values(conversations)
    .filter((conversation) => conversation.hostId === hostId)
    .reduce((total, conversation) => ({
      inputTokens: total.inputTokens + (conversation.usage?.inputTokens || 0),
      outputTokens: total.outputTokens + (conversation.usage?.outputTokens || 0),
      costUsd: total.costUsd + (conversation.usage?.costUsd || 0)
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 }), [conversations, hostId]);
  const task = selected ? tasks[selected] : tasks[activeTaskId] || list[0];

  return <div className="task-panel">
    <aside className="task-list"><h2>{t('tasks')}</h2><button className="btn small ghost" onClick={() => setInboxOnly((value) => !value)}>Review Inbox</button><UsageSummary usage={hostUsage} t={t} />
      {list.length === 0 ? <p className="muted">{t('taskHelp')}</p> : list.map((item) =>
        <button key={item.id} className={`task-row ${task?.id === item.id ? 'active' : ''}`} onClick={() => { setSelected(item.id); setActiveTask(hostId, item.id); }}>
          <b>{item.title}</b><span className={`task-status ${item.status}`}>{labelStatus(item.status, t)}</span>
        </button>)}
    </aside>
    <section className="task-detail">{task ? <DeliveryCard task={task} conversation={conversations[task.convId]}
      t={t} onOpen={(convId = task.convId) => setActiveConv(hostId, convId)} onReview={reviewTask}
      onStop={async () => {
        await window.api.agent.cancel({ hostId: task.hostId, convId: task.convId });
        updateTaskStatus(task.id, 'needs_input');
        recordTaskDelivery(task.id, { auditEvents: [{ type: 'manual_stop', level: 'system', detail: '用户停止执行并接管任务', ts: Date.now() }] });
      }} onRetry={async () => {
        const retried = retryTask(task.id);
        if (!retried) return;
        setActiveConv(hostId, task.convId);
        await sendToAgent(task.hostId, task.convId, '请基于当前任务、已有交付和验收反馈继续执行；优先解决未完成或被要求修改的部分。');
      }} onApprove={async (approvalId) => {
        const approval = resolveTaskApproval(task.id, approvalId, 'approved');
        const conversation = conversations[task.convId];
        if (!approval || !conversation) return;
        await window.api.agent.start({
          hostId: task.hostId, convId: task.convId,
          opts: { agent: conversation.agent, cwd: conversation.cwd, model: conversation.model, permissionMode: 'system' },
          resume: { claudeSessionId: conversation.claudeSessionId, codexSessionId: conversation.codexSessionId, codexStarted: conversation.codexStarted }
        });
        setActiveConv(hostId, task.convId);
        await sendToAgent(task.hostId, task.convId, '该任务的系统权限请求已获批准。请仅在完成当前任务所需范围内继续执行，并在交付中说明实际执行的高风险操作。');
      }} onReject={(approvalId) => resolveTaskApproval(task.id, approvalId, 'rejected')}
      onPrepareStage={async (stage) => {
        const baseCwd = conversations[task.convId]?.cwd;
        if (!baseCwd) return;
        try {
          const isolated = await window.api.worktrees.create({ hostId: task.hostId, baseCwd, taskId: task.id, stageId: stage.id });
          const source = conversations[task.convId];
          const stageConversation = createConversation(task.hostId, {
            agent: source.agent, cwd: isolated.cwd, model: source.model, permissionMode: source.permissionMode,
            title: `${task.title} · ${stage.role}`, projectContext: source.projectContext
          });
          startTaskStage(task.id, stage.id, { cwd: isolated.cwd, convId: stageConversation.id });
          setActiveConv(hostId, stageConversation.id);
        } catch (error) {
          updateTaskStatus(task.id, 'needs_input');
          recordTaskDelivery(task.id, { auditEvents: [{ type: 'worktree_failed', level: 'workspace_write', detail: error.message, ts: Date.now() }] });
        }
      }}
      /> : <div className="empty-state"><p>{t('noTasks')}</p></div>}</section>
  </div>;
}

function UsageSummary({ usage, t }) {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const tokenText = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens;
  return <div className="task-usage-summary">
    <b>{t('usageOverview')}</b>
    <span>{tokenText} tokens · ${usage.costUsd.toFixed(4)}</span>
  </div>;
}

function DeliveryCard({ task, conversation, onOpen, onReview, onStop, onRetry, onApprove, onReject, onPrepareStage, t }) {
  const delivery = task.delivery || {};
  const deliveryPackage = task.deliveryPackage;
  const pendingApprovals = (task.approvalRequests || []).filter((approval) => approval.status === 'pending');
  const [note, setNote] = useState(task.review?.note || '');
  const canReview = task.status === 'review_ready' || task.status === 'changes_requested';
  return <div className="delivery-card">
    <div className="task-detail-head"><div><h2>{task.title}</h2><span className={`task-status ${task.status}`}>{labelStatus(task.status, t)}</span></div>
      <div><button className="btn ghost" onClick={onOpen}>{t('openChat')}</button>{task.status === 'running' && <button className="btn danger task-stop" onClick={onStop}>{t('stopTakeover')}</button>}</div></div>
    <p className="muted small">{conversation?.cwd || '~'} · {t('changes')} {delivery.diffs?.length || 0} · {t('artifacts')} {delivery.artifacts?.length || 0} · {t('dangerousOps')} {delivery.dangerousCommands?.length || 0}</p>
    {deliveryPackage && <p className="muted small">交付包快照：{new Date(deliveryPackage.generatedAt).toLocaleString()} · {deliveryPackage.diffs.length} diff · {deliveryPackage.artifacts.length} artifact</p>}
    {(task.stages || []).length > 0 && <section className="task-stages"><h3>任务阶段</h3>{task.stages.map((stage) => <div className="task-approval-card" key={stage.id}>
      <b>{stage.role}</b><span className="muted small"> · {stage.status}{stage.cwd ? ` · ${stage.cwd}` : ''}</span>
      {stage.convId ? <button className="btn small ghost" onClick={() => onOpen(stage.convId)}>打开阶段对话</button> : <button className="btn small" onClick={() => onPrepareStage(stage)}>准备隔离 worktree</button>}
    </div>)}</section>}
    {pendingApprovals.length > 0 && <section className="task-approvals"><h3>审批请求</h3>{pendingApprovals.map((approval) =>
      <div key={approval.id} className="task-approval-card"><b>{approval.scope === 'system' ? '系统权限' : approval.scope}</b>
        <p>{approval.reason}</p><p className="muted small">请求于 {new Date(approval.requestedAt).toLocaleString()}。批准后该任务会恢复执行；拒绝后保持受限权限。</p>
        <button className="btn primary" onClick={() => onApprove(approval.id)}>批准并继续</button>
        <button className="btn danger" onClick={() => onReject(approval.id)}>拒绝</button>
      </div>)}</section>}
    {pendingApprovals.length > 0 && <button className="btn small ghost" onClick={() => window.api.clipboard.writeText(`remote-agent-studio://task/${task.id}`)}>复制审批链接</button>}
    {delivery.diffs?.length > 0 && <details open><summary>{t('changeEvidence')}</summary><pre className="task-diff">{delivery.diffs.join('\n\n')}</pre></details>}
    {delivery.auditEvents?.length > 0 && <details open><summary>{t('securityAudit')}</summary><div className="task-audit-events">{delivery.auditEvents.map((event, index) =>
      <p key={`${event.ts || index}_${index}`} className={`risk-event ${event.level || 'workspace_write'}`}><b>{labelRisk(event.level || 'workspace_write', t)}</b> · {event.detail}</p>)}</div></details>}
    {delivery.dangerousCommands?.length > 0 && <details open><summary>⚠️ 危险操作</summary><pre>{delivery.dangerousCommands.join('\n')}</pre></details>}
    {(delivery.usage?.inputTokens || delivery.usage?.outputTokens) ? <p>用量：输入 {delivery.usage.inputTokens || 0} / 输出 {delivery.usage.outputTokens || 0} tokens</p> : null}
    {canReview && <div className="task-review"><textarea value={note} placeholder={t('reviewNote')} onChange={(e) => setNote(e.target.value)} />
      <button className="btn primary" onClick={() => onReview(task.id, 'accept', note)}>{t('accept')}</button>
      <button className="btn danger" onClick={() => onReview(task.id, 'changes', note)}>{t('requestChanges')}</button></div>}
    {['failed', 'needs_input', 'changes_requested'].includes(task.status) && <button className="btn primary" onClick={onRetry}>{t('retry')}</button>}
  </div>;
}
