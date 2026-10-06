const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadEsm } = require('./helpers/loadEsm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const P = loadEsm('src/planProgress.js');
const G = loadEsm('src/goalMode.js', { './planProgress.js': P });

/* ------------------------------------------------------------ 解析 */

test('认三种勾选状态', () => {
  const steps = P.parsePlan([
    '# 计划',
    '- [x] 建目录结构',
    '- [~] 写核心模块',
    '- [ ] 补测试'
  ].join('\n'));
  assert.deepEqual(steps.map((s) => s.state), ['done', 'doing', 'todo']);
  assert.equal(steps[1].text, '写核心模块');
});

test('只认清单项,正文和标题不算步骤', () => {
  /* 计划文件里通常夹着大段说明。把它们当成步骤的话,
     总数会虚高好几倍,「第 3 / 18 步」直接变成假数字。 */
  const steps = P.parsePlan([
    '## 背景',
    '这个项目要做的事情很多,包括 A、B、C。',
    '- 这是普通列表项,不是清单',
    '- [x] 真正的步骤'
  ].join('\n'));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, '真正的步骤');
});

test('* 和 + 开头、带缩进的清单都认', () => {
  // 不同模型的 markdown 习惯不一样,只认 `-` 会漏掉一半
  const steps = P.parsePlan('* [x] a\n  + [ ] b\n   - [X] c');
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((s) => s.state), ['done', 'todo', 'done']);
});

test('步骤数有上限,防止把日志当计划', () => {
  const md = Array.from({ length: 500 }, (_, i) => `- [ ] step ${i}`).join('\n');
  assert.equal(P.parsePlan(md).length, P.MAX_STEPS);
});

test('空输入不炸', () => {
  for (const v of ['', null, undefined, '   ']) assert.deepEqual(P.parsePlan(v), []);
});

/* ------------------------------------------------------------ 汇总 */

test('当前步取第一个未完成的,不是已完成数 +1', () => {
  /* 跳着做的时候(第 3 步没完就先做了第 5 步),"已完成数 +1"
     会报一个比实际靠前的数字,看着像倒退了。 */
  const steps = P.parsePlan('- [x] a\n- [ ] b\n- [x] c\n- [ ] d');
  const s = P.planSummary(steps);
  assert.equal(s.done, 2);
  assert.equal(s.current, 2, '第一个没做完的是 b');
  assert.equal(s.text, '第 2 / 4 步');
});

test('有明确「进行中」时以它为准', () => {
  const s = P.planSummary(P.parsePlan('- [x] a\n- [ ] b\n- [~] c'));
  assert.equal(s.current, 3);
  assert.equal(s.currentText, 'c');
});

test('百分比按已完成算,不按当前第几步', () => {
  /* 站在第 3 步不等于前 2 步都完事了。用当前步数算会虚报进度 ——
     进度条只要有一次虚报,人就再也不会信它。 */
  const s = P.planSummary(P.parsePlan('- [ ] a\n- [ ] b\n- [~] c\n- [ ] d'));
  assert.equal(s.done, 0);
  assert.equal(s.percent, 0, '一个都没勾,进度就是 0');
  assert.equal(s.current, 3);
});

test('空计划返回 total 0 而不是崩', () => {
  const s = P.planSummary([]);
  assert.equal(s.total, 0);
  assert.equal(s.text, '');
});

/* ------------------------------------------------------------ 停滞 */

const hist = (...pairs) => pairs.map(([at, done, total = 10]) => ({ at, done, total }));

test('完成数长时间不涨才算停滞', () => {
  const h = hist([0, 3], [60_000, 3], [20 * 60_000, 3]);
  assert.equal(P.planStalled(h, { stallMs: 15 * 60_000, now: 20 * 60_000 }), true);
});

test('只要涨过就重置计时', () => {
  const h = hist([0, 3], [19 * 60_000, 4]);
  assert.equal(P.planStalled(h, { stallMs: 15 * 60_000, now: 20 * 60_000 }), false);
});

test('样本不足时不判停滞', () => {
  /* 只有一个快照时说"没推进"和瞎猜没区别 ——
     而误报停滞会让人去查一个不存在的故障。 */
  assert.equal(P.planStalled(hist([0, 0]), { now: 10 ** 9 }), false);
  assert.equal(P.planStalled([], { now: 10 ** 9 }), false);
});

