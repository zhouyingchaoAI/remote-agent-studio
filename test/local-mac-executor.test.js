const test = require('node:test');
const assert = require('node:assert/strict');

const { LocalExecutor } = require('../electron/LocalExecutor');

test('mac local sessions use the login shell so codex sees the terminal environment', () => {
  const lx = new LocalExecutor({
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    homeDir: '/Users/demo'
  });
  const inv = lx.shellInvocation('codex --version');
  assert.equal(inv.bin, '/bin/zsh');
  assert.deepEqual(inv.args, ['-l', '-c', 'codex --version']);
});

test('mac local PATH is augmented with homebrew, npm-global and codex install dirs', () => {
  const lx = new LocalExecutor({
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    homeDir: '/Users/demo'
  });
  const env = lx.shellEnv();
  assert.ok(env.PATH.startsWith('/usr/bin:/bin'), 'user PATH keeps priority');
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/Users/demo/.npm-global/bin', '/Users/demo/.local/bin', '/Users/demo/.codex/bin']) {
    assert.ok(env.PATH.includes(dir), `missing ${dir}`);
  }
});

test('augmented PATH does not duplicate entries already present', () => {
  const lx = new LocalExecutor({
    platform: 'darwin',
    env: { PATH: '/opt/homebrew/bin:/usr/bin' },
    homeDir: '/Users/demo'
  });
  const parts = lx.shellEnv().PATH.split(':');
  assert.equal(parts.filter((p) => p === '/opt/homebrew/bin').length, 1);
});

test('resolveTerminalEnv captures variables exported by the interactive shell', async () => {
  const lx = new LocalExecutor({
    platform: 'linux',
    env: { SHELL: '/bin/bash', PATH: '/usr/bin:/bin', RAS_TEST_STATIC: '1' },
    homeDir: '/home/demo'
  });
  const env = await lx.resolveTerminalEnv();
  assert.equal(env.RAS_TEST_STATIC, '1', 'static env preserved');
  assert.ok(env.PATH.includes('/usr/bin'), 'terminal PATH merged');
  assert.ok(env.PATH.includes('/home/demo/.npm-global/bin'), 'augmented PATH merged');
  // 第二次调用走缓存,返回同一对象
  assert.equal(await lx.resolveTerminalEnv(), env);
});

test('resolveTerminalEnv falls back to the static env when the shell is unusable', async () => {
  const lx = new LocalExecutor({
    platform: 'linux',
    env: { SHELL: '/nonexistent-shell', PATH: '/usr/bin' },
    homeDir: '/home/demo'
  });
  const env = await lx.resolveTerminalEnv();
  assert.ok(env.PATH.includes('/usr/bin'));
  assert.ok(env.PATH.includes('/home/demo/.local/bin'));
});

test('windows local sessions keep the native PowerShell invocation', () => {
  const lx = new LocalExecutor({ platform: 'win32', env: { PATH: 'C:\\bin' } });
  const inv = lx.shellInvocation('codex.cmd --version');
  assert.equal(inv.bin, 'powershell.exe');
  assert.ok(inv.args.includes('-NonInteractive'));
  assert.equal(lx.shellEnv().PATH, 'C:\\bin');
});
