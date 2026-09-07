const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const g = require('../electron/ssh/threadGuard');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const REAL_ID = '01a041fc-4a1b-7911-be69-fc194ec4bd9c';

/* ============================================================
 * 线程锁的根治。
 *
 * 上一版只做了事后补救(撞锁 → 换新线程),对话能继续,
 * 但每失败一次就多一个挂死的 codex 进程,锁还是会不断产生。
 *
 * 用户机器上的现场:
 *   1817830 codex exec … resume 01a041fc-… 在吗
 * 一句「在吗」的进程还活着,卡在拉模型列表那儿出不来。
 *
 * 三层根因,这里管第二、三层:
 *   2. 内存里的 running 守不住(重启就归零,远端进程还活着)
 *   3. 杀得太早,codex 来不及释放锁 —— 清理动作本身在制造脏锁
 * ============================================================ */

/* ---------------------------------------------- 注入防护 */

test('线程 id 会拼进 shell,必须严格校验', () => {
  /* 这个 id 来自外部进程的输出,不是我们能担保的东西。
     放宽到"任意字符串"就是命令注入。 */
  assert.ok(g.isSafeThreadId(REAL_ID));
  for (const bad of ['x; rm -rf /', "a'b", '$(id)', '', null, undefined, '../etc', 'a b']) {
    assert.equal(g.isSafeThreadId(bad), false, JSON.stringify(bad));
    assert.equal(g.buildFindOwnersCommand(bad), '', '非法 id 不该产生任何命令');
  }
});

test('查找命令按完整命令行过滤,不只按进程名', () => {
  /* 只按进程名找会把**别的对话**正在跑的 codex 一起误杀 ——
     用户会看到另一个窗口的任务凭空中断,比不清理严重得多。 */
  const cmd = g.buildFindOwnersCommand(REAL_ID);
  assert.match(cmd, /pgrep -af 'codex exec'/);
  assert.match(cmd, /grep -F/, 'id 里的 - 不该被当成正则元字符');
  assert.ok(cmd.includes(REAL_ID));
});

/* ---------------------------------------------- pid 解析 */

test('从 pgrep 输出里解出 pid', () => {
  assert.deepEqual(g.parseOwnerPids('1817830\n1817900\n'), [1817830, 1817900]);
});

test('噪音行、init、自己都不会被当成 pid', () => {
  /* 把噪音当 pid 去 kill 是能杀错东西的 —— 尤其 pid 1。 */
  assert.deepEqual(g.parseOwnerPids('\n abc \n0\n1\n-5\n42\n'), [42]);
  assert.deepEqual(g.parseOwnerPids('42\n99\n', { selfPid: 42 }), [99]);
  assert.deepEqual(g.parseOwnerPids(''), []);
  assert.deepEqual(g.parseOwnerPids(null), []);
});

test('重复 pid 只留一个', () => {
  assert.deepEqual(g.parseOwnerPids('7\n7\n7\n'), [7]);
});

/* ---------------------------------------------- 终止命令(真 bash 验证) */

test('没有 pid 时不产生命令', () => {
  // 空列表却生成一条 kill,等于凭空多跑一条命令
  assert.equal(g.buildReleaseCommand([]), '');
  assert.equal(g.buildReleaseCommand(null), '');
  assert.equal(g.buildReleaseCommand([0, 1, -3]), '', 'pid 1 是 init,绝不能碰');
});

test('真的能把进程终止掉,而且退出码是 0', async () => {
  /* 用真 bash 跑:kill/等待/再 kill 这套逻辑的边角情况
     没法靠读代码判断(这一整轮里我已经被 shell 坑过好几次)。 */
  const a = spawn('sleep', ['300'], { stdio: 'ignore' });
  const b = spawn('sleep', ['300'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 100));
  const cmd = g.buildReleaseCommand([a.pid, b.pid], { graceMs: 2000 });

  execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });   // 非 0 会抛
  await new Promise((r) => setTimeout(r, 200));

  for (const p of [a, b]) {
    assert.throws(() => process.kill(p.pid, 0), /ESRCH/, `pid ${p.pid} 没被终止`);
  }
});

