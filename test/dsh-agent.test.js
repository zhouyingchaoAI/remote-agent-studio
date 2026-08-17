const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  dshInstallCommand, dshEnvPosix, dshEnvPowershell, dshArgs,
  withHistory, describeExit, DSH_PACKAGE,
  dshDiagnoseCommand, parseDshConfig, explainSilence, explainAuthFailure
} = require('../electron/ssh/dsh');
const { AgentSession } = require('../electron/ssh/AgentSession');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* grok CLI 已移除,国产模型改走 DeepSeek 官方 harness(dsh)。
 * dsh 的无头模式只在 stdout 打最终文本,没有 NDJSON / 工具事件 / resume ——
 * 这些差异必须在代码里显式处理,不能沿用 claude/codex 的假设。 */

test('安装走官方 npm 包,不是独立二进制脚本', () => {
  const cmd = dshInstallCommand();
  assert.match(cmd, /npm install -g @deepseek-ai\/dsh@latest/);
  assert.equal(DSH_PACKAGE, '@deepseek-ai/dsh');
});

test('无头模式参数固定为 --profile headless', () => {
  assert.equal(dshArgs(), '--profile headless');
});

test('必须设 NODE_USE_ENV_PROXY,否则远程走代理上网连不通', () => {
  const env = dshEnvPosix();
  assert.match(env, /NODE_USE_ENV_PROXY=1/);
  // key 由环境提供,不内联
  assert.match(env, /DEEPSEEK_API_KEY="\$\{DEEPSEEK_API_KEY:-\}"/);
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(env));
});

test('权限模式取值官方未公开完整列表:不填就不设,填了要校验', () => {
  assert.ok(!/DSH_PERMISSION_MODE/.test(dshEnvPosix()), '不填时不该凭空设一个可能非法的值');
  assert.match(dshEnvPosix({ permissionMode: 'workspace-write' }), /DSH_PERMISSION_MODE="workspace-write"/);
  // 会被拼进 shell,非法字符必须挡下
  assert.throws(() => dshEnvPosix({ permissionMode: 'a; rm -rf /' }), /不合法/);
  assert.throws(() => dshEnvPowershell({ permissionMode: "x'" }), /不合法/);
});

test('生成的 env 片段在真实 shell 里可执行', () => {
  const env = dshEnvPosix({ permissionMode: 'workspace-write' });
  const out = execFileSync('sh', ['-c',
    `DEEPSEEK_API_KEY=dummy; ${env} echo "$NODE_USE_ENV_PROXY|$DEEPSEEK_API_KEY|$DSH_PERMISSION_MODE"`
  ], { encoding: 'utf8' }).trim();
  assert.equal(out, '1|dummy|workspace-write');
});

/* ---------------- 多轮上下文 ---------------- */

test('每轮都是新会话,所以历史要拼进任务文本', () => {
  const plain = withHistory('修一下登录', []);
  assert.equal(plain, '修一下登录');

  const withCtx = withHistory('那再改一下超时', [
    { role: 'user', text: '修一下登录' },
    { role: 'agent', text: '已改 auth.js' }
  ]);
  assert.match(withCtx, /此前对话摘要/);
  assert.match(withCtx, /已改 auth\.js/);
  assert.match(withCtx, /本轮指令:那再改一下超时/);
  // 明确告诉模型为什么给它摘要,避免它重复已完成的工作
  assert.match(withCtx, /不要重复已完成的工作/);
});

/* ---------------- 退出码语义 ---------------- */

test('退出 1 是「未完成」而不是崩溃,措辞不能误导', () => {
  assert.equal(describeExit(0).ok, true);
  const r = describeExit(1, '做到一半', '');
  assert.equal(r.ok, false);
  assert.match(r.message, /未完成/);
  assert.match(r.message, /不一定是崩溃/);
});

test('缺命令 / 缺凭据给出可操作提示', () => {
  assert.match(describeExit(127, '', 'dsh: command not found').message, /安装/);
  assert.match(describeExit(1, '', 'missing DEEPSEEK_API_KEY').message, /环境配置/);
});

/* ---------------- 命令构造 ---------------- */

