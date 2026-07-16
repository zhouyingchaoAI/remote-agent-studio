const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Installer } = require('../electron/ssh/Installer');

test('SSHManager wires a hostVerifier when verifyHostKey is provided', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ssh', 'SSHManager.js'), 'utf8');
  assert.match(source, /hostVerifier = \(key, verify\)/);
  assert.match(source, /SHA256:/);
  assert.match(source, /verifyHostKey/);
});

test('SSHManager reconnects with exponential backoff and rebuilds tunnels', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ssh', 'SSHManager.js'), 'utf8');
  assert.match(source, /_scheduleReconnect/);
  assert.match(source, /manualClose/);
  assert.match(source, /Math\.pow\(2, this\.reconnectAttempt - 1\)/);
  assert.match(source, /forwardIn\('127\.0\.0\.1', remotePort/);
});

test('conversation store persists per-file with atomic replace and legacy migration', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'store.js'), 'utf8');
  assert.match(source, /conversations'\)/);
  assert.match(source, /migrateLegacyConvos/);
  assert.match(source, /renameSync\(tmp, file\)/);
  assert.match(source, /convSavedAt/);
});

test('setApiKey stores the key in a 600-permission env file, not bashrc plaintext', async () => {
  const commands = [];
  const ssh = { async exec(c) { commands.push(c); return { code: 0, stdout: '', stderr: '' }; } };
  const installer = new Installer(ssh, null);
  await installer.setApiKey('claude', 'sk-ant-test_123', () => {});

  const cmd = commands[0];
  assert.match(cmd, /\.remote-agent-env\.sh/);
  assert.match(cmd, /chmod 600/);
  // bashrc 只允许出现 source 行与清理逻辑,不允许出现 key 明文写入 bashrc
  assert.doesNotMatch(cmd, /printf 'export ANTHROPIC_API_KEY=%s\\n' '[^']*' >> ~\/\.bashrc/);
  assert.match(cmd, /grep -v '\^export ANTHROPIC_API_KEY=' ~\/\.bashrc/);
});

test('setApiKey rejects keys with shell metacharacters', async () => {
  const installer = new Installer({ async exec() { throw new Error('must not run'); } }, null);
  await assert.rejects(() => installer.setApiKey('codex', "sk';rm -rf ~'", () => {}), /特殊字符/);
});

test('agent commands source the credentials env file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ssh', 'AgentSession.js'), 'utf8');
  assert.match(source, /\.remote-agent-env\.sh/);
});
