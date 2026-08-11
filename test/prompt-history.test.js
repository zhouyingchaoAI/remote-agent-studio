const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// src/promptHistory.js 是 ESM,测试里用轻量转换后加载(避免为单文件引入构建依赖)
function loadPromptHistory() {
  const file = path.join(__dirname, '..', 'src', 'promptHistory.js');
  const src = fs.readFileSync(file, 'utf8').replace(/export function/g, 'function');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(
    `${src}\nmodule.exports = { buildPromptHistory, stepPromptHistory };`,
    sandbox
  );
  return sandbox.module.exports;
}
const { buildPromptHistory, stepPromptHistory } = loadPromptHistory();

test('buildPromptHistory keeps newest first, drops agent/empty and consecutive duplicates', () => {
  const history = buildPromptHistory([
    { role: 'user', text: '第一条' },
    { role: 'agent', text: '模型回复' },
    { role: 'user', text: '  ' },
    { role: 'user', text: '第二条' },
    { role: 'user', text: '第二条' },   // 连续重复 -> 合并
    { role: 'user', text: '第三条' }
  ]);
  assert.deepEqual(history, ['第三条', '第二条', '第一条']);
});

test('ArrowUp walks back through history and stores the draft', () => {
  const history = ['最近', '较早', '最早'];
  let state = { index: null, draft: '' };

  let r = stepPromptHistory(state, history, 1, '写了一半的草稿');
  assert.ok(r.handled);
  assert.equal(r.value, '最近');
  assert.equal(r.draft, '写了一半的草稿'); // 草稿被保存
  state = { index: r.index, draft: r.draft };

  r = stepPromptHistory(state, history, 1, r.value);
  assert.equal(r.value, '较早');
  state = { index: r.index, draft: r.draft };

  r = stepPromptHistory(state, history, 1, r.value);
  assert.equal(r.value, '最早');
  state = { index: r.index, draft: r.draft };

  // 已到最早:仍消费按键但停在原地(不越界)
  r = stepPromptHistory(state, history, 1, r.value);
  assert.ok(r.handled);
  assert.equal(r.value, '最早');
  assert.equal(r.index, 2);
});

test('ArrowDown returns toward the newest and finally restores the draft', () => {
  const history = ['最近', '较早'];
  let state = { index: 1, draft: '我的草稿' };

  let r = stepPromptHistory(state, history, -1, '较早');
  assert.equal(r.value, '最近');
  state = { index: r.index, draft: r.draft };

  r = stepPromptHistory(state, history, -1, '最近');
  assert.ok(r.handled);
  assert.equal(r.index, null);
  assert.equal(r.value, '我的草稿'); // 草稿被还原
});

test('ArrowDown on a draft is not intercepted, and empty history never intercepts', () => {
  // 草稿态按 ↓ -> 交还给光标移动
  const onDraft = stepPromptHistory({ index: null, draft: '' }, ['x'], -1, '正在输入');
  assert.equal(onDraft.handled, false);
  assert.equal(onDraft.value, '正在输入');

  // 无历史时上下都不接管
  assert.equal(stepPromptHistory({ index: null, draft: '' }, [], 1, 'abc').handled, false);
  assert.equal(stepPromptHistory({ index: null, draft: '' }, [], -1, 'abc').handled, false);
});
