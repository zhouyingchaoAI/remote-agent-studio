/**
 * 统一后台任务登记表。
 *
 * 之前只有下载任务能看到状态,但后台跑的远不止下载:传文件、装引擎、下发技能、
 * 跑速览、自动沉淀、智能体的每一轮对话 —— 它们各自散在自己的页面里,
 * 有的连"在跑"都看不出来。这里把它们收到同一个地方。
 *
 * 任务有两个来源,性质完全不同,必须区别对待:
 *
 *  · **app** —— 应用自己发起的(IPC 调用)。我们知道它什么时候开始、什么时候结束、
 *    成功还是抛错。信息是完整的。
 *  · **host** —— 扫描主机进程发现的(见 bgTasks.js)。我们只知道它在跑;
 *    **进程消失时拿不到退出码**,所以只能标"已结束(结果未知)",不能假装成功。
 *
 * 终态怎么处理,来回改过两次,最后定在这里:
 *
 *  · 跑完的任务**仍然登记、仍然保留一段时间**,所以"刚才那条到底成没成"
 *    随时能查到(打开「显示全部」)。
 *  · 但**默认不显示**。实测一屏里一半是「已结束(结果未知)」的空壳 ——
 *    主机上十几秒就没了的子进程根本不是你关心的任务,它们只是把
 *    真正在跑的活儿挤下去了。
 *  · **失败的例外,默认就显示。** 失败不是噪音,是最该立刻看到的那条。
 */
const { redact } = require('./errorLog');

/** 终态保留时长。够你切回来看一眼结果,又不至于让列表越堆越长。 */
const RETAIN_MS = 10 * 60 * 1000;
/** 终态最多留这么多条,防止一次批量操作把面板刷爆 */
const RETAIN_MAX = 50;
/**
 * 短于这个时长的任务不进面板。
 *
 * 不是所有 IPC 都值得展示:`fs:listRemote` 几十毫秒就回来了,涌进面板只会把
 * 真正在跑的活儿淹没,而且是一闪而过的噪音。但"会不会跑很久"没法只看名字决定 ——
 * `setup:installAgent` 可能 3 秒也可能 5 分钟。所以照常登记,只是**跑够 1.5 秒
 * 才显示**;短任务从头到尾没人看见,长任务自动浮出来。
 */
const VISIBLE_AFTER_MS = 1500;

/**
 * 哪些 IPC 值得当作后台任务登记。
 *
 * 没列进来的一律不登记 —— 读目录、取设置这类查询即使偶尔慢,也不是"任务"。
 * title 拿到的是该 IPC 的第一个参数。
 */
const TASK_CHANNELS = {
  'fs:upload': { kind: 'transfer', label: '上传', title: (a) => base(a?.localPath), cancel: 'fs:cancelTransfer' },
  'fs:download': { kind: 'transfer', label: '下载', title: (a) => base(a?.remotePath), cancel: 'fs:cancelTransfer' },
  'fs:copyHostToHost': { kind: 'transfer', label: '主机间传输', title: (a) => base(a?.srcPath), cancel: 'fs:cancelTransfer' },
  'fs:setupDirect': { kind: 'transfer', label: '配置直连' },
  'setup:installAgent': { kind: 'setup', label: '安装引擎', title: (a) => a?.agent || '' },
  'setup:syncAuth': { kind: 'setup', label: '同步登录态' },
  'setup:testRemoteAgent': { kind: 'setup', label: '测试引擎', title: (a) => a?.agent || '' },
  'setup:detect': { kind: 'setup', label: '检测环境' },
  'skills:install': { kind: 'skills', label: '下发技能', title: (a) => a?.name || '' },
  'skills:marketFetch': { kind: 'skills', label: '拉取技能市场' },
  'github:login': { kind: 'auth', label: 'GitHub 登录', cancel: 'github:cancel' },
  'github:syncToRemote': { kind: 'auth', label: '下发 GitHub 登录态' },
  'github:install': { kind: 'auth', label: '安装 gh' },
  'registry:login': { kind: 'auth', label: '登录镜像仓库', title: (a) => a?.registry || '' },
  'web:start': { kind: 'service', label: '启动本地服务', title: (a) => a?.id || '' },
  'web:waitReady': { kind: 'service', label: '等待服务就绪', title: (a) => a?.id || '' }

  /* **对话轮次、快速提问、语音转写、速览、自动沉淀都不在这里。**
   *
   * 它们本质是"模型在想",不是后台作业 —— 而且对话页自己就有转圈和
   * 「停止」按钮,重复放进这个面板只会把真正需要盯的东西挤下去:
   * 你想在这儿看的是镜像拉到哪了、文件传了多少、命令跑完没有。
   *
   * 判断标准:**这件事是不是即使你关掉这个页面也仍然要盯的**。
   * 一轮对话不是(它就在你眼前),一个 8GB 的镜像拉取是。
   */
};

