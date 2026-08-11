const test = require('node:test');
const assert = require('node:assert');
const {
  buildBriefPrompt, extractBriefJson, normalizeBrief, isBriefEmpty, todayKey, sliceJsonObject
} = require('../electron/brief');

test('提示词包含四个栏目与"不要编造链接"的约束', () => {
  const p = buildBriefPrompt({ date: '2026-07-28', topics: 'Agent' });
  for (const k of ['news', 'ideas', 'papers', 'repos']) assert.ok(p.includes(k));
  assert.match(p, /2026-07-28/);
  assert.match(p, /特别关注方向:Agent/);
  assert.match(p, /不要编|不确定就不要编/);
});

test('extractBriefJson 能剥掉 ```json 围栏与前后废话', () => {
  const output = `好的,我检索完了。\n\`\`\`json\n{"news":[{"title":"A","url":"https://x.com/a"}],"ideas":[],"papers":[],"repos":[]}\n\`\`\`\n以上。`;
  const parsed = extractBriefJson(output);
  assert.equal(parsed.news[0].title, 'A');
});

test('extractBriefJson 容忍无围栏、尾随逗号', () => {
  const output = '结果如下 {"news":[{"title":"B"},],"ideas":[],"papers":[],"repos":[]} 完毕';
  assert.equal(extractBriefJson(output).news[0].title, 'B');
});

test('sliceJsonObject 不被字符串内的花括号迷惑', () => {
  const raw = '{"a":"内含 } 花括号","b":{"c":1}}';
  assert.equal(sliceJsonObject(`噪声${raw}噪声`), raw);
});

test('解析失败时返回 null(而不是抛错或给假数据)', () => {
  assert.equal(extractBriefJson('模型说:我搜不到,抱歉'), null);
  assert.equal(extractBriefJson(''), null);
  assert.equal(extractBriefJson('{ 这不是合法 json '), null);
});

test('normalizeBrief 丢弃脏数据并拦截非 http 链接', () => {
  const out = normalizeBrief({
    news: [
      { title: 'GPT 新版', summary: '  多行\n  摘要 ', url: 'https://ok.com/a', source: '官方博客' },
      { title: '', summary: '无标题应被丢弃', url: 'https://x.com' },
      { title: '危险链接', url: 'javascript:alert(1)' },
      'not-an-object'
    ],
    ideas: [{ title: '点子', basis: '基于 X' }],
    papers: [{ title: '论文', authors: '张三' }],
    repos: [{ name: 'awesome/repo', lang: 'Rust', stars: '1.2k', url: 'https://github.com/a/b' }],
    junk: [{ title: '不该出现' }]
  });
  assert.equal(out.news.length, 2);                       // 空标题那条被丢
  assert.equal(out.news[0].summary, '多行 摘要');          // 空白归一
  assert.equal(out.news[1].url, '');                       // javascript: 被拦掉
  assert.equal(out.ideas[0].meta, '基于 X');
  assert.equal(out.papers[0].meta, '张三');
  assert.equal(out.repos[0].title, 'awesome/repo');        // name 映射到 title
  assert.equal(out.repos[0].meta, 'Rust · 1.2k');
  assert.deepEqual(Object.keys(out), ['news', 'ideas', 'papers', 'repos']); // 未知栏目不透传
});

test('isBriefEmpty 用于判定这次跑失败', () => {
  assert.ok(isBriefEmpty({ news: [], ideas: [], papers: [], repos: [] }));
  assert.ok(isBriefEmpty(null));
  assert.ok(!isBriefEmpty({ news: [{ title: 'x' }], ideas: [], papers: [], repos: [] }));
});

test('todayKey 用本地时区,避免 UTC 导致"今天"错位', () => {
  assert.equal(todayKey(new Date(2026, 0, 5, 1, 30)), '2026-01-05');
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
});
