/**
 * 用 Claude Code CLI 驱动 Anthropic 兼容端点(DeepSeek 官方 / 自建中转)。
 *
 * 引擎 'deepseek' 复用 claude 的命令管线与流式 JSON 解析,只在进程环境里
 * 注入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等变量。
 *
 * 端点可配置的原因:官方 DeepSeek 的 Anthropic 兼容入口在 /anthropic 子路径,
 * 而 new-api / one-api 这类自建中转直接在根路径提供 /v1/messages ——
 * 路径规则不同,写死任何一种另一种就用不了。
 *
 * API Key 永远不进配置文件:存在远程 ~/.remote-agent-env.sh(600 权限),
 * 这里只引用环境变量名。
 */

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro[1m]';
const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_MODEL_PRESETS = [DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_FLASH_MODEL];
const DEFAULT_ENV_KEY = 'DEEPSEEK_API_KEY';

/** 出厂默认:官方 DeepSeek */
const DEFAULT_ENDPOINT = {
  baseUrl: DEEPSEEK_BASE_URL,
  model: DEEPSEEK_DEFAULT_MODEL,
  flashModel: DEEPSEEK_FLASH_MODEL,
  envKey: DEFAULT_ENV_KEY
};

/** 常见端点预设,省得用户去翻文档 */
const ENDPOINT_PRESETS = [
  {
    id: 'official', label: 'DeepSeek 官方',
    baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_DEFAULT_MODEL, flashModel: DEEPSEEK_FLASH_MODEL,
    envKey: DEFAULT_ENV_KEY,
    note: 'Anthropic 兼容入口在 /anthropic 子路径'
  },
  {
    id: 'newapi', label: '自建中转(new-api / one-api)',
    baseUrl: '', model: 'deepseek-chat', flashModel: 'deepseek-chat',
    envKey: DEFAULT_ENV_KEY,
    note: '填中转站根地址即可,如 http://1.2.3.4:3000;模型名要与中转站里配置的一致'
  }
];

/**
 * 校验并归一化 base URL。
 * 这个值会被拼进 shell 的 export,必须挡住引号、分号、$() 等注入载体。
 */
function normalizeBaseUrl(raw) {
  const url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('端点地址不能为空');
  if (!/^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._\-/]*)?$/.test(url)) {
    throw new Error(`端点地址不合法:${raw}\n只允许 http(s)://主机[:端口][/路径],不能含空格、引号或 shell 特殊字符`);
  }
  return url;
}

/** 环境变量名校验:同样会进 shell */
function normalizeEnvKey(raw) {
  const key = String(raw || '').trim() || DEFAULT_ENV_KEY;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`环境变量名不合法:${raw}(只允许大写字母、数字和下划线)`);
  }
  return key;
}

/** 模型名校验:允许 deepseek-v4-pro[1m] 这种带方括号的写法 */
function normalizeModel(raw, fallback) {
  const m = String(raw || '').trim() || fallback;
  if (!/^[A-Za-z0-9._\-[\]:/]+$/.test(m)) {
    throw new Error(`模型名不合法:${raw}`);
  }
  return m;
}

/** 把界面/设置里的配置补全成完整可用的端点定义 */
function resolveEndpoint(cfg = {}) {
  const raw = cfg || {};
  const merged = { ...DEFAULT_ENDPOINT, ...raw };
  const model = normalizeModel(merged.model, DEEPSEEK_DEFAULT_MODEL);

  /* 轻量模型不能从默认值合并进来:用户配了自建中转、主模型填 deepseek-chat 却
   * 没填轻量模型时,合并会塞进官方的 deepseek-v4-flash —— 中转站上没这个模型,
   * 子代理调用会以「未知模型」失败,而且报错发生在子任务里很难定位。
   * 用户自己指定了主模型却没指定轻量模型时,一律跟随主模型。 */
  const flashRaw = String(raw.flashModel || '').trim();
  const flash = flashRaw || (String(raw.model || '').trim() ? model : merged.flashModel);

  return {
    baseUrl: normalizeBaseUrl(merged.baseUrl),
    model,
    flashModel: normalizeModel(flash, model),
    envKey: normalizeEnvKey(merged.envKey)
  };
}

