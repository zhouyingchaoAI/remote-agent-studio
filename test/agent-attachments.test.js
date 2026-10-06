const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentSession } = require('../electron/ssh/AgentSession');

const turn = {
  attachments: [
    { kind: 'image', remotePath: '/home/test/uploads/reference image.png', originalName: 'reference image.png' },
    { kind: 'file', remotePath: '/home/test/uploads/brief.md', originalName: 'brief.md' }
  ],
  artifactDir: '/home/test/.remote-agent-studio/artifacts/c1/m1'
};

test('codex places image flags before resume and includes file/artifact context', () => {
  const session = new AgentSession(null, null, {
    agent: 'codex', cwd: '/workspace', permissionMode: 'workspace'
  });
  session.codexStarted = true;
  session.codexSessionId = 'attachment-thread';

  const command = session.buildCommand('create a preview', turn);

  assert.match(command, /--image '\/home\/test\/uploads\/reference image\.png'/);
  assert.match(command, /--add-dir '\/home\/test\/\.remote-agent-studio\/artifacts\/c1\/m1'/);
  assert.ok(command.indexOf('--image') < command.indexOf("resume 'attachment-thread'"));
  assert.match(command, /\/home\/test\/uploads\/brief\.md/);
  assert.match(command, /\/home\/test\/\.remote-agent-studio\/artifacts\/c1\/m1/);
});

test('claude receives all attachment paths as prompt context without codex image flags', () => {
  const session = new AgentSession(null, null, {
    agent: 'claude', cwd: '/workspace', permissionMode: 'workspace'
  });

  const command = session.buildCommand('review these files', turn);

  assert.doesNotMatch(command, /--image/);
  assert.match(command, /\/home\/test\/uploads\/reference image\.png/);
  assert.match(command, /\/home\/test\/uploads\/brief\.md/);
  assert.match(command, /\/home\/test\/\.remote-agent-studio\/artifacts\/c1\/m1/);
});

test('structured agent events collect generated image paths for artifact discovery', () => {
  const session = new AgentSession(null, null, { agent: 'codex', permissionMode: 'workspace' });
  session.imagePaths = [];
  session._parseLine(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'imagegen', aggregated_output: 'saved /home/test/artifacts/final.png' }
  }));
  assert.deepEqual(session.imagePaths, ['/home/test/artifacts/final.png']);
});
