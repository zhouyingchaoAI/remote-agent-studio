/**
 * Installer - 远程环境检测与 codex / claude code / dsh 自动安装
 */
const { dshInstallCommand } = require('./dsh');

const { BIN_PATH: SHARED_BIN_PATH, AGENT_ENV } = require('./agentEnv');

class Installer {
  constructor(ssh, proxyService) {
    this.ssh = ssh;
    this.proxy = proxyService;
  }

  _env() { return this.proxy ? this.proxy.envPrefix() : ''; }

  /** PATH 前缀:各安装位置的统一顺序(校验与清理都要用同一套,否则查的不是实际执行的那个) */
  static get BIN_PATH() { return SHARED_BIN_PATH; }

  /** 探测远程架构,用于选包与给出准确的错误提示 */
  async remoteArch() {
    try {
      const r = await this.ssh.exec('uname -m');
      const machine = String(r.stdout || '').trim();
      const family = /^(x86_64|amd64)$/.test(machine) ? 'x86_64'
        : /^(aarch64|arm64)$/.test(machine) ? 'aarch64' : machine;
      return { machine, family, supported: family === 'x86_64' || family === 'aarch64' };
    } catch (_) { return { machine: '未知', family: '', supported: false }; }
  }

  /**
   * 安装后校验:二进制是否真能执行。
   * 架构不符时系统只会给 "Exec format error" 这种晦涩信息,这里翻译成人话。
   */
  async verifyBinary(bin) {
    const r = await this.ssh.exec(`${Installer.BIN_PATH} ${bin} --version 2>&1`);
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    // 退出码为 0 即视为可执行(有些命令不打印版本号,不能因为输出为空就判失败)
    if (r.code === 0) return { ok: true, version: out.split('\n')[0] || '' };
    if (/exec format error|cannot execute binary file/i.test(out)) {
      const { machine } = await this.remoteArch();
      return {
        ok: false, archMismatch: true,
        message: `安装的 ${bin} 与主机架构(${machine})不匹配,需要该架构的版本`
      };
    }
    return { ok: false, message: out.slice(0, 200) || `退出码 ${r.code}` };
  }

  /**
   * 清理 PATH 上无法执行的同名二进制。
   * 架构不符的残留软链会挡住后续正确安装的版本,
   * 表现成「显示安装成功,一运行就报错」这种最难排查的情况。
   */
  async cleanupBrokenBinary(name, log = () => {}) {
    const dirs = ['$HOME/.local/bin', '$HOME/.npm-global/bin'];
    const script = dirs.map((d) =>
      `if [ -e "${d}/${name}" ] && ! "${d}/${name}" --version >/dev/null 2>&1; then `
      + `rm -f "${d}/${name}"; echo "已清理无法执行的 ${d}/${name}"; fi`
    ).join('; ');
    const r = await this.ssh.exec(script).catch(() => null);
    if (r?.stdout?.trim()) log(`${r.stdout.trim()}\n`);
  }

