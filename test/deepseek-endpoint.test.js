const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, execSync } = require('child_process');
const path = require('path');
const {
  normalizeBaseUrl, normalizeEnvKey, normalizeModel, resolveEndpoint,
  deepseekEnvPosix, deepseekEnvPowershell, resolveDeepseekModel,
  DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL
} = require('../electron/ssh/deepseek');

/* 用户要用自建 new-api 中转跑 DeepSeek。中转站在根路径提供 /v1/messages,
 * 官方则在 /anthropic 子路径 —— 写死任何一种另一种就用不了。 */

test('不配时保持官方端点(不破坏既有行为)', () => {
  const e = resolveEndpoint();
  assert.equal(e.baseUrl, DEEPSEEK_BASE_URL);
  assert.equal(e.model, DEEPSEEK_DEFAULT_MODEL);
  assert.equal(e.envKey, 'DEEPSEEK_API_KEY');
});

test('自建中转:填根地址即可,末尾斜杠被去掉', () => {
  const e = resolveEndpoint({ baseUrl: 'http://122.51.25.98:3000/', model: 'deepseek-chat' });
  assert.equal(e.baseUrl, 'http://122.51.25.98:3000');
  assert.equal(e.model, 'deepseek-chat');
  // 没单独配轻量模型时跟随主模型 —— 中转站常常只挂一个
  assert.equal(e.flashModel, 'deepseek-chat');
});

test('端点地址严格校验:挡住会被拼进 shell 的注入载体', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic');
  assert.equal(normalizeBaseUrl('http://1.2.3.4:3000'), 'http://1.2.3.4:3000');
  for (const bad of [
    '', '   ',
    'http://x.com; rm -rf /',
    'http://x.com"$(whoami)',
    "http://x.com'",
    'http://x.com `id`',
    'ftp://x.com',
    'javascript:alert(1)',
    'http://x.com/a b'
  ]) {
    assert.throws(() => normalizeBaseUrl(bad), undefined, `应拒绝: ${JSON.stringify(bad)}`);
  }
});

test('环境变量名与模型名同样校验', () => {
  assert.equal(normalizeEnvKey(''), 'DEEPSEEK_API_KEY');
  assert.equal(normalizeEnvKey('MY_KEY'), 'MY_KEY');
  assert.throws(() => normalizeEnvKey('my key'), /不合法/);
  assert.throws(() => normalizeEnvKey('K;rm -rf /'), /不合法/);

  // 官方模型名带方括号,必须放行
  assert.equal(normalizeModel('deepseek-v4-pro[1m]', 'x'), 'deepseek-v4-pro[1m]');
  assert.throws(() => normalizeModel('a$(id)', 'x'), /不合法/);
});

/* ---------------- 生成的 shell 片段 ---------------- */

test('posix env 片段指向配置的端点,且 key 走环境变量而不是内联', () => {
  const env = deepseekEnvPosix({ baseUrl: 'http://122.51.25.98:3000', model: 'deepseek-chat' });
  assert.ok(env.includes('http://122.51.25.98:3000'));
  assert.ok(env.includes('ANTHROPIC_AUTH_TOKEN="${DEEPSEEK_API_KEY:-}"'), 'key 必须由环境变量提供');
  assert.ok(env.includes('unset ANTHROPIC_API_KEY'), '要清掉可能存在的官方 key,否则鉴权会串');
  // 绝不能出现任何 sk- 开头的真实密钥
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(env), 'env 片段里不该内联任何密钥');
});

test('自定义环境变量名会被正确引用', () => {
  const env = deepseekEnvPosix({ baseUrl: 'http://a.b:1/', envKey: 'MY_RELAY_KEY' });
  assert.ok(env.includes('${MY_RELAY_KEY:-}'));
});

test('生成的片段在真实 shell 里可执行且变量正确', () => {
  const env = deepseekEnvPosix({
    baseUrl: 'http://122.51.25.98:3000', model: 'deepseek-chat', flashModel: 'deepseek-chat'
  });
  const out = execFileSync('sh', ['-c',
    `DEEPSEEK_API_KEY=dummy-token; ${env} echo "$ANTHROPIC_BASE_URL|$ANTHROPIC_AUTH_TOKEN|$ANTHROPIC_DEFAULT_HAIKU_MODEL"`
  ], { encoding: 'utf8' }).trim();
  assert.equal(out, 'http://122.51.25.98:3000|dummy-token|deepseek-chat');
});

test('powershell 片段同样跟随配置', () => {
  const env = deepseekEnvPowershell({ baseUrl: 'http://a.b:1', flashModel: 'm1', envKey: 'K1' });
  assert.ok(env.includes("$env:ANTHROPIC_BASE_URL='http://a.b:1'"));
  assert.ok(env.includes('$env:ANTHROPIC_AUTH_TOKEN=$env:K1'));
});

test('对话里显式指定的模型优先于端点默认模型', () => {
  const cfg = { baseUrl: 'http://a.b:1', model: 'deepseek-chat' };
  assert.equal(resolveDeepseekModel('deepseek-reasoner', cfg), 'deepseek-reasoner');
  assert.equal(resolveDeepseekModel('', cfg), 'deepseek-chat');
  assert.equal(resolveDeepseekModel(''), DEEPSEEK_DEFAULT_MODEL);
  // 配置坏掉时不能把整轮对话炸掉,退回官方默认
  assert.equal(resolveDeepseekModel('', { baseUrl: '非法' }), DEEPSEEK_DEFAULT_MODEL);
});

test('AgentSession 把端点配置透传给 env 生成', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron/ssh/AgentSession.js'), 'utf8');
  assert.match(src, /deepseekEnvPosix\(this\.opts\.deepseekEndpoint\)/);
  assert.match(src, /deepseekEnvPowershell\(this\.opts\.deepseekEndpoint\)/);

  const main = fs.readFileSync(path.join(__dirname, '..', 'electron/main.js'), 'utf8');
  const injections = main.match(/deepseekEndpoint: loadSettings\(\)\.deepseekEndpoint/g) || [];
  assert.ok(injections.length >= 2, '桌面端与手机端两条创建路径都要注入');
});

test('仓库里没有任何真实密钥(用户曾在对话里贴过)', () => {
  const out = execSync(
    "git grep -lE 'sk-[A-Za-z0-9]{32,}' -- . ':!node_modules' ':!.worktrees' || true",
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' }
  ).trim();
  assert.equal(out, '', `这些文件里疑似有密钥:\n${out}`);
});

