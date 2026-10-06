const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert/strict');

test('chat input does not send while an IME composition is active', () => {
  const source = readChatSources();
  assert.match(source, /onCompositionStart/);
  assert.match(source, /onCompositionEnd/);
  assert.match(source, /nativeEvent\.isComposing/);
  assert.match(source, /composingRef\.current/);
});
