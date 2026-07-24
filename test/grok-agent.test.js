const test = require('node:test');
const assert = require('node:assert');
const { AgentSession } = require('../electron/ssh/AgentSession');
const {
  GROK_DEFAULT_MODEL, grokPresetSpecs, parseGrokSpec, buildGrokConfigBlock,
  BLOCK_BEGIN, BLOCK_END
} = require('../electron/ssh/grokProviders');

test('grok provider registry covers domestic providers with env keys', () => {
  const specs = grokPresetSpecs();
  assert.ok(specs.includes('deepseek/deepseek-v4-pro'));
  assert.ok(specs.includes('glm/glm-5'));
  assert.ok(specs.includes('kimi/kimi-k2.5'));
  assert.ok(specs.includes('qwen/qwen3.5-coder'));
});

test('parseGrokSpec maps provider/model to sanitized alias, passes through raw aliases', () => {
  const p = parseGrokSpec('deepseek/deepseek-v4-pro');
  assert.equal(p.provider, 'deepseek');
  assert.equal(p.modelId, 'deepseek-v4-pro');
  assert.equal(p.alias, 'deepseek-deepseek-v4-pro');
  // 无前缀 / 未知 provider:视为用户自配别名,原样透传
  assert.equal(parseGrokSpec('my-own-alias').alias, 'my-own-alias');
  assert.equal(parseGrokSpec('').alias, parseGrokSpec(GROK_DEFAULT_MODEL).alias);
});

test('buildGrokConfigBlock emits managed markers, env_key auth and preset spec strings', () => {
  const block = buildGrokConfigBlock(['glm/glm-5.2']);
  assert.ok(block.startsWith(BLOCK_BEGIN));
  assert.ok(block.endsWith(BLOCK_END));
  assert.match(block, /\[model\."deepseek-deepseek-v4-pro"\]/);
  assert.match(block, /base_url = "https:\/\/api\.deepseek\.com\/v1"/);
  assert.match(block, /env_key = "DEEPSEEK_API_KEY"/);
  assert.match(block, /\[model\."glm-glm-5\.2"\]/);
  assert.match(block, /env_key = "ZHIPU_API_KEY"/);
  // 不落 api_key 明文
  assert.doesNotMatch(block, /api_key/);
});

test('buildGrokConfigBlock renders GUI custom model objects (relay endpoint + backend)', () => {
  const block = buildGrokConfigBlock([
    { id: 'gm_1', label: '我的中转站', model: 'deepseek-v4-pro', baseUrl: 'https://relay.example.com/v1', apiBackend: 'chat_completions', envKey: 'MY_RELAY_API_KEY' },
    { id: 'gm_2', label: 'Claude 直连', model: 'claude-opus-4-6', baseUrl: 'https://api.anthropic.com/v1', apiBackend: 'messages', envKey: 'ANTHROPIC_API_KEY' }
  ]);
  assert.match(block, /\[model\."custom-我的中转站"\]/);
  assert.match(block, /base_url = "https:\/\/relay\.example\.com\/v1"/);
  assert.match(block, /env_key = "MY_RELAY_API_KEY"/);
  // chat_completions 为默认协议,不写 api_backend
  const relaySection = block.slice(block.indexOf('custom-我的中转站'), block.indexOf('custom-Claude'));
  assert.doesNotMatch(relaySection, /api_backend/);
  // 非默认协议显式写出
  assert.match(block, /api_backend = "messages"/);
  // 依旧不落明文 key
  assert.doesNotMatch(block, /api_key\s*=/);
});

test('custom model without env_key/baseUrl is skipped safely', () => {
  const block = buildGrokConfigBlock([{ id: 'x', label: '半成品', model: '' }]);
  assert.doesNotMatch(block, /半成品/);
});

