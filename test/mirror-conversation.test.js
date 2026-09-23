const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./helpers/loadEsm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const M = loadEsm('src/mirrorConversation.js');

/* ============================================================
 * 对话镜像:复制一份、保留历史,但换一条独立的引擎会话。
 *
 * 这个功能最容易写错的地方是**直觉上的"整个拷一份"**。
 * codexSessionId 指向引擎那边的一条线程,而那条线程只能有一个写者 ——
 * 两个对话拿同一个 id 去 resume,就是:
 *   thread-store conflict: thread <id> already has an active writer
 * 也就是之前排查了很久的「一直连不上」。
 * ============================================================ */

const src = () => ({
  id: 'c_1', hostId: 'h1', title: '测试', agent: 'codex',
  cwd: '/root/work', model: 'gpt-5.6-terra', reasoningEffort: 'high',
  permissionMode: 'system', autoApprove: true,
  messages: [
    { role: 'user', kind: 'text', text: '做个登录页', ts: 1 },
    { role: 'agent', kind: 'text', text: '已经建好 login.jsx', ts: 2 }
  ],
  codexSessionId: '01a041fc-4a1b-7911-be69-fc194ec4bd9c',
  claudeSessionId: 'cl_abc',
  codexStarted: true,
  lastTurnAgent: 'claude',
  goal: { text: '把登录做完', status: 'active', rounds: 7 },
  team: { impl: 'codex', review: 'claude' },
  usage: { inputTokens: 900000, outputTokens: 120000, costUsd: 12.5 },
  createdAt: 1, updatedAt: 2
});

/* ---------------------------------------------- 不能复制的东西 */

test('引擎会话 ID 绝不跟着复制', () => {
  /* 这条是整个功能的地基。复制了就是两个对话抢同一条线程的写锁,
     而且症状("一直连不上")跟"镜像"这个操作看不出任何关联。 */
  const copy = M.mirrorConversation(src());
  assert.equal(copy.codexSessionId, null);
  assert.equal(copy.claudeSessionId, null);
  assert.equal(copy.codexStarted, false, '新线程还没起过');
});

test('目标模式和团队模式不跟着复制', () => {
  /* 这两个都会**自动发消息**。跟着复制的话,两个对话会同时
     对着同一个工作目录推进 —— 互相覆盖改动,还双倍烧钱。 */
  const copy = M.mirrorConversation(src());
  assert.equal(copy.goal, null);
  assert.equal(copy.team, null);
});

test('用量归零', () => {
  // 那是源对话真实烧掉的 token,记在镜像头上会让预算和账单都对不上
  const copy = M.mirrorConversation(src());
  assert.equal(copy.usage.inputTokens, 0);
  assert.equal(copy.usage.costUsd, 0);
});

test('lastTurnAgent 清空', () => {
  /* 不清的话,镜像第一轮会走"引擎切换交接"那条分支,
     和镜像自己的上下文交接撞在一起,发两份摘要。 */
  assert.equal(M.mirrorConversation(src()).lastTurnAgent, '');
});

test('该重置的字段有一份带理由的清单', () => {
  /* 以后给 conv 加字段时,漏掉一个就是一个很难查的 bug ——
     所以把"为什么不能复制"写在代码里,而不是留给下一个人推理。 */
  for (const k of ['codexSessionId', 'claudeSessionId', 'codexStarted', 'goal', 'team']) {
    assert.ok(M.NOT_MIRRORED[k], `${k} 缺少理由说明`);
  }
});

/* ---------------------------------------------- 要保留的东西 */

test('历史、目录、引擎、模型、权限都保留', () => {
  const copy = M.mirrorConversation(src());
  assert.equal(copy.messages.length, 2);
  assert.equal(copy.messages[1].text, '已经建好 login.jsx');
  assert.equal(copy.cwd, '/root/work');
  assert.equal(copy.agent, 'codex');
  assert.equal(copy.model, 'gpt-5.6-terra');
  assert.equal(copy.permissionMode, 'system');
  assert.equal(copy.reasoningEffort, 'high');
});

test('消息数组是新的,改镜像不会动到源对话', () => {
  const a = src();
  const copy = M.mirrorConversation(a);
  copy.messages.push({ role: 'user', text: '新的' });
  assert.equal(a.messages.length, 2, '源对话被改到了');
});

