/**
 * Obsidian 知识库写入 —— 纯逻辑部分(渲染/净化/合并/提示词)。
 *
 * 知识图谱的关键不是"把文字存进去",而是**原子笔记 + 双向链接 + 主题索引(MOC)**:
 * 一个概念一篇短笔记,彼此 [[双链]],再由 MOC 汇总 —— 这样 Obsidian 的图谱视图才会真的长出来。
 *
 * 这里全部是纯函数,便于单测(写文件那部分在 obsidian.js)。
 */
const { sliceJsonObject } = require('./brief');

/** Obsidian/文件系统都安全的笔记名:去掉非法字符与路径穿越 */
function sanitizeNoteName(name) {
  let s = String(name || '').trim();
  // 换行、路径分隔、Windows 非法字符、Obsidian 链接语法字符
  s = s.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\.{2,}/g, '.')      // 防 ../
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, ''); // 首尾点与空白
  s = s.slice(0, 80).trim();
  return s || '未命名笔记';
}

/** YAML frontmatter;值里有特殊字符时加引号 */
function renderFrontmatter(fields = {}) {
  const esc = (v) => {
    const s = String(v);
    return /[:#\-{}[\],&*?|>%@`"']|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${esc(item)}`);
    } else lines.push(`${k}: ${esc(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** 标签净化:Obsidian 标签不能有空格 */
function normalizeTags(tags = []) {
  return [...new Set((Array.isArray(tags) ? tags : [])
    .map((t) => String(t || '').trim().replace(/^#/, '').replace(/\s+/g, '-'))
    .filter(Boolean)
    .map((t) => t.slice(0, 40)))].slice(0, 12);
}

/**
 * 渲染一篇原子笔记。
 * @param note {title, summary, points[], links[], tags[], source, sourceUrl, created}
 */
function renderNote(note = {}) {
  const title = sanitizeNoteName(note.title);
  const links = [...new Set((note.links || []).map(sanitizeNoteName).filter((l) => l && l !== title))];
  const fm = renderFrontmatter({
    title,
    tags: normalizeTags(note.tags),
    source: note.source || 'Remote Agent Studio',
    url: note.sourceUrl || '',
    created: note.created || new Date().toISOString().slice(0, 10)
  });
  const body = [fm, '', `# ${title}`, ''];
  if (note.summary) body.push(String(note.summary).trim(), '');
  const points = (note.points || []).map((p) => String(p).trim()).filter(Boolean);
  if (points.length) {
    body.push('## 要点', ...points.map((p) => `- ${p}`), '');
  }
  if (links.length) {
    body.push('## 关联', ...links.map((l) => `- [[${l}]]`), '');
  }
  if (note.sourceUrl) body.push('## 来源', note.sourceUrl, '');
  return body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const MOC_BEGIN = '<!-- ras:auto-index:begin -->';
const MOC_END = '<!-- ras:auto-index:end -->';

/**
 * 主题索引(MOC)增量合并:只重写受管区块,用户手写的内容原样保留。
 * @param existing 已存在的 MOC 全文(没有则传 '')
 * @param entries [{title, summary}]
 */
function mergeMoc(existing, entries = [], { title = '知识索引' } = {}) {
  const items = entries
    .map((e) => ({ title: sanitizeNoteName(e.title), summary: String(e.summary || '').trim() }))
    .filter((e) => e.title);

  const prev = String(existing || '');
  // 合并已有条目,避免重复
  const known = new Set();
  const blockMatch = prev.match(new RegExp(`${MOC_BEGIN}([\\s\\S]*?)${MOC_END}`));
  const prevLines = blockMatch ? blockMatch[1].split('\n').filter((l) => l.trim().startsWith('- [[')) : [];
  for (const line of prevLines) {
    const m = line.match(/\[\[([^\]]+)\]\]/);
    if (m) known.add(m[1]);
  }
  const merged = [...prevLines];
  for (const item of items) {
    if (known.has(item.title)) continue;
    known.add(item.title);
    merged.push(`- [[${item.title}]]${item.summary ? ` —— ${item.summary.slice(0, 80)}` : ''}`);
  }
  const block = [MOC_BEGIN, `<!-- 由 Remote Agent Studio 自动维护,块外内容不会被覆盖 -->`, ...merged.sort(), MOC_END].join('\n');

  if (blockMatch) {
    return prev.replace(new RegExp(`${MOC_BEGIN}[\\s\\S]*?${MOC_END}`), block);
  }
  const header = prev.trim() ? prev.trimEnd() + '\n\n' : `${renderFrontmatter({ title, tags: ['MOC'] })}\n\n# ${title}\n\n`;
  return `${header}${block}\n`;
}

/**
 * 合并写入:已有笔记不覆盖,按日期追加「补充」块。
 * 持续沉淀必须是追加式 —— 否则每天跑一次就会冲掉之前的内容和你的手改。
 * 已经记过的要点自动跳过,避免同一条经验反复堆积。
 */
function mergeNoteContent(existing, note, date = new Date().toISOString().slice(0, 10)) {
  const prev = String(existing || '').trim();
  if (!prev) return renderNote({ ...note, created: date });

  const points = (note.points || []).map((p) => String(p).trim()).filter(Boolean);
  const links = [...new Set((note.links || []).map(sanitizeNoteName)
    .filter((l) => l && l !== sanitizeNoteName(note.title)))];
  // 已存在的要点/链接不再重复写
  const fresh = points.filter((p) => !prev.includes(p));
  const freshLinks = links.filter((l) => !prev.includes(`[[${l}]]`));
  const summary = String(note.summary || '').trim();
  const freshSummary = summary && !prev.includes(summary) ? summary : '';
  if (!fresh.length && !freshLinks.length && !freshSummary) return prev + '\n'; // 无新内容,原样保留

  const block = [`## 补充 ${date}`];
  if (freshSummary) block.push(freshSummary, '');
  if (fresh.length) block.push(...fresh.map((p) => `- ${p}`));
  if (freshLinks.length) block.push(...freshLinks.map((l) => `- 关联 [[${l}]]`));
  return `${prev}\n\n${block.join('\n')}\n`;
}

/** 让 agent 把对话/内容提炼成原子笔记的提示词 */
function buildExtractPrompt({ content, topic = '', maxNotes = 8 } = {}) {
  return `请把下面的内容提炼成 Obsidian 原子笔记(用于构建知识图谱)。${topic ? `\n主题背景:${topic}` : ''}

要求:
- 一个概念/实体/结论 = 一篇笔记,最多 ${maxNotes} 篇;宁可少而精,不要把流水账拆成笔记
- title 用名词性短语(如「SSH 通道耗尽」),不要用句子,不要带标点符号
- summary 一到两句话说清"是什么/结论是什么"
- points 列 2~5 条要点(可含关键命令、参数、数字)
- links 填其它笔记的 title(建立双链),只能填本次输出里出现过的 title
- tags 用小写英文或中文短词,不要带空格
- 只输出 JSON,不要任何解释文字

严格按此结构:
{
  "notes": [
    {"title":"","summary":"","points":["",""],"links":[""],"tags":[""]}
  ],
  "moc": "这批笔记归属的主题索引名(一个短语)"
}

内容如下:
---
${String(content || '').slice(0, 12000)}
---`;
}

/**
 * 每日汇总提示词:从当天多段对话里提炼"可复用的经验",而不是流水账。
 * 关键是把**已有笔记标题**给模型,让它优先复用/补充已有笔记 ——
 * 否则每天都造新词,图谱会碎成一地孤点。
 */
function buildDailyExtractPrompt({ date, conversations = [], existingTitles = [], maxNotes = 10 } = {}) {
  const corpus = conversations
    .map((c, i) => `### 对话 ${i + 1}:${c.title || '未命名'}\n${String(c.content || '').slice(0, 6000)}`)
    .join('\n\n');
  const known = existingTitles.slice(0, 200);
  return `你是我的知识管理助手。下面是我 ${date} 的工作对话记录,请从中提炼**可复用的经验**并写成 Obsidian 原子笔记。

只沉淀这些:
- 踩过的坑与解决办法(现象 → 根因 → 处置)
- 技术决策与取舍理由
- 可复用的方法、配置、命令
- 结论性认知

不要沉淀:寒暄、纯过程流水账、一次性的临时操作、没有结论的尝试。

已有笔记标题(**优先复用这些标题来补充内容或建立双链**,不要为同一概念另造新名):
${known.length ? known.map((t) => `- ${t}`).join('\n') : '(暂无)'}

要求:
- 一个概念/经验 = 一篇笔记,最多 ${maxNotes} 篇;宁缺毋滥,今天没有值得沉淀的就返回空数组
- title 用名词性短语,不带标点;若与已有标题指同一概念,**必须用完全相同的标题**
- summary 一到两句话讲清结论
- points 2~5 条可操作的要点(含关键命令/参数/数字)
- links 填其它笔记标题(可以是已有笔记),建立双链
- 只输出 JSON,不要解释文字

严格按此结构:
{
  "notes": [{"title":"","summary":"","points":["",""],"links":[""],"tags":[""]}],
  "moc": "这批笔记归属的主题索引名"
}

对话记录:
---
${corpus.slice(0, 40000)}
---`;
}

/** 从模型输出里提取笔记 JSON(容错围栏/废话/尾随逗号) */
function parseNotesJson(output) {
  const text = String(output || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const candidate of [fenced ? fenced[1] : '', text].filter(Boolean)) {
    const raw = sliceJsonObject(candidate);
    if (!raw) continue;
    for (const attempt of [raw, raw.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && Array.isArray(parsed.notes)) return parsed;
      } catch (_) { /* 试下一种 */ }
    }
  }
  return null;
}

/** 归一化笔记数组:丢弃无标题的,限制数量 */
function normalizeNotes(parsed, { max = 12 } = {}) {
  const list = Array.isArray(parsed?.notes) ? parsed.notes : [];
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const title = sanitizeNoteName(n.title);
    if (!title || title === '未命名笔记') continue;
    out.push({
      title,
      summary: String(n.summary || '').trim().slice(0, 500),
      points: (Array.isArray(n.points) ? n.points : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 8),
      links: (Array.isArray(n.links) ? n.links : []).map(sanitizeNoteName).filter(Boolean).slice(0, 10),
      tags: normalizeTags(n.tags)
    });
    if (out.length >= max) break;
  }
  return { notes: out, moc: sanitizeNoteName(parsed?.moc || '知识索引') };
}

