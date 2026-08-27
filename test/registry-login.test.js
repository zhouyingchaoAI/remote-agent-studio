const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const reg = require('../electron/registry');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 镜像仓库登录(Harbor / Docker Hub)。
 * 与 GitHub 的根本差别:没有设备流,只能账号密码。所以全部风险都在
 * 「密码怎么走」上。 */

test('密码必须走 stdin,绝不能用 -p', () => {
  const cmd = reg.buildLoginCommand({ registry: 'harbor.example.com', username: 'robot$ci' });
  assert.match(cmd, /--password-stdin/);
  /* docker 自己都会为 -p 打警告:命令行在 ps 里对同机所有进程可见,
     还会进 shell history */
  assert.ok(!/\s-p\s|--password[^-]/.test(cmd), `命令里出现了 -p:${cmd}`);
  assert.match(cmd, /docker login harbor\.example\.com -u robot\$ci/);
});

test('主进程用 stdin 送密码,不拼进命令', () => {
  const main = read('electron/main.js');
  const block = main.slice(main.indexOf("ipcMain.handle('registry:login'"),
    main.indexOf("ipcMain.handle('registry:logout'"));
  assert.match(block, /\{ stdin: `\$\{password\}/);
  assert.ok(!/\$\{password\}[^`]*docker login/.test(block));
  // 返回值不该带密码
  const ret = block.slice(block.lastIndexOf('return {'));
  assert.ok(!/password|secret/i.test(ret), `返回值带上了密码:${ret}`);
});

test('Docker Hub 的各种写法都归一到同一个仓库', () => {
  for (const v of ['', 'docker.io', 'https://docker.io', 'index.docker.io', 'DOCKER.IO']) {
    const r = reg.normalizeRegistry(v);
    assert.equal(r.isHub, true, `${v} 没被认成 Docker Hub`);
    assert.equal(r.server, '', 'Hub 登录时不传地址');
  }
  // Hub 在 config.json 里的键名和用户输入的完全不同
  assert.equal(reg.normalizeRegistry('docker.io').configKey, 'https://index.docker.io/v1/');
});

test('Harbor 地址:带协议/端口/项目路径都要能用', () => {
  assert.equal(reg.normalizeRegistry('https://harbor.example.com/').server, 'harbor.example.com');
  assert.equal(reg.normalizeRegistry('harbor.example.com:8443').server, 'harbor.example.com:8443');
  assert.equal(reg.normalizeRegistry('10.1.6.230:5000/library').server, '10.1.6.230:5000/library');
});

test('地址与用户名都会进命令行,必须挡住注入', () => {
  assert.throws(() => reg.normalizeRegistry('x.com; rm -rf /'), /不合法/);
  assert.throws(() => reg.normalizeRegistry('$(whoami)'), /不合法/);
  assert.throws(() => reg.safeUsername('a; curl evil'), /不支持的字符/);
  assert.throws(() => reg.safeUsername(''), /不能为空/);
  // Harbor 机器人账号带 $ 和 +,是合法的
  assert.equal(reg.safeUsername('robot$ci+build'), 'robot$ci+build');
});

test('解析 config.json 只取用户名,绝不带出密码', () => {
  // auth 是 base64 的 user:pass,解开后半段就是明文密码
  const secret = 'sup3rs3cret';
  const authB64 = Buffer.from(`alice:${secret}`).toString('base64');
  const out = reg.parseDockerConfig(JSON.stringify({
    auths: { 'harbor.example.com': { auth: authB64 }, 'https://index.docker.io/v1/': {} },
    credsStore: 'desktop'
  }));
  assert.equal(out.length, 2);
  const harbor = out.find((x) => x.configKey === 'harbor.example.com');
  assert.equal(harbor.username, 'alice');
  assert.ok(!JSON.stringify(out).includes(secret), '密码漏出来了');
  // 用凭据助手时 auth 为空,登录态在 helper 里,不能显示成"无用户名"
  assert.equal(out.find((x) => x.configKey.includes('docker.io')).viaHelper, true);
});

