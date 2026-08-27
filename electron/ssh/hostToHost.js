/**
 * 远程 → 远程传输。
 *
 * 两条路,优先直连:
 *
 *  · **直连**:让源主机自己 scp 到目标主机。数据不经过本机,快得多,大文件
 *    尤其明显。前提是源主机上有到目标主机的免密(密钥)且网络可达 ——
 *    这个前提经常不成立,所以必须先探测,不能直接试了再说:
 *    scp 在没有密钥时会**卡在密码提示上等输入**,而我们是非交互执行,
 *    那就是一次无限期挂起。BatchMode=yes 强制它直接失败而不是提问。
 *
 *  · **中转**:源 → 本机临时目录 → 目标。一定能用(两台机器之间不需要互通),
 *    代价是流量走两遍、占本机磁盘。
 *
 * 纯函数,便于单测 —— 这些命令一旦写错,表现是「卡住」而不是报错,最难查。
 */
const { shellQuote } = require('./SSHManager');

/** ssh/scp 的公共选项:绝不允许交互,绝不因为 host key 变更而卡在提问上 */
function sshOpts({ connectTimeout = 8 } = {}) {
  return [
    '-o BatchMode=yes',              // 没密钥就立刻失败,不要弹密码提示
    `-o ConnectTimeout=${connectTimeout}`,
    '-o StrictHostKeyChecking=accept-new'  // 首次连接自动接受,但已知 key 变了仍然拒绝
  ].join(' ');
}

function safePort(port) {
  /* 只有"没填"才用默认值。`port || 22` 会把 0 也当成没填悄悄改成 22 ——
     0 不是没填,是一条错的主机配置,该报出来而不是替它猜。 */
  if (port === undefined || port === null || port === '') return 22;
  /* 必须整串都是数字。只做 parseInt 的话 '22; rm -rf /' 会被读成 22 ——
     拼进命令是安全的(我们用的是解析后的数字),但那是一条明显写错的配置,
     悄悄接受不如当场报出来。 */
  const raw = String(port).trim();
  const p = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`端口不合法:${port}`);
  }
  return p;
}

function safeUserHost(user, host) {
  const u = String(user || '').trim();
  const h = String(host || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(u)) throw new Error(`用户名不合法:${user}`);
  if (!/^[A-Za-z0-9._:-]+$/.test(h)) throw new Error(`主机地址不合法:${host}`);
  return `${u}@${h}`;
}

/**
 * 探测源主机能否直连目标主机。
 * 只跑 `true`,不产生任何副作用。
 */
function buildProbeCommand({ user, host, port }) {
  const dest = safeUserHost(user, host);
  return `ssh ${sshOpts()} -p ${safePort(port)} ${dest} true 2>&1 && echo __H2H_OK__`;
}

function parseProbe(text) {
  const t = String(text || '');
  if (/__H2H_OK__/.test(t)) return { direct: true };
  if (/Permission denied|publickey/i.test(t)) {
    return { direct: false, reason: 'auth', message: '源主机没有到目标主机的免密密钥' };
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) {
    return { direct: false, reason: 'hostkey', message: '目标主机的 host key 与源主机记录的不一致' };
  }
  if (/Connection timed out|No route to host|Could not resolve|Connection refused/i.test(t)) {
    return { direct: false, reason: 'network', message: '源主机连不到目标主机(网络不通)' };
  }
  return { direct: false, reason: 'unknown', message: (t.trim().split('\n').pop() || '无法直连').slice(0, 160) };
}

/**
 * 直连拷贝命令。
 * -r 对文件也安全(单文件时等同普通拷贝),省掉一次「是不是目录」的分支。
 */
function buildDirectCopyCommand({ srcPath, user, host, port, destPath }) {
  const dest = safeUserHost(user, host);
  // 目标目录要先建出来,scp 不会替你创建父目录
  const parent = String(destPath).replace(/\/[^/]*$/, '') || '/';
  return `ssh ${sshOpts()} -p ${safePort(port)} ${dest} ${shellQuote(`mkdir -p ${shellQuote(parent)}`)} 2>&1`
    + ` && scp -r ${sshOpts()} -P ${safePort(port)} ${shellQuote(srcPath)} ${dest}:${shellQuote(destPath)} 2>&1`
    + ' && echo __H2H_DONE__';
}

