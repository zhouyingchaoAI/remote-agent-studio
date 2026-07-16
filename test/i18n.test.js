const test = require('node:test');
const assert = require('node:assert/strict');

test('i18n defaults to Chinese and provides English labels for shared navigation', async () => {
  const { translate, normalizeLanguage } = await import('../src/i18n.mjs');
  assert.equal(normalizeLanguage(), 'zh-CN');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(translate('en', 'settings'), 'Settings');
  assert.equal(translate('zh-CN', 'settings'), '设置');
  assert.equal(translate('en', 'missing_key'), 'missing_key');
});
