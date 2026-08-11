const test = require('node:test');
const assert = require('node:assert');
const {
  looksLikeCredentials, readExpiry, KEYCHAIN_SERVICE, accountCandidates
} = require('../electron/claudeKeychain');

test('钥匙串条目名与官方一致', () => {
  assert.equal(KEYCHAIN_SERVICE, 'Claude Code-credentials');
});

test('识别订阅登录(OAuth)凭据的两种常见结构', () => {
  // 新版:包一层 claudeAiOauth
  assert.ok(looksLikeCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 }
  })));
  // 旧版/扁平:直接带 token 字段
  assert.ok(looksLikeCredentials(JSON.stringify({ access_token: 'a', refresh_token: 'r' })));
});

test('拒绝非凭据内容(避免把垃圾写进远程)', () => {
  assert.ok(!looksLikeCredentials(''));
  assert.ok(!looksLikeCredentials('password'));            // security 返回的普通密码串
  assert.ok(!looksLikeCredentials('{"foo":1}'));           // 是 JSON 但没有 token
  assert.ok(!looksLikeCredentials('{ 不是合法 json'));
  assert.ok(!looksLikeCredentials(null));
});

test('读取过期时间,拿不到时返回 0 而不是抛错', () => {
  assert.equal(readExpiry(JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: 1780000000000 } })), 1780000000000);
  assert.equal(readExpiry(JSON.stringify({ access_token: 'a', expires_at: 123 })), 123);
  assert.equal(readExpiry('{"claudeAiOauth":{"accessToken":"a"}}'), 0);
  assert.equal(readExpiry('乱码'), 0);
});

test('账户候选去重且包含当前用户', () => {
  const list = accountCandidates();
  assert.equal(new Set(list).size, list.length);
  assert.ok(list.length >= 1);
});
