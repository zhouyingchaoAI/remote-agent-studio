/**
 * 命令输出的裁剪与摘要。
 *
 * 对话里每条「执行命令」后面都跟着一段输出。两个问题要一起解决:
 *
 * 1. **截断要留尾巴。** 一直用的是 `slice(0, 4000)`,只保留开头。但命令输出里
 *    最要紧的东西几乎总在最后 —— 报错、退出码、最终结论。`journalctl -n 80`
 *    截掉后半段,恰好把你要看的那部分扔了。所以改成头尾都留、中间省略。
 *
 * 2. **折叠也得说点什么。** 全部折起来等于没有中间过程,全部展开又会把对话冲垮。
 *    折叠状态下给一行摘要:最后一行有内容的输出 + 总行数。多数时候这一行
 *    就够判断"要不要展开"了。
 */

/** 输出保留上限。头尾各一半。 */
export const OUTPUT_LIMIT = 8000;

/**
 * 裁剪长输出:保留开头和结尾,中间标出省略了多少。
 *
 * 为什么不是简单的 slice:命令输出的价值分布是两头重、中间轻 ——
 * 开头是它在干什么,结尾是结果和报错,中间往往是成百上千行进度刷屏。
 */
export function clipOutput(text, limit = OUTPUT_LIMIT) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  const head = Math.floor(limit * 0.35);
  const tail = limit - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… 中间省略 ${omitted.toLocaleString()} 字符 …\n\n${s.slice(-tail)}`;
}

/**
 * 折叠时显示的一行摘要。
 *
 * 取**最后一行非空输出** —— 不是第一行。命令的结论在末尾,
 * 而开头往往是无信息量的横幅或表头。
 */
export function outputSummary(text, { maxLen = 96 } = {}) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return { lines: 0, preview: '' };
  const last = lines[lines.length - 1].trim();
  return {
    lines: lines.length,
    preview: last.length > maxLen ? `${last.slice(0, maxLen - 1)}…` : last
  };
}

/**
 * 这段输出看起来是不是失败了。
 *
 * 用途只有一个:决定要不要**默认展开**。失败的命令你一定想看,
 * 成功的默认折起来。判断错了代价很小(多展开或少展开一段),
 * 所以宁可宽松一点。
 *
 * 注意排除 grep 之类的正常用法 —— "0 matches" 不是错误。
 */
const FAIL_PATTERNS = [
  /\b(error|fatal|failed|failure)\b/i,
  /\bexit(ed)?\s+(code\s+)?[1-9]/i,
  /\b(permission denied|no such file|not found|command not found)\b/i,
  /\b(traceback|panic:|segmentation fault)\b/i,
  /(错误|失败|拒绝访问|没有那个文件)/
];

export function looksFailed(text, exitCode) {
  // 有退出码就以它为准 —— 那是确定的事实,不用猜
  if (exitCode != null && Number.isFinite(Number(exitCode))) return Number(exitCode) !== 0;
  const s = String(text || '');
  if (!s.trim()) return false;
  return FAIL_PATTERNS.some((re) => re.test(s));
}
