const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('remote Codex verification includes the standalone install directory in env', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'verify-remote-codex.js'),
    'utf8'
  );

  assert.match(
    source,
    /'\[ -s "\$HOME\/\.remote-agent-node-env\.sh" \] && \. "\$HOME\/\.remote-agent-node-env\.sh"; ' \+\r?\n\s*'export PATH="\$HOME\/\.local\/bin:/,
    'the PATH export must be concatenated into the remote env command'
  );
});
