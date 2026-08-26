/**
 * 团队模式(Team Mode)—— 两个引擎「干活 + 审查」协作推进同一个目标。
 *
 * 为什么是干活+审查,而不是轮流接力:两个引擎交替改同一堆文件,极容易
 * 互相覆盖、反复推翻。职责分开之后,执行方只管做,审查方只管挑毛病,
 * 谁也不会去改对方刚写的东西 —— 也才谈得上「是否真的完成了」有第二双眼睛。
 *
 * 与目标模式的关系:团队模式是目标模式的一种推进策略,不是另一套状态机。
 * 轮次预算、暂停/继续、达成核验全部沿用目标模式,这里只决定「下一轮该谁上、
 * 说什么」。两套独立的状态机在边界情况一定会打架。
 *
 * 交接走结构化摘要而不是整段历史:全量历史每轮翻倍且迅速膨胀,
 * 而审查方真正需要的只有「改了哪些文件、验证了什么、还差什么」。
 *
 * 纯函数,便于单测。
 */

/** 可选的搭配。执行方放前面,审查方放后面 */
export const TEAM_PRESETS = [
  { id: 'claude-codex', worker: 'claude', reviewer: 'codex', label: 'Claude 干活 · Codex 审查' },
  { id: 'codex-claude', worker: 'codex', reviewer: 'claude', label: 'Codex 干活 · Claude 审查' },
  { id: 'claude-deepseek', worker: 'claude', reviewer: 'deepseek', label: 'Claude 干活 · DeepSeek 审查' },
  { id: 'codex-deepseek', worker: 'codex', reviewer: 'deepseek', label: 'Codex 干活 · DeepSeek 审查' }
];

/** 审查方连续打回多少次还没通过,就停下来让人看一眼 */
export const MAX_CONSECUTIVE_REJECTS = 3;

export function createTeam({ worker, reviewer, workerModel = '', reviewerModel = '' } = {}) {
  if (!worker || !reviewer) throw new Error('团队模式需要同时指定执行方与审查方');
  if (worker === reviewer) throw new Error('执行方与审查方不能是同一个引擎,那样审查毫无意义');
  return {
    worker, reviewer, workerModel, reviewerModel,
    phase: 'work',      // 'work' 执行中 | 'review' 审查中
    reviews: 0,         // 累计审查轮数
    rejects: 0,         // 连续打回次数(通过后清零)
    createdAt: Date.now()
  };
}

/* ------------------------------------------------------------ 交接单 */

/** 一眼能看出「动过文件」的工具名 */
const WRITE_TOOLS = /edit|write|create|apply|patch|update|删除|修改|写入/i;

/**
 * 从本轮消息里抽出结构化交接单。
 *
 * 刻意不额外调一次模型来做摘要 —— 那等于每轮多烧一次钱,
 * 而这些信息本来就在消息流里,直接抽即可。
 *
 * @param messages 本轮(上一条用户消息之后)产生的消息,时间正序
 */
