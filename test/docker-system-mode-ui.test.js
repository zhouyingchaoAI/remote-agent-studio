const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ChatPanel exposes the system-mode toggle, confirmation, badge, restart, and permission hint action', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ChatPanel.jsx'), 'utf8');

  assert.match(source, /const \[permissionMode, setPermissionMode\] = useState\(/);
  assert.match(source, /defaultPermissionMode \|\| 'workspace'/);
  assert.match(source, /opts: \{ agent: conv\.agent, cwd: conv\.cwd, model: conv\.model, permissionMode \}/);
  assert.match(source, /\[conv\.id, permissionMode, conv\.model, conv\.agent\]/);
  assert.match(source, /updateConversationPermission/);
  assert.match(source, /window\.confirm/);
  assert.match(source, /Docker/);
  assert.match(source, /系统权限/);
  assert.match(source, /case 'permission_hint':/);
  assert.match(source, /Enable System Mode/);
});

test('styles keep system-mode status and permission hints visible and actionable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');

  assert.match(source, /\.badge\.system-mode/);
  assert.match(source, /\.system-mode-notice/);
  assert.match(source, /\.permission-hint/);
  assert.match(source, /\.permission-hint-action/);
});
