const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('review-ready tasks freeze an auditable delivery package', () => {
  const store = read('src/store.js');
  const app = read('src/App.jsx');
  const panel = read('src/components/TaskPanel.jsx');
  assert.match(store, /finalizeTaskDelivery:\s*\(/);
  assert.match(store, /deliveryPackage/);
  assert.match(app, /finalizeTaskDelivery\(linkedTask\.id\)/);
  assert.match(panel, /deliveryPackage/);
});
