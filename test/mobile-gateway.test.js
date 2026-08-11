const test = require('node:test');
const assert = require('node:assert');

const {
  generateToken, tokenMatches, bearerOf, route, createGateway, MAX_PROMPT
} = require('../electron/mobileGateway');
const { renderBridgeSkill } = require('../electron/mobileService');
const { parseSkill, lintSkill } = require('../electron/skills');

/* ------------------------------------------------------------ 鉴权 */

test('token 比较用定长算法,长度不同也不抛异常', () => {
  const t = generateToken();
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t + 'x', t), false);
  assert.equal(tokenMatches('短', t), false);
  assert.equal(tokenMatches('', t), false);
});

test('未配置 token 时一律拒绝(绝不能空 token 放行)', () => {
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('随便什么', ''), false);
  assert.equal(tokenMatches('', null), false);
});

test('generateToken 每次都不同且足够长', () => {
  const a = generateToken(), b = generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, `token 太短: ${a.length}`);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a), 'base64url 不应含 +/= 等需转义字符');
});

test('解析 Authorization 头', () => {
  assert.equal(bearerOf({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.equal(bearerOf({ headers: { authorization: 'bearer abc123' } }), 'abc123');
  assert.equal(bearerOf({ headers: { authorization: 'Basic abc' } }), '');
  assert.equal(bearerOf({ headers: {} }), '');
  assert.equal(bearerOf({}), '');
});

/* ------------------------------------------------------------ 路由 */

function fakeDeps(overrides = {}) {
  return {
    listHosts: async () => [{ id: 'h1', name: '开发机', status: 'connected' }],
    startTask: async ({ hostId }) => ({ taskId: 't1', hostId, status: 'running' }),
    getTask: async (id) => (id === 't1' ? { id: 't1', status: 'done', reply: '完成' } : null),
    listTasks: async () => [{ id: 't1', status: 'done' }],
    cancelTask: async () => ({ ok: true }),
    ...overrides
  };
}

test('健康检查与主机列表', async () => {
  const d = fakeDeps();
  assert.equal((await route({ method: 'GET', pathname: '/api/health' }, d)).status, 200);
  const hosts = await route({ method: 'GET', pathname: '/api/hosts' }, d);
  assert.equal(hosts.body.hosts[0].id, 'h1');
});

test('提交任务:缺参数给出可操作的错误', async () => {
  const d = fakeDeps();
  const noPrompt = await route({ method: 'POST', pathname: '/api/tasks', body: { hostId: 'h1' } }, d);
  assert.equal(noPrompt.status, 400);
  assert.match(noPrompt.body.error, /prompt/);

  const noHost = await route({ method: 'POST', pathname: '/api/tasks', body: { prompt: '跑测试' } }, d);
  assert.equal(noHost.status, 400);
  assert.match(noHost.body.error, /hostId/);

  const ok = await route({ method: 'POST', pathname: '/api/tasks', body: { hostId: 'h1', prompt: '跑测试' } }, d);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.taskId, 't1');
});

test('prompt 超长被拒(防止把整份日志灌进来)', async () => {
  const r = await route({
    method: 'POST', pathname: '/api/tasks',
    body: { hostId: 'h1', prompt: 'x'.repeat(MAX_PROMPT + 1) }
  }, fakeDeps());
  assert.equal(r.status, 400);
  assert.match(r.body.error, /过长/);
});

test('主机未连接时,startTask 的报错原样透出给手机端', async () => {
  const d = fakeDeps({ startTask: async () => { throw new Error('主机未连接'); } });
  const r = await route({ method: 'POST', pathname: '/api/tasks', body: { hostId: 'x', prompt: 'a' } }, d);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, '主机未连接');
});

test('查询与取消任务', async () => {
  const d = fakeDeps();
  const got = await route({ method: 'GET', pathname: '/api/tasks/t1' }, d);
  assert.equal(got.body.reply, '完成');

  const missing = await route({ method: 'GET', pathname: '/api/tasks/nope' }, d);
  assert.equal(missing.status, 404);

  const cancelled = await route({ method: 'POST', pathname: '/api/tasks/t1/cancel' }, d);
  assert.equal(cancelled.body.ok, true);
});

test('任务 id 里的路径穿越不会命中路由', async () => {
  const d = fakeDeps();
  for (const bad of ['/api/tasks/../../etc/passwd', '/api/tasks/a%2Fb', '/api/tasks/a b']) {
    const r = await route({ method: 'GET', pathname: bad }, d);
    assert.equal(r.status, 404, `应拒绝: ${bad}`);
  }
});

/* ------------------------------------------------------------ 真起服务 */

test('端到端:鉴权、只绑回环、正常调用', async () => {
  const token = generateToken();
  const { server, port } = await createGateway({ token, port: 0, deps: fakeDeps() });
  const base = `http://127.0.0.1:${port}`;
  try {
    // 只监听回环 —— 这个接口能在服务器上执行命令,绝不能对局域网开放
    assert.equal(server.address().address, '127.0.0.1');

    const noAuth = await fetch(`${base}/api/hosts`);
    assert.equal(noAuth.status, 401);

    // 注意:HTTP 头只能是 ASCII,这里不能用中文,否则 fetch 自己就先抛了
    const wrong = await fetch(`${base}/api/hosts`, { headers: { Authorization: 'Bearer wrong-token-guess' } });
    assert.equal(wrong.status, 401);

    // 长度相同但内容不同 —— 定长比较的真正考验
    const sameLen = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    const near = await fetch(`${base}/api/hosts`, { headers: { Authorization: `Bearer ${sameLen}` } });
    assert.equal(near.status, 401);

    const ok = await fetch(`${base}/api/hosts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).hosts[0].name, '开发机');

    const posted = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId: 'h1', prompt: '跑测试' })
    });
    assert.equal((await posted.json()).taskId, 't1');

    // 坏 JSON 应给 500 而不是把进程干掉
    const badJson = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{不是合法json'
    });
    assert.equal(badJson.status, 500);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* ------------------------------------------------------------ 桥接技能 */

test('桥接技能本身是合法的 SKILL.md(否则 OpenClaw 根本不会加载)', () => {
  const md = renderBridgeSkill({ port: 18790 });
  const r = lintSkill(md);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, 'remote-agent-studio');
  assert.deepEqual(r.warnings, [], r.warnings.join(';'));
});

test('桥接技能里不含明文 token,只教 agent 去读 .token 文件', () => {
  const md = renderBridgeSkill({ port: 18790 });
  assert.ok(md.includes('.token'), '应指引 agent 读取凭据文件');
  assert.ok(!/Bearer\s+[A-Za-z0-9_-]{20,}/.test(md), '不应内联任何真实 token');
  assert.ok(md.includes('127.0.0.1:18790'), '应带上实际端口');
});

test('桥接技能包含防注入提示(转发内容不可直接执行)', () => {
  const body = parseSkill(renderBridgeSkill()).body;
  assert.match(body, /不可信输入|先向用户确认/);
  assert.match(body, /dangerous/, '必须要求回报危险命令');
});
