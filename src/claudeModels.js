/**
 * Claude Code 的模型预设与版本门槛。
 *
 * ── 为什么要管版本 ──
 *
 * 新模型对 CLI 有最低版本要求(Fable 5 要 2.1.170+)。远端那台机器上的
 * claude 往往是几个月前装的 —— 选了新模型,CLI 会甩一句自己的错误退出,
 * 而用户看到的只是"又失败了",完全联想不到是**版本太旧**。
 *
 * 环境检测本来就拿到了 claude 版本号,拿来一比就能在**选之前**说清楚。
 * 这比事后解析 CLI 的报错可靠得多:报错文案会变,版本号不会。
 */

/**
 * 预设列表。
 *
 * 保留 sonnet / opus / haiku 这三个短别名:它们跟随各家族最新版,
 * 用户也早就习惯了。新模型用完整标识符 —— 短别名有没有对应的写法
 * 我没有依据,而写错一个别名的代价是"选了就报错"。
 */
export const CLAUDE_MODELS = [
  { value: 'claude-fable-5-1', label: 'fable 5.1', minCli: '2.1.255' },
  { value: 'claude-fable-5', label: 'fable 5', minCli: '2.1.170' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' }
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
