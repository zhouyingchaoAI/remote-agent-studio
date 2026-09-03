/**
 * 路径缩短显示。
 *
 * 顶栏那一行要塞下引擎、账号、标题、目录、模型、推理强度一堆东西,
 * 而目录动辄 `/Users/zhouyingchao/Documents/ChatGPT/承希经营管理台账助手`,
 * 一条就把后面的控件挤扁。
 *
 * 两条取舍:
 *
 * · **保尾不保头。** 路径的信息量在末尾(项目叫什么),
 *   开头那截 `/Users/<用户名>/` 每条路径都一样,等于噪音。
 *   用 CSS 的 text-overflow 只能砍尾巴,恰好砍掉唯一有用的部分。
 *
 * · **按显示宽度算,不按字符数。** 一个汉字占两个西文字符的位置,
 *   按 length 截的话,中文目录会比英文目录宽出快一倍 ——
 *   而这个界面里的目录名大多是中文。
 */

/** 家目录的几种常见形态。命中就折成 `~`,省下一整段没有信息量的前缀。 */
const HOME_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/;

/** 目测宽度:CJK / 全角算 2,其余算 1 */
export function displayWidth(text) {
  let w = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (
      c <= 0x115f ||
      (c >= 0x2e80 && c <= 0xa4cf) ||     // 部首、假名、CJK
      (c >= 0xac00 && c <= 0xd7a3) ||     // 谚文
      (c >= 0xf900 && c <= 0xfaff) ||     // CJK 兼容
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||     // 全角
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)      // 扩展区
    )) ? 2 : 1;
  }
  return w;
}

/**
 * @param full   完整路径
 * @param maxW   允许的显示宽度(西文字符数;一个汉字算 2)
 * @returns      缩短后的路径,原样可读
 */
export function shortenPath(full, maxW = 34) {
  const s = String(full || '').trim();
  if (!s) return '~';
  // 家目录折成 ~ —— 这一段每条路径都一样,留着纯属占地方
  const home = s.replace(HOME_RE, '~');
  if (displayWidth(home) <= maxW) return home;

  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/';
  const parts = home.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return home;   // 单段路径没法省中间,交给 CSS 去截

  const head = home.startsWith('~') ? '~' : (home.startsWith('/') ? '' : parts[0]);
  const last = parts[parts.length - 1];

  /* 从末尾开始往前收,能塞几段塞几段 —— 末尾是项目名,越靠后越重要。
     至少保住最后一段,哪怕它自己就超宽(那种情况交给 CSS 截,
     总比显示一个 `…` 什么都看不出来强)。 */
  const tail = [last];
  for (let i = parts.length - 2; i >= 1; i -= 1) {
    const candidate = [parts[i], ...tail];
    const text = `${head}${sep}…${sep}${candidate.join(sep)}`;
    if (displayWidth(text) > maxW) break;
    tail.unshift(parts[i]);
  }
  return `${head}${sep}…${sep}${tail.join(sep)}`;
}
