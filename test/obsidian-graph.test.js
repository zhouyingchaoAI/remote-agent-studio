const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/tmp');
const {
  extractLinks, extractTags, extractTitle, buildGraph, scanVault
} = require('../electron/obsidianGraph');

test('抽取双链:兼容别名、锚点、块引用', () => {
  const md = '见 [[SSH 通道耗尽]] 与 [[sshd 配置|配置详解]],还有 [[某笔记#小节]] 和 [[某笔记^块]]';
  assert.deepEqual(extractLinks(md), ['SSH 通道耗尽', 'sshd 配置', '某笔记']);
});

test('代码块/行内代码里的双链不算真链接', () => {
  const md = '正文 [[真链接]]\n```\n[[代码块里的]]\n```\n行内 `[[行内代码里的]]`';
  assert.deepEqual(extractLinks(md), ['真链接']);
});

test('抽取标签:frontmatter 数组、列表与正文 #tag', () => {
  const listStyle = '---\ntitle: A\ntags:\n  - ssh\n  - debug\n---\n正文 #运维 内容';
  assert.deepEqual(extractTags(listStyle).sort(), ['debug', 'ssh', '运维']);

  const inlineStyle = '---\ntags: [a, "b"]\n---\n正文';
  assert.deepEqual(extractTags(inlineStyle).sort(), ['a', 'b']);
});

test('Markdown 标题不会被误当成标签', () => {
  assert.deepEqual(extractTags('# 这是标题\n## 二级标题\n正文'), []);
});

test('标题优先取 frontmatter,其次文件名', () => {
  assert.equal(extractTitle('---\ntitle: 正式标题\n---\n', '文件名'), '正式标题');
  assert.equal(extractTitle('没有 frontmatter', '文件名'), '文件名');
});

test('构建图:边、反向链接、度数都正确', () => {
  const g = buildGraph([
    { relPath: 'a.md', name: 'A.md', content: '连到 [[B]]' },
    { relPath: 'b.md', name: 'B.md', content: '连回 [[A]] 和 [[C]]' },
    { relPath: 'c.md', name: 'C.md', content: '孤零零' }
  ]);
  assert.equal(g.stats.notes, 3);
  assert.equal(g.stats.links, 3);           // A→B, B→A, B→C
  const c = g.nodes.find((n) => n.id === 'C');
  assert.deepEqual(c.backlinks, ['B']);
  assert.equal(c.degree, 1);                // 有反向链接就不算孤立
});

test('孤立笔记与断链能被识别(图谱健康度的关键指标)', () => {
  const g = buildGraph([
    { relPath: 'a.md', name: 'A.md', content: '指向不存在的 [[幽灵笔记]]' },
    { relPath: 'x.md', name: 'X.md', content: '谁也不连' }
  ]);
  // A 的唯一出链是断链,在图上没有任何真实连接 -> 同样算孤立(这正是需要用户去修的情况)
  assert.deepEqual(g.orphans.sort(), ['A', 'X']);
  assert.equal(g.stats.broken, 1);
  assert.deepEqual(g.broken[0], { from: 'A', to: '幽灵笔记' });
});

test('自链不产生边(避免自己指自己)', () => {
  const g = buildGraph([{ relPath: 'a.md', name: 'A.md', content: '[[A]]' }]);
  assert.equal(g.stats.links, 0);
});

test('标题匹配忽略大小写', () => {
  const g = buildGraph([
    { relPath: 'a.md', name: 'Alpha.md', content: '连到 [[beta]]' },
    { relPath: 'b.md', name: 'Beta.md', content: '' }
  ]);
  assert.equal(g.stats.links, 1);
  assert.equal(g.stats.broken, 0);
});

test('标签统计按出现次数降序', () => {
  const g = buildGraph([
    { relPath: '1.md', name: '1.md', content: '---\ntags: [ssh, x]\n---' },
    { relPath: '2.md', name: '2.md', content: '---\ntags: [ssh]\n---' }
  ]);
  assert.equal(g.tags[0].tag, 'ssh');
  assert.equal(g.tags[0].count, 2);
});

test('扫描真实目录:跳过 .obsidian,统计正确', () => {
  const vault = tmpDir('vault-graph-');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{}');
  fs.mkdirSync(path.join(vault, 'RAS'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'RAS', 'SSH 通道耗尽.md'), '---\ntags: [ssh]\n---\n见 [[sshd 配置]]');
  fs.writeFileSync(path.join(vault, 'RAS', 'sshd 配置.md'), '回指 [[SSH 通道耗尽]]');
  fs.writeFileSync(path.join(vault, '独立笔记.md'), '无链接');

  const all = scanVault(vault);
  assert.equal(all.stats.notes, 3);
  assert.equal(all.stats.links, 2);
  assert.deepEqual(all.orphans, ['独立笔记']);

  // 限定子目录时不含 vault 根下的笔记
  const scoped = scanVault(vault, { subFolder: 'RAS' });
  assert.equal(scoped.stats.notes, 2);
  assert.equal(scoped.stats.orphans, 0);
});

test('vault 不存在时返回空图并带错误说明,不抛异常', () => {
  const g = scanVault('/definitely/not/exist');
  assert.equal(g.stats.notes, 0);
  assert.match(g.error, /找不到|未配置/);
});
