const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* src/teamMode.js 是 ESM(渲染进程用),在函数作用域里求值取出来,
   不引额外构建依赖 */
const T = new Function(`${read('src/teamMode.js').replace(/export /g, '')}
  return { TEAM_PRESETS, MAX_CONSECUTIVE_REJECTS, createTeam, buildHandoff, renderHandoff,
           buildReviewPrompt, buildReworkPrompt, classifyReview, decideTeamStep, engineLabel };`)();

/* 团队模式:一个引擎干活、一个审查,配合目标模式跨轮推进。
 * 这类自动循环出错就是烧钱,判定逻辑必须能离线验证。 */

test('执行方与审查方不能是同一个引擎', () => {
  assert.throws(() => T.createTeam({ worker: 'codex', reviewer: 'codex' }), /不能是同一个/);
  assert.throws(() => T.createTeam({ worker: 'codex' }), /同时指定/);
  const t = T.createTeam({ worker: 'claude', reviewer: 'codex' });
  assert.equal(t.phase, 'work');
  assert.equal(t.rejects, 0);
});

test('「审查不通过」不能被读成「审查通过」', () => {
  // 前者含有后者这个子串,判定顺序反了会让每一次打回都变成通过 ——
  // 那审查就完全失效了,而用户以为有人把过关
  assert.equal(T.classifyReview('结论:审查不通过,第 37 行没判空'), 'reject');
  assert.equal(T.classifyReview('审查通过,已跑完 12 个用例'), 'pass');
  assert.equal(T.classifyReview('审查未通过'), 'reject');
  assert.equal(T.classifyReview('Review failed'), 'reject');
  assert.equal(T.classifyReview('Review passed'), 'pass');
});

test('审查方没给判定词时按未通过处理,绝不当作通过', () => {
  assert.equal(T.classifyReview('我看了一下,大体还行'), 'unclear');
  assert.equal(T.classifyReview(''), 'unclear');

  const team = { ...T.createTeam({ worker: 'claude', reviewer: 'codex' }), phase: 'review' };
  const step = T.decideTeamStep(team, { goalText: 'G', lastText: '我看了一下,大体还行' });
  assert.equal(step.action, 'rework', '含糊结论当作通过是最危险的默认值');
  assert.match(step.message, /未给出明确判定/);
});

test('执行方跑完 -> 切审查方,并带上结构化交接单', () => {
  const team = T.createTeam({ worker: 'claude', reviewer: 'codex' });
  const step = T.decideTeamStep(team, {
    goalText: '把登录接口补上限流',
    lastText: '改好了',
    turnMessages: [
      { role: 'agent', kind: 'tool', name: 'edit_file', detail: 'update /root/api/login.py' },
      { role: 'agent', kind: 'tool', name: 'bash', detail: 'pytest tests/test_login.py' },
      { role: 'agent', kind: 'text', text: '已加上令牌桶限流,测试通过' }
    ]
  });
  assert.equal(step.action, 'review');
  assert.equal(step.agent, 'codex');
  assert.equal(step.patch.phase, 'review');
  assert.equal(step.patch.reviews, 1);
  assert.match(step.prompt, /把登录接口补上限流/);
  assert.match(step.prompt, /\/root\/api\/login\.py/, '改过的文件要交接过去');
  assert.match(step.prompt, /pytest/, '跑过的命令也要交接');
  // 不写死「不许改」的话,审查方会直接上手修,两边又开始抢同一堆文件
  assert.match(step.prompt, /不要自己动手修改任何文件/);
  assert.match(step.prompt, /审查通过/);
  assert.match(step.prompt, /审查不通过/);
});

test('审查通过 -> 交回目标模式,连续打回计数清零', () => {
  const team = { ...T.createTeam({ worker: 'claude', reviewer: 'codex' }), phase: 'review', rejects: 2 };
  const step = T.decideTeamStep(team, { goalText: 'G', lastText: '审查通过' });
  assert.equal(step.action, 'passed');
  assert.equal(step.patch.rejects, 0);
  assert.equal(step.patch.phase, 'work');
});

test('审查不通过 -> 退回执行方,并把审查意见原样带过去', () => {
  const team = { ...T.createTeam({ worker: 'claude', reviewer: 'codex' }), phase: 'review' };
  const review = '审查不通过:\n1. login.py:37 未判空\n2. 测试用例被注释掉了';
  const step = T.decideTeamStep(team, { goalText: 'G', lastText: review });
  assert.equal(step.action, 'rework');
  assert.equal(step.agent, 'claude');
  // 二次概括会把「第 37 行没判空」磨成「注意健壮性」,执行方就不知道改哪了
  assert.match(step.prompt, /login\.py:37 未判空/);
  assert.match(step.prompt, /测试用例被注释掉了/);
  assert.equal(step.patch.rejects, 1);
});

test('连续打回到上限就停下来,不无限对刷', () => {
  const team = {
    ...T.createTeam({ worker: 'claude', reviewer: 'codex' }),
    phase: 'review', rejects: T.MAX_CONSECUTIVE_REJECTS - 1
  };
  const step = T.decideTeamStep(team, { goalText: 'G', lastText: '审查不通过:还是不行' });
  assert.equal(step.action, 'stop');
  assert.equal(step.reason, 'rejects');
});

test('交接单从消息里抽,不额外调模型 —— 那等于每轮多烧一次钱', () => {
  const h = T.buildHandoff([
    { role: 'agent', kind: 'diff', text: '--- a/x.py\n+++ b/src/x.py\n+code' },
    { role: 'agent', kind: 'text', text: '第一段' },
    { role: 'agent', kind: 'text', text: '最终结论' }
  ]);
  assert.deepEqual(h.files, ['src/x.py']);
  assert.equal(h.conclusion, '最终结论', '结论取最后一段,开头常在复述历史');
  // 空交接单要说人话,别甩一堆「无」
  assert.match(T.renderHandoff({}), /没有产生可交接的内容/);
});

test('没开团队模式时不做任何事', () => {
  assert.equal(T.decideTeamStep(null, {}).action, 'idle');
  assert.equal(T.decideTeamStep({ worker: 'claude' }, {}).action, 'idle');
});

test('熔断只归目标模式,团队模式不重复实现', () => {
  const src = read('src/teamMode.js');
  // 两套独立的熔断在边界情况一定会互相抵消
  assert.ok(!/dangerHit|maxRounds|isStalled/.test(src), '危险命令/触顶/打转的判定不该在这里重复');
  const app = read('src/App.jsx');
  // 必须挂在目标模式的 continue/verify 分支里,而不是另起一套调度
  assert.match(app, /conv\.team && \(step\.action === 'continue' \|\| step\.action === 'verify'\)/);
});

test('换引擎跑这一轮必须先 start 再 send,否则会被自己 cancel 掉', () => {
  const store = read('src/store.js');
  assert.match(store, /export async function runAsAgent/);
  // agent:start 会 cancel 已存在的会话,顺序错了就把刚发出的这轮掐死
  assert.match(store, /await window\.api\.agent\.start\(\{[\s\S]{0,600}?\}\);[\s\S]{0,120}await sendToAgent/);
  // 在途时 ChatPanel 的 effect 也不能重启
  const ui = readChatSources();
  assert.match(ui, /if \(useStore\.getState\(\)\.agentRunning\[conv\.id\]\) \{ setStarted\(true\); return; \}/);
});

test('来回切引擎不能把用户选的模型清空', () => {
  const store = read('src/store.js');
  assert.match(store, /model: opts\.model !== undefined \? opts\.model : ''/);
});
