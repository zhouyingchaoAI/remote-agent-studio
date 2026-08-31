const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./helpers/loadEsm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const T = loadEsm('src/termFit.js');

/* ============================================================
 * "终端最后一行看不全"。
 *
 * 修过一次:加 14px 底部内边距 —— 没解决,因为那是在**猜差多少**。
 * 现在换成 fit() 之后实测渲染高度,超出就减一行。
 * ============================================================ */

test('没超出时一行都不减', () => {
  // 减错一行等于白白浪费一行屏幕,和看不全一样是缺陷
  assert.equal(T.fittedRows(400, 400, 25), 25);
  assert.equal(T.fittedRows(400, 380, 25), 25);
});

test('超出一行时减掉一行', () => {
  /* 典型情形:每行 17.6px 被各自取整成 18px,25 行就多出 10px。 */
  assert.equal(T.fittedRows(440, 450, 25), 24);
});

test('超出多行时一次减到位', () => {
  // 一次减一行的话,ResizeObserver 要抖好几轮才收敛,中间态是花的
  assert.equal(T.fittedRows(180, 450, 25), 10);
});

test('亚像素的零头不算超出', () => {
  /* 浏览器测出来的高度常带零点几像素。严格比较的话,
     每次 resize 都会莫名其妙少一行 —— 那是另一种坏法。 */
  assert.equal(T.fittedRows(400, 400.4, 25), 25);
});

test('至少留一行', () => {
  // 窗口被拖到极小时也不能算出 0 行 —— xterm 拿到 0 会抛错
  assert.equal(T.fittedRows(5, 450, 25), 1);
  assert.equal(T.fittedRows(1, 999, 40), 1);
});

test('数据不可信时原样返回,不乱调', () => {
  /* 容器还没上屏(高度 0)、或者拿到 NaN 时,
     宁可不调整,也不要凭错误数据把行数改坏。 */
  for (const args of [
    [0, 400, 25], [400, 0, 25], [400, 400, 0],
    [NaN, 400, 25], [400, NaN, 25], [undefined, undefined, 25]
  ]) {
    assert.equal(T.fittedRows(...args), args[2], JSON.stringify(args));
  }
});

test('内容区高度要扣掉内边距', () => {
  /* clientHeight 含内边距。不扣的话,算出来的可用空间比实际大,
     最后一行照样会溢出 —— 正是这次要修的那个现象。 */
  const el = { clientHeight: 300 };
  const style = () => ({ paddingTop: '6px', paddingBottom: '14px' });
  assert.equal(T.contentHeight(el, style), 280);
});

test('内边距读不出来时按 0 算,不产生 NaN', () => {
  const el = { clientHeight: 300 };
  assert.equal(T.contentHeight(el, () => ({})), 300);
  assert.equal(T.contentHeight(null, () => ({})), 0);
});

/* ---------------------------------------------- 接线 */

test('两个终端组件用的是同一套逻辑', () => {
  /* 各写一份的话,修好一个另一个还是坏的 —— 而"另一个"往往是
     引导流程里那个,出问题时最影响第一印象。 */
  for (const f of ['src/components/TerminalPanel.jsx', 'src/components/SetupTerminal.jsx']) {
    const s = read(f);
    assert.match(s, /import \{ fitExact \} from '\.\.\/termFit\.js'/, f);
    assert.ok(!/\bfit\.fit\(\)/.test(s), `${f} 里还有没走校准的裸 fit()`);
    assert.ok(!/fitRef\.current\?\.fit\(\)/.test(s), `${f} 里还有没走校准的裸 fit()`);
  }
});

test('fit 抛错不会把组件带崩', () => {
  /* 容器还没上屏时 FitAddon 会抛。让它冒出去的话,
     整个终端页白屏 —— 比少一行严重得多。 */
  const s = read('src/termFit.js');
  assert.match(s, /try \{\s*fit\.fit\(\);\s*\} catch/);
});

test('调整行数本身也不能抛', () => {
  const s = read('src/termFit.js');
  assert.match(s, /try \{ term\.resize\(term\.cols, want\); \} catch/);
});