test('posix 命令注入 dsh 环境并用 headless 模式', () => {
  const session = new AgentSession({ isLocal: true }, null, {
    agent: 'dsh', cwd: '/workspace', permissionMode: 'workspace'
  });
  const cmd = session.buildCommand('跑一下测试');
  assert.match(cmd, /NODE_USE_ENV_PROXY=1/);
  assert.match(cmd, /dsh --profile headless/);
  assert.match(cmd, /'跑一下测试'/);
  // dsh 没有 --model,不能凭空加上去
  assert.ok(!/--model/.test(cmd), 'dsh 不支持 --model');
  // env 文件要先 source,才能拿到 DEEPSEEK_API_KEY
  assert.ok(cmd.indexOf('.remote-agent-env.sh') < cmd.indexOf('NODE_USE_ENV_PROXY'));
});

test('dsh 的纯文本 stdout 不走 JSON 解析,收尾时整段发出', () => {
  const session = new AgentSession({ isLocal: true }, null, { agent: 'dsh' });
  const msgs = [];
  session.on('message', (m) => msgs.push(m));

  session._parseLine('这是第一行');
  session._parseLine('这是第二行');
  // 逐行冒泡会刷一屏碎片,所以解析阶段不该发任何消息
  assert.equal(msgs.length, 0, '纯文本行不该逐行冒泡');
  assert.equal(session.dshBuffer, '这是第一行\n这是第二行');
});

/* ---------------- grok 已彻底移除 ---------------- */

test('代码库里不再有 grok 引擎的任何残留(迁移映射除外)', () => {
  for (const f of [
    'electron/ssh/AgentSession.js', 'electron/ssh/Installer.js', 'electron/main.js',
    'electron/store.js', 'electron/preload.js', 'electron/skills.js', 'electron/mobileOps.js',
    'src/store.js', 'src/components/ChatPanel.jsx', 'src/components/SetupPanel.jsx',
    'src/components/EngineStatus.jsx', 'src/components/SkillsPanel.jsx'
  ]) {
    // src/store.js 里保留 LEGACY_AGENTS 是有意的:历史对话要能打开
    const body = read(f).split('\n')
      .filter((l) => !/LEGACY_AGENTS|grok 引擎已移除/.test(l))
      .join('\n');
    assert.ok(!/grok/i.test(body), `${f} 仍有 grok 残留`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'electron/ssh/grokProviders.js')),
    'grokProviders.js 应已删除');
});

test('历史 grok 对话平滑迁移到 dsh,不能打不开', () => {
  const src = read('src/store.js');
  assert.match(src, /LEGACY_AGENTS = \{ grok: 'dsh' \}/);
  // 必须作用在加载历史的路径上,只在新建时映射没用
  assert.match(src, /map\[c\.id\] = normalizeConversation\(c\)/);
});

test('技能目录换成 ~/.dsh/skills', () => {
  const { ENGINE_SKILL_DIRS } = require('../electron/skills');
  assert.equal(ENGINE_SKILL_DIRS.dsh, '.dsh/skills');
  assert.equal(ENGINE_SKILL_DIRS.grok, undefined);
});
/* 用户实测:发消息直接崩 —— Cannot read properties of null (reading 'permissionMode')。
 * 这是同一类 bug 的第二次:`cfg = {}` 默认参数只在 undefined 时生效,
 * 而 settings 里存的是 dshConfig: null。第一次出在 normalizePermissionMode。 */

test('可空配置传 null 不崩 —— 默认参数挡不住 null', () => {
  for (const bad of [null, undefined, 0, '', false]) {
    assert.doesNotThrow(() => dshEnvPosix(bad), `dshEnvPosix(${JSON.stringify(bad)}) 崩了`);
    assert.doesNotThrow(() => dshEnvPowershell(bad));
    assert.match(dshEnvPosix(bad), /NODE_USE_ENV_PROXY=1/);
  }
});

test('history 传 null 不崩,原样返回提示词', () => {
  assert.equal(withHistory('干活', null), '干活');
  assert.equal(withHistory('干活', undefined), '干活');
  assert.equal(withHistory('干活', 'not-an-array'), '干活');
});

