const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const bg = require('../electron/bgTasks');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const F = bg.FIELD;
/* 第 6 列是 long 标记:没匹配上已知类型、只是跑得久而被捞进来的进程。
   默认传 0(= 认得出的任务),需要时单独传。 */
const taskLine = (pid, et, w, r, cmd, long = 0, ppid = 1, unit = '') =>
  ['TASK', pid, ppid, et, w, r, long, unit, cmd].join(F);

/* ------------------------------------------------------------ 分隔符 */

test('字段分隔符是真的 0x1F,不是空串', () => {
  /* 写代码时这个控制字符很容易在复制粘贴里丢掉,而丢了之后 split('')
     会把每个字符都切开 —— 解析全线崩,但不报错,只是永远列不出任务。 */
  assert.equal(F, '\x1f');
  assert.equal(F.length, 1);
});

test('命令行里的空格和制表符不会被当成分隔符', () => {
  // 正是为此才不用 \t:被扫描的命令行自己就带一堆空白
  const cmd = 'docker pull\tregistry.cn/x/y:v1  --platform linux/arm64';
  const { tasks } = bg.parseScan(taskLine(101, 30, 0, 0, cmd));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].command, cmd);
});

/* ------------------------------------------------------------ 解析 */

test('解析出 pid / 时长 / 字节数 / 命令', () => {
  const out = [
    taskLine(2451, 842, 3221225472, 900, 'docker pull swr.cn-south-1.myhuaweicloud.com/ascendhub/vllm-ascend:v0.10.0rc1'),
    ['DAEMON', 'dockerd', '9663676416'].join(F),
    ['DISK', '/', '2097152', '96%'].join(F)
  ].join('\n');
  const r = bg.parseScan(out);
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].pid, 2451);
  assert.equal(r.tasks[0].elapsedSec, 842);
  assert.equal(r.tasks[0].kind, 'docker-pull');
  assert.equal(r.daemons.dockerd, 9663676416);
  assert.equal(r.disks[0].availBytes, 2097152 * 1024);
});

test('命令行在展示前脱敏', () => {
  /* ps 输出是密钥最典型的泄露点 —— curl -H "Authorization: Bearer …"、
     带账号密码的 URL,全都明晃晃挂在命令行上。面板会把整条命令显示出来,
     所以脱敏必须发生在解析阶段,不能指望界面记得做。 */
  const fake = 'sk-' + 'a'.repeat(40);
  const line = taskLine(9, 5, 100, 100, `curl -o m.bin -H "Authorization: Bearer ${fake}" https://x/y`);
  const { tasks } = bg.parseScan(line);
  assert.ok(!tasks[0].command.includes(fake), '密钥没被脱敏');
  assert.match(tasks[0].command, /\*\*\*/);
});

test('读不到 /proc 的任务标成 -1,和真的 0 字节区分开', () => {
  const { tasks } = bg.parseScan(taskLine(7, 10, -1, -1, 'wget https://x/big.bin'));
  assert.equal(tasks[0].writeBytes, -1);
});

test('非法行被跳过,不炸解析', () => {
  const r = bg.parseScan('乱七八糟\nTASK\n\n' + taskLine(0, 1, 1, 1, 'wget x') + '\n' + taskLine(5, 1, 1, 1, 'wget y'));
  assert.equal(r.tasks.length, 1);   // pid=0 是非法的
  assert.equal(r.tasks[0].pid, 5);
});

/* ------------------------------------------------------------ 分类 */

test('认得出常见的下载类任务', () => {
  const cases = [
    ['docker pull nginx:latest', 'docker-pull'],
    ['/usr/bin/wget -c https://x/model.safetensors', 'wget'],
    ['curl -O https://x/a.tar.gz', 'curl'],
    ['git clone https://github.com/a/b', 'git-clone'],
    ['pip install torch', 'pip'],
    ['npm install', 'npm'],
    ['apt-get install -y docker.io', 'apt'],
    ['ollama pull qwen2.5:7b', 'ollama'],
    ['rsync -av a/ b/', 'rsync']
  ];
  for (const [cmd, kind] of cases) assert.equal(bg.classifyKind(cmd), kind, cmd);
});

test('curl 不带输出参数不算下载任务', () => {
  // 探活用的 curl 满天飞,全列出来面板就没法看了
  assert.equal(bg.classifyKind('curl -sv https://harbor.example.com/v2/'), 'other');
});

test('标题抽出最能认出它的那一段', () => {
  const t = { kind: 'docker-pull', label: '拉取镜像', command: 'docker pull swr.cn/ascendhub/vllm-ascend:v0.10.0rc1' };
  assert.match(bg.taskTitle(t), /vllm-ascend:v0\.10\.0rc1/);
  // 超长的截断,但保留尾部 —— 镜像名的信息量在后面(仓库/名字:tag)
  const long = { kind: 'docker-pull', label: '拉取镜像', command: `docker pull ${'a'.repeat(200)}/img:tag` };
  const title = bg.taskTitle(long);
  assert.ok(title.length < 90);
  assert.match(title, /img:tag$/);
});

