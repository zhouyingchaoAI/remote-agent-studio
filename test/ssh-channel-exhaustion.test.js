const test = require('node:test');
const assert = require('node:assert');
const { SSHManager } = require('../electron/ssh/SSHManager');

/** 造一个假的 ssh2 client:前 failTimes 次 exec 报"通道开不出来",之后成功 */
function fakeClient(failTimes) {
  let calls = 0;
  return {
    calls: () => calls,
    exec(_cmd, _opts, cb) {
      calls += 1;
      if (calls <= failTimes) {
        return cb(new Error('(SSH) Channel open failure: open failed'));
      }
      // 极简 stream 桩:立刻 close
      const listeners = {};
      const stream = {
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return stream; },
        stderr: { on() { return stream.stderr; } },
        write() {}, end() {}
      };
      setImmediate(() => (listeners.close || []).forEach((fn) => fn(0)));
      cb(null, stream);
    }
  };
}

test('isChannelExhausted recognises sshd MaxSessions style failures', () => {
  assert.ok(SSHManager.isChannelExhausted(new Error('(SSH) Channel open failure: open failed')));
  assert.ok(SSHManager.isChannelExhausted(new Error('Channel open failure: administratively prohibited')));
  assert.ok(SSHManager.isChannelExhausted(new Error('resource shortage')));
  // 普通错误不应被误判(否则会掩盖真实故障)
  assert.ok(!SSHManager.isChannelExhausted(new Error('Permission denied (publickey)')));
  assert.ok(!SSHManager.isChannelExhausted(new Error('connect ETIMEDOUT')));
});

test('exec retries transient channel exhaustion and releases the sftp channel', async () => {
  const mgr = new SSHManager({ host: 'h', username: 'u' });
  mgr.client = fakeClient(2); // 前两次失败,第三次成功
  let sftpEnded = false;
  mgr.sftpSession = { end() { sftpEnded = true; } };

  const result = await mgr.exec('echo hi');
  assert.equal(result.code, 0);
  assert.equal(mgr.client.calls(), 3);      // 重试到第三次
  assert.ok(sftpEnded);                      // 回收了 SFTP 通道名额
  assert.equal(mgr.sftpSession, null);
});

test('exec surfaces an actionable message when channels stay exhausted', async () => {
  const mgr = new SSHManager({ host: 'h', username: 'u' });
  mgr.client = fakeClient(Infinity); // 一直失败
  await assert.rejects(() => mgr.exec('echo hi'), (err) => {
    assert.match(err.message, /通道已用尽/);
    assert.match(err.message, /MaxSessions/);      // 指出根因
    assert.match(err.message, /终端/);              // 给出可操作处理
    return true;
  });
});

test('non-exhaustion errors propagate immediately without retrying', async () => {
  const mgr = new SSHManager({ host: 'h', username: 'u' });
  let calls = 0;
  mgr.client = { exec(_c, _o, cb) { calls += 1; cb(new Error('Permission denied (publickey)')); } };
  await assert.rejects(() => mgr.exec('echo hi'), /Permission denied/);
  assert.equal(calls, 1); // 不做无意义重试
});
