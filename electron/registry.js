/**
 * 容器镜像仓库登录(Harbor / Docker Hub / 任意 registry)。
 *
 * 和 GitHub 那套不一样:registry 没有设备流,只能账号密码。所以这里的
 * 全部心思都在「密码怎么走」上:
 *
 *  · 密码一律走 **stdin**(`--password-stdin`),绝不用 `-p`。docker 自己
 *    都会为 `-p` 打警告 —— 命令行在 `ps` 里对同机所有进程可见,
 *    而且会进 shell history。
 *  · 密码不进日志、不进错误消息、不进 IPC 返回值。
 *  · 我们不解析、不回显 `~/.docker/config.json` 里的 auth 字段值 ——
 *    那玩意儿只是 base64,解开就是明文密码。只取用户名。
 */

/** Docker Hub 在 config.json 里的固定键名,与用户输入的 docker.io 不同 */
const DOCKER_HUB_KEY = 'https://index.docker.io/v1/';
const DOCKER_HUB_ALIASES = ['', 'docker.io', 'index.docker.io', 'registry-1.docker.io', DOCKER_HUB_KEY];

/**
 * 归一化仓库地址。
 * 用户可能填 https://harbor.x.com、harbor.x.com/、或者留空表示 Docker Hub。
 */
function normalizeRegistry(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (DOCKER_HUB_ALIASES.includes(s.toLowerCase())) {
    return { server: '', configKey: DOCKER_HUB_KEY, label: 'Docker Hub', isHub: true };
  }
  // 地址会进命令行:只允许 主机[:端口][/路径] 里的安全字符
  if (!/^[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._\-/]*)?$/.test(s)) {
    throw new Error(`仓库地址不合法:${input}`);
  }
  return { server: s, configKey: s, label: s, isHub: false };
}

/** 用户名同样会进命令行,同样要挡 */
function safeUsername(name) {
  const u = String(name || '').trim();
  if (!u) throw new Error('用户名不能为空');
  if (!/^[A-Za-z0-9._@$+-]+$/.test(u)) throw new Error(`用户名含不支持的字符:${name}`);
  return u;
}

/* ------------------------------------------------------------ 命令 */

/**
 * 登录命令。密码由调用方通过 stdin 送入,这里只负责命令本身。
 * @returns 命令字符串;调用方必须配合 `{ stdin: password }`
 */
function buildLoginCommand({ registry, username }) {
  const { server } = normalizeRegistry(registry);
  const u = safeUsername(username);
  // --password-stdin 是硬性要求:换成 -p 就等于把密码写进 ps 和 history
  return `docker login ${server ? `${server} ` : ''}-u ${u} --password-stdin 2>&1`;
}

function buildLogoutCommand({ registry }) {
  const { server } = normalizeRegistry(registry);
  return `docker logout ${server || 'docker.io'} 2>&1`;
}

function buildVersionCommand() {
  return 'command -v docker >/dev/null 2>&1 && docker version --format "{{.Server.Version}}" 2>&1 '
    + '|| echo "__NO_DOCKER__"';
}

/**
 * 读已登录的仓库列表。
 * 只取 auths 的键与 identitytoken 存在与否 —— **绝不解 auth 字段**,
 * 那是 base64 的 user:pass,解开就是明文密码。
 */
function buildConfigCommand() {
  return 'cat "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null || echo "{}"';
}

/* ------------------------------------------------------------ 解析 */

function parseDockerVersion(text) {
  const t = String(text || '').trim();
  if (/__NO_DOCKER__/.test(t)) return { installed: false, message: '主机上没有 docker 命令' };
  if (/Cannot connect to the Docker daemon|docker daemon is not running|permission denied/i.test(t)) {
    return { installed: true, daemonUp: false, message: `docker 已安装但守护进程连不上:${t.slice(0, 160)}` };
  }
  return { installed: true, daemonUp: true, version: t.split('\n')[0].slice(0, 40) };
}

/**
 * 从 config.json 里列出已登录仓库。
 * 只返回地址与用户名 —— 用户名从 auth 里解出来是安全的(冒号前半段),
 * 但必须只取前半段,后半段是密码。
 */
