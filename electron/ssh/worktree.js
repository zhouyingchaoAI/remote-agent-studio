/**
 * 给「分路」用的 git worktree 命令。
 *
 * ── 为什么非要独立目录 ──
 *
 * 一条对话攒够了上下文,想拆成几路同时做不同功能 —— 这是很自然的需求。
 * 但只复制对话是不够的:几路**共用同一个工作目录**的话,
 * 几个智能体会同时改同一批文件,互相覆盖,而且谁也不知道被谁覆盖了。
 * 那不是并行,是竞态。
 *
 * git worktree 正好解决这个:同一个仓库,多个签出目录,各自一条分支,
 * 互不干扰,最后各自合并。这也是这个项目自己在用的做法(.worktrees/)。
 *
 * ── 这里只产出命令,不执行 ──
 *
 * 命令拼装是这一轮里出错最多的地方(注释被当通配符、while read 挂死、
 * 引用不严)。所以全部做成纯函数,能用真 bash + 真 git 验证,
 * 而不是"看着像对"。
 */

/**
 * 名字校验 —— **这是安全边界,不是便利功能。**
 *
 * 界面那边(src/forkNames.js)会先把名字整理成可用形态,但主进程
 * 不能因此就信任送过来的东西:IPC 的调用方不保证是我们的界面。
 * 所以这里独立再判一次,不合规就**不生成任何命令**。
 *
 * 严格到近乎苛刻是有原因的:这个名字同时要进 shell 命令和 git ref。
 * git 自己就不允许空格、`..`、`~`、`^`、`:`、`?`、`*`、`[`、结尾的 `.lock`,
 * 而 shell 那边的风险更直接。与其两套规则各防一半,不如只放行最安全的那批。
 */
const SAFE_SLUG_RE = /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5-]{0,47}$/;
function isSafeSlug(name) {
  return SAFE_SLUG_RE.test(String(name || ''));
}

/** shell 单引号引用。和仓库里其他地方同一套写法。 */
function q(v) {
  return `'${String(v).replace(/'/g, "'\\''")}'`;
}

/**
 * 探测这个目录是不是 git 仓库,以及仓库根在哪。
 *
 * 输出成 KEY=VALUE,按名字取 —— 不按行号取。
 * (systemctl 那次就是按位置取吃了亏:它返回的顺序和请求的顺序不一样。)
 */
function buildDetectRepoCommand(cwd) {
  const dir = q(cwd || '.');
  return [
    `cd ${dir} 2>/dev/null || { echo "OK=0"; echo "ERR=目录不存在"; exit 0; }`,
    'root=$(git rev-parse --show-toplevel 2>/dev/null)',
    '[ -z "$root" ] && { echo "OK=0"; echo "ERR=不是 git 仓库"; exit 0; }',
    'echo "OK=1"',
    'echo "ROOT=$root"',
    'echo "BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
    'echo "HEAD=$(git rev-parse --short HEAD 2>/dev/null)"',
    // 有未提交改动时要提醒:worktree 只带走已提交的内容
    'echo "DIRTY=$(git status --porcelain 2>/dev/null | head -1 | wc -l | tr -d " ")"',
    'exit 0'
  ].join('\n');
}

function parseDetect(stdout) {
  const get = (k) => (String(stdout || '').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
  return {
    ok: get('OK') === '1',
    error: get('ERR'),
    root: get('ROOT'),
    branch: get('BRANCH'),
    head: get('HEAD'),
    dirty: get('DIRTY') === '1'
  };
}

/** 分路目录统一放在仓库根的 .worktrees/ 下 —— 和这个项目原有的习惯一致 */
const WORKTREE_DIR = '.worktrees';

function worktreePath(root, slug) {
  return `${String(root).replace(/\/+$/, '')}/${WORKTREE_DIR}/${slug}`;
}

/**
 * 建一条分路。
 *
 * 三种情况都要处理好,否则用户会撞上 git 自己那些很难懂的报错:
 *  · 目录已存在 → 明确说"这条分路已经有了",不要让 git 报一句
 *    "already exists" 然后什么也不解释
 *  · 分支已存在 → 复用它(接着上次没做完的),而不是失败
 *  · 都没有 → 从 base 新建分支
 */
function buildCreateWorktreeCommand({ root, slug, branch, base = 'HEAD' }) {
  // 不安全的名字一律不生成命令 —— 宁可什么都不做,也不执行一条拼歪的命令
  if (!root || !isSafeSlug(slug)) return '';
  const p = worktreePath(root, slug);
  const br = branch || `feat/${slug}`;
  if (branch && !isSafeSlug(String(branch).replace(/^[\w-]+\//, ''))) return '';
  return [
    `cd ${q(root)} || { echo "OK=0"; echo "ERR=仓库目录不可用"; exit 0; }`,
    `if [ -e ${q(p)} ]; then echo "OK=0"; echo "ERR=分路目录已存在:${p}"; exit 0; fi`,
    `mkdir -p ${q(`${root}/${WORKTREE_DIR}`)}`,
    // 分支已存在就直接用,让人能接着上次的做
    `if git show-ref --verify --quiet ${q(`refs/heads/${br}`)}; then`,
    `  git worktree add ${q(p)} ${q(br)} >/dev/null 2>&1 || { echo "OK=0"; echo "ERR=挂载已有分支失败"; exit 0; }`,
    `  echo "REUSED=1"`,
    'else',
    `  git worktree add -b ${q(br)} ${q(p)} ${q(base)} >/dev/null 2>&1 || { echo "OK=0"; echo "ERR=创建分路失败(base=${base} 可能不存在)"; exit 0; }`,
    `  echo "REUSED=0"`,
    'fi',
    'echo "OK=1"',
    `echo "PATH=${p}"`,
    `echo "BRANCH=${br}"`,
    'exit 0'
  ].join('\n');
}

function parseCreate(stdout) {
  const get = (k) => (String(stdout || '').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim() || '';
  return {
    ok: get('OK') === '1',
    error: get('ERR'),
    path: get('PATH'),
    branch: get('BRANCH'),
    reused: get('REUSED') === '1'
  };
}

/**
 * 列出现有分路。
 * `git worktree list --porcelain` 的输出是分组的,一组一个 worktree。
 */
function buildListCommand(root) {
  if (!root) return '';
  return `cd ${q(root)} 2>/dev/null && git worktree list --porcelain 2>/dev/null || true`;
}

function parseList(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9).trim(), branch: '', prunable: false };
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (cur && line.startsWith('prunable')) {
      cur.prunable = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = {
  isSafeSlug, SAFE_SLUG_RE, worktreePath, WORKTREE_DIR,
  buildDetectRepoCommand, parseDetect,
  buildCreateWorktreeCommand, parseCreate,
  buildListCommand, parseList
};
