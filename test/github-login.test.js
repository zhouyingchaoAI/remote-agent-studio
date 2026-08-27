const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gh = require('../electron/github');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* GitHub 快捷登录:驱动主机上的 gh 走它自己的设备流。
 *
 * 实现前提是读 cli/cli 与 cli/oauth 源码确认的,写成测试钉住 ——
 * 这些是"看不出来但一改就坏"的那类假设。 */

test('登录命令:--web 选设备流,断开 stdin 让 gh 判定非交互', () => {
  const cmd = gh.buildLoginCommand({});
  assert.match(cmd, /--web/);
  /* stdin 是 tty 时 gh 会停在「Press Enter to open ... in your browser」
     等一个永远不会来的回车 —— 用户截图里 agent 卡住就是这个原因。
     断开 stdin 后 gh 直接打码并开始轮询。 */
  assert.match(cmd, /<\/dev\/null/);
  // 一次性码和成功提示 gh 全打在 stderr 上,不合流就什么都读不到
  assert.match(cmd, /2>&1/);
  assert.match(cmd, /--git-protocol https/);
});

test('主机名会进命令行,必须挡住注入', () => {
  assert.throws(() => gh.buildLoginCommand({ hostname: 'x.com; rm -rf /' }), /不合法/);
  assert.throws(() => gh.buildStatusCommand({ hostname: '$(whoami)' }), /不合法/);
  assert.equal(gh.safeHostname('github.example.com'), 'github.example.com');
});

test('从带颜色的真实输出里抽出一次性码与地址', () => {
  // gh 输出带 ANSI,不剥掉正则匹配不上
  const chunk = '[0;33m![0m First copy your one-time code: [1mA1B2-C3D4[0m\n'
    + '[1mOpen this URL[0m to continue in your web browser: https://github.com/login/device\n';
  const r = gh.parseLoginOutput(chunk);
  assert.equal(r.code, 'A1B2-C3D4');
  assert.equal(r.url, 'https://github.com/login/device');
});

test('识别登录完成与用户名', () => {
  const r = gh.parseLoginOutput('[0;32m✓[0m Authentication complete.\n✓ Logged in as [1msomeuser[0m');
  assert.equal(r.authenticated, true);
  assert.equal(r.username, 'someuser');
  assert.equal(r.done, true);
  // 成功的输出里不该被误判出错误
  assert.equal(r.error, undefined);
});

test('授权链接带上码,手机点开就不用手打', () => {
  assert.equal(
    gh.deviceUrlWithCode('https://github.com/login/device', 'A1B2-C3D4'),
    'https://github.com/login/device?user_code=A1B2-C3D4'
  );
  // 没拿到码时也要给个能用的地址,而不是 undefined
  assert.equal(gh.deviceUrlWithCode('', ''), 'https://github.com/login/device');
});

test('解析 gh auth status 的三种状态', () => {
  const yes = gh.parseAuthStatus(
    'github.com\n  ✓ Logged in to github.com account someuser (keyring)\n  - Token scopes: gist, read:org, repo');
  assert.equal(yes.loggedIn, true);
  assert.equal(yes.username, 'someuser');
  assert.match(yes.scopes, /repo/);

  assert.equal(gh.parseAuthStatus('__NO_GH__').installed, false);
  assert.equal(gh.parseAuthStatus('You are not logged into any GitHub hosts').loggedIn, false);
});

test('登录进度靠流式推送 —— 等命令跑完再取,码早过期了', () => {
  const main = read('electron/main.js');
  assert.match(main, /ipcMain\.handle\('github:login'/);
  assert.match(main, /execStream\(`\$\{env\}\$\{ghMod\.buildLoginCommand/);
  assert.match(main, /send\('github:progress'/);
});

test('非交互模式下 gh 不配 git 凭据助手,push 免密要自己补', () => {
  const main = read('electron/main.js');
  // cli/cli 里那段被 opts.Interactive 守着,我们非交互就走不到
  assert.match(main, /buildSetupGitCommand/);
  assert.match(main, /gitConfigured/);
  assert.equal(gh.buildSetupGitCommand({}), 'gh auth setup-git --hostname github.com 2>&1');
});

test('token 不经过我们:代码里没有任何地方读取或转发它', () => {
  /* 只看代码,不看注释 —— 注释里说明"token 不经过本应用"是必要的文档,
     早先那版断言把注释也算进去,于是自己的说明反倒让测试失败。 */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|\*).*$/gm, '');

  /* 只认代码形态(取属性/赋值/传参),不认散文。
     卡片里那句「token 不经过本应用」是写给用户看的正文,不是注释也剥不掉,
     早先按关键字匹配时,自己的这句说明反倒把测试搞挂了。 */
  const CODE_USE = /\.token\b|\btoken\s*[:=]|authToken|accessToken|getToken/i;
  const ui = stripComments(read('src/components/GithubLogin.jsx'));
  assert.ok(!CODE_USE.test(ui), `登录卡片的代码碰了 token:${ui.match(CODE_USE)?.[0]}`);

  const main = read('electron/main.js');
  const block = stripComments(
    main.slice(main.indexOf("ipcMain.handle('github:login'"),
      main.indexOf("ipcMain.handle('github:cancel'")));
  assert.ok(!CODE_USE.test(block), '主进程不该接手 token');

  // 解析器同样不该把 token 抽出来往上传
  const mod = stripComments(read('electron/github.js'));
  assert.ok(!CODE_USE.test(mod), '解析器不该把 token 抽出来往上传');
});

test('Linux 装到 ~/.local/bin,不需要 root;macOS 只给建议不代劳', () => {
  const linux = gh.buildInstallCommand('linux');
  assert.equal(linux.manual, false);
  assert.match(linux.command, /\$HOME\/\.local\/bin/);
  // 版本号写死会过期,从 API 取
  assert.match(linux.command, /releases\/latest/);
  assert.match(linux.command, /aarch64\|arm64\) A=arm64/, 'ARM 主机也要能装');

  const mac = gh.buildInstallCommand('darwin');
  assert.equal(mac.manual, true, 'brew 会改动全局环境,不该替用户决定');
});
