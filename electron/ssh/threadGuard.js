/**
 * 线程锁的**根治**:开跑之前先确认没人占着这个线程。
 *
 * ── 为什么"撞了锁再恢复"不够 ──
 *
 * 上一版做的是事后补救:撞锁 → 丢掉 thread id → 开新线程。
 * 对话是能继续了,但每次都要先失败一次,而且**每失败一次就多一个
 * 挂死的 codex 进程**,越积越多。
 *
 * 用户机器上抓到的现场说明了全部问题:
 *
 *   1817830 codex exec … resume 01a041fc-… 在吗
 *
 * 一句「在吗」的进程还活着 —— 它卡在 `failed to refresh available
 * models: timeout waiting for child process to exit` 出不来,
 * 于是那个线程的写锁永远不释放。
 *
 * ── 三层根因,缺一层都还会复发 ──
 *
 * 1. **进程会挂死**:上游端点不通时 codex 拉模型列表的子进程卡住,
 *    父进程等它退出,一起卡成僵尸。应用这边没有任何超时,
 *    execStream 会一直等到进程退出 —— 于是永远等下去。
 *
 * 2. **内存里的"正在跑"守不住**:AgentSession.running 只在当前
 *    session 对象里。应用重启、或对话重新初始化会新建 session 对象,
 *    running 归 false,而**远端那个进程还活着**。
 *    这就是为什么重启应用也救不回来。
 *
 * 3. **杀得不干净**:原来 TERM 之后 2 秒就 KILL。codex 需要时间把
 *    thread store 落盘并释放锁,KILL 得太早等于制造一把永久的脏锁。
 *
 * 本模块负责第 2、3 层:**每次要 resume 某个线程之前,先去远端问一句
 * "还有谁占着它",有就先请它退场。** 这一步跨进程、跨重启都有效,
 * 因为它问的是操作系统,不是应用自己的内存。
 */

/**
 * 线程 id 会拼进 shell 命令,必须严格校验。
 *
 * codex 的 thread id 是 uuid 形态。放宽到"任意字符串"的话,
 * 一个带引号或分号的 id 就是命令注入 —— 而这个 id 来自外部进程的输出,
 * 不是我们能担保的东西。宁可不清理,也不执行一条拼歪的命令。
 */
const THREAD_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;
function isSafeThreadId(id) {
  return THREAD_ID_RE.test(String(id || ''));
}

/**
 * 找出还占着这个线程的 codex 进程。
 *
 * 用 `pgrep -af` 拿到完整命令行再按 thread id 过滤 ——
 * 只按进程名找会把**别的对话**正在跑的 codex 一起误杀,
 * 那比不清理严重得多(用户会看到另一个窗口的任务凭空中断)。
 */
function buildFindOwnersCommand(threadId) {
  if (!isSafeThreadId(threadId)) return '';
  // grep -F:thread id 里的 `-` 不该被当成正则元字符
  return `pgrep -af 'codex exec' 2>/dev/null | grep -F ${JSON.stringify(threadId)} | awk '{print $1}'`;
}

/** 解析出 pid 列表。非数字行一律丢掉,别把噪音当 pid 去 kill。 */
function parseOwnerPids(stdout, { selfPid = null } = {}) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const n = Number(String(line).trim());
    if (!Number.isInteger(n) || n <= 1) continue;   // 1 是 init,绝不能碰
    if (selfPid && n === Number(selfPid)) continue; // 别把自己杀了
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** TERM 之后最多等多久再 KILL(毫秒)。给足时间让 codex 把锁释放掉。 */
const RELEASE_GRACE_MS = 8000;

/**
 * 请这些进程退场:先 TERM,**确认真的退了**再收工;
 * 超过宽限期还赖着才 KILL。
 *
 * 关键是那个"等"字。原来 TERM 完 2 秒直接 KILL,codex 还没来得及
 * 把 thread store 落盘 —— 结果是每杀一次就留下一把永久的脏锁,
 * 清理动作本身变成了故障来源。
 *
 * 用 `for` 遍历字面量列表,不用 `while read`:没有管道输入时
 * `while read` 会一直等 stdin,把整条命令挂死在那儿(这个坑踩过)。
 */
function buildReleaseCommand(pids, { graceMs = RELEASE_GRACE_MS } = {}) {
  const list = (pids || []).filter((p) => Number.isInteger(p) && p > 1);
  if (!list.length) return '';
  const ids = list.join(' ');
  const rounds = Math.max(1, Math.round(graceMs / 250));
  return [
    `for p in ${ids}; do kill -TERM "$p" 2>/dev/null; done`,
    `for i in $(seq 1 ${rounds}); do`,
    '  alive=0',
    `  for p in ${ids}; do kill -0 "$p" 2>/dev/null && alive=1; done`,
    '  [ "$alive" = 0 ] && break',
    '  sleep 0.25',
    'done',
    // 还活着说明它卡死了,TERM 收不到 —— 只能硬杀
    `for p in ${ids}; do kill -KILL "$p" 2>/dev/null; done`,
    'exit 0'
  ].join('\n');
}

module.exports = {
  isSafeThreadId, buildFindOwnersCommand, parseOwnerPids, buildReleaseCommand,
  RELEASE_GRACE_MS
};
