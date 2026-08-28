const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ask = require('../electron/askShell');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 终端里的「快速问一下」:命令记不清了,不想切出去查。
 * 两条硬约束:发出去的终端内容必须脱敏;给回来的命令只填不执行。 */

test('终端输出发给模型前必须脱敏 —— 那里面 export KEY=... 太常见了', () => {
  const fake = `sk-${'Ab12ZzYyXxWw'}${'VvUuTtSsRrQq'}`;
  const out = ask.sanitizeTail(`$ export DEEPSEEK_API_KEY=${fake}\n$ ls`);
  assert.ok(!out.includes('ZzYyXxWwVvUu'), `密钥漏出去了:${out}`);
  // 命令本身要留着,否则上下文就没意义了
  assert.match(out, /export DEEPSEEK_API_KEY/);
  assert.match(out, /\$ ls/);
});

test('剥掉 ANSI,否则控制序列白白占满上下文', () => {
  const raw = '[32m$[0m docker ps\n[31merror[0m\n';
  const out = ask.sanitizeTail(raw);
  assert.ok(!out.includes(''), '还有 ANSI 残留');
  assert.match(out, /\$ docker ps/);
  assert.match(out, /error/);
});

test('限行数与字符数 —— 再多对回答没帮助,只是烧 token', () => {
  const many = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const out = ask.sanitizeTail(many, { maxLines: 60 });
  assert.ok(out.split('\n').length <= 60);
  // 要留的是**尾部**,那才是刚发生的事
  assert.match(out, /line 299/);
  assert.ok(!out.includes('line 100'));
});

