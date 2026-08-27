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
