/**
 * 分路名字的规整(界面侧)。
 *
 * 这个名字会同时变成 **git 分支名**和 **目录名**,还要拼进 shell 命令。
 * 三套约束里最严的那套说了算,所以只放行最安全的一批字符。
 *
 * 注意职责划分:这里是**帮用户把名字整理成可用的形态**,
 * 而主进程那边(worktree.js)有一道**独立的校验** ——
 * 它不信任渲染层送过去的任何东西。两者不是重复:
 * 一个是便利,一个是安全边界,少了哪个都不对。
 */

/** 分路名允许的形态:中英文、数字、- 和 _;不能以符号开头结尾 */
export const SAFE_SLUG_RE = /^[\w一-龥][\w一-龥-]{0,47}$/;

export function slugify(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    // 危险字符在这里就被剥掉,而不是指望后面的引用兜住
    .replace(/[^\w一-龥-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 48);
}

/**
 * 名字有没有问题。
 * 返回的是**可以直接显示给用户的一句话**,不是错误码 ——
 * "非法字符"这种提示等于没说,用户不知道该改哪里。
 */
export function slugProblem(name) {
  const raw = String(name || '').trim();
  if (!raw) return '名字不能为空';
  const s = slugify(raw);
  if (!s) return `「${raw}」里没有可用字符(只支持中英文、数字、- 和 _)`;
  if (/^\d+$/.test(s)) return `「${raw}」不能只有数字,git 分支名会有歧义`;
  if (!SAFE_SLUG_RE.test(s)) return `「${raw}」不能用作分支名`;
  return '';
}