test('describeExit 的 stdout/stderr 传 null 不崩', () => {
  assert.doesNotThrow(() => describeExit(1, null, null));
  assert.doesNotThrow(() => describeExit(0, undefined, undefined));
});

test('AgentSession 在源头收敛可空字段,下游拿不到 null', () => {
  const src = read('electron/ssh/AgentSession.js');
  // 与其在每个消费点补 || {},不如让下游永远拿不到 null
  assert.match(src, /dshConfig: \(opts && opts\.dshConfig\) \|\| \{\}/);
  assert.match(src, /history: Array\.isArray\(opts && opts\.history\)/);
});

/* 用户:「还是无法使用 deepseek harness 迭代优化,另外都没有测试按钮」。
 * 两个真问题,都不在我先前以为的地方。 */

test('dsh 每轮把问答记进 history —— 否则下一轮完全失忆', () => {
  const s = new AgentSession({ exec() {} }, null, {
    agent: 'dsh', cwd: '/tmp/proj', dshConfig: null
  });
  // 第一轮:没有历史,原样发指令
  const first = s.buildCommand('把 README 补上安装章节', {});
  assert.ok(!first.includes('此前对话摘要'), '首轮不该凭空造历史');

  s._recordDshTurn('把 README 补上安装章节', '已在 README 加了「安装」小节');
  const second = s.buildCommand('再补一段常见问题', {});
  assert.match(second, /此前对话摘要/);
  assert.match(second, /已在 README 加了/, '上一轮的结论必须带进下一轮,这才谈得上迭代');
  assert.match(second, /本轮指令:再补一段常见问题/);
});

test('history 有上限,不会把提示词无限撑大', () => {
  const s = new AgentSession({ exec() {} }, null, { agent: 'dsh', cwd: '/tmp' });
  for (let i = 0; i < 30; i += 1) s._recordDshTurn(`指令${i}`, `回复${i}`);
  assert.ok(s.opts.history.length <= 12, `实际 ${s.opts.history.length} 条`);
  // 保留的应是最近的
  assert.match(s.opts.history[s.opts.history.length - 1].text, /回复29/);
});

test('从对话记录抽历史:认 role:agent,滤掉错误与工具噪音', () => {
  const src = read('src/components/ChatPanel.jsx');
  // store 里引擎消息是 role:'agent',写成 'assistant' 会一条都抽不到
  assert.match(src, /m\.role === 'agent' && \(m\.kind === 'text' \|\| m\.kind === 'result'\)/);
  assert.ok(!/m\.role === 'assistant'/.test(src), 'store 里没有 assistant 这个 role');
  // 只有 dsh 需要喂历史,claude/codex 各自有 sessionId 续聊
  assert.match(src, /conv\.agent === 'dsh' \? dshHistoryFrom/);
});

test('测试按钮在本机也要有 —— 之前被 !isLocal 整块藏了', () => {
  const src = read('src/components/SetupPanel.jsx');
  const block = src.slice(src.indexOf('测试 dsh') - 1400, src.indexOf('测试 dsh'));
  assert.ok(!block.includes('{!isLocal && <div className="row gap" style={{ marginTop: 6 }}>'),
    '测试按钮区块不该被 !isLocal 包住');
  assert.match(src, /测试 \{isLocal \? '本机' : '远程'\} Codex/);
  assert.match(src, /测试 \{isLocal \? '本机' : '远程'\} DeepSeek/);
});

/* 用户连发三条消息,一条回复都没有 —— 没报错,也没内容。
 * 查官方 README(npm 包内)确认了两件事:
 *  1. `dsh --profile headless "job"` 语法是对的,且 headless profile 首次运行才初始化;
 *  2. 模型与凭据在 $DSH_HOME/cordis.patch.yml 的配置层里,dsh 不读 DEEPSEEK_API_KEY。
 * 所以「加了 API key 还是不行」很可能是加错了地方,而我们连这点都没告诉用户。 */

test('诊断用官方 --dump-config,不启动就能看配置树', () => {
  const cmd = dshDiagnoseCommand();
  assert.match(cmd, /--profile headless/);
  assert.match(cmd, /--dump-config/);
});

