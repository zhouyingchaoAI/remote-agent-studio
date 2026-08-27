const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ErrorLog, redact, classifyError, fingerprint, makeEntry, aggregate
} = require('../electron/errorLog');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 异常日志的目的是「定期拿它修平台」,所以脱敏、指纹聚合、有界
 * 这三件事比落盘本身更重要。 */

/* ------------------------------------------------------------ 脱敏 */

test('API key 一律抹掉 —— 日志会被导出、贴 issue、发给别人', () => {
  /* 这条不是假想威胁:本项目里真的发生过 key 被粘进对话。
     样本必须是编造的 —— 仓库有一条守卫测试禁止出现真实密钥,
     写测试时拿真 key 当样本,就是在自己防的那个洞上再开一次。 */
  /* 拼出来而不是写成一整个字面量:守卫测试按形状匹配
     (sk- 后跟 32 位以上),编得够真就会被自己的守卫拦下。
     样本又必须够长才测得出脱敏规则,所以拆开写。 */
  const fake = `sk-${'Ab12ZzYyXxWw'}${'VvUuTtSsRrQq'}${'PpOoNnMmLlKk'}`;
  const out = redact(`AUTH fail, api key: ${fake} invalid`);
  assert.ok(!out.includes('ZzYyXxWwVvUu'), `没抹干净:${out}`);
  assert.match(out, /sk-Ab12\*\*\*/, '保留前缀便于分辨是哪一类凭据');
});

