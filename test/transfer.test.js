const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/tmp');

const {
  walkLocalDir, buildRemoteWalkCommand, parseRemoteWalk,
  joinPosix, aggregateProgress, TransferCancelled, isCancelled, SKIP_DIRS
} = require('../electron/ssh/transfer');

function makeTree() {
  const root = tmpDir('ras-xfer-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'src', 'deep'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(10));
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'y'.repeat(20));
  fs.writeFileSync(path.join(root, 'src', 'deep', 'c.md'), 'z'.repeat(30));
  fs.writeFileSync(path.join(root, 'node_modules', 'junk', 'big.bin'), 'q'.repeat(9999));
  return root;
}

/* ------------------------------------------------------------ 本地遍历 */

test('遍历目录:算出文件清单、目录清单与总字节', () => {
  const root = makeTree();
  const plan = walkLocalDir(root);

  assert.deepEqual(plan.files.map((f) => f.rel).sort(), ['a.txt', 'src/b.js', 'src/deep/c.md']);
  assert.equal(plan.totalBytes, 60, '总字节应只算被传的文件');
  assert.ok(plan.dirs.includes('src/deep'), '深层目录要建出来,否则上传时无处落盘');

  fs.rmSync(root, { recursive: true, force: true });
});

test('node_modules 这类目录被跳过(传了纯属浪费且常常巨大)', () => {
  const root = makeTree();
  const plan = walkLocalDir(root);

  assert.ok(!plan.files.some((f) => f.rel.includes('node_modules')), 'node_modules 不该被传');
  assert.ok(plan.skipped.includes('node_modules'));
  assert.ok(SKIP_DIRS.has('.git'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('软链不跟随,避免成环把自己传爆', () => {
  const root = makeTree();
  try { fs.symlinkSync(root, path.join(root, 'loop')); } catch (_) { return; } // 无权限则跳过
  const plan = walkLocalDir(root);
  assert.ok(plan.skipped.includes('loop'));
  assert.equal(plan.files.length, 3, '不该因为软链多出文件');
  fs.rmSync(root, { recursive: true, force: true });
});

test('文件数上限兜底,避免误选家目录后卡死', () => {
  const root = makeTree();
  const plan = walkLocalDir(root, { maxFiles: 2 });
  assert.ok(plan.files.length <= 2);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ 远程遍历 */

test('远程扫描命令带路径引用与跳过规则', () => {
  const cmd = buildRemoteWalkCommand("/root/my project's dir");
  assert.match(cmd, /-prune/);
  assert.match(cmd, /node_modules/);
  assert.match(cmd, /printf 'F/);
  // 带单引号的目录名必须被正确转义,否则命令直接坏掉
  assert.ok(!/[^\\]'[^']*'s dir/.test(cmd.replace(/'\\''/g, '')), `转义有问题: ${cmd}`);
});

test('解析 find 输出:区分文件与目录,累计字节', () => {
  const out = [
    'D\tsrc',
    'F\ta.txt\t10',
    'F\tsrc/b.js\t20',
    'D\t',            // find 会把根目录本身输出成空 %P,要忽略
    ''
  ].join('\n');
  const plan = parseRemoteWalk(out);
  assert.deepEqual(plan.files.map((f) => f.rel), ['a.txt', 'src/b.js']);
  assert.deepEqual(plan.dirs, ['src']);
  assert.equal(plan.totalBytes, 30);
});

test('解析空输出不报错(空目录)', () => {
  const plan = parseRemoteWalk('');
  assert.deepEqual(plan.files, []);
  assert.equal(plan.totalBytes, 0);
});

/* ------------------------------------------------------------ 路径与进度 */

test('远程路径一律用 / 拼接,不受本机分隔符影响', () => {
  assert.equal(joinPosix('/root/code', 'src/a.js'), '/root/code/src/a.js');
  assert.equal(joinPosix('/root/code/', '/src/a.js'), '/root/code/src/a.js');
});

test('目录进度按字节而不是文件数(一个 10G 和一个 1K 不该各算一半)', () => {
  const p = aggregateProgress({
    doneBytes: 1000, currentTransferred: 500,
    totalBytes: 3000, doneFiles: 1, totalFiles: 3
  });
  assert.equal(p.transferred, 1500);
  assert.equal(p.percent, 50);
  assert.equal(p.doneFiles, 1);
  assert.equal(p.totalFiles, 3);
});

test('总字节为 0 时不产生 NaN 百分比', () => {
  const p = aggregateProgress({ totalBytes: 0 });
  assert.equal(p.percent, 0);
});

/* ------------------------------------------------------------ 取消 */

test('取消错误可被识别,与真失败区分开', () => {
  assert.equal(isCancelled(new TransferCancelled()), true);
  assert.equal(isCancelled(new Error('传输已取消')), true);
  assert.equal(isCancelled(new Error('Permission denied')), false);
  assert.equal(isCancelled(null), false);
});

test('SSHManager 与 transfer 之间没有顶层循环依赖', () => {
  // transfer.js 顶层若 require SSHManager,SSHManager 拿到的
  // TransferCancelled 会是 undefined,取消时直接 TypeError
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron/ssh/transfer.js'), 'utf8');
  const header = src.slice(0, src.indexOf('function'));
  assert.ok(!/require\('\.\/SSHManager'\)/.test(header), 'transfer.js 顶层不能 require SSHManager');

  const { TransferCancelled: FromSSH } = require('../electron/ssh/SSHManager');
  // SSHManager 不导出它,但要保证 require 顺序不炸
  assert.equal(typeof require('../electron/ssh/transfer').TransferCancelled, 'function');
  assert.equal(FromSSH, undefined);
});
