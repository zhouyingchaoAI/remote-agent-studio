/**
 * Codex 的推理强度(model_reasoning_effort)。
 *
 * 取值来自官方配置参考:minimal | low | medium | high | xhigh,
 * 其中 xhigh 是模型相关的 —— 不是每个模型都提供,所以选了不生效时
 * 要能说清是模型不支持,而不是我们没传。
 *
 * 走 `-c key=value` 而不是改远程 config.toml:后者是全局的,
 * 会影响用户在终端里的其他 codex 会话,一个对话框的选择不该有那种副作用。
 */
const REASONING_EFFORTS = [
  { value: '', label: '默认(跟随 CLI 配置)' },
  { value: 'minimal', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高(需模型支持)' }
];

const VALID = new Set(REASONING_EFFORTS.map((e) => e.value).filter(Boolean));

/**
 * 生成 codex 的推理强度参数。
 * 白名单校验不只是防注入 —— 传个 CLI 不认的值会让整轮直接失败,
 * 而那种报错读起来完全不像「你选错了强度」。
 * @returns {string} 形如 `-c model_reasoning_effort=xhigh`,未设置则空串
 */
function codexReasoningFlag(effort, model = '') {
  let v = String(effort || '').trim().toLowerCase();
  // 旧对话切换到 Astra 时仍可能保存 minimal；Astra 的最低强度是 low。
  if (model === 'gpt-6-astra' && v === 'minimal') v = 'low';
  if (!v) return '';
  if (!VALID.has(v)) throw new Error(`不支持的推理强度:${effort}(可选 ${[...VALID].join('/')})`);
  return `-c model_reasoning_effort=${v}`;
}

module.exports = { REASONING_EFFORTS, codexReasoningFlag };