test('配置树没有模型路由时,明确指出 key 该写在哪', () => {
  const r = parseDshConfig('some: yaml\nwithout: routing\n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unconfigured');
  assert.match(r.message, /cordis\.patch\.yml/);
  // 关键:必须点破「不是环境变量」,否则用户会一直在错的地方加
  assert.match(r.message, /不是 DEEPSEEK_API_KEY/);
});

test('配置树里有模型就认为就绪,并报出模型名', () => {
  const r = parseDshConfig('route:\n  model: deepseek-v4-pro\n  apiKey: xxx\n');
  assert.equal(r.ok, true);
  assert.equal(r.model, 'deepseek-v4-pro');
  assert.equal(r.hasKey, true);
});

test('空输出判为 profile 未初始化,不谎报就绪', () => {
  const r = parseDshConfig('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('退 0 且无输出时给出解释,而不是一片空白', () => {
  const msg = explainSilence(0, 'some stderr tail');
  assert.match(msg, /没有任何输出/);
  assert.match(msg, /cordis\.patch\.yml/);
  assert.match(msg, /some stderr tail/);

  const src = read('electron/ssh/AgentSession.js');
  // 原来是 `if (text) emit(...)` —— 没文本就彻底沉默
  assert.match(src, /explainSilence\(exitCode, this\.lastStderr\)/);
});

test('测试 dsh:先查配置再实跑,且退 0 无输出不算通过', () => {
  const src = read('electron/main.js');
  assert.match(src, /dshMod\.dshDiagnoseCommand\(\)/);
  assert.match(src, /parseDshConfig/);
  // 「测试通过」但对话里一片空白是最误导的组合
  assert.match(src, /const silent = agent === 'dsh' && !out;/);
  assert.match(src, /!looksNetErr && !silent/);
});

/* 实测诊断输出:
 *   ✓ 模型路由已配置:deepseek-v4-flash
 *   ✗ exit 1 —— dsh: AUTH: Authentication Fails, Your api key: ****4CQ7 is invalid
 * key 尾号对应用户自建 new-api 中转签发的 key,而 dsh 默认送去官方端点验签。
 * 我们当时给的建议是「确认已登录且 auth.json 有效」—— dsh 根本没有 auth.json。 */

test('认证失败要指出 key 与端点错配,而不是叫人去查 auth.json', () => {
  const msg = explainAuthFailure(
    'dsh: AUTH: Authentication Fails, Your api key: ****4CQ7 is invalid', '');
  assert.match(msg, /\*\*\*\*4CQ7/, '要回显被拒的 key,便于确认填的是哪一把');
  assert.match(msg, /api\.deepseek\.com/, '要说清当前打的是哪个端点');
  assert.match(msg, /中转/);
  assert.match(msg, /baseUrl/);
  assert.ok(!/auth\.json/.test(msg), 'dsh 没有 auth.json,这条建议会把人带偏');
});

test('端点已是中转时,不再重复劝人改 baseUrl', () => {
  const msg = explainAuthFailure('api key: ****4CQ7 is invalid', 'http://203.0.113.10:3000');
  assert.match(msg, /203\.0\.113\.10/);
  assert.match(msg, /额度|模型名/, '此时该查的是中转上的 key/额度/模型名');
  assert.ok(!/platform\.deepseek\.com/.test(msg), '端点没指错就别再劝申请官方 key');
});

test('配置树能读出 baseUrl,用于判断端点是否指错', () => {
  const r = parseDshConfig('route:\n  model: deepseek-chat\n  baseUrl: http://203.0.113.10:3000\n');
  assert.equal(r.ok, true);
  assert.equal(r.baseUrl, 'http://203.0.113.10:3000');
  assert.match(r.message, /@ http:\/\/203\.0\.113\.10:3000/);
});

test('dsh 的认证失败走专属解释,不复用 codex 那套说辞', () => {
  const src = read('electron/main.js');
  assert.match(src, /looksAuthErr && agent === 'dsh'/);
  assert.match(src, /explainAuthFailure\(out, dshBaseUrl\)/);
});
