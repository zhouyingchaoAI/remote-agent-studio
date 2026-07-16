const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentSession } = require('../electron/ssh/AgentSession');

test('codex resumes by exact session id when available', () => {
  const session = new AgentSession(null, null, {
    agent: 'codex', cwd: '/workspace', permissionMode: 'workspace'
  });
  session.codexStarted = true;
  session.codexSessionId = 'thread-abc-123';

  const command = session.buildCommand('continue');

  assert.match(command, /resume 'thread-abc-123'/);
  assert.doesNotMatch(command, /resume --last/);
});

test('codex falls back to resume --last without a session id', () => {
  const session = new AgentSession(null, null, {
    agent: 'codex', cwd: '/workspace', permissionMode: 'workspace'
  });
  session.codexStarted = true;

  const command = session.buildCommand('continue');

  assert.match(command, /resume --last/);
});

test('switching model mid-conversation keeps -m before the resume subcommand', () => {
  const session = new AgentSession(null, null, {
    agent: 'codex', cwd: '/workspace', permissionMode: 'workspace', model: 'gpt-5.6-terra'
  });
  session.codexStarted = true;
  session.codexSessionId = 'thread-abc-123';

  const command = session.buildCommand('continue');

  assert.match(command, /-m 'gpt-5\.6-terra'/);
  assert.ok(command.indexOf("-m 'gpt-5.6-terra'") < command.indexOf('resume'), 'model flag must precede resume');
  assert.match(command, /resume 'thread-abc-123'/);
});

test('codex captures session id from new thread.started events', () => {
  const session = new AgentSession(null, null, { agent: 'codex', permissionMode: 'workspace' });
  session.imagePaths = [];
  session._parseLine(JSON.stringify({ type: 'thread.started', thread_id: 't-999' }));
  assert.equal(session.codexSessionId, 't-999');
});

test('codex captures session id from legacy session_configured events', () => {
  const session = new AgentSession(null, null, { agent: 'codex', permissionMode: 'workspace' });
  session.imagePaths = [];
  session._parseLine(JSON.stringify({ msg: { type: 'session_configured', session_id: 's-42' } }));
  assert.equal(session.codexSessionId, 's-42');
});
