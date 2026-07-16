const path = require('path');

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
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

module.exports = {
  MAX_ATTACHMENT_BYTES,
  IMAGE_EXTENSIONS,
  classifyFile,
  sanitizeFilename,
  uniqueRemoteNames,
  validateFiles,
  extractImagePaths
};
