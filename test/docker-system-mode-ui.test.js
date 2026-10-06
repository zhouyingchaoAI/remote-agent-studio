const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('ChatPanel exposes the system-mode toggle, confirmation, badge, restart, and permission hint action', () => {
  const source = readChatSources();

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

  /* 「系统权限」原来是徽标 + 复选框两个控件(同一个状态显示两遍,
     还把顶栏挤到换行),现在合并成一个开关,红色由它自己承担。
     这里查的仍是同一件事:**开着的时候必须一眼看出来**。 */
  assert.match(source, /\.chip-toggle\.on\.danger/);
  const danger = source.slice(source.indexOf('.chip-toggle.on.danger'));
  assert.match(danger.slice(0, 200), /var\(--red\)/);
  assert.match(source, /\.system-mode-notice/);
  assert.match(source, /\.permission-hint/);
  assert.match(source, /\.permission-hint-action/);
});
