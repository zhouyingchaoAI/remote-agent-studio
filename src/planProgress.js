/**
 * 计划进度:把一份 markdown 清单解析成「第 N / M 步」。
 *
 * ── 为什么需要它 ──
 *
 * 目标模式在此之前是个**不透明的循环**:界面只能说"第 12 轮"。
 * 而"第 12 轮"不含任何信息 —— 你不知道它在做第几件事、总共几件、
 * 前面那些做完没有。人真正想看的是 codex 那种「第 3 / 18 步」加一张清单。
 *
 * 做法跟着 codex 走:**让智能体自己维护一份 markdown**(它本来就在写
 * progress.md / PLAN.md),应用每轮读一次、解析勾选状态。
 *
 * 为什么不让模型每轮汇报进度、由应用记账:那等于把状态存在对话里,
 * 一旦上下文被截断就全丢了。文件是**外部记忆**,断了也还在,
 * 而且人可以直接打开看、直接改。
 */

/** 一份计划最多认这么多步。再多说明它不是计划,是一份日志。 */
export const MAX_STEPS = 200;

/**
 * 解析 markdown 清单。
 *
 * 认三种状态,因为这三种写法智能体都在用:
 *  · `- [x] 做完的`
 *  · `- [ ] 没做的`
 *  · `- [~] 在做的` / `- [-] 在做的` / 行内带「进行中」
 *
 * 只认**清单项**,不认标题和正文 —— 否则一段说明文字会被当成十几个步骤。
 */
