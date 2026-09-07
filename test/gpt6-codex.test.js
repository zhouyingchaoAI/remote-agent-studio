const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentSession } = require('../electron/ssh/AgentSession');
const { codexReasoningFlag } = require('../electron/ssh/codexOptions');

test('Astra accepts max and migrates explicit legacy minimal to low', () => {
  assert.equal(codexReasoningFlag('max', 'gpt-6-astra'), '-c model_reasoning_effort=max');
  assert.equal(codexReasoningFlag('minimal', 'gpt-6-astra'), '-c model_reasoning_effort=low');
  assert.equal(codexReasoningFlag('minimal', 'custom-model'), '-c model_reasoning_effort=minimal');
  assert.equal(codexReasoningFlag('', 'gpt-6-astra'), '');
});

for (const isWindowsNative of [false, true]) {
  test(`GPT-6 model and effort survive first turn and resume (Windows=${isWindowsNative})`, () => {
    const session = new AgentSession({ isWindowsNative }, null, {
      agent: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max', permissionMode: 'workspace'
    });
    for (const id of [null, 'test-session']) {
      session.codexSessionId = id;
      const command = session.buildCommand('hello');
      assert.match(command, /-m 'gpt-6-astra'/);
      assert.match(command, /-c model_reasoning_effort=max/);
      assert.match(command, /--sandbox workspace-write/);
      if (id) assert.match(command, /resume 'test-session'/);
    }
  });
}
