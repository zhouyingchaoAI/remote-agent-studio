const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* src/pastePath.js 是 ESM,渲染进程用。这里在函数作用域里求值取出来,
   避免引额外的构建依赖;顶层 eval 会和 const 声明撞名。 */
const { normalizePastedPath, looksLikePath } = new Function(
  `${read('src/pastePath.js').replace(/export /g, '')}
   return { normalizePastedPath, looksLikePath };`
)();

/* 用户:「这里的本机工作目录不能直接复制进去」。
 * 在 Finder 里 ⌘C 一个文件夹,剪贴板上放的是文件引用而不是文本,
 * 往输入框 ⌘V 什么都不会出现 —— 看起来就像粘贴功能坏了。 */

test('Finder 的 file:// URL 还原成真实路径(含中文与空格)', () => {
  assert.equal(normalizePastedPath('file:///Users/zhou/my%20code/'), '/Users/zhou/my code');
  assert.equal(normalizePastedPath('file:///Users/z/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95'),
    '/Users/z/中文目录');
});

test('终端复制常带的引号与转义空格都要吃掉', () => {
  assert.equal(normalizePastedPath('"/root/code"'), '/root/code');
  assert.equal(normalizePastedPath("'/root/my project'"), '/root/my project');
  assert.equal(normalizePastedPath('/a/b\\ c'), '/a/b c');
});

test('末尾斜杠去掉,但根目录保持原样', () => {
  assert.equal(normalizePastedPath('~/proj/'), '~/proj');
  assert.equal(normalizePastedPath('/'), '/');
});

test('复制的是文件就退到它所在目录 —— 用户想选的几乎总是目录', () => {
  assert.equal(normalizePastedPath('/a/b/x.txt', { isFile: true }), '/a/b');
  // 没标记成文件时不要自作主张截断
  assert.equal(normalizePastedPath('/a/b/x.txt'), '/a/b/x.txt');
});

test('复制多个条目时只取第一行,不把整坨塞进去', () => {
  assert.equal(normalizePastedPath('/a/one\n/a/two\n/a/three'), '/a/one');
});

test('坏编码不抛异常,原样返回好过整个界面崩', () => {
  assert.doesNotThrow(() => normalizePastedPath('file:///bad%ZZpath'));
  assert.equal(normalizePastedPath(''), '');
  assert.equal(normalizePastedPath(null), '');
});

test('只有像路径的才拦截粘贴,普通文本照常走默认行为', () => {
  assert.ok(looksLikePath('/root/code'));
  assert.ok(looksLikePath('~/proj'));
  assert.ok(looksLikePath('C:\\Users\\x'));
  assert.ok(!looksLikePath('随便一段文字'));
  assert.ok(!looksLikePath('relative/path'));
});

test('主进程能读 Finder 的文件引用,而不只是纯文本', () => {
  const main = read('electron/main.js');
  assert.match(main, /ipcMain\.handle\('clipboard:readPath'/);
  assert.match(main, /public\.file-url/);
  assert.match(read('electron/preload.js'), /readPath: invoke\('clipboard:readPath'\)/);
});

test('粘完就打开目录列表并停在该目录,而不是弹回 HOME', () => {
  const ui = readChatSources();
  // 原来 toggle 写死 load('~'),刚粘完的路径会被丢掉
  assert.match(ui, /load\(value\?\.trim\(\) \|\| '~'\)/);
  assert.match(ui, /const applyPasted = \(raw, opts\) => \{[\s\S]{0,200}setOpen\(true\);[\s\S]{0,40}load\(next\)/);
  // 拖入也要支持
  assert.match(ui, /onDrop=\{/);
  assert.match(ui, /pathForDroppedFile/);
});
