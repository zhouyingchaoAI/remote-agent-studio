const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Installer } = require('../electron/ssh/Installer');

function transport(responses = []) {
  const commands = [];
  return {
    commands,
    async exec(command) {
      commands.push(command);
      return responses.shift() || { code: 0, stdout: '', stderr: '' };
    }
  };
}

test('detect loads nvm before checking node and npm', async () => {
  const ssh = transport([{ code: 0, stdout: 'NODE=v24.18.0\nNPM=11.0.0\n', stderr: '' }]);
  await new Installer(ssh, null).detect();

  const script = ssh.commands[0];
  assert.notEqual(script.indexOf('nvm.sh'), -1, 'detect must load nvm');
  assert.ok(script.indexOf('nvm.sh') < script.indexOf('command -v node'));
});

test('ensureNode removes incompatible npm config and activates a stable default', async () => {
  const ssh = transport([
    { code: 0, stdout: 'NODE=v24.18.0\nNPM=\n', stderr: '' },
    { code: 0, stdout: 'v24.18.0\n11.0.0\n', stderr: '' }
  ]);
  await new Installer(ssh, null).ensureNode(() => {});

  assert.equal(ssh.commands.length, 2, 'missing npm must trigger nvm repair');
  const script = ssh.commands[1];
  assert.ok(script.includes('prefix|globalconfig'));
  assert.match(script, /nvm alias default "\$latest_lts"/);
  assert.match(script, /nvm use --delete-prefix "\$latest_lts"/);
  assert.match(script, /npm -v/);
});

test('ensureNode falls back to a Node 22 glibc 2.17 build on legacy x64 Linux', async () => {
  const ssh = transport([
    { code: 0, stdout: 'NODE=\nNPM=\n', stderr: '' },
    { code: 0, stdout: 'v22.23.1\n10.9.4\n', stderr: '' }
  ]);

  await new Installer(ssh, null).ensureNode(() => {});

  const script = ssh.commands[1];
  assert.match(script, /unofficial-builds\.nodejs\.org\/install-node\.sh/);
  assert.match(script, /--line 22/);
  assert.match(script, /--platform x64-glibc-217/);
  assert.match(script, /--dir "\$compat_node_dir"/);
  assert.match(script, /mkdir -p "\$compat_node_dir"/);
  assert.match(script, /bypassing the slow proxy/);
  assert.match(script, /unset HTTP_PROXY HTTPS_PROXY/);
  assert.match(script, /\.remote-agent-node-env\.sh/);
  assert.match(script, /node -v/);
  assert.match(script, /npm -v/);
});

test('remote execution paths load the compatibility Node override after nvm', () => {
  /* 这段环境前缀原来在四个文件里各写一份,顺序还不一致
     (检测是追加 PATH、执行是前置),导致"检测说 codex 可用、
     实际跑的是另一个二进制"。现在收敛到 agentEnv.js 一处。

     所以这条测试也跟着改:**在唯一的那处**校验顺序,
     再确认每个执行入口都确实走它 —— 而不是逐个文件找字符串,
     那样只要有人把定义抽走,测试就会误报。 */
  const shared = fs.readFileSync(path.join(__dirname, '..', 'electron/ssh/agentEnv.js'), 'utf8');
  assert.match(shared, /remote-agent-node-env\.sh/);
  assert.ok(
    shared.indexOf('nvm.sh') < shared.indexOf('remote-agent-node-env.sh'),
    'compat 路径必须排在 nvm 之后才能覆盖它'
  );

  // 走共享定义的入口
  for (const relativePath of ['electron/ssh/Installer.js', 'electron/ssh/AgentSession.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.match(source, /require\('\.\/agentEnv'\)/, `${relativePath} 应该引用共享定义`);
  }

  // 自己另起一套 shell 前缀的入口,仍然要各自满足顺序要求
  for (const relativePath of ['electron/ssh/SSHManager.js', 'electron/main.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.match(source, /remote-agent-node-env\.sh/, `${relativePath} must load the compatibility environment`);
    assert.ok(
      source.indexOf('nvm.sh') < source.indexOf('remote-agent-node-env.sh'),
      `${relativePath} must let the compatibility path override nvm`
    );
  }
});

test('installAgent activates nvm without writing a conflicting npm prefix for Claude', async () => {
  const ssh = transport();
  const installer = new Installer(ssh, null);
  installer.ensureNode = async () => {};

  await installer.installAgent('claude', () => {});

  const script = ssh.commands[0];
  assert.match(script, /nvm use --delete-prefix default/);
  assert.match(script, /command -v npm/);
  assert.doesNotMatch(script, /npm config set prefix/);
});

test('installAgent prefers the official standalone installer for Codex on Linux', async () => {
  const ssh = transport([
    { code: 0, stdout: 'codex-cli 0.139.0\n', stderr: '' },
    { code: 0, stdout: 'NODE=\nNPM=\nCODEX=codex-cli 0.139.0\n', stderr: '' }
  ]);
  const installer = new Installer(ssh, null);
  installer.ensureNode = async () => { throw new Error('standalone Codex must not require Node'); };

  const result = await installer.installAgent('codex', () => {});

  assert.match(ssh.commands[0], /github\.com\/openai\/codex\/releases\/latest/);
  assert.match(ssh.commands[0], /codex-package_SHA256SUMS/);
  assert.match(ssh.commands[0], /sha256sum/);
  // 直连探测必须针对资产 URL 本身(CDN),而不是 github.com 页面
  assert.match(ssh.commands[0], /curl -fsIL --max-time 10 "\$url"/);
  // 直连失败必须回退代理,且支持断点续传
  assert.match(ssh.commands[0], /downloading via proxy \(resumable\)/);
  assert.match(ssh.commands[0], /-C - -o "\$archive"/);
  assert.match(ssh.commands[0], /\.cache\/remote-agent-codex/);
  assert.match(ssh.commands[0], /Codex package SHA-256 verification failed/);
  assert.match(ssh.commands[0], /env -u HTTP_PROXY -u HTTPS_PROXY/);
  assert.match(ssh.commands[0], /codex --version/);
  assert.equal(result.codex, 'codex-cli 0.139.0');
});
