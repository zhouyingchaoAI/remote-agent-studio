/**
 * 瞬时(可重试)错误识别。
 *
 * 长任务最常见的失败不是模型出错,而是网络/代理把长连接掐断:
 *   API Error: Connection closed mid-response.
 * Claude/Codex 走 SSE 流式响应,一次回合可能持续好几分钟,
 * 代理只要有空闲超时或总时长上限就会中断,CLI 只能报错退出。
 *
 * 这类错误重试有意义(会话 ID 还在,可以 resume 接着干);
 * 而认证类错误重试毫无意义,只会白烧钱 —— 必须严格区分。
 */

/** 可重试:网络层中断、上游过载、超时 */
const TRANSIENT_PATTERNS = [
  /connection closed mid-?response/i,
  /socket hang ?up/i,
  /ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/,
  /fetch failed/i,
  /stream (ended|closed) (unexpectedly|prematurely)/i,
  /request timed out|timeout of \d+ms exceeded/i,
  /\b(429|500|502|503|504|529)\b/,
  /overloaded/i,
  /service unavailable|bad gateway|gateway time-?out/i,
  /premature close/i,
  /terminated unexpectedly/i,
  // 代理侧故障:CONNECT 阶段失败、隧道被拒,长任务最常见的中断来源
  /proxy connection failed|CONNECT failed|tunnel connection failed|proxy error/i,
  /stream disconnected before completion/i
];

/** 不可重试:认证/额度/权限/参数错误 —— 重试也是同样结果 */
const PERMANENT_PATTERNS = [
  /oauth session expired|could not be refreshed/i,
  /\b(401|403)\b/,
  /unauthorized|forbidden/i,
  /invalid api key|api key not valid|authentication_error/i,
  /not logged in|please run \/login|login expired/i,
  /credit balance is too low|insufficient (quota|credits|balance)/i,
  /out of usage credits|usage limit (reached|exceeded)|quota exceeded|rate limit exceeded.*upgrade/i,
  /permission denied/i,
  /invalid_request_error|model not found/i
];

const testAny = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * 判断一轮失败是否值得自动续跑。
 * 不可重试信号优先 —— 宁可少重试,也不要在认证失效时反复空转。
 */
function isTransientAgentError(text = '') {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (testAny(PERMANENT_PATTERNS, s)) return false;
  return testAny(TRANSIENT_PATTERNS, s);
}

/** 给用户看的原因简述(便于界面提示) */
function describeTransient(text = '') {
  const s = String(text || '');
  if (/proxy connection failed|CONNECT failed|proxy error/i.test(s)) return '代理连接失败(CONNECT 被拒,多为节点不稳定)';
  if (/connection closed mid-?response|stream disconnected before completion/i.test(s)) return '响应中途连接被断开(多为代理超时)';
  if (/socket hang ?up|ECONNRESET|premature close/i.test(s)) return '连接被重置';
  if (/timed out|ETIMEDOUT|timeout/i.test(s)) return '请求超时';
  if (/overloaded|\b529\b|\b429\b/i.test(s)) return '上游繁忙';
  if (/\b(500|502|503|504)\b|bad gateway|service unavailable/i.test(s)) return '上游服务异常';
  return '网络中断';
}

/** 指数退避(含上限),避免上游繁忙时火上浇油 */
function retryDelayMs(attempt, { base = 2000, max = 20000 } = {}) {
  return Math.min(base * (2 ** Math.max(0, attempt)), max);
}

module.exports = {
  isTransientAgentError, describeTransient, retryDelayMs,
  TRANSIENT_PATTERNS, PERMANENT_PATTERNS
};
