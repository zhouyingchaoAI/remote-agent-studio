const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) { return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'); }

test('desktop notifications are exposed through narrow IPC and task events', () => {
  assert.match(read('electron/main.js'), /ipcMain\.handle\('notifications:send'/);
  assert.match(read('electron/preload.js'), /notifications:\s*\{\s*send: invoke\('notifications:send'\)\s*\}/);
  const app = read('src/App.jsx');
  assert.match(app, /window\.api\.notifications\.send/);
  assert.match(app, /交付待验收/);
});

test('watch mode is explicit, read-only, and disables message submission', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /watchMode/);
  assert.match(chat, /只读监督/);
  assert.match(chat, /disabled=\{watchMode/);
});

test('automation pilot stops before non-read tool activity', () => {
  const app = read('src/App.jsx');
  assert.match(app, /riskLevel !== 'read'/);
  assert.match(app, /低风险自动化已暂停/);
});

test('approval links deep-link into the local task inbox without a remote relay', () => {
  assert.match(read('electron/main.js'), /setAsDefaultProtocolClient\('remote-agent-studio'\)/);
  assert.match(read('electron/preload.js'), /onOpen: on\('task:open'\)/);
  assert.match(read('src/App.jsx'), /window\.api\.taskLinks\.onOpen/);
  assert.match(read('src/components/TaskPanel.jsx'), /remote-agent-studio:\/\/task\//);
});
