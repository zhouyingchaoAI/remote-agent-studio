/**
 * 移动端的项目发现与只读查看。
 *
 * 两条设计红线:
 *  1. 查看类操作走固定命令白名单,不接受手机传来的任意命令 ——
 *     否则「只读查看」就等价于把服务器 shell 接到了微信上。
 *  2. 路径必须落在选定项目目录内,挡住 ../../etc/shadow 这类读取。
 */
const { shellQuote } = require('./ssh/SSHManager');

/* ---------------------------------------------------------------- 项目发现 */

/**
 * 从已有对话里推导项目列表 —— 用过的目录才是真正的项目,
 * 比在磁盘上瞎扫准得多。
 */
function projectsFromConvos(convos = [], hostId) {
  const seen = new Map();
  for (const c of convos) {
    if (c?.hostId !== hostId) continue;
    const cwd = String(c.cwd || '').trim();
    if (!cwd) continue;
    const at = c.updatedAt || c.createdAt || 0;
    const prev = seen.get(cwd);
    if (!prev || at > prev.lastUsed) {
      seen.set(cwd, {
        path: cwd,
        name: cwd.split('/').filter(Boolean).pop() || cwd,
        lastUsed: at,
        source: 'history'
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * 扫描远程主机上的 git 仓库。
 * 限深度是必须的:不限深的 find 在大盘上能跑几分钟,还会翻进 node_modules。
 */
function buildProjectScanCommand({ roots = ['~'], maxDepth = 3, limit = 40 } = {}) {
  const quoted = roots.map((r) => (r.startsWith('~') ? r : shellQuote(r))).join(' ');
  return `find ${quoted} -maxdepth ${maxDepth} -type d -name .git `
    + `-not -path '*/node_modules/*' -not -path '*/.cache/*' 2>/dev/null `
    + `| head -${limit} | sed 's#/\\.git$##'`;
}

function parseProjectScan(stdout = '') {
  return String(stdout || '').split(/\r?\n/)
    .map((s) => s.trim()).filter(Boolean)
    .map((p) => ({ path: p, name: p.split('/').filter(Boolean).pop() || p, lastUsed: 0, source: 'scan' }));
}

/** 历史优先、扫描补充,按路径去重 */
function mergeProjects(fromHistory = [], fromScan = []) {
  const out = [...fromHistory];
  const known = new Set(out.map((p) => p.path));
  for (const p of fromScan) if (!known.has(p.path)) { out.push(p); known.add(p.path); }
  return out;
}

/* ---------------------------------------------------------------- 只读查看 */

/** 允许的查看类型 —— 白名单之外一律拒绝 */
const INSPECT_KINDS = ['status', 'diff', 'log', 'file', 'tail', 'ls'];

/**
 * 路径安全:必须是 cwd 下的相对路径。
 * 手机端没有正当理由去读项目之外的文件。
 */
function safeRelPath(rel = '') {
  const p = String(rel || '').trim();
  if (!p) return '';
  if (p.startsWith('/') || p.startsWith('~')) throw new Error('只能填项目内的相对路径');
  if (p.split('/').includes('..')) throw new Error('路径不能包含 ..');
  if (/[\0\n\r]/.test(p)) throw new Error('路径含非法字符');
  return p;
}

/**
 * 生成只读命令。每一条都是写死的,手机端只能选类型和相对路径。
 * @returns {command, label}
 */
function buildInspectCommand({ kind, cwd, path: rel, lines = 200 }) {
  if (!INSPECT_KINDS.includes(kind)) throw new Error(`不支持的查看类型: ${kind}`);
  if (!cwd) throw new Error('缺少项目目录');
  const dir = shellQuote(cwd);
  const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 500);

  switch (kind) {
    case 'status':
      return { command: `cd ${dir} && git status --short --branch 2>&1 | head -60`, label: 'git status' };
    case 'log':
      return { command: `cd ${dir} && git log --oneline -20 2>&1`, label: 'git log' };
    case 'diff': {
      const target = rel ? ` -- ${shellQuote(safeRelPath(rel))}` : '';
      // 先给 stat 概览再给正文,避免几千行 diff 把微信刷屏
      return {
        command: `cd ${dir} && git diff --stat${target} 2>&1 | tail -30 `
          + `&& echo '--- 详情(截断) ---' && git diff${target} 2>&1 | head -${n}`,
        label: 'git diff'
      };
    }
    case 'ls':
      return {
        command: `cd ${dir} && ls -la ${rel ? shellQuote(safeRelPath(rel)) : '.'} 2>&1 | head -60`,
        label: 'ls'
      };
    case 'file': {
      const f = shellQuote(safeRelPath(rel));
      if (!rel) throw new Error('查看文件需要提供 path');
      return { command: `cd ${dir} && sed -n '1,${n}p' ${f} 2>&1`, label: `读取 ${rel}` };
    }
    case 'tail': {
      const f = shellQuote(safeRelPath(rel));
      if (!rel) throw new Error('查看日志尾部需要提供 path');
      return { command: `cd ${dir} && tail -n ${n} ${f} 2>&1`, label: `tail ${rel}` };
    }
    default:
      throw new Error(`不支持的查看类型: ${kind}`);
  }
}

/** 输出截断:微信是窄屏,几万字发过去毫无意义 */
function truncateOutput(text = '', max = 6000) {
  const s = String(text || '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…(已截断,完整内容请在桌面端查看)`, truncated: true };
}

/* ---------------------------------------------------------------- 引擎校验 */

const ENGINES = ['codex', 'claude', 'deepseek', 'grok'];

function normalizeEngine(engine) {
  if (!engine) return 'codex';
  const e = String(engine).toLowerCase().trim();
  if (!ENGINES.includes(e)) throw new Error(`不支持的引擎「${engine}」,可选:${ENGINES.join('、')}`);
  return e;
}

module.exports = {
  projectsFromConvos, buildProjectScanCommand, parseProjectScan, mergeProjects,
  INSPECT_KINDS, safeRelPath, buildInspectCommand, truncateOutput,
  ENGINES, normalizeEngine
};
