const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const term = read('src/components/TerminalPanel.jsx');
const css = read('src/styles.css');

/* 把 isAtBottom 单独抠出来跑 —— 它是这次修复里唯一有真逻辑的部分 */
function loadIsAtBottom() {
  const src = term.match(/function isAtBottom\(term\) \{[\s\S]*?\n\}/)[0];
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`${src}\nmodule.exports = isAtBottom;`, sandbox);
  return sandbox.module.exports;
}
const isAtBottom = loadIsAtBottom();

test('终端底部留白比顶部大', () => {
  /* 最后一行原来紧贴窗口底边。只要窗口下沿压着 Dock 或任务栏,
     那一行就被吃掉一半 —— 而它恰恰是当前提示符,最需要看清的一行。 */
  const rule = css.match(/\.terminal-box \{[^}]*\}/)[0];
  const m = rule.match(/padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px/);
  assert.ok(m, `.terminal-box 应显式写出三段 padding,当前:${rule}`);
  assert.ok(Number(m[3]) > Number(m[1]), '底部留白必须大于顶部');
});

test('「问一下」按钮不压在最后一行上', () => {
  // 原来 bottom:16px 正好盖住提示符,光标走到行尾就被按钮遮住
  const rule = css.match(/\.ask-fab \{[^}]*\}/)[0];
  const bottom = Number((rule.match(/bottom:\s*(\d+)px/) || [])[1]);
  assert.ok(bottom >= 40, `按钮离底边太近(${bottom}px),会压住最后一行`);
  assert.match(rule, /opacity/);
});

test('重排后滚回底部,否则最后一行会留在可视区外', () => {
  assert.match(term, /if \(atBottom\) term\.scrollToBottom\(\);/);
  // 标签页隐藏时高度为 0,重新显示后也要滚
  assert.match(term, /term\.scrollToBottom\(\);\s*\n\s*window\.api\.term\.resize/);
});

test('只在本来就贴底时才滚 —— 不能把正在翻历史的人拽走', () => {
  /* 调整窗口大小恰恰是翻历史时最常做的事(想看清一点),
     无条件 scrollToBottom 会让人刚翻到的位置瞬间丢失。 */
  assert.match(term, /const atBottom = isAtBottom\(term\);/);
  assert.equal(isAtBottom({ buffer: { active: { viewportY: 100, baseY: 100 } } }), true);
  assert.equal(isAtBottom({ buffer: { active: { viewportY: 20, baseY: 100 } } }), false);
});

test('差一行也算贴底', () => {
  // 窗口高度不是行高整数倍时这两个数会差零点几行,严格相等会误判
  assert.equal(isAtBottom({ buffer: { active: { viewportY: 99, baseY: 100 } } }), true);
});

test('缓冲区还没准备好时不炸,并按"贴底"处理', () => {
  // 刚创建、还没写入任何内容时 buffer 可能取不到
  assert.equal(isAtBottom(null), true);
  assert.equal(isAtBottom({}), true);
});

test('ResizeObserver 做了防抖并在卸载时清掉定时器', () => {
  /* fit() 自己会改变元素尺寸,可能把 RO 再触发一次;
     连锁抖动的中间态里滚动位置会停在错的地方。 */
  assert.match(term, /resizeTimer = window\.setTimeout\(applyFit/);
  assert.match(term, /window\.clearTimeout\(resizeTimer\);\s*\n\s*window\.removeEventListener/);
});
