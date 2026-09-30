/**
 * 模型列表**自动发现** —— 去问端点,而不是在代码里维护一份清单。
 *
 * ── 为什么硬编码那份列表注定是错的 ──
 *
 * 之前 MODEL_PRESETS 是写死的,有两个躲不开的问题:
 *
 * 1. **它永远落后一轮。** 模型每隔几周就换代,而列表要等人想起来改。
 *    `gpt-5-codex` 在列表里躺到退役之后很久才被清掉 ——
 *    期间任何人选中它,拿到的都是一句没头没尾的报错。
 *
 * 2. **对自建/中转端点根本不准。** 不少人的 codex 指向自己的中转,
 *    那里的模型叫 `gpt-5.6-terra` 这种名字,官方列表里一个都没有。
 *    写死的清单对他们而言不是"不全",是**完全无关**。
 *
 * 端点自己知道答案:OpenAI 兼容和 Anthropic 都提供 `GET /v1/models`。
 * 问它一次,拿到的就是**这台机器、这个账号、此刻真正能用的那些**。
 *
 * ── 这里只产出命令与解析,不执行 ──
 *
 * 纯函数,可以用真 bash + 真 HTTP 服务验证。
 * 命令拼装是这个仓库里出错最多的地方,不靠"看着像对"。
 */

/** 默认端点。用户没配自定义端点时就是这两个。 */
const DEFAULT_BASE = {
  codex: 'https://api.openai.com',
  claude: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com/anthropic'
};

/** 各引擎默认从哪个环境变量取密钥(和下发时用的名字一致) */
const DEFAULT_ENV_KEY = {
  codex: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY'
};

/** 环境变量名必须干净:它会原样进 shell */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 端点地址也会进 shell(JSON.stringify 后),先挡掉明显不对的 */
function isHttpUrl(v) {
  return /^https?:\/\/[^\s"']+$/.test(String(v || '').trim());
}

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 生成"列出可用模型"的命令。
 *
 * 密钥**只以变量名出现**,绝不内联 —— 命令行在 `ps` 里是所有人可见的,
 * 把 key 拼进去等于贴在公告板上。这是仓库里既有的做法,这里照做。
 *
 * 两种鉴权头都带上:OpenAI 系认 `Authorization: Bearer`,
 * Anthropic 认 `x-api-key` + `anthropic-version`。多带一个头不会出错,
 * 而分两条命令试要多一次往返、还得判断该试哪条。
 */
function buildDiscoverCommand({ engine, baseUrl, envKey } = {}) {
  const base = normalizeBase(baseUrl || DEFAULT_BASE[engine]);
  const key = envKey || DEFAULT_ENV_KEY[engine] || '';
  if (!isHttpUrl(base) || !ENV_KEY_RE.test(key)) return '';
  const url = `${base}/v1/models`;
  return [
    `curl -sS -m 20 -o /tmp/.ras-models -w "RAS_HTTP=%{http_code}" `,
    `${JSON.stringify(url)} `,
    `-H "Authorization: Bearer \${${key}:-}" `,
    `-H "x-api-key: \${${key}:-}" `,
    '-H "anthropic-version: 2023-06-01" 2>&1; ',
    'echo; echo "RAS_BODY_BEGIN"; head -c 20000 /tmp/.ras-models 2>/dev/null; ',
    'rm -f /tmp/.ras-models'
  ].join('');
}

/** 模型 id 的合法形态。太离谱的一律不收,免得把报错正文当成模型名。 */
const MODEL_ID_RE = /^[A-Za-z0-9][\w.:@/-]{1,80}$/;

/**
 * 解析 `/v1/models` 的返回。
 *
 * 三种形态都见过,所以都认:
 *   · OpenAI / 多数中转:{ data: [{ id }] }
 *   · Anthropic:        { data: [{ id, display_name }] }
 *   · 少数中转直接给数组:[{ id }] 或 ["name"]
 *
 * **失败要说清是哪一类**,而不是笼统"没拿到":
 * 401 是密钥问题、404 多半是端点地址写错(少写/多写了 /v1)、
 * 超时是网络 —— 三者该动的地方完全不同。
 */
function parseDiscover(stdout = '') {
  const out = String(stdout || '');
  const code = Number((out.match(/RAS_HTTP=(\d+)/) || [])[1] || 0);
  const body = (out.split('RAS_BODY_BEGIN')[1] || '').trim();

  if (code === 401 || code === 403) {
    return { ok: false, status: code, error: '密钥无效或没有权限(到「环境配置」检查 API Key)', models: [] };
  }
  if (code === 404) {
    return { ok: false, status: code, error: '端点上没有 /v1/models(检查端点地址是否多写或少写了 /v1)', models: [] };
  }
  if (!code) {
    return { ok: false, status: 0, error: '请求没有返回(网络不通、或端点地址不可达)', models: [] };
  }
  if (code >= 400) {
    return { ok: false, status: code, error: `端点返回 ${code}`, models: [] };
  }

  let json;
  try { json = JSON.parse(body); } catch (_) {
    /* 能连上但不是 JSON,通常是被网关/登录页拦了 ——
       这和"端点不支持列表"是两回事,分开说。 */
    return { ok: false, status: code, error: '返回的不是 JSON(可能被网关或登录页拦截)', models: [] };
  }

  const rows = Array.isArray(json) ? json : (Array.isArray(json.data) ? json.data : []);
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const id = typeof row === 'string' ? row : String(row?.id || row?.name || '');
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ value: id, label: (row && row.display_name) ? `${id} · ${row.display_name}` : id });
  }
  if (!models.length) {
    return { ok: false, status: code, error: '端点返回了空列表', models: [] };
  }
  return { ok: true, status: code, error: '', models };
}

/**
 * 发现结果与内置预设合并。
 *
 * **以发现到的为准,预设只补位。** 端点说有什么就是有什么 ——
 * 内置清单的唯一作用是在发现失败时不至于两手空空。
 *
 * 预设里那些端点没列出来的,仍然保留但标出来:有些中转不在
 * `/v1/models` 里公布全部模型,直接指定却能用。**贸然删掉就是在
 * 替用户断定"这个不能用"**,而我们并不知道。
 */
function mergeModels(discovered = [], presets = []) {
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

module.exports = {
  buildDiscoverCommand, parseDiscover, mergeModels,
  DEFAULT_BASE, DEFAULT_ENV_KEY, isHttpUrl, normalizeBase
};