test('全部完成就不算停滞', () => {
  // 做完了本来就不会再涨,这不是卡住
  const h = hist([0, 10, 10], [60_000, 10, 10], [10 ** 9, 10, 10]);
  assert.equal(P.planStalled(h, { stallMs: 1000, now: 10 ** 9 }), false);
});

/* ------------------------------------------------------------ 提示词 */

test('提示词明确要求改文件,而不是在回复里描述', () => {
  /* 光说"更新进度"的话,模型会在回复里写一段进度描述、不去动文件 ——
     那样应用还是读不到任何东西,这个功能等于没有。 */
  const f = P.planPromptFragment('/root/progress.md');
  assert.match(f, /\/root\/progress\.md/);
  assert.match(f, /不要只在回复里描述/);
  assert.match(f, /\[x\]/);
});

test('没有计划文件时不产生任何提示词', () => {
  assert.equal(P.planPromptFragment(''), '');
  assert.equal(P.planPromptFragment(null), '');
});

/* ------------------------------------------------------------ 与目标模式的接线 */

const activeGoal = (over = {}) => ({
  ...G.createGoal('部署服务', { planPath: '/root/progress.md' }), ...over
});

test('计划没勾完却说达成 -> 驳回,并列出没勾的条目', () => {
  /* 这是有计划文件之后最值钱的一条检查:模型宣称完成的成本是零,
     而一份写着 3/18 的清单直接反驳了它。 */
  const steps = P.parsePlan('- [x] a\n- [ ] 补测试\n- [ ] 写文档');
  const goal = activeGoal(G.mergePlan(null, steps, { now: 0 }));
  const step = G.decideGoalStep(goal, { lastText: '目标已达成', now: 1000 });
  assert.equal(step.action, 'continue');
  assert.equal(step.planPushback, 1);
  assert.match(step.prompt, /补测试/);
  assert.match(step.prompt, /写文档/);
  assert.match(step.message, /第 2 \/ 3 步/);
});

test('驳回有次数上限 —— 陈旧的清单不能把目标永远卡住', () => {
  /* 模型可能真做完了,只是忘了勾最后一个框。
     一直拿旧清单否定它,会比不检查更糟。 */
  const steps = P.parsePlan('- [x] a\n- [ ] b');
  const goal = activeGoal({
    ...G.mergePlan(null, steps, { now: 0 }),
    planPushback: G.GOAL_PLAN_PUSHBACK_MAX
  });
  const step = G.decideGoalStep(goal, { lastText: '目标已达成', now: 1000 });
  assert.notEqual(step.action, 'continue');
});

test('放行时必须说出"计划和达成是矛盾的",不能替模型背书', () => {
  const steps = P.parsePlan('- [x] a\n- [ ] b');
  const goal = activeGoal({
    ...G.mergePlan(null, steps, { now: 0 }),
    planPushback: G.GOAL_PLAN_PUSHBACK_MAX, verifying: true
  });
  const step = G.decideGoalStep(goal, { lastText: '目标已达成', now: 1000 });
  assert.equal(step.action, 'complete');
  assert.match(step.message, /计划文件仍停在/);
});

test('计划勾完了就不驳回', () => {
  const steps = P.parsePlan('- [x] a\n- [x] b');
  const goal = activeGoal({ ...G.mergePlan(null, steps, { now: 0 }), verifying: true });
  const step = G.decideGoalStep(goal, { lastText: '目标已达成', now: 1000 });
  assert.equal(step.action, 'complete');
  assert.ok(!/计划文件仍停在/.test(step.message));
});

test('计划长时间没推进 -> 停下来,并说清可能只是忘了更新文件', () => {
  const steps = P.parsePlan('- [x] a\n- [~] 拉镜像\n- [ ] c');
  const goal = activeGoal({
    plan: { ...P.planSummary(steps), steps },
    planHistory: hist([0, 1, 3], [30 * 60_000, 1, 3])
  });
  const step = G.decideGoalStep(goal, { lastText: '还在继续排查', now: 30 * 60_000 });
  assert.equal(step.action, 'stop');
  assert.equal(step.reason, 'planStalled');
  assert.match(step.message, /拉镜像/);
  /* **不能断言成"任务失败"。** 它可能只是没更新文件,
     写死成失败就是在编造一个我们并不知道的结论。 */
  assert.match(step.message, /忘了更新计划文件/);
});

