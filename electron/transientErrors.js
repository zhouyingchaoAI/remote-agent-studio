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

/**
 * codex 线程存储被占用。
 *
 *   thread-store conflict: thread <id> already has an active writer
 *   thread/resume failed: ... (code -32600)
 *
 * 这是一类**很特别的失败**,单独识别是因为它有三个反直觉的性质:
 *
 * 1. 它**看起来像连不上**(一发消息就红框、每次都一样),
 *    实际跟网络毫无关系 —— 是本机/远端还有个 codex 进程占着这个线程的写锁,
 *    或者上次的进程被 KILL 掉、锁没释放干净。
 *
 * 2. **重试一万次也是同样结果。** 应用把 thread id 存了下来,每轮都
 *    `codex exec resume <同一个 id>`,于是永远撞在同一把锁上 ——
 *    用户看到的就是"一直连不上"。
 *
 * 3. 所以正确的动作不是重试,是**别再 resume 这个线程**。
 */
const THREAD_LOCK_RE = /thread-store conflict|already has an active writer|thread\/resume failed/i;
function isThreadLockError(text = '') {
  return THREAD_LOCK_RE.test(String(text || ''));
}

/** 给用户的说明:说清它不是网络问题,并给出能自己动手的那一步 */
function describeThreadLock(text = '') {
  const id = (String(text || '').match(/thread ([0-9a-f-]{8,})/i) || [])[1] || '';
  return [
    '⚠ 这不是网络问题,是 codex 的会话线程被占用了' + (id ? `(${id})` : '') + '。',
    '原因通常是上一个 codex 进程还活着,或者被强制杀掉后没释放锁。',
    '',
    '已自动改用新线程继续(本轮上下文会带过去)。若仍然失败,到那台机器上执行:',
    '  pgrep -af "codex exec" ; # 看看还有没有残留进程,有就 kill 掉',
    '  rm -f ~/.codex/threads/*.lock 2>/dev/null  # 清理残留锁(路径以实际安装为准)'
  ].join('\n');
}

const testAny = (patterns, text) => patterns.some((re) => re.test(text));

/**
 * 判断一轮失败是否值得自动续跑。
 * 不可重试信号优先 —— 宁可少重试,也不要在认证失效时反复空转。
 */
function isTransientAgentError(text = '') {
  const s = String(text || '');
  if (!s.trim()) return false;
  if (testAny(PERMANENT_PATTERNS, s)) return false;
  /* 线程锁冲突绝不能当成瞬时错误。
     它的报文里常夹着 "timeout waiting for child process to exit",
     一不留神就会被 TRANSIENT 里的 timeout 规则捞进去 —— 那样应用会
     拿着同一个 thread id 一遍遍 resume,每次都撞同一把锁,
     退避重试只是把"立刻失败"变成"慢慢地一直失败"。 */
  if (isThreadLockError(s)) return false;
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
  isThreadLockError, describeThreadLock,
  TRANSIENT_PATTERNS, PERMANENT_PATTERNS
};
