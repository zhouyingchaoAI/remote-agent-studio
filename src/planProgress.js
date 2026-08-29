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