/* ------------------------------------------------------------ 进度与停滞 */

const scanOf = (tasks, daemons = {}) => ({ tasks, daemons, disks: [] });
const t = (over) => ({ pid: 1, elapsedSec: 60, writeBytes: 0, readChars: 0, command: 'wget https://x/a', kind: 'wget', label: '下载文件', ...over });

test('第一次采样不报速率,也不报停滞', () => {
  // 没有基准就报 0 B/s,会被直接读成"卡住了"
  const r = bg.mergeTasks([], scanOf([t({ writeBytes: 1000 })]), 1000);
  assert.equal(r[0].bytesPerSec, null);
  assert.equal(r[0].stalled, false);
  assert.equal(r[0].progress, 'measured');
});

test('两次采样之间算出速率', () => {
  const a = bg.mergeTasks([], scanOf([t({ writeBytes: 0 })]), 0);
  const b = bg.mergeTasks(a, scanOf([t({ writeBytes: 10 * 1024 * 1024 })]), 10000);
  assert.equal(b[0].bytesPerSec, 1024 * 1024);   // 10 MB / 10 s
});

test('字节数长时间不动才判停滞', () => {
  let s = bg.mergeTasks([], scanOf([t({ writeBytes: 500 })]), 0);
  s = bg.mergeTasks(s, scanOf([t({ writeBytes: 500 })]), 30000);
  assert.equal(s[0].stalled, false, '30 秒不动还不能判死,慢速下载也是下载');
  s = bg.mergeTasks(s, scanOf([t({ writeBytes: 500 })]), 95000);
  assert.equal(s[0].stalled, true);
});

test('只要动过就重置停滞计时', () => {
  let s = bg.mergeTasks([], scanOf([t({ writeBytes: 0 })]), 0);
  s = bg.mergeTasks(s, scanOf([t({ writeBytes: 0 })]), 80000);
  s = bg.mergeTasks(s, scanOf([t({ writeBytes: 1 })]), 85000);   // 只动了 1 字节
  assert.equal(s[0].stalled, false);
  s = bg.mergeTasks(s, scanOf([t({ writeBytes: 1 })]), 120000);
  assert.equal(s[0].stalled, false, '距上次活动才 35 秒');
});

test('读不到字节数的任务永远不会被标成停滞', () => {
  /* 这是本模块最重要的一条。把"我没量到"显示成"它卡住了",
     会让人去排查一个根本不存在的故障 —— 比什么都不显示更糟。 */
  let s = bg.mergeTasks([], scanOf([t({ writeBytes: -1 })]), 0);
  s = bg.mergeTasks(s, scanOf([t({ writeBytes: -1 })]), 600000);
  assert.equal(s[0].progress, 'unknown');
  assert.equal(s[0].stalled, false);
  assert.equal(s[0].bytesPerSec, null);
});

test('docker pull 的进度按 dockerd 的写入量算', () => {
  /* docker pull 的下载是守护进程做的,客户端几乎不写盘。
     只看客户端会得出"一直 0 B/s"从而把正常拉取误报成卡住。 */
  const dt = t({ pid: 300, kind: 'docker-pull', command: 'docker pull nginx', writeBytes: 0 });
  let s = bg.mergeTasks([], scanOf([dt], { dockerd: 0 }), 0);
  s = bg.mergeTasks(s, scanOf([dt], { dockerd: 50 * 1024 * 1024 }), 10000);
  assert.equal(s[0].bytesSource, 'daemon');
  assert.equal(s[0].bytesPerSec, 5 * 1024 * 1024);
  assert.equal(s[0].stalled, false);
});

test('同时有多个 docker pull 时不猜,退回进程自身的数字', () => {
  // 守护进程的写入量无法拆分到某一个拉取上,平摊出来的是假数字
  const a = t({ pid: 1, kind: 'docker-pull', command: 'docker pull a', writeBytes: -1 });
  const b = t({ pid: 2, kind: 'docker-pull', command: 'docker pull b', writeBytes: -1 });
  const s = bg.mergeTasks([], scanOf([a, b], { dockerd: 999 }), 0);
  assert.equal(s[0].bytesSource, 'process');
  assert.equal(s[0].progress, 'unknown');
});

test('任务消失后不再出现在列表里', () => {
  const s1 = bg.mergeTasks([], scanOf([t({ pid: 1 }), t({ pid: 2 })]), 0);
  assert.equal(s1.length, 2);
  const s2 = bg.mergeTasks(s1, scanOf([t({ pid: 2 })]), 5000);
  assert.equal(s2.length, 1);
  assert.equal(s2[0].pid, 2);
});

/* ------------------------------------------------------------ 停止 */

