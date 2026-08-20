const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { REASONING_EFFORTS, codexReasoningFlag } = require('../electron/ssh/codexOptions');
const { AgentSession } = require('../electron/ssh/AgentSession');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 用户:「codex 不能使用快速模式以及推理极高最强模型」。
 * 查官方配置参考确认 model_reasoning_effort 取值为
 * minimal|low|medium|high|xhigh —— xhigh 就是界面上的「极高」,
 * 且文档注明它是模型相关的(不是所有模型都提供)。 */

test('取值与官方一致,含 xhigh(极高)', () => {
  const values = REASONING_EFFORTS.map((r) => r.value).filter(Boolean);
  assert.deepEqual(values, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(REASONING_EFFORTS.find((r) => r.value === 'xhigh').label, '极高');
});

test('生成 -c 覆盖而不是改远程 config.toml', () => {
  assert.equal(codexReasoningFlag('xhigh'), '-c model_reasoning_effort=xhigh');
  assert.equal(codexReasoningFlag(''), '');
  assert.equal(codexReasoningFlag(null), '');
  assert.equal(codexReasoningFlag('  HIGH  '), '-c model_reasoning_effort=high');
});

test('非法值当场报错,不把垃圾拼进命令行', () => {
  // 传个 CLI 不认的值会让整轮失败,而那种报错读起来完全不像「你选错了强度」
  assert.throws(() => codexReasoningFlag('极高'), /不支持的推理强度/);
  assert.throws(() => codexReasoningFlag('ultra'), /minimal\/low\/medium\/high\/xhigh/);
  // 顺带挡住注入
  assert.throws(() => codexReasoningFlag('high; rm -rf /'), /不支持的推理强度/);
});

test('端到端:选了极高就出现在真实命令里,且在 resume 子命令之前', () => {
  const s = new AgentSession({ exec() {} }, null, {
    agent: 'codex', cwd: '/root/code', model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh', permissionMode: 'system'
  });
  const first = s.buildCommand('干活', {});
  assert.match(first, /-c model_reasoning_effort=xhigh/);

  // codex 的全局选项必须排在 resume 之前,否则会被当成 resume 的参数
  s.codexSessionId = 'sess-123';
  const resumed = s.buildCommand('继续', {});
  const effortAt = resumed.indexOf('model_reasoning_effort');
  const resumeAt = resumed.indexOf('resume ');
  assert.ok(effortAt > 0 && effortAt < resumeAt, '推理强度必须在 resume 之前');
});

test('不设置时不往命令里塞空参数残留', () => {
  const s = new AgentSession({ exec() {} }, null, { agent: 'codex', cwd: '/x' });
  assert.ok(!s.buildCommand('hi', {}).includes('model_reasoning_effort'));
});

test('只对 codex 生效:其他引擎没有这个开关', () => {
  const ui = read('src/components/ChatPanel.jsx');
  assert.match(ui, /conv\.agent === 'codex' && \(/);
  assert.match(ui, /reasoningEffort: conv\.agent === 'codex'/);

  for (const agent of ['claude', 'deepseek', 'dsh']) {
    const s = new AgentSession({ exec() {} }, null, { agent, cwd: '/x', reasoningEffort: 'xhigh' });
    assert.ok(!s.buildCommand('hi', {}).includes('model_reasoning_effort'),
      `${agent} 不该带 codex 的参数`);
  }
});

test('前后端两份选项不许漂移(手抄两份最怕悄悄不一致)', () => {
  const ui = read('src/reasoningEfforts.js');
  for (const r of REASONING_EFFORTS) {
    if (!r.value) continue;
    assert.match(ui, new RegExp(`value: '${r.value}'`), `前端缺 ${r.value}`);
  }
  assert.match(ui, /label: '极高'/);
});
