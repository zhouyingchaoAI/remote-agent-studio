/**
 * Obsidian 知识图谱解析:扫描 vault 里的 .md,抽出双链与标签,构建图数据。
 *
 * 图谱的价值在于**发现结构问题**,所以除了节点和边,还要算出:
 *  - 孤立笔记(没有任何进出链接)—— 自动沉淀最容易产出这种,是图谱"长不起来"的信号
 *  - 断链(指向不存在的笔记)—— 模型编了个标题,或笔记被改名/删除
 * 解析部分是纯函数,便于单测。
 */
const fs = require('fs');
const path = require('path');

const MAX_FILES = 5000;          // 超大 vault 保护
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.smart-env']);

/**
 * 抽取 [[双链]]。兼容:
 *   [[目标]] / [[目标|别名]] / [[目标#小节]] / [[目标^块引用]]
 * 忽略代码块与行内代码里的内容(那多半是示例而非真链接)。
 */
function extractLinks(markdown) {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?```/g, '')   // 代码块
    .replace(/`[^`\n]*`/g, '');       // 行内代码
  const links = [];
  for (const m of text.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const raw = m[1].split('|')[0].split('#')[0].split('^')[0].trim();
    if (raw) links.push(raw);
  }
  return [...new Set(links)];
}

/** 抽取标签:frontmatter 的 tags 与正文里的 #tag */
function extractTags(markdown) {
  const text = String(markdown || '');
  const tags = [];
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const block = fm[1];
    // tags: [a, b] 行内数组
    const inline = block.match(/^tags:\s*\[(.*?)\]/m);
    if (inline) {
      for (const t of inline[1].split(',')) {
        const v = t.trim().replace(/^["']|["']$/g, '');
        if (v) tags.push(v);
      }
    }
    // tags:\n  - a\n  - b 列表
    const listBlock = block.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
    if (listBlock) {
      for (const line of listBlock[1].split('\n')) {
        const v = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
        if (v) tags.push(v);
      }
    }
  }
  // 正文里的 #tag(去掉 frontmatter、代码与标题行)
  const body = text.replace(/^---\n[\s\S]*?\n---/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^#{1,6}\s.*$/gm, '');   // Markdown 标题不是标签
  for (const m of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]{1,40})/gu)) tags.push(m[1]);
  return [...new Set(tags.map((t) => t.replace(/^#/, '')).filter(Boolean))];
}

/** frontmatter 里的 title(有则以它为准,否则用文件名) */
function extractTitle(markdown, fallback) {
  const fm = String(markdown || '').match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^title:\s*(.+)$/m);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  return fallback;
}

/** 递归收集 .md 文件(带跳过与数量上限) */
function collectMarkdown(root, { max = MAX_FILES } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 由「文件列表 + 内容读取器」构建图。抽成纯函数便于单测(不碰真实磁盘)。
 * @param files [{relPath, name, content}]
 */
function buildGraph(files = []) {
  const nodes = new Map(); // key: 小写标题 -> node
  const keyOf = (t) => String(t || '').trim().toLowerCase();

  for (const f of files) {
    const base = String(f.name || '').replace(/\.md$/i, '');
    const title = extractTitle(f.content, base);
    const key = keyOf(title);
    if (!key) continue;
    nodes.set(key, {
      id: title,
      relPath: f.relPath,
      tags: extractTags(f.content),
      links: extractLinks(f.content),
      backlinks: [],
      size: String(f.content || '').length,
      isMoc: /(^|\W)MOC(\W|$)/i.test(String(f.content || '').slice(0, 400)) || /索引$/.test(title)
    });
  }

  const edges = [];
  const broken = [];
  for (const node of nodes.values()) {
    for (const target of node.links) {
      const tKey = keyOf(target);
      const hit = nodes.get(tKey);
      if (hit) {
        if (hit.id !== node.id) {
          edges.push({ source: node.id, target: hit.id });
          hit.backlinks.push(node.id);
        }
      } else {
        broken.push({ from: node.id, to: target });
      }
    }
  }

  const list = [...nodes.values()].map((n) => ({
    ...n,
    degree: n.backlinks.length + edges.filter((e) => e.source === n.id).length
  }));
  const orphans = list.filter((n) => n.degree === 0).map((n) => n.id);

  // 标签分布(用于筛选)
  const tagCount = {};
  for (const n of list) for (const t of n.tags) tagCount[t] = (tagCount[t] || 0) + 1;

  return {
    nodes: list,
    edges,
    broken,
    orphans,
    stats: {
      notes: list.length,
      links: edges.length,
      orphans: orphans.length,
      broken: broken.length,
      tags: Object.keys(tagCount).length
    },
    tags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }))
  };
}

/** 扫描真实 vault 目录并构建图 */
function scanVault(vaultPath, { subFolder = '', max = MAX_FILES } = {}) {
  if (!vaultPath || !fs.existsSync(vaultPath)) {
    return { ...buildGraph([]), error: '未配置或找不到 vault 目录' };
  }
  const root = subFolder ? path.join(vaultPath, subFolder) : vaultPath;
  if (!fs.existsSync(root)) return { ...buildGraph([]), error: `目录不存在:${subFolder}` };

  const files = collectMarkdown(root, { max }).map((full) => {
    let content = '';
    try {
      // 单文件过大时只读前部,避免大附件拖慢扫描
      const stat = fs.statSync(full);
      content = stat.size > 512 * 1024
        ? fs.readFileSync(full, 'utf8').slice(0, 512 * 1024)
        : fs.readFileSync(full, 'utf8');
    } catch (_) {}
    return { relPath: path.relative(vaultPath, full), name: path.basename(full), content };
  });
  const graph = buildGraph(files);
  graph.truncated = files.length >= max;
  graph.scannedAt = Date.now();
  return graph;
}

module.exports = {
  extractLinks, extractTags, extractTitle, buildGraph, scanVault, collectMarkdown, MAX_FILES
};
