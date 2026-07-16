const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('Electron exposes clipboard access through narrow IPC handlers', () => {
  const main = read('electron/main.js');
  const preload = read('electron/preload.js');

  assert.match(main, /clipboard:readText/);
  assert.match(main, /clipboard:writeText/);
  assert.match(preload, /clipboard:\s*\{/);
  assert.match(preload, /readText: invoke\('clipboard:readText'\)/);
  assert.match(preload, /writeText: invoke\('clipboard:writeText'\)/);
});

test('terminal supports copy and paste without stealing an unselected Ctrl+C', () => {
  const source = read('src/components/TerminalPanel.jsx');

  assert.match(source, /attachCustomKeyEventHandler/);
  assert.match(source, /term\.hasSelection\(\)/);
  assert.match(source, /window\.api\.clipboard\.writeText\(term\.getSelection\(\)\)/);
  assert.match(source, /window\.api\.clipboard\.readText\(\)/);
  assert.match(source, /term\.paste\(text\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /if \(key === 'c' && \(event\.shiftKey \|\| term\.hasSelection\(\)\)\)/);
  assert.match(source, /return true;\s*\}\);/);
});

test('terminal provides a right-click copy and paste menu', () => {
  const source = read('src/components/TerminalPanel.jsx');
  const styles = read('src/styles.css');

  assert.match(source, /onContextMenu=\{openContextMenu\}/);
  assert.match(source, /terminal-context-menu/);
  assert.match(source, />复制</);
  assert.match(source, />粘贴</);
  assert.match(styles, /\.terminal-context-menu/);
});

test('terminal provides an in-panel search control backed by xterm search', () => {
  const source = read('src/components/TerminalPanel.jsx');
  const pkg = read('package.json');
  assert.match(pkg, /@xterm\/addon-search/);
  assert.match(source, /SearchAddon/);
  assert.match(source, /findNext/);
  assert.match(source, /findPrevious/);
  assert.match(source, /搜索终端输出/);
});
