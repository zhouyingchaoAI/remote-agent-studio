/**
 * Obsidian 集成:双通道写入。
 *  - 直写 vault 目录:零依赖(vault 本来就是一堆 .md),本机首选
 *  - Local REST API:装了 obsidian-local-rest-api 插件时可用,远程 codex 也能写
 *
 * 写入一律限制在 vault 内的目标子目录里,防止路径穿越写到别处。
 */
const fs = require('fs');
const path = require('path');
const { sanitizeNoteName, mergeMoc, mergeNoteContent, renderNote } = require('./obsidianNotes');

let _app = null;
let _safeStorage = null;
function init(app, safeStorage) { _app = app; _safeStorage = safeStorage; }
function cfgPath() { return path.join(_app.getPath('userData'), 'obsidian.json'); }

const DEFAULTS = {
  vaultPath: '',
  folder: 'RemoteAgentStudio',          // vault 内的落地目录
  restBaseUrl: 'http://127.0.0.1:27123', // local-rest-api 默认 http 端口
  transport: 'file'                      // file | rest
};

function _readRaw() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}
function _decryptKey(raw) {
  if (!raw?.keyEnc) return '';
  try {
    if (_safeStorage && _safeStorage.isEncryptionAvailable())
      return _safeStorage.decryptString(Buffer.from(raw.keyEnc, 'base64'));
    return Buffer.from(raw.keyEnc, 'base64').toString('utf8');
  } catch (_) { return ''; }
}

function getConfig() {
  const raw = _readRaw();
  return {
    vaultPath: raw.vaultPath, folder: raw.folder,
    restBaseUrl: raw.restBaseUrl, transport: raw.transport, hasKey: !!raw.keyEnc
  };
}

function setConfig({ vaultPath, folder, restBaseUrl, transport, apiKey } = {}) {
  const raw = _readRaw();
  const next = {
    vaultPath: vaultPath != null ? String(vaultPath).trim() : raw.vaultPath,
    folder: folder != null ? sanitizeRelFolder(folder) : raw.folder,
    restBaseUrl: restBaseUrl != null ? String(restBaseUrl).trim().replace(/\/+$/, '') : raw.restBaseUrl,
    transport: transport != null ? (transport === 'rest' ? 'rest' : 'file') : raw.transport,
    keyEnc: raw.keyEnc || ''
  };
  if (apiKey === null) next.keyEnc = '';
  else if (typeof apiKey === 'string' && apiKey.trim()) {
    const buf = (_safeStorage && _safeStorage.isEncryptionAvailable())
      ? _safeStorage.encryptString(apiKey.trim())
      : Buffer.from(apiKey.trim(), 'utf8');
    next.keyEnc = buf.toString('base64');
  }
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return getConfig();
}

/** 相对目录净化:多级允许,但不许穿越到 vault 外 */
function sanitizeRelFolder(input) {
  return String(input || '')
    .split(/[\\/]+/)
    .map((seg) => sanitizeNoteName(seg))
    .filter((seg) => seg && seg !== '未命名笔记')
    .join('/') || DEFAULTS.folder;
}

/** 目标文件在 vault 内的相对路径 */
function notePath(folder, title) {
  return `${sanitizeRelFolder(folder)}/${sanitizeNoteName(title)}.md`;
}

/** 校验解析后的绝对路径确实在 vault 内(纵深防御) */
function assertInsideVault(vaultPath, absPath) {
  const root = path.resolve(vaultPath);
  const target = path.resolve(absPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('拒绝写入 vault 之外的路径');
  }
  return target;
}

/* ---------------- 通道一:直写 vault 目录 ---------------- */

function writeFileNote({ vaultPath, relPath, content, mode = 'overwrite' }) {
  if (!vaultPath) throw new Error('未配置 Obsidian vault 路径');
  const abs = assertInsideVault(vaultPath, path.join(vaultPath, relPath));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (mode === 'skipExisting' && fs.existsSync(abs)) return { path: relPath, skipped: true };
  fs.writeFileSync(abs, content, 'utf8');
  return { path: relPath, skipped: false };
}

function readFileNote({ vaultPath, relPath }) {
  try {
    const abs = assertInsideVault(vaultPath, path.join(vaultPath, relPath));
    return fs.readFileSync(abs, 'utf8');
  } catch (_) { return ''; }
}

/* ---------------- 通道二:Local REST API ---------------- */

