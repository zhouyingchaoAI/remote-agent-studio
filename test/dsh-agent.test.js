const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  dshInstallCommand, dshEnvPosix, dshEnvPowershell, dshArgs,
  withHistory, describeExit, DSH_PACKAGE
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
