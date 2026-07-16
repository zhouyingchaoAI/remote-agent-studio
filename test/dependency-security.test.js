const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('desktop runtime and packager use patched major releases', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.devDependencies.electron, /^\^43\./);
  assert.match(pkg.devDependencies['electron-builder'], /^\^26\.15\./);
});
