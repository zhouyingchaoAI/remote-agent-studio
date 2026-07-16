const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('visited host views stay mounted in stable workspace layers', () => {
  const source = read('src/App.jsx');

  assert.match(source, /function PersistentWorkspace/);
  assert.match(source, /visitedViews/);
  assert.match(source, /const viewKey = `\$\{activeHostId\}:\$\{activeView\}`/);
  assert.match(source, /key=\{viewKey\}/);
  assert.match(source, /workspace-layer/);
  assert.match(source, /active=\{isActive\}/);
  assert.doesNotMatch(source, /eff === 'terminal' && <TerminalPanel/);
});

test('terminal refits when its persistent layer becomes active', () => {
  const source = read('src/components/TerminalPanel.jsx');

  assert.match(source, /TerminalPanel\(\{ hostId, active \}\)/);
  assert.match(source, /if \(!active\) return/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /window\.api\.term\.resize/);
});

test('file transfer progress is isolated by host while panels stay mounted', () => {
  const source = read('src/components/FilePanel.jsx');

  assert.match(source, /hostId: progressHostId/);
  assert.match(source, /if \(progressHostId !== hostId\) return/);
  assert.match(source, /\}, \[hostId\]\)/);
});

test('inactive workspace layers are hidden without removing their contents', () => {
  const source = read('src/styles.css');

  assert.match(source, /\.workspace-layer/);
  assert.match(source, /\.workspace-layer\.active/);
});
