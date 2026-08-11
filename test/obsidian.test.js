const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sanitizeNoteName, renderFrontmatter, normalizeTags, renderNote,
  mergeMoc, MOC_BEGIN, MOC_END, parseNotesJson, normalizeNotes, renderBriefNote
} = require('../electron/obsidianNotes');
const { notePath, sanitizeRelFolder, assertInsideVault } = require('../electron/obsidian');

test('文件名净化:挡住路径穿越与非法字符', () => {
  assert.equal(sanitizeNoteName('../../etc/passwd'), 'etc passwd');
  assert.equal(sanitizeNoteName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(sanitizeNoteName('  ..  '), '未命名笔记');
  assert.equal(sanitizeNoteName(''), '未命名笔记');
  // Obsidian 链接语法字符也要去掉,否则双链会错乱
  assert.equal(sanitizeNoteName('SSH [[通道]] #标签'), 'SSH 通道 标签');
});

test('相对目录净化不允许逃出 vault', () => {
  assert.equal(sanitizeRelFolder('../../outside'), 'outside');
  assert.equal(sanitizeRelFolder('Notes/AI/Daily'), 'Notes/AI/Daily');
  assert.equal(sanitizeRelFolder(''), 'RemoteAgentStudio');
});

test('assertInsideVault 拒绝 vault 之外的目标', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  assert.doesNotThrow(() => assertInsideVault(vault, path.join(vault, 'a/b.md')));
  assert.throws(() => assertInsideVault(vault, path.join(vault, '../evil.md')), /vault 之外/);
});

test('frontmatter 对特殊字符加引号,空值跳过', () => {
  const fm = renderFrontmatter({ title: 'a: b', tags: ['x', 'y'], empty: '', nul: null });
  assert.match(fm, /title: "a: b"/);
  assert.match(fm, /tags:\n {2}- x\n {2}- y/);
  assert.ok(!fm.includes('empty'));
  assert.ok(!fm.includes('nul'));
});

test('标签净化:去 # 去空格去重限量', () => {
  assert.deepEqual(normalizeTags(['#AI', 'AI', 'multi word', '  ']), ['AI', 'multi-word']);
});

test('renderNote 产出双链与要点,并排除自链', () => {
  const md = renderNote({
    title: 'SSH 通道耗尽', summary: 'MaxSessions 占满导致新命令开不出通道',
    points: ['默认 MaxSessions 10', '关闭多余终端标签可缓解'],
    links: ['SSH 通道耗尽', 'sshd 配置'], tags: ['ssh', 'debug'], created: '2026-07-28'
  });
  assert.match(md, /^---\n/);
  assert.match(md, /# SSH 通道耗尽/);
  assert.match(md, /- 默认 MaxSessions 10/);
  assert.match(md, /- \[\[sshd 配置\]\]/);
  assert.ok(!md.includes('[[SSH 通道耗尽]]')); // 不自链
});

test('MOC 增量合并:保留用户手写内容,不重复收录', () => {
  const first = mergeMoc('', [{ title: 'A', summary: 'aa' }], { title: '索引' });
  assert.ok(first.includes(MOC_BEGIN) && first.includes(MOC_END));
  assert.match(first, /- \[\[A\]\] —— aa/);

  // 用户在块外加了自己的话
  const edited = first + '\n## 我的备注\n手写内容不该被删\n';
  const second = mergeMoc(edited, [{ title: 'A' }, { title: 'B', summary: 'bb' }]);
  assert.match(second, /手写内容不该被删/);            // 块外保留
  assert.equal((second.match(/\[\[A\]\]/g) || []).length, 1); // A 不重复
  assert.match(second, /\[\[B\]\]/);
});

test('parseNotesJson 容错围栏与废话;结构不对返回 null', () => {
  const ok = parseNotesJson('说明\n```json\n{"notes":[{"title":"X"}],"moc":"索引"}\n```\n完');
  assert.equal(ok.notes[0].title, 'X');
  assert.equal(parseNotesJson('{"foo":1}'), null);   // 没有 notes 数组
  assert.equal(parseNotesJson('模型摆烂了'), null);
});

test('normalizeNotes 丢弃无标题项并净化字段', () => {
  const { notes, moc } = normalizeNotes({
    notes: [
      { title: 'A/B', summary: ' s ', points: ['p', ''], links: ['C'], tags: ['#t'] },
      { title: '   ' },
      'garbage'
    ],
    moc: '我的/索引'
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'A B');
  assert.deepEqual(notes[0].points, ['p']);
  assert.deepEqual(notes[0].tags, ['t']);
  assert.equal(moc, '我的 索引');
});

test('速览笔记含真实链接与分区', () => {
  const md = renderBriefNote({
    date: '2026-07-28', agent: 'codex',
    sections: {
      news: [{ title: '某模型发布', summary: '摘要', url: 'https://x.com/a' }],
      repos: [{ title: 'owner/repo', url: 'https://github.com/o/r', meta: 'Rust · 1k' }],
      ideas: [], papers: []
    }
  });
  assert.match(md, /# AI 速览 2026-07-28/);
  assert.match(md, /## AI 资讯/);
  assert.match(md, /\[某模型发布\]\(https:\/\/x\.com\/a\)/);
  assert.match(md, /## 开源项目/);
  assert.ok(!md.includes('## 产品创意')); // 空栏目不留空壳
});

test('notePath 组合出安全的相对路径', () => {
  assert.equal(notePath('RemoteAgentStudio', '我的 笔记'), 'RemoteAgentStudio/我的 笔记.md');
  assert.equal(notePath('../evil', '../../x'), 'evil/x.md');
});
