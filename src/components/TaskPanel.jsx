import React, { useMemo, useState } from 'react';
import { useStore } from '../store.js';

const LABELS = {
  draft: '草稿', queued: '排队中', running: '执行中', needs_input: '等待输入',
  needs_approval: '等待审批', review_ready: '待验收', accepted: '已验收',
  changes_requested: '需修改', failed: '失败', archived: '已归档'
};
const RISK_LABELS = { read: '只读', workspace_write: '项目写入', external_side_effect: '外部影响', system: '系统级' };

export default function TaskPanel({ hostId }) {
  const tasks = useStore((s) => s.tasks);
  const conversations = useStore((s) => s.conversations);
  const setActiveConv = useStore((s) => s.setActiveConv);
  const reviewTask = useStore((s) => s.reviewTask);
  const [selected, setSelected] = useState(null);
  const list = useMemo(() => Object.values(tasks).filter((task) => task.hostId === hostId)
    .sort((a, b) => b.updatedAt - a.updatedAt), [tasks, hostId]);
  const hostUsage = useMemo(() => Object.values(conversations)
    .filter((conversation) => conversation.hostId === hostId)
    .reduce((total, conversation) => ({
      inputTokens: total.inputTokens + (conversation.usage?.inputTokens || 0),
      outputTokens: total.outputTokens + (conversation.usage?.outputTokens || 0),
      costUsd: total.costUsd + (conversation.usage?.costUsd || 0)
    }), { inputTokens: 0, outputTokens: 0, costUsd: 0 }), [conversations, hostId]);
  const task = selected ? tasks[selected] : list[0];

  return <div className="task-panel">
    <aside className="task-list"><h2>任务</h2><UsageSummary usage={hostUsage} />
      {list.length === 0 ? <p className="muted">从对话页创建任务后，在这里验收交付。</p> : list.map((item) =>
        <button key={item.id} className={`task-row ${task?.id === item.id ? 'active' : ''}`} onClick={() => setSelected(item.id)}>
          <b>{item.title}</b><span className={`task-status ${item.status}`}>{LABELS[item.status] || item.status}</span>
        </button>)}
    </aside>
    <section className="task-detail">{task ? <DeliveryCard task={task} conversation={conversations[task.convId]}
      onOpen={() => setActiveConv(hostId, task.convId)} onReview={reviewTask} /> : <div className="empty-state"><p>尚无任务</p></div>}</section>
  </div>;
}

function UsageSummary({ usage }) {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const tokenText = totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens;
  return <div className="task-usage-summary">
    <b>用量概览</b>
    <span>{tokenText} tokens · ${usage.costUsd.toFixed(4)}</span>
  </div>;
}

function DeliveryCard({ task, conversation, onOpen, onReview }) {
  const delivery = task.delivery || {};
  const [note, setNote] = useState(task.review?.note || '');
  const canReview = task.status === 'review_ready' || task.status === 'changes_requested';
  return <div className="delivery-card">
    <div className="task-detail-head"><div><h2>{task.title}</h2><span className={`task-status ${task.status}`}>{LABELS[task.status] || task.status}</span></div>
      <button className="btn ghost" onClick={onOpen}>打开对话</button></div>
    <p className="muted small">{conversation?.cwd || '~'} · 变更 {delivery.diffs?.length || 0} · 产物 {delivery.artifacts?.length || 0} · 危险操作 {delivery.dangerousCommands?.length || 0}</p>
    {delivery.diffs?.length > 0 && <details open><summary>变更证据</summary><pre className="task-diff">{delivery.diffs.join('\n\n')}</pre></details>}
    {delivery.auditEvents?.length > 0 && <details open><summary>安全审计</summary><div className="task-audit-events">{delivery.auditEvents.map((event, index) =>
      <p key={`${event.ts || index}_${index}`} className={`risk-event ${event.level || 'workspace_write'}`}><b>{RISK_LABELS[event.level] || event.level}</b> · {event.detail}</p>)}</div></details>}
    {delivery.dangerousCommands?.length > 0 && <details open><summary>⚠️ 危险操作</summary><pre>{delivery.dangerousCommands.join('\n')}</pre></details>}
    {(delivery.usage?.inputTokens || delivery.usage?.outputTokens) ? <p>用量：输入 {delivery.usage.inputTokens || 0} / 输出 {delivery.usage.outputTokens || 0} tokens</p> : null}
    {canReview && <div className="task-review"><textarea value={note} placeholder="验收备注（可选）" onChange={(e) => setNote(e.target.value)} />
      <button className="btn primary" onClick={() => onReview(task.id, 'accept', note)}>Accept</button>
      <button className="btn danger" onClick={() => onReview(task.id, 'changes', note)}>Request changes</button></div>}
  </div>;
}
