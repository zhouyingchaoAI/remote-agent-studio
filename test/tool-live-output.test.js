const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 命令执行的实时日志。
 *
 * 起因:一条跑十分钟的命令,在它结束之前对话里什么都看不到。
 * 而引擎其实一直在发增量输出 —— 只是事件不带 id,渲染端分不清
 * "同一条命令又长了一截"和"另起了一条命令",这些数据就被丢掉了。
 * ============================================================ */

/* ---------------------------------------------- 增量块的解码 */

// AgentSession 是 CommonJS,但整文件 require 会连带拉起 ssh 依赖,这里只取函数
function loadDecodeChunk() {
  const src = read('electron/ssh/AgentSession.js');
  const start = src.indexOf('function decodeChunk');
  assert.ok(start > 0, '没找到 decodeChunk');
  const end = src.indexOf('\n}', start) + 2;
  // eslint-disable-next-line no-new-func
  return new Function('Buffer', `${src.slice(start, end)}; return decodeChunk;`)(Buffer);
}
const decodeChunk = loadDecodeChunk();

test('字节数组能解出文本', () => {
  /* Rust 侧 Vec<u8> 会被序列化成数字数组。 */
  const bytes = [...Buffer.from('拉取镜像中\n', 'utf8')];
  assert.equal(decodeChunk(bytes), '拉取镜像中\n');
});

test('base64 字符串也能解出文本', () => {
  /* 另一些版本发 base64。只认一种的话,在另一半版本上表现为
     "实时日志永远是空的",而且**不报任何错** —— 这种沉默的坏法最难查。 */
  assert.equal(decodeChunk(Buffer.from('Cloning into /tmp/x...\n').toString('base64')),
    'Cloning into /tmp/x...\n');
});

test('普通文本不会被误当成 base64 解成乱码', () => {
  /* 碰巧只含 base64 字符、长度又是 4 的倍数的文本很常见。
     解错的结果是一屏乱码 —— 比不解码糟得多。 */
  for (const s of ['done', 'abcd', 'Building', '中文进度', 'a b\n']) {
    assert.equal(decodeChunk(s), s, s);
  }
});

test('空值不炸', () => {
  for (const v of [null, undefined, '', []]) assert.equal(decodeChunk(v), '');
});

/* ---------------------------------------------- 事件解析 */

test('命令跑到一半的事件带上 id 和"运行中"', () => {
  /* 没有 id,渲染端就没法把后续输出接到同一条命令上;
     没有 running,界面就分不出"还在跑"和"跑完了"。 */
  const src = read('electron/ssh/AgentSession.js');
  const seg = src.slice(src.indexOf("if (it === 'command_execution')"));
  assert.match(seg.slice(0, 1200), /const running = t === 'item\.updated' && exitCode == null/);
  assert.match(seg.slice(0, 1200), /id: item\.id \|\| item\.item_id \|\| null, running/);
});

test('退出码存在就不算运行中', () => {
  /* item.updated 也可能在命令结束后再来一次。
     只看事件类型不看退出码的话,那条命令会永远转着圈。 */
  const src = read('electron/ssh/AgentSession.js');
  const seg = src.slice(src.indexOf("if (it === 'command_execution')"));
  assert.match(seg.slice(0, 1200), /exitCode == null/);
});

test('老格式的三个事件用 call_id 串起来', () => {
  const src = read('electron/ssh/AgentSession.js');
  assert.match(src, /case 'exec_command_begin'[\s\S]{0,400}id: msg\.call_id/);
  assert.match(src, /case 'exec_command_output_delta'[\s\S]{0,400}id: msg\.call_id/);
  assert.match(src, /case 'exec_command_end'[\s\S]{0,400}id: msg\.call_id/);
});

