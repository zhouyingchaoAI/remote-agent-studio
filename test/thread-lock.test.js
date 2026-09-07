const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  isThreadLockError, describeThreadLock, isTransientAgentError
} = require('../electron/transientErrors');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 「一直连不上」其实跟网络无关。
 *
 * 真实报文(用户机器上连着几轮都一样):
 *   thread-store conflict: thread 01a041fc-… already has an active writer
 *   Error: thread/resume: thread/resume failed: … (code -32600)
 *
 * 应用把 thread id 存了下来,每轮都 `codex exec resume <同一个 id>`,
 * 于是永远撞在同一把锁上 —— 表现就是"每次一发消息就红框,而且一模一样"。
 * ============================================================ */

/* 用户机器上的真实报文(节选、原样保留) */
const REAL = [
  '进程退出码 1(若提示未登录/无 API key,请到"环境配置"页设置)',
  '—— 最近输出 ——',
  '2026-09-07T01:50:22.718406Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit',
  '2026-09-07T01:50:24.745741Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread 01a041fc-4a1b-7911-be69-fc194ec4bd9c already has an active writer',
  'Error: thread/resume: thread/resume failed: thread 01a041fc-4a1b-7911-be69-fc194ec4bd9c already has an active writer (code -32600)'
].join('\n');

test('认得出线程锁冲突', () => {
  assert.ok(isThreadLockError(REAL));
  assert.ok(isThreadLockError('thread-store conflict: thread abc already has an active writer'));
  assert.ok(isThreadLockError('thread/resume failed'));
});

test('**绝不能**当成瞬时错误去重试', () => {
  /* 这是这次修复的核心。报文里夹着
     "timeout waiting for child process to exit",
     一不留神就会被 TRANSIENT 里的 timeout 规则捞进去 ——
     那样应用会拿着同一个 thread id 一遍遍 resume,每次撞同一把锁。
     退避重试只是把"立刻失败"变成"慢慢地一直失败",更难查。 */
  assert.equal(isTransientAgentError(REAL), false);
});

test('普通的超时/断连仍然算瞬时错误', () => {
  // 别为了修这个把真正该重试的也一并挡掉
  assert.ok(isTransientAgentError('API Error: Connection closed mid-response.'));
  assert.ok(isTransientAgentError('request timed out'));
  assert.ok(isTransientAgentError('socket hang up'));
});

test('说明里点明"不是网络问题"', () => {
  /* 用户的第一反应是"连不上",而按网络去查会白花很多时间 ——
     报错文案的头等任务是把人从错误的方向上拉回来。 */
  const msg = describeThreadLock(REAL);
  assert.match(msg, /不是网络问题/);
  assert.match(msg, /01a041fc-4a1b-7911-be69-fc194ec4bd9c/, '带上线程 id 才好自查');
  assert.match(msg, /pgrep/, '给出能自己动手的那一步');
});

test('拿不到线程 id 也能给出说明', () => {
  const msg = describeThreadLock('thread-store conflict');
  assert.match(msg, /不是网络问题/);
  assert.ok(!/\(\)/.test(msg), '没有 id 时不该留下一对空括号');
});

/* ---------------------------------------------- 接线 */

test('撞锁后把 thread id 丢掉,下一轮开新线程', () => {
  /* 不丢的话下一轮还 resume 同一个 id,再撞同一把锁 ——
     这正是"一直连不上"的成因。丢掉之后对话能继续走下去。 */
  const s = read('electron/ssh/AgentSession.js');
  const seg = s.slice(s.indexOf('isThreadLockError(detail)'));
  assert.match(seg.slice(0, 600), /this\.codexSessionId = null/);
  assert.match(seg.slice(0, 600), /this\.codexStarted = false/);
});

test('清空的 id 能落到存储里,不被旧值盖回去', () => {
  /* updateConvResume 若写成 `codexSessionId || 原值`,清空就不生效,
     下一轮又会 resume 那个锁着的线程。 */
  const store = read('src/store.js');
  const fn = store.slice(store.indexOf('updateConvResume:'), store.indexOf('setConversationGoal:'));
  assert.match(fn, /\.\.\.c, claudeSessionId, codexSessionId, codexStarted/);
  assert.ok(!/codexSessionId \|\|/.test(fn), '不能用 || 兜底,那会让清空失效');
});
