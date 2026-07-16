const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('setup controls use shared localized labels', () => {
  const source = read('src/components/SetupPanel.jsx');
  assert.match(source, /translate as tr/);
  assert.match(source, /t\('networkProxy'\)/);
  assert.match(source, /t\('applyProxy'\)/);
  assert.match(source, /t\('exportDiagnostics'\)/);
  assert.match(source, /<LocalCodexCard language=\{language\}/);
});
