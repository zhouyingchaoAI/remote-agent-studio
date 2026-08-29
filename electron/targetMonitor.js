/**
 * 以**监控目标**为中心的进度记录。
 *
 * ── 为什么要推翻上一版的建模 ──
 *
 * 之前把任务建模成**进程**,于是:
 *  · `systemctl restart --no-block xxx` 一秒就退了,面板什么也抓不到;
 *  · 重试脚本在两次尝试之间 sleep,恰好被扫到的那一刻可能一个进程都没有;
 *  · 进程一消失,记录连同它的历史一起没了 —— 所以永远看不到"持续进度",
 *    只能看到一个又一个瞬时快照。
 *
 * 但对话里启动的活儿,**持久的把手不是 pid,是目标本身**:
 * 那个 systemd 单元、那个下载目录。它们从任务开始到结束一直在,
 * 进程只是其中一个时有时无的信号。
 *
 * 所以这里每个目标一条记录,跨采样累积:
 *  · 首次见到的时间 → "已持续多久"
 *  · 字节数采样序列 → **增量、速率、还在不在动**(这才是"持续进度")
 *  · 单元状态 + 最后一行日志 → 到哪一步了
 *
 * 进程消失不影响记录存在。这是这一版和之前所有版本的根本差别。
 */

/** 采样保留多少个点。够画一条趋势线,又不至于无限长。 */
const MAX_SAMPLES = 60;
/** 多久没有任何字节增长才算"停了" */
const IDLE_AFTER_MS = 120 * 1000;

/**
 * 把一次扫描并进已有的目标记录里。
 *
 * @param prev     上一轮的记录数组(第一次传 [])
 * @param watch    { units: [], paths: [], scripts: [], images: [] } —— 来自对话
 * @param scan     bgTasks.parseScan 的结果
 * @param now      当前时间
 *
 * **只增不减**:目标从 watch 里过期后记录才消失。扫描这一轮没看到进程、
 * 没读到大小,都只是"这一刻没数据",不是"任务没了"。
 */
function updateTargets(prev, { watch = {}, scan = {}, now = Date.now() } = {}) {
  const byKey = new Map((prev || []).map((r) => [r.key, r]));
  const out = [];

  const units = scan.units || [];
  const pathSizes = scan.pathSizes || new Map();
  const procs = scan.tasks || [];

  const touch = (key, seed) => {
    const rec = byKey.get(key) || { key, ...seed, firstSeenAt: now, samples: [] };
    return { ...rec, ...seed, key, firstSeenAt: rec.firstSeenAt, samples: rec.samples };
  };

  /* ---- systemd 单元 ---- */
  for (const name of watch.units || []) {
    const u = units.find((x) => x.unit === name);
    const rec = touch(`unit:${name}`, {
      kind: 'unit', name, label: '服务',
      activeState: u?.activeState || '',
      subState: u?.subState || '',
      lastLog: u?.lastLog || ''
    });
    /* 状态映射。**activating 是"在启动、还没就绪"**,正是你在等的那段;
       没查到不等于没了(可能这轮 systemctl 没返回),标 unknown 而不是 failed。 */
    rec.state = !u ? 'unknown'
      : (u.activeState === 'failed' || u.subState === 'failed') ? 'failed'
        : u.activeState === 'activating' ? 'starting' : 'active';
    out.push(rec);
  }

  /* ---- 下载目录 ---- */
  for (const p of watch.paths || []) {
    const size = pathSizes.get(p);
    const rec = touch(`path:${p}`, { kind: 'path', name: p, label: '目录' });
    if (typeof size === 'number' && size >= 0) {
      rec.samples = pushSample(rec.samples, { at: now, bytes: size });
    }
    rec.state = 'watching';
    out.push(rec);
  }

  /* ---- 进程(有就记,没有也不删记录) ---- */
  for (const token of [...(watch.scripts || []), ...(watch.images || [])]) {
    const hit = procs.find((t) => String(t.command || '').includes(token));
    const rec = touch(`proc:${token}`, { kind: 'proc', name: token, label: '进程' });
    if (hit) {
      rec.pid = hit.pid;
      rec.command = hit.command;
      if (hit.writeBytes >= 0) rec.samples = pushSample(rec.samples, { at: now, bytes: hit.writeBytes });
    }
    /* **进程不在 ≠ 任务结束。** 重试脚本在 sleep 间隙、systemd 在两次重启之间,
       都会有一段时间没有进程。之前把这当成"已结束(结果未知)"是错的:
       那条记录随后就被清掉了,于是"持续进度"永远攒不起来。 */
    rec.state = hit ? 'running' : 'idle';
    out.push(rec);
  }

  return out.map((r) => ({ ...r, ...progressOf(r, now) }));
}

function pushSample(samples, s) {
  const next = [...(samples || []), s];
  return next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next;
}

/**
 * 从采样序列算出"持续进度"。
 *
 * 这是这个模块存在的理由:单个快照只能说"现在多大",
 * 而人想知道的是**从开始到现在涨了多少、现在还在不在涨**。
 */
function progressOf(rec, now = Date.now()) {
  const s = rec.samples || [];
  if (s.length === 0) {
    return { grownBytes: null, bytesPerSec: null, movingAt: null, idle: false, sparkline: [] };
  }
  const first = s[0];
  const last = s[s.length - 1];
  const grownBytes = last.bytes - first.bytes;

  /* 速率用**最近一段**而不是全程平均:全程平均会把早期的快和现在的卡
     糊成一个中间值,而你要判断的恰恰是"现在还动不动"。 */
  const recent = s.filter((x) => now - x.at <= 60_000);
  const a = recent[0] || first;
  const b = last;
  const dt = (b.at - a.at) / 1000;
  const bytesPerSec = dt > 0 ? Math.max(0, (b.bytes - a.bytes) / dt) : null;

  // 最后一次真的涨过是什么时候
  let movingAt = first.at;
  for (let i = 1; i < s.length; i += 1) if (s[i].bytes > s[i - 1].bytes) movingAt = s[i].at;

  return {
    grownBytes,
    bytesPerSec,
    movingAt,
    /* 只有**采样够多、时间够长**才敢说停了。样本太少时说"停滞"
       和瞎猜没区别 —— 而误报停滞会让人去查一个不存在的故障。 */
    idle: s.length >= 3 && now - movingAt >= IDLE_AFTER_MS,
    sparkline: s.slice(-24).map((x) => x.bytes)
  };
}

/** 目标从对话监控清单里过期后,记录才该消失 */
function dropUnwatched(records, watch = {}) {
  const alive = new Set([
    ...(watch.units || []).map((v) => `unit:${v}`),
    ...(watch.paths || []).map((v) => `path:${v}`),
    ...(watch.scripts || []).map((v) => `proc:${v}`),
    ...(watch.images || []).map((v) => `proc:${v}`)
  ]);
  return (records || []).filter((r) => alive.has(r.key));
}

module.exports = { updateTargets, progressOf, dropUnwatched, MAX_SAMPLES, IDLE_AFTER_MS };