export function parsePlan(markdown = '') {
  const steps = [];
  for (const raw of String(markdown || '').split('\n')) {
    const m = raw.match(/^\s*[-*+]\s*\[([ xX~\-])\]\s*(.+?)\s*$/);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const text = m[2].replace(/\*\*/g, '').trim();
    if (!text) continue;
    steps.push({
      text,
      state: mark === 'x' ? 'done'
        : (mark === '~' || mark === '-') ? 'doing'
          : /进行中|in progress|doing/i.test(text) ? 'doing' : 'todo'
    });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

/**
 * 汇总成一句「第 N / M 步」。
 *
 * "当前第几步"取**第一个未完成的**,而不是已完成数 +1:
 * 清单里出现跳着做的情况时(第 3 步没做完就先做了第 5 步),
 * 后者会报一个比实际靠前的数字,看着像倒退了。
 */
export function planSummary(steps = []) {
  const total = steps.length;
  if (!total) return { total: 0, done: 0, current: 0, text: '', percent: null };
  const done = steps.filter((s) => s.state === 'done').length;
  const doingIdx = steps.findIndex((s) => s.state === 'doing');
  const todoIdx = steps.findIndex((s) => s.state !== 'done');
  const current = doingIdx >= 0 ? doingIdx + 1 : (todoIdx >= 0 ? todoIdx + 1 : total);
  return {
    total,
    done,
    current,
    /* 百分比按**已完成**算,不按"当前第几步"算 —— 站在第 3 步不等于
       前 2 步都完事了,用当前步数会虚报进度。 */
    percent: Math.round((done / total) * 100),
    text: `第 ${current} / ${total} 步`,
    currentText: steps[current - 1]?.text || ''
  };
}

/**
 * 计划有没有在推进。
 *
 * 目标模式原来的"停滞"判据是**连续几轮输出雷同** —— 那是在猜。
 * 有了计划就有硬指标:**完成数长时间不涨**。
 * 截图里 codex 那句「目标已停滞」就是这个意思。
 *
 * 注意要求至少有过两次快照:只有一次时说"没推进"和瞎猜没区别。
 */
export function planStalled(history = [], { stallMs = 15 * 60 * 1000, now = Date.now() } = {}) {
  const h = (history || []).filter((x) => x && typeof x.done === 'number');
  if (h.length < 2) return false;
  const last = h[h.length - 1];
  // 最后一次"完成数变多"是什么时候
  let movedAt = h[0].at;
  for (let i = 1; i < h.length; i += 1) if (h[i].done > h[i - 1].done) movedAt = h[i].at;
  return last.done < last.total && now - movedAt >= stallMs;
}

/**
 * 从模型的正文里捞进度。
 *
 * 起因是一次很刺眼的对比:模型在回复里明明白白写着
 * 「当前仍在第 12/67 步」,而状态条显示「0/25 轮」——
 * **信息就在眼前,应用却视而不见。**
 *
 * 这是**兜底**,不是主路径:文件是外部记忆,正文是模型的一面之词,
 * 它可能记错、可能把上一轮的数字复读一遍。所以只在读不到计划文件时用,
 * 并且在界面上标明来源是"模型自述"。
 *
 * 严格要求「步/step」紧挨着数字,否则 `12/67` 这种片段在正文里太常见
 * (版本号、比例、日期),误判一次就会显示一个凭空捏造的进度。
 */
const PROSE_RE = [
  /第\s*(\d{1,3})\s*[/／]\s*(\d{1,3})\s*步/,
  /步骤\s*(\d{1,3})\s*[/／]\s*(\d{1,3})/,
  /\bstep\s+(\d{1,3})\s*(?:\/|of)\s*(\d{1,3})\b/i
];
export function parseProseProgress(text = '') {
  const s = String(text || '');
  for (const re of PROSE_RE) {
    const m = s.match(re);
    if (!m) continue;
    const current = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    /* 反过来的(第 67/12 步)、总数是 1 的、超范围的一律不认 ——
       宁可不显示,也不显示一个假的。 */
    if (!(total >= 2 && current >= 1 && current <= total)) continue;
    return { current, total };
  }
  return null;
}

/**
 * 每条目标的默认计划文件位置。
 *
 * 有默认路径,拆解才能**默认发生**。要用户先想出一个路径、
 * 再手敲 `--plan`,这个功能就只有极少数人会用到 ——
 * 而它恰恰是"目标模式"和"跑 25 轮然后停"之间的全部差别。
 */
export function defaultPlanPath(convId) {
  const safe = String(convId || 'goal').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'goal';
  return `~/.remote-agent-studio/goals/${safe}.md`;
}

/**
 * 目标拆解提示词 —— 目标模式的第 0 轮。
 *
 * codex 的做法是先把目标摊成一张清单再逐条做;原来这里是直接开跑,
 * 于是"进度"只能是轮次,而轮次说不出还剩多少活儿。
 *
 * 这段提示词里每一条都是踩出来的:
 *  · 必须**写文件**,否则模型会在回复里列一张漂亮的清单然后就没了;
 *  · 必须给**粒度**,否则要么 5 条大到没法勾,要么 200 条全是琐事;
 *  · 必须让它**接着就干**,否则它会写完计划停下来等你说"开始"。
 */
export function buildDecomposePrompt(goal) {
  return [
    `【目标模式 · 拆解】目标:${goal?.text || ''}`,
    '',
    `第一步先把这个目标拆成一份可勾选的清单,写入文件 ${goal?.planPath || ''}`,
    '(用编辑/写文件的工具真的把文件建出来,不要只在回复里列清单):',
    '',
    '```markdown',
    '- [ ] 第一件事',
    '- [ ] 第二件事',
    '```',
    '',
    '要求:',
    '1. **粒度**:每条是一件能独立验证完成的事,通常 8~40 条。',
    '   拆到 3 条说明太粗(没法看出进度),拆到 100 条说明混进了琐碎操作。',
    '2. 按依赖顺序排,前面的做完后面的才能做',
    '3. 每条写清楚"做完的标志是什么",而不是只写动词',
    '4. 已经完成的部分直接写成 `- [x]`,不要假装从零开始',
    '',
    '**写完文件后不要停下来等我确认**,立刻开始做第一条未完成的,',
    '并把正在做的那条标成 `- [~]`。'
  ].join('\n');
}

/**
 * 让智能体维护计划文件的指令。
 *
 * 这段必须够具体:光说"更新进度"的话,模型会在回复里写一段进度描述,
 * 而不去动文件 —— 那样应用还是读不到任何东西。
 */
export function planPromptFragment(planPath) {
  if (!planPath) return '';
  return [
    '',
    `【计划文件】${planPath}`,
    '每轮开始前先读它,结束前**必须更新它**(用编辑文件的工具,不要只在回复里描述):',
    `- 完成一项就把 \`- [ ]\` 改成 \`- [x]\``,
    `- 正在做的那项标成 \`- [~]\``,
    '- 发现需要新增的步骤,追加到清单末尾',
    '- 保持一行一步,不要把多件事塞进同一行'
  ].join('\n');
}
