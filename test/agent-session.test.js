const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { AgentSession, isDuplicateFinal } = require('../electron/ssh/AgentSession');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 用户反馈「会出现重复」:同一段回复在界面上渲染了两次,
 * 第二个气泡带着 $0.1218 · 17.7s 的页脚。
 *
 * 原因是两个引擎的收尾事件都会把最后一段回复再带一遍:
 * claude 的 result.result、codex 的 task_complete.last_agent_message。
 * 我们原样又发了一条 kind:'result',于是就有了两个一模一样的气泡。 */

test('收尾正文与刚发过的一致时判为重复', () => {
  assert.equal(isDuplicateFinal('服务已启动', '服务已启动'), true);
  // 换行/空格差异不算不同 —— 两个引擎在这里的处理并不一致
  assert.equal(isDuplicateFinal('服务已启动\n\n可以访问', '服务已启动 可以访问'), true);
  // 真的多说了内容就不能吞
  assert.equal(isDuplicateFinal('服务已启动,另外还有一点', '服务已启动'), false);
  assert.equal(isDuplicateFinal('', '服务已启动'), false);
  assert.equal(isDuplicateFinal('收尾', ''), false);
});

test('重复时只保留费用/耗时,不再发一份正文', () => {
  const s = new AgentSession({ exec() {} }, null, { agent: 'claude', cwd: '/x' });
  const got = [];
  s.on('message', (m) => got.push(m));

  s._emitMsg({ kind: 'text', text: '服务已启动,现在可以访问:\nhttp://localhost:3003/lab' });
  s._emitFinal({ text: '服务已启动,现在可以访问:\nhttp://localhost:3003/lab', costUsd: 0.1218, durationMs: 17700 });

  assert.equal(got.length, 2);
  assert.equal(got[1].kind, 'result');
  assert.equal(got[1].text, '', '正文重复就不要再发一遍');
  assert.equal(got[1].costUsd, 0.1218, '费用还得留着');
});

test('收尾确实带了新内容时照常发出', () => {
  const s = new AgentSession({ exec() {} }, null, { agent: 'codex', cwd: '/x' });
  const got = [];
  s.on('message', (m) => got.push(m));
  s._emitMsg({ kind: 'text', text: '前半段' });
  s._emitFinal({ text: '前半段。另外我还改了配置文件。' });
  assert.equal(got[1].text, '前半段。另外我还改了配置文件。');
});

test('既无新正文也无费用 -> 整条丢掉,别塞空气泡', () => {
  const s = new AgentSession({ exec() {} }, null, { agent: 'codex', cwd: '/x' });
  const got = [];
  s.on('message', (m) => got.push(m));
  s._emitMsg({ kind: 'text', text: '做完了' });
  s._emitFinal({ text: '做完了' });     // codex 的 task_complete 不带费用
  assert.equal(got.length, 1);
});

test('两个引擎的收尾都走判重通道', () => {
  const src = read('electron/ssh/AgentSession.js');
  assert.match(src, /_emitFinal\(\{ text: msg\.last_agent_message/, 'codex task_complete');
  assert.match(src, /_emitFinal\(\{\s*\n?\s*text: ev\.result/, 'claude result');
  // 跨轮不能沿用,否则新一轮的收尾会被误判成重复而被吞掉
  assert.match(src, /this\.lastAssistantText = '';/);
});
