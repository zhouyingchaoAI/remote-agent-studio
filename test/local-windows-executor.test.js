const test = require('node:test');
const assert = require('node:assert/strict');

const { AgentSession } = require('../electron/ssh/AgentSession');
const { Installer } = require('../electron/ssh/Installer');
const { LocalExecutor } = require('../electron/LocalExecutor');

test('Windows local sessions build native PowerShell Codex commands', () => {
  const ssh = { isLocal: true, isWindowsNative: true };
  const session = new AgentSession(ssh, null, {
    agent: 'codex', cwd: 'C:\\work\\demo', permissionMode: 'workspace'
  });
  const command = session.buildCommand('review this', {
    attachments: [{ kind: 'image', remotePath: 'C:\\cache\\shot.png' }],
    artifactDir: 'C:\\cache\\artifacts\\m1'
  });

  assert.match(command, /Set-Location -LiteralPath 'C:\\work\\demo'/);
  assert.match(command, /& codex\.cmd exec/);
  assert.match(command, /--image 'C:\\cache\\shot\.png'/);
  assert.match(command, /--add-dir 'C:\\cache'/);
  assert.doesNotMatch(command, /export NVM_DIR|<\/dev\/null/);
});

test('Windows local installer delegates detection and npm installation to LocalExecutor', async () => {
  const calls = [];
  const ssh = {
    isLocal: true,
    isWindowsNative: true,
    detectEnvironment: async () => ({ os: 'Windows', node: 'v24', npm: '11', codex: '', claude: '' }),
    installGlobalAgent: async (pkg, bin) => { calls.push([pkg, bin]); return `${bin} 1.0`; }
  };
  const installer = new Installer(ssh, null);

  assert.deepEqual(await installer.detect(), { os: 'Windows', node: 'v24', npm: '11', codex: '', claude: '' });
  const result = await installer.installAgent('codex', () => {});
  assert.deepEqual(calls, [['@openai/codex@latest', 'codex']]);
  assert.equal(result.codex, 'codex 1.0');
});

test('local unix installer upgrades via npm instead of the remote Linux flow', async () => {
  const commands = [];
  const ssh = {
    isLocal: true,
    isWindowsNative: false,
    async exec(command) {
      commands.push(command);
      // 第一条是安装命令,其余是 detect 脚本
      return commands.length === 1
        ? { code: 0, stdout: 'codex-cli 0.99.0\n', stderr: '' }
        : { code: 0, stdout: 'OS=Darwin arm64\nNODE=v22\nNPM=10\nCODEX=codex-cli 0.99.0\nCLAUDE=\n', stderr: '' };
    }
  };
  const installer = new Installer(ssh, null);
  const result = await installer.installAgent('codex', () => {});

  assert.match(commands[0], /npm install -g @openai\/codex@latest/);
  assert.doesNotMatch(commands[0], /nvm|unknown-linux-musl|releases\/download/);
  assert.equal(result.codex, 'codex-cli 0.99.0');
});

test('local unix installer surfaces a brew hint on failure', async () => {
  const ssh = {
    isLocal: true,
    isWindowsNative: false,
    async exec() { return { code: 1, stdout: '', stderr: 'EACCES' }; }
  };
  const installer = new Installer(ssh, null);
  await assert.rejects(
    () => installer.installAgent('codex', () => {}),
    /brew upgrade codex/
  );
});

test('LocalExecutor selects the native Windows backend on win32', () => {
  assert.equal(new LocalExecutor({ platform: 'win32' }).isWindowsNative, true);
  assert.equal(new LocalExecutor({ platform: 'linux' }).isWindowsNative, false);
});