test('权限提示只在命令结束后判', () => {
  // 跑到一半的输出容易触发误报,而这个提示会直接弹给用户
  const src = read('electron/ssh/AgentSession.js');
  const seg = src.slice(src.indexOf("if (it === 'command_execution')"));
  assert.match(seg.slice(0, 1200), /if \(!running\) this\._maybeEmitPermissionHint/);
});

/* ---------------------------------------------- store 合并 */

const store = read('src/store.js');

test('同 id 的消息就地更新,不追加', () => {
  /* 无脑追加的话,一条跑五分钟的命令会在对话里留下几十条
     几乎一样的「执行命令」,把真正的内容冲走。 */
  const fn = store.slice(store.indexOf('pushMessage: (convId, msg)'), store.indexOf('addUsage:'));
  assert.match(fn, /findIndex\(\(m\) => m\.id === msg\.id && m\.kind === msg\.kind\)/);
  assert.match(fn, /ts: next\[idx\]\.ts/, '保留原时间戳,否则消息会在排序里跳位');
});

test('tool_output 能合进对应的 tool,合不上才追加', () => {
  // 合不上就退回追加 —— 老对话里的 tool_output 没有 id,不能因此丢掉
  const fn = store.slice(store.indexOf('pushMessage: (convId, msg)'), store.indexOf('addUsage:'));
  assert.match(fn, /msg\.kind === 'tool_output' && msg\.id/);
  assert.match(fn, /running: false/);
});

test('增量输出是追加,不是替换', () => {
  /* 老格式的 delta 只给新增的一小块,不给全量。
     写成替换的话,日志会只剩最后一个字符。 */
  const fn = store.slice(store.indexOf('appendToolDelta:'));
  assert.match(fn.slice(0, 900), /\(c\.messages\[i\]\.output \|\| ''\) \+ chunk/);
});

test('实时日志有长度上限,只留最后一段', () => {
  /* 一条 docker build 能刷出几十万字符。全存进对话会把渲染拖垮,
     而且会被写进持久化文件 —— 实时日志要看的本来就是最新那几屏。 */
  const fn = store.slice(store.indexOf('appendToolDelta:'));
  assert.match(fn.slice(0, 900), /LIVE_LIMIT/);
  assert.match(fn.slice(0, 900), /slice\(-LIVE_LIMIT\)/);
});

test('本轮结束会把还挂着"运行中"的命令收掉', () => {
  /* 不收的话,一条被中断的命令会永远转圈 ——
     "永远在跑"和"跑了很久"在界面上长得一模一样。 */
  assert.match(store, /clearRunningTools:/);
  const app = read('src/App.jsx');
  assert.match(app, /st\.clearRunningTools\(convId\)/);
  assert.match(app, /st\.appendToolDelta\(convId, msg\.id, msg\.text\)/);
});

/* ---------------------------------------------- 界面 */

const chat = read('src/components/ChatPanel.jsx');

test('跑着的输出默认展开', () => {
  /* 命令跑了十分钟你却要先点一下才能看见它在干什么,等于这个日志不存在。 */
  assert.match(chat, /useState\(failed \|\| running\)/);
});

test('自动滚到底,但用户往上翻时不抢视线', () => {
  /* 日志一直在长。不管三七二十一都滚到底的话,
     人正在看某一行报错时会被反复拽回去 —— 比不自动滚更烦。 */
  assert.match(chat, /followRef\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < \d+/);
  assert.match(chat, /if \(followRef\.current\) el\.scrollTop = el\.scrollHeight/);
});

test('还没有输出时也要显示出来', () => {
  // 否则界面上什么都没有,和卡死没区别
  assert.match(chat, /if \(!String\(output\)\.trim\(\) && !running\) return null/);
});

test('停止复用会话本身的取消通道', () => {
  /* 那条通道会 kill 远端进程。在这儿另写一套"停止命令"必然和它不一致 ——
     一个停了界面、另一个还在远端跑。 */
  assert.match(chat, /window\.api\.agent\.cancel\(\{ hostId, convId \}\)/);
});
