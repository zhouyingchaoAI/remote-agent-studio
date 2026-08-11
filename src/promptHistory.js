/**
 * 输入历史(↑/↓ 回溯)的纯逻辑,独立出来便于单测。
 * 约定:history[0] 为最近一条,索引越大越早;index === null 表示正在编辑草稿。
 */

/** 从消息列表提取用户输入历史(最近在前,连续重复合并) */
export function buildPromptHistory(messages = []) {
  const list = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const text = (m.text || '').trim();
    if (!text || text === list[list.length - 1]) continue;
    list.push(text);
  }
  return list;
}

/**
 * 计算一次 ↑/↓ 后的状态。
 * @param state {index:number|null, draft:string}
 * @param history 由 buildPromptHistory 得到的数组
 * @param step +1 更早(↑),-1 更新(↓)
 * @param currentInput 当前输入框内容
 * @returns {handled:boolean, index, draft, value} —— handled=false 表示不接管该按键
 */
export function stepPromptHistory(state, history, step, currentInput) {
  const { index, draft } = state;
  if (!history.length) return { handled: false, index, draft, value: currentInput };

  if (index === null) {
    // 草稿态按 ↓ 不接管(让光标正常移动)
    if (step < 0) return { handled: false, index, draft, value: currentInput };
    return { handled: true, index: 0, draft: currentInput, value: history[0] };
  }

  const next = index + step;
  if (next < 0) return { handled: true, index: null, draft: '', value: draft }; // 回到草稿
  if (next >= history.length) return { handled: true, index, draft, value: history[index] }; // 已最早
  return { handled: true, index: next, draft, value: history[next] };
}
