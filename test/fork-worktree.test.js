const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadEsm } = require('./helpers/loadEsm');
const w = require('../electron/ssh/worktree');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const N = loadEsm('src/forkNames.js');

/* ============================================================
 * 分路:一条攒了上下文的对话拆成几路,各做一个功能。
 *
 * **独立目录是前提,不是锦上添花。** 几路共用一个工作目录的话,
 * 几个智能体会同时改同一批文件,互相覆盖,事后还查不出是谁改的 ——
 * 那不是并行,是竞态。git worktree 正好解决这个。
 * ============================================================ */

/* ---------------------------------------------- 名字的两道关 */

test('界面侧:把名字整理成可用形态', () => {
  assert.equal(N.slugify('登录 优化'), '登录-优化');
  assert.equal(N.slugify('  report--export  '), 'report-export');
  /* 危险字符是被**删掉**而不是替换成连字符,所以 `a;rm` 会连成 `arm` ——
     名字变得有点怪,但安全性是对的。这里记下实际行为,
     免得以后有人看到 `arm-rf` 以为是 bug 又去"修"它。 */
  assert.equal(N.slugify('a;rm -rf /'), 'arm-rf');
});

test('界面侧:说不清的名字要给出能看懂的理由', () => {
  /* "非法字符"这种提示等于没说 —— 用户不知道该改哪里。 */
  assert.equal(N.slugProblem('登录优化'), '');
  assert.match(N.slugProblem(''), /不能为空/);
  assert.match(N.slugProblem('###'), /没有可用字符/);
  assert.match(N.slugProblem('123'), /不能只有数字/);
});

test('主进程侧:独立再判一次,不信任渲染层', () => {
  /* 这不是重复实现 —— 一个是便利,一个是安全边界。
     IPC 的调用方不保证是我们的界面。 */
  assert.equal(w.isSafeSlug('登录优化'), true);
  for (const bad of ['a;rm -rf /', '$(id)', '../etc', '', 'x y', '.hidden', '-lead']) {
    assert.equal(w.isSafeSlug(bad), false, bad);
    assert.equal(w.buildCreateWorktreeCommand({ root: '/r', slug: bad }), '',
      `${bad} 不该生成任何命令`);
  }
});

test('分支名同样要过校验', () => {
  // branch 也可能是外部传进来的
  assert.equal(w.buildCreateWorktreeCommand({ root: '/r', slug: 'ok', branch: 'feat/a;b' }), '');
  assert.ok(w.buildCreateWorktreeCommand({ root: '/r', slug: 'ok', branch: 'feat/good' }));
});

/* ---------------------------------------------- 真 git 验证 */

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-test-'));
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

const sh = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });

test('真的能建出 worktree,中文名也行', () => {
  /* 命令拼装是这一轮出错最多的地方(注释被当通配符、while read 挂死、
     引用不严),所以必须用真 bash + 真 git 跑,而不是"看着像对"。 */
  const root = tmpRepo();
  const r = w.parseCreate(sh(w.buildCreateWorktreeCommand({ root, slug: '登录优化' })));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.branch, 'feat/登录优化');
  assert.ok(fs.existsSync(path.join(r.path, 'a.txt')), '工作树内容应该在');
});

test('几路互不干扰:各自一个目录一条分支', () => {
  const root = tmpRepo();
  const a = w.parseCreate(sh(w.buildCreateWorktreeCommand({ root, slug: 'aaa' })));
  const b = w.parseCreate(sh(w.buildCreateWorktreeCommand({ root, slug: 'bbb' })));
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.branch, b.branch);

  // 在 a 里改文件,b 完全不受影响 —— 这正是分路要的
  fs.writeFileSync(path.join(a.path, 'a.txt'), 'changed by a');
  assert.equal(fs.readFileSync(path.join(b.path, 'a.txt'), 'utf8'), 'hi');
});

test('重复建同一条时说清楚是"已存在",不是笼统失败', () => {
  /* git 自己只会报一句 "already exists",什么也不解释。 */
  const root = tmpRepo();
  sh(w.buildCreateWorktreeCommand({ root, slug: 'dup' }));
  const again = w.parseCreate(sh(w.buildCreateWorktreeCommand({ root, slug: 'dup' })));
  assert.equal(again.ok, false);
  assert.match(again.error, /已存在/);
});

