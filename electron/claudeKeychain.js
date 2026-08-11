/**
 * macOS 钥匙串里的 Claude Code 凭据导出。
 *
 * 背景:Claude Code 在 macOS 把 OAuth 凭据存进钥匙串(条目 "Claude Code-credentials"),
 * 而不是 ~/.claude/.credentials.json —— 所以"复制认证文件"那套对 macOS 无效。
 * 但 Claude Code 支持文件回退:远程存在 ~/.claude/.credentials.json 时会从文件读。
 * 于是路径是:本机钥匙串导出 -> 下发成远程的 .credentials.json(600)。
 *
 * 这样 Pro/Max 订阅(OAuth 登录)也能在远程机上用,不必额外买 API Key。
 */
const { execFile } = require('child_process');
const os = require('os');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** 钥匙串里可能用过的账户名(不同版本写法不一),按顺序尝试 */
function accountCandidates() {
  return [os.userInfo().username, process.env.USER, ''].filter((v, i, a) => v != null && a.indexOf(v) === i);
}

/** 判断导出的内容是不是合法的 Claude 凭据 JSON */
function looksLikeCredentials(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('{')) return false;
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== 'object') return false;
    // 兼容不同版本:顶层可能是 {claudeAiOauth:{...}} 或直接带 token 字段
    const inner = j.claudeAiOauth || j;
    return !!(inner.accessToken || inner.access_token || inner.refreshToken || inner.refresh_token);
  } catch (_) { return false; }
}

/** 读取 token 过期时间(毫秒);拿不到返回 0 */
function readExpiry(text) {
  try {
    const j = JSON.parse(String(text));
    const inner = j.claudeAiOauth || j;
    const exp = inner.expiresAt || inner.expires_at || 0;
    return Number(exp) || 0;
  } catch (_) { return 0; }
}

function runSecurity(args) {
  return new Promise((resolve) => {
    execFile('security', args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

/**
 * 从钥匙串导出凭据 JSON。
 * @returns {ok, text, expiresAt, error}
 */
async function exportCredentials() {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '仅 macOS 需要从钥匙串导出' };
  }
  for (const account of accountCandidates()) {
    const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE];
    if (account) args.push('-a', account);
    args.push('-w');
    // eslint-disable-next-line no-await-in-loop
    const out = await runSecurity(args);
    if (looksLikeCredentials(out)) {
      return { ok: true, text: out, expiresAt: readExpiry(out) };
    }
  }
  return {
    ok: false,
    error: '钥匙串里没找到 Claude Code 凭据。请先在本机运行 claude 完成登录;' +
      '若弹出钥匙串授权请点「允许」。'
  };
}

/**
 * 把凭据 JSON 解析成界面要展示的摘要(纯函数)。
 * 不同版本字段名不一致,这里做兼容;拿不到的字段留空而不是瞎猜。
 */
function summarizeCredentials(text) {
  const out = { valid: false, expiresAt: 0, expired: false, subscription: '', scopes: '', account: '' };
  if (!looksLikeCredentials(text)) return out;
  let j;
  try { j = JSON.parse(String(text)); } catch (_) { return out; }
  const inner = j.claudeAiOauth || j;
  out.valid = true;
  out.expiresAt = Number(inner.expiresAt || inner.expires_at || 0) || 0;
  out.expired = out.expiresAt > 0 && out.expiresAt <= Date.now();
  // 订阅类型:Pro / Max / 或 API 计费
  const sub = inner.subscriptionType || inner.subscription_type || inner.plan || '';
  out.subscription = String(sub || '').trim();
  const scopes = inner.scopes || inner.scope || '';
  out.scopes = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '').trim();
  out.account = String(inner.account?.email_address || inner.account?.email || inner.email || '').trim();
  return out;
}

module.exports = {
  exportCredentials, looksLikeCredentials, readExpiry, summarizeCredentials,
  KEYCHAIN_SERVICE, accountCandidates
};