test('停止用 SIGTERM 而不是 -9', () => {
  // docker pull 收到 TERM 会清掉下了一半的层;-9 会在磁盘上留下垃圾
  const cmd = bg.buildStopCommand(4321);
  assert.match(cmd, /kill -TERM 4321/);
  assert.ok(!/-9|SIGKILL/.test(cmd));
});

test('拒绝非法 PID 和 init', () => {
  for (const bad of ['1; rm -rf /', -1, 0, 'abc', null, undefined, 1]) {
    assert.throws(() => bg.buildStopCommand(bad), `PID ${bad} 应该被拒绝`);
  }
});

/* ------------------------------------------------------------ 磁盘 */

test('磁盘快满时给出预警', () => {
  // 大镜像/权重把盘写满是这些任务最常见的死法,报错常埋在几百行输出里
  const w = bg.diskWarning([
    { mount: '/', availBytes: 500 * 1024 ** 3, usePercent: 20 },
    { mount: '/var/lib/docker', availBytes: 800 * 1024 ** 2, usePercent: 99 }
  ]);
  assert.equal(w.mount, '/var/lib/docker');
  assert.match(w.message, /只剩/);
  assert.equal(bg.diskWarning([{ mount: '/', availBytes: 900 * 1024 ** 3, usePercent: 5 }]), null);
});

/* ------------------------------------------------------------ 扫描命令 */

test('扫描命令是只读的', () => {
  const cmd = bg.buildScanCommand();
  // 先摘掉 2>/dev/null 这类丢弃重定向,再查真正的写操作
  const bare = cmd.replace(/2?>\s*\/dev\/null/g, '');
  /* 重定向要认真正的写入形式(`> 路径`),不能只看 `>` ——
     awk 里的 `NR>1` 是比较,不是重定向。 */
  assert.ok(!/\brm\b|\bkill\b|\bmv\b|\bdd\b|\btee\b|(^|\s)>>?\s*['"$/A-Za-z]/.test(bare),
    `扫描命令里出现了写操作:${bare}`);
  assert.match(cmd, /ps -eo/);
  assert.match(cmd, /\/proc\/\$p\/io/);
});

test('扫描顺带读 dockerd 的 io 和磁盘余量', () => {
  const cmd = bg.buildScanCommand();
  assert.match(cmd, /dockerd/);
  assert.match(cmd, /df -P/);
});

test('扫描把 grep 自己排除掉', () => {
  // 否则匹配用的那条命令自己会作为任务出现,每次都多一条幽灵记录
  assert.match(bg.buildScanCommand(), /\*grep\*\) continue/);
});

/* ------------------------------------------------------------ 接线 */

