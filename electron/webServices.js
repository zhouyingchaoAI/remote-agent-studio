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
    /* 装了全局 dsh 就直接用它 —— npx -y @latest 每次都要联网解析并下载,
     * 首次动辄几十秒,用户只会看到一个白屏。装了就没必要走这条慢路。 */
    command: 'dsh',
    args: ['web'],
    fallback: { command: 'npx', args: ['-y', '@deepseek-ai/dsh@latest', 'web'] }
  }
};

/** npm 全局 bin 常见位置:GUI 启动的应用继承不到用户 shell 的 PATH */
const EXTRA_PATH = [
  `${process.env.HOME || ''}/.npm-global/bin`,
  `${process.env.HOME || ''}/.local/bin`,
  '/opt/homebrew/bin', '/usr/local/bin'
].filter(Boolean).join(':');

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

  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: '1',
    PATH: `${process.env.PATH || ''}:${EXTRA_PATH}`
  };
  const child = spawn(def.command, def.args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

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

  /* spawn 失败必须接住:不接的话 'error' 会把主进程整个干掉。
   * 命令不存在(没装全局 dsh)时自动退到 npx —— 不退的话用户只看到
   * 一句 ENOENT,完全不知道该怎么办。 */
  child.on('error', (err) => {
    if (err.code === 'ENOENT' && def.fallback && !entry.usedFallback) {
      append(`\n[未找到 ${def.command},改用 ${def.fallback.command}(首次需要联网下载,可能要几十秒)]\n`);
      services.delete(id);
      const fb = { ...def, ...def.fallback, fallback: null };
      DEFS[`${id}__fb`] = fb;
      const s = start(`${id}__fb`, onLog);
      // 用回退方式起的进程仍登记在原 id 下,界面不必知道这个细节
      const started = services.get(`${id}__fb`);
      if (started) { started.usedFallback = true; services.set(id, started); services.delete(`${id}__fb`); }
      return void s;
    }
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

/**
 * 等端口真的能连上再返回。
 *
 * 固定 sleep 是猜的:dsh 首次可能要下载依赖、编译前端产物,几十秒都正常,
 * 而端口起来后又不该白等。所以轮询实际连通性,并把等待过程回报给界面 ——
 * 否则用户看到的就是一个白屏加 ERR_CONNECTION_REFUSED。
 */
async function waitReady(id, { timeoutMs = 90000, intervalMs = 800, onTick = () => {} } = {}) {
  const net = require('net');
  const deadline = Date.now() + timeoutMs;
  const probe = (port) => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.setTimeout(1500, () => { sock.destroy(); resolve(false); });
  });

  while (Date.now() < deadline) {
    const s = services.get(id);
    // 进程已经退出就别再等了,直接把日志给用户看
    if (!s || !s.child || s.child.killed) {
      return { ready: false, reason: 'exited', log: (s?.log || '').slice(-2000) };
    }
    // eslint-disable-next-line no-await-in-loop
    if (await probe(s.port)) return { ready: true, url: s.url, port: s.port };
    onTick(Math.round((Date.now() - (deadline - timeoutMs)) / 1000));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    ready: false, reason: 'timeout',
    log: (services.get(id)?.log || '').slice(-2000)
  };
}

module.exports = { DEFS, start, stop, stopAll, statusOf, listStatus, waitReady };