function parseCopyResult(text) {
  const t = String(text || '');
  if (/__H2H_DONE__/.test(t)) return { ok: true };
  return {
    ok: false,
    message: (t.trim().split('\n').filter(Boolean).pop() || '拷贝失败').slice(0, 300)
  };
}

/**
 * 量一下源路径有多大(字节)。
 * scp 不报进度,总量得我们自己先问出来,否则进度条没有分母。
 */
function buildSizeCommand(path) {
  return `du -sb ${shellQuote(path)} 2>/dev/null | cut -f1 || echo 0`;
}

/**
 * 量目标路径当前有多大 —— 直连进度靠轮询它算出来。
 *
 * scp 只在 stdout 是 tty 时才打进度条,而我们是非交互执行,拿不到任何进度。
 * 与其让用户对着一个不动的 0 B 干等,不如每隔几秒问一次目标目录的大小:
 * 数字会有滞后(scp 是按文件写的),但至少是真的在动、且方向正确。
 */
function buildDestSizeCommand(path) {
  return `du -sb ${shellQuote(path)} 2>/dev/null | cut -f1 || echo 0`;
}

function parseSize(text) {
  const n = parseInt(String(text || '').trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/* ------------------------------------------------------- 配置直连(下发公钥) */

/**
 * 确保源主机有一把 ssh 密钥,并把公钥打出来。
 *
 * 用 ed25519:比 RSA 短、快,现代 OpenSSH 都支持。
 * -N '' 是空口令 —— 有口令的密钥没法用于非交互的 scp,那正是我们要的场景;
 * 这一点必须让用户知情,所以配置直连是个显式按钮而不是自动行为。
 */
function buildEnsureKeyCommand() {
  return [
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    // 已有就不动:重新生成会把这台机器现有的所有免密关系全部作废
    '[ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519" -q',
    'cat "$HOME/.ssh/id_ed25519.pub"'
  ].join('; ');
}

/**
 * 把公钥追加到目标主机的 authorized_keys。
 *
 * 公钥不是秘密,可以走命令行。但仍要做两件事:
 *  · 去重 —— 重复追加会让文件越来越长,且看不出是不是已经配过;
 *  · 权限必须对 —— authorized_keys 权限过宽时 sshd 会**直接忽略它**,
 *    表现为"明明配了却还是要密码",极难查。
 */
function buildInstallKeyCommand(publicKey) {
  const key = String(publicKey || '').trim();
  if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/=]+/.test(key)) {
    throw new Error('公钥格式不对,拒绝写入 authorized_keys');
  }
  const q = shellQuote(key);
  return [
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"',
    `grep -qxF ${q} "$HOME/.ssh/authorized_keys" || echo ${q} >> "$HOME/.ssh/authorized_keys"`,
    'echo __KEY_OK__'
  ].join('; ');
}

/**
 * 中转用的本机临时路径。
 * 带上传输 id,避免两个任务撞同名。
 */
function relayTempPath(tmpDir, transferId, name) {
  const safe = String(name || 'file').replace(/[/\\]/g, '_');
  return `${tmpDir}/ras-h2h-${transferId}/${safe}`;
}

/**
 * 中转的两段进度合成一条。
 * 下载占前一半、上传占后一半 —— 直接把两段各自的百分比轮流报出去,
 * 进度条会先冲到 100 再跳回 0,看着像出错了。
 */
function relayProgress({ phase, transferred = 0, total = 0 }) {
  const ratio = total > 0 ? Math.min(1, transferred / total) : 0;
  const pct = phase === 'upload' ? 0.5 + ratio * 0.5 : ratio * 0.5;
  return { percent: Math.round(pct * 100), phase };
}

module.exports = {
  sshOpts, safePort, safeUserHost,
  buildProbeCommand, parseProbe,
  buildDirectCopyCommand, parseCopyResult,
  buildEnsureKeyCommand, buildInstallKeyCommand,
  buildSizeCommand, buildDestSizeCommand, parseSize,
  relayTempPath, relayProgress
};
