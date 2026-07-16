const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Windows local Codex detection falls back to the installed desktop app', { skip: process.platform !== 'win32' }, () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

  assert.ok(mainSource.indexOf("'codex.cmd'") < mainSource.indexOf("'codex.exe'"),
    'the runnable npm shim must be tried before the protected Desktop executable');
  assert.match(mainSource, /\['\/d', '\/s', '\/c', bin, '--version'\]/,
    'Windows command shims must be launched through cmd.exe');
  assert.match(mainSource, /execFile\('where\.exe'/, 'Windows detection must locate the AppX desktop install');
  assert.match(mainSource, /Codex Desktop/, 'the desktop fallback must be reported distinctly from a runnable CLI');
});
