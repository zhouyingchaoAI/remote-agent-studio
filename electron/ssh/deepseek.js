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

/**
 * 拉取端点可用模型列表(OpenAI 兼容的 /v1/models)。
 *
 * 模型名必须与中转站里配的一字不差,靠猜必错。new-api / one-api /
 * DeepSeek 官方都提供这个接口,直接问它比让用户去后台翻靠谱。
 */
function buildModelListCommand(cfg = {}) {
  const { baseUrl, envKey } = resolveEndpoint(cfg);
  /* 注意:模型列表在 OpenAI 风格的 /v1/models 上,而对话走 Anthropic 的
   * /v1/messages。官方 DeepSeek 的 base 带 /anthropic 后缀,那下面没有
   * /v1/models,要退回到根域名去问。 */
  const roots = [...new Set([baseUrl, baseUrl.replace(/\/anthropic$/, '')])];
  return roots.map((root) =>
    `echo "RAS_ROOT=${root}"; curl -sS -m 20 ${JSON.stringify(`${root}/v1/models`)} `
    + `-H "Authorization: Bearer \${${envKey}:-}" 2>&1 | head -c 4000; echo`
  ).join('; ');
}

/** 从 /v1/models 响应里抽出模型 id,去重后按 deepseek 优先排序 */
function parseModelList(stdout = '') {
  const ids = new Set();
  for (const m of String(stdout || '').matchAll(/"id"\s*:\s*"([^"]{1,120})"/g)) {
    const id = m[1].trim();
    // 过滤掉明显不是模型名的(如 object/owned_by 里的值)
    if (id && !/^(list|model|organization|owner)$/i.test(id)) ids.add(id);
  }
  const all = [...ids];
  const score = (id) => (/deepseek/i.test(id) ? 0 : 1);
  return all.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/**
 * 端点连通性探测命令。
 *
 * 直接打 Anthropic 协议的 /v1/messages,而不是等对话时才失败 ——
 * 那时报错是「未知模型」或一堆 CLI 噪音,根本看不出是路径不对、key 无效
 * 还是模型名写错。这里一次请求就能把三种情况分开。
 *
 * key 从环境变量取,不进命令行(命令行会出现在 ps 输出里)。
 */
function buildEndpointProbeCommand(cfg = {}) {
  const { baseUrl, model, envKey } = resolveEndpoint(cfg);
  const body = JSON.stringify({
    model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }]
  });
  // 用 --data @- 从 stdin 读,body 里的引号不必再过一层 shell 转义
  return [
    `printf '%s' ${JSON.stringify(body)} | `,
    'curl -sS -m 30 -o /tmp/.ras-probe-body -w "RAS_HTTP=%{http_code}" ',
    `-X POST ${JSON.stringify(`${baseUrl}/v1/messages`)} `,
    `-H "x-api-key: \${${envKey}:-}" `,
    `-H "authorization: Bearer \${${envKey}:-}" `,
    '-H "anthropic-version: 2023-06-01" -H "content-type: application/json" ',
    '--data @- 2>&1; ',
    'echo; echo "RAS_BODY_BEGIN"; head -c 600 /tmp/.ras-probe-body 2>/dev/null; ',
    'rm -f /tmp/.ras-probe-body'
  ].join('');
}

/**
 * 解读探测结果 —— 把三类失败分开,每类给出该动哪里。
 * 这是这个功能的价值所在:光说「失败了」等于没测。
 */
function parseEndpointProbe(stdout = '', cfg = {}) {
  const out = String(stdout || '');
  const code = Number((out.match(/RAS_HTTP=(\d+)/) || [])[1] || 0);
  const body = (out.split('RAS_BODY_BEGIN')[1] || '').trim();
  const model = (() => { try { return resolveEndpoint(cfg).model; } catch (_) { return ''; } })();

  if (code === 200) {
    return { ok: true, code, message: `✓ 端点可用,模型 ${model} 有响应` };
  }
  if (code === 0) {
    return {
      ok: false, code,
      message: `连不上端点。检查地址是否正确、这台主机能否访问它(需要走代理的话先配好代理)。\n${body || out.slice(-300)}`
    };
  }
  if (code === 404) {
    return {
      ok: false, code,
      message: '404:这个地址上没有 /v1/messages。\n'
        + '→ 自建中转要填**根地址**(不带 /v1);DeepSeek 官方要带 /anthropic 子路径。\n'
        + '→ 也可能是中转站没开 Anthropic 协议兼容,那这条路走不通,得换用 Codex 或让中转站开启该能力。\n'
        + body
    };
  }
  if (code === 401 || code === 403) {
    return {
      ok: false, code,
      message: `${code}:鉴权失败。API Key 没写、写错,或没有这个模型的权限。\n`
        + '→ 在下方「API Key」栏重新写入一次。\n' + body
    };
  }
  if (/model|not found|不存在/i.test(body)) {
    return {
      ok: false, code,
      message: `模型名可能不对(当前填的是 ${model})。\n→ 去中转站/服务商后台确认实际可用的模型名。\n${body}`
    };
  }
  return { ok: false, code, message: `HTTP ${code}\n${body || out.slice(-300)}` };
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
  parseRelayConfig, maskKey, buildEndpointProbeCommand, parseEndpointProbe,
  buildModelListCommand, parseModelList,
  deepseekEnvPosix, deepseekEnvPowershell, resolveDeepseekModel
};