test('续推提示词带上"你在第几步"', () => {
  // 「第 12 轮」对模型和对人一样没信息量;「第 3 / 18 步」能让它接着干
  const steps = P.parsePlan('- [x] a\n- [~] 写核心模块\n- [ ] c');
  const goal = activeGoal();
  const p = G.buildContinuePrompt(goal, { plan: { ...P.planSummary(steps), steps } });
  assert.match(p, /第 2 \/ 3 步/);
  assert.match(p, /写核心模块/);
  assert.match(p, /progress\.md/, '同时要提醒它更新文件');
});

test('没有计划时续推提示词跟以前一样,不多出空行或残留标题', () => {
  const p = G.buildContinuePrompt(G.createGoal('随便'), {});
  assert.ok(!/计划文件/.test(p));
  assert.ok(!/undefined|null/.test(p));
  assert.equal(p, p.trimEnd(), '结尾不能留空行');
});

/* ------------------------------------------------------------ 合并 */

test('读到的计划写进历史,供停滞判定使用', () => {
  const steps = P.parsePlan('- [x] a\n- [ ] b');
  const p1 = G.mergePlan(null, steps, { now: 100 });
  assert.equal(p1.plan.done, 1);
  assert.deepEqual(p1.planHistory, [{ at: 100, done: 1, total: 2 }]);
  const p2 = G.mergePlan(p1, P.parsePlan('- [x] a\n- [x] b'), { now: 200 });
  assert.equal(p2.planHistory.length, 2);
  assert.equal(p2.plan.percent, 100);
});

test('解析不出步骤时不写历史', () => {
  /* 一次读取失败(文件还没建、主机抖了一下)不该被当成"进度没涨",
     那会让停滞判定凭空提前触发。 */
  const prev = G.mergePlan(null, P.parsePlan('- [ ] a'), { now: 0 });
  const next = G.mergePlan(prev, [], { now: 999 });
  assert.equal(next.plan, null);
  assert.equal(next.planHistory, undefined, '历史保持原样,不追加也不清空');
});

test('历史有长度上限', () => {
  let g = null;
  for (let i = 0; i < G.PLAN_HISTORY_MAX + 30; i += 1) {
    g = { ...(g || {}), ...G.mergePlan(g, P.parsePlan('- [ ] a'), { now: i }) };
  }
  assert.equal(g.planHistory.length, G.PLAN_HISTORY_MAX);
});

/* ------------------------------------------------------------ 自动拆解 */

test('拆解提示词要求真的写文件,并且写完接着干', () => {
  /* 两条都是踩出来的:
     只说"拆成清单"→ 模型在回复里列一张漂亮的清单然后就没了,应用读不到;
     不说"别停"→ 它写完计划会停下来等你说"开始"。 */
  const p = P.buildDecomposePrompt({ text: '部署 ragflow', planPath: '/root/p.md' });
  assert.match(p, /\/root\/p\.md/);
  assert.match(p, /不要只在回复里列清单/);
  assert.match(p, /不要停下来等我确认/);
  assert.match(p, /8~40 条/, '不给粒度会拆出 5 条或 200 条,两种都没法看进度');
});

