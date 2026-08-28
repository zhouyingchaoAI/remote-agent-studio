const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  TaskRegistry, TASK_CHANNELS, VISIBLE_AFTER_MS, describe: desc, mergeHostTasks, stateText
} = require('../electron/taskRegistry');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ------------------------------------------------------------ 登记范围 */

test('只登记会跑一阵子的通道,查询类的一律不登记', () => {
  /* fs:listRemote 几十毫秒就回来了。把这类也登记进去,面板会被刷屏,
     真正在跑的活儿反而被淹没。 */
  assert.equal(desc('fs:listRemote', {}), null);
  assert.equal(desc('settings:get', {}), null);
  assert.equal(desc('convos:list', {}), null);
  assert.ok(desc('fs:upload', { localPath: '/a/b.zip' }));
  assert.ok(desc('setup:installAgent', { agent: 'codex' }));
});

test('标题带上最能认出它的那点信息', () => {
  assert.match(desc('fs:download', { remotePath: '/data/model.safetensors' }).title, /model\.safetensors/);
  assert.match(desc('setup:installAgent', { agent: 'claude' }).title, /claude/);
  // 没有可用信息时退回纯标签,而不是留一个尾巴
  assert.equal(desc('setup:syncAuth', {}).title, '同步登录态');
});

test('标题在存下来之前脱敏', () => {
  /* 提问和路径都可能带密钥 —— 比如「我这个 sk-xxx 为什么 401」。
     面板会把标题显示出来,所以脱敏必须发生在登记时。 */
  const fake = 'sk-' + 'b'.repeat(40);
  const d = desc('ask:shell', { question: `为什么 ${fake} 会 401` });
  assert.ok(!d.title.includes(fake));
  assert.match(d.title, /\*\*\*/);
});

/* ------------------------------------------------------------ 生命周期 */

test('登记 → 完成', () => {
  const r = new TaskRegistry();
  const id = r.begin('fs:upload', { localPath: '/a/b.zip', hostId: 'h1' }, { now: 0 });
  assert.ok(id);
  r.end(id, { ok: true, now: 5000 });
  const t = r.snapshot({ now: 5000 })[0];
  assert.equal(t.state, 'done');
  assert.equal(t.elapsedMs, 5000);
  assert.equal(t.hostId, 'h1');
});

test('抛错的任务标成失败并留下原因', () => {
  const r = new TaskRegistry();
  const id = r.begin('setup:installAgent', { agent: 'codex' }, { now: 0 });
  r.end(id, { ok: false, error: 'npm 装不上:ETIMEDOUT', now: 3000 });
  const t = r.snapshot({ now: 3000 })[0];
  assert.equal(t.state, 'failed');
  assert.match(t.error, /ETIMEDOUT/);
});

test('短任务不进面板,跑久了自动浮出来', () => {
  /* "会不会跑很久"没法只看通道名决定 —— setup:installAgent 可能 3 秒也可能 5 分钟。
     所以照常登记,只是跑够时长才显示。 */
  const r = new TaskRegistry();
  r.begin('setup:detect', { hostId: 'h1' }, { now: 0 });
  assert.equal(r.snapshot({ now: VISIBLE_AFTER_MS - 1 }).length, 0);
  assert.equal(r.snapshot({ now: VISIBLE_AFTER_MS + 1 }).length, 1);
});

test('进度按 refId 回填 —— 进度事件不知道任务 id', () => {
  const r = new TaskRegistry();
  const id = r.begin('fs:download', { remotePath: '/a/big.bin', transferId: 'tr_1' }, { now: 0 });
  r.updateByRef('tr_1', { progress: { transferred: 50, total: 100 } });
  const t = r.snapshot({ now: 9000 }).find((x) => x.id === id);
  assert.equal(t.progress.total, 100);
});

test('进度回填只作用于还在跑的任务', () => {
  // transferId 可能被复用;已结束的任务不该被后来的进度事件改写
  const r = new TaskRegistry();
  const id = r.begin('fs:download', { remotePath: '/a', transferId: 'tr_x' }, { now: 0 });
  r.end(id, { ok: true, now: 100 });
  r.updateByRef('tr_x', { progress: { transferred: 1, total: 2 } });
  assert.equal(r.snapshot({ now: 5000 })[0].progress, null);
});

test('进度事件比任务活得久是正常的,不该炸', () => {
  const r = new TaskRegistry();
  assert.doesNotThrow(() => r.updateByRef('不存在', { progress: {} }));
  assert.doesNotThrow(() => r.update('也不存在', { note: 'x' }));
});

/* ------------------------------------------------------------ 终态保留 */

test('跑完的任务保留一段时间,过期才清', () => {
  /* 这是这个面板存在的核心理由之一:进程一消失任务就没了的话,
     "下完了"和"下挂了"表现完全一样。 */
  const r = new TaskRegistry({ retainMs: 1000 });
  const id = r.begin('brief:run', {}, { now: 0 });
  r.end(id, { ok: true, now: 100 });
  assert.equal(r.snapshot({ now: 900 }).length, 1);
  assert.equal(r.snapshot({ now: 2000 }).length, 0);
});

test('运行中的任务永远不会因为"太久"被清掉', () => {
  // 跑一小时的编译不该从面板上消失
  const r = new TaskRegistry({ retainMs: 1000 });
  r.begin('setup:installAgent', { agent: 'codex' }, { now: 0 });
  const s = r.snapshot({ now: 3600 * 1000 });
  assert.equal(s.length, 1);
  assert.equal(s[0].state, 'running');
});

