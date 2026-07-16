const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('terminal controls use shared localized labels', () => {
  const source = read('src/components/TerminalPanel.jsx');
  assert.match(source, /translate as tr/);
  assert.match(source, /t\('terminalTab'/);
  assert.match(source, /t\('reconnectTerminal'/);
  assert.match(source, /t\('copy'/);
  assert.match(source, /t\('paste'/);
});
