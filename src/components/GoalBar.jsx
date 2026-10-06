import { useState } from 'react';
import { useStore, sendToAgent } from '../store.js';
import { buildContinuePrompt, resumeGoalPatch, GOAL_DEFAULT_MAX_ROUNDS, GOAL_EXTEND_ROUNDS } from '../goalMode.js';

/**
 * 步骤清单。
 *
 * 这份清单的**唯一来源是主机上那个文件**,不是应用自己记的账。
 * 所以要把路径显示出来 —— 人看到某一步状态不对时,可以直接去改文件,
 * 下一轮就生效。应用记账的话,人就只能干看着。
 */
function PlanList({ plan, planPath }) {
  const ICON = { done: '✓', doing: '◐', todo: '○' };
  return (
    <div className="goal-plan">
      <div className="goal-plan-head muted small">
        {planPath}
        <span> · 已完成 {plan.done} / {plan.total}</span>
      </div>
      <ol className="goal-plan-list">
        {plan.steps.map((s, i) => (
          <li key={i} className={`plan-step ${s.state}`}>
            <span className="plan-mark">{ICON[s.state] || '○'}</span>
            <span className="plan-text">{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* 目标模式状态条:显示目标与进度,可暂停/继续/清除 */
function GoalBar({ conv }) {
  const goal = conv.goal;
  /* 步骤清单默认收起。它可能有二三十条,一直摊开会把对话挤走 ——
     而人大多数时候只需要看那句「第 3 / 18 步」。 */
  const [openPlan, setOpenPlan] = useState(false);
  if (!goal?.text) return null;
  // 已达成的目标不再显示 —— 它不会推进了。
  // 新流程会在达成时直接清空,这里兜住历史对话里已存的 done 目标。
  if (goal.status === 'done') return null;
  const st = useStore.getState();
  // 核验中要单独标出来,否则用户看到「推进中」不知道它正在自查而不是在干活
  const label = goal.verifying && goal.status === 'active'
    ? '核验中'
    : ({ active: '推进中', paused: '已暂停', done: '已达成' }[goal.status] || goal.status);
  const plan = goal.plan;
  const hasSteps = plan?.steps?.length > 0;
  return (
    <div className={`goal-bar ${goal.status}`}>
      <span className="goal-tag">🎯 目标</span>
      <span className="goal-text" title={goal.text}>{goal.text}</span>
      {/* **步数排在轮次前面。**「第 3 / 18 步」有信息量,「第 12 轮」没有 ——
          后者说不出在做第几件事、还剩几件。有计划时轮次退居次要。 */}
      {plan?.total > 0 && (
        /* **来源要看得出来。** 从计划文件读到的是可核对的事实,
           从模型正文里捞的("我在第 12/67 步")只是它的一面之词 ——
           两者长得一样的话,人会把后者也当成确凿进度。 */
        <button className="goal-step" disabled={!hasSteps}
          onClick={() => hasSteps && setOpenPlan((v) => !v)}
          title={hasSteps
            ? (plan.currentText ? `当前:${plan.currentText}` : '展开步骤清单')
            : '这个步数是模型在回复里自己说的,没有对应的计划文件 —— 用 /goal replan 让它拆一份'}>
          <span className="goal-step-bar">
            <i style={{ width: `${plan.percent}%` }} />
          </span>
          {plan.text}
          <span className="muted"> {hasSteps ? (openPlan ? '▾' : '▸') : '(自述)'}</span>
        </button>
      )}
      <span className="muted small">{label} · {goal.rounds || 0}/{goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS} 轮</span>
      <span className="flex1" />
      {goal.status === 'active' && (
        <button className="btn small ghost"
          onClick={() => st.updateConversationGoal(conv.id, { status: 'paused' })}>暂停</button>
      )}
      {goal.status !== 'active' && (
        <button className="btn small"
          title="触顶暂停时会自动追加轮次预算,否则跑一轮又会立刻停下"
          onClick={() => {
            st.updateConversationGoal(conv.id, resumeGoalPatch(goal));
            sendToAgent(conv.hostId, conv.id, buildContinuePrompt(goal), [], { auto: true });
          }}>
          {(goal.rounds || 0) >= (goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS)
            ? `继续(+${GOAL_EXTEND_ROUNDS} 轮)` : '继续'}
        </button>
      )}
      <button className="btn small ghost" onClick={() => st.setConversationGoal(conv.id, null)}>清除</button>
      {openPlan && hasSteps && <PlanList plan={plan} planPath={goal.planPath} />}
    </div>
  );
}

export { PlanList, GoalBar };
