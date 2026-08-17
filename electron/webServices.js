/**
 * 本机后台 Web 服务(目前是 dsh 的配置界面)。
 *
 * dsh 的模型/提供方配置只能在它自己的 Web UI 里做,而那个 UI 默认只监听
 * 127.0.0.1:3080。与其让用户去终端敲命令再切浏览器,不如由应用把进程拉起来,
 * 用内置浏览器直接打开。
 *
 * 只管本机:dsh web 绑的是它所在机器的回环地址,远程主机上的 UI 需要
 * 本地端口转发才能访问,那是另一件事,不在这里假装支持。
 */
const { spawn } = require('child_process');

/** 已启动的服务:id -> {child, port, url, startedAt, log} */
const services = new Map();

const DEFS = {
  dsh: {
    label: 'DeepSeek Harness 配置界面',
    port: 3080,
    // 走 npx 而不是全局 dsh:即使用户没全局装也能拉起来
    command: 'npx',
    args: ['-y', '@deepseek-ai/dsh@latest', 'web'],
    ready: /127\.0\.0\.1:(\d+)|listening|已启动|http:\/\//i
  }
};

function statusOf(id) {
  const s = services.get(id);
  const def = DEFS[id];
  if (!def) return null;
  return {
    id, label: def.label,
    running: !!(s && s.child && !s.child.killed),
    port: s?.port || def.port,
    url: s?.url || `http://127.0.0.1:${def.port}`,
    log: (s?.log || '').slice(-4000)
  };
}

function listStatus() { return Object.keys(DEFS).map(statusOf); }

/**
 * 启动服务。已在运行则直接返回现状,不重复拉起 ——
 * 重复启动会撞端口,报错还很难懂。
 */
function start(id, onLog = () => {}) {
  const def = DEFS[id];
  if (!def) throw new Error(`未知服务: ${id}`);
  const existing = services.get(id);
  if (existing?.child && !existing.child.killed) return statusOf(id);

  const child = spawn(def.command, def.args, {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const entry = { child, port: def.port, url: `http://127.0.0.1:${def.port}`, startedAt: Date.now(), log: '' };
  services.set(id, entry);

  const append = (chunk) => {
    const text = String(chunk);
    entry.log = (entry.log + text).slice(-20000);
    // 端口可能被它改掉(比如 3080 被占),从输出里认出来
    const m = text.match(/127\.0\.0\.1:(\d{2,5})/);
    if (m) { entry.port = Number(m[1]); entry.url = `http://127.0.0.1:${entry.port}`; }
    onLog(text);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  // spawn 失败(命令不存在等)必须接住:不接的话 'error' 会把主进程整个干掉
  child.on('error', (err) => {
    append(`\n[启动失败] ${err.message}\n`);
    services.delete(id);
  });
  child.on('close', (code) => {
    append(`\n[已退出] exit ${code}\n`);
    if (services.get(id)?.child === child) services.delete(id);
  });

  return statusOf(id);
}

function stop(id) {
  const s = services.get(id);
  if (!s?.child) return { ok: true };
  try { s.child.kill('SIGTERM'); } catch (_) {}
  // 给它 3 秒优雅退出,不走就强杀,避免端口一直被占
  const child = s.child;
  setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {} }, 3000);
  services.delete(id);
  return { ok: true };
}

/** 应用退出时收尾,别把后台进程留在系统里 */
function stopAll() { for (const id of [...services.keys()]) stop(id); }

module.exports = { DEFS, start, stop, stopAll, statusOf, listStatus };
