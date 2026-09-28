const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 「上一次对话产生的图片,每次对话都会加载一遍」
 *
 * 后端每轮的产物目录按 messageId 分,旧图不会被重新发一遍 ——
 * 重复的是**解析**:每次挂载都重新走一遍 IPC,而一次解析要在远端
 * stat、读完整文件、再 base64 传回来。几张图叠起来就是肉眼可见的卡顿,
 * 界面上表现为"一发消息旧图又转圈"。
 * ============================================================ */

const svc = read('electron/chat/AttachmentService.js');
const chat = read('src/components/ChatPanel.jsx');

/* ---------------------------------------------- 主进程缓存 */

test('解析结果进内存缓存', () => {
  assert.match(svc, /this\.imageCache = new Map\(\)/);
  assert.match(svc, /const hit = this\.imageCache\.get\(cacheKey\)/);
});

test('缓存键带 mtime + size,图被覆盖重画时自动失效', () => {
  /* 智能体经常用同一个文件名重画一张图。只按路径缓存会一直显示旧图 ——
     那比多加载一次糟得多:你以为改了没生效,实际是缓存骗了你。 */
  assert.match(svc, /stamp = `\$\{size\}-\$\{mtimeStr \|\| ''\}`/);
  assert.match(svc, /stamp = `\$\{st\.size\}-\$\{Math\.floor\(st\.mtimeMs\)\}`/);
  assert.match(svc, /const cacheKey = `\$\{hostId\}\|\$\{safePath\}\|\$\{stamp\}`/);
});

test('缓存有上限,不会把内存吃光', () => {
  // base64 比原图还大三分之一,无上限地攒下去迟早 OOM
  assert.match(svc, /imageCacheMax/);
  assert.match(svc, /this\.imageCache\.delete\(this\.imageCache\.keys\(\)\.next\(\)\.value\)/);
});

test('远端探测合成一次 SSH 往返', () => {
  /* 原来 readlink 一次、stat 一次,每张图每次预览两个往返。 */
  assert.match(svc, /p=\$\(readlink -f/);
  assert.match(svc, /stat -c '%s %Y'/);
  // 旧的那条独立 stat 必须没了,否则等于没省
  assert.ok(!/const sizeResult = await this\.ssh\.exec\(`stat -c %s/.test(svc));
});

test('合成后的探测命令在真 bash 里行为正确', () => {
  /* 命令拼装是这一轮出错最多的地方。符号链接、带空格的路径、
     不存在的文件,三种都跑一遍,而不是"看着像对"。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const real = path.join(dir, 'a b.png');
  fs.writeFileSync(real, Buffer.alloc(1234));
  const link = path.join(dir, 'link.png');
  fs.symlinkSync(real, link);

  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const build = (p) => `p=$(readlink -f ${q(p)}) && printf '%s\\n' "$p" && stat -c '%s %Y' "$p"`;

  const out = execFileSync('bash', ['-c', build(link)], { encoding: 'utf8' }).split('\n');
  assert.equal(out[0], real, '符号链接要解析到真实路径(防止跑出会话目录)');
  const [size] = out[1].trim().split(/\s+/);
  assert.equal(Number(size), 1234);

  // 文件不存在时不能报一堆噪音,调用方靠空输出判失败
  const bad = execFileSync('bash', ['-c', `${build(path.join(dir, 'nope.png'))} 2>/dev/null || true`],
    { encoding: 'utf8' });
  assert.ok(!bad.includes('1234'));
});

/* ---------------------------------------------- 行为验证(不只是看源码) */

const { AttachmentService } = require('../electron/chat/AttachmentService');

/** 假远端:记下每次探测,返回可控的 size/mtime */
function fakeHost({ size = 10, mtime = 1700000000 } = {}) {
  const state = { probes: 0, downloads: 0, size, mtime };
  const ssh = {
    exec: async (command) => {
      if (command.includes('__RAS_HOME__')) {
        return { code: 0, stdout: '__RAS_HOME__/home/test__RAS_HOME__', stderr: '' };
      }
      if (command.includes('readlink -f')) {
        state.probes += 1;
        const p = command.match(/'([^']+)'/)[1];
        return { code: 0, stdout: `${p}\n${state.size} ${state.mtime}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    download: async (_remote, local) => {
      state.downloads += 1;
      fs.writeFileSync(local, Buffer.alloc(state.size, state.downloads));
    }
  };
  return { ssh, state };
}

const IMG = '/home/test/.remote-agent-studio/artifacts/c1/m1/chart.png';

test('第二次解析同一张图不再读文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcache-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const { ssh, state } = fakeHost();
  const svcObj = new AttachmentService(ssh, { cacheRoot: dir });

  const a = await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: IMG, isLocal: false });
  const b = await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: IMG, isLocal: false });
  assert.equal(a.src, b.src);
  assert.equal(state.downloads, 1, '不该重复下载');
  // 探测还是要做的 —— 它就是用来判断图有没有被重画的
  assert.equal(state.probes, 2);
});