test('默认计划路径按对话隔离,且文件名安全', () => {
  /* 有默认路径,拆解才能默认发生 —— 要用户先想出一个路径再手敲 --plan,
     这个功能就只有极少数人会用到。 */
  assert.notEqual(P.defaultPlanPath('conv-a'), P.defaultPlanPath('conv-b'));
  assert.match(P.defaultPlanPath('conv-a'), /^~\/\.remote-agent-studio\/goals\//);
  // 对话 id 会拼进路径,不能带斜杠或引号
  assert.ok(!/[/'"$;]/.test(P.defaultPlanPath('../../etc/passwd').replace(/^~\/\.remote-agent-studio\/goals\//, '')));
});

/* ------------------------------------------------------------ 正文兜底 */

test('从模型正文里捞出「第 12/67 步」', () => {
  /* 真实场景:模型在回复里写着这句,状态条却显示「0/25 轮」——
     信息就在眼前,应用视而不见。 */
  assert.deepEqual(P.parseProseProgress('当前仍在第 12/67 步,apt 正在更新索引'), { current: 12, total: 67 });
  assert.deepEqual(P.parseProseProgress('第3/18步'), { current: 3, total: 18 });
  assert.deepEqual(P.parseProseProgress('步骤 5/9 完成'), { current: 5, total: 9 });
  assert.deepEqual(P.parseProseProgress('Step 4 of 12'), { current: 4, total: 12 });
});

test('正文里的普通分数不会被当成进度', () => {
  /* `12/67` 这种片段在正文里太常见(版本号、比例、日期)。
     误判一次就会显示一个凭空捏造的进度 —— 宁可不显示。 */
  for (const s of [
    '磁盘用了 12/67 GB',
    '准确率 3/18',
    '2026/08/29 开始构建',
    'v1.2/3.4 版本',
    ''
  ]) assert.equal(P.parseProseProgress(s), null, s);
});

test('反过来的、越界的步数一律不认', () => {
  assert.equal(P.parseProseProgress('第 67/12 步'), null, '当前不该大于总数');
  assert.equal(P.parseProseProgress('第 1/1 步'), null, '总数为 1 没有信息量');
  assert.equal(P.parseProseProgress('第 0/9 步'), null);
});

/* ------------------------------------------------------------ 轮次自适应 */

test('计划远大于轮次上限时把上限抬上去', () => {
  /* 67 步配 25 轮注定反复触顶,每次都要人点「继续」——
     而这个功能存在的意义本来就是不用人守着。 */
  const g = G.createGoal('x');
  const r = G.scaleRoundsForPlan(g, { total: 67 });
  assert.equal(r.maxRounds, 134);
  assert.equal(r.planScaled, true);
  assert.match(r.message, /67 步/);
  assert.match(r.message, /token 预算/, '要说清真正的闸门仍是 token');
  assert.match(r.message, /\/goal max 25/, '要给出调回去的办法');
});

test('只抬一次,不会每轮都往上加', () => {
  // 悄悄地一轮轮放大用户设的上限,等于替他决定多花多少钱
  const g = { ...G.createGoal('x'), planScaled: true };
  assert.equal(G.scaleRoundsForPlan(g, { total: 200 }), null);
});

test('上限本来就够就不动它', () => {
  const g = { ...G.createGoal('x'), maxRounds: 100 };
  const r = G.scaleRoundsForPlan(g, { total: 8 });
  assert.equal(r.maxRounds, undefined, '不该往下调 —— 那是用户自己设的');
  assert.equal(r.planScaled, true);
});

test('再大的计划也不能超过硬上限', () => {
  const r = G.scaleRoundsForPlan(G.createGoal('x'), { total: 9999 });
  assert.equal(r.maxRounds, G.GOAL_MAX_ROUNDS_CAP);
});

/* ------------------------------------------------------------ 接线 */

test('设定目标后第一轮是拆解,不是"继续推进"', () => {
  /* 一上来就说"继续推进",模型只能边想边做,
     进度就永远只能用轮次表示 —— 而轮次说不出还剩多少活儿。 */
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /sendToAgent\(hostId, conv\.id, buildDecomposePrompt\(fresh\)/);
  assert.match(chat, /planPath \|\| defaultPlanPath\(conv\.id\)/, '没给路径要用默认的');
});

test('正文兜底不写进 planHistory', () => {
  /* 模型可能把上一轮的数字原样复读。拿它喂停滞判定,
     会得出一个看似确凿、实则没有依据的结论。 */
  const store = read('src/store.js');
  const fn = store.slice(store.indexOf('function fallbackToProse'));
  assert.ok(!/planHistory/.test(fn.slice(0, 900)));
  assert.match(fn.slice(0, 900), /planSource: 'prose'/);
});

test('读到过文件就不再退回正文自述', () => {
  // 可核对的事实一旦有了,就不该被模型的一面之词覆盖
  const store = read('src/store.js');
  assert.match(store, /planSource === 'file'\) return;/);
});

test('界面上区分"清单"和"模型自述的步数"', () => {
  /* 两者长得一样的话,人会把后者也当成确凿进度。 */
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /disabled=\{!hasSteps\}/);
  assert.match(chat, /自述/);
});

test('默认计划路径里的 ~ 会被展开', () => {
  /* 整段引起来的话 `~` 不展开,会去找一个名字里真带波浪号的目录 ——
     而默认路径正是 `~/.remote-agent-studio/…`,不处理这个功能默认就是坏的。 */
  const main = read('electron/ipc/goal.js');
  const h = main.slice(main.indexOf(`ipcMain.handle('goal:readPlan'`), main.length);
  assert.match(h, /startsWith\('~\/'\)/);
  assert.match(h, /"\$HOME"/);

  // 用真的 bash 验证展开后仍然是安全的
  const { shellQuote } = require('../electron/ssh/SSHManager');
  const build = (f) => (f.startsWith('~/') ? `"$HOME"/${shellQuote(f.slice(2))}` : shellQuote(f));
  /* HOME 必须**单独一条语句**先赋值:写成 `HOME=x printf "$HOME"` 的话,
     $HOME 在调用 printf 之前就被外层 shell 展开了,测的其实是本机的 HOME。 */
  const out = execFileSync('bash', ['-c',
    `HOME=/tmp/h\nprintf '%s\\n' ${build('~/a b/x.md')} ${build('~/$(echo NO).md')}`
  ], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['/tmp/h/a b/x.md', '/tmp/h/$(echo NO).md']);
});

test('计划文件路径拼进 shell 前必须被引用', () => {
  /* 路径是用户输入的,直接拼进命令行就是命令注入。
     用**真的 bash** 验证,而不是看正则像不像对 ——
     shell 引用的边角情况多到没法靠阅读判断。 */
  const { shellQuote } = require('../electron/ssh/SSHManager');
  const paths = [
    '/tmp/x.md; echo INJECTED',
    '/tmp/$(echo EXPANDED).md',
    '/tmp/`echo BACKTICK`.md',
    "/tmp/it's.md",
    '/tmp/a b.md'
  ];
  const script = paths.map((f) => `printf '%s\\n' ${shellQuote(f)}`).join('\n');
  const lines = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).split('\n').slice(0, -1);

  /* 判据是**逐行原样相等**,不是"输出里没有某个词"。
     `printf '%s' '...; echo INJECTED'` 本来就会把 INJECTED 这几个字母打出来 ——
     按关键字判会把这次正确的行为误判成注入。真正要证明的是:
     每条路径进去多少、出来还是多少,shell 一个字符都没多做。 */
  assert.deepEqual(lines, paths);
});