test('轮询分快慢两档,关面板只降档不停掉', () => {
  /* 常驻 6 秒一次会把远端 sshd 的 MaxSessions 悄悄吃光,
     表现是"新对话打不开";但完全停掉,顶栏角标就永远不亮,
     而人恰恰是想不起来看的时候才需要它。 */
  const main = read('electron/main.js');
  assert.match(main, /BG_SLOW_MS = 30000/);
  assert.match(main, /BG_FAST_MS = 6000/);
  const drawer = read('src/components/BgTasksDrawer.jsx');
  // 现在还带上了作用域参数(当前主机/对话),只校验快慢两档仍在
  assert.match(drawer, /window\.api\.bg\.start\(\{ fast: true[,}]/);
  assert.match(drawer, /window\.api\.bg\.start\(\{ fast: false[,}]/);
});

test('每台主机同时只允许一次扫描在飞', () => {
  // 网络慢时上一次没回来就发下一次,会越积越多,最后同样是通道耗尽
  assert.match(read('electron/main.js'), /if \(st\.scanning\) return st/);
});

test('扫描失败时保留上一次结果而不是清空', () => {
  // 主机抖一下就把面板清空,会让人以为任务都跑完了
  const main = read('electron/main.js');
  assert.match(main, /扫不动不清空已有列表/);
});

test('停止任务需要二次确认,并把完整命令摆出来', () => {
  /* 任务是靠进程特征匹配出来的,理论上可能认错。
     确认框必须显示将要杀掉的到底是什么。 */
  const drawer = read('src/components/BgTasksDrawer.jsx');
  assert.match(drawer, /confirming/);
  assert.match(drawer, /确认停止/);
  assert.match(drawer, /<pre className="bg-cmd">\{task\.command\}<\/pre>/);
});

test('没有任何值得看的东西时角标整个隐藏', () => {
  /* 常驻一个 0 等于噪音。但"没有在跑"不等于"没事" ——
     刚失败或已停滞的任务同样要让人看见,否则失败会静悄悄地过去。 */
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /if \(!snap\.running && !bad\) return null/);
  assert.match(ui, /const bad = \(snap\.stalled \|\| 0\) \+ \(snap\.failed \|\| 0\)/);
});

/* --------------------------------------------- 服务在拉镜像(截图里的场景) */

const unitLine = (u, st, sub, since, log) => ['UNIT', u, st, sub, since, log].join(F);

test('docker run 也算一类任务 —— 它会隐式拉镜像', () => {
  /* 本地没有镜像时 `docker run` 会自己去拉,而这时整台机器上
     一个 docker pull 进程都没有,拉取完全发生在守护进程里。
     不认它的话,最该被看见的那段时间恰好什么都看不见。 */
  assert.equal(bg.classifyKind('docker run --rm --name qwen7b-vllm vllm-ascend:v0.23'), 'docker-run');
  assert.equal(bg.classifyKind('docker compose up -d'), 'docker-run');
  assert.match(bg.buildScanCommand(), /\*"docker "\*run\*/);
});

test('扫描会查 systemd:activating 的单元 + 名字像下载的 running 单元', () => {
  const cmd = bg.buildScanCommand();
  assert.match(cmd, /--state=activating/);
  assert.match(cmd, /pull\|download\|image\|fetch\|install\|vllm\|model\|sync/);
  // 限量:给每个 running 单元都跑一次 systemctl show 会很慢
  assert.match(cmd, /head -8/);
  // 没有 systemd 的机器上必须安静跳过,而不是报一堆 command not found
  assert.match(cmd, /command -v systemctl/);
});

test('解析 systemd 单元', () => {
  const r = bg.parseScan(unitLine('qwen7b-vllm.service', 'activating', 'start', '123', 'Pulling fs layer'));
  assert.equal(r.units.length, 1);
  assert.equal(r.units[0].unit, 'qwen7b-vllm.service');
  assert.equal(r.units[0].activeState, 'activating');
  assert.equal(r.units[0].lastLog, 'Pulling fs layer');
});

test('非 .service 的行被忽略', () => {
  assert.equal(bg.parseScan(unitLine('foo.mount', 'active', 'mounted', '1', 'x')).units.length, 0);
});

test('单元日志同样脱敏', () => {
  // 拉私有仓库失败时,报错里常常带着 Authorization 头
  const fake = 'sk-' + 'c'.repeat(40);
  const r = bg.parseScan(unitLine('a.service', 'failed', 'failed', '1', `denied: Bearer ${fake}`));
  assert.ok(!r.units[0].lastLog.includes(fake));
});

test('activating 的单元报成进行中,并说清它卡在哪一步', () => {
  /* 截图里的场景:服务停在 activating,对话里只留一句"正在下载"。
     最后一行日志是唯一能说明"到哪一步了"的东西。 */
  const r = bg.parseScan(unitLine('qwen7b-vllm.service', 'activating', 'start', '9', 'Pulling from ascendhub: 2.1GB/8.4GB'));
  const t = bg.unitTask(r.units[0], { now: 0 });
  assert.equal(t.state, 'running');
  assert.equal(t.kind, 'systemd');
  assert.match(t.note, /activating/);
  assert.match(t.lastLog, /2\.1GB\/8\.4GB/);
});

test('failed 的单元报成失败', () => {
  const r = bg.parseScan(unitLine('qwen7b-vllm.service', 'failed', 'failed', '9', 'exited, code=139'));
  assert.equal(bg.unitTask(r.units[0], { now: 0 }).state, 'failed');
});

test('单元永远不会被判停滞', () => {
  /* 服务可能就是启动慢,而我们手上没有任何字节数能证明它没在动 ——
     凭时长判死就是猜,而误报"卡住了"比不报更糟。 */
  const r = bg.parseScan(unitLine('a.service', 'activating', 'start', '1', 'x'));
  const t = bg.unitTask(r.units[0], { now: 999999999 });
  assert.notEqual(t.state, 'stalled');
  assert.ok(!bg.STALL_KINDS.has('systemd'));
});

test('systemd 单元量不到时的文案不能照抄进程那套', () => {
  /* 服务根本没有 pid,跟人说"读不到 /proc/<pid>/io"等于答非所问。
     现在服务也会显示已下载量(量目标目录),量不到时才走这个分支。 */
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /task\.kind === 'systemd'/);
  assert.match(ui, /未找到下载目录/);
});

/* -------------------------------------- 没被认出来的长跑进程也要能看到 */

test('跑够久但没匹配上已知类型的进程也会被捞回来', () => {
  /* KINDS 是一份**人工列举**,一定会漏 —— 智能体完全可能起一个我没想到的
     长命令。而漏掉的那个恰恰最需要被看见:你连它叫什么都不知道。 */
  const r = bg.parseScan(taskLine(88, 900, 10, 0, '/opt/x/weird-job --forever', 1));
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].longRunning, true);
  assert.equal(r.tasks[0].kind, 'other');
});

test('认得出的任务不带 long 标记', () => {
  const r = bg.parseScan(taskLine(1, 10, 0, 0, 'docker pull nginx', 0));
  assert.equal(r.tasks[0].longRunning, false);
});

