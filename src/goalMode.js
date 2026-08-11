/**
 * 目标模式(Goal Mode)—— 对标 codex/grok 的 /goal。
 *
 * 痛点:agent 每轮结束就停,哪怕问题没解决(常见于"我会继续排查"之后就没有然后了)。
 * 目标模式让它跨轮自动推进:每轮结束后判断目标是否达成,没达成就自动追一句继续,
 * 直到达成、卡住或触达上限。
 *
 * 纯函数,便于单测 —— 这类"自动循环"逻辑必须能离线验证,否则出错就是烧钱。
 */

export const GOAL_DEFAULT_MAX_ROUNDS = 25;
/** 每次点「继续」追加的轮次预算 */
export const GOAL_EXTEND_ROUNDS = 25;
/** 上限的上限:再怎么加也不能无限烧 */
export const GOAL_MAX_ROUNDS_CAP = 500;

/** 模型宣称完成的说法 */
const DONE_PATTERNS = [
  /目标(已)?(达成|完成)/, /问题(已)?(解决|修复)/, /已(全部)?(完成|解决|修复|通过)/,
  /验收(通过|完成)/, /测试(全部)?通过/, /没有(其它|其他)(问题|待办)/,
  /goal (achieved|completed)/i, /all (tests? )?(pass|passed|passing)/i, /task complete/i
];
/** 明确表示"还没完"的说法 —— 优先级高于完成判定,避免"已修复但仍未通过"被误判 */
const NOT_DONE_PATTERNS = [
  /仍(然)?(未|没)/, /还(未|没)(有)?(完成|解决|通过)/, /尚未(通过|完成|解决)/,
  /继续(排查|修复|优化|推进)/, /下一步/, /待(办|验证|确认)/, /未通过/, /失败/,
  /still (failing|not)/i, /next step/i
];
/** 需要人介入的信号:再自动追下去也没用 */
const BLOCKED_PATTERNS = [
  /需要(你|您|人工)\s*(提供|确认|授权|介入)/, /请(你|您)\s*(提供|补充|确认)/,
  /(缺少|缺失|没有)\s*(权限|密码|密钥|凭据|账号|token|api\s*key)/i,
  /无法(访问|连接).*(需要|请)/,
  /need (your|human) (input|approval)/i
];

const testAny = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * 判断一轮结束后目标处于什么状态。
 * @param lastText 本轮 agent 的最后一段文本
 * @returns 'done' | 'blocked' | 'continue'
 */
export function classifyGoalProgress(lastText = '') {
  const text = String(lastText || '').trim();
  if (!text) return 'continue';
  // 只看结尾一段:开头常在复述历史,结论一般在最后
  const tail = text.slice(-500);
  if (testAny(BLOCKED_PATTERNS, tail)) return 'blocked';
  if (testAny(NOT_DONE_PATTERNS, tail)) return 'continue';
  if (testAny(DONE_PATTERNS, tail)) return 'done';
  return 'continue';
}

/** 连续多轮输出高度相似 -> 判定原地打转,停下来免得烧钱 */
export function isStalled(recentTexts = [], threshold = 3) {
  const texts = recentTexts.filter((t) => String(t || '').trim()).slice(-threshold);
  if (texts.length < threshold) return false;
  const norm = (t) => String(t).replace(/\s+/g, '').slice(-200);
  const first = norm(texts[0]);
  return texts.every((t) => norm(t) === first);
}

/**
 * 决定是否继续推进,以及给出停止原因。
 * @param goal {text, status, rounds, maxRounds}
 * @param ctx  {lastText, recentTexts, dangerHit}
 */
export function decideGoalStep(goal, ctx = {}) {
  if (!goal || !goal.text || goal.status !== 'active') {
    return { action: 'idle' };
  }
  const maxRounds = goal.maxRounds || GOAL_DEFAULT_MAX_ROUNDS;
  if (ctx.dangerHit) {
    return { action: 'stop', reason: 'danger', message: `🛑 目标模式已暂停:本轮出现危险命令「${String(ctx.dangerHit).slice(0, 80)}」,请人工确认后再继续。` };
  }
  if ((goal.rounds || 0) >= maxRounds) {
    return {
      action: 'stop', reason: 'maxRounds',
      message: `🎯 已达轮次上限(${maxRounds} 轮)并暂停,避免无限循环烧钱。\n`
        + `点「继续」会再给 ${GOAL_EXTEND_ROUNDS} 轮;`
        + `任务本来就大的话,用 /goal max 100 一次把预算调高。`
    };
  }
  if (isStalled(ctx.recentTexts)) {
    return { action: 'stop', reason: 'stalled', message: '🎯 目标模式检测到连续多轮输出雷同,疑似原地打转,已暂停。请人工看一眼再决定。' };
  }
  const progress = classifyGoalProgress(ctx.lastText);
  if (progress === 'done') {
    return { action: 'complete', message: '🎯 目标看起来已达成,目标模式自动结束。若判断有误,可重新设定目标。' };
  }
  if (progress === 'blocked') {
    return { action: 'stop', reason: 'blocked', message: '🎯 模型表示需要你提供信息或授权,目标模式已暂停等待你处理。' };
  }
  return { action: 'continue', prompt: buildContinuePrompt(goal) };
}

/** 续推提示词:强调不要停、不要反问,并要求自检 */
export function buildContinuePrompt(goal) {
  const round = (goal.rounds || 0) + 1;
  return [
    `【目标模式 · 第 ${round} 轮】当前目标尚未达成:${goal.text}`,
    '',
    '请继续推进,不要停下来等我确认:',
    '1. 先用一句话说明目前的阻塞点或下一步依据',
    '2. 直接执行下一步(需要决策时自行选择最合理的方案)',
    '3. 每次改动后进行实际验证(运行、请求、截图等),不要把"接口返回正常"当作问题已解决',
    '4. 若目标已真正达成,请明确回复"目标已达成"并给出验证证据',
    '5. 若确实需要我提供信息或授权才能继续,请明确说明缺什么'
  ].join('\n');
}

/**
 * 恢复推进时要打的补丁。
 *
 * 只把 status 改回 active 是不够的 —— 因触顶而暂停时 rounds 已经等于 maxRounds,
 * 下一轮结束会立刻再次触顶暂停,表现为「点一次继续只多跑一轮」。
 * 所以触顶恢复必须同时把预算往上抬。
 */
export function resumeGoalPatch(goal, { extra = GOAL_EXTEND_ROUNDS } = {}) {
  const rounds = goal?.rounds || 0;
  const maxRounds = goal?.maxRounds || GOAL_DEFAULT_MAX_ROUNDS;
  if (rounds < maxRounds) return { status: 'active' }; // 不是触顶停的,预算还有,不用动
  return { status: 'active', maxRounds: Math.min(rounds + extra, GOAL_MAX_ROUNDS_CAP) };
}

/** 手动设定轮次预算(/goal max N) */
export function setGoalMaxRounds(goal, n) {
  const want = parseInt(n, 10);
  if (!Number.isFinite(want) || want < 1) throw new Error('轮次上限要是正整数');
  const capped = Math.min(want, GOAL_MAX_ROUNDS_CAP);
  // 已经跑过的轮次不能比上限还大,否则设完立刻又触顶
  return { maxRounds: Math.max(capped, (goal?.rounds || 0) + 1), status: 'active' };
}

/** 新建目标对象 */
export function createGoal(text, { maxRounds = GOAL_DEFAULT_MAX_ROUNDS } = {}) {
  return { text: String(text || '').trim(), status: 'active', rounds: 0, maxRounds, createdAt: Date.now() };
}