test('用的是仓库里那个 shellQuote,没有再手写一份引用逻辑', () => {
  /* 每多一份引用实现,就多一处会出错、且不会被上面那条测试覆盖的地方。 */
  const main = read('electron/ipc/goal.js');
  const h = main.slice(main.indexOf(`ipcMain.handle('goal:readPlan'`), main.length);
  assert.match(h, /shellQuote\(file\)/);
  assert.ok(!/replace\(\/'\/g/.test(h), '不该在这里再写一遍单引号转义');
});

test('读计划失败不抛错 —— 它只是观察窗口,不该打断对话', () => {
  /* 文件还没被创建、路径写错、主机刚好断了,都只是"这次没读到"。
     让它抛出去会把整轮目标推进打断,代价远大于少显示一次进度。 */
  const main = read('electron/ipc/goal.js');
  const h = main.slice(main.indexOf(`ipcMain.handle('goal:readPlan'`));
  assert.match(h.slice(0, 1400), /catch \(e\)[\s\S]*?return \{ ok: false/);
  assert.match(h.slice(0, 1400), /code === 124/, '超时(124)不会抛,必须显式判');
});

test('前端读计划失败时不写历史', () => {
  /* 把"这次没读到"记成一条历史,等于告诉停滞判定"进度没涨",
     会让它凭空提前触发。 */
  const store = read('src/store.js');
  const fn = store.slice(store.indexOf('export async function refreshGoalPlan'), store.indexOf('function fallbackToProse'));
  /* 两条失败路径都必须在 mergePlan 之前就返回 —— 只要走到 mergePlan,
     就会往 planHistory 里追加一条"进度没涨",让停滞判定凭空提前触发。 */
  assert.match(fn, /if \(!r\?\.ok\) return fallbackToProse/);
  assert.match(fn, /if \(!steps\.length\) return fallbackToProse/);
  const beforeMerge = fn.slice(0, fn.indexOf('mergePlan'));
  assert.ok(/!r\?\.ok/.test(beforeMerge) && /!steps\.length/.test(beforeMerge));
});

test('决策前先刷新计划,而且用刷新后的 goal', () => {
  /* 读计划会写回 goal.plan。决策时若仍用闭包里那份旧的,
     等于白读 —— 面板会显示新进度,判据却还看着旧数据。 */
  const app = read('src/App.jsx');
  assert.match(app, /refreshGoalPlan\(conv\.hostId, convId\)\.then\(goalStep\)/);
  const step = app.slice(app.indexOf('const goalStep = ()'));
  assert.match(step.slice(0, 400), /const conv = st\.conversations\[convId\]/,
    'goalStep 必须自己重新取 conv');
});

test('驳回次数会被持久化', () => {
  // 不持久化的话每轮都从 0 开始,一份陈旧的清单就能把目标永远卡住
  const app = read('src/App.jsx');
  assert.match(app, /step\.planPushback != null \? \{ planPushback: step\.planPushback \}/);
});