test('id 是新的,并记下来自哪条', () => {
  const a = src();
  const copy = M.mirrorConversation(a);
  assert.notEqual(copy.id, a.id);
  assert.equal(copy.mirrorOf, 'c_1');
  assert.ok(copy.mirroredAt > 0);
});

/* ---------------------------------------------- 标题 */

test('标题加「副本」,连续镜像时递增', () => {
  /* 镜像常常连着做好几个(试几种方案),
     「X 副本 副本 副本」堆起来就没法看了。 */
  assert.equal(M.nextMirrorTitle('测试'), '测试 副本');
  assert.equal(M.nextMirrorTitle('测试 副本'), '测试 副本 2');
  assert.equal(M.nextMirrorTitle('测试 副本 2'), '测试 副本 3');
  assert.equal(M.nextMirrorTitle('测试 副本 9'), '测试 副本 10');
});

test('空标题不会变成「 副本」', () => {
  assert.equal(M.nextMirrorTitle(''), '对话 副本');
  assert.equal(M.nextMirrorTitle(null), '对话 副本');
  assert.equal(M.nextMirrorTitle('   '), '对话 副本');
});

test('可以指定标题和目录', () => {
  const copy = M.mirrorConversation(src(), { title: '方案二', cwd: '/root/exp' });
  assert.equal(copy.title, '方案二');
  assert.equal(copy.cwd, '/root/exp');
});

test('空输入不炸', () => {
  assert.equal(M.mirrorConversation(null), null);
  assert.equal(M.mirrorConversation({}), null, '没有 id 的不是有效对话');
});

/* ---------------------------------------------- 上下文交接 */

test('第一轮把历史摘要带给新线程', () => {
  const copy = M.mirrorConversation(src());
  assert.equal(copy.needsContextReplay, true);
});

test('交接提示词要说清"别重做"', () => {
  /* 不说的话,模型很可能把摘要里提到的事再做一遍 ——
     而那些事在磁盘上早就做完了,重做就是覆盖。 */
  const p = M.buildMirrorPrompt('用户: 做个登录页\n助手: 已经建好 login.jsx', '继续加注册页');
  assert.match(p, /不要重做/);
  assert.match(p, /login\.jsx/, '摘要本身要在');
  assert.match(p, /继续加注册页/, '用户的新指令要在');
  assert.match(p, /磁盘上的改动都还在/);
});

test('没有摘要时原样返回用户指令', () => {
  // 空对话镜像出来也该能正常发消息,而不是发一段只有套话的提示词
  assert.equal(M.buildMirrorPrompt('', '你好'), '你好');
});

/* ---------------------------------------------- 接线 */

test('第一轮用完就清掉标记', () => {
  /* 不清的话每一轮都重发一遍摘要 —— 一条 2000 条消息的对话,
     那是每轮白烧几千 token。 */
  const store = read('src/store.js');
  assert.match(store, /if \(conv\?\.needsContextReplay\)/);
  assert.match(store, /needsContextReplay: false/);
});

test('镜像交接和引擎切换交接是互斥的两条分支', () => {
  /* 同时走会发两份摘要。
     中间还夹着"分路"那一支(它也是 needsContextReplay 的一种),
     所以这里取整段来判,而不是卡一个固定的字符窗口 ——
     窗口开小了,以后每加一个分支这条测试就误报一次。 */
  const store = read('src/store.js');
  const start = store.indexOf('if (conv?.needsContextReplay)');
  const next = store.indexOf('} else if (conv && conv.lastTurnAgent', start);
  assert.ok(start > 0 && next > start, '两条分支必须是 if / else if 关系');
  // 中间不能再出现第二个独立的 if(那就不是互斥了)
  const between = store.slice(start, next);
  assert.ok(!/\n    if \(/.test(between), '中间出现了同级的独立 if,可能会重复交接');
});

test('界面上标出"镜像副本 · 共用工作目录"', () => {
  /* 两条对话对着同一个目录。不标的话,很容易以为副本是独立沙箱,
     在里面做破坏性操作 —— 而它改的是同一批文件。 */
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /conv\.mirrorOf &&/);
  assert.match(chat, /共用工作目录/);
});
