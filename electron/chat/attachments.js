const path = require('path');

// 20MB 对工程文档(扫描报告、图纸、大表格)太小了;
// 走 SFTP 上传本身没有这个量级的限制,放宽到 200MB 更贴合实际使用
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function classifyFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(String(name)).toLowerCase()) ? 'image' : 'file';
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || '')).replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return base.replace(/^\.+/, '') || 'attachment';
}

function uniqueRemoteNames(files) {
  const used = new Set();
  return files.map((file) => {
    const clean = sanitizeFilename(file.name);
    const ext = path.extname(clean);
    const stem = clean.slice(0, clean.length - ext.length);
    let candidate = clean;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase())) {
      candidate = `${stem}-${suffix}${ext}`;
      suffix += 1;
    }
    used.add(candidate.toLocaleLowerCase());
    return candidate;
  });
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择附件');
  for (const file of files) {
    if (!file?.path || !file?.name || !Number.isFinite(file?.size)) {
      throw new Error('附件信息不完整');
    }
    if (file.size < 0 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${file.name} 超过 20 MB`);
    }
  }
  return files;
}

function extractImagePaths(value) {
  const found = [];
  const seen = new Set();
  const add = (candidate) => {
    let clean = candidate.trim();
    if (/^[A-Za-z]:/.test(clean)) clean = clean.replace(/\\{2,}/g, '\\');
    if (!clean || clean.startsWith('//') || /^https?:/i.test(clean)) return;
    if (classifyFile(clean) !== 'image') return;
    const key = clean.replace(/\\/g, '/');
    if (!seen.has(key)) {
      seen.add(key);
      found.push(clean);
    }
  };
  const visit = (item) => {
    if (typeof item === 'string') {
      const localText = item.replace(/https?:\/\/\S+/gi, '');
      for (const match of localText.matchAll(/\/(?!\/)[^"'`\r\n]*?\.(?:png|jpe?g|webp|gif)/gi)) add(match[0]);
      for (const match of localText.matchAll(/[A-Za-z]:\\[^"'`\r\n]*?\.(?:png|jpe?g|webp|gif)/gi)) add(match[0]);
      return;
    }
    if (Array.isArray(item)) return item.forEach(visit);
    if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return found;
}

/**
 * 危险命令识别:用于 UI 高亮与全自动模式的强制刹车。
 * 命中的是"不可逆/影响面大"的操作,不是所有写操作。
 */
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-[a-z]*\s+)*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i, // rm -rf / -fr
  /\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME)/i,                  // rm -r 根/家目录
  /\bmkfs\b|\bdd\s+if=|\bshred\b/i,                          // 磁盘擦写
  /:\(\)\s*\{.*\};:/,                                         // fork 炸弹
  /\b(shutdown|reboot|halt|poweroff)\b/i,                    // 关机重启
  />\s*\/dev\/sd[a-z]/i,                                      // 写裸盘
  /\bchmod\s+-R\s+777\b|\bchown\s+-R\b/i,                    // 递归改权限/属主
  /\bgit\s+push\s+.*(--force|-f)\b|\bgit\s+reset\s+--hard\b/i, // 强推/硬重置
  /\bkubectl\s+delete\b|\bdocker\s+system\s+prune\b/i,       // 集群/容器批量删除
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash)\b/i,                // 管道执行远程脚本
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i        // 破坏性 SQL
];

function isDangerousCommand(command) {
  const c = String(command || '');
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(c));
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  formatMB,
  IMAGE_EXTENSIONS,
  classifyFile,
  sanitizeFilename,
  uniqueRemoteNames,
  validateFiles,
  extractImagePaths,
  isDangerousCommand,
  DANGEROUS_COMMAND_PATTERNS
};
