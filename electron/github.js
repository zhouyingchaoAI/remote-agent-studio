/**
 * GitHub 快捷登录。
 *
 * 走 gh CLI 自己的设备流,而不是自己实现 OAuth:
 *  · 不必冒用别人的 client_id,也不必让用户去注册一个 OAuth App;
 *  · **token 全程由 gh 处理,不经过我们** —— 我们只读它的 stdout 拿一次性码。
 *    这一点很关键:凭据不落在我们的日志、IPC 和内存里,也就没得泄漏。
 *
 * 关键实现前提(读 cli/cli 与 cli/oauth 源码确认过):
 *  1. `--web` 直接选中浏览器授权分支,不再问「怎么登录」;
 *  2. stdin **不是 tty** 时 gh 判定为非交互,于是既不提示按回车、也不尝试
 *     打开浏览器,而是直接打印一次性码与地址然后开始轮询 —— 正好是我们
 *     spawn 出来的默认形态。截图里 agent 卡住,就是因为它在有 tty 的
 *     终端里跑,gh 停在「Press Enter」等一个永远不会来的回车。
 *  3. cli/oauth 的 DetectFlow 先试设备流,github.com 支持,所以不会退化成
 *     需要 127.0.0.1 回调的 web 流 —— 那在远程主机上根本回调不回来。
 *  4. 非交互模式下 gh 不会配 git 凭据助手(那段被 Interactive 守着),
 *     所以 push 免密要我们随后单独调 `gh auth setup-git`。
 */

const DEFAULT_HOST = 'github.com';

/** 主机名只允许域名字符 —— 它会进命令行 */
function safeHostname(host) {
  const h = String(host || DEFAULT_HOST).trim();
  if (!/^[A-Za-z0-9.-]+$/.test(h)) throw new Error(`GitHub 主机名不合法:${host}`);
  return h;
}

/* ------------------------------------------------------------ 命令 */

/**
 * 登录命令。
 * 2>&1 是必须的:一次性码、进度、成功提示 gh 全打在 **stderr** 上。
 * </dev/null 是关键:把 stdin 明确断掉,gh 才会判定非交互而不等回车。
 */
function buildLoginCommand({ hostname = DEFAULT_HOST } = {}) {
  const h = safeHostname(hostname);
  return `gh auth login --hostname ${h} --git-protocol https --web 2>&1 </dev/null`;
}

/** 让 https 方式的 git push/pull 直接用这份凭据 */
function buildSetupGitCommand({ hostname = DEFAULT_HOST } = {}) {
  return `gh auth setup-git --hostname ${safeHostname(hostname)} 2>&1`;
}

function buildStatusCommand({ hostname = DEFAULT_HOST } = {}) {
  return `gh auth status --hostname ${safeHostname(hostname)} 2>&1`;
}

function buildVersionCommand() {
  return 'command -v gh >/dev/null 2>&1 && gh --version 2>/dev/null | head -1 || echo "__NO_GH__"';
}

/**
 * 安装命令。
 * Linux 走官方 tarball 装到 ~/.local/bin:不需要 root,也不用猜发行版的包管理器。
 * macOS 只给建议不自动装 —— brew 装东西可能很慢且会动全局环境,不该由我们替用户决定。
 */
function buildInstallCommand(platform = 'linux') {
  if (platform === 'darwin') {
    return { manual: true, command: 'brew install gh', note: 'macOS 请手动执行(brew 安装会改动全局环境,不代劳)' };
  }
  return {
    manual: false,
    command: [
      'set -e',
      'mkdir -p "$HOME/.local/bin" "$HOME/.cache/ras-gh"',
      'cd "$HOME/.cache/ras-gh"',
      // 用 API 拿最新版本号,避免把版本号写死在代码里过期
      'V=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -o \'"tag_name": *"v[^"]*"\' | head -1 | sed \'s/.*"v\\(.*\\)"/\\1/\')',
      '[ -n "$V" ] || { echo "拿不到 gh 最新版本号(网络或代理问题)"; exit 1; }',
      'A=$(uname -m); case "$A" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; esac',
      'curl -fsSL -o gh.tgz "https://github.com/cli/cli/releases/download/v${V}/gh_${V}_linux_${A}.tar.gz"',
      'tar xzf gh.tgz',
      'install -m 755 "gh_${V}_linux_${A}/bin/gh" "$HOME/.local/bin/gh"',
      'rm -rf gh.tgz "gh_${V}_linux_${A}"',
      '"$HOME/.local/bin/gh" --version | head -1'
    ].join('; ')
  };
}

/* ------------------------------------------------------------ 解析 */

/** gh 输出里带 ANSI 颜色,不剥掉正则会匹配不上 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\[[0-9;?]*[a-zA-Z]/g, '');
}

/**
 * 从 gh 的输出里抽出登录进度。
 * 每一项都可能还没出现,所以返回的是「目前已知的部分」,由调用方累积。
 */
function parseLoginOutput(chunk) {
  const t = stripAnsi(chunk);
  const out = {};

  // ! First copy your one-time code: ABCD-1234
  const code = t.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
  if (code) out.code = code[1].toUpperCase();

  // Open this URL to continue in your web browser: https://github.com/login/device
  const url = t.match(/https?:\/\/\S*\/login\/device\S*/);
  if (url) out.url = url[0].replace(/[.,)\]]+$/, '');

  if (/Authentication complete/i.test(t)) out.authenticated = true;

  // ✓ Logged in as someuser
  const who = t.match(/Logged in as\s+([A-Za-z0-9-]+)/);
  if (who) { out.username = who[1]; out.done = true; }

  if (/error|failed|denied|expired/i.test(t) && !/Authentication complete/i.test(t)) {
    const line = t.split(/\r?\n/).find((l) => /error|failed|denied|expired/i.test(l));
    if (line) out.error = line.trim().slice(0, 300);
  }
  return out;
}

/** 设备授权页带上一次性码,手机扫过去就不用手打了 */
function deviceUrlWithCode(url, code) {
  const base = url || 'https://github.com/login/device';
  if (!code) return base;
  return `${base}${base.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(code)}`;
}

/**
 * 解析 `gh auth status`。
 * 注意别把 token 本身带出来 —— gh 默认已隐藏,但万一用户开了 --show-token,
 * 我们也不该把它塞进返回值里到处传。
 */
function parseAuthStatus(text) {
  const t = stripAnsi(text);
  if (/__NO_GH__|command not found|not found/i.test(t)) {
    return { installed: false, loggedIn: false, message: '主机上没有 gh 命令' };
  }
  const who = t.match(/Logged in to \S+ (?:account\s+)?([A-Za-z0-9-]+)/)
    || t.match(/Logged in to \S+ as ([A-Za-z0-9-]+)/);
  if (who) {
    const scopes = t.match(/Token scopes:\s*(.+)/);
    return {
      installed: true, loggedIn: true, username: who[1],
      scopes: scopes ? scopes[1].replace(/['"]/g, '').trim() : '',
      message: `已登录:${who[1]}`
    };
  }
  return { installed: true, loggedIn: false, message: '已安装 gh,但尚未登录' };
}

module.exports = {
  DEFAULT_HOST, safeHostname,
  buildLoginCommand, buildSetupGitCommand, buildStatusCommand,
  buildVersionCommand, buildInstallCommand,
  stripAnsi, parseLoginOutput, deviceUrlWithCode, parseAuthStatus
};