test('先 TERM、确认退出后才 KILL', () => {
  /* **这一条是根治的另一半。** 原来 TERM 完 2 秒直接 KILL,
     而 codex 需要时间把 thread store 落盘、释放线程写锁 ——
     杀得太早,每取消一次就留下一把永久的脏锁,
     下次 resume 必然撞上:清理动作本身成了故障来源。 */
  const cmd = g.buildReleaseCommand([12345], { graceMs: 8000 });
  assert.ok(cmd.indexOf('kill -TERM') < cmd.indexOf('kill -KILL'), 'TERM 必须在 KILL 之前');
  assert.match(cmd, /kill -0 .* && alive=1/, '要真的确认它退了,而不是干等固定秒数');
  // 8 秒宽限,按 250ms 一轮 = 32 轮
  assert.match(cmd, /seq 1 32/);
});

test('不用 while read —— 没有管道输入会挂死', () => {
  // 这个坑在后台任务扫描里踩过一次,整条命令卡在等 stdin
  const cmd = g.buildReleaseCommand([1, 2, 3].map((n) => n + 100));
  assert.ok(!/while\s+read/.test(cmd));
});

/* ---------------------------------------------- 接线 */

const src = read('electron/ssh/AgentSession.js');

test('每次 resume 之前都先清一遍', () => {
  /* 这是唯一能**跨应用重启**生效的一层:它问的是操作系统
     "还有谁在跑这个 thread",而不是应用自己的内存。
     AgentSession.running 重启就归零,而远端进程还活着 ——
     那正是"重启也救不回来"的原因。 */
  assert.match(src, /await this\._releaseStaleThreadOwners\(\);/);
  const idx = src.indexOf('await this._releaseStaleThreadOwners()');
  assert.ok(idx > 0 && idx < src.indexOf('this.running = true'), '必须在置 running 之前');
});

test('只在要 resume 具体线程时才清,不无谓加延迟', () => {
  const fn = src.slice(src.indexOf('async _releaseStaleThreadOwners()'));
  assert.match(fn.slice(0, 400), /this\.opts\.agent !== 'codex' \|\| !id/);
});

test('清理失败不阻断发消息', () => {
  /* 这是预防性的一步,它自己不该成为发不出消息的原因 ——
     真撞上锁还有"丢掉 thread id 开新线程"那层兜底。 */
  const fn = src.slice(src.indexOf('async _releaseStaleThreadOwners()'));
  assert.match(fn.slice(0, 1400), /catch \(_\) \{/);
});

test('取消也走同一套终止逻辑', () => {
  // 另写一套必然和它不一致,而不一致的那一份就是下一个脏锁的来源
  const fn = src.slice(src.indexOf('  cancel() {'));
  assert.match(fn.slice(0, 700), /buildReleaseCommand\(\[pid\]\)/);
  assert.ok(!/sleep 2; kill -KILL/.test(fn.slice(0, 700)), '旧的"2 秒就硬杀"必须去掉');
});

/* ---------------------------------------------- 挂死看门狗 */

test('长时间没有任何输出就判定挂死并终止', () => {
  /* 这是"锁为什么会产生"的那一层。原来没有任何超时:
     execStream 一直等进程退出,于是永远等下去,写锁永不释放。 */
  assert.match(src, /const STALL_TIMEOUT_MS = /);
  assert.match(src, /stallTimer = setTimeout/);
  assert.match(src, /this\.cancel\(\);/);
});

test('判据是"没有输出",不是"总时长"', () => {
  /* 一轮跑一小时是正常的,而 codex 干活时 stdout 一直有事件流。
     按总时长砍会把正常的长任务误杀 —— 那比挂死更糟。 */
  const s = src.slice(src.indexOf('let stallTimer'));
  assert.match(s.slice(0, 2000), /bumpStall/);
  // stdout 和 stderr 都要能续命
  const dataHandlers = (src.match(/bumpStall\(\);/g) || []).length;
  assert.ok(dataHandlers >= 3, `只在 ${dataHandlers} 处续命,stdout/stderr/启动都要有`);
});

test('看门狗一定会被清理掉', () => {
  // 不清的话,一个跑完的会话还会在几分钟后突然"终止"下一轮
  assert.match(src, /if \(stallTimer\) clearTimeout\(stallTimer\)/);
});
