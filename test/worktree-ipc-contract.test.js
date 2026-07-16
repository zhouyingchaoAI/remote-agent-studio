const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) { return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'); }

test('worktree creation is exposed through narrow IPC only', () => {
  assert.match(read('electron/main.js'), /ipcMain\.handle\('worktrees:create'/);
  assert.match(read('electron/preload.js'), /worktrees:\s*\{\s*create: invoke\('worktrees:create'\)\s*\}/);
});

test('worktree service creates an isolated branch and refuses invalid input', () => {
  const service = read('electron/git/WorktreeService.js');
  assert.match(service, /function createWorktree/);
  assert.match(service, /git -C/);
  assert.match(service, /worktree add -b/);
  assert.match(service, /safeSegment/);
  assert.match(service, /baseCwd is required/);
});
