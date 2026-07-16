const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('task approvals are persisted and carry the requested scope', () => {
  const store = read('src/store.js');
  assert.match(store, /createTaskApproval:\s*\(taskId, fields = \{\}\)/);
  assert.match(store, /resolveTaskApproval:\s*\(taskId, approvalId, decision\)/);
  assert.match(store, /status:\s*'pending'/);
  assert.match(store, /scope:\s*fields\.scope \|\| 'system'/);
  assert.match(store, /type:\s*'approval_requested'/);
  assert.match(store, /type:\s*'approval_resolved'/);
});

test('approval mode remains sandboxed at workspace level for both agents', () => {
  const session = read('electron/ssh/AgentSession.js');
  assert.match(session, /opts\.permissionMode === 'approval'/);
  assert.match(session, /permissionMode === 'approval' \? '--sandbox workspace-write'/);
  assert.match(session, /permissionMode === 'approval' \? '--permission-mode acceptEdits'/);
});

test('system elevation on a linked task creates an approval request before permission changes', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /createTaskApproval\(task\.id/);
  assert.match(chat, /updateTaskStatus\(task\.id, 'needs_approval'\)/);
  assert.match(chat, /if \(nextMode === 'system' && task\)/);
});

test('task panel exposes scoped approval preview, approval, rejection, and audit-linked elevation', () => {
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(panel, /pendingApprovals/);
  assert.match(panel, /onApprove/);
  assert.match(panel, /onReject/);
  assert.match(panel, /resolveTaskApproval\(task\.id, approvalId, 'approved'\)/);
  assert.match(panel, /审批请求/);
});
