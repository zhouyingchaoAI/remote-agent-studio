const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const HELPER = path.join(root, 'electron/pty-helper.py');

/* 用户反馈本机终端连不上:
 *   script: tcgetattr/ioctl: Operation not supported on socket
 *
 * macOS/BSD 的 script 会对**它自己的 stdin** 调 tcgetattr。它能给子进程
 * 分配伪终端不假,但前提是自己先连着一个 tty —— 这个前提在 GUI 应用里
 * 从来不成立(spawn 出来的 stdin 是管道)。 */

const py = ['python3', '/usr/bin/python3'].find((b) => {
  try { return spawnSync(b, ['-c', 'import pty'], { timeout: 5000 }).status === 0; }
  catch (_) { return false; }
});

test('优先走自带的 PTY 桥,script 只作为退路', () => {
  const src = read('electron/LocalExecutor.js');
  assert.match(src, /pty-helper\.py/);
  assert.match(src, /hasPython3\(\)/);
  // 说清为什么不用 script:这个坑不写下来,下次还会有人换回去
  assert.match(src, /tcgetattr/);
});

test('尺寸指令走 fd 3,不与用户输入同流', () => {
  const src = read('electron/LocalExecutor.js');
  // 混在 stdin 里就得设计转义,而任何转义都可能被真实输入撞上
  assert.match(src, /\['pipe', 'pipe', 'pipe', 'pipe'\]/);
  assert.match(src, /child\.stdio\[3\]\?\.write/);
});

test('helper 必须解包出 asar —— python3 读不了虚拟文件系统', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok((pkg.build.asarUnpack || []).includes('electron/pty-helper.py'));
  // 光解包不够,路径也得跟着改写
  assert.match(read('electron/LocalExecutor.js'), /app\.asar\.unpacked/);
});

test('helper 语法正确', { skip: !py && '没有 python3' }, () => {
  const r = spawnSync(py, ['-m', 'py_compile', HELPER], { timeout: 15000 });
  assert.equal(r.status, 0, r.stderr?.toString());
});

/* 下面这条是关键:在 stdin 为管道的条件下(正是 script 失败的场景),
   子进程仍要拿到真正的 tty,并且能改窗口尺寸。 */
test('端到端:stdin 是管道时子进程仍拿到真 tty,且尺寸可改',
  { skip: !py && '没有 python3' }, async () => {
    const child = spawn(py, [HELPER, '/bin/sh'], {
      env: { ...process.env, PTY_COLS: '100', PTY_ROWS: '30', TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']    // stdin 是管道,不是 tty
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(400);
    child.stdin.write('echo TTY=$(tty) SIZE=$(stty size)\n');
    await wait(600);
    child.stdio[3].write(`${JSON.stringify({ rows: 44, cols: 120 })}\n`);
    await wait(500);
    child.stdin.write('echo RESIZED=$(stty size)\n');
    await wait(800);
    child.kill();

    const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    assert.match(clean, /TTY=\/dev\/(pts\/\d+|ttys\d+)/, `子进程没拿到真 tty:\n${clean}`);
    assert.match(clean, /SIZE=30 100/, `初始尺寸没生效:\n${clean}`);
    assert.match(clean, /RESIZED=44 120/, `fd 3 改尺寸没生效:\n${clean}`);
  });

test('坏的尺寸指令不该弄死终端', { skip: !py && '没有 python3' }, async () => {
  const child = spawn(py, [HELPER, '/bin/sh'], {
    env: { ...process.env, PTY_COLS: '80', PTY_ROWS: '24' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  child.stdio[3].write('这不是 JSON\n{"rows":"坏"}\n');
  await wait(300);
  child.stdin.write('echo STILL_ALIVE\n');
  await wait(600);
  child.kill();
  assert.match(out, /STILL_ALIVE/, '收到坏指令后终端应当照常工作');
});