test('坏的 config.json 不该让整张卡片崩掉', () => {
  assert.deepEqual(reg.parseDockerConfig('这不是 JSON'), []);
  assert.deepEqual(reg.parseDockerConfig('{}'), []);
  assert.doesNotThrow(() => reg.parseDockerConfig(JSON.stringify({ auths: { x: { auth: '@@坏base64' } } })));
});

test('登录结果按「该改什么」分类', () => {
  assert.equal(reg.parseLoginResult('Login Succeeded').ok, true);

  const cert = reg.parseLoginResult(
    'Error response from daemon: Get "https://harbor.x.com/v2/": x509: certificate signed by unknown authority',
    { registry: 'harbor.x.com' });
  assert.equal(cert.reason, 'cert');
  assert.match(cert.advice, /certs\.d\/harbor\.x\.com/);
  assert.match(cert.advice, /insecure-registries/);
  // 重启 docker 会掐掉所有容器,必须写出来
  assert.match(cert.advice, /掐掉这台机器上所有正在运行的容器/);

  assert.equal(reg.parseLoginResult('unauthorized: incorrect username or password').reason, 'auth');
  assert.equal(reg.parseLoginResult('Cannot connect to the Docker daemon at unix:///var/run/docker.sock').reason, 'daemon');
  assert.equal(reg.parseLoginResult('dial tcp: lookup harbor.x.com: no such host').reason, 'network');
});

test('HTTP 仓库给的是另一套说辞', () => {
  const r = reg.parseLoginResult(
    'http: server gave HTTP response to HTTPS client', { registry: 'harbor.x.com:5000' });
  assert.equal(r.reason, 'cert');
  assert.match(r.advice, /是 HTTP 仓库/);
});

test('证书问题只给命令不代改 —— 那是主机级配置且要重启 docker', () => {
  const main = read('electron/main.js');
  // 不该有任何写 daemon.json / 重启 docker 的代码
  assert.ok(!/daemon\.json/.test(main), '不该代改 daemon.json');
  assert.ok(!/systemctl restart docker/.test(main), '不该代重启 docker');
  // 建议文本在纯逻辑模块里,是给人看的
  assert.match(read('electron/registry.js'), /systemctl restart docker/);
});

