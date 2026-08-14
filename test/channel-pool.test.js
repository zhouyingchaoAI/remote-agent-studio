const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  ChannelPool, parseMaxSessions, MAX_SESSIONS_PROBE, RESERVE
} = require('../electron/ssh/channelPool');

/* 用户 2026-08-11 反馈:attachments:prepare 报「SSH 通道已用尽」。
 * 提示写得再清楚也不如不发生 —— 闸门的作用是排队而不是失败。 */

test('超出上限的请求排队而不是失败', async () => {
  const pool = new ChannelPool(2);
  const r1 = await pool.acquire();
  const r2 = await pool.acquire();
  assert.equal(pool.available, 0);

  let got3 = false;
  const p3 = pool.acquire().then((r) => { got3 = true; return r; });
  await new Promise((r) => setImmediate(r));
  assert.equal(got3, false, '满了应该排队等着');
  assert.equal(pool.pending, 1);

  r1();
  const r3 = await p3;
  assert.equal(got3, true, '有名额释放后应立刻放行');
  r2(); r3();
  assert.equal(pool.stats().inUse, 0);
});

test('release 幂等:stream 的 close 与 error 都触发也不会多还名额', async () => {
  const pool = new ChannelPool(1);
  const release = await pool.acquire();
  release();
  release();
  release();
  assert.equal(pool.stats().inUse, 0, '重复释放不该把计数压到负数');
  // 名额没有被凭空放大
  await pool.acquire();
  assert.equal(pool.available, 0);
});

test('排队超时给出可操作的提示,而不是永远挂着', async () => {
  const pool = new ChannelPool(1);
  await pool.acquire();
  await assert.rejects(
    pool.acquire({ timeoutMs: 30 }),
    (e) => /等待 SSH 通道超时/.test(e.message) && /终端/.test(e.message)
  );
  assert.equal(pool.pending, 0, '超时后要从队列里摘掉,否则后续 release 会误放行');
});

test('按探测到的 MaxSessions 调整上限,并留出余量', () => {
  const pool = new ChannelPool();
  assert.equal(pool.setMaxSessions(20), 20 - RESERVE);
  assert.equal(pool.setMaxSessions(3), 3 - RESERVE);
  // 非法值不改动
  const before = pool.limit;
  assert.equal(pool.setMaxSessions('abc'), before);
  assert.equal(pool.setMaxSessions(0), before);
});

test('调高上限后,排队中的请求立刻被放行', async () => {
  const pool = new ChannelPool(1);
  await pool.acquire();
  let released = false;
  const waiting = pool.acquire({ timeoutMs: 1000 }).then(() => { released = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(released, false);

  pool.setMaxSessions(10); // limit -> 8
  await waiting;
  assert.equal(released, true);
});

test('断线时清空占用,排队者立刻失败而不是等到超时', async () => {
  const pool = new ChannelPool(1);
  await pool.acquire();
  const waiting = pool.acquire({ timeoutMs: 60000 });
  await new Promise((r) => setImmediate(r));

  pool.reset(new Error('SSH 连接已断开'));
  await assert.rejects(waiting, /连接已断开/);
  assert.equal(pool.stats().inUse, 0);
  assert.equal(pool.stats().pending, 0);
});

/* ---------------- MaxSessions 探测 ---------------- */

test('解析 sshd -T 与 sshd_config 两种格式', () => {
  assert.equal(parseMaxSessions('maxsessions 10'), 10);
  assert.equal(parseMaxSessions('MaxSessions 64'), 64);
  assert.equal(parseMaxSessions('  MaxSessions   32  '), 32);
  assert.equal(parseMaxSessions('#MaxSessions 10'), null, '注释掉的不算');
  assert.equal(parseMaxSessions(''), null);
  assert.equal(parseMaxSessions('maxstartups 10:30:100'), null, '别把 MaxStartups 当成它');
});

test('探测命令在没有 root、没有配置文件时也不报错退出', () => {
  assert.match(MAX_SESSIONS_PROBE, /2>\/dev\/null/);
  assert.match(MAX_SESSIONS_PROBE, /\|\| true$/);
});

/* ---------------- 接线检查 ---------------- */

test('exec / shell / sftp 三条开通道的路径都过闸门', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron/ssh/SSHManager.js'), 'utf8');
  const acquires = src.match(/this\.channels\.acquire\(/g) || [];
  assert.ok(acquires.length >= 3, `应有 exec/shell/sftp 三处取名额,实际 ${acquires.length}`);
  assert.match(src, /label: 'exec'/);
  assert.match(src, /label: `shell:/);
  assert.match(src, /label: 'sftp'/);
  // 断线要清空,否则重连后名额永远回不来
  assert.match(src, /this\.channels\.reset\(/);
});
