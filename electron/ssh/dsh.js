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
function dshEnvPosix(cfg = {}) {
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

function dshEnvPowershell(cfg = {}) {
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
function dshArgs() {
  return '--profile headless';
}

/**
 * 多轮上下文:dsh 每次都是新会话,只能把历史摘要拼进任务文本。
 * 不做的话第二句「那再改一下 X」它完全不知道在说什么。
 */
function withHistory(prompt, history = []) {
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
function describeExit(code, stdout = '', stderr = '') {
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

module.exports = {
  DSH_PACKAGE, DSH_BIN, DSH_MIN_NODE,
  dshInstallCommand, dshEnvPosix, dshEnvPowershell, dshArgs,
  withHistory, describeExit
};