async function restRequest(relPath, { method = 'GET', body } = {}) {
  const raw = _readRaw();
  const key = _decryptKey(raw);
  if (!raw.restBaseUrl) throw new Error('未配置 Obsidian REST 地址');
  if (!key) throw new Error('未配置 Obsidian REST API Key');
  const url = `${raw.restBaseUrl}/vault/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/markdown' },
      body, signal: controller.signal
    });
  } catch (e) {
    throw new Error(e?.name === 'AbortError'
      ? `Obsidian REST 请求超时:${url}`
      : `连不上 Obsidian REST(${raw.restBaseUrl}):${e?.message || e}。确认已装并启用 local-rest-api 插件。`);
  } finally { clearTimeout(timer); }
  if (method === 'GET' && res.status === 404) return '';
  if (!res.ok) throw new Error(`Obsidian REST 返回 HTTP ${res.status}`);
  return method === 'GET' ? res.text() : '';
}

/* ---------------- 统一写入入口 ---------------- */

/** 读一篇已存在的笔记(MOC 合并需要) */
async function readNote(relPath) {
  const raw = _readRaw();
  if (raw.transport === 'rest') return restRequest(relPath, { method: 'GET' }).catch(() => '');
  return readFileNote({ vaultPath: raw.vaultPath, relPath });
}

async function writeNote(relPath, content, { mode = 'overwrite' } = {}) {
  const raw = _readRaw();
  if (raw.transport === 'rest') {
    if (mode === 'skipExisting') {
      const existing = await restRequest(relPath, { method: 'GET' }).catch(() => '');
      if (existing) return { path: relPath, skipped: true };
    }
    await restRequest(relPath, { method: 'PUT', body: content });
    return { path: relPath, skipped: false };
  }
  return writeFileNote({ vaultPath: raw.vaultPath, relPath, content, mode });
}

/**
 * 批量写入原子笔记 + 更新 MOC。
 * @param notes 已归一化的笔记数组(含 renderNote 渲染后的 content)
 */
async function saveNotes({ notes = [], mocName = '知识索引', mode = 'overwrite' } = {}) {
  const raw = _readRaw();
  const folder = sanitizeRelFolder(raw.folder);
  const written = [];
  for (const n of notes) {
    const rel = notePath(folder, n.title);
    // eslint-disable-next-line no-await-in-loop
    const r = await writeNote(rel, n.content, { mode });
    written.push({ title: n.title, ...r });
  }
  // MOC 增量合并(保留用户手写内容)
  const mocRel = notePath(folder, mocName);
  const existing = await readNote(mocRel);
  const moc = mergeMoc(existing, notes.map((n) => ({ title: n.title, summary: n.summary })), { title: mocName });
  await writeNote(mocRel, moc);
  return { written, moc: mocRel, folder, transport: raw.transport };
}

/** 列出落地目录里已有的笔记标题(喂给模型以复用标题、建立双链) */
function listExistingTitles() {
  const raw = _readRaw();
  if (raw.transport !== 'file' || !raw.vaultPath) return [];
  try {
    const dir = path.join(raw.vaultPath, sanitizeRelFolder(raw.folder));
    if (!fs.existsSync(dir)) return [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.md') ? [e.name.replace(/\.md$/, '')] : [])
    ));
    return walk(dir);
  } catch (_) { return []; }
}

/**
 * 合并式写入:已有笔记追加「补充」块,不覆盖(持续沉淀必须如此)。
 * @param notes 归一化后的笔记(不需要预渲染 content)
 */
async function saveNotesMerging({ notes = [], mocName = '知识索引', date, source = 'Remote Agent Studio' } = {}) {
  const raw = _readRaw();
  const folder = sanitizeRelFolder(raw.folder);
  const day = date || new Date().toISOString().slice(0, 10);
  const written = [];
  for (const n of notes) {
    const rel = notePath(folder, n.title);
    // eslint-disable-next-line no-await-in-loop
    const existing = await readNote(rel);
    const content = existing
      ? mergeNoteContent(existing, n, day)
      : renderNote({ ...n, source, created: day });
    // eslint-disable-next-line no-await-in-loop
    await writeNote(rel, content);
    written.push({ title: n.title, merged: !!existing });
  }
  const mocRel = notePath(folder, mocName);
  const existingMoc = await readNote(mocRel);
  const moc = mergeMoc(existingMoc, notes.map((n) => ({ title: n.title, summary: n.summary })), { title: mocName });
  await writeNote(mocRel, moc);
  return { written, moc: mocRel, folder, created: written.filter((w) => !w.merged).length, merged: written.filter((w) => w.merged).length };
}

/** 连通性/可写性自检 */
async function test() {
  const raw = _readRaw();
  if (raw.transport === 'rest') {
    try {
      await restRequest(notePath(raw.folder, '连通性测试'), { method: 'GET' });
      return { ok: true, transport: 'rest', detail: 'REST 可访问' };
    } catch (e) { return { ok: false, transport: 'rest', detail: e.message }; }
  }
  if (!raw.vaultPath) return { ok: false, transport: 'file', detail: '未选择 vault 目录' };
  try {
    if (!fs.existsSync(raw.vaultPath)) return { ok: false, transport: 'file', detail: 'vault 目录不存在' };
    // Obsidian vault 一般有 .obsidian 目录;没有也允许,只提示
    const looksLikeVault = fs.existsSync(path.join(raw.vaultPath, '.obsidian'));
    const probe = path.join(raw.vaultPath, sanitizeRelFolder(raw.folder), '.ras-write-test');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return {
      ok: true, transport: 'file',
      detail: looksLikeVault ? '目录可写,已识别为 Obsidian vault' : '目录可写(未发现 .obsidian,请确认这是 vault 根目录)'
    };
  } catch (e) { return { ok: false, transport: 'file', detail: e.message }; }
}

module.exports = {
  init, getConfig, setConfig, saveNotes, saveNotesMerging, listExistingTitles,
  writeNote, readNote, test,
  notePath, sanitizeRelFolder, assertInsideVault
};
