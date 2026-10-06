const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CHAT_FILES } = require('./helpers/chatSource');

const dir = path.join(__dirname, '..', 'src', 'components');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

/* ============================================================
 * ChatPanel 拆分后的结构约束。
 *
 * 1850 行、24 个组件拆成了 7 个文件。拆的方式是按 AST 节点整段搬,
 * 行为不变。这里守的是**别再长回去**和**别成环**。
 * ============================================================ */

test('拆出来的文件都在', () => {
  for (const f of CHAT_FILES) assert.ok(fs.existsSync(path.join(dir, f)), `${f} 不存在`);
});

test('拆出来的组件不反向 import ChatPanel', () => {
  /* 子组件 import 父文件 = 循环依赖。Vite 能编译过,但模块初始化顺序
     会变得取决于谁先被加载 —— 有时是 undefined,而且只在某些入口下复现。 */
  for (const f of CHAT_FILES.filter((x) => x !== 'ChatPanel.jsx')) {
    assert.ok(!/from '\.\/ChatPanel\.jsx'/.test(read(f)), `${f} 反向依赖了 ChatPanel`);
  }
});

test('每个拆出的文件有显式的 export 列表', () => {
  // 显式列表让"这个文件对外提供什么"一眼可见,也挡住误导出内部函数
  for (const f of CHAT_FILES.filter((x) => x !== 'ChatPanel.jsx')) {
    assert.match(read(f), /^export \{ [^}]+ \};$/m, `${f} 没有显式 export 列表`);
  }
});

test('ChatPanel 自己不再超过 1000 行', () => {
  /* 不是精确数字,是个闸:再往里堆功能时这条会提醒"该拆出去了"。
     拆之前是 1850 行。 */
  const lines = read('ChatPanel.jsx').split('\n').length;
  assert.ok(lines < 1000, `ChatPanel.jsx 又长到 ${lines} 行了`);
});
