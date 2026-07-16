/**
 * LocalExecutor mirrors the SSHManager interface for local conversations.
 * Windows uses native PowerShell so Windows project and attachment paths stay valid.
 * macOS/Linux use the user's login shell with common install paths appended, so
 * codex / claude run with exactly the same environment, config and account as
 * when launched manually from a terminal (行为与 codex CLI/Desktop 一致).
 */
const { spawn } = require('child_process');
const os = require('os');

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
    child.stdin.end();
    return child;
  }

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
