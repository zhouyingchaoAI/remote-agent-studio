const test = require('node:test');
const assert = require('node:assert');
const { LocalExecutor } = require('../electron/LocalExecutor');
const { summarizeCredentials } = require('../electron/claudeKeychain');

/* ---------------- 本机终端 PTY ---------------- */

/* PTY 方案换过一次:原来只用系统 script,但 macOS/BSD 的 script 会对
   自己的 stdin 调 tcgetattr,GUI 应用 spawn 出来的 stdin 是管道 ——
   于是「本机终端」在 mac 上根本连不上。现在首选自带的 Python PTY 桥,
   script 只在没有 python3 时兜底。 */

/** 造一个"没有 python3"的执行器,用来固定退路行为 */
function withoutPython(platform) {
  const ex = new LocalExecutor({ platform });
  ex.hasPython3 = () => false;
  return ex;
}

test('有 python3 时走自带 PTY 桥,不再用 script', () => {
  const ex = new LocalExecutor({ platform: 'darwin' });
  ex.hasPython3 = () => { ex.python3Bin = 'python3'; return true; };
  const r = ex.ptyInvocation('/bin/zsh', 100, 30);
  assert.equal(r.mode, 'pty-helper');
  assert.equal(r.bin, 'python3');
  assert.ok(r.args[0].endsWith('pty-helper.py'));
  assert.deepEqual(r.args.slice(1), ['/bin/zsh', '-l']);
  // 初始尺寸走环境变量,helper 起来就 TIOCSWINSZ
  assert.equal(r.env.PTY_COLS, '100');
  assert.equal(r.env.PTY_ROWS, '30');
});

test('没有 python3 才退回 script,mac 与 linux 语法不同', () => {
  const mac = withoutPython('darwin').ptyInvocation('/bin/zsh', 100, 30);
  assert.equal(mac.mode, 'script');
  assert.equal(mac.bin, 'script');
  assert.ok(mac.args.includes('-q') && mac.args.includes('/dev/null'));
  assert.ok(mac.args.some((a) => a.includes('exec /bin/zsh -l')));

  const linux = withoutPython('linux').ptyInvocation('/bin/bash', 80, 24);
  assert.equal(linux.bin, 'script');
  assert.ok(linux.args.includes('-qfc'));
  assert.ok(linux.args.some((a) => a.includes('exec /bin/bash -l')));
});

test('退回 script 时仍要先设好窗口尺寸(否则换行会错乱)', () => {
  const { args } = withoutPython('linux').ptyInvocation('/bin/bash', 120, 40);
  assert.ok(args.some((a) => a.includes('stty rows 40 cols 120')));
});

test('真实打开本机 shell:子进程能检测到 TTY(交互式 CLI 的前提)', async () => {
  const ex = new LocalExecutor({ platform: process.platform });
  if (process.platform === 'win32') return; // Windows 走另一条路,跳过
  const s = await ex.openShell({ termId: 'test-tty', cols: 100, rows: 30 });
  let out = '';
  s.on('data', (d) => { out += d.toString(); });
  s.write('test -t 0 && echo TTY_OK || echo NO_TTY; echo COLS=$(tput cols); exit\n');
  await new Promise((r) => s.on('close', r));
  assert.match(out, /TTY_OK/);      // 有伪终端
  assert.match(out, /COLS=100/);    // 尺寸生效
});

test('同一 termId 复用已有 shell,close 后清理', async () => {
  if (process.platform === 'win32') return;
  const ex = new LocalExecutor({ platform: process.platform });
  const a = await ex.openShell({ termId: 'reuse' });
  const b = await ex.openShell({ termId: 'reuse' });
  assert.equal(a, b);               // 不会重复起进程
  ex.closeShell('reuse');
  assert.ok(!ex.shells.get('reuse'));
});

test('Windows 本机终端给出明确提示而不是静默失败', async () => {
  const ex = new LocalExecutor({ platform: 'win32' });
  await assert.rejects(() => ex.openShell({}), /Windows 本机终端暂不支持/);
});

/* ---------------- 本机 Claude 凭据摘要 ---------------- */

test('凭据摘要:识别订阅类型与过期状态', () => {
  const future = Date.now() + 3600000;
  const s = summarizeCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: future, subscriptionType: 'pro' }
  }));
  assert.equal(s.valid, true);
  assert.equal(s.expired, false);
  assert.equal(s.subscription, 'pro');
  assert.equal(s.expiresAt, future);
});

test('凭据摘要:已过期要能判出来(界面据此禁用下发)', () => {
  const s = summarizeCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: 'a', expiresAt: Date.now() - 1000 }
  }));
  assert.equal(s.valid, true);
  assert.equal(s.expired, true);
});

test('凭据摘要:非凭据内容一律判为无效', () => {
  assert.equal(summarizeCredentials('password').valid, false);
  assert.equal(summarizeCredentials('{"foo":1}').valid, false);
  assert.equal(summarizeCredentials('').valid, false);
});
