/**
 * 目标模式(Goal Mode)—— 对标 codex 的 /goal。
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

/**
 * 模型宣称「整体目标达成」的说法。
 *
 * 刻意只收显式的整体宣告。曾经把「测试通过」「已完成」也算作达成,
 * 结果模型说一句「已完成第一层强制访问控制」「测试全部通过」就被判达成,
 * 目标 0 轮就结束了 —— 那些是某一步完成,不是目标完成。
 */
const DONE_PATTERNS = [
  /目标(已)?(达成|完成|实现)/,
  /(全部|所有)(工作|任务|需求|内容|事项)?(都)?(已)?(完成|做完)/,
  /任务(已)?(全部)?完成/,
  /没有(其它|其他|剩余)(的)?(问题|待办|工作)/,
  /goal (achieved|completed|is complete)/i,
  /task (is )?complete/i,
  /everything (is )?done/i
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
    /* 达成要过一道核验关。模型宣称完成的成本极低,直接采信就会出现
     * 「0 轮就达成」这种明显没做完的情况。先让它逐条对照目标给证据,
     * 再说一次达成才算数。 */
    if (!goal.verifying) {
      return {
        action: 'verify',
        prompt: buildVerifyPrompt(goal),
        message: '🎯 模型宣称目标已达成,先让它逐条核对验收项并给出证据,通过后才算完成。'
      };
    }
    return { action: 'complete', message: buildCompleteMessage(goal) };
  }
  if (progress === 'blocked') {
    return { action: 'stop', reason: 'blocked', message: '🎯 模型表示需要你提供信息或授权,目标模式已暂停等待你处理。' };
  }
  // 又说没完成了 -> 撤销核验态,回到正常推进
  return { action: 'continue', prompt: buildContinuePrompt(goal), clearVerifying: !!goal.verifying };
}

/**
 * 核验提示词:要证据,不要复述。
 * 关键是逼它把目标拆成可勾验收项,并对每一项给出可复现的凭据 ——
 * 光问「真的完成了吗」,模型基本都会说「是的」。
 */
export function buildVerifyPrompt(goal) {
  return [
    `【目标模式 · 达成核验】你刚才表示目标已达成。目标是:${goal?.text || ''}`,
    '',
    '现在做一次严格自检,不要复述之前说过的话:',
    '1. 把目标拆成具体验收项,逐条列出',
    '2. 每条给出**可复现的证据**:实际执行的命令与其真实输出、文件路径、接口返回、截图',
    '   —— 「已实现」「应该没问题」不算证据',
    '3. 任何一条拿不出证据,就说明没做完:直接继续做,不要写在"后续计划"里',
    '4. 逐条都有证据后,明确回复「目标已达成」并附上上述清单',
    '5. 若发现遗漏,如实说明还差什么并继续推进'
  ].join('\n');
}

/**
 * 达成时的收尾消息。
 * 必须带上目标原文 —— 达成后目标条会被清掉,不写进消息的话,
 * 万一判断有误,用户连原来设的是什么都找不回来了。
 */
export function buildCompleteMessage(goal) {
  const rounds = goal?.rounds || 0;
  return [
    `🎯 目标已达成,目标模式结束(共推进 ${rounds} 轮):${goal?.text || ''}`,
    '若判断有误,复制上面这句目标用 /goal 重新设定即可。'
  ].join('\n');
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
  return {
    text: String(text || '').trim(), status: 'active',
    rounds: 0, maxRounds, verifying: false, createdAt: Date.now()
  };
}
