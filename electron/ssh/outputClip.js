/**
 * 命令输出截断。
 *
 * 与 src/toolOutput.js 同一套规则 —— 主进程用 CommonJS、渲染进程用 ESM,
 * 所以逻辑写两份,由测试保证两边行为一致。
 *
 * 关键取舍:**保留头和尾,省略中间**。原来是 slice(0, 4000),只留开头 ——
 * 但命令输出的价值分布是两头重、中间轻:开头说明它在干什么,结尾是结果和报错,
 * 中间往往是几百行进度刷屏。`journalctl -n 80` 被截掉后半段,
 * 恰好把你要看的那部分扔了。
 */
const OUTPUT_LIMIT = 8000;

function clipOutput(text, limit = OUTPUT_LIMIT) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.35);
  const tail = limit - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… 中间省略 ${omitted.toLocaleString()} 字符 …\n\n${s.slice(-tail)}`;
}

module.exports = { clipOutput, OUTPUT_LIMIT };
