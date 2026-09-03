const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('卸载终端视图时关闭远程 shell，避免切换页面累积 SSH 通道', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', 'TerminalPanel.jsx'),
    'utf8'
  );
  const cleanup = source.match(/return \(\) => \{([\s\S]*?)\n    \};\n  \}, \[hostId, termId\]\);/);

  assert.ok(cleanup, 'TermView 应有依赖 hostId/termId 的卸载清理函数');
  assert.match(
    cleanup[1],
    /window\.api\.term\.close\(\{ hostId, termId \}\)/,
    '页面切走时必须关闭远程 shell，归还 SSH 通道'
  );
});
