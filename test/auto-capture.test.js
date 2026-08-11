const test = require('node:test');
const assert = require('node:assert');
const { parseTime, msUntilNext, shouldCatchUp, dayKey } = require('../electron/autoCapture');
const { mergeNoteContent, buildDailyExtractPrompt } = require('../electron/obsidianNotes');

/* ---------------- 调度时间 ---------------- */

test('parseTime 解析 HH:MM,非法值回落默认', () => {
  assert.deepEqual(parseTime('08:30'), { hour: 8, minute: 30 });
  assert.deepEqual(parseTime('9:05'), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime('25:00'), { hour: 22, minute: 0 });
  assert.deepEqual(parseTime('乱写'), { hour: 22, minute: 0 });
});

test('msUntilNext:未到点排今天,已过点排明天', () => {
  const now = new Date(2026, 6, 28, 10, 0, 0);
  assert.equal(msUntilNext('22:00', now), 12 * 3600 * 1000);      // 今天 22:00
  assert.equal(msUntilNext('09:00', now), 23 * 3600 * 1000);      // 明天 09:00
  // 恰好等于当前时刻 -> 顺延到明天,避免立刻重复触发
  assert.equal(msUntilNext('10:00', now), 24 * 3600 * 1000);
});

test('shouldCatchUp:关机错过当天那次,下次启动应补跑', () => {
  const now = new Date(2026, 6, 28, 23, 0, 0);
  // 今天没跑过 -> 补跑
  assert.ok(shouldCatchUp({ time: '22:00', lastRunDate: '2026-07-27' }, now));
  // 今天已跑过 -> 不补
  assert.ok(!shouldCatchUp({ time: '22:00', lastRunDate: '2026-07-28' }, now));
  // 还没到点 -> 不补(等定时器)
  assert.ok(!shouldCatchUp({ time: '22:00', lastRunDate: '2026-07-27' }, new Date(2026, 6, 28, 9, 0, 0)));
});

test('dayKey 用本地时区', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 1, 30)), '2026-01-05');
});

/* ---------------- 追加式合并(持续沉淀的核心) ---------------- */

test('已有笔记按日期追加补充,原文与手改完整保留', () => {
  const existing = '---\ntitle: SSH 通道耗尽\n---\n\n# SSH 通道耗尽\n\n旧结论\n\n## 我的批注\n手写内容\n';
  const merged = mergeNoteContent(existing, {
    title: 'SSH 通道耗尽', summary: '新结论', points: ['新要点'], links: ['sshd 配置']
  }, '2026-07-28');
  assert.match(merged, /旧结论/);        // 原文保留
  assert.match(merged, /手写内容/);      // 手改保留
  assert.match(merged, /## 补充 2026-07-28/);
  assert.match(merged, /- 新要点/);
  assert.match(merged, /- 关联 \[\[sshd 配置\]\]/);
});

test('重复的要点不再堆积(同一条经验反复出现时)', () => {
  const existing = '# T\n\n## 补充 2026-07-27\n- 已经记过的要点\n';
  const merged = mergeNoteContent(existing, { title: 'T', points: ['已经记过的要点'] }, '2026-07-28');
  assert.equal((merged.match(/已经记过的要点/g) || []).length, 1);
  assert.ok(!merged.includes('## 补充 2026-07-28')); // 没有新内容就不加空块
});

test('笔记不存在时走正常渲染', () => {
  const created = mergeNoteContent('', { title: '新概念', summary: 's', points: ['p'] }, '2026-07-28');
  assert.match(created, /^---\n/);
  assert.match(created, /# 新概念/);
});

test('自链在合并时同样被排除', () => {
  const merged = mergeNoteContent('# A\n\n正文\n', { title: 'A', links: ['A', 'B'] }, '2026-07-28');
  assert.ok(!merged.includes('[[A]]'));
  assert.match(merged, /\[\[B\]\]/);
});

/* ---------------- 每日抽取提示词 ---------------- */

test('每日提示词强调复用已有标题(否则图谱会碎成孤点)', () => {
  const p = buildDailyExtractPrompt({
    date: '2026-07-28',
    conversations: [{ title: '排查', content: '内容' }],
    existingTitles: ['SSH 通道耗尽', 'sshd 配置']
  });
  assert.match(p, /2026-07-28/);
  assert.match(p, /- SSH 通道耗尽/);
  assert.match(p, /优先复用这些标题/);
  assert.match(p, /必须用完全相同的标题/);
  assert.match(p, /不要沉淀/);          // 明确排除流水账
  assert.match(p, /宁缺毋滥/);
});

test('没有已有笔记时提示词也能正常生成', () => {
  const p = buildDailyExtractPrompt({ date: '2026-07-28', conversations: [], existingTitles: [] });
  assert.match(p, /\(暂无\)/);
});
