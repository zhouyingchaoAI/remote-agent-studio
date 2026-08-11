const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  projectsFromConvos, buildProjectScanCommand, parseProjectScan, mergeProjects,
  safeRelPath, buildInspectCommand, truncateOutput, normalizeEngine, INSPECT_KINDS
} = require('../electron/mobileOps');
const { route } = require('../electron/mobileGateway');
const mobileService = require('../electron/mobileService');
const { lintSkill } = require('../electron/skills');

/* ------------------------------------------------------------ 项目发现 */

test('从历史对话推导项目:去重,按最近使用排序', () => {
  const convos = [
    { hostId: 'h1', cwd: '/srv/api', updatedAt: 100 },
    { hostId: 'h1', cwd: '/srv/api', updatedAt: 300 },   // 同项目取最新
    { hostId: 'h1', cwd: '/srv/web', updatedAt: 200 },
    { hostId: 'h2', cwd: '/other/proj', updatedAt: 999 }, // 别的主机不该混进来
    { hostId: 'h1', cwd: '', updatedAt: 400 },            // 没有 cwd 的忽略
    { hostId: 'h1' }
  ];
  const out = projectsFromConvos(convos, 'h1');
  assert.deepEqual(out.map((p) => p.path), ['/srv/api', '/srv/web']);
  assert.equal(out[0].name, 'api');
  assert.equal(out[0].source, 'history');
});

test('扫描命令限深度并排除 node_modules(否则大盘上会跑很久)', () => {
  const cmd = buildProjectScanCommand();
  assert.match(cmd, /-maxdepth 3/);
  assert.match(cmd, /node_modules/);
  assert.match(cmd, /head -40/);
});

test('扫描结果解析成项目条目', () => {
  const out = parseProjectScan('/home/u/api\n/home/u/web\n\n  \n');
  assert.deepEqual(out.map((p) => p.name), ['api', 'web']);
  assert.equal(out[0].source, 'scan');
});

test('合并时历史优先,同路径不重复', () => {
  const merged = mergeProjects(
    [{ path: '/a', name: 'a', source: 'history' }],
    [{ path: '/a', name: 'a', source: 'scan' }, { path: '/b', name: 'b', source: 'scan' }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].source, 'history');
});

/* ------------------------------------------------------------ 只读查看 */

test('相对路径校验:挡住穿越与绝对路径', () => {
  assert.equal(safeRelPath('src/index.js'), 'src/index.js');
  assert.equal(safeRelPath(''), '');
  for (const bad of ['../../etc/shadow', '/etc/passwd', '~/.ssh/id_rsa', 'a/../../b', 'a\nb']) {
    assert.throws(() => safeRelPath(bad), undefined, `应拒绝: ${bad}`);
  }
  // 文件名里含 .. 但不是路径段,应该放行
  assert.equal(safeRelPath('src/a..b.js'), 'src/a..b.js');
});

test('查看类型是白名单,任意命令进不来', () => {
  assert.throws(() => buildInspectCommand({ kind: 'exec', cwd: '/a' }), /不支持/);
  assert.throws(() => buildInspectCommand({ kind: 'rm', cwd: '/a' }), /不支持/);
  assert.throws(() => buildInspectCommand({ kind: 'status' }), /缺少项目目录/);
  for (const kind of INSPECT_KINDS) {
    const needsPath = ['file', 'tail'].includes(kind);
    const built = buildInspectCommand({ kind, cwd: '/srv/api', path: needsPath ? 'a.log' : undefined });
    assert.ok(built.command.length > 0, kind);
  }
});

