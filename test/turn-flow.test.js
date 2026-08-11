const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 与其它前端模块测试一致:把 ESM 转成可执行的 CJS 片段 */
function loadEsm(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/^export\s+(function|const|let)\s+/gm, '$1 ')
    .replace(/^import[^\n]*\n/gm, '');
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;__out = { autoConfirmOutcome, autoPauseMessage };`, sandbox);
  return sandbox.__out;
}

const { autoConfirmOutcome, autoPauseMessage } = loadEsm('src/turnFlow.js');

/* 用户 2026-08-11 反馈:开着全自动时目标模式停住不动、轮次不涨。
 * 根因是全自动分支无条件 return,目标模式代码永远执行不到。 */

test('全自动没在等确认时必须交棒给目标模式(否则目标永远不推进)', () => {
  // 截图里模型的原话:自己收尾了,但明说目标没达成 —— 这不是提问
  assert.equal(
    autoConfirmOutcome({ enabled: true, awaitingConfirm: false, dangerHit: null }),
    'idle',
    '不是在等确认就该交给目标模式,而不是直接结束本轮'
  );
});

test('全自动确实在等确认时由它应答,不叠加目标续推', () => {
  assert.equal(
    autoConfirmOutcome({ enabled: true, awaitingConfirm: true, verdictOk: true }),
    'sent'
  );
});

test('确认次数超限/重复提问 -> 暂停,不再自动点头', () => {
  assert.equal(
    autoConfirmOutcome({ enabled: true, awaitingConfirm: true, verdictOk: false }),
    'paused'
  );
});

test('危险命令一律暂停,优先级高于"是否在等确认"', () => {
  assert.equal(
    autoConfirmOutcome({ enabled: true, awaitingConfirm: true, verdictOk: true, dangerHit: 'rm -rf /' }),
    'paused'
  );
  assert.equal(
    autoConfirmOutcome({ enabled: true, awaitingConfirm: false, dangerHit: 'rm -rf /' }),
    'paused'
  );
});

test('没开全自动时它不插手,直接走目标模式', () => {
  assert.equal(autoConfirmOutcome({ enabled: false, awaitingConfirm: true }), 'idle');
  assert.equal(autoConfirmOutcome({}), 'idle');
});

test('暂停原因说清楚是哪一种,不要笼统一句"已暂停"', () => {
  assert.match(autoPauseMessage({ dangerHit: 'git reset --hard' }), /危险命令.*git reset --hard/);
  assert.match(autoPauseMessage({ verdictReason: 'repeat' }), /重复发出同一确认请求/);
  assert.match(autoPauseMessage({ maxReplies: 5 }), /连续自动确认 5 次/);
});

/* ---- 与目标模式合起来看:开着全自动也必须能连续推进 ---- */

test('端到端:全自动 + 目标模式,模型自行收尾时应被踢着继续', () => {
  const goalSrc = fs.readFileSync(path.join(__dirname, '..', 'src/goalMode.js'), 'utf8')
    .replace(/^export\s+(function|const|let)\s+/gm, '$1 ');
  const box = { module: { exports: {} }, console };
  vm.createContext(box);
  vm.runInContext(`${goalSrc}\n;__out = { decideGoalStep };`, box);
  const { decideGoalStep } = box.__out;

  // 截图里的真实结尾
  const lastText = '目标尚未达成,已完成资源标记的第一层强制访问控制。'
    + '下一步继续实现项目成员角色授权,再补对象标准视图、资源血缘与健康记录。';

  const outcome = autoConfirmOutcome({ enabled: true, awaitingConfirm: false, dangerHit: null });
  assert.equal(outcome, 'idle', '全自动应放行');

  const step = decideGoalStep(
    { text: '按任务书开发', status: 'active', rounds: 19, maxRounds: 25 },
    { lastText, recentTexts: [lastText] }
  );
  assert.equal(step.action, 'continue', '目标模式应接手并继续推进');
  assert.match(step.prompt, /第 20 轮/);
});
