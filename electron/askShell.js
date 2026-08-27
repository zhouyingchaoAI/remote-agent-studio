/**
 * 终端里的「快速问一下」。
 *
 * 场景很具体:命令记不清了,不想切出去查。所以这个功能的取舍全都围绕
 * 「快」和「安全」两点:
 *
 *  · 只问一次、只要答案,不开会话、不改文件。
 *  · 终端输出是最好的上下文 —— 它是真文本,模型不用猜,还能直接引用报错原文。
 *    但**终端输出里经常有密钥**(export XXX_KEY=…、curl -H "Authorization: …"),
 *    发给模型前必须脱敏,这一点不能指望调用方记得。
 *  · 给出的命令**只填进终端,绝不自动执行**。模型给的命令可能是 rm -rf,
 *    也可能只是版本对不上;让人看一眼再按回车,成本是一秒,省掉的是不可逆的事故。
 */
const { redact } = require('./errorLog');

/** 终端输出带大量 ANSI 控制序列,不剥掉会白白占满上下文 */
function stripAnsi(text) {
  return String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;?]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\][^]*/g, '')
    .replace(/\r/g, '');
}

/**
 * 整理终端尾部输出:剥 ANSI、去空行、限行数,**并脱敏**。
 * @param maxLines 默认 60 行 —— 再多对回答质量没帮助,只是烧 token
 */
function sanitizeTail(raw, { maxLines = 60, maxChars = 6000 } = {}) {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, arr) => l.trim() || (i > 0 && arr[i - 1].trim()));  // 折叠连续空行
  const tail = lines.slice(-maxLines).join('\n').slice(-maxChars);
  // 复用异常日志那套脱敏规则:终端里 export KEY=... 太常见了
  return redact(tail);
}

/**
 * 组装提问。
 *
 * 明确要求「先给命令、再给一句为什么」:用户是来拿命令的,把解释放前面
 * 等于让人再滚动一次。同时要求命令放进 ```bash 块 —— 界面靠它切出可复制的按钮。
 */
function buildAskPrompt({ question, tail = '', env = {}, hasImage = false } = {}) {
  const q = String(question || '').trim();
  if (!q) throw new Error('问题不能为空');

  const parts = [
    '你是一个终端助手。用户正在一台机器的 shell 里操作,忘了某条命令怎么写。',
    '',
    '回答要求:',
    '1. **先给命令**,放在 ```bash 代码块里,一块一条(或一组连续步骤)',
    '2. 命令之后再用一两句话说明它做什么、有什么风险',
    '3. 只给这台机器上能直接跑的命令 —— 注意下面的环境信息,别给错包管理器',
    '4. 不确定时明说不确定,并给出先查证的命令,不要编一条看起来对的',
    '5. 简短。用户是在终端里急着用,不是来读文档的'
  ];

  const envLines = [];
  if (env.os) envLines.push(`系统:${env.os}`);
  if (env.shell) envLines.push(`shell:${env.shell}`);
  if (env.cwd) envLines.push(`当前目录:${env.cwd}`);
  if (env.user) envLines.push(`用户:${env.user}${env.user === 'root' ? '(root)' : ''}`);
  if (envLines.length) parts.push('', '【环境】', ...envLines);

  if (tail) {
    parts.push('', '【终端最近输出】(已脱敏,密钥类内容被替换成 ***)', '```', tail, '```');
  }
  if (hasImage) {
    parts.push('', '【截图】用户附了一张终端截图,一并参考。');
  }
  parts.push('', '【问题】', q);
  return parts.join('\n');
}

/** 探测当前主机环境,给提示词用 —— 免得给 Debian 的命令而机器是 CentOS */
function buildEnvCommand() {
  return [
    'echo "__OS__=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s )"',
    'echo "__SHELL__=$(basename "${SHELL:-sh}")"',
    'echo "__USER__=$(id -un 2>/dev/null || whoami)"',
    'echo "__CWD__=$PWD"'
  ].join('; ');
}

function parseEnv(text) {
  const pick = (k) => (String(text || '').match(new RegExp(`__${k}__=(.*)`)) || [, ''])[1].trim();
  return { os: pick('OS'), shell: pick('SHELL'), user: pick('USER'), cwd: pick('CWD') };
}

/**
 * 从回答里切出命令块。
 * 界面据此给「复制」和「填入终端」两个按钮 —— 没有这一步,用户还得自己
 * 从一段话里手动挑出命令,那这个功能就没省下什么。
 */
function extractCommands(answer) {
  const text = String(answer || '');
  const out = [];
  const re = /```(?:bash|sh|shell|zsh|console)?\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const block = m[1]
      .split('\n')
      /* 顺序要紧:先滤注释再剥提示符。反过来的话 `# 注释` 会先被当成
         root 提示符剥成 `注释`,注释判断随即失效,一句中文说明就被
         当成命令复制出去了。
         `#` 一律按注释处理 —— 它当 root 提示符的情况远少于当注释。 */
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => l.replace(/^\s*\$\s+/, ''))   // 只剥 `$ `,最常见的那种
      .join('\n')
      .trim();
    if (block) out.push(block);
  }
  return out;
}

module.exports = {
  stripAnsi, sanitizeTail, buildAskPrompt,
  buildEnvCommand, parseEnv, extractCommands
};
