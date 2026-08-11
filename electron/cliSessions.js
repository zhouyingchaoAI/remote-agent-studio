/**
 * 读取 Claude Code / Codex CLI 在**所有项目**下积累的历史会话。
 *
 * 这些才是经验的大头 —— 本应用自己的对话只是其中一小部分。
 *   Claude Code: ~/.claude/projects/<路径转义>/<session-id>.jsonl
 *   Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * ⚠️ 这些是 CLI 的内部格式,官方明确说过会随版本变化。
 * 所以这里全程防御式解析:认字段不认版本,单行坏了就跳过,
 * 任何一处解析失败都不能影响整体沉淀。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Claude Code 把工作目录路径里的非字母数字替换成 '-' 作为目录名,这里尽量还原 */
function decodeProjectDir(name) {
  const s = String(name || '');
  // 形如 -Users-me-code-myproject -> /Users/me/code/myproject(无法 100% 还原,够用即可)
  if (s.startsWith('-')) return s.replace(/-/g, '/');
  return s;
}

/** 从一条消息事件里抽出可读文本(兼容 string / content 数组 / 各种字段名) */
function textFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const msg = ev.message || ev;
  const role = ev.type === 'user' || msg.role === 'user' ? '我'
    : (ev.type === 'assistant' || msg.role === 'assistant' ? 'AI' : '');
  if (!role) return '';

  const content = msg.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') return `[工具] ${b.name || ''} ${JSON.stringify(b.input || {}).slice(0, 160)}`;
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content
          : (Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join(' ') : '');
        return c ? `[结果] ${String(c).slice(0, 200)}` : '';
      }
      return '';
    }).filter(Boolean).join('\n');
  } else if (typeof msg.text === 'string') text = msg.text;

  text = String(text || '').trim();
  return text ? `【${role}】${text}` : '';
}

/** 解析一个 jsonl 会话文件 -> 纯文本;坏行跳过 */
function parseSessionFile(content, { maxChars = 20000 } = {}) {
  const lines = String(content || '').split('\n');
  const out = [];
  let chars = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(t); } catch (_) { continue; }   // 坏行直接跳过
    const text = textFromEvent(ev);
    if (!text) continue;
    out.push(text);
    chars += text.length;
    if (chars >= maxChars) { out.push('…(已截断)'); break; }
  }
  return out.join('\n');
}

/** 递归找 .jsonl(带数量上限) */
function collectJsonl(root, { max = 2000 } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= max) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * 扫描本机所有项目的 CLI 会话。
 * @returns [{source, project, title, content, mtime}]
 */
function scanLocalSessions({ homeDir = os.homedir(), maxFiles = 500, minChars = 400, sinceDays = 0 } = {}) {
  const results = [];
  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400000 : 0;

  const add = (file, source, project) => {
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return; }
    if (cutoff && stat.mtimeMs < cutoff) return;
    let raw = '';
    try {
      // 单文件可能很大,只读尾部足够的量(近期内容更有价值)
      raw = stat.size > 2 * 1024 * 1024
        ? fs.readFileSync(file, 'utf8').slice(-2 * 1024 * 1024)
        : fs.readFileSync(file, 'utf8');
    } catch (_) { return; }
    const content = parseSessionFile(raw);
    if (content.length < minChars) return;               // 太短的会话没有沉淀价值
    results.push({
      source, project,
      title: `${project} · ${path.basename(file).replace(/\.jsonl$/i, '').slice(0, 40)}`,
      content, mtime: stat.mtimeMs
    });
  };

  // Claude Code:按项目目录组织
  const claudeRoot = path.join(homeDir, '.claude', 'projects');
  if (fs.existsSync(claudeRoot)) {
    let dirs = [];
    try { dirs = fs.readdirSync(claudeRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) {}
    for (const d of dirs) {
      const project = decodeProjectDir(d.name);
      for (const f of collectJsonl(path.join(claudeRoot, d.name), { max: maxFiles })) {
        add(f, 'claude', project);
      }
    }
  }

  // Codex:按日期组织,项目信息在会话内部,这里用日期作分组名
  const codexRoot = path.join(homeDir, '.codex', 'sessions');
  if (fs.existsSync(codexRoot)) {
    for (const f of collectJsonl(codexRoot, { max: maxFiles })) {
      add(f, 'codex', 'Codex 会话');
    }
  }

  // 新的在前更有价值,但沉淀时要正序(老的先建笔记),这里先按时间正序返回
  return results.sort((a, b) => a.mtime - b.mtime).slice(-maxFiles);
}

/** 统计概览(供界面预估规模) */
function summarize(sessions = []) {
  const byProject = {};
  let chars = 0;
  for (const s of sessions) {
    byProject[s.project] = (byProject[s.project] || 0) + 1;
    chars += s.content.length;
  }
  return {
    sessions: sessions.length,
    chars,
    projects: Object.keys(byProject).length,
    topProjects: Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([project, count]) => ({ project, count }))
  };
}

