/**
 * DeepSeek Harness(dsh)引擎。
 *
 * 官方 agent harness:https://github.com/deepseek-ai/deepseek-harness
 * 取代原先的 grok CLI 作为国产模型通道 —— 少一个二进制、少一套 xAI 登录。
 *
 * 与 codex / claude 的关键差异(直接影响界面能显示什么,别指望它们一致):
 *   - 无头模式是 `dsh --profile headless "任务"`,一次性执行
 *   - **stdout 只打印最后一段 assistant 文本**,没有 NDJSON、没有工具事件,
 *     所以「执行命令 / 修改文件」这些卡片在 dsh 下不会出现
 *   - 每次调用都是**全新会话**,没有 resume;多轮上下文要靠我们自己把历史
 *     拼进 prompt
 *   - 成功退出 0,其余退出 1;成功时 stderr 不写任何东西
 * 以上依据官方 CLI 行为参考(apps/cli/reference/README.md)。
 */

const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_BIN = 'dsh';
/** 官方要求 Node ≥ 22.19 或 ≥ 24 */
const DSH_MIN_NODE = '22.19.0';

/** 全局安装命令(远程与本机通用) */
function dshInstallCommand() {
  return `npm install -g ${DSH_PACKAGE}@latest`;
}

/**
 * 环境前缀。
 * NODE_USE_ENV_PROXY=1 是必须的:官方文档明确说要设它,Node 才会认
 * HTTP_PROXY/HTTPS_PROXY —— 不设的话远程机器走代理上网会直接连不通。
 * @param cfg {permissionMode?} 权限模式取值官方未公开完整列表,留空则继承其默认的 workspace-write
 */
function dshEnvPosix(rawCfg) {
  // 默认参数只挡 undefined。settings 里存的是 dshConfig: null,
  // null.permissionMode 直接 TypeError,整轮对话就废了 —— 上次在
  // normalizePermissionMode 踩过一模一样的坑,这里是同一个类型的第二处。
  const cfg = rawCfg || {};
  const parts = [
    'export NODE_USE_ENV_PROXY=1;',
    // 凭据从环境读取;key 仍存在 ~/.remote-agent-env.sh(600),不内联
    'export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}";'
  ];
  const mode = String(cfg.permissionMode || '').trim();
  if (mode) {
    if (!/^[A-Za-z0-9_-]+$/.test(mode)) throw new Error(`dsh 权限模式取值不合法:${mode}`);
    parts.push(`export DSH_PERMISSION_MODE=${JSON.stringify(mode)};`);
  }
  return parts.join(' ');
}

function dshEnvPowershell(rawCfg) {
  const cfg = rawCfg || {};
  const parts = [
    '$env:NODE_USE_ENV_PROXY=\'1\';',
    '$env:DEEPSEEK_API_KEY=$env:DEEPSEEK_API_KEY;'
  ];
  const mode = String(cfg.permissionMode || '').trim();
  if (mode) {
    if (!/^[A-Za-z0-9_-]+$/.test(mode)) throw new Error(`dsh 权限模式取值不合法:${mode}`);
    parts.push(`$env:DSH_PERMISSION_MODE='${mode}';`);
  }
  return parts.join(' ');
}

/**
 * 无头任务的命令参数。
 * dsh 没有 --model 之类的开关(模型由 profile 配置决定),所以对话里的
 * 模型选择对它无效 —— 界面上要如实标出来,不能让用户以为选了有用。
 */
/**
 * 诊断命令:不启动、只把合成后的配置树打出来(官方 --dump-config)。
 * 用来回答「模型路由到底配没配」——「我加了 API key 还是不行」多半
 * 是加错了地方:dsh 的模型/凭据在 $DSH_HOME/cordis.patch.yml 的配置层里,
 * 不读 DEEPSEEK_API_KEY 环境变量。
 */
function dshDiagnoseCommand() {
  return 'dsh --profile headless --dump-config 2>&1';
}

/**
 * 从 --dump-config 输出里判断模型路由是否可用。
 * 只做保守判断:拿不准就说拿不准,不要给用户一个假的「已就绪」。
 */
