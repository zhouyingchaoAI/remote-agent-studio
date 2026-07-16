const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('file transfers use individually cancellable streams and narrow IPC', () => {
  const ssh = read('electron/ssh/SSHManager.js');
  assert.match(ssh, /activeTransfers = new Map/);
  assert.match(ssh, /cancelTransfer\(transferId\)/);
  assert.match(ssh, /source\.destroy\(error\)/);
  assert.match(ssh, /destination\.destroy\(error\)/);
  assert.doesNotMatch(ssh, /fastPut\(/);
  assert.doesNotMatch(ssh, /fastGet\(/);
  assert.match(read('electron/preload.js'), /cancelTransfer: invoke\('fs:cancelTransfer'\)/);
  assert.match(read('src/components/FilePanel.jsx'), /window\.api\.files\.cancelTransfer/);
});
