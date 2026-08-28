const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  TaskRegistry, TASK_CHANNELS, VISIBLE_AFTER_MS, describe: desc, mergeHostTasks, stateText,
  DEFAULT_STATES, matchesScope
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
  // 「完成」默认不显示了,要看得打开 all
  const t = r.snapshot({ now: 5000, all: true })[0];
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
  // 已完成的默认不显示了,要查得打开 all
  assert.equal(r.snapshot({ now: 5000, all: true })[0].progress, null);
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
  assert.equal(r.snapshot({ now: 900, all: true }).length, 1);
  assert.equal(r.snapshot({ now: 2000, all: true }).length, 0, '过期后连 all 也查不到了');
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
  assert.equal(r.snapshot({ now: 100, all: true }).length, 3);
});

test('运行中的排在终态前面', () => {
  const r = new TaskRegistry();
  const done = r.begin('brief:run', {}, { now: 0 });
  r.end(done, { ok: true, now: 1 });
  r.begin('fs:upload', { localPath: '/a' }, { now: 2 });
  const s = r.snapshot({ now: 10000, all: true });
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


/* ------------------------------------------------ 默认只看在跑的 / 当前主机 */

test('默认只显示进行中、停滞、失败', () => {
  /* 契约改了。原来跑完的也留 10 分钟,理由是"要能看到结果";
     但实测一屏里一半是「已结束(结果未知)」的空壳,把真正在跑的挤了下去。
     失败保留是刻意的 —— 它不是噪音,是最该立刻看到的那条。 */
  assert.ok(DEFAULT_STATES.has('running'));
  assert.ok(DEFAULT_STATES.has('stalled'));
  assert.ok(DEFAULT_STATES.has('failed'), '失败不能跟着"跑完了"一起藏掉');
  assert.ok(!DEFAULT_STATES.has('done'));
  assert.ok(!DEFAULT_STATES.has('ended'));
});

test('跑完的默认不显示,但仍留在登记表里可查', () => {
  const r = new TaskRegistry();
  const a = r.begin('brief:run', {}, { now: 0 });
  r.end(a, { ok: true, now: 100 });
  r.begin('fs:upload', { localPath: '/x' }, { now: 0 });
  assert.equal(r.snapshot({ now: 9000 }).length, 1, '默认只剩在跑的那条');
  assert.equal(r.snapshot({ now: 9000, all: true }).length, 2, '打开 all 能查到刚跑完的');
});

test('失败的默认就显示,不用打开开关', () => {
  const r = new TaskRegistry();
  const id = r.begin('setup:installAgent', { agent: 'codex' }, { now: 0 });
  r.end(id, { ok: false, error: '装不上', now: 100 });
  assert.equal(r.snapshot({ now: 9000 }).length, 1);
});

test('只显示当前主机的', () => {
  const r = new TaskRegistry();
  r.begin('fs:upload', { localPath: '/a', hostId: 'h1' }, { now: 0 });
  r.begin('fs:upload', { localPath: '/b', hostId: 'h2' }, { now: 0 });
  const s = r.snapshot({ now: 9000, hostId: 'h1' });
  assert.equal(s.length, 1);
  assert.equal(s[0].hostId, 'h1');
});

test('主机上扫到的进程按主机匹配,不能因为没有 convId 就被滤掉', () => {
  /* 这是这个功能诚实的边界:智能体是自己在远端起进程的,应用只转发输出,
     **看不到是哪一轮对话起的哪个进程**。硬要求 convId 相等会把它们全滤光,
     而它们恰恰是最需要看的那批。 */
  const host = { source: 'host', hostId: 'h1', state: 'running' };
  assert.equal(matchesScope(host, { hostId: 'h1', convId: 'c1' }), true);
  assert.equal(matchesScope(host, { hostId: 'h2', convId: 'c1' }), false, '主机对不上还是要滤掉');
});

test('应用侧任务带了 convId 才按对话筛', () => {
  const mk = (convId) => ({ source: 'app', hostId: 'h1', convId, state: 'running' });
  assert.equal(matchesScope(mk('c1'), { hostId: 'h1', convId: 'c1' }), true);
  assert.equal(matchesScope(mk('c2'), { hostId: 'h1', convId: 'c1' }), false);
  // 没带 convId 的(传输、安装这类)不该因为"不属于任何对话"而消失
  assert.equal(matchesScope(mk(''), { hostId: 'h1', convId: 'c1' }), true);
});

test('不传作用域就不筛', () => {
  const t = { source: 'app', hostId: 'h9', convId: 'cX', state: 'running' };
  assert.equal(matchesScope(t, {}), true);
});

test('角标和面板用同一套作用域', () => {
  // 否则会出现「角标说有 3 个,点进去一个没有」—— 那 3 个在别的主机上
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /export function BgTasksBadge\(\{ onClick, hostId = '', convId = '' \}\)/);
  assert.match(ui, /window\.api\.bg\.snapshot\(\{ hostId, convId \}\)/);
});

test('磁盘预警只报当前主机', () => {
  /* 之前把所有已连接主机的都堆上来 —— 你在看 A 机器却收到 B 的告警,
     看着像当前这台快满了。 */
  const main = read('electron/main.js');
  assert.match(main, /\.filter\(\(\[hostId\]\) => !scope\.hostId \|\| hostId === scope\.hostId\)/);
});

test('pathSizes 存在 st 上,不是从别的函数的局部变量里拿', () => {
  /* 算快照的是 tasksSnapshot,量目录的是 bgScanHost —— 两个函数。
     直接引用 scan.pathSizes 会是 undefined,而这类作用域错误
     单测抓不到(它在主进程里、要跑起来才炸),lint 抓到了。 */
  const main = read('electron/main.js');
  assert.match(main, /st\.pathSizes = scan\.pathSizes/);
  assert.match(main, /pathSizes: st\.pathSizes/);
});
