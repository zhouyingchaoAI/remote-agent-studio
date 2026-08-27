/**
 * 镜像仓库凭据存储。
 *
 * 这里存的是**可解密还原的密码**,性质比 token 更重,所以比本项目其他
 * 配置存储更严一档:
 *
 *  · 加密不可用时**直接拒绝保存**,不像别处那样退回明文 base64。
 *    base64 不是加密;一个存密码的功能悄悄降级成明文,比不提供这个功能更糟,
 *    因为用户以为它是加密的。
 *  · 密码只在两个时刻出现:保存时(加密)与登录时(解密后走 stdin)。
 *    列表接口一律不返回密码,连字段都不给。
 *  · 文件权限 600。
 */
const fs = require('fs');
const path = require('path');

let _app = null;
let _safeStorage = null;

function init(app, safeStorage) { _app = app; _safeStorage = safeStorage; }

function cfgPath() {
  return path.join(_app.getPath('userData'), 'registries.json');
}

function encryptionAvailable() {
  try { return !!_safeStorage?.isEncryptionAvailable(); } catch (_) { return false; }
}

function _read() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    return Array.isArray(raw.items) ? raw.items : [];
  } catch (_) { return []; }
}

function _write(items) {
  const file = cfgPath();
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2), 'utf8');
  // 里面是加密后的密码,别让同机其他用户读到
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows 上没有这个概念 */ }
}

/** 给界面用的列表:**没有密码字段**,连占位都不给 */
function list() {
  return _read().map((it) => ({
    id: it.id,
    registry: it.registry,
    username: it.username,
    label: it.label,
    hasSecret: !!it.secretEnc,
    updatedAt: it.updatedAt
  }));
}

/**
 * 保存一条凭据。
 * @param secret 密码或令牌;留空表示只更新地址/用户名,不动已存的密码
 */
function save({ id, registry, username, label, secret }) {
  if (secret && !encryptionAvailable()) {
    throw new Error(
      '系统加密不可用(Linux 上通常是缺少 keyring/libsecret),拒绝以明文保存密码。'
      + '你仍可以每次手动输入密码登录,只是不能保存。'
    );
  }
  const items = _read();
  const now = Date.now();
  const key = id || `reg_${now}_${Math.random().toString(36).slice(2, 8)}`;
  const idx = items.findIndex((it) => it.id === key);
  const prev = idx >= 0 ? items[idx] : {};
  const next = {
    id: key,
    registry: registry ?? prev.registry ?? '',
    username: username ?? prev.username ?? '',
    label: label ?? prev.label ?? '',
    // 没传新密码就保留原来的,避免"改个用户名把密码弄丢"
    secretEnc: secret
      ? _safeStorage.encryptString(secret).toString('base64')
      : (prev.secretEnc || ''),
    updatedAt: now
  };
  if (idx >= 0) items[idx] = next; else items.push(next);
  _write(items);
  return { id: key };
}

function remove(id) {
  _write(_read().filter((it) => it.id !== id));
  return { ok: true };
}

/**
 * 取出明文密码。
 *
 * 只给主进程内部的登录流程用 —— 绝不要把它的返回值放进 IPC 响应、
 * 日志或错误消息里。调用点应当尽快用完丢弃。
 */
function revealSecret(id) {
  const it = _read().find((x) => x.id === id);
  if (!it?.secretEnc) return '';
  try {
    return _safeStorage.decryptString(Buffer.from(it.secretEnc, 'base64'));
  } catch (_) {
    // 换了机器或钥匙串变了会解不开,这时如实报错比返回空串好排查
    throw new Error('凭据解密失败(可能是换了机器或系统钥匙串已变),请重新保存密码');
  }
}

function get(id) {
  const it = _read().find((x) => x.id === id);
  if (!it) return null;
  return { id: it.id, registry: it.registry, username: it.username, label: it.label, hasSecret: !!it.secretEnc };
}

module.exports = { init, list, save, remove, get, revealSecret, encryptionAvailable, cfgPath };
