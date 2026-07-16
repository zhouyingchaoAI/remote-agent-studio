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
  assert.match(read('src/App.jsx'), /TaskPanel/);
});