test('终态条数有上限,不会被批量操作刷爆', () => {
  const r = new TaskRegistry({ retainMax: 3 });
  for (let i = 0; i < 10; i += 1) {
    const id = r.begin('skills:install', { name: `s${i}` }, { now: i });
    r.end(id, { ok: true, now: i + 1 });
  }
  assert.equal(r.snapshot({ now: 100 }).length, 3);
});

test('运行中的排在终态前面', () => {
  const r = new TaskRegistry();
  const done = r.begin('brief:run', {}, { now: 0 });
  r.end(done, { ok: true, now: 1 });
  r.begin('fs:upload', { localPath: '/a' }, { now: 2 });
  const s = r.snapshot({ now: 10000 });
  assert.equal(s[0].state, 'running', '需要盯的是还在跑的那些');
});

/* ------------------------------------------------------------ 主机任务终态 */

const hostTask = (over) => ({
  pid: 7, kind: 'docker-pull', label: '拉取镜像', title: '拉取镜像 nginx',
  command: 'docker pull nginx', startedAtMs: 0, elapsedSec: 60,
  progress: 'measured', bytes: 100, bytesPerSec: 10, bytesSource: 'daemon', stalled: false, ...over
});

test('主机进程消失时标"结果未知",不能写成完成', () => {
  /* 进程从 ps 里消失,我们拿不到退出码 —— 它可能下完了,也可能被 OOM 杀了。
     写成"完成"就是编造一个我们并不知道的结论。 */
  const prev = mergeHostTasks([], [hostTask()], 'h1', { now: 0 });
  const now = mergeHostTasks(prev, [], 'h1', { now: 5000 });
  assert.equal(now.length, 1);
  assert.equal(now[0].state, 'ended');
  assert.match(now[0].note, /结果未知/);
  assert.ok(!/完成/.test(now[0].note));
});

test('停滞过的任务消失时,提示更可能是失败', () => {
  let s = mergeHostTasks([], [hostTask({ stalled: true })], 'h1', { now: 0 });
  s = mergeHostTasks(s, [], 'h1', { now: 1000 });
  assert.match(s[0].note, /更可能是失败/);
});

test('主机终态也会过期清掉', () => {
  let s = mergeHostTasks([], [hostTask()], 'h1', { now: 0 });
  s = mergeHostTasks(s, [], 'h1', { now: 1000, retainMs: 500 });
  s = mergeHostTasks(s, [], 'h1', { now: 3000, retainMs: 500 });
  assert.equal(s.length, 0);
});

test('停滞的任务状态是 stalled 而不是 running', () => {
  const s = mergeHostTasks([], [hostTask({ stalled: true })], 'h1', { now: 0 });
  assert.equal(s[0].state, 'stalled');
});

test('「完成」和「已结束(结果未知)」文案必须分得清', () => {
  assert.equal(stateText({ state: 'done' }), '完成');
  assert.match(stateText({ state: 'ended' }), /结果未知/);
  assert.notEqual(stateText({ state: 'done' }), stateText({ state: 'ended' }));
});

/* ------------------------------------------------------------ 接线 */

test('登记挂在 IPC 包装上,而不是逐个 handler 里加', () => {
  // 逐个加会漏,而漏掉的往往正是跑得最久、最该被看见的那个
  const main = read('electron/main.js');
  assert.match(main, /const taskId = taskRegistry\.begin\(channel/);
  assert.match(main, /taskRegistry\.end\(taskId, \{ ok: true \}\)/);
  assert.match(main, /taskRegistry\.end\(taskId, \{ ok: false/);
});

test('取消复用各自原本的取消通道,不另写一套', () => {
  /* 取消一次传输要清临时文件、取消一轮对话要收掉会话 ——
     那些细节属于各自的模块,在这里抄一遍必然会漏。 */
  const main = read('electron/main.js');
  assert.match(main, /handlerFns\.get\(t\.cancelChannel\)/);
  /* 查的是"有没有真的用",不是"有没有提到" —— 代码里有一段注释专门
     解释为什么不用它,那段注释不该让这条测试挂掉。 */
  assert.ok(!/ipcMain\._invokeHandlers\s*[?.[(]/.test(main), '不该依赖 Electron 私有字段');
});

test('传输进度同时喂给任务面板', () => {
  // 否则面板上只能显示一个干巴巴的"进行中",而进度其实是有的
  const main = read('electron/main.js');
  assert.ok((main.match(/taskRegistry\.updateByRef\(transferId/g) || []).length >= 3);
});

test('没有确切总量时不画进度条', () => {
  // 画一根不知道走到哪的条,比不画更误导
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /if \(!p \|\| !p\.total \|\| !\(p\.total > 0\)\) return null/);
});

test('编译和训练不适用停滞判定', () => {
  /* 它们本来就会长时间不写盘(编译在内存里跑、训练几分钟才存一次 checkpoint)。
     按下载的标准判死会给健康任务打上"卡住了"。 */
  const bg = require('../electron/bgTasks');
  assert.ok(!bg.STALL_KINDS.has('compile'));
  assert.ok(!bg.STALL_KINDS.has('train'));
  assert.ok(!bg.STALL_KINDS.has('docker-build'));
  assert.ok(bg.STALL_KINDS.has('docker-pull'));
});

test('docker build --pull 算构建,不算拉取', () => {
  const bg = require('../electron/bgTasks');
  assert.equal(bg.classifyKind('docker build --pull -t x .'), 'docker-build');
  assert.equal(bg.classifyKind('docker pull nginx'), 'docker-pull');
});

test('登记表覆盖了各类后台活儿,不只是传输', () => {
  const kinds = new Set(Object.values(TASK_CHANNELS).map((d) => d.kind));
  for (const k of ['transfer', 'setup', 'skills', 'brief', 'capture', 'auth', 'agent']) {
    assert.ok(kinds.has(k), `缺少 ${k} 类任务`);
  }
});