/* ---------------- 远程主机上的 CLI 会话 ---------------- */

const REMOTE_MARK = '===RAS_SESSION===';

/**
 * 第一步:列出远程的会话文件(时间戳 + 大小 + 路径)。
 * 默认不做时间过滤、上限给得很宽 —— 目标是「全部历史都要提炼」;
 * 这一步只传路径不传内容,再多也很轻。
 */
function buildRemoteListCommand({ maxFiles = 5000, sinceDays = 0 } = {}) {
  const timeFilter = sinceDays > 0 ? `-mtime -${sinceDays} ` : '';
  // GNU find 有 -printf;没有则退回 stat,两种都试一遍
  return [
    'for d in "$HOME/.claude/projects" "$HOME/.codex/sessions"; do',
    '  [ -d "$d" ] || continue;',
    `  find "$d" -name '*.jsonl' -type f ${timeFilter}-printf '%T@|%s|%p\\n' 2>/dev/null ||`,
    `  find "$d" -name '*.jsonl' -type f ${timeFilter}2>/dev/null | while read -r f; do`,
    '    printf "%s|%s|%s\\n" "$(stat -c %Y "$f" 2>/dev/null)" "$(stat -c %s "$f" 2>/dev/null)" "$f";',
    '  done;',
    `done | sort -rn | head -n ${maxFiles}`
  ].join('\n');
}

/**
 * 把文件切成多页,每页控制在传输预算内。
 * 「全部提炼」不能靠一次拉完(几十上百 MB 会卡死 SSH),
 * 而是分页拉 → 分页提炼 → 分页入库,内存与带宽都可控。
 */
function pageRemoteFiles(files, { pageBudget = 1500000, perFile = 400000 } = {}) {
  const pages = [];
  let cur = [], used = 0;
  for (const f of files) {
    const take = Math.min(f.size, perFile);
    if (used + take > pageBudget && cur.length) { pages.push(cur); cur = []; used = 0; }
    cur.push({ ...f, take });
    used += take;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/**
 * 远程诊断:直接把「会话记录到底在不在、在哪、有多少」查清楚。
 * 与其猜路径不对还是权限不对,不如把真实情况原样打出来。
 */
function buildRemoteDiagnoseCommand() {
  return [
    'echo "HOME=$HOME"; echo "USER=$(whoami)";',
    'for d in "$HOME/.claude" "$HOME/.claude/projects" "$HOME/.codex" "$HOME/.codex/sessions"; do',
    '  if [ -d "$d" ]; then',
    '    n=$(find "$d" -name "*.jsonl" -type f 2>/dev/null | wc -l);',
    '    echo "DIR|$d|存在|jsonl数=$n";',
    '  else echo "DIR|$d|不存在|"; fi;',
    'done;',
    // 列几个样本路径,便于确认目录结构是否如预期
    'find "$HOME/.claude/projects" "$HOME/.codex/sessions" -name "*.jsonl" -type f 2>/dev/null | head -5 | while read -r f; do',
    '  echo "SAMPLE|$f|$(wc -c < "$f" 2>/dev/null)";',
    'done;',
    // 也看看有没有装 CLI(没装过自然没有会话)
    'for c in claude codex grok; do',
    '  p=$(command -v $c 2>/dev/null); echo "CLI|$c|${p:-未安装}";',
    'done'
  ].join('\n');
}

/** 解析诊断输出 */
function parseRemoteDiagnose(stdout) {
  const out = { home: '', user: '', dirs: [], samples: [], clis: [] };
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (t.startsWith('HOME=')) out.home = t.slice(5);
    else if (t.startsWith('USER=')) out.user = t.slice(5);
    else if (t.startsWith('DIR|')) {
      const [, dir, exists, extra] = t.split('|');
      out.dirs.push({ dir, exists: exists === '存在', count: Number((extra || '').split('=')[1] || 0) });
    } else if (t.startsWith('SAMPLE|')) {
      const [, file, size] = t.split('|');
      out.samples.push({ file, size: Number(size || 0) });
    } else if (t.startsWith('CLI|')) {
      const [, name, path] = t.split('|');
      out.clis.push({ name, path });
    }
  }
  out.totalJsonl = out.dirs.reduce((n, d) => n + (d.count || 0), 0);
  return out;
}

/** 列出远程会话文件(只拿元信息,不传内容) */
async function listRemoteSessionFiles(exec, opts = {}) {
  if (typeof exec !== 'function') return [];
  try {
    const r = await exec(buildRemoteListCommand(opts));
    return parseRemoteList(r?.stdout);
  } catch (_) { return []; }
}

/** 取回指定一页文件的内容并解析成会话文本 */
async function fetchRemoteSessionPage(exec, page, { minChars = 400, hostLabel = '远程' } = {}) {
  if (!page?.length) return [];
  let fetched = [];
  try {
    const r = await exec(buildRemoteFetchCommand(page));
    fetched = parseRemoteFetch(r?.stdout);
  } catch (_) { return []; }
  const byFile = new Map(page.map((p) => [p.file, p]));
  const out = [];
  for (const f of fetched) {
    const content = parseSessionFile(f.raw, { maxChars: 60000 });
    if (content.length < minChars) continue;
    const project = projectFromRemotePath(f.file);
    out.push({
      source: 'remote',
      project: `${hostLabel}:${project}`,
      title: `${project} · ${f.file.split('/').pop().replace(/\.jsonl$/i, '').slice(0, 40)}`,
      content,
      mtime: byFile.get(f.file)?.mtime || 0
    });
  }
  return out;
}

/** 解析上一步的输出 */
function parseRemoteList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/^([\d.]+)\|(\d+)\|(.+)$/);
    if (!m) continue;
    out.push({ mtime: Math.round(Number(m[1]) * 1000), size: Number(m[2]), file: m[3] });
  }
  return out;
}