test('分支还在但目录被删时,复用分支接着做', () => {
  // 不复用的话,想接着上次没做完的就只能换个名字,历史分支就散了
  const root = tmpRepo();
  const first = w.parseCreate(sh(w.buildCreateWorktreeCommand({ root, slug: 'resume' })));
  execFileSync('git', ['-C', root, 'worktree', 'remove', first.path, '--force']);
  const second = w.parseCreate(sh(w.buildCreateWorktreeCommand({ root, slug: 'resume' })));
  assert.equal(second.ok, true, second.error);
  assert.equal(second.reused, true);
  assert.equal(second.branch, 'feat/resume');
});

test('探测:是仓库 / 不是仓库 / 目录不存在,三种都说得清', () => {
  const root = tmpRepo();
  const ok = w.parseDetect(sh(w.buildDetectRepoCommand(root)));
  assert.equal(ok.ok, true);
  assert.equal(ok.root, fs.realpathSync(root));
  assert.equal(ok.dirty, false);

  assert.match(w.parseDetect(sh(w.buildDetectRepoCommand('/tmp'))).error, /不是 git 仓库/);
  assert.match(w.parseDetect(sh(w.buildDetectRepoCommand('/nope-xyz-123'))).error, /目录不存在/);
});

test('有未提交改动要报出来', () => {
  /* worktree 从**提交点**切出去,没提交的改动不会跟过去。
     不提醒的话,分路里会发现"我刚改的东西不见了"。 */
  const root = tmpRepo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'uncommitted');
  assert.equal(w.parseDetect(sh(w.buildDetectRepoCommand(root))).dirty, true);
});

test('列表能解析出每条分路的路径和分支', () => {
  const root = tmpRepo();
  sh(w.buildCreateWorktreeCommand({ root, slug: 'x1' }));
  const list = w.parseList(sh(w.buildListCommand(root)));
  assert.ok(list.length >= 2, '主仓库 + 分路');
  assert.ok(list.some((x) => x.branch === 'feat/x1'));
});

/* ---------------------------------------------- 提示词 */

const Mir = loadEsm('src/mirrorConversation.js');

test('分路提示词划清边界:本路做什么、别路别碰什么', () => {
  /* 不说清楚的话,模型会顺手去改别路正在做的东西。
     在各自 worktree 里不会立刻冲突,但合并时会撞成一团,
     而那时候已经很难看出是谁碰的。 */
  const p = Mir.buildForkPrompt({
    digest: '用户: 做个后台\n助手: 已完成框架',
    focus: '登录优化', branch: 'feat/登录优化', path: '/r/.worktrees/登录优化',
    siblings: ['报表导出', '权限管理']
  });
  assert.match(p, /本路负责:登录优化/);
  assert.match(p, /报表导出、权限管理/);
  assert.match(p, /不要碰/);
  assert.match(p, /合并时会撞成一团/);
  assert.match(p, /已完成框架/, '主线背景要带上');
  assert.match(p, /不要重做/);
});

test('只有一路时不写"别路"那段', () => {
  // 没有兄弟路还讲一堆边界,是噪音
  const p = Mir.buildForkPrompt({ digest: 'x', focus: '单独一路', siblings: [] });
  assert.ok(!/不要碰/.test(p));
});

/* ---------------------------------------------- 接线 */

test('逐条报结果,不是整体成功/失败', () => {
  /* 建到第三条才失败时,前两条是真的建好了。笼统报一句"失败"
     会让人以为什么都没发生,重来一次,然后撞上"目录已存在"。 */
  const store = read('src/store.js');
  const fn = store.slice(store.indexOf('forkConversation: async'));
  assert.match(fn.slice(0, 2000), /results\.push\(\{ name: sp\.name, ok: false/);
  assert.match(fn.slice(0, 2000), /continue;/, '一条失败不该中断其余的');
});

test('兄弟路的名字会写进每一路的上下文', () => {
  const store = read('src/store.js');
  assert.match(store, /forkSiblings = names\.filter/);
});

test('分路走独立分支,不复用主线的引擎会话', () => {
  // 复用就是两条对话抢同一把线程写锁 —— 和镜像同一个道理
  const store = read('src/store.js');
  assert.match(store, /mirrorConversation\(src, \{ title: sp\.name, cwd: r\.path \}\)/);
});
