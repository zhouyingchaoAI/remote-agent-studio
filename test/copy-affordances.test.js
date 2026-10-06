const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 代码块与图片的「可复制」能力:光有按钮不够,IPC 两端要对得上。
 * 这些是契约测试 —— 渲染层调的方法必须在 preload 暴露、在主进程注册,
 * 三处有一处漏了,运行时就是点了没反应。 */

test('复制/保存图片的 IPC 三处齐全', () => {
  const preload = read('electron/preload.js');
  const main = read('electron/main.js');

  for (const [api, channel] of [
    ['writeImage', 'clipboard:writeImage'],
    ['saveImageAs', 'image:saveAs'],
    ['writeText', 'clipboard:writeText']
  ]) {
    assert.ok(preload.includes(`${api}: invoke('${channel}')`), `preload 缺 ${api}`);
    assert.ok(main.includes(`ipcMain.handle('${channel}'`), `主进程缺 ${channel} 处理器`);
  }
});

test('渲染层调用的正是这几个方法名', () => {
  const chat = readChatSources();
  assert.ok(chat.includes('window.api.clipboard.writeImage('), '图片复制未接线');
  assert.ok(chat.includes('window.api.clipboard.saveImageAs('), '图片另存为未接线');

  const md = read('src/components/Markdown.jsx');
  assert.ok(md.includes('window.api.clipboard.writeText('), '代码复制未接线');
});

test('代码块渲染成带复制条的结构,而不是裸 pre', () => {
  const md = read('src/components/Markdown.jsx');
  assert.ok(md.includes('md-code-wrap'), '缺少代码块外壳');
  assert.ok(md.includes('md-code-bar'), '缺少复制条');
  assert.ok(/CodeBlock/.test(md), '缺少 CodeBlock 组件');
  // 语言标记要从正文里剥掉,否则复制出来第一行是 "bash"
  assert.ok(md.includes("replace(/^[\\w+-]*\\n/, '')"), '语言标记未从代码正文剥离');
});

test('样式允许框选:代码区必须能用鼠标选中', () => {
  const css = read('src/styles.css');
  assert.match(css, /\.md-code[^{]*\{[^}]*user-select:\s*text/s);
});

test('图片操作按钮在缩略图和大图两处都有', () => {
  const chat = readChatSources();
  const uses = chat.match(/<ImageActions/g) || [];
  assert.ok(uses.length >= 2, `ImageActions 应在两处出现,实际 ${uses.length}`);
  assert.ok(chat.includes('lightbox-bar'), '大图下方缺操作条');
});

test('主进程对无效图片数据给出明确错误而不是静默失败', () => {
  const main = read('electron/main.js');
  assert.match(main, /clipboard:writeImage[\s\S]{0,400}图片数据无效/);
  assert.match(main, /image:saveAs[\s\S]{0,400}图片数据无效/);
});

test('另存为被取消时不写文件', () => {
  const main = read('electron/main.js');
  assert.match(main, /r\.canceled \|\| !r\.filePath\) return \{ saved: false \}/);
});