test('long 标记会一路传到面板的任务对象上', () => {
  const s = bg.mergeTasks([], scanOf([t({ longRunning: true })]), 0);
  assert.equal(s[0].longRunning, true);
});

test('只有跑够 5 分钟的才纳入,短命进程不算', () => {
  // 短命进程每轮扫描都在变,列出来是一片闪烁的噪音,本来也不需要盯
  assert.match(bg.buildScanCommand(), /-ge 300/);
});

test('常驻守护进程被排除', () => {
  // 不排除的话,sshd/systemd 这些永远在跑的会把真正的任务淹没
  const cmd = bg.buildScanCommand();
  for (const d of ['sshd', 'systemd', 'agetty', 'rsyslog', 'containerd-shim']) {
    assert.ok(cmd.includes(`*${d}*`), `没排除 ${d}`);
  }
});

test('这一类默认不显示,但给一个开关', () => {
  /* 默认摊开会淹掉真正的任务;完全不收又会漏。
     所以:照收,默认藏,需要时一键看全。 */
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /useState\(false\)/);
  assert.match(ui, /showOther \|\| !t\.longRunning/);
  assert.match(ui, /其他长跑进程/);
});

/* ------------------------------------------------ 真的能看到下载进度 */

test('docker run / build 的字节数也按 dockerd 算', () => {
  /* 截图里那条「启动容器 docker run」跑了 15 分钟一直显示 0 B ——
     因为之前只认 docker-pull。可 docker run 在本地没镜像时会隐式拉取,
     客户端进程本来就不写盘,活是 dockerd 干的。 */
  const mk = (kind) => t({ pid: 9, kind, command: 'docker run --rm x', writeBytes: 0 });
  for (const kind of ['docker-run', 'docker-build', 'docker-pull']) {
    let s = bg.mergeTasks([], scanOf([mk(kind)], { dockerd: 0 }), 0);
    s = bg.mergeTasks(s, scanOf([mk(kind)], { dockerd: 200 * 1024 * 1024 }), 10000);
    assert.equal(s[0].bytesSource, 'daemon', `${kind} 应按 dockerd 计`);
    assert.equal(s[0].bytesPerSec, 20 * 1024 * 1024);
  }
  assert.ok(bg.DOCKER_KINDS.has('docker-run'));
});

test('从日志里解析出真实的已下载/总量', () => {
  /* 这是**唯一**能拿到真实总量的途径。字节数只能说"下了多少",
     而人想知道的是"还有多少"—— 截图里那句「还有多少没下载」问的就是它。 */
  const r = bg.parseSizeProgress('Downloading [====>    ]  1.2GB/4.5GB');
  assert.ok(Math.abs(r.transferred - 1.2 * 1024 ** 3) < 1);
  assert.ok(Math.abs(r.total - 4.5 * 1024 ** 3) < 1);
});

test('一行里有多层时取最后一处 —— 越靠后越新', () => {
  const r = bg.parseSizeProgress('a1: 512MB/2GB | b2: 1.5GB/3GB');
  assert.equal(r.total, 3 * 1024 ** 3);
});

test('解析不到就返回 null,绝不拿别的数字凑', () => {
  assert.equal(bg.parseSizeProgress('Pulling fs layer'), null);
  assert.equal(bg.parseSizeProgress(''), null);
  assert.equal(bg.parseSizeProgress(null), null);
});

test('已下载大于总量时判为解析错误', () => {
  /* 多半是把两个不相干的数字配成了一对(比如内存占用)。
     宁可不显示,也不要给一个 300% 的进度条。 */
  assert.equal(bg.parseSizeProgress('mem 8GB/4GB'), null);
});

test('服务任务带上解析出的进度和一句说明', () => {
  const line = ['UNIT', 'a.service', 'activating', 'start', '1',
    'Downloading 2.1GB/8.4GB'].join(F);
  const u = bg.parseScan(line).units[0];
  const task = bg.unitTask(u, { now: 0 });
  assert.ok(task.progress.total > task.progress.transferred);
  // docker 按层刷进度,不写明的话进度条走到 100% 又跳回去会像出错了
  assert.match(task.progressNote, /按层/);
});

test('日志取最后 6 行而不是 1 行', () => {
  /* 一次拉取会把每一层刷成一行,只看最后一行常常正好落在
     "Verifying"这类没有数字的行上,而带进度的那条就在上面一两行。 */
  assert.match(bg.buildScanCommand(), /journalctl -u "\$u" -n 6/);
});

test('进度条标出这是什么的百分比', () => {
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /<ProgressBar p=\{task\.progress \|\| task\.progressFromLog\} note=\{task\.progressNote\}/);
  // 光有百分比不够,得同时看到"下了多少 / 一共多少"
  assert.match(ui, /fmtBytes\(p\.transferred\)\} \/ \{fmtBytes\(p\.total\)/);
});

/* ------------------------------------------- 写盘的是子进程,不是它本人 */

