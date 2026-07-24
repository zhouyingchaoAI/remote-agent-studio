/**
 * DeepSeek 引擎配置 - 通过 DeepSeek 官方 Anthropic 兼容 API 驱动 Claude Code CLI。
 * 官方文档: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
 *
 * 引擎 'deepseek' 复用 claude 的命令管线与流式 JSON 解析,只在进程环境里
 * 注入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等变量。
 * API Key 从 DEEPSEEK_API_KEY 读取(远程存放于 ~/.remote-agent-env.sh, 600 权限)。
 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
// 主模型: V4 Pro(128K 上下文的 1m 变体);轻量任务/子代理用 flash
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-pro[1m]';
const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_MODEL_PRESETS = [DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_FLASH_MODEL];

/** POSIX shell(远程 Linux / 本机 mac)env 前缀 */
function deepseekEnvPosix() {
  return [
    `export ANTHROPIC_BASE_URL=${DEEPSEEK_BASE_URL};`,
    // 避免已配置的 Anthropic 官方 key 干扰鉴权
    'unset ANTHROPIC_API_KEY;',
    'export ANTHROPIC_AUTH_TOKEN="${DEEPSEEK_API_KEY:-}";',
    `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${JSON.stringify(DEEPSEEK_FLASH_MODEL)};`,
    `export CLAUDE_CODE_SUBAGENT_MODEL=${JSON.stringify(DEEPSEEK_FLASH_MODEL)};`
  ].join(' ');
}

/** Windows PowerShell env 前缀 */
function deepseekEnvPowershell() {
  return [
    `$env:ANTHROPIC_BASE_URL='${DEEPSEEK_BASE_URL}';`,
    "$env:ANTHROPIC_API_KEY=$null;",
    "$env:ANTHROPIC_AUTH_TOKEN=$env:DEEPSEEK_API_KEY;",
    `$env:ANTHROPIC_DEFAULT_HAIKU_MODEL='${DEEPSEEK_FLASH_MODEL}';`,
    `$env:CLAUDE_CODE_SUBAGENT_MODEL='${DEEPSEEK_FLASH_MODEL}';`
  ].join(' ');
}

/** deepseek 引擎实际执行时使用的模型(未指定则用默认主模型) */
function resolveDeepseekModel(model) {
  return String(model || '').trim() || DEEPSEEK_DEFAULT_MODEL;
}

module.exports = {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_MODEL_PRESETS,
  deepseekEnvPosix,
  deepseekEnvPowershell,
  resolveDeepseekModel
};
