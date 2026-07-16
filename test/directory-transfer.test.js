const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLocalDirectoryManifest } = require('../electron/fileTransfer');

test('directory manifest includes nested regular files and skips symlinks', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'top.txt'), 'top');
  fs.writeFileSync(path.join(root, 'nested', 'child.txt'), 'child');
  fs.symlinkSync(path.join(root, 'top.txt'), path.join(root, 'linked.txt'));

  const manifest = await buildLocalDirectoryManifest(root);

  assert.deepEqual(manifest.files.map((file) => file.relativePath).sort(), [
    'nested/child.txt',
    'top.txt'
  ]);
  assert.equal(manifest.total, 8);
  assert.equal(manifest.skippedSymlinks, 1);
});
