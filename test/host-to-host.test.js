const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h2h = require('../electron/ssh/hostToHost');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 远程 → 远程:优先让源主机直连目标(数据不过本机),不行再经本机中转。
 * 这些命令写错的表现是「卡住」而不是报错,最难查,所以逐条钉住。 */

test('BatchMode 是硬性要求 —— 没它 scp 会卡在密码提示上等一个不会来的输入', () => {
  const probe = h2h.buildProbeCommand({ user: 'root', host: '10.1.6.230', port: 22 });
  const copy = h2h.buildDirectCopyCommand({
    srcPath: '/a', user: 'root', host: '10.1.6.230', port: 22, destPath: '/b/a' });
  for (const cmd of [probe, copy]) {
    assert.match(cmd, /-o BatchMode=yes/, `缺 BatchMode:${cmd}`);
    assert.match(cmd, /-o ConnectTimeout=\d+/);
  }
});

test('host key 策略:首次自动接受,但变更时仍然拒绝', () => {
  // StrictHostKeyChecking=no 会连"key 被换了"都照连不误,那是中间人的入口
  assert.match(h2h.sshOpts(), /StrictHostKeyChecking=accept-new/);
  assert.ok(!/StrictHostKeyChecking=no/.test(h2h.sshOpts()));
});

test('探测只跑 true,不产生任何副作用', () => {
  const cmd = h2h.buildProbeCommand({ user: 'root', host: 'h', port: 22 });
  assert.match(cmd, /root@h true/);
  assert.match(cmd, /__H2H_OK__/);
});

test('探测结果按「该怎么办」分类', () => {
  assert.equal(h2h.parseProbe('__H2H_OK__').direct, true);
  assert.equal(h2h.parseProbe('root@h: Permission denied (publickey).').reason, 'auth');
  assert.equal(h2h.parseProbe('Host key verification failed.').reason, 'hostkey');
  assert.equal(h2h.parseProbe('ssh: connect to host h port 22: Connection timed out').reason, 'network');
});

test('路径与用户名会进命令行,注入一律挡掉', () => {
  assert.throws(() => h2h.buildProbeCommand({ user: 'a;rm -rf /', host: 'h', port: 22 }), /用户名不合法/);
  assert.throws(() => h2h.buildProbeCommand({ user: 'root', host: 'h$(id)', port: 22 }), /主机地址不合法/);
  assert.throws(() => h2h.safePort('22; rm -rf /'), /端口不合法/);
  assert.throws(() => h2h.safePort(0), /端口不合法/);
  // 带空格的路径要被正确引用,而不是被拒绝
  const cmd = h2h.buildDirectCopyCommand({
    srcPath: '/root/my code', user: 'root', host: 'h', port: 22, destPath: '/data/my code' });
  assert.match(cmd, /'\/root\/my code'/);
});

test('直连前先建目标父目录 —— scp 不会替你创建', () => {
  const cmd = h2h.buildDirectCopyCommand({
    srcPath: '/a/b.txt', user: 'root', host: 'h', port: 22, destPath: '/data/deep/b.txt' });
  assert.match(cmd, /mkdir -p /);
  assert.match(cmd, /'\/data\/deep'/);
});

test('中转的两段进度合成一条,不会先冲到 100 再跳回 0', () => {
  assert.equal(h2h.relayProgress({ phase: 'download', transferred: 0, total: 100 }).percent, 0);
  assert.equal(h2h.relayProgress({ phase: 'download', transferred: 100, total: 100 }).percent, 50);
  assert.equal(h2h.relayProgress({ phase: 'upload', transferred: 0, total: 100 }).percent, 50);
  assert.equal(h2h.relayProgress({ phase: 'upload', transferred: 100, total: 100 }).percent, 100);
  // total 为 0 时不能算出 NaN
  assert.equal(h2h.relayProgress({ phase: 'download', transferred: 0, total: 0 }).percent, 0);
});

test('中转临时路径带传输 id,两个任务不会撞同名', () => {
  const a = h2h.relayTempPath('/tmp', 't1', 'x.tar');
  const b = h2h.relayTempPath('/tmp', 't2', 'x.tar');
  assert.notEqual(a, b);
  // 文件名里的路径分隔符要清掉,免得写到别处去
  assert.ok(!h2h.relayTempPath('/tmp', 't1', '../../etc/passwd').includes('..' + path.sep + '..'));
});

test('直连探测通过但拷贝失败时如实报错,不悄悄退回中转', () => {
  const main = read('electron/main.js');
  // 静默回退会把真正的问题(比如目标磁盘满)掩盖成"慢"
  assert.match(main, /直连拷贝失败:/);
  assert.match(main, /不要悄悄退回中转把问题掩盖掉/);
});

