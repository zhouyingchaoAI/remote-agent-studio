import React, { useMemo, useState } from 'react';
import { useStore } from '../store.js';

const LABELS = {
  draft: '草稿', queued: '排队中', running: '执行中', needs_input: '等待输入',
  needs_approval: '等待审批', review_ready: '待验收', accepted: '已验收',
  changes_requested: '需修改', failed: '失败', archived: '已归档'
};

export default function TaskPanel({ hostId }) {
  const tasks = useStore((s) => s.tasks);
  const conversations = useStore((s) => s.conversations);
  const setActiveConv = useStore((s) => s.setActiveConv);
  const reviewTask = useStore((s) => s.reviewTask);
  const [selected, setSelected] = useState(null);
  const list = useMemo(() => Object.values(tasks).filter((task) => task.hostId === hostId)
    .sort((a, b) => b.updatedAt - a.updatedAt), [tasks, hostId]);
  const task = selected ? tasks[selected] : list[0];

  return <div className="task-panel">
    <aside className="task-list"><h2>任务</h2>
      {list.length === 0 ? <p className="muted">从对话页创建任务后，在这里验收交付。</p> : list.map((item) =>
        <button key={item.id} className={`task-row ${task?.id === item.id ? 'active' : ''}`} onClick={() => setSelected(item.id)}>
          <b>{item.title}</b><span className={`task-status ${item.status}`}>{LABELS[item.status] || item.status}</span>
        </button>)}
    </aside>
    <section className="task-detail">{task ? <DeliveryCard task={task} conversation={conversations[task.convId]}
      onOpen={() => setActiveConv(hostId, task.convId)} onReview={reviewTask} /> : <div className="empty-state"><p>尚无任务</p></div>}</section>
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
    {delivery.dangerousCommands?.length > 0 && <details open><summary>⚠️ 危险操作</summary><pre>{delivery.dangerousCommands.join('\n')}</pre></details>}
    {(delivery.usage?.inputTokens || delivery.usage?.outputTokens) ? <p>用量：输入 {delivery.usage.inputTokens || 0} / 输出 {delivery.usage.outputTokens || 0} tokens</p> : null}
    {canReview && <div className="task-review"><textarea value={note} placeholder="验收备注（可选）" onChange={(e) => setNote(e.target.value)} />
      <button className="btn primary" onClick={() => onReview(task.id, 'accept', note)}>Accept</button>
      <button className="btn danger" onClick={() => onReview(task.id, 'changes', note)}>Request changes</button></div>}
  </div>;
}