function parseDshConfig(stdout = '') {
  const text = String(stdout || '');
  if (!text.trim()) return { ok: false, reason: 'empty', message: 'dsh 没有输出配置,多半是 profile 尚未初始化(首次运行会自动初始化,需要联网且较慢)' };
  if (/command not found|not found|ENOENT/i.test(text) && !/model/i.test(text)) {
    return { ok: false, reason: 'missing', message: '本机找不到 dsh 命令,先到「环境配置」页安装' };
  }
  const model = text.match(/model:\s*['"]?([A-Za-z0-9._-]+)/);
  const baseUrl = text.match(/base[_-]?[Uu]rl:\s*['"]?(https?:\/\/[^\s'"]+)/);
  const hasKey = /apiKey|api_key|authorization/i.test(text);
  if (!model && !hasKey) {
    return {
      ok: false, reason: 'unconfigured',
      message: '配置树里没有模型路由 —— dsh 的模型与密钥写在 $DSH_HOME/cordis.patch.yml,'
        + '不是 DEEPSEEK_API_KEY 环境变量。到「浏览」页启动 dsh 配置界面填一次。'
    };
  }
  const url = baseUrl ? baseUrl[1] : '';
  /* 有模型路由但没有 key 是一个很具体的坑:dsh 的 web 与 headless 是两个
   * 独立 profile,各有自己的 cordis.patch.yml。在 web 界面里填的 key 如果
   * 落在 web 那份里,headless 就完全看不到 —— 用户会觉得「明明填了」。
   * 模型路由来自随附模板,所以它一直都在,不能拿它代表「配好了」。 */
  if (!hasKey) {
    return {
      ok: false, reason: 'nokey', model: model ? model[1] : '', baseUrl: url,
      message: `headless profile 里有模型路由${model ? `(${model[1]})` : ''}但没有 API key。`
        + 'dsh 的 web 与 headless 是两个独立 profile —— 在网页里填的 key 若只写进了 web 那份,'
        + 'headless 读不到。请把 key 写到 home 级的 $DSH_HOME/cordis.patch.yml(对所有 profile 生效)。'
    };
  }
  return {
    ok: true, model: model ? model[1] : '', baseUrl: url, hasKey,
    message: `模型路由已配置${model ? `:${model[1]}` : ''}${url ? ` @ ${url}` : ''},且已读到 API key`
  };
}

function dshArgs() {
  return '--profile headless';
}

/**
 * 多轮上下文:dsh 每次都是新会话,只能把历史摘要拼进任务文本。
 * 不做的话第二句「那再改一下 X」它完全不知道在说什么。
 */
function withHistory(prompt, rawHistory) {
  const history = Array.isArray(rawHistory) ? rawHistory : [];
  const items = (history || []).filter((h) => h && h.text);
  if (!items.length) return prompt;
  const digest = items.map((h) => `${h.role === 'user' ? '用户' : '助手'}:${String(h.text).slice(0, 800)}`).join('\n');
  return [
    '【此前对话摘要】dsh 每轮为独立会话,以下是上下文,请据此继续,不要重复已完成的工作:',
    digest,
    '————',
    `本轮指令:${prompt}`
  ].join('\n');
}

/**
 * 解释退出码。
 * 官方:completed 退 0,其余退 1。所以非 0 不一定是崩溃,
 * 也可能是任务未达成 —— 报错措辞不能写成「进程崩溃」误导用户。
 */
function describeExit(code, stdout, stderr) {
  stdout = String(stdout || ''); stderr = String(stderr || '');
  if (code === 0) return { ok: true };
  const detail = String(stderr || '').trim() || String(stdout || '').trim().slice(-400);
  if (/not found|command not found|ENOENT/i.test(detail)) {
    return { ok: false, message: `未找到 dsh 命令,请先在「环境配置」页安装(${dshInstallCommand()})` };
  }
  if (/DEEPSEEK_API_KEY|credential|unauthorized|401/i.test(detail)) {
    return { ok: false, message: `dsh 鉴权失败:请在「环境配置」页写入 DEEPSEEK_API_KEY。\n${detail}` };
  }
  return {
    ok: false,
    message: `dsh 未完成任务(exit ${code})。dsh 以 0 表示完成、1 表示未完成,不一定是崩溃。\n${detail}`
  };
}

/**
 * dsh 正常退出却一个字都没输出时的解释。
 * 静默是最糟的失败方式 —— 用户只看到消息发出去、然后什么都没有。
 */
/**
 * 解释 dsh 的认证失败。
 *
 * 最常见的错配:用户拿自建中转(new-api/one-api)签发的 key 填进 dsh,
 * 而 dsh 默认把它送去 api.deepseek.com 官方端点验签 —— 官方当然不认这把 key。
 * 通用的「检查登录状态」提示在这里毫无用处,dsh 也没有 auth.json。
 * @param baseUrl 配置树里读到的端点,用来判断是不是指错了地方
 */
function explainAuthFailure(output = '', baseUrl = '') {
  const masked = String(output).match(/api key:\s*(\S+)/i);
  const lines = ['dsh 认证失败:配置里的 API key 被端点拒绝了。'];
  if (masked) lines.push(`  被拒的 key:${masked[1]}`);
  const official = !baseUrl || /api\.deepseek\.com/i.test(baseUrl);
  lines.push(`  当前端点:${baseUrl || 'api.deepseek.com(默认)'}`);
  if (official) {
    lines.push(
      '',
      '最常见的原因是 key 与端点不匹配:',
      '· 若这把 key 来自你自建的中转(new-api/one-api),它只在中转上有效 ——',
      '  必须同时把 dsh 的 baseUrl 指到中转地址,否则请求会被送去官方端点验签。',
      '· 若你想用官方端点,请到 platform.deepseek.com 申请一把官方 key。'
    );
  } else {
    lines.push('', '端点已指向自建中转,那么请检查:key 是否在该中转上有效、是否还有额度、'
      + `模型名是否是中转上真实存在的(中转常不提供官方同名模型)。`);
  }
  lines.push('', '改配置的位置:$DSH_HOME/cordis.patch.yml,或到「浏览」页打开 dsh 配置界面。');
  return lines.join('\n');
}

function explainSilence(code, stderr = '') {
  const tail = String(stderr || '').trim().slice(-600);
  const lines = [
    `dsh 退出(码 ${code ?? '未知'})但没有任何输出。`,
    '常见原因:',
    '· headless profile 首次运行需要联网自动初始化,可能很慢或失败',
    '· 模型路由没配 —— dsh 的模型/密钥在 $DSH_HOME/cordis.patch.yml,不读 DEEPSEEK_API_KEY',
    '到「环境配置」页点「测试 dsh」可以看到确切原因。'
  ];
  if (tail) lines.push('—— stderr ——', tail);
  return lines.join('\n');
}

module.exports = {
  dshDiagnoseCommand, parseDshConfig, explainSilence, explainAuthFailure,
  DSH_PACKAGE, DSH_BIN, DSH_MIN_NODE,
  dshInstallCommand, dshEnvPosix, dshEnvPowershell, dshArgs,
  withHistory, describeExit
};