test('按进程树求和,而不是只看被匹配到的那个 pid', () => {
  /* git clone 拉大仓库时真正干活的是 git-remote-https / git-lfs;
     截图里那个用 git-lfs 拉权重的服务就是这样,父进程 io 恒为 0。
     只看父进程会得出"一直 0 B"—— 而那和"真的卡住了"长得一模一样。 */
  const scan = {
    ppids: new Map([[100, 1], [101, 100], [102, 101], [999, 1]]),
    io: new Map([[100, 0], [101, 50e6], [102, 150e6], [999, 7e9]])
  };
  assert.equal(bg.subtreeWriteBytes(100, scan), 200e6, '应含子孙,且不含无关的 999');
});

test('一个都读不到时返回 -1,不是 0', () => {
  // "测不到"和"写了 0 字节"绝不能混:前者不该被判停滞,后者该
  assert.equal(bg.subtreeWriteBytes(5, { ppids: new Map(), io: new Map() }), -1);
});

test('进程表有环也能返回,不死循环', () => {
  /* ppid 和 io 是两次采样拼起来的,不能假设它一定是棵树。
     没有上限的话这里会死循环 —— 表现是整个扫描永远不返回。 */
  const cyc = { ppids: new Map([[1, 2], [2, 1]]), io: new Map([[1, 5], [2, 5]]) };
  assert.equal(bg.subtreeWriteBytes(1, cyc), 10);
});

test('mergeTasks 用进程树的数字,并标明来源', () => {
  const gt = t({ pid: 100, kind: 'git-clone', command: 'git clone https://x/y', writeBytes: 0 });
  const mk = (childBytes) => ({
    tasks: [gt], daemons: {}, disks: [],
    ppids: new Map([[100, 1], [101, 100]]),
    io: new Map([[100, 0], [101, childBytes]])
  });
  let s = bg.mergeTasks([], mk(0), 0);
  s = bg.mergeTasks(s, mk(100 * 1024 * 1024), 10000);
  assert.equal(s[0].bytesSource, 'tree');
  assert.equal(s[0].bytesPerSec, 10 * 1024 * 1024);
});

test('扫描一次性读回全机的 ppid 和 write_bytes', () => {
  // 逐个起子 shell 去读 /proc/<pid>/io 会慢到不可用
  const cmd = bg.buildScanCommand();
  assert.match(cmd, /PPID/);
  assert.match(cmd, /\/proc\/\[0-9\]\*\/io/);
});

test('git clone 的标题不再是没有信息量的数字', () => {
  /* 之前只跳过 `-开头` 的词,于是 `--depth 1` 的那个 `1` 被当成了目标,
     界面上出现「克隆仓库 1」。 */
  const mk = (command) => bg.taskTitle({ kind: 'git-clone', label: '克隆仓库', command });
  assert.match(mk('git -c x=y clone --depth 1 https://hf.co/Qwen/Q3 /home/models/q'), /hf\.co\/Qwen\/Q3/);
  assert.match(mk('git clone --branch main git@github.com:a/b.git'), /github\.com:a\/b\.git/);
  // 本地路径克隆:退到最后一个非选项、非纯数字的参数
  assert.match(mk('git clone --depth 1 /srv/mirror/repo /home/x'), /\/home\/x/);
});

/* ------------------------------------------- 对话里说的那个数,面板也要有 */

test('服务的已运行时长按单调时钟算,不是写死 0', () => {
  /* 截图里一个下了半小时的服务显示「已运行 0 秒」—— 比不显示更糟,
     因为它看起来像刚起来、一切正常。
     systemd 给的是开机以来的微秒数,得减去 /proc/uptime 才是"跑了多久"。 */
  const out = [
    ['UNIT', 'a.service', 'activating', 'start', '120000000', 'Fetching...'].join(F),
    ['UPTIME', '3600.5'].join(F)
  ].join('\n');
  const r = bg.parseScan(out);
  assert.equal(r.uptimeSec, 3600.5);
  const task = bg.unitTask(r.units[0], { now: 0, uptimeSec: r.uptimeSec });
  assert.ok(Math.abs(task.elapsedMs - 3480500) < 1500, `实际 ${task.elapsedMs}`);
});

test('拿不到启动时刻时不瞎算', () => {
  const u = { unit: 'a.service', activeState: 'running', subState: 'running', startedMonotonicUs: 0, lastLog: '' };
  assert.equal(bg.unitTask(u, { now: 0, uptimeSec: 999 }).elapsedMs, 0);
});

test('从命令里找出下载目标目录', () => {
  /* 对话里智能体报的「当前约下载 2GB」就是 du 出来的。
     面板也量同一个目录,才不会出现"对话说 2GB、面板说 0 B"的自相矛盾。 */
  assert.equal(bg.watchPathFor({ kind: 'git-clone', command: 'git clone --depth 1 https://h/x /home/models/Q' }), '/home/models/Q');
  assert.equal(bg.watchPathFor({ kind: 'wget', command: 'wget -c -P /home/models/x https://a/b' }), '/home/models/x');
  assert.equal(bg.watchPathFor({ kind: 'hf', command: 'huggingface-cli download X --local-dir /data/m' }), '/data/m');
});

