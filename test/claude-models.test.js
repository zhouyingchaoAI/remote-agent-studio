const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./helpers/loadEsm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const M = loadEsm('src/claudeModels.js');

/* ============================================================
 * Claude 模型预设 + CLI 版本门槛。
 *
 * 新模型对 CLI 有最低版本要求(Fable 5 要 2.1.170+),而远端那台机器上的
 * claude 往往是几个月前装的。选了新模型 → CLI 甩一句自己的错误退出 →
 * 用户只看到"又失败了",完全联想不到是版本太旧。
 * ============================================================ */

test('预设里有 Fable 5 / 5.1,用完整标识符', () => {
  /* 短别名(sonnet/opus/haiku)跟随各家族最新版,保留。
     但新模型的短别名有没有对应写法我没有依据,而写错一个别名的
     代价是"一选就报错" —— 所以用文档里明确给出的完整标识符。 */
  const ids = M.CLAUDE_MODELS.map((m) => m.value);
  assert.ok(ids.includes('claude-fable-5'));
  assert.ok(ids.includes('claude-fable-5-1'));
  for (const legacy of ['opus', 'sonnet', 'haiku']) {
    assert.ok(ids.includes(legacy), `${legacy} 不该被挤掉`);
  }
});

test('新模型带最低 CLI 版本,老别名不带', () => {
  const byId = Object.fromEntries(M.CLAUDE_MODELS.map((m) => [m.value, m]));
  assert.equal(byId['claude-fable-5'].minCli, '2.1.170');
  assert.equal(byId['claude-fable-5-1'].minCli, '2.1.255');
  // 短别名一直可用,标一个版本门槛反而会误报
  assert.ok(!byId.opus.minCli);
});

/* ---------------------------------------------- 版本比较 */

test('版本号比较', () => {
  assert.equal(M.compareVersions('2.1.170', '2.1.170'), 0);
  assert.equal(M.compareVersions('2.1.169', '2.1.170'), -1);
  assert.equal(M.compareVersions('2.1.171', '2.1.170'), 1);
  assert.equal(M.compareVersions('2.2.0', '2.1.999'), 1, '按段比较,不是字符串比较');
  assert.equal(M.compareVersions('10.0.0', '9.9.9'), 1, '两位数不能按字典序');
});

test('位数不同时缺的位按 0 补', () => {
  assert.equal(M.compareVersions('2.1', '2.1.0'), 0);
  assert.equal(M.compareVersions('2.1', '2.1.1'), -1);
});

test('从 --version 输出里取版本号', () => {
  assert.equal(M.parseCliVersion('2.1.170 (Claude Code)'), '2.1.170');
  assert.equal(M.parseCliVersion('claude 2.1.255'), '2.1.255');
});

test('取不到版本号返回空,而不是编一个', () => {
  /* 输出格式变过,也可能整个检测就没返回。
     把"没测出来"当成"版本太旧"是在编造结论。 */
  for (const v of ['', null, undefined, 'unknown', '(Claude Code)']) {
    assert.equal(M.parseCliVersion(v), '');
  }
});

/* ---------------------------------------------- 判定 */

test('版本不够时给出能看懂的提示', () => {
  const msg = M.modelVersionProblem('claude-fable-5', '2.1.100 (Claude Code)');
  assert.match(msg, /fable 5/);
  assert.match(msg, /2\.1\.170/, '要说清最低要求是多少');
  assert.match(msg, /2\.1\.100/, '也要说清这台机器现在是多少');
  assert.match(msg, /环境配置/, '给出该去哪儿升级');
});

test('版本够了不提示', () => {
  assert.equal(M.modelVersionProblem('claude-fable-5', '2.1.170'), '');
  assert.equal(M.modelVersionProblem('claude-fable-5', '2.3.0'), '');
});

test('拿不到版本号时一律放行', () => {
  /* 检测可能因为各种原因没返回。这时候拦下来,等于凭空阻止用户
     用一个本来能用的模型 —— 宁可让 CLI 自己去报错。 */
  assert.equal(M.modelVersionProblem('claude-fable-5', ''), '');
  assert.equal(M.modelVersionProblem('claude-fable-5', null), '');
  assert.equal(M.modelVersionProblem('claude-fable-5', '看不懂的输出'), '');
});

test('没有门槛的模型和未知模型都不提示', () => {
  assert.equal(M.modelVersionProblem('opus', '1.0.0'), '');
  assert.equal(M.modelVersionProblem('', '1.0.0'), '');
  assert.equal(M.modelVersionProblem('某个自定义模型', '1.0.0'), '');
});

/* ---------------------------------------------- 接线 */

const chat = read('src/components/ChatPanel.jsx');

test('预设列表同时兼容字符串和对象两种写法', () => {
  /* codex/deepseek 还是纯字符串列表。为了给 claude 加一个字段
     就把另外两个也改一遍,是没必要的改动面。 */
  assert.match(chat, /typeof m === 'string' \? \{ value: m, label: m \} : m/);
});

test('提示只是警告,不禁用选择', () => {
  // 拦错了比漏提示更糟:堵住一个本来能用的模型,而且没法绕过
  assert.match(chat, /versionNote && <span className="model-warn"/);
  assert.ok(!/disabled=\{.*versionNote/.test(chat), '不该因为版本提示就禁用');
});

test('版本号来自环境检测,不是另外再查一次', () => {
  assert.match(chat, /cliVersion=\{hostEnv\?\.claude \|\| ''\}/);
  assert.match(chat, /useStore\(\(s\) => s\.envInfo\[hostId\]\)/);
});
