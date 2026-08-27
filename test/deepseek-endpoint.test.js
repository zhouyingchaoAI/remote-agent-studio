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
  const e = resolveEndpoint({ baseUrl: 'http://203.0.113.10:3000/', model: 'deepseek-chat' });
  assert.equal(e.baseUrl, 'http://203.0.113.10:3000');
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
  const env = deepseekEnvPosix({ baseUrl: 'http://203.0.113.10:3000', model: 'deepseek-chat' });
  assert.ok(env.includes('http://203.0.113.10:3000'));
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
    baseUrl: 'http://203.0.113.10:3000', model: 'deepseek-chat', flashModel: 'deepseek-chat'
  });
  const out = execFileSync('sh', ['-c',
    `DEEPSEEK_API_KEY=dummy-token; ${env} echo "$ANTHROPIC_BASE_URL|$ANTHROPIC_AUTH_TOKEN|$ANTHROPIC_DEFAULT_HAIKU_MODEL"`
  ], { encoding: 'utf8' }).trim();
  assert.equal(out, 'http://203.0.113.10:3000|dummy-token|deepseek-chat');
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
  /* 除了模型 API key,现在还处理 GitHub 凭据,守卫一并覆盖它的形状。
     测试样本一律拼接构造,不要写成整串字面量。 */
  const out = execSync(
    "git grep -lE 'sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'"
    + " -- . ':!node_modules' ':!.worktrees' || true",
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' }
  ).trim();
  assert.equal(out, '', `这些文件里疑似有密钥:\n${out}`);
});


/* ---------------- 中转站配置串导入 ---------------- */

const { parseRelayConfig, maskKey } = require('../electron/ssh/deepseek');

test('解析 new-api 配置串:取出地址与密钥', () => {
  const r = parseRelayConfig(
    '{"_type":"newapi_channel_conn","key":"sk-AAAABBBBCCCCDDDDEEEEFFFF","url":"http://1.2.3.4:3000"}'
  );
  assert.equal(r.baseUrl, 'http://1.2.3.4:3000');
  assert.equal(r.key, 'sk-AAAABBBBCCCCDDDDEEEEFFFF');
});

test('兼容常见字段别名与末尾斜杠', () => {
  assert.equal(parseRelayConfig('{"base_url":"http://a.b:1/","api_key":"k1"}').baseUrl, 'http://a.b:1');
  assert.equal(parseRelayConfig('{"baseUrl":"http://a.b:1","token":"k2"}').key, 'k2');
});

test('不是合法 JSON 时宽松提取(用户常只粘一部分)', () => {
  const r = parseRelayConfig('渠道地址 http://5.6.7.8:3000 密钥 sk-1234567890ABCDEFGH 请妥善保管');
  assert.equal(r.baseUrl, 'http://5.6.7.8:3000');
  assert.equal(r.key, 'sk-1234567890ABCDEFGH');
});

test('缺地址或完全认不出时给出明确错误', () => {
  assert.throws(() => parseRelayConfig(''), /请粘贴/);
  assert.throws(() => parseRelayConfig('{"key":"sk-xxxxxxxxxxxxxxxxxx"}'), /没有 url/);
  assert.throws(() => parseRelayConfig('一段无关文字'), /没认出/);
});

test('配置串里的非法地址同样被挡下', () => {
  assert.throws(() => parseRelayConfig('{"url":"http://a.b; rm -rf /","key":"k"}'), /不合法/);
});

test('脱敏只留头尾,足够辨认又不泄漏', () => {
  const masked = maskKey('sk-AAAABBBBCCCCDDDDEEEEFFFF');
  assert.equal(masked, 'sk-AA…FFFF');
  assert.ok(!masked.includes('BBBBCCCC'));
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '****');
});

test('本机也能写 API Key(此前只对远程开放,本地项目等于没入口)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/DeepseekEndpoint.jsx'), 'utf8');
  assert.ok(!/isLocal &&/.test(src), 'API Key 区块不该再被 isLocal 挡住');
  assert.match(src, /setEnvKey/);
});

/* ---------------- 端点实测 ---------------- */

const { buildEndpointProbeCommand, parseEndpointProbe } = require('../electron/ssh/deepseek');

test('探测命令打的是 /v1/messages,key 走环境变量不进命令行', () => {
  const cmd = buildEndpointProbeCommand({ baseUrl: 'http://203.0.113.10:3000', model: 'deepseek-chat' });
  assert.match(cmd, /v1\/messages/);
  assert.match(cmd, /anthropic-version: 2023-06-01/);
  // key 出现在命令行会被 ps 看到,必须用变量引用
  assert.match(cmd, /\$\{DEEPSEEK_API_KEY:-\}/);
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(cmd));
  // 官方端点要保留 /anthropic 子路径
  assert.match(buildEndpointProbeCommand({}), /api\.deepseek\.com\/anthropic\/v1\/messages/);
});

test('探测命令在真实 shell 里语法正确(不真发请求)', () => {
  const cmd = buildEndpointProbeCommand({ baseUrl: 'http://127.0.0.1:9', model: 'm' });
  // -n 只做语法检查,不执行
  execFileSync('sh', ['-n', '-c', cmd], { encoding: 'utf8' });
});

