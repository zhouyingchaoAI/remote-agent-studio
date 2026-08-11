const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// src 下是 ESM,测试里轻量转换加载(避免为两个小模块引入构建依赖)
function loadEsm(rel, names) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')
    .replace(/export const/g, 'const')
    .replace(/export function/g, 'function');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`${src}\nmodule.exports = { ${names.join(', ')} };`, sandbox);
  return sandbox.module.exports;
}

const goal = loadEsm('goalMode.js', [
  'classifyGoalProgress', 'isStalled', 'decideGoalStep', 'buildContinuePrompt', 'createGoal', 'GOAL_DEFAULT_MAX_ROUNDS'
]);
const slash = loadEsm('slashCommands.js', [
  'COMMANDS', 'isSlashInput', 'parseSlash', 'matchCommands', 'applyCompletion', 'parseGoalArgs', 'helpText'
]);

/* ---------------- 目标模式 ---------------- */

test('把"仍未通过/继续排查"判为未完成(截图里正是这种情形)', () => {
  assert.equal(goal.classifyGoalProgress('尚未通过截图验收。我会继续按实际页面请求排查。'), 'continue');
  assert.equal(goal.classifyGoalProgress('接口已补齐并返回模型,但可用模型页面仍为空'), 'continue');
  assert.equal(goal.classifyGoalProgress('下一步我将检查前端数据路径'), 'continue');
});

test('只有明确宣告完成才算达成', () => {
  assert.equal(goal.classifyGoalProgress('目标已达成,可用模型列表已正常显示,截图已验证。'), 'done');
  // "所有测试通过" 只是某一步的结果,不再当作目标达成 ——
  // 旧判定就是被这类措辞误伤,导致目标 0 轮就结束
  assert.equal(goal.classifyGoalProgress('所有测试通过'), 'continue');
  // "已修复"但同时说仍未通过 -> 不算完成(未完成信号优先)
  assert.equal(goal.classifyGoalProgress('已修复接口,但列表仍未显示'), 'continue');
});

test('需要人工提供信息时判为 blocked,不再空转', () => {
  assert.equal(goal.classifyGoalProgress('需要你提供数据库密码才能继续'), 'blocked');
  assert.equal(goal.classifyGoalProgress('缺少 token,无法调用该接口'), 'blocked');
});

test('连续多轮输出雷同 -> 判定原地打转', () => {
  const same = ['我在排查前端数据路径', '我在排查前端数据路径', '我在排查前端数据路径'];
  assert.ok(goal.isStalled(same));
  assert.ok(!goal.isStalled(['A', 'B', 'C']));
  assert.ok(!goal.isStalled(['A', 'A'])); // 不足阈值
});

test('decideGoalStep:未达成则继续,并带上目标与自检要求', () => {
  const g = goal.createGoal('让可用模型列表正常显示');
  const step = goal.decideGoalStep(g, { lastText: '仍未通过,继续排查', recentTexts: ['a', 'b'] });
  assert.equal(step.action, 'continue');
  assert.match(step.prompt, /让可用模型列表正常显示/);
  assert.match(step.prompt, /不要停下来等我确认/);
  assert.match(step.prompt, /实际验证/);
});

test('decideGoalStep:危险命令/触顶/打转/阻塞都会停,且给出原因', () => {
  const g = goal.createGoal('目标');
  assert.equal(goal.decideGoalStep(g, { dangerHit: 'rm -rf /' }).reason, 'danger');
  assert.equal(goal.decideGoalStep({ ...g, rounds: 25 }, { lastText: '继续' }).reason, 'maxRounds');
  assert.equal(goal.decideGoalStep(g, { lastText: 'x', recentTexts: ['同样的话', '同样的话', '同样的话'] }).reason, 'stalled');
  assert.equal(goal.decideGoalStep(g, { lastText: '需要你提供密码' }).reason, 'blocked');
  // 宣称达成先走核验轮,核验后再宣称才算 complete
  assert.equal(goal.decideGoalStep(g, { lastText: '目标已达成' }).action, 'verify');
  assert.equal(goal.decideGoalStep({ ...g, verifying: true }, { lastText: '目标已达成' }).action, 'complete');
});

