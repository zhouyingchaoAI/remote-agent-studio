const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('chat input does not send while an IME composition is active', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ChatPanel.jsx'), 'utf8');
  assert.match(source, /onCompositionStart/);
  assert.match(source, /onCompositionEnd/);
  assert.match(source, /nativeEvent\.isComposing/);
  assert.match(source, /composingRef\.current/);
});
