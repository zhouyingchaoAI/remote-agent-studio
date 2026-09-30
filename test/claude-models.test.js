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

test('别名优先,钉版 ID 兜底', () => {
  /* 别名各自指向该家族最新版,模型换代时这份列表不用改 ——
     而每次换代都手工改一遍,迟早漏掉一次,留下一个已退役的名字。
     钉版 ID 留着给"要复现结果 / 要避开一次换代"的场景。 */
  const ids = M.CLAUDE_MODELS.map((m) => m.value);
  for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) {
    assert.ok(ids.includes(alias), `缺少别名 ${alias}`);
  }
  assert.ok(ids.includes('claude-fable-5-1'), '要能钉到具体版本');
  assert.ok(ids.includes('claude-opus-5-5'));
});

test('别名排在钉版 ID 前面', () => {
  // 多数人该用别名。钉版排前面等于默认把人推向一个会过期的选择
  const ids = M.CLAUDE_MODELS.map((m) => m.value);
  assert.ok(ids.indexOf('sonnet') < ids.indexOf('claude-fable-5-1'));
});

test('不含已退役的模型名', () => {
  /* 留着已退役的名字,用户选中后只会收到一句没头没尾的报错。
     这条会在下次换代忘记清理时挂掉。 */
  const ids = M.CLAUDE_MODELS.map((m) => m.value);
  for (const dead of ['claude-3-opus', 'claude-2', 'claude-instant']) {
    assert.ok(!ids.includes(dead), `${dead} 已退役`);
  }
});

test('钉版 ID 带最低 CLI 版本,别名一律不带', () => {
  /* 别名在老版本上会解析到老模型,照样能跑 —— 给它标门槛只会误报。
     门槛数字来自 docs.claude.com,会随版本变,所以这里只对得上
     "有没有门槛"这个结构,具体数字在下面单独核对。 */
  const byId = Object.fromEntries(M.CLAUDE_MODELS.map((m) => [m.value, m]));
  assert.equal(byId['claude-fable-5'].minCli, '2.1.170');
  assert.equal(byId['claude-fable-5-1'].minCli, '2.1.257');
  assert.equal(byId['claude-opus-5-5'].minCli, '2.1.280');
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable', 'opusplan']) {
    assert.ok(!byId[alias].minCli, `${alias} 是别名,不该标版本门槛`);
  }
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

/* ---------------------------------------------- Codex 预设 */

test('Codex 列表已退役的型号都清掉了', () => {
  /* gpt-5 / gpt-5-codex 早就从 Codex 退役(gpt-5.4 2026-08-31、
     gpt-5.3-codex-spark 2026-09-14、gpt-5.5 2026-10-14)。
     留在列表里只会让人选中一个不存在的模型,然后收到一句没头没尾的报错。 */
  const chat = read('src/components/ChatPanel.jsx');
  const seg = chat.slice(chat.indexOf('codex: ['), chat.indexOf('deepseek: ['));
  for (const dead of ['gpt-5-codex', "'gpt-5'", 'gpt-5.4', 'gpt-5.3-codex-spark', 'gpt-5.5']) {
    assert.ok(!seg.includes(dead), `${dead} 已退役,不该还在预设里`);
  }
});

test('Codex 列表含当前推荐型号,且推荐的排第一', () => {
  /* 列表是给人选的,第一个应该是"多数情况下该选的那个"。 */
  const chat = read('src/components/ChatPanel.jsx');
  const seg = chat.slice(chat.indexOf('codex: ['), chat.indexOf('deepseek: ['));
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']) {
    assert.ok(seg.includes(id), `缺少 ${id}`);
  }
  assert.ok(seg.indexOf('gpt-6.1-sol') < seg.indexOf('gpt-6-astra'), '推荐的该排最前');
});

test('5.6 系保留 —— 过渡期仍可用,自建端点也常用这几个名字', () => {
  const chat = read('src/components/ChatPanel.jsx');
  const seg = chat.slice(chat.indexOf('codex: ['), chat.indexOf('deepseek: ['));
  assert.ok(seg.includes('gpt-5.6-terra'));
});