function base(p) {
  return String(p || '').replace(/\/+$/, '').split(/[/\\]/).pop() || '';
}

function shorten(s, n = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** 描述一个任务。标题可能来自用户输入(提问、路径),照例脱敏后再存。 */
function describe(channel, args) {
  const d = TASK_CHANNELS[channel];
  if (!d) return null;
  const detail = shorten(redact(String(d.title ? d.title(args) || '' : '')));
  return {
    kind: d.kind,
    label: d.label,
    title: detail ? `${d.label} ${detail}` : d.label,
    cancelChannel: d.cancel || ''
  };
}

class TaskRegistry {
  constructor({ retainMs = RETAIN_MS, retainMax = RETAIN_MAX } = {}) {
    this.tasks = new Map();
    this.seq = 0;
    this.retainMs = retainMs;
    this.retainMax = retainMax;
  }

  /** 登记一次 IPC 调用。返回 null 表示这个通道不值得登记。 */
  begin(channel, args, { now = Date.now() } = {}) {
    const d = describe(channel, args);
    if (!d) return null;
    this.seq += 1;
    const id = `app_${this.seq}`;
    this.tasks.set(id, {
      id,
      source: 'app',
      channel,
      hostId: args?.hostId || '',
      convId: args?.convId || '',
      /* 传输类的 transferId 是外面用来对进度的钥匙,登记下来才能把
         transfer:progress 事件接回到这条任务上 */
      refId: args?.transferId || args?.askId || args?.convId || '',
      ...d,
      state: 'running',
      startedAt: now,
      endedAt: 0,
      error: '',
      progress: null,
      note: ''
    });
    return id;
  }

  /** 中途更新:进度、当前在做什么。找不到就静默忽略,进度事件比任务活得久是正常的。 */
  update(id, patch = {}) {
    const t = this.tasks.get(id);
    if (!t) return;
    if (patch.note != null) t.note = shorten(redact(String(patch.note)), 90);
    if (patch.progress !== undefined) t.progress = patch.progress;
  }

  /** 按 refId 更新 —— 进度事件通常只带 transferId,不知道任务 id */
  updateByRef(refId, patch = {}) {
    if (!refId) return;
    for (const t of this.tasks.values()) {
      if (t.state === 'running' && t.refId === refId) this.update(t.id, patch);
    }
  }

  end(id, { ok = true, error = '', now = Date.now() } = {}) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.state = ok ? 'done' : 'failed';
    t.endedAt = now;
    t.error = ok ? '' : shorten(redact(String(error || '')), 200);
    this.prune(now);
  }

  /** 清掉过期的终态。运行中的永远不清 —— 跑一小时的任务不该因为"太久"而消失。 */
  prune(now = Date.now()) {
    const finished = [...this.tasks.values()]
      .filter((t) => t.state !== 'running')
      .sort((a, b) => b.endedAt - a.endedAt);
    finished.forEach((t, i) => {
      if (now - t.endedAt > this.retainMs || i >= this.retainMax) this.tasks.delete(t.id);
    });
  }

  /**
   * 面板要显示的列表。
   *
   * @param hostTasks bgTasks 扫出来的主机进程(见 mergeHostTasks 的取舍)
   */
  snapshot({ now = Date.now(), hostTasks = [], hostId = '', convId = '', all = false } = {}) {
    this.prune(now);
    const app = [...this.tasks.values()]
      // 跑得够久才露面:短任务一闪而过只是噪音
      .filter((t) => t.state !== 'running' || now - t.startedAt >= VISIBLE_AFTER_MS)
      .map((t) => ({ ...t, elapsedMs: (t.endedAt || now) - t.startedAt }));

    const merged = [...app, ...hostTasks];
    /* all=true 时不筛,给「看全部」开关用。
       终态仍然留在登记表里(prune 才删),只是默认不显示 —— 这样
       打开开关就能立刻看到刚才那条到底成没成,不必重新跑一遍。 */
    const visible = all
      ? merged
      : merged.filter((t) => DEFAULT_STATES.has(t.state) && matchesScope(t, { hostId, convId }));
    return visible.sort(byRecency);
  }
}