export function buildHandoff(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const files = new Set();
  const commands = [];
  let conclusion = '';

  for (const m of list) {
    if (!m) continue;
    if (m.role === 'agent' && (m.kind === 'text' || m.kind === 'result') && m.text) {
      conclusion = m.text;   // 留最后一段作为结论
    }
    if (m.kind === 'tool' && m.name) {
      const detail = String(m.detail || '').trim();
      if (WRITE_TOOLS.test(m.name)) {
        // detail 常形如 "add /root/code/x.py" 或直接是路径
        const hit = detail.match(/(\/[^\s'"]+|[A-Za-z]:\\[^\s'"]+)/);
        if (hit) files.add(hit[1]);
      } else if (detail) {
        commands.push(detail.slice(0, 160));
      }
    }
    if (m.kind === 'diff' && m.text) {
      for (const line of String(m.text).split('\n')) {
        const hit = line.match(/^\+\+\+ [ab]?\/?(\S+)/);
        if (hit) files.add(hit[1]);
      }
    }
  }

  return {
    conclusion: conclusion.trim().slice(-1200),
    files: [...files].slice(0, 30),
    commands: commands.slice(-8)
  };
}

/** 交接单渲染成文本;空字段直接省略,不要给对方一堆「无」 */
export function renderHandoff(handoff = {}) {
  const parts = [];
  if (handoff.conclusion) parts.push(`【执行方的结论】\n${handoff.conclusion}`);
  if (handoff.files?.length) parts.push(`【本轮改动的文件】\n${handoff.files.map((f) => `- ${f}`).join('\n')}`);
  if (handoff.commands?.length) parts.push(`【执行过的命令(节选)】\n${handoff.commands.map((c) => `- ${c}`).join('\n')}`);
  return parts.join('\n\n') || '(执行方本轮没有产生可交接的内容)';
}

/* ------------------------------------------------------------ 提示词 */

/**
 * 审查提示词。
 *
 * 三件事必须写死:不许自己动手改、必须给出明确判定词、判定要有依据。
 * 不写「不许改」的话审查方会直接上手修,两边就又开始抢同一堆文件了;
 * 不要求判定词就没法可靠地解析结论,只能猜。
 */
export function buildReviewPrompt(goalText, handoff, { round = 1 } = {}) {
  return [
    `【团队模式 · 第 ${round} 次审查】你现在的角色是**审查方**,不是执行方。`,
    `整体目标:${goalText || '(未设定)'}`,
    '',
    renderHandoff(handoff),
    '',
    '请做一次严格审查:',
    '1. **不要自己动手修改任何文件** —— 你的职责是找问题,改由执行方来做',
    '2. 实际去读改动过的文件、跑测试或命令来验证,不要只看执行方的自述',
    '3. 重点查:是否真的实现了目标、有没有偷工减料(如空实现、写死返回值、'
      + '把失败的用例注释掉)、有没有引入回归、边界与错误路径是否处理',
    '4. 最后必须以下面两句之一单独成行作结:',
    '   - 「审查通过」—— 并简述你实际验证了什么',
    '   - 「审查不通过」—— 并按严重程度列出具体问题,每条指明文件与位置',
    '5. 拿不准就算不通过,宁可多推一轮'
  ].join('\n');
}

/**
 * 返工提示词:把审查意见原样带给执行方。
 * 不做二次概括 —— 概括会把「第 37 行没判空」磨成「注意健壮性」,
 * 执行方拿到后根本不知道改哪。
 */
export function buildReworkPrompt(goalText, reviewText, { round = 1 } = {}) {
  return [
    `【团队模式 · 第 ${round} 次返工】你现在的角色是**执行方**。`,
    `整体目标:${goalText || '(未设定)'}`,
    '',
    '审查方提出了以下问题:',
    '————',
    String(reviewText || '').trim().slice(-3000),
    '————',
    '',
    '请逐条处理:',
    '1. 每条要么改掉,要么说明为什么不该改(要有依据,不能只说"没问题")',
    '2. 改完实际运行验证,不要把"代码看起来对"当作验证',
    '3. 不要开新话题,先把上面的问题清完',
    '4. 处理完简述你改了什么、验证结果如何'
  ].join('\n');
}

/* ------------------------------------------------------------ 判定 */

const PASS_PATTERNS = [/审查通过/, /review\s*(passed|approved)/i];
const REJECT_PATTERNS = [/审查不通过/, /审查未通过/, /review\s*(failed|rejected)/i];

/**
 * 解析审查结论。
 *
 * 先判不通过:「审查不通过」里含有「审查通过」这个子串,
 * 顺序反了会把每一次打回都读成通过 —— 那审查就完全失效了。
 */
export function classifyReview(text = '') {
  const t = String(text || '');
  if (!t.trim()) return 'unclear';
  if (REJECT_PATTERNS.some((re) => re.test(t))) return 'reject';
  if (PASS_PATTERNS.some((re) => re.test(t))) return 'pass';
  return 'unclear';
}

/**
 * 决定团队模式的下一步。
 *
 * 只在目标模式判定「还要继续」时才会被调用 —— 危险命令、触顶、原地打转
 * 这些熔断仍由目标模式负责,这里不重复实现。
 *
 * @param team 团队状态
 * @param ctx {goalText, lastText, turnMessages}
 * @returns {action:'review'|'rework'|'passed', agent, model, prompt, message, patch}
 */
export function decideTeamStep(team, ctx = {}) {
  if (!team || !team.worker || !team.reviewer) return { action: 'idle' };
  const goalText = ctx.goalText || '';

  // 执行方刚跑完 -> 交给审查方
  if (team.phase === 'work') {
    const handoff = buildHandoff(ctx.turnMessages || []);
    const round = (team.reviews || 0) + 1;
    return {
      action: 'review',
      agent: team.reviewer,
      model: team.reviewerModel || '',
      prompt: buildReviewPrompt(goalText, handoff, { round }),
      message: `👥 交给 ${engineLabel(team.reviewer)} 审查(第 ${round} 次)`,
      patch: { phase: 'review', reviews: round }
    };
  }

  // 审查方刚跑完 -> 看结论
  const verdict = classifyReview(ctx.lastText);
  if (verdict === 'pass') {
    return {
      action: 'passed',
      message: `👥 ${engineLabel(team.reviewer)} 审查通过,交回目标模式做达成核验。`,
      patch: { phase: 'work', rejects: 0 }
    };
  }

  const rejects = (team.rejects || 0) + 1;
  if (rejects >= MAX_CONSECUTIVE_REJECTS) {
    return {
      action: 'stop',
      reason: 'rejects',
      message: `👥 审查方连续 ${rejects} 次打回仍未通过,已暂停 —— `
        + '再自动推下去多半是两边理解不一致,建议你看一眼审查意见再决定。',
      patch: { phase: 'work', rejects }
    };
  }

  /* 审查方没给出明确判定,按不通过处理并要求它下次给判定词。
   * 当作通过是最危险的默认值:审查形同虚设,而用户以为有人把过关。 */
  const note = verdict === 'unclear'
    ? '(审查方未给出明确判定,按未通过处理)'
    : '';
  return {
    action: 'rework',
    agent: team.worker,
    model: team.workerModel || '',
    prompt: buildReworkPrompt(goalText, ctx.lastText, { round: rejects }),
    message: `👥 审查未通过,退回 ${engineLabel(team.worker)} 返工(第 ${rejects} 次)${note}`,
    patch: { phase: 'work', rejects }
  };
}

const LABELS = { codex: 'Codex', claude: 'Claude Code', deepseek: 'DeepSeek', dsh: 'DeepSeek Harness' };
export function engineLabel(agent) { return LABELS[agent] || agent; }
