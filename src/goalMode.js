/**
 * 目标模式(Goal Mode)。
 *
 * 痛点:agent 每轮结束就停,哪怕问题没解决(常见于"我会继续排查"之后就没有然后了)。
 * 目标模式让它跨轮自动推进,直到达成、卡住或触达预算。
 *
 * ── 这一版对齐了 codex /goal 的核心取舍,差别集中在三点 ──
 *
 * 1. **达成靠证据,不靠模型的话。**
 *    原来只能正则匹配模型说的"目标已达成"—— 而模型宣称完成的成本是零,
 *    它随口一句就结束了。现在目标可以带一条**验收命令**
 *    (`npm test`、`curl -fsS localhost:8000/v1/models`、`test -f xxx`),
 *    退出码 0 才算达成。这是这次改动里唯一真正改变结果的一条。
 *    验收失败时,**命令的真实输出会成为下一轮的输入** —— 比任何续推话术都有用。
 *
 * 2. **预算按 token,不按轮次。**
 *    一轮可能烧 2k token 也可能烧 200k,轮次是个很差的代理指标。
 *    轮次上限保留为兜底(防死循环),但真正的闸门是 token。
 *
 * 3. **快到预算时换一种提示词。**
 *    codex 用两份提示(continuation / budget_limit):快没预算时不该再开新工作,
 *    而该收敛、把剩余项交代清楚。一直用同一句"继续推进"会在预算耗尽的瞬间
 *    留下一个半拉子状态。
 *
 * 纯函数,便于单测 —— 这类"自动循环"逻辑必须能离线验证,否则出错就是烧钱。
 */

import { planPromptFragment, planSummary, planStalled } from './planProgress.js';

export const GOAL_DEFAULT_MAX_ROUNDS = 25;
/**
 * 计划没推进多久算停滞。
 *
 * 比"输出雷同"那条判据宽得多是故意的:一个步骤本来就可能做很久
 * (编译、跑测试、拉模型)。这条要抓的是**做了很多轮但一步没往前走**,
 * 不是"这一步慢"。
 */
export const GOAL_PLAN_STALL_MS = 20 * 60 * 1000;
/**
 * 计划还没勾完时,最多驳回几次"已达成"。
 *
 * 不能无限驳回:模型可能确实做完了,只是忘了勾最后一个框。
 * 一直用陈旧的计划文件否定它,会把目标卡死在最后一步 ——
 * 那比不检查更糟。所以驳两次就放行,并在消息里说清楚这一点。
 */
export const GOAL_PLAN_PUSHBACK_MAX = 2;
/**
 * 默认 token 预算。
 *
 * 轮次挡不住烧钱:一轮 200k token 的深度推理和一轮 2k 的确认,
 * 在轮次上是一样的。所以真正的闸门放在 token 上,轮次退居兜底(防死循环)。
 */
