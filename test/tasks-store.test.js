const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('task records have isolated atomic persistence helpers', () => {
  const source = read('electron/store.js');

  assert.match(source, /const taskDir\s*=\s*\(\)\s*=>/);
  assert.match(source, /function loadTasks\s*\(\)/);
  assert.match(source, /function saveTasks\s*\(tasks\)/);
  assert.match(source, /function safeTaskId\s*\(id\)/);
  assert.match(source, /path\.join\(taskDir\(\), `\$\{safeTaskId\(task\.id\)\}\.json`\)/);
  assert.match(source, /\.tmp/);
});

test('task IPC is limited to listing and saving task records', () => {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');

  assert.match(main, /ipcMain\.handle\('tasks:list', \(\) => loadTasks\(\)\)/);
  assert.match(main, /ipcMain\.handle\('tasks:save', \(_e, tasks\) => \{ saveTasks\(tasks\); return true; \}\)/);
  assert.match(preload, /tasks:\s*\{\s*list: invoke\('tasks:list'\),\s*save: invoke\('tasks:save'\)\s*\}/);
});