  /** 检测远程环境: node/npm/codex/claude 版本、系统信息 */
  async detect() {
    if (this.ssh.isWindowsNative) return this.ssh.detectEnvironment();
    /* **必须和实际执行用同一份环境前缀。**
       以前这里是 `PATH="$PATH:...家目录"`(追加),而执行时是
       `PATH="家目录:...:$PATH"`(前置)。系统里另有一个 codex 时,
       两边解析到的是**不同的二进制** —— 界面显示「可用」、实际却跑不起来,
       而且从界面上完全看不出矛盾。 */
    const script = `
      echo "OS=$(uname -sm)";
      ${AGENT_ENV}
      command -v node >/dev/null 2>&1 && echo "NODE=$(node -v)" || echo "NODE=";
      command -v npm  >/dev/null 2>&1 && echo "NPM=$(npm -v)"  || echo "NPM=";
      command -v codex  >/dev/null 2>&1 && echo "CODEX=$(codex --version 2>/dev/null | head -1)"  || echo "CODEX=";
      command -v claude >/dev/null 2>&1 && echo "CLAUDE=$(claude --version 2>/dev/null | head -1)" || echo "CLAUDE=";
      command -v dsh    >/dev/null 2>&1 && echo "DSH=$(dsh --version 2>/dev/null | head -1)"     || echo "DSH=";
      # 把解析到的路径也报上来:光说"可用"没法判断用的是哪一个,
      # 而"装了好几份 codex"恰恰是这类问题最常见的成因。
      echo "CODEX_BIN=$(command -v codex 2>/dev/null)";
      echo "CLAUDE_BIN=$(command -v claude 2>/dev/null)";
    `;
    const { stdout } = await this.ssh.exec(script);
    const get = (k) => (stdout.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
    return {
      os: get('OS'),
      node: get('NODE'),
      npm: get('NPM'),
      codex: get('CODEX'),
      claude: get('CLAUDE'),
      dsh: get('DSH'),
      codexBin: get('CODEX_BIN'),
      claudeBin: get('CLAUDE_BIN')
    };
  }

  /** 确保 node 存在,缺失时通过 nvm 安装(免 root) */
  async ensureNode(log) {
    const d = await this.detect();
    if (d.node && d.npm) { log(`Node 已存在 ${d.node} (npm ${d.npm})\n`); return; }
    if (this.ssh.isWindowsNative) {
      throw new Error('本机未检测到 Node.js/npm，请先安装 Windows Node.js LTS');
    }
    log('未检测到 Node.js,通过 nvm 安装 LTS(免 root)...\n');
    const cmd = `${this._env()} export NVM_DIR="$HOME/.nvm";
      [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash;
      if [ -f "$HOME/.npmrc" ] && grep -Eq '^[[:space:]]*(prefix|globalconfig)[[:space:]]*=' "$HOME/.npmrc"; then
        cp -n "$HOME/.npmrc" "$HOME/.npmrc.remote-agent-backup" 2>/dev/null || true;
        grep -Ev '^[[:space:]]*(prefix|globalconfig)[[:space:]]*=' "$HOME/.npmrc" > "$HOME/.npmrc.remote-agent-tmp" || true;
        mv "$HOME/.npmrc.remote-agent-tmp" "$HOME/.npmrc";
        echo "Removed nvm-incompatible prefix/globalconfig from ~/.npmrc";
      fi;
      . "$NVM_DIR/nvm.sh";
      echo "nvm=$(nvm --version 2>/dev/null || true)";
      glibc_version="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')";
      glibc_major="${'${glibc_version%%.*}'}";
      glibc_minor="${'${glibc_version#*.}'}"; glibc_minor="${'${glibc_minor%%.*}'}";
      legacy_x64=0;
      if [ "$(uname -m)" = "x86_64" ] && [ -n "$glibc_major" ] && [ -n "$glibc_minor" ]; then
        if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 28 ]; }; then legacy_x64=1; fi;
      fi;
      node_works=0;
      if [ "$legacy_x64" -ne 1 ]; then
        echo "NVM_NODEJS_ORG_MIRROR=$NVM_NODEJS_ORG_MIRROR";
        echo "Visible LTS versions (default mirror):";
        lts_versions="$(nvm ls-remote --lts 2>&1)";
        echo "$lts_versions" | tail -20;
        latest_lts="$(echo "$lts_versions" | sed -n 's/.*\\(v[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p' | tail -1)";
        echo "Resolved latest LTS: $latest_lts";
        install_ok=0;
        if [ -n "$latest_lts" ] && nvm install "$latest_lts"; then install_ok=1; fi;
        if [ "$install_ok" -ne 1 ]; then
          echo "Default Node mirror failed, retrying with npmmirror...";
          export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node;
          lts_versions="$(nvm ls-remote --lts 2>&1)";
          echo "$lts_versions" | tail -20;
          latest_lts="$(echo "$lts_versions" | sed -n 's/.*\\(v[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p' | tail -1)";
          echo "Resolved latest LTS from npmmirror: $latest_lts";
          if [ -n "$latest_lts" ] && nvm install "$latest_lts"; then install_ok=1; fi;
        fi;
        if [ "$install_ok" -eq 1 ]; then
          nvm alias default "$latest_lts";
          nvm use --delete-prefix "$latest_lts";
          if command -v npm >/dev/null 2>&1 && node -v && npm -v; then node_works=1; fi;
        fi;
      else
        echo "Detected legacy x64 Linux (glibc $glibc_version); using a compatible Node 22 build.";
      fi;
      if [ "$node_works" -ne 1 ]; then
        [ "$(uname -m)" = "x86_64" ] || { echo "No compatible automatic Node build for $(uname -m)"; exit 1; };
        echo "Installing Node 22 x64-glibc-217 compatibility build...";
        compat_node_dir="$HOME/.remote-agent-node";
        compat_installer="$HOME/.remote-agent-install-node.sh";
        mkdir -p "$compat_node_dir" || exit 1;
        if env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY curl -fsSIL --max-time 10 https://unofficial-builds.nodejs.org/install-node.sh >/dev/null 2>&1; then
          echo "Compatibility download supports direct access; bypassing the slow proxy.";
          unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY;
        fi;
        curl -fsSL https://unofficial-builds.nodejs.org/install-node.sh -o "$compat_installer" || exit 1;
        bash "$compat_installer" --yes --line 22 --platform x64-glibc-217 --dir "$compat_node_dir" || exit 1;
        printf '%s\n' 'export PATH="$HOME/.remote-agent-node/bin:$PATH"' > "$HOME/.remote-agent-node-env.sh";
        grep -Fq '.remote-agent-node-env.sh' "$HOME/.bashrc" 2>/dev/null || printf '%s\n' '[ -s "$HOME/.remote-agent-node-env.sh" ] && . "$HOME/.remote-agent-node-env.sh"' >> "$HOME/.bashrc";
        . "$HOME/.remote-agent-node-env.sh";
      fi;
      command -v npm >/dev/null 2>&1 && node -v && npm -v`;
    const r = await this.ssh.exec(cmd, { onStdout: log, onStderr: log });
    if (r.code !== 0) throw new Error('Node.js 安装失败,请查看日志');
    log('Node.js 安装完成\n');
  }

  /**
   * 安装 agent: 'codex' -> @openai/codex, 'claude' -> @anthropic-ai/claude-code
   * 全程带代理环境;由 nvm 管理 Node 与 npm 的全局安装目录
   */
  async installAgent(agent, log) {
    /* dsh:DeepSeek Harness,npm 全局包(bin 名 dsh)。
     * 官方要求 Node ≥ 22.19 / ≥ 24,低版本会在启动时报模块解析错误,
     * 所以先确保 Node 再装。 */
    if (agent === 'dsh') {
      if (this.ssh.isWindowsNative) {
        throw new Error(`Windows 本机请在 PowerShell 手动执行: ${dshInstallCommand()}`);
      }
      await this.ensureNode(log);
      log('安装/升级 DeepSeek Harness(dsh)...\n');
      const r = await this.ssh.exec(`${this._env()} ${Installer.BIN_PATH} ${dshInstallCommand()}`,
        { onStdout: log, onStderr: log });
      const v = await this.verifyBinary('dsh');
      if (!v.ok) throw new Error(`dsh 安装失败 (exit ${r.code}):${v.message}`);
      log(`dsh 安装完成 ✓(${v.version})\n`);
      return this.detect();
    }
    const pkg = agent === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';

    // 本机(macOS/Linux)安装/升级:直接用本机 npm(与用户终端同环境),
    // 不走远程专用的 Linux 独立二进制 / nvm 流程
    if (this.ssh.isLocal && !this.ssh.isWindowsNative) {
      log(`本机安装/升级 ${pkg}@latest ...\n`);
      const r = await this.ssh.exec(
        `npm install -g ${pkg}@latest && ${agent} --version`,
        { onStdout: log, onStderr: log }
      );
      if (r.code !== 0) {
        throw new Error(
          `${pkg} 本机安装/升级失败 (exit ${r.code})。` +
          `若是 Homebrew 安装的,请在终端运行: brew upgrade ${agent === 'codex' ? 'codex' : 'claude-code'}`
        );
      }
      log(`${agent} 已升级到最新 ✓\n`);
      return this.detect();
    }

    if (this.ssh.isWindowsNative) {
      await this.ensureNode(log);
      log(`安装 ${pkg} ...\n`);
      const version = await this.ssh.installGlobalAgent(`${pkg}@latest`, agent, {
        onStdout: log,
        onStderr: log
      });
      const detected = await this.detect();
      detected[agent] = detected[agent] || version;
      log(`${agent} 安装完成 ✓\n`);
      return detected;
    }

    if (agent === 'codex') {
      log('安装 Codex 官方独立版本(无需 Node.js)...\n');
      const standalone = `${this._env()}
        if env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY curl -fsSIL --max-time 10 https://github.com/openai/codex/releases/latest >/dev/null 2>&1; then
          echo "GitHub releases support direct access; bypassing the slow proxy.";
        fi;
        release_url="$(curl -fsSIL -o /dev/null -w '%{url_effective}' https://github.com/openai/codex/releases/latest)" || exit 1;
        release_tag="${'${release_url##*/}'}";
        version="${'${release_tag#rust-v}'}";
        [ -n "$version" ] || { echo "Unable to resolve the latest Codex version"; exit 1; };
        # 按实际架构选包:写死 x86_64 会在 ARM 机器(如昇腾/鲲鹏/树莓派)上装出跑不了的二进制
        machine="$(uname -m)";
        case "$machine" in
          x86_64|amd64) pkg_arch="x86_64";;
          aarch64|arm64) pkg_arch="aarch64";;
          *) echo "No prebuilt Codex binary for $machine; will fall back to npm"; exit 3;;
        esac;
        asset="codex-package-$pkg_arch-unknown-linux-musl.tar.gz";
        echo "Detected $machine -> $asset";
        base="https://github.com/openai/codex/releases/download/$release_tag";
        temp_dir="$HOME/.cache/remote-agent-codex/$version";
        mkdir -p "$temp_dir" || exit 1;
        manifest="$temp_dir/codex-package_SHA256SUMS";
        archive="$temp_dir/$asset";
        curl -fsSL "$base/codex-package_SHA256SUMS" -o "$manifest" || exit 1;
        expected="$(awk -v asset="$asset" '$2 == asset && length($1) == 64 && $1 !~ /[^0-9a-fA-F]/ { print tolower($1); exit }' "$manifest")";
        # 官方没为该架构发包时,别硬来,交给 npm 回退
        [ -n "$expected" ] || { echo "No official $pkg_arch package in this release; will fall back to npm"; exit 3; };
        url="$base/$asset";
        rm -f "$temp_dir"/part.* 2>/dev/null;
        echo "Downloading Codex $version ...";
        dl_ok=0;
        # 先探测资产 CDN(objects.githubusercontent.com)能否直连——注意不是 github.com
        if env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY curl -fsIL --max-time 10 "$url" >/dev/null 2>&1; then
          echo "Asset CDN reachable directly; downloading without proxy (resumable)...";
          if env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY curl -fL --retry 3 --retry-delay 2 -C - -o "$archive" "$url"; then dl_ok=1; fi;
        fi;
        if [ "$dl_ok" -ne 1 ]; then
          echo "Direct download unavailable; downloading via proxy (resumable)...";
          if ! curl -fL --retry 3 --retry-delay 2 -C - -o "$archive" "$url"; then
            echo "Resume failed; restarting download via proxy...";
            rm -f "$archive";
            curl -fL --retry 3 --retry-delay 2 -o "$archive" "$url" || { echo "Codex download failed"; exit 1; };
          fi;
        fi;
        actual="$(sha256sum "$archive" | awk '{print tolower($1)}')";
        if [ "$actual" != "$expected" ]; then
          echo "SHA-256 mismatch; re-downloading once via proxy...";
          rm -f "$archive";
          curl -fL --retry 3 --retry-delay 2 -o "$archive" "$url" || { echo "Codex download failed"; exit 1; };
          actual="$(sha256sum "$archive" | awk '{print tolower($1)}')";
        fi;
        [ "$actual" = "$expected" ] || { echo "Codex package SHA-256 verification failed"; exit 1; };
        release_dir="$HOME/.local/share/remote-agent-codex/$version";
        mkdir -p "$release_dir" "$HOME/.local/bin" || exit 1;
        tar -xzf "$archive" -C "$release_dir" || exit 1;
        codex_bin="$(find "$release_dir" -type f -name codex | head -1)";
        [ -n "$codex_bin" ] || { echo "Codex executable is missing from the verified package"; exit 1; };
        chmod 755 "$codex_bin" || exit 1;
        ln -sf "$codex_bin" "$HOME/.local/bin/codex" || exit 1;
        export PATH="$HOME/.local/bin:$PATH";
        codex --version`;
      const result = await this.ssh.exec(standalone, { onStdout: log, onStderr: log });
      if (result.code === 0) {
        log('codex 安装完成 ✓\n');
        return this.detect();
      }
      // 关键:独立安装可能已经建好了指向错误架构二进制的软链,
      // 它在 PATH 里优先于 npm 安装的版本,不清掉的话回退安装会被它挡住
      // (表现为「安装完成 ✓」但一运行就 Exec format error)
      await this.cleanupBrokenBinary('codex', log);
      log(`Codex 独立安装失败 (exit ${result.code}),回退到 npm 安装...\n`);
    }

    await this.ensureNode(log);
    log(`安装 ${pkg} ...\n`);
    const cmd = `${this._env()}
      export NVM_DIR="$HOME/.nvm";
      [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" || exit 1;
      if [ -s "$HOME/.remote-agent-node-env.sh" ]; then
        . "$HOME/.remote-agent-node-env.sh";
      else
        nvm use --delete-prefix default >/dev/null || exit 1;
      fi;
      command -v npm >/dev/null 2>&1 || { echo "npm is unavailable after loading nvm"; exit 127; };
      npm install -g ${pkg}@latest && ${agent} --version`;
    const r = await this.ssh.exec(cmd, { onStdout: log, onStderr: log });
    if (r.code !== 0) throw new Error(`${pkg} 安装失败 (exit ${r.code})`);
    // npm 装完也校验一次:确保 PATH 上生效的确实是能执行的那个
    const v = await this.verifyBinary(agent);
    if (!v.ok) {
      await this.cleanupBrokenBinary(agent, log);
      const retry = await this.verifyBinary(agent);
      if (!retry.ok) throw new Error(`${agent} 安装后无法执行:${retry.message}`);
      log(`已清理冲突的旧二进制,现使用 ${retry.version}\n`);
    }
    // 兼容旧版本曾安装到 ~/.npm-global 的 agent
    await this.ssh.exec(
      `grep -q npm-global ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc`
    );
    log(`${agent} 安装完成 ✓\n`);
    return this.detect();
  }

  /**
   * 写入 API key(可选,也可用户在远程自行 login);已存在时更新为新值。
   * 存放在 600 权限的 ~/.remote-agent-env.sh(不进 bashrc 明文),
   * bashrc 只追加一行 source,agent 命令与终端都会显式加载该文件。
   */
  async setApiKey(agent, key, log) {
    const varName = {
      claude: 'ANTHROPIC_API_KEY',
      codex: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      glm: 'ZHIPU_API_KEY',
      kimi: 'MOONSHOT_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      minimax: 'MINIMAX_API_KEY'
    }[agent] || 'OPENAI_API_KEY';
    return this.setEnvKey(varName, key, log);
  }

  /** 把任意环境变量(如自定义 provider 的 env_key)写入远程 600 权限 env 文件 */
  async setEnvKey(varName, key, log = () => {}) {
    const trimmed = String(key || '').trim();
    // 只允许安全字符,防止拼进 shell 时被注入
    if (!/^[A-Za-z0-9_.\-]+$/.test(trimmed)) {
      throw new Error('API Key 含空格或特殊字符,请检查后重试');
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(varName || ''))) {
      throw new Error('环境变量名不合法(仅字母/数字/下划线,不以数字开头)');
    }
    const envFile = '~/.remote-agent-env.sh';
    await this.ssh.exec(
      `touch ${envFile} && chmod 600 ${envFile} && ` +
      `grep -v '^export ${varName}=' ${envFile} > ${envFile}.tmp 2>/dev/null; ` +
      `mv ${envFile}.tmp ${envFile} && chmod 600 ${envFile} && ` +
      `printf 'export ${varName}=%s\\n' '${trimmed}' >> ${envFile} && ` +
      // 清理旧版本写进 bashrc 的明文 key,并确保 bashrc 引用 env 文件
      `touch ~/.bashrc && grep -v '^export ${varName}=' ~/.bashrc > ~/.bashrc.remote-agent-tmp 2>/dev/null; ` +
      `mv ~/.bashrc.remote-agent-tmp ~/.bashrc && ` +
      `grep -Fq '.remote-agent-env.sh' ~/.bashrc || ` +
      `printf '%s\\n' '[ -s "$HOME/.remote-agent-env.sh" ] && . "$HOME/.remote-agent-env.sh"' >> ~/.bashrc`
    );
    log(`${varName} 已写入 ${envFile}(600 权限,不落 bashrc 明文)\n`);
  }

}

module.exports = { Installer };