test('服务的目标目录从日志里找', () => {
  // 截图里那条日志就写着「weights to /home/models.」
  assert.equal(
    bg.watchPathForUnit({ lastLog: 'Started Download and checkout Qwen3.6 weights to /home/models.|15 objects found' }),
    '/home/models'
  );
});

test('绝不去 du 系统目录', () => {
  /* 这里防的**不是注入**(路径会被 shellQuote),而是卡死:
     du -sb / 在几 TB 的机器上要跑几分钟,而扫描是 12 秒超时的 ——
     结果是每一轮都超时,面板彻底不动。 */
  for (const bad of ['/', '/usr', '/etc/', '/proc', '/dev', '/var/lib/docker', 'relative/path', '']) {
    assert.equal(bg.safeWatchPath(bad), '', `${bad} 不该被 du`);
  }
  assert.equal(bg.safeWatchPath('/home/models/Q'), '/home/models/Q');
});

test('要量的目录有数量上限', () => {
  // du 再快也架不住一次量十几个
  const tasks = Array.from({ length: 10 }, (_, i) =>
    ({ kind: 'wget', command: `wget -P /home/d${i} https://a/b` }));
  assert.ok(bg.collectWatchPaths({ tasks, units: [] }).length <= 4);
});

test('目录大小优先于 /proc 的写入量', () => {
  /* 它和智能体报的是同一个数。否则会出现"对话说已下 2GB、面板说 0 B",
     那比没有数字更让人不信任面板。 */
  const gt = t({ pid: 9, kind: 'git-clone', command: 'git clone https://h/x /home/models/Q', writeBytes: 0 });
  const mk = (sz) => ({
    tasks: [gt], daemons: {}, disks: [], ppids: new Map(), io: new Map(),
    pathSizes: new Map([['/home/models/Q', sz]])
  });
  let s = bg.mergeTasks([], mk(2.0e9), 0);
  s = bg.mergeTasks(s, mk(2.3e9), 10000);
  assert.equal(s[0].bytesSource, 'dir');
  assert.equal(s[0].bytes, 2.3e9);
  assert.equal(s[0].watchPath, '/home/models/Q');
});

test('路径被 shell 引用', () => {
  const cmd = bg.buildScanCommand({ watchPaths: ["/home/it's"] });
  assert.match(cmd, /du -sb '\/home\/it'/);
});

test('界面标出数字的来源,并解释为什么没有百分比', () => {
  const ui = read('src/components/BgTasksDrawer.jsx');
  for (const src of ['daemon', 'tree', 'dir']) {
    assert.ok(ui.includes(`task.bytesSource === '${src}'`), `没标出 ${src} 来源`);
  }
  // 有字节数却没进度条时,不说明白会被当成"进度条坏了"
  assert.match(ui, /没有百分比:这个下载器不报总量/);
  // 服务卡片之前被 kind !== 'systemd' 排除,压根不显示字节数
  assert.ok(!ui.includes("task.kind !== 'systemd' && (task.progressMode"));
});

/* ------------------------------- 服务日志里的分层进度要接到进程任务上 */

test('顺带读出进程属于哪个 systemd 单元', () => {
  /* 截图里那份 146.7/323.8 MB 的分层进度只存在于 ragflow-bootstrap.service
     的 journal 里,而那个单元名不含 pull/download —— 按名字过滤永远扫不到。
     进程的 cgroup 路径里就写着它属于哪个单元,顺着这条线才能找到日志。 */
  assert.match(bg.buildScanCommand(), /\/proc\/\$p\/cgroup/);
  const r = bg.parseScan(taskLine(9, 60, 0, 0, 'docker run x', 0, 1, 'ragflow-bootstrap.service'));
  assert.equal(r.tasks[0].unit, 'ragflow-bootstrap.service');
});

test('下一轮把这些单元也纳入 journal 抓取', () => {
  const units = bg.collectUnits({ tasks: [{ unit: 'a.service' }, { unit: 'a.service' }, { unit: '' }] });
  assert.deepEqual(units, ['a.service']);
  const cmd = bg.buildScanCommand({ extraUnits: ['ragflow-bootstrap.service'] });
  assert.match(cmd, /'ragflow-bootstrap\.service'/);
});