test('非激活状态不推进(暂停/清除后不会偷偷继续烧钱)', () => {
  assert.equal(goal.decideGoalStep({ text: 'x', status: 'paused' }, { lastText: '继续' }).action, 'idle');
  assert.equal(goal.decideGoalStep(null, {}).action, 'idle');
  assert.equal(goal.decideGoalStep({ text: '', status: 'active' }, {}).action, 'idle');
});

/* ---------------- 斜杠命令 ---------------- */

test('parseSlash 识别命令名与参数', () => {
  assert.deepEqual(slash.parseSlash('/goal 修好登录'), { isCommand: true, name: 'goal', args: '修好登录', known: true });
  assert.equal(slash.parseSlash('/nope').known, false);
  assert.equal(slash.parseSlash('普通消息').isCommand, false);
});

test('matchCommands 只在输入命令名阶段给候选', () => {
  assert.ok(slash.matchCommands('/g').some((c) => c.name === 'goal'));
  assert.equal(slash.matchCommands('/').length, slash.COMMANDS.length);
  // 已经在填参数了,不该继续弹菜单挡住视线
  assert.deepEqual(slash.matchCommands('/goal 修好登录'), []);
  // 多行不是命令
  assert.deepEqual(slash.matchCommands('/goal\n第二行'), []);
});

test('applyCompletion 对带参命令补空格,无参命令不补', () => {
  assert.equal(slash.applyCompletion({ name: 'goal', args: '<x>' }), '/goal ');
  assert.equal(slash.applyCompletion({ name: 'help', args: '' }), '/help');
});

test('parseGoalArgs 区分子动作与目标文本', () => {
  assert.deepEqual(slash.parseGoalArgs(''), { sub: 'status' });
  assert.deepEqual(slash.parseGoalArgs('pause'), { sub: 'pause' });
  assert.deepEqual(slash.parseGoalArgs('stop'), { sub: 'pause' });   // stop 视作 pause
  assert.deepEqual(slash.parseGoalArgs('修好可用模型列表'), { sub: 'set', text: '修好可用模型列表' });
});

test('helpText 列出全部命令', () => {
  const h = slash.helpText();
  for (const c of slash.COMMANDS) assert.ok(h.includes(`/${c.name}`));
});

/* ---- 触顶后「继续」只多跑一轮就又停(用户 2026-08-11 反馈的真实现象) ---- */

test('触顶暂停后点继续,不能跑一轮又立刻触顶', () => {
  const { resumeGoalPatch, decideGoalStep, GOAL_EXTEND_ROUNDS } = require('../src/goalMode.js');

  // 复现:25/25 触顶暂停
  let goal = { text: '按任务书开发', status: 'active', rounds: 25, maxRounds: 25 };
  const hit = decideGoalStep(goal, { lastText: '继续排查' });
  assert.equal(hit.action, 'stop');
  assert.equal(hit.reason, 'maxRounds');

  // 旧行为(只改 status)会立刻再次触顶 —— 这就是 bug
  const buggy = { ...goal, status: 'active', rounds: 26 };
  assert.equal(decideGoalStep(buggy, { lastText: '继续排查' }).action, 'stop',
    '仅恢复 status 的话,下一轮必然又停');

  // 新行为:恢复时追加预算
  goal = { ...goal, status: 'paused' };
  const patch = resumeGoalPatch(goal);
  assert.equal(patch.status, 'active');
  assert.equal(patch.maxRounds, 25 + GOAL_EXTEND_ROUNDS);

  const resumed = { ...goal, ...patch, rounds: 26 };
  assert.equal(decideGoalStep(resumed, { lastText: '继续排查' }).action, 'continue',
    '追加预算后应能接着跑');
});