test('图被重画(mtime 变了)时缓存自动失效', async () => {
  /* 这条是缓存最危险的一面:显示一张过期的图,而用户以为改动没生效。
     宁可多读一次,也不能给错的。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcache2-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const { ssh, state } = fakeHost();
  const svcObj = new AttachmentService(ssh, { cacheRoot: dir });

  await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: IMG, isLocal: false });
  state.mtime += 60;                       // 智能体用同名文件重画了一张
  state.size = 20;
  await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: IMG, isLocal: false });
  assert.equal(state.downloads, 2, 'mtime 变了就必须重新取');
});

/* ---------------------------------------------- 渲染端缓存 */

test('渲染端的缓存放在模块作用域,跨挂载存活', () => {
  /* 放组件里等于没有:切对话、分屏、窗口滑动,任何一次重挂载都会重来。 */
  assert.match(chat, /^const imageMemo = new Map\(\);/m);
  assert.match(chat, /useState\(\(\) => imageMemo\.get\(memoKey\) \|\| null\)/);
});

test('有缓存时不闪"加载中"', () => {
  /* 原来无条件 setImage(null) —— 每次重挂载都先闪一下加载态,
     这正是用户看到的"旧图又加载一遍"。 */
  assert.match(chat, /if \(!cached\) setImage\(null\)/);
  assert.ok(!/^\s*setImage\(null\);\s*$/m.test(chat.slice(chat.indexOf('function ImagePreview'))),
    '不该还留着无条件清空');
});

test('已有图在显示时,后台校验失败不把它换成报错', () => {
  // 网络抖一下就把好好的图变成"加载失败",比不刷新更糟
  assert.match(chat, /if \(active && !imageMemo\.get\(memoKey\)\) setError/);
});

test('渲染端缓存也有上限', () => {
  assert.match(chat, /IMAGE_MEMO_MAX/);
  assert.match(chat, /imageMemo\.delete\(imageMemo\.keys\(\)\.next\(\)\.value\)/);
});

/* ---------------------------------------------- 后端确实是按轮隔离的 */

test('产物目录按 messageId 分,旧图不会被重新列一遍', () => {
  /* 这条是**排除**:查这个问题时先怀疑后端每轮重发,
     确认不是之后才转向渲染端。把结论钉下来,省得下次再查一遍。 */
  assert.match(svc, /listArtifacts\(\{ convId, messageId, extraPaths = \[\], isLocal \}\)/);
  assert.match(svc, /this\.directory\('artifacts', convId, messageId, isLocal\)/);
  // extraPaths 也要被限制在本轮目录内,否则旧图会从模型正文里被捞回来
  assert.match(svc, /\.filter\(\(candidate\) => this\._isWithin\(candidate, dir, isLocal\)\)/);
});

test('不同目录下的同名图片是两张图,不能互相覆盖', async () => {
  /* 这条是被老测试逼出来的:我第一版的清理按**文件名**筛,
     于是 m1/output.png 和 m2/output.png 互相把对方的缓存删了。
     同名不等于同一张图。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcache3-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const { ssh, state } = fakeHost();
  const svcObj = new AttachmentService(ssh, { cacheRoot: dir });

  const base = '/home/test/.remote-agent-studio/artifacts/c1';
  await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: `${base}/m1/output.png`, isLocal: false });
  await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: `${base}/m2/output.png`, isLocal: false });

  assert.equal(state.downloads, 2);
  assert.equal(fs.readdirSync(path.join(dir, 'h1', 'c1')).length, 2, '两张图的缓存都该在');
});

test('同一张图重画后,旧版本缓存被清掉(不无限增长)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgcache4-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const { ssh, state } = fakeHost();
  const svcObj = new AttachmentService(ssh, { cacheRoot: dir });

  for (let i = 0; i < 4; i += 1) {
    state.mtime += 10;
    await svcObj.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: IMG, isLocal: false });
  }
  assert.equal(fs.readdirSync(path.join(dir, 'h1', 'c1')).length, 1, '同一张图只留最新一版');
});
