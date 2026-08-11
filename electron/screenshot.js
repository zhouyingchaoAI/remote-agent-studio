/**
 * 区域截图:优先调系统原生区域截图工具落盘;拿不到文件时回退到"触发系统截图 → 读剪贴板"。
 * 由全局快捷键或界面按钮触发,结果作为附件加入对话。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

/**
 * 各平台的区域截图候选命令(纯函数,便于单测)。
 * 返回按优先级排列的 { bin, args(outPath) } 列表;bin 存在即用。
 */
function screenshotCommands(platform, outPath) {
  if (platform === 'darwin') {
    // -i 交互式区域选择,-x 静音
    return [{ bin: 'screencapture', args: ['-i', '-x', outPath] }];
  }
  if (platform === 'linux') {
    return [
      { bin: 'gnome-screenshot', args: ['-a', '-f', outPath] },
      { bin: 'spectacle', args: ['-rbn', '-o', outPath] },
      { bin: 'maim', args: ['-s', outPath] },
      { bin: 'scrot', args: ['-s', outPath] },
      { bin: 'import', args: [outPath] } // imagemagick
    ];
  }
  return []; // win32 走剪贴板兜底
}

function which(bin) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [bin], { timeout: 4000 }, (err, stdout) => resolve(!err && !!String(stdout).trim()));
  });
}

function runCapture(bin, args) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function screenshotDir(app) {
  const dir = path.join(app.getPath('userData'), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  // 清理 7 天前旧图
  try {
    const cutoff = Date.now() - 7 * 86400 * 1000;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.rmSync(fp, { force: true });
    }
  } catch (_) {}
  return dir;
}

function outFile(dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, `region-${stamp}.png`);
}

/**
 * 触发区域截图,返回 { path, name, size } 或 null(用户取消)。
 * @param app electron app
 * @param clipboard electron clipboard(剪贴板兜底用)
 */
async function captureRegion(app, clipboard) {
  const dir = screenshotDir(app);
  const out = outFile(dir);
  const cmds = screenshotCommands(process.platform, out);

  for (const { bin, args } of cmds) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await which(bin))) continue;
    // eslint-disable-next-line no-await-in-loop
    const ok = await runCapture(bin, args);
    if (ok && fs.existsSync(out) && fs.statSync(out).size > 0)
      return { path: out, name: path.basename(out), size: fs.statSync(out).size };
    // 命令存在但没出图(用户取消选择)→ 视为取消
    if (cmds.length === 1) return null;
  }

  // 兜底:Windows/无原生工具时,触发系统截图工具后轮询剪贴板
  return captureViaClipboard(app, clipboard, out);
}

/** 触发系统截图工具,轮询剪贴板取新图并落盘 */
async function captureViaClipboard(app, clipboard, out) {
  if (!clipboard) return null;
  const before = clipboard.readImage();
  const beforeSig = before && !before.isEmpty() ? before.toPNG().length : 0;

  if (process.platform === 'win32') {
    // Win10+ 截图工具(选择区域后自动进剪贴板)
    // 同样要监听 error:未监听时启动失败会抛出并拖垮主进程
    spawn('cmd', ['/c', 'start', 'ms-screenclip:'], { stdio: 'ignore', shell: false })
      .on('error', () => {});
  }

  const deadline = Date.now() + 30000;
  // 轮询剪贴板,出现新图即保存
  // eslint-disable-next-line no-constant-condition
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) {
      const buf = img.toPNG();
      if (buf.length && buf.length !== beforeSig) {
        fs.writeFileSync(out, buf);
        return { path: out, name: path.basename(out), size: buf.length };
      }
    }
  }
  return null;
}

module.exports = { screenshotCommands, captureRegion };
