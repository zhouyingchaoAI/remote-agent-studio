const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) { return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'); }

test('project contexts use isolated persisted records and narrow IPC', () => {
  const store = read('electron/store.js');
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');
  assert.match(store, /function loadProjects\s*\(\)/);
  assert.match(store, /function saveProjects\s*\(projects\)/);
  assert.match(main, /ipcMain\.handle\('projects:list'/);
  assert.match(main, /ipcMain\.handle\('projects:save'/);
  assert.match(preload, /projects:\s*\{\s*list: invoke\('projects:list'\),\s*save: invoke\('projects:save'\)\s*\}/);
});

test('conversations and task stages snapshot project rules and skills', () => {
  const store = read('src/store.js');
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(store, /projects: \{\}/);
  assert.match(store, /createProject:/);
  assert.match(store, /projectContext: opts\.projectContext \|\| null/);
  assert.match(store, /项目规则/);
  assert.match(store, /projectContext: fields\.projectContext \|\| null/);
  assert.match(panel, /projectContext: source\.projectContext/);
});

test('session setup can save and inherit a project context', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /selectedProjectId/);
  assert.match(chat, /saveProjectContext/);
  assert.match(chat, /projectContext/);
  assert.match(chat, /项目规则/);
});

test('queued work snapshots and restores project context before execution', () => {
  const chat = read('src/components/ChatPanel.jsx');
  const app = read('src/App.jsx');
  const store = read('src/store.js');
  assert.match(chat, /projectContext: conv\.projectContext/);
  assert.match(app, /projectContext: next\.projectContext/);
  assert.match(store, /opts\.projectContext \|\| conv\?\.projectContext/);
});
