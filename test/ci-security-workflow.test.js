const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('CI fails when npm reports high-severity dependency vulnerabilities', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /npm audit --audit-level=high/);
});

test('CI performs an unsigned packaging smoke test on every target OS', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /npm run dist -- --dir/);
  assert.match(workflow, /ubuntu-latest, macos-latest, windows-latest/);
});

test('CI runs on feature branch pushes as well as pull requests', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /branches: \['\*\*'\]/);
  assert.match(workflow, /pull_request:/);
});

test('CI cancels superseded runs for the same branch', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
});
