const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 用户:一台主机想同时开两个以上对话窗口。
 * 后端本来就按 convId 分开、切走也照跑 —— 缺的只是「同时可见」。 */

test('分屏状态与主对话分开存,不动 activeConvByHost 的语义', () => {
  const store = read('src/store.js');
  assert.match(store, /extraConvByHost: \{\}/);
  // 这样所有读 activeConvByHost 的地方行为不变,不必为分屏改一堆无关代码
  assert.match(store, /这里只放"再多开的那几个"/);
});

test('同一个对话不能被开两次 —— 两个面板会互相把对方掐死', () => {
  const store = read('src/store.js');
  assert.match(store, /if \(!convId \|\| convId === primary \|\| cur\.includes\(convId\)\) return \{\}/);
  /* 主进程 agent:start 会 cancel 掉同 convId 的现有会话,
     所以同一对话渲染两次 = 两个面板轮流掐死对方 */
  assert.match(store, /互相把对方掐死/);
});

test('面板数有上限,且算上主面板', () => {
  const store = read('src/store.js');
  assert.match(store, /export const MAX_PANES = 4/);
  assert.match(store, /if \(1 \+ cur\.length \+ 1 > MAX_PANES\) return \{\}/);
  // 每个对话占一条 SSH 通道,开太多会把远端 MaxSessions 吃光
  assert.match(store, /MaxSessions/);
});

test('关主面板时把第一个分屏顶上来,不能整片空掉', () => {
  const store = read('src/store.js');
  const fn = store.slice(store.indexOf('closeSplit:'), store.indexOf('setActiveConv:'));
  assert.match(fn, /const \[next, \.\.\.rest\] = cur/);
  assert.match(fn, /\[hostId\]: next \|\| null/);
});

test('换主对话时清掉分屏 —— 否则旁边挂着上一组,极易对错窗口发消息', () => {
  const store = read('src/store.js');
  assert.match(store, /extraConvByHost: \{ \.\.\.s\.extraConvByHost, \[hostId\]: \[\] \}/);
  assert.match(store, /极易对错窗口发消息/);
});

test('删除对话要从分屏里摘掉,否则留一个空壳面板', () => {
  const store = read('src/store.js');
  assert.match(store, /会渲染成一个空壳/);
  assert.match(store, /extraConvByHost: extras/);
});

test('分屏渲染:一个时走原路径,多个才铺网格', () => {
  const ui = read('src/components/ChatPanel.jsx');
  assert.match(ui, /if \(paneConvs\.length === 1\) \{/);
  assert.match(ui, /chat-split panes-\$\{Math\.min\(paneConvs\.length, MAX_PANES\)\}/);
  // 面板里已删除的对话要滤掉
  assert.match(ui, /\.map\(\(id\) => conversations\[id\]\)\.filter\(Boolean\)/);
});

test('只能并排同主机的对话', () => {
  const ui = read('src/components/ChatPanel.jsx');
  assert.match(ui, /c\.hostId === hostId && !onScreen\.has\(c\.id\)/);
  // 跨主机并排看没意义:cwd 与引擎都对不上,还容易对着错的机器发指令
  assert.match(ui, /很容易对着错的机器发指令/);
});

test('关本屏不等于删对话', () => {
  const ui = read('src/components/ChatPanel.jsx');
  assert.match(ui, /关掉这一屏\(对话本身不会删除,后台照常跑\)/);
  assert.match(ui, /closeSplit\(hostId, conv\.id\)/);
});

test('CSS 覆盖 2/3/4 个面板的布局', () => {
  const css = read('src/styles.css');
  for (const n of [2, 3, 4]) {
    assert.match(css, new RegExp(`\\.chat-split\\.panes-${n} \\{`), `缺 panes-${n}`);
  }
  // 分屏时顶栏空间小,得允许换行
  assert.match(css, /\.chat-pane \.chat-header \{ flex-wrap: wrap/);
});
