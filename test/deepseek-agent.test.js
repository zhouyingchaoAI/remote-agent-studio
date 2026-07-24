const test = require('node:test');
const assert = require('node:assert');
const { AgentSession } = require('../electron/ssh/AgentSession');
const {
  DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_FLASH_MODEL,
  deepseekEnvPosix, resolveDeepseekModel
} = require('../electron/ssh/deepseek');

test('deepseek posix env points claude CLI at DeepSeek Anthropic endpoint', () => {
  const env = deepseekEnvPosix();
  assert.match(env, new RegExp(`ANTHROPIC_BASE_URL=${DEEPSEEK_BASE_URL}`));
  assert.match(env, /unset ANTHROPIC_API_KEY/);
  assert.match(env, /ANTHROPIC_AUTH_TOKEN="\$\{DEEPSEEK_API_KEY:-\}"/);
  assert.match(env, /CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"/);
});

test('resolveDeepseekModel falls back to v4-pro and respects explicit model', () => {
  assert.equal(resolveDeepseekModel(''), DEEPSEEK_DEFAULT_MODEL);
  assert.equal(resolveDeepseekModel(null), DEEPSEEK_DEFAULT_MODEL);
  assert.equal(resolveDeepseekModel(DEEPSEEK_FLASH_MODEL), DEEPSEEK_FLASH_MODEL);
});

test('deepseek buildCommand (posix) reuses claude pipeline with injected env and default model', () => {
  const session = new AgentSession(null, null, {
    agent: 'deepseek', cwd: '/workspace', permissionMode: 'workspace'
  });
  const cmd = session.buildCommand('hello');
  assert.match(cmd, /claude -p --output-format stream-json/);
  assert.match(cmd, new RegExp(`ANTHROPIC_BASE_URL=${DEEPSEEK_BASE_URL}`));
  // env 注入必须在 ~/.remote-agent-env.sh 之后(DEEPSEEK_API_KEY 来源)
  assert.ok(cmd.indexOf('.remote-agent-env.sh') < cmd.indexOf('ANTHROPIC_BASE_URL'));
  assert.match(cmd, /--model 'deepseek-v4-pro\[1m\]'/);
  assert.match(cmd, /--permission-mode acceptEdits/);
});

test('deepseek buildCommand honors user-selected model and resume', () => {
  const session = new AgentSession(null, null, {
    agent: 'deepseek', cwd: '/workspace', permissionMode: 'system', model: DEEPSEEK_FLASH_MODEL
  });
  session.claudeSessionId = 'sess-123';
  const cmd = session.buildCommand('continue');
  assert.match(cmd, /--model 'deepseek-v4-flash'/);
  assert.match(cmd, /--resume 'sess-123'/);
  assert.match(cmd, /--dangerously-skip-permissions/);
});

test('deepseek buildCommand (windows native) injects powershell env', () => {
  const session = new AgentSession({ isWindowsNative: true }, null, {
    agent: 'deepseek', cwd: 'C:\\work', permissionMode: 'workspace'
  });
  const cmd = session.buildCommand('hello');
  assert.match(cmd, /claude\.cmd -p/);
  assert.match(cmd, new RegExp(`\\$env:ANTHROPIC_BASE_URL='${DEEPSEEK_BASE_URL}'`));
  assert.match(cmd, /\$env:ANTHROPIC_AUTH_TOKEN=\$env:DEEPSEEK_API_KEY/);
  assert.match(cmd, /--model 'deepseek-v4-pro\[1m\]'/);
});

test('deepseek events go through the claude stream-json parser', () => {
  const session = new AgentSession(null, null, { agent: 'deepseek', permissionMode: 'workspace' });
  const got = [];
  session.on('message', (m) => got.push(m));
  session._parseLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'ds-1' }));
  session._parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] }
  }));
  assert.equal(session.claudeSessionId, 'ds-1');
  assert.deepEqual(got.map((m) => m.kind), ['text']);
});

test('codex/claude commands stay free of deepseek env injection', () => {
  for (const agent of ['codex', 'claude']) {
    const session = new AgentSession(null, null, { agent, cwd: '/w', permissionMode: 'workspace' });
    assert.doesNotMatch(session.buildCommand('hi'), /ANTHROPIC_BASE_URL/);
  }
});
