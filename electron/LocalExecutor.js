/**
 * LocalExecutor mirrors the SSHManager interface for local conversations.
 * Windows uses native PowerShell so Windows project and attachment paths stay valid.
 * macOS/Linux use the user's login shell with common install paths appended, so
 * codex / claude run with exactly the same environment, config and account as
 * when launched manually from a terminal (行为与 codex CLI/Desktop 一致).
 */
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

class LocalExecutor {
  constructor({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
    this.isLocal = true;
    this.platform = platform;
    this.isWindowsNative = platform === 'win32';
    this.baseEnv = env;
    this.homeDir = homeDir;
  }

  /** 登录 shell(macOS 默认 zsh),保证 .zprofile / .bash_profile 中的 PATH 生效 */
  shellInvocation(command) {
    if (this.isWindowsNative) {
      return { bin: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
    }
    const shell = this.baseEnv.SHELL || (this.platform === 'darwin' ? '/bin/zsh' : 'bash');
    return { bin: shell, args: ['-l', '-c', command] };
  }

  /** 在用户 PATH 基础上补齐常见安装位置(homebrew / npm 全局 / codex 独立安装) */
  shellEnv() {
    if (this.isWindowsNative) return { ...this.baseEnv };
    const home = this.homeDir;
    const extra = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${home}/.npm-global/bin`,
      `${home}/.local/bin`,
      `${home}/.codex/bin`
    ];
    const current = (this.baseEnv.PATH || '').split(':').filter(Boolean);
    const merged = [...current, ...extra.filter((p) => !current.includes(p))];
    return { ...this.baseEnv, PATH: merged.join(':'), LANG: this.baseEnv.LANG || 'en_US.UTF-8' };
  }

  /**
   * 解析「用户终端等效环境」:起一个交互式登录 shell(-ilc)执行 env,
   * 拿到 .zshrc/.zprofile 里 export 的全部变量(代理、API keys、PATH 等)。
   * 与 VS Code 的 shell environment resolution 同思路;失败则退回静态 PATH 补齐。
   */
  async resolveTerminalEnv() {
    if (this.isWindowsNative) return this.shellEnv();
    if (this._terminalEnv) return this._terminalEnv;
    if (!this._terminalEnvPromise) {
      const { bin } = this.shellInvocation('');
      const marker = '__RAS_ENV_MARKER__';
      this._terminalEnvPromise = new Promise((resolve) => {
        let out = '';
        let done = false;
        const finish = (env) => { if (!done) { done = true; resolve(env); } };
        let child;
        try {
          child = spawn(bin, ['-ilc', `echo ${marker}; env`], {
            env: { ...this.shellEnv(), DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' }
          });
        } catch (_) { return finish(this.shellEnv()); }
        child.stdin.end();
        const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(this.shellEnv()); }, 8000);
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', () => { clearTimeout(timer); finish(this.shellEnv()); });
        child.on('close', () => {
          clearTimeout(timer);
          const idx = out.lastIndexOf(marker);
          if (idx < 0) return finish(this.shellEnv());
          const env = { ...this.shellEnv() };
          for (const line of out.slice(idx + marker.length).split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) {
              const key = line.slice(0, eq);
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = line.slice(eq + 1);
            }
          }
          // 终端 PATH 与静态补齐取并集,双保险
          const merged = [...new Set([
            ...(env.PATH || '').split(':'),
            ...this.shellEnv().PATH.split(':')
          ].filter(Boolean))];
          env.PATH = merged.join(':');
          finish(env);
        });
      }).then((env) => { this._terminalEnv = env; return env; });
    }
    return this._terminalEnvPromise;
  }

  async _spawn(command) {
    const { bin, args } = this.shellInvocation(command);
    const env = await this.resolveTerminalEnv();
    const child = spawn(bin, args, { env });
    // 兜底监听:未监听的 'error' 事件会抛出并拖垮主进程。
    // 这里只保证不抛,调用方自己的 error 监听照常生效(EventEmitter 允许多个监听者)。
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    child.stdin.end();
    return child;
  }

  /**
   * 本机交互终端的 PTY 方案。
   *
   * 首选自带的 Python PTY 桥:它自己开 pty 对,不要求**我们这端**的 stdin
   * 是终端。系统的 `script` 恰恰有这个隐含要求 —— macOS/BSD 的 script 会对
   * 自己的 stdin 调 tcgetattr,而 GUI 应用 spawn 出来的 stdin 是管道,
   * 于是直接报 "tcgetattr/ioctl: Operation not supported on socket" 退出。
   *
   * 没有 python3 时退回 script:Linux 的 util-linux 版本容忍非 tty 的 stdin,
   * 至少还能用;macOS 上则会给出可操作的提示而不是一句底层报错。
   */
  ptyInvocation(shell, cols, rows) {
    /* python3 是外部进程,读不了 app.asar 这个虚拟文件系统里的路径。
       package.json 把该文件列进 asarUnpack,真实文件落在 app.asar.unpacked 下。 */
    const helper = path.join(__dirname, 'pty-helper.py').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (this.hasPython3() && fs.existsSync(helper)) {
      return {
        bin: this.python3Bin, args: [helper, shell, '-l'],
        env: { PTY_COLS: String(cols), PTY_ROWS: String(rows) },
        mode: 'pty-helper'
      };
    }
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${shell} -l`;
    if (this.platform === 'darwin') {
      return { bin: 'script', args: ['-q', '/dev/null', '/bin/sh', '-c', inner], mode: 'script' };
    }
    return { bin: 'script', args: ['-qfc', inner, '/dev/null'], mode: 'script' };
  }

  /** 找一个能用的 python3(GUI 应用继承不到用户 shell 的 PATH) */
  hasPython3() {
    if (this._python3 !== undefined) return this._python3;
    const candidates = ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
    for (const bin of candidates) {
      try {
        const r = spawnSync(bin, ['-c', 'import pty,select,fcntl,termios'], { timeout: 5000 });
        if (r.status === 0) { this.python3Bin = bin; this._python3 = true; return true; }
      } catch (_) { /* 试下一个 */ }
    }
    this._python3 = false;
    return false;
  }

  /** 打开本机交互 shell(与 SSHManager.openShell 接口一致,供终端页复用) */
  async openShell({ termId = 'default', cols = 80, rows = 24 } = {}) {
    if (!this.shells) this.shells = new Map();
    const existing = this.shells.get(termId);
    if (existing) return existing;
    if (this.isWindowsNative) {
      throw new Error('Windows 本机终端暂不支持,请使用系统自带的 PowerShell/Windows Terminal');
    }

    const env = { ...(await this.resolveTerminalEnv()), TERM: 'xterm-256color' };
    const shell = this.baseEnv.SHELL || (this.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const { bin, args, env: extraEnv, mode } = this.ptyInvocation(shell, cols, rows);
    /* pty-helper 走 fd 3 收尺寸指令:与用户输入分流,
       混在 stdin 里就得设计转义,而任何转义都可能被真实输入撞上 */
    const stdio = mode === 'pty-helper'
      ? ['pipe', 'pipe', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'pipe'];
    const child = spawn(bin, args, { env: { ...env, ...(extraEnv || {}) }, cwd: this.homeDir, stdio });
    child.__ptyMode = mode;
    // 必须监听 error:未监听的 'error' 事件在 Node 里会直接抛出,足以让主进程整个退出
    // (例如系统缺少 script 命令、shell 路径不存在)
    child.on('error', (err) => {
      const hint = mode === 'script' && this.platform === 'darwin'
        ? '\r\n提示:未找到可用的 python3,而 macOS 的 script 需要自身连着终端才能工作。'
          + '\r\n装一个 python3(xcode-select --install)即可启用本机终端。'
        : '';
      try {
        child.stdout.emit('data', Buffer.from(`\r\n[本机终端启动失败] ${err.message}${hint}\r\n`));
      } catch (_) {}
      this.shells.delete(termId);
    });
    // 子进程已退出后再写入会触发 EPIPE,同样是未捕获错误的来源
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    child.stderr?.on('error', () => {});

    // 适配终端页期望的 stream 形态(与 ssh2 的 shell stream 对齐)
    const stream = {
      stderr: child.stderr,
      __child: child,
      on(event, cb) {
        if (event === 'data') child.stdout.on('data', cb);
        else if (event === 'close') child.on('close', (code) => cb(code));
        return this;
      },
      write(data) { try { child.stdin.write(data); } catch (_) {} },
      setWindow(r, c) {
        if (child.__ptyMode === 'pty-helper') {
          // 走控制通道:helper 会 TIOCSWINSZ 并补一个 SIGWINCH,
          // 全屏程序(vim/less)才会真的重排
          try { child.stdio[3]?.write(`${JSON.stringify({ rows: r, cols: c })}\n`); } catch (_) {}
          return;
        }
        // script 不转发 SIGWINCH,只能通过 stty 让子进程知道新尺寸
        try { child.stdin.write(`stty rows ${r} cols ${c} 2>/dev/null\n`); } catch (_) {}
      },
      end() { try { child.stdin.end(); child.kill(); } catch (_) {} },
      close() { try { child.kill(); } catch (_) {} },
      signal(sig) { try { child.kill(sig === 'INT' ? 'SIGINT' : sig); } catch (_) {} }
    };
    child.on('close', () => this.shells.delete(termId));
    this.shells.set(termId, stream);
    return stream;
  }

  closeShell(termId) {
    const s = this.shells?.get(termId);
    if (s) { try { s.end(); } catch (_) {} this.shells.delete(termId); }
  }

  /* 与 SSHManager 同名接口,供 term:write / term:resize 直接复用 */
  writeShell(termId, data) { const s = this.shells?.get(termId); if (s) s.write(data); }
  resizeShell(termId, cols, rows) { const s = this.shells?.get(termId); if (s) s.setWindow(rows, cols, 0, 0); }

  async execStream(command) {
    const child = await this._spawn(command);
    const stream = {
      stderr: child.stderr,
      on(event, cb) {
        if (event === 'data') child.stdout.on('data', cb);
        else if (event === 'close') child.on('close', (code) => cb(code));
        return this;
      },
      write() {},
      signal() { try { child.kill('SIGINT'); } catch (_) {} },
      close() { try { child.kill(); } catch (_) {} }
    };
    return stream;
  }

  async exec(command, opts = {}) {
    const child = await this._spawn(command);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
        opts.onStdout?.(data.toString());
      });
      child.stderr.on('data', (data) => {
        stderr += data;
        opts.onStderr?.(data.toString());
      });
      child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
      child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }

  async detectEnvironment() {
    if (!this.isWindowsNative) return null;
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'
      $node = (& node --version 2>$null | Select-Object -First 1)
      $npm = (& npm.cmd --version 2>$null | Select-Object -First 1)
      $codex = (& codex.cmd --version 2>$null | Select-Object -First 1)
      $claude = (& claude.cmd --version 2>$null | Select-Object -First 1)
      Write-Output "OS=Windows $([System.Environment]::OSVersion.Version)"
      Write-Output "NODE=$node"
      Write-Output "NPM=$npm"
      Write-Output "CODEX=$codex"
      Write-Output "CLAUDE=$claude"
    `;
    const { stdout } = await this.exec(script);
    const get = (key) => (stdout.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim() || '';
    return { os: get('OS'), node: get('NODE'), npm: get('NPM'), codex: get('CODEX'), claude: get('CLAUDE') };
  }

  async installGlobalAgent(pkg, bin, opts = {}) {
    if (!this.isWindowsNative) throw new Error('Native installation is only available on Windows');
    const command = `
      & npm.cmd install -g ${psQuote(pkg)}
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      & ${bin}.cmd --version
    `;
    const result = await this.exec(command, opts);
    if (result.code !== 0) throw new Error(`${pkg} installation failed (exit ${result.code})`);
    return result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  }
}

module.exports = { LocalExecutor, psQuote };
