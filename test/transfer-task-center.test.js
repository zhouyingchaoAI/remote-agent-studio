const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('transfer tasks have global state and an independent workspace view', () => {
  const store = read('src/store.js');
  const app = read('src/App.jsx');

  assert.match(store, /transfers:\s*\{\}/);
  assert.match(store, /createTransfer:\s*\(/);
  assert.match(store, /updateTransferProgress:\s*\(/);
  assert.match(store, /finishTransfer:\s*\(/);
  assert.match(app, /TransferPanel/);
  assert.match(app, /key:\s*'transfers'/);
  assert.match(app, /view === 'transfers'/);
  assert.match(app, /files\.onProgress/);
});
