const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) { return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'); }

test('store keeps a transient execution trace per conversation', () => {
  const store = read('src/store.js');
  for (const token of ['executionTraces: {}', 'startExecutionTrace:', 'appendExecutionTrace:', 'finishExecutionTrace:']) assert.match(store, new RegExp(token.replace(/[{}]/g, '\\$&')));
});

test('agent events update the live trace before being persisted as chat messages', () => {
  const app = read('src/App.jsx');
  assert.match(app, /startExecutionTrace\(convId/);
  assert.match(app, /appendExecutionTrace\(convId, msg\)/);
  assert.match(app, /finishExecutionTrace\(convId/);
});

test('chat renders an expandable live execution panel with command output and risk', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /ExecutionTrace/);
  assert.match(chat, /executionTrace/);
  assert.match(chat, /当前后台执行/);
  assert.match(chat, /event\.output/);
  assert.match(chat, /event\.riskLevel/);
});
