const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./helpers/loadEsm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { shortenPath, displayWidth } = loadEsm('src/shortenPath.js');

/* ============================================================
 * 顶栏那一行要塞引擎、账号、标题、目录、模型、推理强度一堆东西,
 * 而目录动辄 `/Users/zhouyingchao/Documents/ChatGPT/承希经营管理台账助手`,
 * 一条就把后面的控件挤扁。
 * ============================================================ */

test('保尾不保头', () => {
  /* 信息量在末尾(项目叫什么);开头那截 `/Users/<用户名>/` 每条都一样。
     CSS 的 text-overflow 只能砍尾巴,恰好砍掉唯一有用的部分 ——
     所以这件事必须在 JS 里做。 */
  const out = shortenPath('/Users/zhouyingchao/Documents/ChatGPT/承希经营管理台账助手');
  assert.match(out, /承希经营管理台账助手$/, '项目名必须留着');
  assert.ok(!out.includes('zhouyingchao'), '用户名没有信息量');
  assert.ok(displayWidth(out) <= 34, `太宽了:${displayWidth(out)}`);
});

test('家目录折成 ~', () => {
  assert.equal(shortenPath('/Users/zyc/proj'), '~/proj');
  assert.equal(shortenPath('/home/chency/proj'), '~/proj');
  assert.equal(shortenPath('/root/ragflow'), '~/ragflow');
  assert.equal(shortenPath('/root'), '~');
  assert.equal(shortenPath('C:\\Users\\zyc\\Documents\\proj'), '~\\Documents\\proj');
});

test('本来就短的原样返回,不画蛇添足', () => {
  // 短路径加个 … 只会让人以为省略了什么
  assert.equal(shortenPath('/opt/app'), '/opt/app');
  assert.equal(shortenPath('/root/ragflow'), '~/ragflow');
});

test('按显示宽度算,不按字符数', () => {
  /* 一个汉字占两个西文字符的位置。按 length 截的话,
     中文目录会比英文目录宽出快一倍 —— 而这个界面里的目录大多是中文。 */
  assert.equal(displayWidth('abcd'), 4);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中a'), 3);
  assert.equal(displayWidth(''), 0);

  const cn = shortenPath('/Users/u/a/中文项目目录名称很长啊');
  const en = shortenPath('/Users/u/a/some-english-project-dir');
  assert.ok(displayWidth(cn) <= 34 && displayWidth(en) <= 34);
});

test('中间段能塞几段塞几段', () => {
  /* 只留最后一段太狠:同名的 build/ dist/ 到处都是,
     得看到上一层才认得出是哪个项目的。 */
  const out = shortenPath('/home/u/workspace/projects/backend/services/gateway/build');
  assert.match(out, /build$/, '最后一段必须在');
  assert.match(out, /…/, '这条确实超宽了,应该省略中间');
  assert.match(out, /gateway/, '上一层也要尽量带上');
  assert.ok(displayWidth(out) <= 34);
});

test('单段超长路径不硬省,交给 CSS 截', () => {
  /* 没有可省的中间段时,返回 `~/…` 这种什么都看不出来的东西
     比截断更糟 —— 至少截断还能看见开头。 */
  const long = `/${'超长目录名'.repeat(6)}`;
  const out = shortenPath(long);
  assert.ok(!out.includes('…'), '不该省出一个没信息的结果');
});

test('空值和垃圾输入不炸', () => {
  for (const v of ['', null, undefined, '   ']) assert.equal(shortenPath(v), '~');
});

/* ---------------------------------------------- 接线 */

test('顶栏用缩短版,完整路径放 tooltip', () => {
  /* 缩短是为了好看,但完整路径不能没处看 —— 要往终端里粘的时候就得它。 */
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /title=\{`\$\{conv\.cwd \|\| '~'\}\\n\(点击复制\)`\}/);
  assert.match(chat, /\{shortenPath\(conv\.cwd\)\}/);
});

test('CSS 里 min-width: 0,否则 flex 子元素不肯收缩', () => {
  /* 这是 flex 布局的经典坑:不写 min-width: 0,
     再怎么设 overflow 都挤不动,照样会把模型选择器顶出去。 */
  const css = read('src/styles.css');
  const block = css.slice(css.indexOf('.conv-cwd {'), css.indexOf('}', css.indexOf('.conv-cwd {')));
  assert.match(block, /min-width: 0/);
  assert.match(block, /text-overflow: ellipsis/);
});