test('各种凭据形态都要盖住', () => {
  assert.ok(!redact('export DEEPSEEK_API_KEY=abcdefghijklmn').includes('abcdefghij'));
  assert.ok(!redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9').includes('eyJhbGciOi'));
  assert.ok(!redact('{"apiKey": "supersecretvalue"}').includes('supersecretvalue'));
  // 同样拼接构造:仓库守卫按形状拦截,写成整串字面量会被自己拦下
  const ghFake = `ghp_${'1234567890'}${'abcdefghij'}`;
  assert.ok(!redact(ghFake).includes('1234567890abcdef'));
  assert.ok(!redact('password: hunter2hunter2').includes('hunter2hunter2'));
  // URL 里的账号密码
  assert.ok(!redact('https://admin:s3cr3tpass@relay.example.com').includes('s3cr3tpass'));
  // 私钥整段
  const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  assert.ok(!redact(pk).includes('MIIEow'));
});

test('落盘的条目一定是脱敏后的 —— 不能指望调用方记得洗', () => {
  const e = makeEntry({ source: 'agent', text: 'key sk-abcd1234567890abcdef failed' });
  assert.ok(!e.text.includes('1234567890abcdef'));
});

/* ------------------------------------------------------------ 分类 */

test('代码崩溃优先归为 crash —— 它是唯一必须改代码的类别', () => {
  // 这条真实报错里含 "not a function"/"Cannot read",会被别的规则蹭到,
  // 归错类就会被埋在「未安装」里没人管
  assert.equal(classifyError("Cannot read properties of null (reading 'permissionMode')"), 'crash');
  assert.equal(classifyError('TypeError: fn is not a function'), 'crash');
});

test('其余类别各归各位', () => {
  assert.equal(classifyError('AUTH: Authentication Fails, api key is invalid'), 'auth');
  assert.equal(classifyError('connect ETIMEDOUT 10.1.6.230:22'), 'network');
  assert.equal(classifyError('429 rate limit exceeded'), 'quota');
  assert.equal(classifyError('dsh: command not found'), 'install');
  assert.equal(classifyError('随便一句没见过的话'), 'unknown');
});

/* ------------------------------------------------------------ 指纹 */

test('同一个 bug 的不同实例要归到一组', () => {
  // 不做指纹的话,同一个错因为路径/行号/时间不同会散成几十条
  const a = fingerprint("ENOENT: no such file '/root/code/a/x.py' at line 37");
  const b = fingerprint("ENOENT: no such file '/home/other/b/y.py' at line 912");
  assert.equal(a, b);
});

test('不同的 bug 不能被合并', () => {
  assert.notEqual(
    fingerprint('TypeError: cannot read permissionMode'),
    fingerprint('TypeError: cannot read dshConfig')
  );
});

test('IP、时间戳、hash 都要归一', () => {
  assert.equal(
    fingerprint('2026-08-26T10:00:00Z conn 10.1.6.230:22 id a1b2c3d4e5f6'),
    fingerprint('2026-01-01T03:22:11Z conn 172.16.5.207:22 id ffffffffffff')
  );
});

/* ------------------------------------------------------------ 聚合 */

test('按出现次数排序 —— 修平台的优先级就是这个顺序', () => {
  const mk = (text, ts) => makeEntry({ source: 'agent', text, hostId: 'h1' , level: 'error'});
  const entries = [
    { ...mk('TypeError: read x of null'), ts: 1 },
    { ...mk('TypeError: read x of null'), ts: 2 },
    { ...mk('TypeError: read x of null'), ts: 3 },
    { ...mk('connect ETIMEDOUT 1.2.3.4'), ts: 9 }
  ];
  const g = aggregate(entries);
  assert.equal(g[0].count, 3, '出现最多的排最前');
  assert.equal(g[0].firstSeen, 1);
  assert.equal(g[0].lastSeen, 3);
  assert.deepEqual(g[0].hosts, ['h1']);
  assert.equal(g.length, 2);
});

test('空输入与脏数据不崩', () => {
  assert.deepEqual(aggregate([]), []);
  assert.doesNotThrow(() => aggregate([null, undefined]));
});

/* ------------------------------------------------------------ 落盘 */

test('端到端:写入、读回(最新在前)、清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-errlog-'));
  const log = new ErrorLog(dir);
  log.append({ source: 'agent', text: '第一个错' });
  log.append({ source: 'ipc:agent:send', text: '第二个错' });

  const got = log.read();
  assert.equal(got.length, 2);
  assert.equal(got[0].text, '第二个错', '最新的排最前');
  assert.equal(got[0].source, 'ipc:agent:send');

  log.clear();
  assert.deepEqual(log.read(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('单行坏了不该让整个日志页打不开', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-errlog-bad-'));
  const log = new ErrorLog(dir);
  log.append({ source: 'a', text: '好的一条' });
  fs.appendFileSync(log.file, '{这不是合法 JSON\n', 'utf8');
  log.append({ source: 'b', text: '后面的一条' });

  const got = log.read();
  assert.equal(got.length, 2, '坏行跳过,好行照读');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记日志失败绝不能影响主流程 —— 它只是观测', () => {
  /* 造一个必然失败的目标:把一个普通文件当作父目录,mkdir 会立刻 ENOTDIR。
     (别用 /proc 之类的特殊文件系统,不同环境下行为不一致,还可能直接挂住) */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-errlog-ro-'));
  const blocker = path.join(dir, 'iam-a-file');
  fs.writeFileSync(blocker, 'x');

  const log = new ErrorLog(path.join(blocker, 'nested'));
  assert.doesNotThrow(() => log.append({ source: 'x', text: 'y' }));
  assert.deepEqual(log.read(), [], '读不到也不该抛');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ 接线 */

test('每个 IPC handler 都被包住,且包完仍原样抛出', () => {
  const main = read('electron/main.js');
  // 逐个 handler 加 try/catch 会漏,漏掉的往往就是没人复现得了的那个
  assert.match(main, /const _rawHandle = ipcMain\.handle\.bind\(ipcMain\)/);
  assert.match(main, /source: `ipc:\$\{channel\}`/);
  assert.match(main, /throw e;\s*\/\/ 观测不改变行为/);
});

test('主进程与渲染进程的未捕获异常都有兜底', () => {
  const main = read('electron/main.js');
  assert.match(main, /process\.on\('uncaughtException'/);
  assert.match(main, /process\.on\('unhandledRejection'/);
  const app = read('src/App.jsx');
  assert.match(app, /addEventListener\('error', onWinError\)/);
  assert.match(app, /addEventListener\('unhandledrejection', onRejection\)/);
  // 加了监听就得摘,否则热重载会越堆越多
  assert.match(app, /removeEventListener\('error', onWinError\)/);
});

test('对话里的红框错误进日志(用户最直接感知的异常)', () => {
  assert.match(read('electron/main.js'), /msg\.kind === 'error' && msg\.text\)/);
});