/** 每日速览 -> 一篇归档笔记(带真实链接与双链) */
function renderBriefNote(brief) {
  const date = brief?.date || new Date().toISOString().slice(0, 10);
  const sections = brief?.sections || {};
  const labels = { news: 'AI 资讯', ideas: '产品创意', papers: '最新论文', repos: '开源项目' };
  const fm = renderFrontmatter({
    title: `AI 速览 ${date}`,
    tags: ['AI速览', 'daily'],
    source: brief?.agent || 'Remote Agent Studio',
    created: date
  });
  const body = [fm, '', `# AI 速览 ${date}`, ''];
  for (const [key, label] of Object.entries(labels)) {
    const items = Array.isArray(sections[key]) ? sections[key] : [];
    if (!items.length) continue;
    body.push(`## ${label}`, '');
    for (const it of items) {
      const title = String(it.title || '').trim();
      if (!title) continue;
      body.push(it.url ? `- [${title}](${it.url})` : `- ${title}`);
      if (it.summary) body.push(`  - ${String(it.summary).trim()}`);
      if (it.meta) body.push(`  - \`${String(it.meta).trim()}\``);
    }
    body.push('');
  }
  body.push('---', `> 由 Remote Agent Studio 于 ${new Date().toLocaleString()} 归档`, '');
  return body.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = {
  sanitizeNoteName, renderFrontmatter, normalizeTags, renderNote, mergeNoteContent,
  mergeMoc, MOC_BEGIN, MOC_END,
  buildExtractPrompt, buildDailyExtractPrompt, parseNotesJson, normalizeNotes, renderBriefNote
};
