const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ChatPanel exposes the system-mode toggle, confirmation, badge, restart, and permission hint action', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ChatPanel.jsx'), 'utf8');

  assert.match(source, /const \[permissionMode, setPermissionMode\] = useState\(/);
  assert.match(source, /defaultPermissionMode \|\| 'workspace'/);
  // 断言语义而不是那一行的排版:permissionMode 必须随 agent:start 传下去。
  // 原来写死了整行字面量,给 opts 加个字段就误报。
  assert.match(source, /agent\.start\(\{[\s\S]{0,400}?permissionMode/);
  // 断言依赖项包含权限模式即可 —— 写死整个数组,加一个依赖就误报
  assert.match(source, /\}, \[conv\.id, permissionMode,[^\]]*\]\);/);
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