test('200 判为可用', () => {
  const r = parseEndpointProbe('RAS_HTTP=200\nRAS_BODY_BEGIN\n{"content":[{"text":"pong"}]}',
    { baseUrl: 'http://a.b:1', model: 'deepseek-chat' });
  assert.equal(r.ok, true);
  assert.match(r.message, /deepseek-chat/);
});

test('404 要说清是路径问题还是中转站不支持 Anthropic 协议', () => {
  const r = parseEndpointProbe('RAS_HTTP=404\nRAS_BODY_BEGIN\n{"error":"path not found"}', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /根地址/);
  assert.match(r.message, /Anthropic 协议/);
});

test('401/403 指向 API Key,而不是笼统说失败', () => {
  for (const code of [401, 403]) {
    const r = parseEndpointProbe(`RAS_HTTP=${code}\nRAS_BODY_BEGIN\nunauthorized`, {});
    assert.equal(r.ok, false);
    assert.match(r.message, /API Key/);
  }
});

test('连不上(code 0)提示查地址与代理', () => {
  const r = parseEndpointProbe('RAS_HTTP=000\nRAS_BODY_BEGIN\n', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /代理/);
});

test('模型名错单独识别出来', () => {
  const r = parseEndpointProbe('RAS_HTTP=400\nRAS_BODY_BEGIN\n{"error":{"message":"model not found"}}',
    { baseUrl: 'http://a.b:1', model: 'wrong-name' });
  assert.equal(r.ok, false);
  assert.match(r.message, /模型名可能不对/);
  assert.match(r.message, /wrong-name/);
});

/* ---------------- 拉取模型列表 ---------------- */

const { buildModelListCommand, parseModelList } = require('../electron/ssh/deepseek');

test('官方端点要退回根域名问 /v1/models(anthropic 子路径下没有这个接口)', () => {
  const cmd = buildModelListCommand({});   // 默认 https://api.deepseek.com/anthropic
  assert.match(cmd, /api\.deepseek\.com\/anthropic\/v1\/models/);
  assert.match(cmd, /api\.deepseek\.com\/v1\/models/, '应同时试根域名');
});

test('自建中转只问一次(根地址下就有 /v1/models)', () => {
  const cmd = buildModelListCommand({ baseUrl: 'http://203.0.113.10:3000', model: 'x' });
  const hits = cmd.match(/v1\/models/g) || [];
  assert.equal(hits.length, 1, '没有 /anthropic 后缀时不该重复请求');
  assert.match(cmd, /Authorization: Bearer \$\{DEEPSEEK_API_KEY:-\}/);
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(cmd));
});

test('从 /v1/models 响应里抽出模型 id,deepseek 排前面', () => {
  const body = JSON.stringify({
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
      { id: 'deepseek-chat', object: 'model' },
      { id: 'claude-3-5-sonnet', object: 'model' },
      { id: 'deepseek-reasoner', object: 'model' }
    ]
  });
  const out = parseModelList(`RAS_ROOT=http://a.b:1\n${body}`);
  assert.deepEqual(out.slice(0, 2), ['deepseek-chat', 'deepseek-reasoner']);
  assert.ok(out.includes('gpt-4o'));
  // object/owned_by 的值不该被当成模型名
  assert.ok(!out.includes('list'));
  assert.ok(!out.includes('model'));
});

test('同一模型在两次请求里重复出现只保留一个', () => {
  const dup = '{"data":[{"id":"deepseek-chat"}]} {"data":[{"id":"deepseek-chat"}]}';
  assert.deepEqual(parseModelList(dup), ['deepseek-chat']);
});

test('拿不到列表时返回空数组而不是抛错(端点可能不提供该接口)', () => {
  assert.deepEqual(parseModelList(''), []);
  assert.deepEqual(parseModelList('404 page not found'), []);
});

/* 用户反馈「都不会填了」「UI 逻辑混乱」—— 面板重做成线性四步 */

test('切来源时不清空已填的地址', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/DeepseekEndpoint.jsx'), 'utf8');
  const seg = src.slice(src.indexOf('const pickSource'), src.indexOf('const importRelay'));
  // 只有在「当前是官方地址」时才换成中转默认值,不无条件清空
  assert.match(seg, /form\.baseUrl === OFFICIAL\.baseUrl/);
});

test('官方模式不显示地址与模型框(没有可决策的东西就别摆出来)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/DeepseekEndpoint.jsx'), 'utf8');
  assert.match(src, /source === 'relay' && \(/, '地址/模型区应只在中转模式显示');
  assert.match(src, /你只需要下面填一个 API Key/);
});

test('保存/写 Key/测试合成一个按钮,用户不必记顺序', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/DeepseekEndpoint.jsx'), 'utf8');
  const seg = src.slice(src.indexOf('const saveAndTest'), src.indexOf('const needUrl'));
  assert.match(seg, /applySettings/);
  assert.match(seg, /setEnvKey/);
  assert.match(seg, /testEndpoint/);
  assert.match(src, /保存并测试/);
});

test('地址没填时按钮禁用并当场标出来', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/DeepseekEndpoint.jsx'), 'utf8');
  assert.match(src, /needUrl/);
  assert.match(src, /还没填/);
  assert.match(src, /input-missing/);
});
