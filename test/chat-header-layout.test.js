const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const chat = readChatSources();
const css = read('src/styles.css');

/* ============================================================
 * 对话顶栏被挤到换行(System Mode 掉到第二行)。
 *
 * 表面是"宽度不够",实际是**同一个状态被显示了两遍**:
 * `系统权限` 徽标和 `System Mode` 复选框都由 permissionMode === 'system'
 * 驱动。删掉一个,宽度问题和"这俩什么关系"的疑惑一起没了。
 * ============================================================ */

/* 只看顶栏那一段。新建对话弹窗里也有个 System Mode 勾选,
   那是**设定初值**的地方,和顶栏这个"随时切换"是两回事,不该被算进来。 */
const header = chat.slice(chat.indexOf('<div className="chat-header">'), chat.indexOf('<TeamBar'));

test('系统权限状态只显示一处', () => {
  /* 一个状态两个控件,除了占地方,还会让人以为是两件事 ——
     "我是不是要把两个都打开?" */
  assert.ok(!/badge system-mode/.test(header), '独立的「系统权限」徽标应该已经并入开关');
  // 顶栏里只有一个权限控件:数按钮,不数状态判断(className/文案各要判一次)
  const controls = header.match(/changePermissionMode\(/g) || [];
  assert.equal(controls.length, 1, `顶栏出现 ${controls.length} 个权限控件`);
});

test('权限开关有明确的开/关文案,不是只靠勾选框', () => {
  /* 复选框勾没勾,在深色主题下要凑近看;
     而这个开关决定的是"能不能动工作目录外的东西"。 */
  assert.match(chat, /🔓 系统权限/);
  assert.match(chat, /🔒 工作区/);
});

test('开着系统权限时是红的', () => {
  // 能改工作目录之外的文件和服务,这个必须一眼看出来
  assert.match(chat, /permissionMode === 'system' \? ' on danger' : ''/);
  const block = css.slice(css.indexOf('.chip-toggle.on.danger'));
  assert.match(block.slice(0, 200), /var\(--red\)/);
});

test('跑着的时候不能改权限', () => {
  // 中途换权限模式,这一轮到底按哪个跑说不清
  const seg = chat.slice(chat.indexOf('🔓 系统权限') - 600, chat.indexOf('🔓 系统权限'));
  assert.match(seg, /disabled=\{running\}/);
});

/* ---------------------------------------------- 宽度封顶 */

test('标题和路径都有宽度上限', () => {
  /* 这次是路径和标题一起把行撑爆的。只封一个,换个长标题就复发。 */
  for (const sel of ['.conv-title', '.conv-cwd']) {
    const block = css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
    assert.match(block, /max-width/, `${sel} 缺宽度上限`);
    assert.match(block, /min-width: 0/, `${sel} 缺 min-width: 0,flex 里挤不动`);
  }
});

test('顶栏仍然允许换行', () => {
  /* 窄窗口下换行是**对的** —— 不换行的话控件会被裁掉、点不到,
     那比多一行严重得多。我们要做的是让它在正常宽度下不换,
     而不是禁止换行。 */
  const block = css.slice(css.indexOf('.chat-header {'), css.indexOf('}', css.indexOf('.chat-header {')));
  assert.match(block, /flex-wrap: wrap/);
});
