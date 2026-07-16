const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AgentSession } = require('../electron/ssh/AgentSession');

function session(opts = {}) {
  return new AgentSession(null, null, { agent: 'codex', cwd: '', ...opts });
}

test('Codex uses workspace-write unless system mode is explicitly enabled', () => {
  assert.match(session().buildCommand('status'), /--sandbox workspace-write/);
  assert.doesNotMatch(session().buildCommand('status'), /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(
    session({ permissionMode: 'system' }).buildCommand('status'),
    /--dangerously-bypass-approvals-and-sandbox/
  );
});

test('AgentSession keeps legacy autoApprove conversations in system mode', () => {
  assert.match(
    session({ autoApprove: true }).buildCommand('status'),
    /--dangerously-bypass-approvals-and-sandbox/
  );
});

test('Docker permission errors emit a system-mode hint only in workspace mode', () => {
  const workspace = session();
  const workspaceMessages = [];
  workspace.on('message', (message) => workspaceMessages.push(message));
  workspace._parseCodex({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'docker ps',
      aggregated_output: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'
    }
  });

  const system = session({ permissionMode: 'system' });
  const systemMessages = [];
  system.on('message', (message) => systemMessages.push(message));
  system._parseCodex({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      command: 'docker ps',
      aggregated_output: 'operation not permitted'
    }
  });

  assert.ok(workspaceMessages.some((message) => message.kind === 'permission_hint'));
  assert.ok(workspaceMessages.some((message) => /\/var\/run\/docker\.sock/.test(message.text)));
  assert.ok(!systemMessages.some((message) => message.kind === 'permission_hint'));

  const unrelated = session();
  const unrelatedMessages = [];
  unrelated.on('message', (message) => unrelatedMessages.push(message));
  unrelated._parseCodex({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'mount', aggregated_output: 'operation not permitted' }
  });
  assert.ok(!unrelatedMessages.some((message) => message.kind === 'permission_hint'));
});

test('store normalizes legacy permission mode and persists mode updates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');

  assert.match(source, /function normalizePermissionMode\(value\)/);
  assert.match(source, /autoApprove === true\s*\?\s*'system'\s*:\s*'workspace'/);
  assert.match(source, /permissionMode:\s*normalizePermissionMode\(opts\)/);
  assert.match(source, /updateConversationPermission:\s*\(convId, mode\)/);
  assert.match(source, /permissionMode:\s*normalizePermissionMode\(mode\)/);
  assert.match(source, /normalizeConversation\(c\)/);
});
