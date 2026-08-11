/**
 * 从模型回复里识别「可点击的选项」。
 *
 * 难点:编号清单在正常内容里极常见(周报、总结、计划、步骤说明),
 * 只靠"有 1. 2. 3."判断会把这些全变成按钮。因此要求同时满足:
 *   1) 编号从 1 开始且连续、数量 2~8
 *   2) 每项都短(选项是短语,不是叙述句)
 *   3) 清单前后存在"让你选"的语义线索(选择措辞或疑问句)
 */

// "让你选"的措辞线索
const CHOICE_CUE = new RegExp([
  '请选择', '请选', '选择以下', '以下选项', '可选(操作|方案|项)', '选哪', '哪一个', '哪个',
  '你想', '您想', '你希望', '您希望', '要不要', '是否需要', '请回复(序号|数字|编号)',
  '回复(序号|数字|编号)', '选项如下', '接下来(要|想)',
  'which (one|option|approach|would)', 'choose (one|an?)', 'select (one|an?)',
  'pick one', 'what would you like', 'do you want'
].join('|'), 'i');

const MAX_OPTION_LEN = 40;   // 超过这个长度更像叙述内容而非选项
const MAX_OPTIONS = 8;

/** @returns [{n, label}] —— 空数组表示"这不是选项列表" */
export function extractOptions(text = '') {
  const lines = String(text).split('\n');
  const items = [];
  let firstIdx = -1;
  let lastIdx = -1;

  lines.forEach((line, i) => {
    const m = line.match(/^\s*(\d{1,2})[.)、:：]\s*(.+)$/);
    if (!m) return;
    if (firstIdx === -1) firstIdx = i;
    lastIdx = i;
    items.push({ n: m[1], label: m[2].trim() });
  });

  if (items.length < 2 || items.length > MAX_OPTIONS) return [];
  // 编号必须 1,2,3... 连续(乱序/跳号通常是引用或正文)
  if (items.some((it, i) => Number(it.n) !== i + 1)) return [];
  // 选项应短小;长句是清单/汇报内容
  if (items.some((it) => it.label.length > MAX_OPTION_LEN)) return [];

  // 线索只在清单「前后文」里找,避免选项自身文字碰巧命中
  const preamble = lines.slice(0, firstIdx).join('\n');
  const tail = lines.slice(lastIdx + 1).join('\n');
  const context = `${preamble}\n${tail}`;
  const asksChoice = CHOICE_CUE.test(context) || /[?？]/.test(context);
  if (!asksChoice) return [];

  return items.map((it) => ({ n: it.n, label: it.label.slice(0, 50) }));
}
