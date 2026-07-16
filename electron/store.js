/** 主机配置持久化(userData/hosts.json),密码用 safeStorage 加密 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'hosts.json');

function enc(s) {
  if (!s) return '';
  try {
    if (safeStorage.isEncryptionAvailable())
      return 'enc:' + safeStorage.encryptString(s).toString('base64');
  } catch (_) {}
  return 'raw:' + Buffer.from(s).toString('base64');
}

function dec(s) {
  if (!s) return '';
  try {
    if (s.startsWith('enc:'))
      return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('raw:'))
      return Buffer.from(s.slice(4), 'base64').toString();
  } catch (_) {}
  return '';
}

function loadHosts() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data.map((h) => ({ ...h, password: dec(h.password), passphrase: dec(h.passphrase) }));
  } catch (_) { return []; }
}

function saveHosts(hosts) {
  const data = hosts.map((h) => ({ ...h, password: enc(h.password), passphrase: enc(h.passphrase) }));
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

/* -------- 对话历史持久化(userData/conversations/<id>.json,每对话一个文件) --------
 * 相比单一大 JSON:只重写有变化的对话,长历史下不再随消息量线性变慢;
 * 崩溃最多丢一个对话的最近一次写入。旧版 conversations.json 首次加载自动迁移。 */
const convDir = () => path.join(app.getPath('userData'), 'conversations');
const legacyConvFile = () => path.join(app.getPath('userData'), 'conversations.json');
const convSavedAt = new Map(); // convId -> updatedAt(跳过未变化的对话)

function safeConvId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function migrateLegacyConvos() {
  try {
    if (!fs.existsSync(legacyConvFile())) return;
    const list = JSON.parse(fs.readFileSync(legacyConvFile(), 'utf8'));
    fs.mkdirSync(convDir(), { recursive: true });
    for (const c of list) {
      if (c && c.id) fs.writeFileSync(path.join(convDir(), `${safeConvId(c.id)}.json`), JSON.stringify(c));
    }
    fs.renameSync(legacyConvFile(), legacyConvFile() + '.bak');
  } catch (_) {}
}

function loadConvos() {
  migrateLegacyConvos();
  try {
    return fs.readdirSync(convDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(convDir(), f), 'utf8')); }
        catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) { return []; }
}

function saveConvos(convos) {
  fs.mkdirSync(convDir(), { recursive: true });
  const alive = new Set();
  for (const c of convos) {
    if (!c || !c.id) continue;
    const fid = safeConvId(c.id);
    alive.add(`${fid}.json`);
    if (convSavedAt.get(c.id) === c.updatedAt) continue; // 未变化,跳过
    const file = path.join(convDir(), `${fid}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, file); // 原子替换,避免写一半崩溃损坏
    convSavedAt.set(c.id, c.updatedAt);
  }
  // 清理已删除的对话文件
  try {
    for (const f of fs.readdirSync(convDir())) {
      if (f.endsWith('.json') && !alive.has(f)) fs.rmSync(path.join(convDir(), f), { force: true });
    }
  } catch (_) {}
}

/* -------- 开发任务持久化(userData/tasks/<id>.json) -------- */
const taskDir = () => path.join(app.getPath('userData'), 'tasks');

function safeTaskId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function loadTasks() {
  try {
    return fs.readdirSync(taskDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const task = JSON.parse(fs.readFileSync(path.join(taskDir(), name), 'utf8'));
          return task && task.id && task.hostId && task.convId ? task : null;
        } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) { return []; }
}

function saveTasks(tasks) {
  fs.mkdirSync(taskDir(), { recursive: true });
  const alive = new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || !task.id || !task.hostId || !task.convId) continue;
    const name = `${safeTaskId(task.id)}.json`;
    alive.add(name);
    const file = path.join(taskDir(), `${safeTaskId(task.id)}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(task));
    fs.renameSync(tmp, file);
  }
  try {
    for (const name of fs.readdirSync(taskDir())) {
      if (name.endsWith('.json') && !alive.has(name)) fs.rmSync(path.join(taskDir(), name), { force: true });
    }
  } catch (_) {}
}

/* -------- 已知主机指纹(userData/knownhosts.json,TOFU) -------- */
const knownHostsFile = () => path.join(app.getPath('userData'), 'knownhosts.json');

function loadKnownHosts() {
  try { return JSON.parse(fs.readFileSync(knownHostsFile(), 'utf8')); }
  catch (_) { return {}; }
}

function saveKnownHost(hostKey, fingerprint) {
  const all = loadKnownHosts();
  all[hostKey] = { fingerprint, updatedAt: Date.now() };
  fs.mkdirSync(path.dirname(knownHostsFile()), { recursive: true });
  fs.writeFileSync(knownHostsFile(), JSON.stringify(all, null, 2));
}

/* -------- 代理配置持久化(userData/proxies.json) -------- */
const proxyFile = () => path.join(app.getPath('userData'), 'proxies.json');

function loadProxies() {
  try { return JSON.parse(fs.readFileSync(proxyFile(), 'utf8')); }
  catch (_) { return {}; }
}
function saveProxy(hostId, cfg) {
  const all = loadProxies();
  if (cfg) all[hostId] = cfg; else delete all[hostId];
  fs.mkdirSync(path.dirname(proxyFile()), { recursive: true });
  fs.writeFileSync(proxyFile(), JSON.stringify(all, null, 2));
}

/* -------- 应用设置持久化(userData/settings.json) -------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = { language: 'zh-CN', theme: 'dark', terminalFontSize: 13, defaultPermissionMode: 'workspace', autoConfirmCap: 5 };

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch (_) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(settings) {
  const merged = { ...loadSettings(), ...settings };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  loadHosts, saveHosts, loadConvos, saveConvos, loadProxies, saveProxy,
  loadKnownHosts, saveKnownHost, loadSettings, saveSettings, loadTasks, saveTasks
};