/** 第二步:在总字节预算内挑文件,并生成批量读取命令(只取尾部,近期内容更有价值) */
function planRemoteFetch(files, { totalBudget = 1500000, perFile = 40000 } = {}) {
  const picked = [];
  let used = 0;
  for (const f of files) {                       // files 已按时间倒序
    const take = Math.min(f.size, perFile);
    if (used + take > totalBudget) break;
    picked.push({ ...f, take });
    used += take;
  }
  return picked;
}

function buildRemoteFetchCommand(picked) {
  return picked.map((p) =>
    `printf '%s\\n%s\\n' '${REMOTE_MARK}' ${JSON.stringify(p.file)}; tail -c ${p.take} ${JSON.stringify(p.file)}; echo`
  ).join('; ');
}

/** 解析批量读取的输出 -> [{file, content}] */
function parseRemoteFetch(stdout) {
  const chunks = String(stdout || '').split(REMOTE_MARK);
  const out = [];
  for (const chunk of chunks) {
    // 标记后面紧跟换行,先去掉,否则第一行会被解析成空文件名
    const body = chunk.replace(/^\r?\n/, '');
    const nl = body.indexOf('\n');
    if (nl < 0) continue;
    const file = body.slice(0, nl).trim();
    if (!file) continue;
    out.push({ file, raw: body.slice(nl + 1) });
  }
  return out;
}

/** 从远程文件路径推断项目名 */
function projectFromRemotePath(file) {
  const m = String(file).match(/\.claude\/projects\/([^/]+)\//);
  if (m) return decodeProjectDir(m[1]);
  if (String(file).includes('.codex/sessions')) return 'Codex 会话';
  return '远程会话';
}

/**
 * 扫描远程主机上所有项目的 CLI 会话。
 * @param exec 形如 ssh.exec(cmd) -> {stdout}
 */
async function scanRemoteSessions(exec, { minChars = 400, hostLabel = '远程' } = {}) {
  if (typeof exec !== 'function') return [];
  let list = [];
  try {
    const r = await exec(buildRemoteListCommand());
    list = parseRemoteList(r?.stdout);
  } catch (_) { return []; }
  if (!list.length) return [];

  const picked = planRemoteFetch(list);
  if (!picked.length) return [];

  let fetched = [];
  try {
    const r = await exec(buildRemoteFetchCommand(picked));
    fetched = parseRemoteFetch(r?.stdout);
  } catch (_) { return []; }

  const byFile = new Map(picked.map((p) => [p.file, p]));
  const out = [];
  for (const f of fetched) {
    const content = parseSessionFile(f.raw);
    if (content.length < minChars) continue;
    const project = projectFromRemotePath(f.file);
    out.push({
      source: 'remote',
      project: `${hostLabel}:${project}`,
      title: `${project} · ${f.file.split('/').pop().replace(/\.jsonl$/i, '').slice(0, 40)}`,
      content,
      mtime: byFile.get(f.file)?.mtime || 0
    });
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

module.exports = {
  decodeProjectDir, textFromEvent, parseSessionFile, collectJsonl, scanLocalSessions, summarize,
  buildRemoteListCommand, parseRemoteList, planRemoteFetch, buildRemoteFetchCommand,
  parseRemoteFetch, projectFromRemotePath, scanRemoteSessions, REMOTE_MARK,
  pageRemoteFiles, listRemoteSessionFiles, fetchRemoteSessionPage,
  buildRemoteDiagnoseCommand, parseRemoteDiagnose
};
