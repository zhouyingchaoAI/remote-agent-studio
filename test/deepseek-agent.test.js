const test = require('node:test');
const assert = require('node:assert');
const { AgentSession } = require('../electron/ssh/AgentSession');
const {
  DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_FLASH_MODEL,
  deepseekEnvPosix, resolveDeepseekModel
} = require('../electron/ssh/deepseek');

test('deepseek posix env points claude CLI at DeepSeek Anthropic endpoint', () => {
  const env = deepseekEnvPosix();
  assert.match(env, new RegExp(`ANTHROPIC_BASE_URL="${DEEPSEEK_BASE_URL}"`));
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
  assert.match(cmd, new RegExp(`ANTHROPIC_BASE_URL="${DEEPSEEK_BASE_URL}"`));
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

/* ---- 用户 2026-08-11 反馈的三连报错:TypeError → 上一轮仍在执行中 → TypeError ---- */

test('opts 显式传 null 不该炸(默认参数挡不住 null)', () => {
  const { AgentSession } = require('../electron/ssh/AgentSession');
  // 默认参数只在 undefined 时生效;null 会让 opts.permissionMode 抛 TypeError
  const s = new AgentSession({ isLocal: true }, null, null);
  assert.equal(s.opts.permissionMode, 'workspace');
});

test('构造命令失败不能把对话永久卡死', async () => {
  const { AgentSession } = require('../electron/ssh/AgentSession');
  // 端点地址为空 -> buildCommand 抛错(用户点了「用自建中转」预设但没填地址)
  const s = new AgentSession({ isLocal: true }, null, {
    agent: 'deepseek', deepseekEndpoint: { baseUrl: '', model: 'deepseek-chat' }
  });
  const msgs = [];
  s.on('message', (m) => msgs.push(m));

  await assert.rejects(() => s.send('hi'));
  // 关键:running 必须回到 false,否则后续每条消息都报「上一轮仍在执行中」
  assert.equal(s.running, false, '构造失败后 running 应保持 false');
  assert.ok(msgs.some((m) => m.kind === 'error' && /环境配置/.test(m.text)),
    '应给出可操作的提示,而不是只抛一个 TypeError');

  // 修好配置后应能正常构造,不需要重建会话
  s.opts.deepseekEndpoint = { baseUrl: 'http://203.0.113.10:3000', model: 'deepseek-chat' };
  assert.match(s.buildCommand('hi'), /203\.0\.113\.10:3000/);
});
