const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('failed and paused tasks can be resumed with an auditable retry record', () => {
  const store = read('src/store.js');
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(store, /retryTask:\s*\(/);
  assert.match(store, /type:\s*'task_retry'/);
  assert.match(store, /retryCount/);
  assert.match(panel, /onRetry/);
  assert.match(panel, /retryTask/);
  assert.match(panel, /\['failed', 'needs_input', 'changes_requested'\]\.includes\(task\.status\)/);
});
