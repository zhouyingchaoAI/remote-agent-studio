/**
 * 一轮结束后的编排:全自动与目标模式如何协作。
 *
 * 这两个机制解决的是不同问题:
 *   - 全自动:模型「反问要不要继续」时替你点头
 *   - 目标模式:模型「自己收尾了但目标没达成」时踢它继续
 * 它们必须互补。曾经的写法是全自动分支无条件 return,
 * 导致只要开了全自动,目标模式就永远不执行 —— 表现为目标停住不动、轮次不涨。
 */

/**
 * 全自动这一轮的处置结果。
 * @returns 'paused' 需人工介入 | 'sent' 已自动应答 | 'idle' 没它的事,交给目标模式
 */
export function autoConfirmOutcome({ enabled, dangerHit, awaitingConfirm, verdictOk } = {}) {
  if (!enabled) return 'idle';
  if (dangerHit) return 'paused';       // 危险命令一律停,不自动点头
  if (!awaitingConfirm) return 'idle';  // 模型没在等确认 -> 该目标模式接手了
  return verdictOk ? 'sent' : 'paused';
}

/** 全自动暂停时给用户看的话 */
export function autoPauseMessage({ dangerHit, verdictReason, maxReplies }) {
  if (dangerHit) {
    return `🛑 全自动已暂停:本轮包含危险命令「${String(dangerHit).slice(0, 80)}」,请人工确认后再继续。`;
  }
  if (verdictReason === 'repeat') {
    return '🤖 模型重复发出同一确认请求,全自动已暂停(可能陷入循环或不可行的流程),请人工核实后再继续。';
  }
  return `🤖 全自动模式已连续自动确认 ${maxReplies} 次,已暂停,请人工查看后继续。`;
}