/**
 * 解析中转站给的配置串,例如:
 *   {"_type":"newapi_channel_conn","key":"sk-xxx","url":"http://1.2.3.4:3000"}
 *
 * 目的是让用户一次粘贴就配好,不用在几个框之间手抄。
 * 注意:解析出的 key 只用于当场下发到远程环境文件,
 * 调用方绝不能把它写进设置、日志或任何持久化文件。
 */
function parseRelayConfig(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('请粘贴中转站配置串');

  let obj = null;
  try { obj = JSON.parse(raw); } catch (_) { /* 不是 JSON 就走宽松提取 */ }

  if (!obj || typeof obj !== 'object') {
    // 用户可能只粘了一部分,或者带了多余的前后缀
    const url = (raw.match(/https?:\/\/[^\s"',}]+/) || [])[0];
    const key = (raw.match(/\bsk-[A-Za-z0-9_-]{16,}/) || [])[0];
    if (!url && !key) throw new Error('没认出地址或密钥,请检查粘贴内容');
    obj = { url, key };
  }

  const url = String(obj.url || obj.base_url || obj.baseUrl || '').trim();
  const key = String(obj.key || obj.api_key || obj.apiKey || obj.token || '').trim();
  if (!url) throw new Error('配置串里没有 url 字段');

  return { baseUrl: normalizeBaseUrl(url), key };
}

/** 脱敏:任何要展示或记录的地方都必须先过这一层 */
function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 10) return k ? '****' : '';
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

/** POSIX shell(远程 Linux / 本机 mac)env 前缀 */
function deepseekEnvPosix(cfg) {
  const { baseUrl, flashModel, envKey } = resolveEndpoint(cfg);
  return [
    `export ANTHROPIC_BASE_URL=${JSON.stringify(baseUrl)};`,
    // 避免已配置的 Anthropic 官方 key 干扰鉴权
    'unset ANTHROPIC_API_KEY;',
    `export ANTHROPIC_AUTH_TOKEN="\${${envKey}:-}";`,
    `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${JSON.stringify(flashModel)};`,
    `export CLAUDE_CODE_SUBAGENT_MODEL=${JSON.stringify(flashModel)};`
  ].join(' ');
}

/** Windows PowerShell env 前缀 */
function deepseekEnvPowershell(cfg) {
  const { baseUrl, flashModel, envKey } = resolveEndpoint(cfg);
  return [
    `$env:ANTHROPIC_BASE_URL='${baseUrl}';`,
    '$env:ANTHROPIC_API_KEY=$null;',
    `$env:ANTHROPIC_AUTH_TOKEN=$env:${envKey};`,
    `$env:ANTHROPIC_DEFAULT_HAIKU_MODEL='${flashModel}';`,
    `$env:CLAUDE_CODE_SUBAGENT_MODEL='${flashModel}';`
  ].join(' ');
}

/** 实际执行时使用的模型(对话里没指定则用端点配置的主模型) */
function resolveDeepseekModel(model, cfg) {
  const explicit = String(model || '').trim();
  if (explicit) return explicit;
  try { return resolveEndpoint(cfg).model; } catch (_) { return DEEPSEEK_DEFAULT_MODEL; }
}

module.exports = {
  DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_MODEL_PRESETS, DEFAULT_ENDPOINT, ENDPOINT_PRESETS, DEFAULT_ENV_KEY,
  normalizeBaseUrl, normalizeEnvKey, normalizeModel, resolveEndpoint,
  parseRelayConfig, maskKey,
  deepseekEnvPosix, deepseekEnvPowershell, resolveDeepseekModel
};