/**
 * 面板默认只显示这些状态。
 *
 * 原来把跑完的也留 10 分钟,理由是"要能看到结果"。但实际用起来,
 * 一屏里一半是「已结束(结果未知)」的空壳 —— 主机上那些十几秒就没了的
 * 子进程根本不是你关心的"任务",它们只是把真正在跑的活儿挤下去了。
 *
 * 折中:默认只看在跑的,**但失败的留着**。失败不是噪音,恰恰是你最需要
 * 立刻看到的一条;把它和"跑完了"一起藏掉,等于让错误悄悄溜走。
 * 想看全的有开关。
 */
const DEFAULT_STATES = new Set(['running', 'stalled', 'failed']);

/**
 * 按主机/对话筛。
 *
 * **诚实的边界**:主机上扫到的进程**无法归属到某一轮对话** —— 智能体是自己
 * 在远端起进程的,应用只转发输出,看不到是哪次对话起的哪个进程。
 * 能做到的最细粒度是「哪台主机」。应用自己发起的任务才带得上 convId。
 * 所以按对话筛时,主机进程按主机匹配即可,不能硬要求 convId 相等 ——
 * 那会把它们全部滤掉,而它们正是最需要看的。
 */
function matchesScope(t, { hostId = '', convId = '' } = {}) {
  if (hostId && t.hostId && t.hostId !== hostId) return false;
  // 只有应用侧任务知道自己属于哪轮对话;带了才比,没带就不筛
  if (convId && t.source === 'app' && t.convId && t.convId !== convId) return false;
  return true;
}

function byRecency(a, b) {
  // 运行中的永远排在终态前面 —— 需要盯的是还在跑的那些
  const ar = a.state === 'running' ? 0 : 1;
  const br = b.state === 'running' ? 0 : 1;
  if (ar !== br) return ar - br;
  return (b.startedAt || 0) - (a.startedAt || 0);
}

/**
 * 把主机扫描结果转成统一形状,并给消失的进程一个诚实的终态。
 *
 * @param prevHost 上一轮的主机任务(用来发现"消失了")
 *
 * 进程从 ps 里消失,我们**拿不到退出码** —— 它可能下完了,也可能被 OOM 杀了。
 * 所以标 'ended',文案是"已结束(结果未知)",绝不写成"完成"。
 * 唯一能多说一句的是停滞过的任务:那种消失更可能是失败,给一句提示。
 */
function mergeHostTasks(prevHost, scanned, hostId, { now = Date.now(), retainMs = RETAIN_MS } = {}) {
  const out = [];
  const seen = new Set();

  for (const t of scanned) {
    seen.add(t.pid);
    out.push({
      id: `host_${hostId}_${t.pid}`,
      source: 'host',
      hostId,
      kind: t.kind,
      label: t.label,
      title: t.title,
      command: t.command,
      pid: t.pid,
      state: t.stalled ? 'stalled' : 'running',
      startedAt: t.startedAtMs,
      elapsedMs: t.elapsedSec * 1000,
      progressMode: t.progress,          // 'measured' | 'unknown'
      bytes: t.bytes,
      bytesPerSec: t.bytesPerSec,
      bytesSource: t.bytesSource,
      longRunning: !!t.longRunning,
      wasStalled: t.stalled || (prevHost || []).find((p) => p.pid === t.pid)?.wasStalled || false
    });
  }

  // 上一轮有、这一轮没了 —— 进程结束了
  for (const p of prevHost || []) {
    if (seen.has(p.pid)) continue;
    if (p.state === 'ended') {
      if (now - (p.endedAt || 0) <= retainMs) out.push(p);   // 终态留一会儿
      continue;
    }
    out.push({
      ...p,
      state: 'ended',
      endedAt: now,
      /* 说不出成没成就别说。之前停滞过的话多提一句,因为那种消失
         更可能是超时退出而不是下完了。 */
      note: p.wasStalled
        ? '进程已结束 —— 此前长时间无数据,更可能是失败'
        : '进程已结束 —— 应用看不到退出码,结果未知'
    });
  }
  return out;
}

/** 状态显示文案。'done' 和 'ended' 必须分得清:一个是确定成功,一个是不知道。 */
function stateText(task) {
  switch (task.state) {
    case 'running': return '进行中';
    case 'stalled': return '停滞';
    case 'done': return '完成';
    case 'failed': return '失败';
    case 'ended': return '已结束(结果未知)';
    default: return task.state || '';
  }
}

module.exports = {
  TaskRegistry, TASK_CHANNELS,
  RETAIN_MS, RETAIN_MAX, VISIBLE_AFTER_MS, DEFAULT_STATES, matchesScope,
  describe, mergeHostTasks, stateText, shorten
};
