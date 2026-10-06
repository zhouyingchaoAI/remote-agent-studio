const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 长对话为什么卡。
 *
 * 先量了持久化:1 条 2000 消息 + 7 条 200 消息,每次 persist 序列化全部
 * 只要 1.5ms —— **不是瓶颈**。真正的开销在渲染:Message 没 memo,
 * 流式输出每来一个 delta,窗口内 200 条消息全部重渲染、每条重新解析
 * Markdown,每秒十几次 delta 就是每秒几千次解析。
 *
 * 持久化那层顺手也改了(只发脏对话过 IPC),但要说清楚:它是省开销,
 * 不是修卡顿。
 * ============================================================ */

const chat = read('src/components/ChatPanel.jsx');

/* ---------------------------------------------- 渲染:memo 三件套 */

test('Message 用 React.memo 包着', () => {
  assert.match(chat, /const Message = React\.memo\(function Message\(/);
});

test('传给 Message 的回调引用稳定', () => {
  /* memo 生效的前提。每次渲染新建一个箭头函数当 prop,
     200 条消息就全部重渲染 —— memo 形同虚设,还白付比较的开销。 */
  assert.match(chat, /const onQuickReply = React\.useCallback\(/);
  assert.match(chat, /const onEnableSystemMode = React\.useCallback\(/);
  assert.match(chat, /const onFileLink = React\.useCallback\(/);
  // 调用处不能再是内联箭头
  const at = chat.indexOf('<Message key=');
  const usage = chat.slice(at, at + 500);
  assert.ok(!/onQuickReply=\{\(t\) =>/.test(usage), 'onQuickReply 还是内联箭头');
  assert.ok(!/onFileLink=\{\(p\) =>/.test(usage), 'onFileLink 还是内联箭头');
  assert.ok(!/onEnableSystemMode=\{\(\) =>/.test(usage), 'onEnableSystemMode 还是内联箭头');
});

test('稳定回调通过 ref 调到最新的 send', () => {
  /* send 自己每次渲染都是新函数(它闭包了 input 等状态)。
     useCallback 的 deps 填 [] 又直接调 send,会永远调到第一次渲染的那个 ——
     发出去的是旧状态。用 ref 中转:回调引用不变,指向的实现永远最新。 */
  assert.match(chat, /sendRef\.current = send;/);
  assert.match(chat, /permRef\.current = changePermissionMode;/);
  assert.match(chat, /sendRef\.current\?\.\(t\)/);
});

test('Markdown 也 memo', () => {
  // 一条消息的 text 只在它自己流式更新时才变,其余 199 条完全不该重新解析
  const md = read('src/components/Markdown.jsx');
  assert.match(md, /export default React\.memo\(Markdown\)/);
});

test('store 只替换被改的那条消息,其余保持引用', () => {
  /* memo 比较的是引用。store 若每次把所有消息对象重建一遍,
     memo 一个都命中不了。这里查的是三条热路径。 */
  const store = read('src/store.js');
  // appendStreamDelta:只重建最后一条
  assert.match(store, /next = \[\.\.\.msgs\.slice\(0, -1\), \{ \.\.\.last, text: last\.text \+ chunk \}\]/);
  // pushMessage 的 id 合并:拷数组、只换一个下标
  assert.match(store, /const next = \[\.\.\.c\.messages\];\s*[\s\S]{0,200}next\[idx\] = \{ \.\.\.next\[idx\], \.\.\.msg/);
  // appendToolDelta:同样只换一个下标
  assert.match(store, /next\[i\] = \{\s*\.\.\.next\[i\], running: true/);
});

/* ---------------------------------------------- 持久化:只发脏的 */

const storeSrc = read('src/store.js');

test('persist 只把变过的对话送过 IPC', () => {
  assert.match(storeSrc, /const changed = all\.filter\(\(c\) => sentAt\.get\(c\.id\) !== c\.updatedAt\)/);
  assert.match(storeSrc, /window\.api\.convos\.save\(\{ changed, ids \}\)/);
});

test('id 列表每次都带全 —— 主进程靠它删文件', () => {
  /* 只发脏对话不发 id,删掉的对话会在磁盘上永远留着,
     下次启动又全部冒出来。 */
  assert.match(storeSrc, /const ids = all\.map\(\(c\) => c\.id\)/);
});

test('加载后标记为已持久化,不把刚读出来的原样写回', () => {
  assert.match(storeSrc, /markPersisted\(Object\.values\(map\)\)/);
});

/* ---------------------------------------------- 主进程:两种入参都认 */

test('saveConvos 接受新旧两种入参', async () => {
  /* 旧的整数组形态还有别的调用方可能在用;不兼容会让它们静默丢数据。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convos-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  // 把 electron 的 app.getPath 桩掉
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: { getPath: () => dir }, safeStorage: {} };
    return orig.call(this, req, ...rest);
  };
  try {
    const p = require.resolve('../electron/store');
    delete require.cache[p];
    const st = require(p);

    // 旧形态:整数组
    st.saveConvos([{ id: 'a', updatedAt: 1, messages: [] }, { id: 'b', updatedAt: 1, messages: [] }]);
    assert.deepEqual(st.loadConvos().map((c) => c.id).sort(), ['a', 'b']);

    // 新形态:只发脏的 + 全量 id。b 没变但要留着;c 新增;a 被删
    st.saveConvos({ changed: [{ id: 'c', updatedAt: 2, messages: [] }], ids: ['b', 'c'] });
    assert.deepEqual(st.loadConvos().map((c) => c.id).sort(), ['b', 'c'], 'a 该被删,b 该保留');
  } finally {
    Module._load = orig;
  }
});
