/**
 * 发现到的模型与内置清单的合并规则。
 *
 * **以端点说的为准,内置清单只补位。** 端点列出来的才是这台机器、
 * 这个账号此刻真能用的;内置清单的唯一作用是发现失败时不至于两手空空。
 *
 * 但没被列出来的预设**仍然保留**(标记 discovered: false):
 * 有些中转不在 /v1/models 里公布全部模型,直接指定却能用。
 * 删掉等于替用户断定"这个不能用",而我们并不知道 ——
 * 宁可多列一个可能用不了的,也不要藏起一个本来能用的。
 *
 * 主进程侧有一份同名实现(electron/ssh/modelDiscovery.js)。
 * 两边都要用,而 CommonJS 与 ESM 不能直接互相 import;
 * 逻辑很短,由测试保证两边行为一致 —— 和仓库里 outputClip 的处理一致。
 */
export function mergeModels(discovered = [], presets = []) {
  const norm = (m) => (typeof m === 'string' ? { value: m, label: m } : m);
  const out = [];
  const seen = new Set();
  for (const m of discovered) {
    if (!m?.value || seen.has(m.value)) continue;
    seen.add(m.value);
    out.push({ ...m, discovered: true });
  }
  for (const raw of presets) {
    const m = norm(raw);
    if (!m?.value || seen.has(m.value)) continue;
    seen.add(m.value);
    out.push({ ...m, discovered: false });
  }
  return out;
}