test('目录名里的 shell 元字符被正确转义(真跑一遍)', () => {
  // 真实会遇到:目录带空格、带单引号
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-proj-'));
  const weird = path.join(tmp, "my project's dir");
  fs.mkdirSync(weird);
  fs.writeFileSync(path.join(weird, 'note.txt'), '第一行\n第二行\n第三行\n');

  const { command } = buildInspectCommand({ kind: 'file', cwd: weird, path: 'note.txt', lines: 2 });
  const out = execFileSync('sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(out, '第一行\n第二行\n');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('注入尝试不会变成第二条命令', () => {
  const { command } = buildInspectCommand({ kind: 'ls', cwd: '/srv/api; rm -rf /' });
  // 整个目录名被引号包住,分号失去语法意义
  assert.ok(!/&&\s*rm -rf \/|;\s*rm -rf \/\s*$/.test(command.replace(/'[^']*'/g, "''")),
    `不应产生可执行的 rm: ${command}`);
});

test('输出截断,不把几万字塞进微信', () => {
  const short = truncateOutput('短输出');
  assert.equal(short.truncated, false);
  const long = truncateOutput('x'.repeat(9000));
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < 6200);
  assert.match(long.text, /桌面端查看/);
});

/* ------------------------------------------------------------ 引擎 */

test('引擎白名单', () => {
  assert.equal(normalizeEngine(), 'codex');
  assert.equal(normalizeEngine('Claude'), 'claude');
  assert.throws(() => normalizeEngine('gpt-9'), /不支持的引擎/);
});

/* ------------------------------------------------------------ 多轮续聊 */

test('同一主机同一项目的会话被记住,换项目则相互独立', () => {
  mobileService.resetMobileConvo('h1', '/srv/api');
  mobileService.resetMobileConvo('h1', '/srv/web');

  const a1 = mobileService.getMobileConvo('h1', '/srv/api');
  mobileService.rememberResume('h1', '/srv/api', { codexSessionId: 'sess-api', codexStarted: true });
  const a2 = mobileService.getMobileConvo('h1', '/srv/api');
  assert.equal(a2.convId, a1.convId, '同项目应复用同一会话');
  assert.equal(a2.codexSessionId, 'sess-api');
  assert.equal(a2.turns, 1);

  const b = mobileService.getMobileConvo('h1', '/srv/web');
  assert.notEqual(b.convId, a1.convId, '不同项目必须隔离');
  assert.equal(b.codexSessionId, null);
});

test('开新话题会丢掉 resume 状态', () => {
  mobileService.resetMobileConvo('h9', '/p');
  mobileService.rememberResume('h9', '/p', { claudeSessionId: 'abc' });
  assert.equal(mobileService.getMobileConvo('h9', '/p').claudeSessionId, 'abc');

  mobileService.resetMobileConvo('h9', '/p');
  assert.equal(mobileService.getMobileConvo('h9', '/p').claudeSessionId, null);
});

/* ------------------------------------------------------------ 路由 */

function deps(overrides = {}) {
  return {
    listHosts: async () => [],
    listProjects: async (hostId) => [{ path: `/p/${hostId}`, name: hostId }],
    startTask: async (a) => ({ taskId: 't1', ...a }),
    getTask: async () => null,
    listTasks: async () => [],
    cancelTask: async () => ({ ok: true }),
    inspect: async (a) => ({ label: a.kind, output: 'ok' }),
    resetSession: async () => ({ ok: true }),
    ...overrides
  };
}

test('项目列表走查询参数,缺 hostId 时报错而不是返回空', async () => {
  const missing = await route({ method: 'GET', pathname: '/api/projects', query: {} }, deps());
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /hostId/);

  const ok = await route({ method: 'GET', pathname: '/api/projects', query: { hostId: 'h1' } }, deps());
  assert.equal(ok.body.projects[0].path, '/p/h1');
});

test('提交任务时 cwd / engine / newSession 都被透传', async () => {
  const r = await route({
    method: 'POST', pathname: '/api/tasks',
    body: { hostId: 'h1', prompt: '修 bug', cwd: '/srv/api', engine: 'claude', newSession: true }
  }, deps());
  assert.equal(r.body.cwd, '/srv/api');
  assert.equal(r.body.engine, 'claude');
  assert.equal(r.body.newSession, true);
});

test('inspect 的错误原样返回,让用户知道为什么被拒', async () => {
  const d = deps({ inspect: async () => { throw new Error('路径不能包含 ..'); } });
  const r = await route({ method: 'POST', pathname: '/api/inspect', body: { kind: 'file' } }, d);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, '路径不能包含 ..');
});

/* ------------------------------------------------------------ 技能同步 */

test('桥接技能已教会 OpenClaw 用新接口,且仍是合法 SKILL.md', () => {
  const md = mobileService.renderBridgeSkill({ port: 18790 });
  const r = lintSkill(md);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);

  for (const must of ['/api/projects', '/api/inspect', '/api/reset', 'newSession', 'cwd']) {
    assert.ok(md.includes(must), `技能应说明 ${must}`);
  }
  // 明确告知能力边界,免得 agent 硬编不存在的接口
  assert.match(md, /做不到的事/);
  assert.match(md, /跑任意 shell 命令/);
});
