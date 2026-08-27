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