function parseDockerConfig(json) {
  let cfg = {};
  try { cfg = JSON.parse(String(json || '{}')); } catch (_) { return []; }
  const auths = cfg.auths || {};
  return Object.keys(auths).map((key) => {
    const entry = auths[key] || {};
    let username = '';
    if (entry.auth) {
      try {
        const decoded = Buffer.from(entry.auth, 'base64').toString('utf8');
        // 只取冒号前的用户名;冒号之后是密码,到此为止,不再传递
        username = decoded.split(':')[0] || '';
      } catch (_) { /* 坏数据当没有用户名 */ }
    }
    const norm = DOCKER_HUB_ALIASES.includes(key.toLowerCase())
      ? { label: 'Docker Hub' } : { label: key };
    return {
      configKey: key,
      label: norm.label,
      username,
      // 用凭据助手时 auth 是空的,登录态在 helper 里
      viaHelper: !entry.auth && !!(cfg.credsStore || cfg.credHelpers?.[key])
    };
  });
}

/**
 * 解释登录结果。
 * 分类的价值在于「该改什么」:证书问题要动 daemon 配置,凭据问题只需重填。
 */
function parseLoginResult(text, { registry } = {}) {
  const t = String(text || '');
  if (/Login Succeeded/i.test(t)) return { ok: true, message: '登录成功' };

  if (/x509|certificate signed by unknown authority|tls: failed to verify|server gave HTTP response to HTTPS client/i.test(t)) {
    return {
      ok: false, reason: 'cert',
      message: 'TLS 证书不被信任(Harbor 自建常见)', advice: certAdvice(registry, t)
    };
  }
  if (/unauthorized|incorrect username or password|authentication required|401/i.test(t)) {
    return { ok: false, reason: 'auth', message: '用户名或密码不对(Harbor 机器人账号的名字通常带 robot$ 前缀)' };
  }
  if (/Cannot connect to the Docker daemon|permission denied while trying to connect/i.test(t)) {
    return { ok: false, reason: 'daemon', message: 'docker 守护进程连不上(未启动,或当前用户不在 docker 组)' };
  }
  if (/no such host|connection refused|timeout|i\/o timeout/i.test(t)) {
    return { ok: false, reason: 'network', message: '连不上这个仓库地址(DNS / 端口 / 代理)' };
  }
  return { ok: false, reason: 'unknown', message: t.trim().split('\n').slice(-3).join('\n').slice(0, 300) };
}

/**
 * 证书问题的处置建议。
 *
 * 只给命令不代改:这是主机级安全配置,而且改完要重启 docker ——
 * 重启会掐掉那台机器上所有正在跑的容器,不该由一个登录按钮顺手做掉。
 */
function certAdvice(registry, errorText = '') {
  let server = '';
  try { server = normalizeRegistry(registry).server || 'docker.io'; } catch (_) { server = String(registry || ''); }
  const httpsToHttp = /server gave HTTP response to HTTPS client/i.test(errorText);
  return [
    httpsToHttp
      ? `${server} 是 HTTP 仓库,docker 默认只认 HTTPS。两条路二选一:`
      : `${server} 的证书不在系统信任链里。两条路二选一:`,
    '',
    `A. 把 CA 证书装到该主机(推荐,不降低安全级别):`,
    `   sudo mkdir -p /etc/docker/certs.d/${server}`,
    `   sudo cp your-ca.crt /etc/docker/certs.d/${server}/ca.crt`,
    '   # 这条不需要重启 docker',
    '',
    `B. 声明为 insecure registry(降低安全级别,且要重启 docker):`,
    '   sudo vi /etc/docker/daemon.json',
    `   { "insecure-registries": ["${server}"] }`,
    '   sudo systemctl restart docker',
    '   # 注意:重启会掐掉这台机器上所有正在运行的容器'
  ].join('\n');
}

module.exports = {
  DOCKER_HUB_KEY, DOCKER_HUB_ALIASES,
  normalizeRegistry, safeUsername,
  buildLoginCommand, buildLogoutCommand, buildVersionCommand, buildConfigCommand,
  parseDockerVersion, parseDockerConfig, parseLoginResult, certAdvice
};
