/**
 * 技能市场:从上游开源仓库按需拉取 SKILL.md。
 *
 * 刻意不把上游技能 vendor 进本仓库:
 *  - 许可证各不相同,打包分发要逐个确认
 *  - 上游一直在更新,vendor 进来就永远是旧的
 *  - 体积会迅速膨胀
 * 改成运行时拉取:列表走一次 Git Tree API,正文按需取,对未认证的
 * 60 次/小时限额很友好。
 */

/** 内置的上游源。用户也可以在界面里加自定义仓库 */
const SOURCES = [
  { id: 'anthropic', repo: 'anthropics/skills', branch: 'main',
    label: 'Anthropic 官方', note: '文档处理(docx/pdf/pptx/xlsx)、设计、前端测试等' },
  { id: 'openai', repo: 'openai/skills', branch: 'main',
    label: 'OpenAI Codex 官方', note: 'Codex 官方技能目录' }
];

const UA = { 'User-Agent': 'RemoteAgentStudio', Accept: 'application/vnd.github+json' };

async function getJson(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctl.signal });
    if (res.status === 403) {
      throw new Error('GitHub API 限流(未认证 60 次/小时),请稍后再试');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function getText(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

/** 从 tree 里筛出技能条目:凡是 <某目录>/SKILL.md 都算一条 */
function extractSkillEntries(tree = [], repo = '') {
  return tree
    .filter((n) => n.type === 'blob' && /(^|\/)SKILL\.md$/.test(n.path))
    .map((n) => {
      const parts = n.path.split('/');
      const name = parts[parts.length - 2] || '';
      const category = parts.length > 2 ? parts.slice(0, -2).join('/') : '';
      return { name, category, path: n.path, repo, size: n.size || 0 };
    })
    .filter((e) => e.name)
    .sort((a, b) => (a.category + a.name).localeCompare(b.category + b.name));
}

/** 列出某个源里的全部技能(1 次 API 调用) */
async function listSource(source) {
  const { repo, branch = 'main' } = source;
  const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const data = await getJson(url);
  if (!Array.isArray(data.tree)) throw new Error('仓库结构解析失败');
  return {
    repo,
    truncated: !!data.truncated, // 超大仓库 GitHub 会截断,提示用户
    skills: extractSkillEntries(data.tree, repo)
  };
}

/** 取一条技能的正文 */
async function fetchSkillContent({ repo, path, branch = 'main' }) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  return getText(url);
}

/** "owner/repo" 校验,防止把任意字符串拼进 URL */
function parseRepoSpec(spec = '') {
  const m = String(spec).trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
    .match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

module.exports = { SOURCES, listSource, fetchSkillContent, extractSkillEntries, parseRepoSpec };