test('加密不可用时拒绝保存密码,不悄悄降级成明文', () => {
  const store = read('electron/registryStore.js');
  /* 本项目别处(mobileService)在加密不可用时会退回明文 base64。
     存密码不能这么干:base64 不是加密,而用户以为它是。 */
  assert.match(store, /拒绝以明文保存密码/);
  assert.match(store, /if \(secret && !encryptionAvailable\(\)\)/);
  assert.ok(!/Buffer\.from\(secret/.test(store), '不该有明文回退路径');
  // 文件里是可解密的密码,权限必须收紧
  assert.match(store, /chmodSync\(file, 0o600\)/);
});

test('列表接口不返回密码,连字段都不给', () => {
  const store = read('electron/registryStore.js');
  const listFn = store.slice(store.indexOf('function list()'), store.indexOf('function save('));
  assert.ok(!/secretEnc:/.test(listFn), '列表里不该带密文');
  assert.match(listFn, /hasSecret: !!it\.secretEnc/, '只告诉界面有没有,不给内容');

  const ui = read('src/components/RegistryLogin.jsx');
  // 选中已存凭据时不回填密码:界面拿不到它,也不该假装拿得到
  assert.match(ui, /不回填密码/);
});

test('改用户名不该把已存的密码弄丢', () => {
  const store = read('electron/registryStore.js');
  assert.match(store, /secretEnc: secret[\s\S]{0,120}prev\.secretEnc \|\| ''/);
});

/* 用户点了远程主机上的登录,界面一直停在「登录中…」。
 * 两个真 bug:本机根本收不到密码,以及连不上的仓库能挂到天荒地老。 */

test('本机 exec 必须透传 stdin —— 否则 --password-stdin 永远拿不到密码', async () => {
  const { LocalExecutor } = require('../electron/LocalExecutor');
  const ex = new LocalExecutor({ platform: process.platform });
  const r = await ex.exec('cat', { stdin: 'secret-from-stdin\n' });
  assert.equal(r.stdout.trim(), 'secret-from-stdin');
});

test('_spawn 原来无条件关 stdin,现在只在没内容时才关', () => {
  const src = read('electron/LocalExecutor.js');
  assert.match(src, /if \(opts\.stdin != null\) \{ try \{ child\.stdin\.write\(opts\.stdin\)/);
  // 关闭仍要发生,否则读 stdin 的命令等不到 EOF
  assert.match(src, /child\.stdin\.end\(\);/);
});

test('两端 exec 都支持超时,不让界面无限转圈', async () => {
  const { LocalExecutor } = require('../electron/LocalExecutor');
  const ex = new LocalExecutor({ platform: process.platform });
  const t0 = Date.now();
  const r = await ex.exec('sleep 30', { timeoutMs: 1200 });
  assert.ok(Date.now() - t0 < 8000, '超时没生效,还在等');
  assert.equal(r.code, 124);
  assert.match(r.stderr, /\[超时\]/);

  // SSH 侧同样要有
  assert.match(read('electron/ssh/SSHManager.js'), /opts\.timeoutMs > 0/);
});

test('登录调用带上超时,并对超时给出对症解释', () => {
  const main = read('electron/main.js');
  assert.match(main, /stdin: `\$\{password\}\\n`, timeoutMs: 60000/);
  const r = reg.parseLoginResult('\n[超时] 命令超过 60 秒未返回');
  assert.equal(r.reason, 'timeout');
  // 超时的下一步和「密码错」完全不同,不能混为一谈;
  // 且要点名最常见的那个原因,而不是罗列一堆可能性
  assert.match(r.message, /守护进程没配代理/);
});

test('批量登录也读 stderr —— 只读 stdout 会把失败原因丢掉', () => {
  const main = read('electron/main.js');
  const block = main.slice(main.indexOf("ipcMain.handle('registry:loginMany'"));
  assert.match(block, /r\.stdout \|\| r\.stderr/);
});

/* 用户在远程主机上跑 curl 完全正常(通过 https_proxy 连上,返回 401 —— 那是
 * registry 未认证时的正常应答),但 docker login 一直卡住。
 *
 * 根因:docker login 的网络请求不是 CLI 发的,是 **docker 守护进程** 发的。
 * 守护进程不读 shell 里的 https_proxy,于是 curl 通、docker 不通。 */

test('诊断分别验证 shell 与守护进程,而不是只看一边', () => {
  const cmd = reg.buildDiagnoseCommand({ registry: 'harbor.example.com' });
  assert.match(cmd, /https_proxy/, '要看 shell 的代理');
  assert.match(cmd, /curl -sS[^;]*harbor\.example\.com\/v2\//, '要从 shell 实测连通性');
  // docker info 直接暴露守护进程自己的代理,比翻 systemd 文件可靠
  assert.match(cmd, /docker info --format[^;]*HTTPSProxy/);
});

test('复刻用户现场:shell 通 + 守护进程无代理 -> 指向守护进程代理', () => {
  const r = reg.parseDiagnose(
    '__SHELL_PROXY__=http://10.1.33.75:7890\n__CURL__=401\n__DAEMON__=||\n',
    { registry: 'harbor.chencytech.com' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'daemonProxy');
  assert.match(r.message, /守护进程没配代理/);
  // 事实要摆出来,不能只给结论
  assert.match(r.facts, /shell 连仓库:通\(HTTP 401\)/);
  assert.match(r.facts, /docker 守护进程代理:未设置/);
  // 建议里要带上用户实际的代理地址,不是占位符
  assert.match(r.advice, /HTTPS_PROXY=http:\/\/10\.1\.33\.75:7890/);
  assert.match(r.advice, /systemctl daemon-reload/);
  assert.match(r.advice, /掐掉这台机器上所有正在运行的容器/);
});

test('401 算连通 —— 那是 registry 未认证时的正常应答', () => {
  for (const code of ['200', '401', '403']) {
    const r = reg.parseDiagnose(`__SHELL_PROXY__=none\n__CURL__=${code}\n__DAEMON__=http://p:1|http://p:1|`, {});
    assert.equal(r.ok, true, `HTTP ${code} 不该被当成不通`);
  }
});

test('shell 自己就不通时,先说网络别扯 docker', () => {
  const r = reg.parseDiagnose('__SHELL_PROXY__=none\n__CURL__=000\n__DAEMON__=||', {});
  assert.equal(r.reason, 'network');
  assert.match(r.message, /先解决网络/);
});

test('两边都有代理时不误报', () => {
  const r = reg.parseDiagnose(
    '__SHELL_PROXY__=http://p:7890\n__CURL__=401\n__DAEMON__=http://p:7890|http://p:7890|localhost', {});
  assert.equal(r.ok, true);
});

test('超时提示要点名守护进程代理这个最常见原因', () => {
  const r = reg.parseLoginResult('\n[超时] 命令超过 60 秒未返回');
  assert.match(r.message, /守护进程没配代理/);
  assert.match(r.message, /curl 通不代表 docker 通/);
});

test('诊断同样不代改主机配置', () => {
  const main = read('electron/main.js');
  assert.ok(!/systemctl daemon-reload/.test(main), '不该代写 systemd 配置');
  assert.match(read('electron/registry.js'), /systemctl daemon-reload/, '命令给人看即可');
});

/* 用户说「还是没在远程登陆成功」,但截图里状态明明写着
 * 「已登录 1 个仓库 · harbor.chencytech.com zhouyc」,下面却是「连不上」——
 * 界面自相矛盾,他自然看不出到底成没成。 */

test('规范形式必须可回环 —— 存进去再读出来不能变成别的仓库', () => {
  for (const v of ['https://harbor.x.com/', 'harbor.x.com', '', 'docker.io',
    'https://index.docker.io/v1/', 'harbor.x.com:8443']) {
    const once = reg.canonicalRegistry(v);
    assert.equal(reg.canonicalRegistry(once), once, `${v} 回环后变了`);
  }
  /* 不能直接存 configKey:Hub 的 configKey 是 https://index.docker.io/v1/,
     再解析会被当成一个叫 index.docker.io/v1 的自建仓库,静默指向错的地方 */
  assert.equal(reg.canonicalRegistry('docker.io'), 'docker.io');
});

test('Docker Hub 的所有写法互相认得,且不会把 Harbor 误判成 Hub', () => {
  const forms = ['', 'docker.io', 'index.docker.io', 'https://index.docker.io/v1/', 'registry-1.docker.io'];
  for (const f of forms) assert.ok(reg.sameRegistry(f, 'docker.io'), `${f} 没被认成 Hub`);
  assert.ok(!reg.sameRegistry('harbor.chencytech.com', 'docker.io'));
  assert.ok(reg.sameRegistry('https://harbor.chencytech.com', 'harbor.chencytech.com'));
});

test('保存凭据时存规范形式,否则永远和 docker 的 config key 对不上', () => {
  const store = read('electron/registryStore.js');
  assert.match(store, /canonicalRegistry\(rawReg\)/);
  // 用户填 https://harbor.x.com,docker 的键是 harbor.x.com
  assert.match(store, /两边就永远对不上/);
});

test('状态里带上规范形式,前端不必自己再写一份规则', () => {
  const main = read('electron/main.js');
  assert.match(main, /canonical: \(\(\) => \{ try \{ return registry\.canonicalRegistry/);
  const ui = read('src/components/RegistryLogin.jsx');
  assert.match(ui, /l\.canonical \|\| canon\(l\.configKey\)/);
});

test('当前仓库已登录时要明说,别让人对着「已登录N个」自己猜', () => {
  const ui = read('src/components/RegistryLogin.jsx');
  assert.match(ui, /currentLogin && \(/);
  assert.match(ui, /当前已登录/);
  // 重新登录失败时要讲清原凭据还在用,否则红字会让人以为整个功能没成
  assert.match(ui, /这次失败的是重新登录,原凭据仍然有效/);
});

test('网络/超时类失败自动跑诊断,省得用户再点一次', () => {
  const ui = read('src/components/RegistryLogin.jsx');
  assert.match(ui, /r\.reason === 'network' \|\| r\.reason === 'timeout'/);
  assert.match(ui, /—— 诊断 ——/);
});