export const GOAL_DEFAULT_TOKEN_BUDGET = 2_000_000;
/** 剩余预算低于这个比例时,提示词换成"收敛"档 */
export const GOAL_WRAPUP_RATIO = 0.15;
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
  /* token 预算先判 —— 它才是真正的闸门,轮次只是防死循环的兜底。 */
  const budget = goal.tokenBudget || GOAL_DEFAULT_TOKEN_BUDGET;
  const used = ctx.tokensUsed || 0;
  if (used >= budget) {
    return {
      action: 'stop', reason: 'budget',
      message: `🎯 已用完 token 预算(${fmtTokens(used)} / ${fmtTokens(budget)})并暂停。\n`
        + '点「继续」会再给一份同样的预算;任务本来就大的话,用 /goal budget 5m 一次调高。'
    };
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
  /* 有计划文件时多一条**硬的**停滞判据:完成数长时间不涨。
     "输出雷同"只能抓到复读机式的空转;模型每轮都在说不同的话、
     却一步也没勾掉,才是更常见也更烧钱的那种卡住。 */
  const plan = goal.plan || null;
  if (plan && planStalled(goal.planHistory, { stallMs: goal.planStallMs || GOAL_PLAN_STALL_MS, now: ctx.now })) {
    return {
      action: 'stop', reason: 'planStalled',
      message: `🎯 计划已经 ${Math.round((goal.planStallMs || GOAL_PLAN_STALL_MS) / 60000)} 分钟没往前走了`
        + `(停在 ${plan.text || ''}),已暂停。\n`
        + `当前这步:${plan.currentText || '(未知)'}\n`
        + '可能是卡在这一步上,也可能是它忘了更新计划文件 —— 建议自己看一眼再点「继续」。'
    };
  }
  const progress = classifyGoalProgress(ctx.lastText);
  if (progress === 'done') {
    /* **计划还没勾完,却说达成了。**
     *
     * 这是有计划文件之后最值钱的一条检查:模型宣称完成的成本是零,
     * 而一份写着 3/18 的清单直接反驳了它。把没勾的那几条原样甩回去,
     * 比任何"请确认是否真的完成"都具体。
     *
     * 但**不能无限驳回** —— 它可能真做完了,只是忘了勾最后一个框。
     * 拿一份陈旧的清单一直否定它,会把目标永远卡在最后一步。
     */
    if (plan && plan.total > 0 && plan.done < plan.total
        && (goal.planPushback || 0) < GOAL_PLAN_PUSHBACK_MAX) {
      return {
        action: 'continue',
        prompt: buildPlanIncompletePrompt(goal, plan),
        planPushback: (goal.planPushback || 0) + 1,
        clearVerifying: true,
        message: `🎯 模型说达成了,但计划文件还停在 ${plan.text}(${plan.total - plan.done} 项没勾),已要求它核对。`
      };
    }
    /* 达成判据分两档,能用硬的就绝不用软的。
     *
     * **有验收命令 → 跑它,退出码说了算。** 模型宣称完成的成本是零,
     * 而一条 `npm test` 或 `curl -fsS .../v1/models` 是不会撒谎的。
     * 这是这一版和原来最大的差别。
     *
     * 没有验收命令时,退回原来的"让它自己拿证据"—— 聊胜于无,
     * 但界面上会标明这是**弱判定**,免得让人以为验过了。
     */
    if (goal.verifyCommand) {
      /* ctx.checkResult 由外面把命令跑完再塞回来 —— 这个模块是纯函数,
         不碰 IO。没跑就先要求跑。 */
      if (!ctx.checkResult) {
        return {
          action: 'check', command: goal.verifyCommand,
          message: `🎯 模型宣称达成,先跑一遍验收命令:\n${goal.verifyCommand}`
        };
      }
      if (ctx.checkResult.code === 0) {
        return { action: 'complete', message: buildCompleteMessage(goal, ctx.checkResult) };
      }
      /* **验收失败时,把命令的真实输出喂回去。**
         这比任何"请继续推进"的话术都有用:它是具体的、可操作的,
         而且直接反驳了模型刚才那句"已达成"。 */
      return {
        action: 'continue',
        prompt: buildCheckFailedPrompt(goal, ctx.checkResult),
        clearVerifying: true,
        message: `🎯 验收未通过(退出码 ${ctx.checkResult.code}),已把输出反馈给模型继续修。`
      };
    }
    if (!goal.verifying) {
      return {
        action: 'verify',
        prompt: buildVerifyPrompt(goal),
        message: '🎯 模型宣称目标已达成,先让它逐条核对验收项并给出证据,通过后才算完成。'
          + '\n(这条目标没设验收命令,只能靠模型自证 —— 用 /goal check <命令> 可以换成硬判据。)'
      };
    }
    return { action: 'complete', message: buildCompleteMessage(goal) };
  }
  if (progress === 'blocked') {
    return { action: 'stop', reason: 'blocked', message: '🎯 模型表示需要你提供信息或授权,目标模式已暂停等待你处理。' };
  }
  // 又说没完成了 -> 撤销核验态,回到正常推进
  return {
    action: 'continue',
    prompt: buildContinuePrompt(goal, { tokensUsed: used, plan }),
    clearVerifying: !!goal.verifying
  };
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
export function buildCompleteMessage(goal, checkResult = null) {
  const rounds = goal?.rounds || 0;
  const lines = [`🎯 目标已达成,目标模式结束(共推进 ${rounds} 轮):${goal?.text || ''}`];
  /* 说清是怎么判定达成的。"验收命令通过"和"模型自己说完成了"
     是两种可信度完全不同的结论,不该长得一样。 */
  if (checkResult) {
    lines.push(`验收命令通过(退出码 0):${goal?.verifyCommand || ''}`);
  } else {
    lines.push('⚠ 这条目标没有验收命令,达成是模型自述的 —— 建议自己确认一下。');
  }
  /* 驳回过还是放行的情况必须说出来:计划文件和"已达成"是矛盾的,
     我们只是选择不再拦。把这个矛盾藏起来,等于替模型背书。 */
  const plan = goal?.plan;
  if (plan && plan.total > 0 && plan.done < plan.total) {
    lines.push(`⚠ 计划文件仍停在 ${plan.text}(${plan.total - plan.done} 项没勾)。`
      + `已核对 ${GOAL_PLAN_PUSHBACK_MAX} 次仍宣称达成,故放行 —— 可能是它忘了更新文件,也可能真没做完。`);
  }
  lines.push('若判断有误,复制上面这句目标用 /goal 重新设定即可。');
  return lines.join('\n');
}

/**
 * 续推提示词。
 *
 * **分两档**,这是从 codex 那里学来的一条:它用 continuation 和 budget_limit
 * 两份提示。快没预算时还在说"继续推进",结果就是预算耗尽的那一刻
 * 留下一个半拉子状态 —— 该收敛的时候必须明确要求收敛。
 */
export function buildContinuePrompt(goal, { tokensUsed = 0, plan = null } = {}) {
  const round = (goal.rounds || 0) + 1;
  const budget = goal.tokenBudget || GOAL_DEFAULT_TOKEN_BUDGET;
  const left = budget - tokensUsed;
  /* 把"你在第几步"写进提示词。
     光说"第 12 轮"对模型和对人一样没信息量;
     "第 3 / 18 步,当前这步是 X"能让它接着干,而不是重新规划一遍。 */
  const where = plan && plan.total
    ? `\n当前进度:${plan.text} · 这一步是「${plan.currentText || '?'}」`
    : '';
  const planTail = planPromptFragment(goal.planPath);

  if (left > 0 && left < budget * GOAL_WRAPUP_RATIO) {
    return [
      `【目标模式 · 收尾】预算快用完了(剩余约 ${fmtTokens(left)}),目标:${goal.text}${where}`,
      '',
      '现在**不要再开新的工作**,把这一轮用来收敛:',
      '1. 优先完成"再花一点点力气就能完成"的那部分',
      '2. 把当前真实状态写清楚:哪些已经可用、哪些没做、卡在哪',
      '3. 剩余项写成一份可以直接接着做的清单(具体到命令和文件)',
      '4. 不要为了显得完成而含糊其辞 —— 没做完就说没做完',
      planTail
    ].join('\n').trimEnd();
  }

  return [
    `【目标模式 · 第 ${round} 轮】当前目标尚未达成:${goal.text}${where}`,
    '',
    '请继续推进,不要停下来等我确认:',
    '1. 先用一句话说明目前的阻塞点或下一步依据',
    '2. 直接执行下一步(需要决策时自行选择最合理的方案)',
    '3. 每次改动后进行实际验证(运行、请求、截图等),不要把"接口返回正常"当作问题已解决',
    '4. 若目标已真正达成,请明确回复"目标已达成"并给出验证证据',
    '5. 若确实需要我提供信息或授权才能继续,请明确说明缺什么',
    planTail
  ].join('\n').trimEnd();
}

/**
 * 计划没勾完却说达成时的提示词。
 *
 * 关键是**把没勾的条目原样列出来**。只说"计划还没完成"的话,
 * 模型很可能回一句"那些其实已经做了"就把框全勾上 —— 那等于没检查。
 * 列出来它就得对着具体条目逐条表态。
 */
export function buildPlanIncompletePrompt(goal, plan) {
  const rest = (plan.steps || []).filter((s) => s.state !== 'done').slice(0, 20);
  return [
    `【目标模式 · 计划核对】你说目标已达成,但计划文件 ${goal.planPath || ''} 里还有 ${plan.total - plan.done} 项没勾。`,
    `目标:${goal.text}`,
    `进度:${plan.text}`,
    '',
    '未完成的条目:',
    ...rest.map((s) => `- ${s.text}`),
    '',
    '逐条处理,不要笼统回答:',
    '1. **确实还没做的** —— 现在就做,不要写进"后续计划"',
    '2. **已经做完但忘了勾的** —— 说明证据(命令与输出/文件路径),然后把文件里的框改成 `- [x]`',
    '3. **确认不需要做的** —— 说清理由,并在文件里把该条改成 `- [x] ~~不需要:原因~~`',
    '4. 全部处理完再回复「目标已达成」'
  ].join('\n');
}

/**
 * 验收命令失败后的提示词。
 *
 * 核心是把**命令的真实输出**原样交回去。模型刚说完"已达成",
 * 这份输出直接反驳了它 —— 比任何"请继续推进"的话术都有力,
 * 而且是具体的、可操作的。
 */
export function buildCheckFailedPrompt(goal, result = {}) {
  const out = String(result.output || '').trim().slice(-1500);
  return [
    `【目标模式 · 验收未通过】你说目标已达成,但验收命令的退出码是 ${result.code}。`,
    `目标:${goal?.text || ''}`,
    `验收命令:${goal?.verifyCommand || ''}`,
    '',
    '命令的实际输出:',
    '```',
    out || '(无输出)',
    '```',
    '',
    '请据此继续:',
    '1. 先说清这份输出说明了什么问题 —— 不要重复"已完成"',
    '2. 直接修,不要写进"后续计划"',
    '3. 修完自己先跑一遍那条验收命令,通过了再说达成'
  ].join('\n');
}

/** token 数按人读得懂的量级显示 */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
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

/** 手动设定 token 预算(/goal budget 5m) */
export function setGoalTokenBudget(goal, raw) {
  const m = String(raw || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!m) throw new Error('预算写法:/goal budget 500k 或 /goal budget 5m');
  const mult = m[2] === 'm' ? 1e6 : (m[2] === 'k' ? 1e3 : 1);
  const want = Math.round(Number(m[1]) * mult);
  if (want < 1000) throw new Error('预算太小了,至少 1k');
  return { tokenBudget: want, status: 'active' };
}

/** 新建目标对象 */
export function createGoal(text, {
  maxRounds = GOAL_DEFAULT_MAX_ROUNDS,
  tokenBudget = GOAL_DEFAULT_TOKEN_BUDGET,
  verifyCommand = '',
  planPath = ''
} = {}) {
  return {
    text: String(text || '').trim(), status: 'active',
    rounds: 0, maxRounds, tokenBudget,
    /* 验收命令:退出码 0 才算达成。留空则退回"模型自证"的弱判定,
       界面上会标出来 —— 两种可信度不该长得一样。 */
    verifyCommand: String(verifyCommand || '').trim(),
    /* 计划文件:智能体自己维护的 markdown 清单,应用每轮读一次,
       把不透明的"第 12 轮"变成「第 3 / 18 步」。 */
    planPath: String(planPath || '').trim(),
    plan: null,          // 最近一次解析结果 { total, done, current, text, steps }
    planHistory: [],     // [{ at, done, total }] —— 用来判断计划有没有在推进
    planPushback: 0,     // 已经拿计划驳回过几次"已达成"
    verifying: false, createdAt: Date.now()
  };
}

/**
 * 把新读到的计划并进目标。
 *
 * 历史只留最近若干条,并且**读失败时不写历史** —— 一次读取失败
 * (文件还没建、主机抖了一下)不该被当成"进度没涨",
 * 那会让停滞判定凭空提前触发。
 */
export const PLAN_HISTORY_MAX = 60;
export function mergePlan(goal, steps, { now = Date.now() } = {}) {
  const sum = planSummary(steps);
  if (!sum.total) return { plan: null };
  const prev = (goal?.planHistory || []).slice(-PLAN_HISTORY_MAX + 1);
  return {
    plan: { ...sum, steps },
    planHistory: [...prev, { at: now, done: sum.done, total: sum.total }]
  };
}