test('把所属单元的日志进度挂到进程任务上', () => {
  // 智能体在对话里报的那三行百分比就是从这里读的,面板没理由拿不到
  const t9 = t({ pid: 9, kind: 'docker-run', unit: 'ragflow-bootstrap.service', command: 'docker run x' });
  const scan = {
    tasks: [t9], daemons: {}, disks: [], ppids: new Map(), io: new Map(), pathSizes: new Map(),
    units: [{ unit: 'ragflow-bootstrap.service', lastLog: 'a1 Downloading 146.7MB/323.8MB' }]
  };
  const s = bg.mergeTasks([], scan, 0);
  assert.ok(s[0].progressFromLog.total > 0);
  const pct = Math.round(s[0].progressFromLog.transferred / s[0].progressFromLog.total * 100);
  assert.equal(pct, 45);
  assert.match(s[0].progressNote, /ragflow-bootstrap\.service/);
});

test('docker 归不到守护进程头上时报"测不到",不报 0 B', () => {
  /* docker 客户端进程本来就不写盘。同时有好几个 docker 命令在跑时
     归属不了,它自己那个 0 毫无意义 —— 显示「已写入 0 B · 0 B/s」
     会被读成"卡住了",而它其实下得好好的。 */
  const a = t({ pid: 1, kind: 'docker-run', command: 'docker run a', writeBytes: 0 });
  const b = t({ pid: 2, kind: 'docker-pull', command: 'docker pull b', writeBytes: 0 });
  const s = bg.mergeTasks([], { tasks: [a, b], daemons: { dockerd: 5e9 }, disks: [], ppids: new Map(), io: new Map() }, 0);
  assert.equal(s[0].progress, 'unknown', '不该显示 0 B');
  assert.equal(s[0].bytes, null);
});

test('界面优先用日志解析出来的进度画条', () => {
  const ui = read('src/components/BgTasksDrawer.jsx');
  assert.match(ui, /<ProgressBar p=\{task\.progress \|\| task\.progressFromLog\}/);
  // 有日志进度时就不该再说"没有百分比"
  assert.match(ui, /!task\.progressFromLog && \(/);
});

/* --------------------------- 面板整个空掉的那次:进程根本没被扫到 */

/** 把扫描命令里那段 case 抠出来单独跑 —— 这段是纯 shell,只能用真 bash 验 */
function classifyInShell(args, unit = '') {
  const { execFileSync } = require('child_process');
  const L = bg.buildScanCommand().split('\n');
  const s = L.findIndex((l) => l.includes('u=$(sed'));
  const e = L.indexOf('  esac');
  const script = ['for a in "$@"; do', 'e=999; long=; u="$U"',
    ...L.slice(s + 1, e + 1), 'echo "$long|$a"', 'done'].join('\n');
  return execFileSync('bash', ['-c', script, '_', ...args], { env: { ...process.env, U: unit } })
    .toString().trim().split('\n').filter(Boolean);
}

test('服务的包装脚本必须被扫到 —— 它是整次下载的门面', () => {
  /* 之前排除规则写的是 *bash*,把 `/bin/bash /usr/local/bin/xxx-bootstrap.sh`
     整个吃掉了。而进度全在它的 journal 里,它一被丢,面板就整个空了。
     这段逻辑是纯 shell,只有真跑一遍才验得了 —— 靠读正则推理正是上次出错的原因。 */
  const out = classifyInShell(['/bin/bash /usr/local/bin/ragflow-bootstrap.sh'], 'ragflow-bootstrap.service');
  assert.equal(out.length, 1, '被整条丢弃了');
  assert.ok(out[0].startsWith('0|'), '应算正经任务而不是塞进隐藏桶');
});

test('docker compose pull 也要放行', () => {
  // 之前只匹配 *compose*up*(要求有 up),而截图里正在下的恰恰是 pull
  const out = classifyInShell(['docker-compose -p ragflow -f docker-compose.yml pull'], 'x.service');
  assert.ok(out[0].startsWith('0|'));
  assert.equal(bg.classifyKind('docker compose pull'), 'docker-pull');
});

test('git-lfs 也要放行 —— 拉权重时干活的就是它', () => {
  const out = classifyInShell(['/usr/bin/git-lfs filter-process'], 'dl.service');
  assert.ok(out[0].startsWith('0|'));
});

test('交互式登录 shell 仍然排除', () => {
  // 放宽 bash 规则不能把 ssh 会话本身也列进来
  assert.equal(classifyInShell(['-bash', 'bash', '/bin/bash', 'sshd: root@pts/0']).length, 0);
});

test('不属于服务的脚本仍进隐藏桶', () => {
  /* "属于某个 systemd 服务"才是"有人特意让它在后台跑"的证据。
     否则一台机器上随便一个跑了很久的脚本都会挤到前面。 */
  const out = classifyInShell(['/bin/bash /home/me/random.sh'], '');
  assert.ok(out[0].startsWith('1|'));
});

test('服务里的进程只要跑够一分钟就算任务,不用等五分钟', () => {
  const cmd = bg.buildScanCommand();
  assert.match(cmd, /\[ -n "\$\{u:-\}" \] && \[ "\$\{e:-0\}" -ge 60 \]/);
});
