const test = require('node:test');
const assert = require('node:assert');
const { Installer } = require('../electron/ssh/Installer');

/** 造一个可编排的假 ssh:按命令内容返回预设结果,并记录执行过的命令 */
function fakeSsh(handler) {
  const calls = [];
  return {
    calls,
    isLocal: false,
    isWindowsNative: false,
    async exec(cmd) {
      calls.push(cmd);
      return handler(cmd) || { code: 0, stdout: '', stderr: '' };
    }
  };
}

test('remoteArch 归一化各种架构名', async () => {
  for (const [machine, family, supported] of [
    ['x86_64', 'x86_64', true], ['amd64', 'x86_64', true],
    ['aarch64', 'aarch64', true], ['arm64', 'aarch64', true],
    ['riscv64', 'riscv64', false]
  ]) {
    const ssh = fakeSsh((c) => (c.includes('uname -m') ? { code: 0, stdout: `${machine}\n` } : null));
    const arch = await new Installer(ssh, null).remoteArch();
    assert.equal(arch.family, family, machine);
    assert.equal(arch.supported, supported, machine);
  }
});

test('remoteArch 探测失败时安全降级,不抛异常', async () => {
  const ssh = { exec: async () => { throw new Error('连不上'); } };
  const arch = await new Installer(ssh, null).remoteArch();
  assert.equal(arch.machine, '未知');
  assert.equal(arch.supported, false);
});

test('verifyBinary 把 Exec format error 翻译成架构不匹配', async () => {
  const ssh = fakeSsh((c) => {
    if (c.includes('uname -m')) return { code: 0, stdout: 'aarch64\n' };
    return { code: 126, stdout: 'bash: /root/.local/bin/codex: cannot execute binary file: Exec format error' };
  });
  const v = await new Installer(ssh, null).verifyBinary('codex');
  assert.equal(v.ok, false);
  assert.equal(v.archMismatch, true);
  assert.match(v.message, /aarch64/);
  assert.match(v.message, /架构.*不匹配/);
});

test('verifyBinary 退出码 0 即算可执行(有些命令不打印版本)', async () => {
  const quiet = fakeSsh(() => ({ code: 0, stdout: '' }));
  assert.equal((await new Installer(quiet, null).verifyBinary('x')).ok, true);

  const normal = fakeSsh(() => ({ code: 0, stdout: 'codex-cli 0.146.0\n' }));
  const v = await new Installer(normal, null).verifyBinary('codex');
  assert.equal(v.version, 'codex-cli 0.146.0');
});

test('verifyBinary 普通失败不误报成架构问题', async () => {
  const ssh = fakeSsh(() => ({ code: 127, stdout: 'command not found' }));
  const v = await new Installer(ssh, null).verifyBinary('codex');
  assert.equal(v.ok, false);
  assert.ok(!v.archMismatch);
  assert.match(v.message, /command not found/);
});

test('cleanupBrokenBinary 覆盖所有安装目录(错架构残留会挡住正确版本)', async () => {
  const ssh = fakeSsh(() => ({ code: 0, stdout: '' }));
  await new Installer(ssh, null).cleanupBrokenBinary('codex');
  const cmd = ssh.calls[0];
  for (const dir of ['.local/bin', '.npm-global/bin']) {
    assert.ok(cmd.includes(`${dir}/codex`), `应检查 ${dir}`);
  }
  assert.match(cmd, /rm -f/);
  assert.match(cmd, /--version >\/dev\/null/);   // 先验证再删,不误删可用的
});

test('BIN_PATH 顺序与运行时一致(否则查的不是实际执行的那个)', () => {
  assert.match(Installer.BIN_PATH, /\.npm-global\/bin.*\.local\/bin/);
});
