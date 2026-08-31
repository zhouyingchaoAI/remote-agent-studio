const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./helpers/loadEsm');
/* node:buffer 里的 File —— eslint 的 node 环境里没有全局 File,
   显式引入既能过 lint,也说明白这就是标准的那个 File。 */
const { File } = require('node:buffer');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const A = loadEsm('src/attachmentFile.js');

/* ============================================================
 * 附件为什么会"没了"。
 *
 * 查这个问题时找到两处,**只有第二处已确认会在当前代码里发生**,
 * 这个区别值得写下来,免得以后误以为第一处就是当时那个 bug。
 *
 * 一、`{ ...file, thumb }` 展开 File —— **目前是隐患,不是现行路径**。
 *    File 的 name/size 是原型 getter,展开出来只剩 path,而且不报错,
 *    直到主进程抛一句「附件信息不完整」。现在各个入口(选择文件/截图/
 *    拖拽/粘贴)恰好都已经传的是普通对象,所以没被触发 ——
 *    但只要哪天有人直接把 File 塞进来就会中招,所以在入口做归一化。
 *
 * 二、**拿不到磁盘路径的文件被一声不吭地滤掉** —— 这条是实打实的。
 *    `file.path &&` 直接丢弃,不给任何提示。从浏览器里拖过来的图片、
 *    某些应用给的内存数据都会走到这儿,用户看到的就是"图片拖进去没了"。
 * ============================================================ */

/** 造一个和 Electron 里一样的 File:name/size 在原型上,path 是自有属性 */
function fakeFile(name, size, extra = {}) {
  const f = new File([new Uint8Array(Math.min(size, 8))], name, { type: 'image/png' });
  f.path = `/tmp/${name}`;
  Object.assign(f, extra);
  // 真实 File 的 size 由内容决定,这里要的是"原型 getter"这个性质
  Object.defineProperty(f, 'size', { value: size, enumerable: false, configurable: true });
  return f;
}

test('复现:直接展开 File 会丢掉 name 和 size', () => {
  /* 这条是**问题本身**的存证。哪天有人觉得"展开一下挺方便"改回去,
     这条会立刻挂掉,并告诉他为什么不行。 */
  const spread = { ...fakeFile('shot.png', 2048), thumb: 'data:...' };
  assert.equal(spread.path, '/tmp/shot.png');
  assert.equal(spread.name, undefined, 'name 是原型 getter,展开拿不到');
  assert.equal(spread.size, undefined);
});

test('归一化之后再展开,字段都还在', () => {
  const a = A.toAttachment(fakeFile('shot.png', 2048));
  const spread = { ...a, thumb: 'data:...' };
  assert.equal(spread.name, 'shot.png');
  assert.equal(spread.size, 2048);
  assert.equal(spread.path, '/tmp/shot.png');
  assert.equal(spread.thumb, 'data:...');
});

test('重复归一化是安全的,并且保留已有缩略图', () => {
  /* 会被调用两次(入口一次、后续可能再走一遍)。
     第二次要是把缩略图抹掉,预览会闪一下没了。 */
  const once = { ...A.toAttachment(fakeFile('a.png', 10)), thumb: 'T' };
  const twice = A.toAttachment(once);
  assert.equal(twice.name, 'a.png');
  assert.equal(twice.size, 10);
  assert.equal(twice.thumb, 'T');
});

test('拿不到路径的(拖进来的文件夹)直接滤掉', () => {
  const folder = new File([], 'somedir');   // 没有 path
  const ok = fakeFile('x.png', 5);
  const out = A.toAttachments([folder, ok]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'x.png');
});

test('空输入不炸', () => {
  assert.deepEqual(A.toAttachments(null), []);
  assert.deepEqual(A.toAttachments(undefined), []);
  assert.equal(A.toAttachment(null), null);
});

/* ---------------------------------------------- 发送前的体检 */

test('判据和主进程 validateFiles 对齐', () => {
  /* 两边不一致的话,渲染端放行、主进程抛错 —— 用户看到的还是那句
     没头没尾的「附件信息不完整」。 */
  assert.equal(A.attachmentProblem({ path: '/a', name: 'a.png', size: 1 }), '');
  assert.match(A.attachmentProblem({ name: 'a.png', size: 1 }), /路径/);
  assert.match(A.attachmentProblem({ path: '/a', size: 1 }), /文件名/);
  assert.match(A.attachmentProblem({ path: '/a', name: 'a.png' }), /大小/);
  assert.match(A.attachmentProblem({ path: '/a', name: 'a.png', size: NaN }), /大小/);
  assert.ok(A.attachmentProblem(null));
});

test('主进程那四个必填字段一个不少', () => {
  // 少带一个,上传时就会被判"信息不完整"
  const src = read('electron/chat/attachments.js');
  assert.match(src, /!file\?\.path \|\| !file\?\.name \|\| !Number\.isFinite\(file\?\.size\)/);
  for (const f of ['path', 'name', 'size']) assert.ok(A.ATTACHMENT_FIELDS.includes(f), f);
});

/* ---------------------------------------------- 接线 */

const chat = read('src/components/ChatPanel.jsx');

test('附件在入口就归一化,不留 File 实例', () => {
  assert.match(chat, /Array\.from\(rawFiles \|\| \[\]\)\.map\(toAttachment\)/);
});

test('拿不到路径的文件要报出来,不能一声不吭地丢掉', () => {
  /* 原来被 `file.path &&` 直接滤掉。从浏览器里拖过来的图片、
     某些应用给的内存数据都会走到这儿 —— 用户看到的就是
     "图片拖进去没了",而且完全不知道为什么。 */
  assert.match(chat, /const noPath = files\.find\(\(file\) => !file\.path\)/);
  assert.match(chat, /拿不到磁盘路径/);
});

test('附件不完整时不发送,也不清空输入框', () => {
  /* 清空了的话消息就没了 —— 用户得重打一遍,还不知道哪里错了。 */
  assert.match(chat, /const broken = files\.map/);
  assert.match(chat, /setInput\(raw\)/);
});

test('排队项显示附件数', () => {
  // 看不见就无从发现它丢了 —— 这个 bug 拖到现在,一半原因是它不可见
  assert.match(chat, /q\.files\?\.length > 0/);
});

test('排队和出队都带着 files', () => {
  assert.match(chat, /text: prompt, files/);
  const app = read('src/App.jsx');
  assert.match(app, /sendToAgent\(conv\.hostId, convId, next\.text, next\.files \|\| \[\]\)/);
});