test('grok buildCommand (posix): headless streaming-json, yolo + workspace sandbox, new session uuid', () => {
  const session = new AgentSession(null, null, {
    agent: 'grok', cwd: '/workspace', permissionMode: 'workspace'
  });
  const cmd = session.buildCommand('hello');
  assert.match(cmd, /grok --output-format streaming-json/);
  assert.match(cmd, /-m 'deepseek-deepseek-v4-pro'/);
  assert.match(cmd, /--yolo --sandbox workspace/);
  assert.match(cmd, /-s '[0-9a-f-]{36}'/);
  assert.match(cmd, /-p 'hello'/);
  assert.equal(session.pendingGrokSessionId.length, 36);
  // grok 安装目录已进 PATH
  assert.match(cmd, /\.grok\/bin/);
});

test('grok buildCommand resumes confirmed session and honors system mode + custom model', () => {
  const session = new AgentSession(null, null, {
    agent: 'grok', cwd: '/workspace', permissionMode: 'system', model: 'kimi/kimi-k2.5'
  });
  session.grokSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const cmd = session.buildCommand('continue');
  assert.match(cmd, /--resume 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'/);
  assert.match(cmd, /-m 'kimi-kimi-k2\.5'/);
  assert.match(cmd, /--yolo/);
  assert.doesNotMatch(cmd, /--sandbox/);
});

test('grok pending session id is committed only after successful turn', () => {
  const session = new AgentSession(null, null, { agent: 'grok', permissionMode: 'workspace' });
  session.buildCommand('hi');
  const pending = session.pendingGrokSessionId;
  assert.ok(pending && !session.grokSessionId);
  // 模拟 send() 收尾逻辑
  session.grokSessionId = null;
  if (session.pendingGrokSessionId && !session.grokSessionId) session.grokSessionId = session.pendingGrokSessionId;
  session.pendingGrokSessionId = null;
  assert.equal(session.grokSessionId, pending);
});

test('grok streaming-json parser handles common event shapes defensively', () => {
  const session = new AgentSession(null, null, { agent: 'grok', permissionMode: 'workspace' });
  const got = [];
  session.on('message', (m) => got.push(m));

  session._parseLine(JSON.stringify({ type: 'session.started', session_id: 'gs-1' }));
  session._parseLine(JSON.stringify({ type: 'text.delta', delta: '你' }));
  session._parseLine(JSON.stringify({ type: 'reasoning.delta', delta: '思考中' }));
  session._parseLine(JSON.stringify({ type: 'tool.start', tool_name: 'run_terminal_cmd', input: { command: 'ls -la' } }));
  session._parseLine(JSON.stringify({ type: 'tool.result', tool_name: 'run_terminal_cmd', output: 'total 0' }));
  session._parseLine(JSON.stringify({ type: 'error', message: '配额不足' }));
  session._parseLine(JSON.stringify({
    type: 'result', text: '完成', stopReason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 }, cost: 0.01
  }));

  assert.equal(session.grokSessionId, 'gs-1');
  const kinds = got.map((m) => m.kind);
  assert.deepEqual(kinds, ['text_delta', 'reasoning_delta', 'tool', 'tool_output', 'error', 'usage', 'result']);
  assert.equal(got[2].detail, 'ls -la');
  assert.equal(got[5].inputTokens, 100);
  assert.equal(got[6].text, '完成');
});

test('grok parser stays silent on unknown events instead of leaking raw noise', () => {
  const session = new AgentSession(null, null, { agent: 'grok', permissionMode: 'workspace' });
  const got = [];
  session.on('message', (m) => got.push(m));
  session._parseLine(JSON.stringify({ type: 'telemetry.ping', seq: 1 }));
  assert.equal(got.length, 0);
});

test('windows native grok command uses powershell quoting', () => {
  const session = new AgentSession({ isWindowsNative: true }, null, {
    agent: 'grok', cwd: 'C:\\work', permissionMode: 'workspace'
  });
  const cmd = session.buildCommand("it's here");
  assert.match(cmd, /& grok --output-format streaming-json/);
  assert.match(cmd, /-p 'it''s here'/);
});