test('中转的临时文件一定要清 —— 几个大镜像就能把本机磁盘吃满', () => {
  const main = read('electron/main.js');
  const block = main.slice(main.indexOf("ipcMain.handle('fs:copyHostToHost'"));
  assert.match(block, /finally \{[\s\S]{0,200}rm\(path\.dirname\(tmp\), \{ recursive: true, force: true \}\)/);
});

test('上传/下载抽成函数,中转段与 IPC 共用一份实现', () => {
  const main = read('electron/main.js');
  assert.match(main, /async function doUpload\(/);
  assert.match(main, /async function doDownload\(/);
  // 中转段必须复用,不能自己再写一遍目录遍历
  const block = main.slice(main.indexOf("ipcMain.handle('fs:copyHostToHost'"));
  assert.match(block, /await doDownload\(\{/);
  assert.match(block, /await doUpload\(\{/);
});

test('界面:左栏可选主机,并显示走的是直连还是中转', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /pane-host-select/);
  assert.match(ui, /copyHostToHost/);
  // 直连和中转的代价差很多,做完要告诉用户走的哪条
  assert.match(ui, /源主机直连/);
  assert.match(ui, /经本机中转/);
  // 中转是两段,不标出来进度条会看着像出错
  assert.match(ui, /中转 1\/2 下载/);
  assert.match(ui, /中转 2\/2 上传/);
  // 左栏选了远程后,路径分隔符不能再按 Windows 判
  assert.match(ui, /leftIsLocal && local\.path\.includes/);
});

/* 用户问「远程到远程为啥不能直接过去非要中转」——
 * 说明两件事都没做到:传输过程中没告诉他原因,也没给他解决的办法。 */

test('直连原因要在传输过程中就报出去,不能等传完', () => {
  const main = read('electron/main.js');
  // 传 1.8G 时用户正盯着进度条,那时候才最需要知道为什么
  assert.match(main, /report\(\{ phase: 'download', relayReason: probe\.message \|\| probe\.reason, relayCode: probe\.reason \}\)/);
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /直连不可用:\{t\.relayReason\}/);
});

test('生成密钥用 ed25519 且不覆盖已有的', () => {
  const cmd = h2h.buildEnsureKeyCommand();
  assert.match(cmd, /ssh-keygen -t ed25519/);
  /* 重新生成会把这台机器现有的所有免密关系全部作废 —— 这个副作用太大,
     必须先判存在 */
  assert.match(cmd, /\[ -f "\$HOME\/\.ssh\/id_ed25519" \] \|\|/);
  assert.match(cmd, /chmod 700 "\$HOME\/\.ssh"/);
});

test('写 authorized_keys:去重、权限、且只接受真的公钥', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey root@src';
  const cmd = h2h.buildInstallKeyCommand(key);
  assert.match(cmd, /grep -qxF/, '重复追加会让文件越来越长且看不出配没配过');
  /* 权限过宽时 sshd 会直接忽略 authorized_keys,表现为"明明配了还要密码",
     极难查 —— 所以每次都显式 chmod */
  assert.match(cmd, /chmod 600 "\$HOME\/\.ssh\/authorized_keys"/);
  assert.match(cmd, /__KEY_OK__/);

  for (const bad of ['rm -rf /', '', 'not-a-key', 'ssh-ed25519']) {
    assert.throws(() => h2h.buildInstallKeyCommand(bad), /公钥格式不对/, `放过了:${bad}`);
  }
});

test('配置直连是显式动作,不在传输失败时自动做掉', () => {
  const ui = read('src/components/FilePanel.jsx');
  // 给目标主机加一把可免密登录的钥匙,属于真实授权变更
  assert.match(ui, /window\.confirm\(/);
  assert.match(ui, /可免密登录的钥匙/);
  const main = read('electron/main.js');
  assert.match(main, /只在\s*\n?\s*\* 用户明确点击时执行,绝不在传输失败时自动做掉/);
});

test('只有「缺密钥」这一种原因能一键解决,别的不给按钮', () => {
  const ui = read('src/components/FilePanel.jsx');
  // 网络不通、host key 变更都不是加个公钥能解决的
  assert.match(ui, /t\.relayCode === 'auth'/);
  // 本机不参与:本机→远程本来就不走这条路
  assert.match(ui, /t\.fromHostId !== 'local' && t\.toHostId !== 'local'/);
});

test('配完立刻验证一次,不让用户再传一遍才知道成没成', () => {
  const main = read('electron/main.js');
  const block = main.slice(main.indexOf("ipcMain.handle('fs:setupDirect'"));
  assert.match(block, /buildProbeCommand/);
  assert.match(block, /密钥已写入,但直连仍不通/);
});

/* 用户在左栏选了「智能办公助手开发环境」,内容却还是本机的目录,
 * 底下报「主机未连接」。选择器和内容对不上是危险状态:那时候按传输或
 * 删除,操作的目标完全不是他以为的那台。 */

test('列目录失败时必须清空内容,不能留着上一台主机的列表', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /setLocal\(\{ path: '', entries: \[\] \}\);[\s\S]{0,80}setLeftErr\(e\.message\)/);
  // 这不是显示问题,是会真的删错东西
  assert.match(ui, /是会真的删错东西/);
});

test('出错时面板只显示错误,不渲染任何文件行', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /function Pane\(\{ title, data, sel, onUp, onOpen, onSelect, error \}\)/);
  assert.match(ui, /\{error \? \([\s\S]{0,400}\) : \(/);
  assert.match(ui, /pane-error/);
});

test('从左栏选远程主机要自己建连接 —— 侧边栏点进去才连是连不上的', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /const pickLeftHost = useCallback/);
  assert.match(ui, /await window\.api\.ssh\.connect\(host\)/);
  // 切换瞬间先清空,避免旧内容和新选择短暂共存
  assert.match(ui, /setLeftHostId\(id\);[\s\S]{0,120}setLocal\(\{ path: '', entries: \[\] \}\)/);
});