test('提示词要求先给命令、且放进代码块(界面靠它切按钮)', () => {
  const p = ask.buildAskPrompt({ question: '怎么看容器日志' });
  assert.match(p, /\*\*先给命令\*\*/);
  assert.match(p, /```bash/);
  // 用户是在终端里急着用 —— 现在直接给了硬性行数上限
  assert.match(p, /最多 5 行/);
  // 不确定就说不确定,别编一条看起来对的
  assert.match(p, /不要编一条看起来对的/);
  assert.throws(() => ask.buildAskPrompt({ question: '  ' }), /不能为空/);
});

test('带上环境信息,免得给 apt 命令而机器是 yum', () => {
  const p = ask.buildAskPrompt({
    question: '装个 jq', env: { os: 'CentOS 7', shell: 'bash', user: 'root', cwd: '/root' }
  });
  assert.match(p, /系统:CentOS 7/);
  assert.match(p, /用户:root\(root\)/);
  assert.match(p, /别给错包管理器/);

  const parsed = ask.parseEnv('__OS__=Ubuntu 22.04\n__SHELL__=zsh\n__USER__=chency\n__CWD__=/home/chency');
  assert.deepEqual(parsed, { os: 'Ubuntu 22.04', shell: 'zsh', user: 'chency', cwd: '/home/chency' });
});

test('抽命令:先滤注释再剥提示符 —— 顺序反了会把中文说明当成命令', () => {
  const out = ask.extractCommands('```bash\n$ docker logs -f abc\n# 这是注释\ndocker logs --tail 100 abc\n```');
  assert.deepEqual(out, ['docker logs -f abc\ndocker logs --tail 100 abc']);
  // 没有代码块时不要瞎猜
  assert.deepEqual(ask.extractCommands('就用 docker logs 吧'), []);
  // 多个块各自成条
  assert.equal(ask.extractCommands('```\nls\n```\n```bash\npwd\n```').length, 2);
});

test('命令只填进终端,绝不自动执行', () => {
  const ui = read('src/components/TerminalPanel.jsx');
  /* 模型给的可能是 rm -rf,也可能只是版本对不上。让人看一眼再按回车,
     成本是一秒,省掉的是不可逆的事故。 */
  assert.match(ui, /window\.api\.term\.write\(\{ hostId, termId, data: cmd \}\)/);
  assert.ok(!/data: `\$\{cmd\}\\n`/.test(ui), '不能替用户回车');
  assert.match(ui, /只填不回车/);
  const panel = read('src/components/AskShell.jsx');
  assert.match(panel, /填进终端但不回车/);
  assert.match(panel, /不会自动执行/);
});

test('上下文取自 xterm 缓冲区,比截图准', () => {
  const ui = read('src/components/TerminalPanel.jsx');
  assert.match(ui, /term\.buffer\.active/);
  assert.match(ui, /translateToString\(true\)/);
  // 截图是可选项,不是唯一来源
  assert.match(read('src/components/AskShell.jsx'), /screenshot\.capture/);
});

test('问答是只读的一次性调用,不该动任何文件', () => {
  const main = read('electron/main.js');
  /* 会话构造挪进了 runAskOnce(为了能换一组参数重试),
     所以从那里开始切 —— 契约没变,只是位置变了。 */
  const block = main.slice(main.indexOf('async function runAskOnce('));
  assert.match(block, /permissionMode: 'workspace'/);
  assert.match(block, /只读沙箱/);
  // 脱敏发生在主进程,不指望调用方记得洗
  assert.match(block, /askShell\.sanitizeTail\(tail\)/);
});

test('⌘K 唤起 —— 手已经在键盘上,不该逼人去够鼠标', () => {
  const panel = read('src/components/AskShell.jsx');
  assert.match(panel, /e\.metaKey \|\| e\.ctrlKey/);
  assert.match(panel, /key\.toLowerCase\(\) === 'k'/);
  assert.match(panel, /e\.key === 'Escape'/);
});

/* 用户:「使用对话的模型」。原来写死 codex + 默认模型 —— 用户在对话里
 * 特意选了引擎(换 DeepSeek 省钱、或调到 gpt-5.6-terra),问一句命令却跑去
 * 用另一个,既不符合预期,账单也记在别处。 */

/** 从组件里取出纯函数(JSX 没法直接 require) */
function loadPick() {
  const src = read('src/components/AskShell.jsx');
  // pickAskEngine 现在依赖 FASTEST_MODEL,得把那张表一起抠出来
  const table = src.slice(src.indexOf('const FASTEST_MODEL'), src.indexOf('};', src.indexOf('const FASTEST_MODEL')) + 2);
  const body = src.slice(src.indexOf('export function pickAskEngine')).replace('export function', 'function');
  return new Function(`${table}\n${body.slice(0, body.indexOf('\n}') + 2)}; return pickAskEngine;`)();
}

test('引擎跟当前活跃对话走,模型换成该引擎最快的那个', () => {
  /* 契约变了:用户明确要「最快的模型、不要深度思考」。
     引擎仍然跟着对话 —— 它决定用哪套凭据、账单记在哪,不能替人换;
     模型则固定挑最快的,因为这个面板的全部价值就是快。 */
  const pick = loadPick();
  const st = {
    conversations: { a: { id: 'a', hostId: 'h1', agent: 'deepseek', model: 'deepseek-v4-pro[1m]', updatedAt: 1 } },
    activeConvByHost: { h1: 'a' }
  };
  const r = pick(st, 'h1');
  assert.equal(r.agent, 'deepseek', '引擎必须跟着对话');
  assert.equal(r.model, 'deepseek-v4-flash', '模型应换成最快的,而不是对话里那个');
  assert.equal(r.fast, true);
  assert.equal(r.source, 'active');
});

test('没有活跃对话就沿用该主机最近用过的那个', () => {
  const pick = loadPick();
  const st = {
    conversations: {
      a: { id: 'a', hostId: 'h1', agent: 'claude', model: 'opus', updatedAt: 100 },
      b: { id: 'b', hostId: 'h1', agent: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'xhigh', updatedAt: 200 }
    },
    activeConvByHost: {}
  };
  const r = pick(st, 'h1');
  // 断言的是「引擎取自哪条对话」;模型不再跟对话走(固定挑最快的)
  assert.equal(r.agent, 'codex', '应取 updatedAt 最大的那条');
  assert.equal(r.model, '', 'codex 应跟随 CLI 配置,不替用户指定模型');
  assert.equal(r.reasoningEffort, 'minimal', '不沿用对话里的 xhigh');
  assert.equal(r.source, 'recent');
});

test('codex 固定最低推理强度,其他引擎没这个开关', () => {
  /* 推理强度是延迟差别最大的一个开关,同一个模型 minimal 和 high 能差好几倍。
     而「某某命令怎么写」是回忆,不是解题,不需要推理。 */
  const pick = loadPick();
  const mk = (agent) => ({
    conversations: { a: { id: 'a', hostId: 'h1', agent, reasoningEffort: 'xhigh', updatedAt: 1 } },
    activeConvByHost: { h1: 'a' }
  });
  assert.equal(pick(mk('codex'), 'h1').reasoningEffort, 'minimal', '不该沿用对话里的 xhigh');
  assert.equal(pick(mk('claude'), 'h1').reasoningEffort, '');
  assert.equal(pick(mk('deepseek'), 'h1').reasoningEffort, '');
});

test('这台主机一条对话都没有才用默认', () => {
  const pick = loadPick();
  const r = pick({ conversations: {}, activeConvByHost: {} }, 'h9');
  assert.equal(r.agent, 'codex');
  assert.equal(r.source, 'default');
});

test('选择器不能每次返回新对象 —— React 18 下会每次 store 变动都重渲', () => {
  const ui = read('src/components/AskShell.jsx');
  // 选原始值再 useMemo,而不是在 selector 里现算对象
  assert.match(ui, /const conversations = useStore\(\(st\) => st\.conversations\)/);
  assert.match(ui, /useMemo\(\s*\n?\s*\(\) => pickAskEngine/);
  assert.match(ui, /getSnapshot 没缓存/);
});

test('面板上标出用的是哪个引擎/模型 —— 关系到费用,不该藏着', () => {
  const ui = read('src/components/AskShell.jsx');
  assert.match(ui, /ENGINE_LABEL\[engine\.agent\]/);
  assert.match(ui, /engine\.model/);
  /* 还要标出"极速":模型被替换成了最快的那个,和对话里选的不一样,
     不说清楚会让人以为面板在偷偷用别的东西。 */
  assert.match(ui, /极速/);
});

test('主进程按传入的引擎配置建会话,包括 deepseek 端点', () => {
  const main = read('electron/main.js');
  const block = main.slice(main.indexOf('async function runAskOnce('));
  assert.match(block, /deepseekEndpoint: loadSettings\(\)\.deepseekEndpoint/);
  assert.match(block, /reasoningEffort: agent === 'codex' \? reasoningEffort : ''/);
});

test('导航按使用频次排:对话/终端/文件在最左', () => {
  const app = read('src/App.jsx');
  const order = [...app.matchAll(/\{ key: '(\w+)', label: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 3), ['chat', 'terminal', 'files']);
  // 配置类沉到最右
  assert.equal(order[order.length - 1], 'setup');
});

/* 用户卡在「问中…」不动,并猜是脱敏拖慢的。
 * 脱敏是对 ≤6000 字符跑一遍正则、发生在网络请求之前,微秒级 —— 不是原因。
 * 真正的问题是这个调用**既没有超时也没有取消**,可以永远停在那儿。 */

test('必须有超时 —— 没有出口的等待界面是最糟的失败方式', () => {
  const main = read('electron/main.js');
  assert.match(main, /const ASK_TIMEOUT_MS = \d+/);
  assert.match(main, /Promise\.race\(\[/);
  assert.match(main, /问答超时/);
  // 超时提示要指向下一步,而不是只说"超时了"
  assert.match(main, /引擎未登录\/额度不足\/代理不通/);
});

test('可以取消,且取消要真的中断会话', () => {
  const main = read('electron/main.js');
  assert.match(main, /ipcMain\.handle\('ask:cancel'/);
  assert.match(main, /askSessions\.set\(askId, session\)/);
  // 结束后要清掉,否则 Map 会一直涨
  assert.match(main, /askSessions\.delete\(askId\)/);
  const ui = read('src/components/AskShell.jsx');
  assert.match(ui, /window\.api\.ask\.cancel\(\{ askId: askIdRef\.current \}\)/);
});

test('边出边显示 + 已等秒数,而不是一个转到底的「问中…」', () => {
  const main = read('electron/main.js');
  assert.match(main, /send\('ask:progress', \{ askId, partial: answer \}\)/);
  const ui = read('src/components/AskShell.jsx');
  assert.match(ui, /ask\.onProgress/);
  assert.match(ui, /已等 \$\{elapsed\}s/);
  // 只认自己这次的 askId,否则连着问两次会串
  assert.match(ui, /askId === askIdRef\.current/);
});

test('引擎返回空内容要报错,不能静默成功', () => {
  const main = read('electron/main.js');
  /* dsh 那次已经栽过一模一样的:退 0 而无输出,界面一片空白,
     用户完全不知道发生了什么 */
  assert.match(main, /引擎没有返回任何内容/);
});

test('脱敏是本地正则,与快慢无关 —— 提示不该让人误会', () => {
  const ui = read('src/components/AskShell.jsx');
  assert.match(ui, /本地正则,不影响速度/);
});

/* ------------------------------------------------ 快:这个面板的全部价值 */

test('固定用最快的模型和最低推理强度', () => {
  /* 用户:「用最快的模型,不需要深度思考,需要最快反应」。
     这个面板的全部价值就是快 —— 等 20 秒不如自己去搜,那它不如不存在。 */
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/components/AskShell.jsx'), 'utf8');
  assert.match(ui, /const FASTEST_MODEL = \{/);
  assert.match(ui, /claude: 'haiku'/);
  assert.match(ui, /deepseek: 'deepseek-v4-flash'/);
  /* codex 故意留空 = 跟随 CLI 配置。很多人的 codex 指向自建/中转端点,
     那里没有 gpt-5 这个名字 —— 硬塞一个模型名会让引擎一声不吭返回空。
     对 codex 来说延迟大头是推理强度,换模型的收益远不如冒的风险大。 */
  assert.match(ui, /codex: '',/);
  // 推理强度是延迟差别最大的开关,而"命令怎么写"是回忆不是解题
  assert.match(ui, /reasoningEffort: agent === 'codex' \? 'minimal' : ''/);
});

test('引擎仍跟着对话走 —— 换引擎等于换凭据和账单', () => {
  /* 模型可以替用户挑,引擎不行:引擎决定用哪套凭据、账单记在哪、装没装。
     悄悄换引擎会让人在别处看到不认识的账单。 */
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/components/AskShell.jsx'), 'utf8');
  assert.match(ui, /const agent = conv\?\.agent \|\| 'codex';/);
  assert.match(ui, /model: FASTEST_MODEL\[agent\]/);
});

test('提示词要求极简,不许展开思考过程', () => {
  // 同一个问题,啰嗦的答案光是吐字就能多花好几秒
  const p = ask.buildAskPrompt({ question: '怎么看容器日志' });
  assert.match(p, /最多 5 行/);
  assert.match(p, /不要解释你的思考过程/);
});

test('主机环境探测有缓存 —— 它是串在提问前面的一次完整 SSH 往返', () => {
  /* 这一步纯串行地加在每次提问的延迟上,而发行版/shell/用户
     在一台机器上基本不变,每次重新探一遍纯属浪费。 */
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron/main.js'), 'utf8');
  assert.match(main, /const askEnvCache = new Map\(\);/);
  assert.match(main, /let env = askEnvCache\.get\(hostId\);/);
  // 断开时必须失效:重连往往意味着机器换了或刚装完东西
  assert.match(main, /askEnvCache\.delete\(hostId\);/);
});


test('指定的模型问不出内容时,退回 CLI 默认配置重试一次', () => {
  /* 真实故障:面板替用户指定了 gpt-5,而那台机器的 codex 指向自建端点、
     没有这个模型 —— 引擎一声不吭返回空,用户只看到"引擎没有返回任何内容"。
     求快不能把功能求没了,所以降级重试。 */
  const main = read('electron/main.js');
  assert.match(main, /async function runAskOnce\(/);
  assert.match(main, /if \(model \|\| reasoningEffort\) \{/);
  assert.match(main, /model: '', reasoningEffort: '', env/);
});

test('只重试一次,且只在指定过模型时重试', () => {
  // 否则就是拿同样的参数再撞一遍墙,白白多等一个超时
  const main = read('electron/main.js');
  assert.ok(!/runAskOnce[\s\S]{0,400}runAskOnce[\s\S]{0,400}runAskOnce/.test(main),
    '不该有三次调用');
});

test('报错里带上引擎自己的输出', () => {
  /* 原因就在 stderr 里(比如 unknown model xxx)。不带上它,
     用户只能去猜 —— 这正是这次故障里最耽误事的一环。 */
  const main = read('electron/main.js');
  assert.match(main, /engineErr \+= /);
  assert.match(main, /引擎输出:\$\{detail\}/);
});

test('降级过要告诉用户', () => {
  // 否则他只会觉得"这次怎么变慢了"
  const main = read('electron/main.js');
  assert.match(main, /fellBackFrom/);
  const ui = read('src/components/AskShell.jsx');
  assert.match(ui, /result\.fellBackFrom/);
});
