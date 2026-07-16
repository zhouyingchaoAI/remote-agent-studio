const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('renderer store exposes task lifecycle actions and persistence', () => {
  const source = read('src/store.js');
  for (const token of ['tasks: {}', 'activeTaskByHost: {}', 'createTask:', 'updateTaskStatus:', 'recordTaskDelivery:', 'reviewTask:', 'export async function loadTasks']) {
    assert.match(source, new RegExp(token.replace(/[{}]/g, '\\$&')));
  }
  assert.match(source, /window\.api\.tasks\.save/);
});

test('application maps agent completion and failures into linked task status', () => {
  const source = read('src/App.jsx');
  assert.match(source, /recordTaskDelivery/);
  assert.match(source, /updateTaskStatus\([^)]*, 'review_ready'\)/);
  assert.match(source, /updateTaskStatus\([^)]*, 'failed'\)/);
});

test('task panel exposes delivery evidence and review actions', () => {
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(panel, /review_ready/);
  assert.match(panel, /Accept/);
  assert.match(panel, /Request changes/);
  assert.match(panel, /dangerousCommands/);
  assert.match(panel, /auditEvents/);
  assert.match(read('src/App.jsx'), /TaskPanel/);
});

test('task view includes host-level token and cost summary', () => {
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(panel, /用量概览/);
  assert.match(panel, /hostUsage/);
  assert.match(panel, /costUsd/);
});

test('running task can be stopped for human takeover from delivery view', () => {
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(panel, /停止并接管/);
  assert.match(panel, /window\.api\.agent\.cancel/);
  assert.match(panel, /'needs_input'/);
});

test('linked task starts only when its conversation sends work', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /createTask\(hostId, conv\.id/);
  assert.match(chat, /updateTaskStatus\(task\.id, 'running'\)/);
  assert.doesNotMatch(chat, /createTask\(hostId, conv\.id[\s\S]{0,220}updateTaskStatus\(next\.id, 'running'\)/);
});

test('permission elevation is retained in the linked task audit trail', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /permission_change/);
  assert.match(chat, /recordTaskDelivery/);
});

test('tool calls display their classified safety level inline', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /RISK_LABELS/);
  assert.match(chat, /m\.riskLevel/);
  assert.match(chat, /安全级别/);
});

test('local projects retain access to the task delivery view', () => {
  const app = read('src/App.jsx');
  assert.match(app, /t\.key === 'chat' \|\| t\.key === 'tasks' \|\| t\.key === 'setup'/);
  assert.match(app, /tab !== 'setup' && tab !== 'tasks' \? 'chat' : tab/);
});
