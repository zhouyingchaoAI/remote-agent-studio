/**
 * 目录传输的规划与解析(纯函数,便于单测)。
 *
 * 目录传输不能一把梭:得先把文件清单和总字节数算出来,
 * 否则进度条无从显示,用户面对 21 GB 的传输完全不知道还要多久。
 */
const fs = require('fs');
const path = require('path');
// 注意:不在模块顶层 require SSHManager —— 它要 require 本模块拿 TransferCancelled,
// 顶层互引会形成循环依赖,导出会变成 undefined。用到时再取。

/** 跳过的目录:传了纯属浪费,而且常常巨大 */
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.cache', '.venv', 'venv', 'dist', 'build']);

/**
 * 遍历本地目录,产出待传文件清单(相对路径 + 大小)。
 * @returns {{files:[{rel,abs,size}], dirs:[rel], totalBytes, skipped:[]}}
 */
function walkLocalDir(root, { maxFiles = 20000, skipDirs = SKIP_DIRS } = {}) {
  const files = [];
  const dirs = [];
  const skipped = [];
  let totalBytes = 0;

  const walk = (abs, rel) => {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) { skipped.push(childRel); continue; } // 软链跟着走容易成环
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) { skipped.push(childRel); continue; }
        dirs.push(childRel);
        walk(childAbs, childRel);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = fs.statSync(childAbs).size; } catch (_) { continue; }
        files.push({ rel: childRel, abs: childAbs, size });
        totalBytes += size;
      }
    }
  };
  walk(root, '');
  return { files, dirs, totalBytes, skipped };
}

/**
 * 列出远程目录下的全部文件(相对路径 + 字节数)。
 * 用 find + printf 一次拿全,比逐级 sftp.readdir 快一个数量级。
 */
function buildRemoteWalkCommand(root, { maxFiles = 20000 } = {}) {
  const { shellQuote } = require('./SSHManager');
  const skip = [...SKIP_DIRS].map((d) => `-name ${shellQuote(d)}`).join(' -o ');
  return `cd ${shellQuote(root)} && find . \\( ${skip} \\) -prune -o `
    + `\\( -type f -printf 'F\\t%P\\t%s\\n' -o -type d -printf 'D\\t%P\\n' \\) `
    + `2>/dev/null | head -${maxFiles}`;
}

/** 解析上面的输出 */
function parseRemoteWalk(stdout = '') {
  const files = [];
  const dirs = [];
  let totalBytes = 0;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const [kind, rel, size] = line.split('\t');
    if (!rel) continue;                      // find 会把根目录本身输出成空 %P
    if (kind === 'D') { dirs.push(rel); continue; }
    if (kind === 'F') {
      const n = Number(size) || 0;
      files.push({ rel, size: n });
      totalBytes += n;
    }
  }
  return { files, dirs, totalBytes };
}

/** posix 拼接(远程一律用 /) */
function joinPosix(base, rel) {
  return `${String(base).replace(/\/+$/, '')}/${String(rel).replace(/^\/+/, '')}`;
}

/**
 * 目录传输的整体进度:已完成文件的字节 + 当前文件的进度。
 * 只按文件数算百分比会很跳(一个 10 GB 文件和一个 1 KB 文件各算一份)。
 */
function aggregateProgress({ doneBytes = 0, currentTransferred = 0, totalBytes = 0, doneFiles = 0, totalFiles = 0 }) {
  const transferred = doneBytes + currentTransferred;
  return {
    transferred,
    total: totalBytes,
    doneFiles,
    totalFiles,
    percent: totalBytes > 0 ? Math.min(100, Math.round((transferred / totalBytes) * 100)) : 0
  };
}

/** 取消错误统一识别,便于界面区分"用户取消"与"真失败" */
class TransferCancelled extends Error {
  constructor() { super('传输已取消'); this.name = 'TransferCancelled'; this.cancelled = true; }
}
function isCancelled(err) {
  return !!(err && (err.cancelled || err.name === 'TransferCancelled' || /传输已取消/.test(err.message || '')));
}

module.exports = {
  SKIP_DIRS, walkLocalDir, buildRemoteWalkCommand, parseRemoteWalk,
  joinPosix, aggregateProgress, TransferCancelled, isCancelled
};
