/**
 * grok 引擎(xai-org/grok-build 的 `grok` CLI)- 国产大模型统一接入层。
 *
 * grok CLI 支持在 ~/.grok/config.toml 里用 [model.<别名>] 定义自定义模型
 * (base_url 指向各家 OpenAI 兼容端点,env_key 指定 API Key 环境变量;
 *  配置了自定义模型即可直接使用,无需 xAI 账号登录)。
 *
 * 本模块维护国产 provider 注册表,并生成 config.toml 的「受管块」:
 * 每次会话启动前整块重写(带标记注释),不碰用户自己的配置。
 *
 * 模型规格约定: "provider/模型ID",如 "deepseek/deepseek-v4-pro"。
 * 各家模型名迭代快,ID 可在界面上用「自定义」随时改,如 "glm/glm-5.2"。
 */
const GROK_PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash']
  },
  glm: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envKey: 'ZHIPU_API_KEY',
    models: ['glm-5']
  },
  kimi: {
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    models: ['kimi-k2.5']
  },
  qwen: {
    label: '通义 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    models: ['qwen3.5-coder']
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    envKey: 'MINIMAX_API_KEY',
    models: ['minimax-m2.5']
  }
};

const GROK_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';

/** 所有预设模型规格("provider/模型ID"),供 UI 预设列表与 config 生成 */
function grokPresetSpecs() {
  return Object.entries(GROK_PROVIDERS)
    .flatMap(([id, p]) => p.models.map((m) => `${id}/${m}`));
}

/** 解析模型规格;无 provider 前缀视为用户在 config.toml 自配的别名,原样透传 */
function parseGrokSpec(spec) {
  const s = String(spec || '').trim() || GROK_DEFAULT_MODEL;
  const idx = s.indexOf('/');
  if (idx <= 0) return { alias: s, provider: null, modelId: s };
  const provider = s.slice(0, idx);
  const modelId = s.slice(idx + 1);
  if (!GROK_PROVIDERS[provider]) return { alias: s, provider: null, modelId: s };
  return { alias: grokModelAlias(s), provider, modelId };
}

/** config.toml 中的模型别名(-m 参数值):保留 unicode 字母/数字(含中文),
 *  其余(空格/斜杠/引号等)折叠为 '-',确定性映射且避免中文名撞车 */
function grokModelAlias(spec) {
  return String(spec).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
}

/** 用户自定义模型的别名:基于显示名/模型 ID 生成,加 custom- 前缀避免与预设撞车 */
function customModelAlias(model = {}) {
  if (model.alias) return grokModelAlias(model.alias);
  const base = model.label || model.model || 'model';
  return `custom-${grokModelAlias(base)}`;
}

/** 归一化一个模型定义(预设或自定义)为 config 生成所需字段 */
function normalizeModelDef(def) {
  // 字符串:按 "provider/模型ID" 预设规格解析
  if (typeof def === 'string') {
    const { alias, provider, modelId } = parseGrokSpec(def);
    if (!provider) return null;
    const p = GROK_PROVIDERS[provider];
    return { alias, model: modelId, baseUrl: p.baseUrl, name: `${p.label} ${modelId}`, envKey: p.envKey, apiBackend: null };
  }
  // 对象:用户在界面上填的自定义端点
  if (def && typeof def === 'object' && def.baseUrl && def.model) {
    return {
      alias: customModelAlias(def),
      model: String(def.model),
      baseUrl: String(def.baseUrl),
      name: String(def.label || def.model),
      envKey: def.envKey ? String(def.envKey) : null,
      apiBackend: def.apiBackend ? String(def.apiBackend) : null
    };
  }
  return null;
}

const BLOCK_BEGIN = '# >>> remote-agent-studio managed models >>>';
const BLOCK_END = '# <<< remote-agent-studio managed models <<<';

/**
 * 生成受管块内容:内置预设模型 + 用户自定义模型(去重)。
 * 入参每项可为字符串("provider/模型ID" 预设规格)或自定义模型对象
 * ({label, model, baseUrl, envKey, apiBackend})。
 * API Key 一律走 env_key(取自 ~/.remote-agent-env.sh),不落 config 明文。
 */
function buildGrokConfigBlock(extraDefs = []) {
  const defs = [...grokPresetSpecs(), ...(Array.isArray(extraDefs) ? extraDefs : [])]
    .map(normalizeModelDef)
    .filter(Boolean);
  const lines = [BLOCK_BEGIN, '# 由 Remote Agent Studio 图形界面生成,请勿手改(会被覆盖);自有模型请写在块外'];
  const seen = new Set();
  for (const d of defs) {
    if (seen.has(d.alias)) continue;
    seen.add(d.alias);
    lines.push('', `[model.${JSON.stringify(d.alias)}]`, `model = ${JSON.stringify(d.model)}`,
      `base_url = ${JSON.stringify(d.baseUrl)}`, `name = ${JSON.stringify(d.name)}`);
    if (d.apiBackend && d.apiBackend !== 'chat_completions') lines.push(`api_backend = ${JSON.stringify(d.apiBackend)}`);
    if (d.envKey) lines.push(`env_key = ${JSON.stringify(d.envKey)}`);
  }
  lines.push('', BLOCK_END);
  return lines.join('\n');
}

module.exports = {
  GROK_PROVIDERS,
  GROK_DEFAULT_MODEL,
  BLOCK_BEGIN,
  BLOCK_END,
  grokPresetSpecs,
  parseGrokSpec,
  grokModelAlias,
  customModelAlias,
  normalizeModelDef,
  buildGrokConfigBlock
};
