/**
 * 把「粘贴进来的东西」归一化成一个目录路径。
 *
 * 用户可能从终端复制(带引号或转义空格)、从 Finder 复制(file:// URL)、
 * 或复制了一个文件而不是目录。这些都该能用,而不是让人手动改。
 */
export function normalizePastedPath(raw = '', { isFile = false } = {}) {
  let p = String(raw || '').trim();
  if (!p) return '';
  // 多行时只取第一行 —— 复制多个文件时会是多行
  p = p.split(/\r?\n/)[0].trim();
  // file:///Users/x → /Users/x(含中文等百分号编码)
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch (_) { /* 编码坏了就用原样 */ }
  }
  // 终端里 ⌘C 常带成对引号
  p = p.replace(/^(['"])(.*)\1$/, '$2');
  // 终端拖入会把空格转义成 "\ "
  p = p.replace(/\\ /g, ' ');
  // 末尾斜杠去掉(根目录除外)
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // 粘的是文件就退到它所在目录 —— 用户想选的几乎总是目录
  if (isFile && p.includes('/')) p = p.replace(/\/[^/]+$/, '') || '/';
  return p;
}

/** 看起来像绝对路径或 ~ 开头,才值得当路径处理 */
export function looksLikePath(p = '') {
  return /^([~/]|[A-Za-z]:[\\/])/.test(String(p).trim());
}
