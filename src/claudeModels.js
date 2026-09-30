/**
 * Claude Code 的模型预设与版本门槛。
 *
 * ── 为什么优先给别名 ──
 *
 * `fable` / `opus` / `sonnet` / `haiku` 是**别名**,各自指向该家族的最新版,
 * 并且随提供方(Anthropic API / Bedrock / Foundry)解析到不同版本。
 * 用别名的好处是模型换代时这份列表不用跟着改 ——
 * 而每次换代都手工改一遍列表,迟早会漏掉一次,留下一个已经退役的名字。
 *
 * 钉死版本的完整 ID 也留几个:要复现某次结果、或者要避开一次换代时,
 * 别名帮不上忙。
 *
 * ── 为什么要管版本门槛 ──
 *
 * 新模型对 CLI 有最低版本要求。远端那台机器上的 claude 往往是几个月前装的,
 * 选了新模型 → CLI 甩一句自己的错误退出 → 用户只看到"又失败了",
 * 完全联想不到是**版本太旧**。
 *
 * 门槛只挂在**钉死版本的 ID** 上,不挂别名:别名在老版本上会解析到
 * 老模型,照样能跑,标门槛反而会误报。
 *
 * 数字来自 docs.claude.com 的 Claude Code 模型配置页(2026-09 核对)。
 * 它会随版本变,所以这里**只警告、不禁用** —— 我们的数字过期时,
 * 不该把一个本来能用的模型堵死。
 */

export const CLAUDE_MODELS = [
  /* 别名:日常首选。顺序按"多数人该先看到哪个"排,不是按能力排 —— */
  { value: 'sonnet', label: 'sonnet · 日常编码' },
  { value: 'opus', label: 'opus · 复杂推理' },
  { value: 'fable', label: 'fable · 最强,长任务' },
  { value: 'haiku', label: 'haiku · 快而省' },
  /* opusplan:计划阶段用 opus、执行阶段自动换 sonnet。
     长任务里这个组合最省钱,但名字看不出来,所以标注一下。 */
  { value: 'opusplan', label: 'opusplan · 计划 opus / 执行 sonnet' },
  { value: 'sonnet[1m]', label: 'sonnet[1m] · 100 万上下文' },
  { value: 'opus[1m]', label: 'opus[1m] · 100 万上下文' },

  /* 钉死版本:复现结果、或想避开一次换代时用 */
  { value: 'claude-fable-5-1', label: 'fable 5.1(钉版)', minCli: '2.1.257' },
  { value: 'claude-fable-5', label: 'fable 5(钉版)', minCli: '2.1.170' },
  { value: 'claude-opus-5-5', label: 'opus 5.5(钉版)', minCli: '2.1.280' },
  { value: 'claude-opus-5', label: 'opus 5(钉版)' },
  { value: 'claude-sonnet-5', label: 'sonnet 5(钉版)' }
];

/**
 * 从 `claude --version` 的输出里取版本号。
 *
 * 输出形如 `2.1.170 (Claude Code)`,但不同版本格式变过 ——
 * 所以只认"第一个 x.y.z",拿不到就返回空,**由调用方当作"不知道"处理**,
 * 而不是当作"版本太旧"。把"没测出来"说成"不满足"是在编造结论。
 */
export function parseCliVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
}

/** a < b 返回 -1,相等 0,a > b 返回 1。位数不同时缺的位按 0 补。 */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 这个模型在这台机器上能不能用。
 *
 * @returns 空字符串表示没问题;否则是一句可以直接显示给用户的话
 *
 * **拿不到版本号时一律放行。** 检测可能因为各种原因没返回,
 * 这时候拦下来等于凭空阻止用户用一个本来能用的模型 ——
 * 宁可让 CLI 自己去报错,也不要替它编一个理由。
 */
export function modelVersionProblem(model, cliVersionText) {
  const preset = CLAUDE_MODELS.find((m) => m.value === model);
  if (!preset || !preset.minCli) return '';
  const v = parseCliVersion(cliVersionText);
  if (!v) return '';
  if (compareVersions(v, preset.minCli) >= 0) return '';
  return `${preset.label} 需要 Claude Code ${preset.minCli}+,这台机器是 ${v} —— 请先到「环境配置」升级`;
}
