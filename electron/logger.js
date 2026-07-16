/** 主进程日志:userData/logs/main-YYYY-MM-DD.log,兜底捕获未处理异常 */
const fs = require('fs');
const path = require('path');

let logDir = null;

function logFile() {
  const d = new Date();
  const name = `main-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(logDir, name);
}

function write(level, ...args) {
  if (!logDir) return;
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map((a) =>
      a instanceof Error ? (a.stack || a.message) : (typeof a === 'string' ? a : JSON.stringify(a))
    ).join(' ')}\n`;
    fs.appendFileSync(logFile(), line);
  } catch (_) {}
}

/** 初始化:传入 app.getPath('userData'),并挂载全局异常兜底 */
function initLogger(userDataDir) {
  logDir = path.join(userDataDir, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  process.on('uncaughtException', (err) => {
    write('FATAL', 'uncaughtException', err);
    console.error('[uncaughtException]', err);
  });
  process.on('unhandledRejection', (reason) => {
    write('ERROR', 'unhandledRejection', reason instanceof Error ? reason : String(reason));
    console.error('[unhandledRejection]', reason);
  });
  // 清理 14 天前的日志
  try {
    const cutoff = Date.now() - 14 * 86400 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      const p = path.join(logDir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch (_) {}
  write('INFO', 'logger initialized');
}

module.exports = { initLogger, logInfo: (...a) => write('INFO', ...a), logError: (...a) => write('ERROR', ...a) };