test('连接进行中不去列目录,否则会拿到一条假的「主机未连接」', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /if \(!leftConnecting\) loadLocal\(\)/);
  // 连完翻回 false,effect 自己再跑一次
  assert.match(ui, /\[loadLocal, leftConnecting\]/);
});

test('左栏出错时挡住传输按钮,免得打到错的目标', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /disabled=\{!selLocal \|\| !!leftErr\}/);
  assert.match(ui, /disabled=\{!selRemote \|\| !!leftErr \|\| leftConnecting\}/);
});

/* 用户在中转进行中点了「配置直连」,配好后看到「直连已配好」紧挨着进度条,
 * 于是问「现在是直连吗」—— 不是。这次传输在开始时就选定了中转,不会中途
 * 切换,而提示的位置让它读起来像已经切过去了。 */

test('配好直连时要说清「本次不变」,别让人误以为已经切过去了', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /本次传输仍走中转\(开始时就定了\),下次才生效/);
  // 只有进行中的传输才需要这句;已完成的说了反而多余
  assert.match(ui, /const inFlight = !t\.done && !t\.error/);
});

test('给一条出路:取消中转、用刚配好的直连重传', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /const restartDirect = async \(t\)/);
  assert.match(ui, /用直连重传/);
  // 1.8G 走中转不值得等完
  assert.match(ui, /cancelTransfer\(\{ transferId: t\.id \}\)/);
  assert.match(ui, /canRedirect: r\.ok && inFlight/);
});

test('取消要同时中断中转的两段 —— 上传段注册在另一个 id 下', () => {
  const main = read('electron/main.js');
  /* 只取消 transferId 的话,取消按钮在上传阶段按下去毫无作用:
     界面显示"取消中…"而传输照跑,是最糟的那种假象 */
  assert.match(main, /const ids = \[transferId, `\$\{transferId\}_up`\]/);
  assert.match(main, /最糟的那种假象/);
  // 两个都不存在才算"已结束"
  assert.match(main, /return hit \? \{ ok: true \}/);
});

/* 用户走上直连后问「直连传输不会有进度条吗」—— 确实没有,而且界面还显示
 * 一个不动的「0 B / 4.0 KB」,那个分母是选中条目的大小,对目录根本不对。 */

test('直连要自己造进度:先问源总量,再轮询目标已有多大', () => {
  // scp 只在 stdout 是 tty 时才打进度,非交互执行拿不到任何进度
  assert.match(h2h.buildSizeCommand('/root/code'), /du -sb '\/root\/code'/);
  assert.match(h2h.buildDestSizeCommand('/data/code'), /du -sb '\/data\/code'/);
  // 路径带空格要能正确引用
  assert.match(h2h.buildSizeCommand('/a/my code'), /'\/a\/my code'/);

  const main = read('electron/main.js');
  assert.match(main, /setInterval\(async \(\) => \{[\s\S]{0,400}buildDestSizeCommand/);
  // 轮询要停掉,否则传完还在打扰目标主机
  assert.match(main, /finally \{\s*\n\s*stopped = true;\s*\n\s*clearInterval\(poll\)/);
});

test('大小解析:拿不到就当 0,不要把 NaN 送进进度条', () => {
  assert.equal(h2h.parseSize('1048576\t/root/code'), 1048576);
  assert.equal(h2h.parseSize('0'), 0);
  assert.equal(h2h.parseSize(''), 0);
  assert.equal(h2h.parseSize('du: cannot access'), 0);
  assert.equal(h2h.parseSize(undefined), 0);
});

test('直连的进度标明是估算,不假装精确', () => {
  const ui = read('src/components/FilePanel.jsx');
  assert.match(ui, /直连中\(数据不经过本机\)/);
  // 数字来自定时查目录大小,scp 按文件写,必然滞后
  assert.match(ui, /(估算)/);
  assert.match(ui, /t\.phase === 'direct' \? \([\s\S]{0,500}<progress/);
});

test('直连的超时不能按分钟算 —— 大目录传几小时是正常的', () => {
  const main = read('electron/main.js');
  assert.match(main, /timeoutMs: 6 \* 60 \* 60 \* 1000/);
});
