/**
 * 对话镜像:复制一份,保留历史与上下文,但**换一条独立的引擎会话**。
 *
 * ── 这个功能最要紧的一条:会话 ID 绝对不能跟着复制 ──
 *
 * 直觉上"镜像"就是把对象整个拷一份。但 `codexSessionId` / `claudeSessionId`
 * 指向的是**引擎自己那边的一条线程**,而那条线程只能有一个写者。
 * 两个对话拿着同一个 thread id 去 resume,结果就是:
 *
 *   thread-store conflict: thread <id> already has an active writer
 *
 * 这正是之前排查了很久的那个「一直连不上」。所以镜像必须开新线程 ——
 * 这不是保守,是**唯一正确**的做法:引擎侧的线程本来就不支持分叉。
 *
 * ── 那上下文怎么办 ──
 *
 * 引擎那边接不上,就从我们这边补:对话记录是完整的,把它摘要成一段
 * 交接说明,在镜像的第一轮随指令一起发过去。这套机制切换引擎时已经在用
 * (buildContextDigest),镜像只是同一个问题的另一种形态。
 *
 * 所以要诚实地讲:**镜像保住的是"聊过什么",不是引擎的内部状态。**
 * 引擎缓存的文件内容、工具调用中间态都不会跟过来。
 */

/**
 * 不能带进镜像的字段,以及各自的理由。
 * 写成表是为了以后加字段时有个对照 —— 漏掉一个就是一个难查的 bug。
 */
export const NOT_MIRRORED = {
  codexSessionId: '引擎侧线程只能有一个写者,复制会撞锁',
  claudeSessionId: '同上',
  codexStarted: '新线程还没起过,标成已起会让下一轮直接 resume 一个不存在的线程',
  goal: '目标模式会自动发消息。跟着复制的话,两个对话会同时对着同一个目录推进',
  team: '同上,团队模式也会自动轮转',
  lastTurnAgent: '镜像的第一轮要重新交接上下文,不能让它以为接着上一轮'
};

/** 镜像时重置成什么 */
const RESET = {
  codexSessionId: null,
  claudeSessionId: null,
  codexStarted: false,
  goal: null,
  team: null,
  lastTurnAgent: ''
};

/**
 * @param src  源对话
 * @param opts { id, title, cwd, hostId, now }
 * @returns 新对话对象;src 为空时返回 null
 */
export function mirrorConversation(src, opts = {}) {
  if (!src || !src.id) return null;
  const now = opts.now || Date.now();
  const id = opts.id || `c_${now}_${Math.random().toString(36).slice(2, 6)}`;

  return {
    ...src,
    ...RESET,
    id,
    hostId: opts.hostId || src.hostId,
    cwd: opts.cwd != null ? opts.cwd : src.cwd,
    title: opts.title || nextMirrorTitle(src.title),
    /* 整条历史都带过去 —— 这正是用户要的"保留之前的资料"。
       浅拷贝数组即可:消息对象本身从不被原地修改(store 里都是整条替换)。 */
    messages: [...(src.messages || [])],
    /* 用量不复制:那是源对话真实烧掉的 token,记在镜像头上会让
       预算和账单都对不上。 */
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    /** 第一轮发送时把历史摘要一并带给新线程,之后清掉 */
    needsContextReplay: true,
    mirrorOf: src.id,
    mirroredAt: now,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 镜像标题。
 *
 * 已经是「X 副本」的再镜像一次,要变成「X 副本 2」而不是「X 副本 副本」——
 * 镜像常常是连着做好几个(试几种方案),名字堆起来就没法看了。
 */
export function nextMirrorTitle(title) {
  const base = String(title || '对话').trim() || '对话';
  const m = base.match(/^(.*?) 副本(?: (\d+))?$/);
  if (!m) return `${base} 副本`;
  const n = parseInt(m[2] || '1', 10);
  return `${m[1]} 副本 ${n + 1}`;
}

/**
 * 镜像第一轮的上下文交接提示词。
 *
 * 必须说清楚"这些是之前聊过的、不用重做" —— 不说的话,模型很可能
 * 把摘要里提到的事情再做一遍,而那些事在磁盘上早就做完了。
 */
/**
 * 分路第一轮的提示词。
 *
 * 和普通镜像的差别在于**必须划清边界**:几路在同时跑,
 * 各自一个 git worktree、一条分支。不说清楚的话,模型会顺手去改
 * 别路正在做的东西 —— 在各自的 worktree 里改不会冲突,
 * 但合并时会撞成一团,而那时候已经很难看出是谁碰的。
 */
export function buildForkPrompt({ digest, focus, branch, path: wtPath, siblings = [] }) {
  const lines = [
    '【分路 · 独立工作区】这条对话是从一条主线对话分出来的,',
    '专门负责其中一件事。现在有几路在并行,各自一个 git worktree。',
    '',
    `本路负责:${focus}`,
    wtPath ? `工作目录:${wtPath}` : '',
    branch ? `所在分支:${branch}` : ''
  ].filter(Boolean);

  if (siblings.length) {
    lines.push(
      '',
      `其他几路在做(**不要碰**):${siblings.join('、')}`,
      '越界修改在各自 worktree 里不会立刻冲突,但合并时会撞成一团,',
      '而且那时候很难看出是谁改的。有依赖就说出来,不要自己顺手做掉。'
    );
  }

  if (digest) {
    lines.push('', '以下是主线对话此前的记录摘要,作为背景:', '', digest);
  }
  lines.push(
    '',
    '注意:摘要里已完成的工作**不要重做** —— 这条分路是从主线的提交点切出来的,',
    '那些改动都已经在代码里了。需要确认就直接读文件。'
  );
  return lines.join('\n');
}

export function buildMirrorPrompt(digest, userText) {
  if (!digest) return userText;
  return [
    '【对话镜像 · 上下文交接】这是从另一条对话镜像出来的新会话,',
    '工作目录和文件都还是原来那份,只是引擎侧换了一条新线程。',
    '以下是此前的对话摘要,请读完后无缝接上:',
    '',
    digest,
    '',
    '注意:摘要里已经完成的工作**不要重做**,磁盘上的改动都还在。',
    '如果需要确认某个文件的当前状态,直接去读它。',
    '————',
    `用户新指令: ${userText}`
  ].join('\n');
}
