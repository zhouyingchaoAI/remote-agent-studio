const test = require('node:test');
const assert = require('node:assert');
const { isTransientAgentError, describeTransient, retryDelayMs } = require('../electron/transientErrors');

test('识别截图里的真实中断:Connection closed mid-response', () => {
  const real = '{"type":"result","subtype":"success","is_error":true,"duration_ms":277102,'
    + '"result":"API Error: Connection closed mid-response. The response above may be incomplete."}';
  assert.ok(isTransientAgentError(real));
  assert.equal(describeTransient(real), '响应中途连接被断开(多为代理超时)');
});

test('识别代理侧故障(截图里的真实报错)', () => {
  const real = 'stream disconnected before completion: URL error: Proxy connection failed: '
    + 'HTTP CONNECT failed with status 503';
  assert.ok(isTransientAgentError(real));
  assert.equal(describeTransient(real), '代理连接失败(CONNECT 被拒,多为节点不稳定)');
});

test('CLI 自身的重试通告不该被当成错误展示', () => {
  const { isRetryNotice } = require('../electron/ssh/AgentSession');
  assert.ok(isRetryNotice('Reconnecting... 2/5 (stream disconnected before completion)'));
  assert.ok(isRetryNotice('Retrying request...'));
  assert.ok(!isRetryNotice('Error: something actually broke'));
  assert.ok(!isRetryNotice(''));
});

test('识别其它网络层中断', () => {
  for (const s of [
    'socket hang up', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443',
    'fetch failed', 'Premature close', 'Request timed out',
    'HTTP 502 Bad Gateway', 'Error 529 overloaded', 'Service Unavailable'
  ]) {
    assert.ok(isTransientAgentError(s), `应判为可重试: ${s}`);
  }
});

test('认证/额度类错误绝不重试(否则白烧钱)', () => {
  for (const s of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'HTTP 401 Unauthorized', 'invalid api key', 'Login expired · Please run /login',
    'Your credit balance is too low', 'permission denied', 'model not found',
    // 真实遇到过:额度耗尽,重试毫无意义
    "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
    'usage limit reached', 'quota exceeded'
  ]) {
    assert.ok(!isTransientAgentError(s), `不该重试: ${s}`);
  }
});

test('不可重试信号优先:同时出现时不重试', () => {
  // 502 是可重试信号,但同时说了认证过期 -> 以不可重试为准
  const mixed = 'HTTP 502 ... OAuth session expired and could not be refreshed';
  assert.ok(!isTransientAgentError(mixed));
});

test('普通输出与空值不误判为中断', () => {
  assert.ok(!isTransientAgentError(''));
  assert.ok(!isTransientAgentError('任务完成,所有测试通过'));
  assert.ok(!isTransientAgentError(null));
});

test('退避时间指数增长且有上限', () => {
  assert.equal(retryDelayMs(0), 2000);
  assert.equal(retryDelayMs(1), 4000);
  assert.equal(retryDelayMs(2), 8000);
  assert.equal(retryDelayMs(10), 20000); // 封顶
});
