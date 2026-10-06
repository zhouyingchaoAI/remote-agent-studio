const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { clipOutput, OUTPUT_LIMIT } = require('../electron/ssh/outputClip');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// src 下是 ESM,测试里轻量转换加载
function loadEsm(rel, names) {
  const src = read(path.join('src', rel))
    .replace(/export const/g, 'const')
    .replace(/export function/g, 'function');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`${src}\nmodule.exports = { ${names.join(', ')} };`, sandbox);
  return sandbox.module.exports;
}
const ui = loadEsm('toolOutput.js', ['clipOutput', 'outputSummary', 'looksFailed', 'OUTPUT_LIMIT']);

/* ------------------------------------------------------- 中间过程可见 */

test('tool 消息会渲染它携带的 output', () => {
  /* 这是"完全不知道中间过程"的根因:codex 新格式把命令输出挂在 tool 消息的
     output 字段上,而渲染器只画命令、**从来不看 output** ——
     于是对话里只剩一行命令和一段结论,没法验证结论对不对。 */
  const chat = readChatSources();
  assert.match(chat, /<ToolOutput output=\{m\.output\} exitCode=\{m\.exitCode\} \/>/);
  assert.match(chat, /function ToolCall/);
});

test('后端在 tool 消息上带出输出和退出码', () => {
  const s = read('electron/ssh/AgentSession.js');
  assert.match(s, /kind: 'tool', name: '执行命令', detail: item\.command, output/);
  /* 退出码现在先取到变量里(实时日志要靠它判断命令是不是还在跑),
     所以这里查的是"取值来源对不对",不是那一行长什么样。 */
  assert.match(s, /const exitCode = item\.exit_code \?\? item\.exitCode \?\? null;/);
  assert.match(s, /kind: 'tool'[\s\S]{0,400}\n\s*exitCode,/);
  // claude 的工具失败用 is_error 标记,比猜关键词准
  assert.match(s, /exitCode: b\.is_error \? 1 : null/);
});

test('长命令能展开看全,不是硬截断了事', () => {
  // 200 字符经常正好把命令切在关键参数上
  const chat = readChatSources();
  assert.match(chat, /showFull \|\| !long \? detail : `\$\{detail\.slice\(0, 200\)\}…`/);
});

/* ------------------------------------------------------------ 截断 */

test('截断保留头和尾,不是只留开头', () => {
  /* 原来是 slice(0, 4000),只留开头。但命令输出最要紧的东西几乎总在最后 ——
     报错、退出码、最终结论。journalctl -n 80 被截掉后半段,
     恰好把你要看的那部分扔了。 */
  const text = `${'A'.repeat(20000)}关键报错在最后`;
  const out = clipOutput(text);
  assert.ok(out.length < text.length);
  assert.ok(out.endsWith('关键报错在最后'), '尾部被扔掉了');
  assert.ok(out.startsWith('AAAA'), '头部也要留');
  assert.match(out, /中间省略/);
});

test('短输出原样返回,不加任何标记', () => {
  assert.equal(clipOutput('hello'), 'hello');
  assert.equal(clipOutput(''), '');
  assert.equal(clipOutput(null), '');
});

test('主进程和渲染进程的截断规则一致', () => {
  /* 一份 CommonJS 一份 ESM,逻辑写了两遍。
     不一致的话:后端截到 8000 存进历史,前端按别的规则再算一次,
     显示出来的和实际存的对不上。 */
  assert.equal(OUTPUT_LIMIT, ui.OUTPUT_LIMIT);
  const long = 'x'.repeat(30000) + 'END';
  assert.equal(clipOutput(long), ui.clipOutput(long));
});

test('上限比原来的 4000 大 —— 一屏日志经常就超了', () => {
  assert.ok(OUTPUT_LIMIT >= 8000);
});

/* ------------------------------------------------------------ 摘要 */

test('折叠时的摘要取最后一行非空输出', () => {
  /* 不是第一行。命令的结论在末尾,开头往往是无信息量的横幅或表头 ——
     显示第一行等于告诉你"它开始跑了",而你想知道的是"结果如何"。 */
  const text = 'Loading...\n表头\n\n  Error: connection refused  \n\n';
  const s = ui.outputSummary(text);
  assert.equal(s.preview, 'Error: connection refused');
  assert.equal(s.lines, 3);
});

test('空输出的摘要是空的,不显示空壳', () => {
  assert.equal(ui.outputSummary('').lines, 0);
  assert.equal(ui.outputSummary('\n\n  \n').preview, '');
});

test('过长的摘要会截断', () => {
  const s = ui.outputSummary('x'.repeat(300));
  assert.ok(s.preview.length <= 96);
  assert.ok(s.preview.endsWith('…'));
});

/* ------------------------------------------------------------ 失败识别 */

test('有退出码就以退出码为准,不猜', () => {
  // 退出码是确定的事实
  assert.equal(ui.looksFailed('一切正常', 1), true);
  assert.equal(ui.looksFailed('Error: 这个词出现在正常输出里', 0), false);
});

test('没有退出码时按关键词判断,用于决定要不要默认展开', () => {
  assert.equal(ui.looksFailed('bash: xyz: command not found'), true);
  assert.equal(ui.looksFailed('Permission denied'), true);
  assert.equal(ui.looksFailed('Traceback (most recent call last):'), true);
  assert.equal(ui.looksFailed('错误:连接超时'), true);
  assert.equal(ui.looksFailed('ok\nall good\n'), false);
  assert.equal(ui.looksFailed(''), false);
});

test('失败的输出默认展开', () => {
  // 成功的折起来省地方;失败的那条正是你想看的,不该还要多点一下
  const chat = readChatSources();
  assert.match(chat, /const failed = looksFailed\(output, exitCode\);/);
  /* 还在跑的也默认展开 —— 想看进度的时刻正是它还在跑的时刻。
     两个条件都要在,少一个就有一类输出要多点一下才能看见。 */
  assert.match(chat, /useState\(failed \|\| running\)/);
});

test('退出码非 0 时显著标出来', () => {
  // 失败的命令和成功的长得一样,是这个界面最早的问题之一
  const chat = readChatSources();
  assert.match(chat, /exit-bad/);
  assert.match(chat, /退出码/);
});
