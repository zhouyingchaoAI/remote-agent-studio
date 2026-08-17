const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 用户要求「不打开浏览器,工具集成浏览器功能」——
 * dsh 的模型配置只能在它自己的 Web UI 里做,不该逼用户切出去。 */

test('主窗口开启 webviewTag,但不给 webview 开 nodeIntegration', () => {
  const main = read('electron/main.js');
  assert.match(main, /webviewTag: true/);
  // 内置浏览器会加载外部页面,绝不能让页面脚本碰到 Node
  assert.match(main, /nodeIntegration: false/);
  // 只看真正带属性的那个 <webview>,文档注释里也提到过这个词
  const tag = read('src/components/BrowserPanel.jsx').match(/<webview\s+[^>]+>/)[0];
  assert.ok(!/nodeintegration/i.test(tag), 'webview 标签不该带 nodeintegration');
  assert.ok(!/allowpopups/i.test(tag), '不开弹窗,外链走系统浏览器');
  assert.match(tag, /partition="persist:ras-browser"/, '用独立分区,别和应用自身共用会话');
});

test('后台服务:重复启动直接返回现状,不撞端口', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /if \(existing\?\.child && !existing\.child\.killed\) return statusOf\(id\)/);
});

test('spawn 必须挂 error 监听,否则主进程会被直接干掉', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /child\.on\('error'/);
  assert.match(src, /child\.on\('close'/);
});

test('端口被占时从输出里认出实际端口', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /127\\\.0\\\.0\\\.1:\(\\d\{2,5\}\)/);
});

test('退出时收尾后台进程,不留在系统里', () => {
  assert.match(read('electron/webServices.js'), /function stopAll/);
  assert.match(read('electron/main.js'), /before-quit[\s\S]{0,80}stopAll/);
});

test('停止走 TERM,超时再 KILL,避免端口一直被占', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /SIGTERM/);
  assert.match(src, /SIGKILL/);
});

test('浏览面板挂进 tab,且不要求主机已连接', () => {
  const app = read('src/App.jsx');
  assert.match(app, /key: 'browser'/);
  assert.match(app, /<BrowserPanel \/>/);
  // 内置浏览器开的是本机地址,和 SSH 连接无关
  assert.match(app, /'mobile', 'browser'\]\.includes\(activeView\)/);
});

test('地址没有协议前缀时自动补 http://', () => {
  const src = read('src/components/BrowserPanel.jsx');
  assert.match(src, /if \(!\/\^https\?:\\\/\\\/\/i\.test\(next\)\) next = `http:\/\/\$\{next\}`/);
});

test('加载失败要区分「被主动中断」与真失败', () => {
  const src = read('src/components/BrowserPanel.jsx');
  // errorCode -3 是导航被取代,报出来是噪音
  assert.match(src, /errorCode === -3/);
  assert.match(src, /isMainFrame/);
});

test('dsh 配置入口只在本机且已安装时出现', () => {
  const src = read('src/components/SetupPanel.jsx');
  assert.match(src, /isLocal && env\?\.dsh &&/);
  assert.match(src, /setPendingBrowserUrl/);
  assert.match(src, /setTab\('browser'\)/);
});

/* 用户反馈:点了「配置 dsh 模型」得到 ERR_CONNECTION_REFUSED —— 服务没起来,
 * 而界面上什么线索都没有。三个原因:等待时间是猜的、日志不可见、
 * 明明装了 dsh 却仍走 npx 重新下载。 */

test('装了全局 dsh 就直接用它,npx 只作为回退', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /command: 'dsh'/);
  assert.match(src, /fallback: \{ command: 'npx'/);
  // 走 npx @latest 每次都要联网解析下载,首次几十秒
  assert.match(src, /几十秒/);
});

test('命令不存在时自动退到 npx,而不是丢一句 ENOENT', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /err\.code === 'ENOENT'/);
  assert.match(src, /def\.fallback/);
});

test('补上 npm 全局 bin 路径(GUI 应用继承不到 shell 的 PATH)', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /\.npm-global\/bin/);
  assert.match(src, /PATH: `\$\{process\.env\.PATH/);
});

test('等端口真能连上再导航,不用固定 sleep', () => {
  const src = read('electron/webServices.js');
  assert.match(src, /function waitReady/);
  assert.match(src, /net\.connect/);
  // 进程已退出就别再空等,直接把日志给用户
  assert.match(src, /reason: 'exited'/);
  assert.match(src, /reason: 'timeout'/);

  const panel = read('src/components/BrowserPanel.jsx');
  assert.match(panel, /web\.waitReady/);
  assert.ok(!/setTimeout\(\(\) => go\(/.test(panel), '不该再用固定 sleep 猜启动时间');
});

test('启动日志可见 —— 白屏时用户要能判断在下载还是报错', () => {
  const panel = read('src/components/BrowserPanel.jsx');
  assert.match(panel, /web\.onLog/);
  assert.match(panel, /browser-log/);
  assert.match(panel, /启动日志/);
  // 等待秒数也要显示,否则不知道是卡住还是在进行
  assert.match(panel, /onWaiting/);
  assert.match(panel, /启动中…/);
});
