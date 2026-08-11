const test = require('node:test');
const assert = require('node:assert');
const {
  buildRemoteListCommand, parseRemoteList, planRemoteFetch, buildRemoteFetchCommand,
  parseRemoteFetch, projectFromRemotePath, scanRemoteSessions, REMOTE_MARK
} = require('../electron/cliSessions');

test('远程列举命令覆盖两个 CLI 的目录,并有 GNU/BSD 双路径', () => {
  const cmd = buildRemoteListCommand();
  assert.match(cmd, /\.claude\/projects/);
  assert.match(cmd, /\.codex\/sessions/);
  assert.match(cmd, /-printf/);      // GNU find 快路径
  assert.match(cmd, /stat -c/);      // 没有 -printf 时的回退
  assert.match(cmd, /head -n \d+/);  // 有数量上限
});

test('解析列举输出;脏行忽略', () => {
  const out = [
    '1785000000.5|12000|/home/me/.claude/projects/-home-me-proj/a.jsonl',
    '不是有效行',
    '1784000000|500|/home/me/.codex/sessions/2026/07/01/rollout-x.jsonl'
  ].join('\n');
  const list = parseRemoteList(out);
  assert.equal(list.length, 2);
  assert.equal(list[0].size, 12000);
  assert.equal(list[0].mtime, 1785000000500);
});

test('按总预算挑文件,超预算即停(避免一次拉几十 MB)', () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ file: `f${i}`, size: 50000, mtime: i }));
  const picked = planRemoteFetch(files, { totalBudget: 200000, perFile: 40000 });
  assert.equal(picked.length, 5);            // 200000 / 40000
  assert.ok(picked.every((p) => p.take === 40000));
});

test('小文件按实际大小取,不浪费预算', () => {
  const picked = planRemoteFetch([{ file: 'a', size: 1000, mtime: 1 }], { perFile: 40000 });
  assert.equal(picked[0].take, 1000);
});

test('读取命令对路径做转义(空格/引号不会破坏命令)', () => {
  const cmd = buildRemoteFetchCommand([{ file: "/home/me/a b'c.jsonl", take: 100 }]);
  assert.match(cmd, /tail -c 100/);
  assert.ok(cmd.includes(JSON.stringify("/home/me/a b'c.jsonl")));
});

test('解析批量读取输出,按标记切分', () => {
  const stdout = [
    REMOTE_MARK, '/p/a.jsonl', '{"type":"user","message":{"content":"甲"}}',
    REMOTE_MARK, '/p/b.jsonl', '{"type":"user","message":{"content":"乙"}}'
  ].join('\n');
  const parsed = parseRemoteFetch(stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].file, '/p/a.jsonl');
  assert.match(parsed[1].raw, /乙/);
});

test('从远程路径推断项目名', () => {
  assert.equal(projectFromRemotePath('/home/me/.claude/projects/-home-me-zyc-workspace/s.jsonl'),
    '/home/me/zyc/workspace');
  assert.equal(projectFromRemotePath('/home/me/.codex/sessions/2026/07/01/r.jsonl'), 'Codex 会话');
});

test('端到端:用假的 exec 跑通远程扫描', async () => {
  // 内容要超过 400 字的最小阈值(过短的会话没有沉淀价值,会被有意过滤)
  const long = `{"type":"user","message":{"content":"${'排查问题的过程记录'.repeat(60)}"}}`;
  const exec = async (cmd) => {
    if (cmd.includes('find')) {
      return { stdout: '1785000000|9999|/home/me/.claude/projects/-home-me-demo/s1.jsonl' };
    }
    return { stdout: `${REMOTE_MARK}\n/home/me/.claude/projects/-home-me-demo/s1.jsonl\n${long}` };
  };
  const sessions = await scanRemoteSessions(exec, { hostLabel: 'srv1' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].project, 'srv1:/home/me/demo');
  assert.match(sessions[0].content, /排查问题/);
});

test('远程不可用时安全返回空,不抛异常', async () => {
  const boom = async () => { throw new Error('连不上'); };
  assert.deepEqual(await scanRemoteSessions(boom), []);
  assert.deepEqual(await scanRemoteSessions(null), []);
});
