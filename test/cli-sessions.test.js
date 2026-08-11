const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  decodeProjectDir, textFromEvent, parseSessionFile, scanLocalSessions, summarize
} = require('../electron/cliSessions');

test('项目目录名还原成路径', () => {
  assert.equal(decodeProjectDir('-Users-me-code-myproject'), '/Users/me/code/myproject');
  assert.equal(decodeProjectDir('plain'), 'plain');
});

test('抽取消息文本:兼容字符串与 content 数组', () => {
  assert.match(textFromEvent({ type: 'user', message: { content: '帮我修个 bug' } }), /【我】帮我修个 bug/);
  assert.match(
    textFromEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '好的' }] } }),
    /【AI】好的/
  );
});

test('工具调用与结果也纳入(经验往往藏在这里)', () => {
  const t = textFromEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] }
  });
  assert.match(t, /\[工具\] Bash/);
  assert.match(t, /npm test/);

  const r = textFromEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: '182 passed' }] }
  });
  assert.match(r, /\[结果\] 182 passed/);
});

test('非消息事件与空内容被忽略', () => {
  assert.equal(textFromEvent({ type: 'summary', summary: 'x' }), '');
  assert.equal(textFromEvent({ type: 'user', message: { content: '   ' } }), '');
  assert.equal(textFromEvent(null), '');
});

test('解析 jsonl:坏行跳过,不影响整体(格式随版本变是常态)', () => {
  const jsonl = [
    '{"type":"user","message":{"content":"第一条"}}',
    '这不是 JSON',
    '{坏掉的 json',
    '',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"第二条"}]}}'
  ].join('\n');
  const text = parseSessionFile(jsonl);
  assert.match(text, /第一条/);
  assert.match(text, /第二条/);
  assert.equal(text.split('\n').length, 2);   // 坏行不产生噪声
});

test('超长会话按上限截断', () => {
  const long = Array.from({ length: 500 },
    (_, i) => `{"type":"user","message":{"content":"${'x'.repeat(200)}"}}`).join('\n');
  const text = parseSessionFile(long, { maxChars: 2000 });
  assert.ok(text.length < 4000);
  assert.match(text, /已截断/);
});

test('扫描真实目录结构:按项目归类、过滤过短会话', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const proj = path.join(home, '.claude', 'projects', '-Users-me-demo');
  fs.mkdirSync(proj, { recursive: true });
  // 有内容的会话
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'),
    `{"type":"user","message":{"content":"${'内容'.repeat(200)}"}}`);
  // 过短的会话应被过滤
  fs.writeFileSync(path.join(proj, 'sess2.jsonl'), '{"type":"user","message":{"content":"hi"}}');

  const sessions = scanLocalSessions({ homeDir: home });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].project, '/Users/me/demo');
  assert.equal(sessions[0].source, 'claude');

  const sum = summarize(sessions);
  assert.equal(sum.sessions, 1);
  assert.equal(sum.projects, 1);
  assert.equal(sum.topProjects[0].project, '/Users/me/demo');
});

test('目录不存在时安全返回空,不抛异常', () => {
  const sessions = scanLocalSessions({ homeDir: '/definitely/not/exist' });
  assert.deepEqual(sessions, []);
  assert.equal(summarize([]).sessions, 0);
});