test('未触顶时恢复不该无谓抬高预算', () => {
  const { resumeGoalPatch } = require('../src/goalMode.js');
  const patch = resumeGoalPatch({ status: 'paused', rounds: 3, maxRounds: 25 });
  assert.deepEqual(patch, { status: 'active' });
});

test('/goal max 解析与边界', () => {
  const { parseGoalArgs } = require('../src/slashCommands.js');
  const { setGoalMaxRounds, GOAL_MAX_ROUNDS_CAP } = require('../src/goalMode.js');

  assert.deepEqual(parseGoalArgs('max 100'), { sub: 'max', rounds: 100 });
  assert.deepEqual(parseGoalArgs('max  8'), { sub: 'max', rounds: 8 });
  assert.equal(parseGoalArgs('max abc').sub, 'set'); // 不是数字就当成目标描述

  // 设的值比已跑轮次还小 -> 抬到 rounds+1,否则设完立刻又触顶
  assert.equal(setGoalMaxRounds({ rounds: 30 }, 10).maxRounds, 31);
  // 封顶
  assert.equal(setGoalMaxRounds({ rounds: 0 }, 99999).maxRounds, GOAL_MAX_ROUNDS_CAP);
  assert.throws(() => setGoalMaxRounds({ rounds: 0 }, 0), /正整数/);
});

/* ---- 达成判定过松 + 达成后目标条不消失(用户 2026-08-11 反馈) ---- */

test('某一步完成不等于目标达成(旧判定 0 轮就结束的根因)', () => {
  const { classifyGoalProgress } = require('../src/goalMode.js');
  // 截图里的真实措辞:都是阶段性成果,不该判为目标达成
  for (const s of [
    '11 个测试套件、13 项测试和编译全部通过;我现在在运行中的 PostgreSQL 上创建一条标记资源。',
    '已完成资源标记的第一层强制访问控制。',
    '容器健康检查通过: {"status":"ok"}',
    '类型已修正;我重新执行项目目录测试和编译。'
  ]) {
    assert.notEqual(classifyGoalProgress(s), 'done', `不该判达成: ${s.slice(0, 24)}`);
  }
});

test('只有显式宣告整体达成才算', () => {
  const { classifyGoalProgress } = require('../src/goalMode.js');
  for (const s of ['目标已达成,验收清单如下', '所有任务都已完成', 'goal achieved', 'task is complete']) {
    assert.equal(classifyGoalProgress(s), 'done', `应判达成: ${s}`);
  }
});

test('宣称达成先走核验轮,再说一次才算完成', () => {
  const { decideGoalStep } = require('../src/goalMode.js');
  const base = { text: '写平台说明书', status: 'active', rounds: 3, maxRounds: 25 };

  // 第一次宣称 -> 不采信,追一轮核验
  const first = decideGoalStep(base, { lastText: '目标已达成' });
  assert.equal(first.action, 'verify');
  assert.match(first.prompt, /可复现的证据/);
  assert.match(first.prompt, /不算证据/);

  // 核验轮后仍宣称达成 -> 才算完成
  const second = decideGoalStep({ ...base, verifying: true }, { lastText: '目标已达成,清单如下' });
  assert.equal(second.action, 'complete');

  // 核验轮发现没做完 -> 回到正常推进,并撤销核验态
  const back = decideGoalStep({ ...base, verifying: true }, { lastText: '还差接口鉴权未完成,下一步继续' });
  assert.equal(back.action, 'continue');
  assert.equal(back.clearVerifying, true);
});

test('达成消息带上目标原文,清掉目标后还能找回来重设', () => {
  const { buildCompleteMessage } = require('../src/goalMode.js');
  const msg = buildCompleteMessage({ text: '帮我写详细的平台使用说明书', rounds: 7 });
  assert.match(msg, /帮我写详细的平台使用说明书/);
  assert.match(msg, /共推进 7 轮/);
  assert.match(msg, /重新设定/);
});
