/**
 * AgentSession - 在远程机上以流式 JSON 模式运行 codex / claude code,
 * 把事件解析为统一的聊天消息结构发给前端。
 *
 * 每轮对话 = 一次远程 exec(non-interactive + resume),避免 PTY 抓屏的脆弱性:
 *   codex : codex exec --json [resume --last] "<prompt>"
 *   claude: claude -p --output-format stream-json --verbose [--resume <id>] "<prompt>"
 */
const { EventEmitter } = require('events');
const path = require('path');
const { shellQuote } = require('./SSHManager');
const { extractImagePaths, isDangerousCommand } = require('../chat/attachments');
const { deepseekEnvPosix, deepseekEnvPowershell, resolveDeepseekModel } = require('./deepseek');
const {
  dshEnvPosix, dshEnvPowershell, dshArgs, withHistory, describeExit, explainSilence
} = require('./dsh');
const { isTransientAgentError, describeTransient } = require('../transientErrors');

const AGENT_PATH = 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"; ' +
  'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ' +
  '[ -s "$HOME/.remote-agent-node-env.sh" ] && . "$HOME/.remote-agent-node-env.sh"; ' +
  '[ -s "$HOME/.remote-agent-env.sh" ] && . "$HOME/.remote-agent-env.sh";';
const DOCKER_PERMISSION_ERROR = /(?:docker\.sock|docker daemon|docker:)[\s\S]*(?:operation not permitted|permission denied|no new privileges)|(?:operation not permitted|permission denied|no new privileges)[\s\S]*(?:docker\.sock|docker daemon|docker:)/i;
// tracing 风格的运行日志(2026-07-15T05:55:46Z ERROR ...):不在聊天里冒泡,
// 仅保留在诊断缓冲中,进程失败时随错误消息一起展示
const LOG_NOISE = /^\s*\d{4}-\d{2}-\d{2}T[0-9:.]+Z?\s+(ERROR|WARN|INFO|DEBUG|TRACE)\b/;

/**
 * CLI 自己的重试通告(Reconnecting... 2/5 之类)不是错误,是它在自愈。
 * 渲染成红色错误框会刷屏、也会让人误以为任务已经失败。
 */
const RETRY_NOTICE = /^\s*(reconnecting|retrying|retry)\b|重连中|正在重试/i;
function isRetryNotice(text) {
  return RETRY_NOTICE.test(String(text || '').trim().slice(0, 60));
}

function filterStderrNoise(text) {
  return String(text).split('\n')
    .filter((line) => line.trim() && !LOG_NOISE.test(line))
    .join('\n');
}

function normalizePermissionMode(rawOpts) {
  // 默认参数只在 undefined 时生效,挡不住显式传进来的 null ——
  // 而 null.permissionMode 会直接抛 TypeError 把整轮打断
  const opts = rawOpts || {};
  if (opts.permissionMode === 'system') return 'system';
  if (opts.permissionMode === 'workspace') return 'workspace';
  return opts.autoApprove === true ? 'system' : 'workspace';
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

class AgentSession extends EventEmitter {
  /**
   * @param ssh SSHManager
   * @param proxy ProxyService|null
   * @param opts {agent:'codex'|'claude'|'deepseek'|'dsh', cwd, permissionMode?:'workspace'|'system', autoApprove?:boolean, model?}
   *   deepseek: 复用 claude CLI 管线,注入 DeepSeek Anthropic 兼容端点(api.deepseek.com/anthropic)
   *   dsh     : DeepSeek Harness 无头模式。只输出最终文本,无流式/无工具事件/无 resume
   */
  constructor(ssh, proxy, opts) {
    super();
    this.ssh = ssh;
    this.proxy = proxy;
    /* 在源头把可空字段收敛成确定类型。
     * 这类 `cfg = {}` 默认参数挡不住 null 的 TypeError 已经出现两次
     * (normalizePermissionMode、dshEnvPosix),每次都是整轮对话直接崩。
     * 与其在每个下游消费点补 `|| {}`,不如让下游永远拿不到 null。 */
    this.opts = {
      ...opts,
      permissionMode: normalizePermissionMode(opts),
      dshConfig: (opts && opts.dshConfig) || {},
      history: Array.isArray(opts && opts.history) ? opts.history : []
    };
    this.claudeSessionId = null;
    this.codexSessionId = null; // codex 会话/线程 ID,优先用它精确 resume
    this.codexStarted = false;
    this.dshBuffer = '';            // dsh 无流式,先攒 stdout,收尾时整段发出
    this.running = false;
    this.stream = null;
    this.permissionHintEmitted = false;
  }

  /**
   * 记录 dsh 的一轮问答,供下一轮拼上下文。
   * 留最近 6 轮:再多会把提示词撑爆,而 dsh 每轮都要把它整段重发。
   */
  _recordDshTurn(prompt, reply) {
    const h = this.opts.history;
    if (prompt) h.push({ role: 'user', text: String(prompt) });
    if (reply) h.push({ role: 'assistant', text: String(reply) });
    const MAX = 12;
    if (h.length > MAX) h.splice(0, h.length - MAX);
  }

  _emitMsg(msg) {
    // 重试通告降级成状态提示,不占据错误气泡
    if ((msg.kind === 'error' || msg.kind === 'stderr') && isRetryNotice(msg.text)) {
      this.emit('message', { kind: 'status', text: String(msg.text).trim().slice(0, 160) });
      return;
    }
    this.emit('message', msg);
  }


  buildCommand(prompt, turn = {}) {
    const { agent, cwd, model, permissionMode } = this.opts;
    const attachments = Array.isArray(turn.attachments) ? turn.attachments : [];
    const context = [];
    if (attachments.length) {
      context.push('', 'Attached files are available at these paths:');
      for (const file of attachments) {
        context.push(`- [${file.kind || 'file'}] ${file.originalName || file.name || 'attachment'}: ${file.remotePath}`);
      }
    }
    if (turn.artifactDir) {
      context.push(
        '',
        `Save every generated image file in this directory: ${turn.artifactDir}`,
        'When image generation is requested, use the available image generation tool and keep the final image files in that directory.'
      );
    }
    const fullPrompt = `${prompt}${context.join('\n')}`;

    if (this.ssh?.isWindowsNative) {
      const cd = cwd ? `Set-Location -LiteralPath ${powershellQuote(cwd)}; ` : '';
      if (agent === 'dsh') {
        // dsh 没有 --model:模型由 profile 配置决定,对话里的模型选择对它无效
        return `${cd}${dshEnvPowershell(this.opts.dshConfig)} & dsh ${dshArgs()} ${powershellQuote(withHistory(fullPrompt, this.opts.history))}`;
      }
      if (agent === 'codex') {
        const approval = permissionMode === 'system'
          ? '--dangerously-bypass-approvals-and-sandbox'
          : '--sandbox workspace-write';
        const modelArg = model ? `-m ${powershellQuote(model)}` : '';
        const images = attachments
          .filter((file) => file.kind === 'image' && file.remotePath)
          .map((file) => `--image ${powershellQuote(file.remotePath)}`)
          .join(' ');
        const writableDirs = [...new Set([
          turn.artifactDir,
          ...attachments.map((file) => file.remotePath ? path.win32.dirname(file.remotePath) : '')
        ].filter(Boolean))]
          .map((dir) => `--add-dir ${powershellQuote(dir)}`)
          .join(' ');
        const flags = `--json --skip-git-repo-check ${approval} ${modelArg} ${images} ${writableDirs}`;
        // 优先用会话 ID 精确 resume;仅在拿不到 ID 时退回 --last(同目录多会话时可能串线)
        const resume = this.codexSessionId
          ? `resume ${powershellQuote(this.codexSessionId)} `
          : (this.codexStarted ? 'resume --last ' : '');
        return `${cd}& codex.cmd exec ${flags} ${resume}${powershellQuote(fullPrompt)}`;
      }
      const permission = permissionMode === 'system'
        ? '--dangerously-skip-permissions'
        : '--permission-mode acceptEdits';
      // deepseek: 同一 claude.cmd,前置注入 DeepSeek 端点变量,模型默认 v4-pro
      const dsEnv = agent === 'deepseek' ? `${deepseekEnvPowershell(this.opts.deepseekEndpoint)} ` : '';
      const effectiveModel = agent === 'deepseek' ? resolveDeepseekModel(model, this.opts.deepseekEndpoint) : model;
      const modelArg = effectiveModel ? `--model ${powershellQuote(effectiveModel)}` : '';
      const resume = this.claudeSessionId ? `--resume ${powershellQuote(this.claudeSessionId)}` : '';
      return `${cd}${dsEnv}& claude.cmd -p --output-format stream-json --include-partial-messages --verbose ${permission} ${modelArg} ${resume} ${powershellQuote(fullPrompt)}`;
    }

    // deepseek env 必须放在 AGENT_PATH 之后:它引用 ~/.remote-agent-env.sh 里的 DEEPSEEK_API_KEY
    const env = (this.proxy ? this.proxy.envPrefix() : '') + ' ' + AGENT_PATH +
      (agent === 'deepseek' ? ' ' + deepseekEnvPosix(this.opts.deepseekEndpoint) : '');
    const cd = cwd ? `cd ${shellQuote(cwd)} && ` : '';
    const q = shellQuote(fullPrompt);
    // 先回报 shell PID,再用 exec 让 agent 继承该 PID —— 「停止」时可以精确 kill 远端进程
    const wrap = (invocation) => `${env} ${cd}{ echo "__RAS_PID_$$__"; exec ${invocation}; } </dev/null`;

    if (agent === 'dsh') {
      // 每轮都是全新会话,多轮上下文只能靠把历史摘要拼进任务文本
      const task = shellQuote(withHistory(fullPrompt, this.opts.history));
      return wrap(`${dshEnvPosix(this.opts.dshConfig)} dsh ${dshArgs()} ${task}`);
    }
    if (agent === 'codex') {
      const approval = permissionMode === 'system'
        ? '--dangerously-bypass-approvals-and-sandbox'
        : '--sandbox workspace-write';
      const m = model ? `-m ${shellQuote(model)}` : '';
      const images = attachments
        .filter((file) => file.kind === 'image' && file.remotePath)
        .map((file) => `--image ${shellQuote(file.remotePath)}`)
        .join(' ');
      const writableDirs = [...new Set([
        turn.artifactDir,
        ...attachments.map((file) => file.remotePath?.replace(/\/[^/]+$/, ''))
      ].filter(Boolean))]
        .map((dir) => `--add-dir ${shellQuote(dir)}`)
        .join(' ');
      // 全局选项(--json/--skip-git-repo-check/--sandbox/-m)必须放在 resume 子命令之前
      const flags = `--json --skip-git-repo-check ${approval} ${m} ${images} ${writableDirs}`;
      // 优先用会话 ID 精确 resume;仅在拿不到 ID 时退回 --last(同目录多会话时可能串线)
      if (this.codexSessionId)
        return wrap(`codex exec ${flags} resume ${shellQuote(this.codexSessionId)} ${q}`);
      if (this.codexStarted)
        return wrap(`codex exec ${flags} resume --last ${q}`);
      return wrap(`codex exec ${flags} ${q}`);
    }
    // claude / deepseek(共用 claude CLI)
    const perm = permissionMode === 'system' ? '--dangerously-skip-permissions' : '--permission-mode acceptEdits';
    const effectiveModel = agent === 'deepseek' ? resolveDeepseekModel(model, this.opts.deepseekEndpoint) : model;
    const m = effectiveModel ? `--model ${shellQuote(effectiveModel)}` : '';
    const resume = this.claudeSessionId ? `--resume ${shellQuote(this.claudeSessionId)}` : '';
    return wrap(`claude -p --output-format stream-json --include-partial-messages --verbose ${perm} ${m} ${resume} ${q}`);
  }

  async send(prompt, turn = {}) {
    if (this.running) throw new Error('上一轮仍在执行中');

    /* buildCommand 会因配置非法而抛错(比如 DeepSeek 端点地址为空)。
     * 它以前在 try 之外、running 已置 true 之后调用 —— 一旦抛错,
     * running 永远停在 true,之后每条消息都报「上一轮仍在执行中」,
     * 整个对话彻底卡死,只能新建。所以先构造命令,成功了再置 running。 */
    let cmd;
    try {
      cmd = this.buildCommand(prompt, turn);
    } catch (e) {
      this._emitMsg({
        kind: 'error',
        text: `无法构造命令:${e.message}\n→ 多为引擎配置有误,请到「环境配置」页检查后重试。`
      });
      throw e;
    }

    this.running = true;
    this.imagePaths = [];
    this.lastLines = [];   // 最近的 stdout 行(诊断用)
    this.lastStderr = '';  // 最近的 stderr(诊断用)
    this.lastResultText = '';
    this.transient = null; // 本轮若因网络/代理中断,记下原因供上层自动续跑
    this._emitMsg({ kind: 'status', text: '正在远程执行...' });

    let buffer = '';
    try {
      const stream = await this.ssh.execStream(cmd);
      this.stream = stream;
      stream.on('data', (d) => {
        buffer += d.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) this._parseLine(line);
        }
      });
      stream.stderr.on('data', (d) => {
        const t = d.toString();
        this._maybeEmitPermissionHint(t);
        this.lastStderr = (this.lastStderr + t).slice(-1000);
        const informative = filterStderrNoise(t);
        if (informative.trim()) this._emitMsg({ kind: 'stderr', text: informative });
      });
      const exitCode = await new Promise((resolve) => stream.on('close', (code) => {
        if (buffer.trim()) this._parseLine(buffer.trim());
        // 判定本轮是不是被网络/代理掐断的(可自动续跑),而不是认证之类的硬错误
        const diag = [this.lastStderr, ...(this.lastLines || []), this.lastResultText || ''].join('\n');
        if (isTransientAgentError(diag)) {
          this.transient = describeTransient(diag);
        }
        if (code !== 0 && code != null) {
          const detail = [this.lastStderr.trim(), ...(this.lastLines || [])]
            .filter(Boolean).join('\n').slice(-800);
          if (this.opts.agent === 'dsh') {
            // dsh 以 0=完成、1=未完成,退 1 不一定是崩溃,措辞别误导
            const r = describeExit(code, this.dshBuffer, this.lastStderr);
            this._emitMsg({ kind: 'error', text: r.message });
          } else {
            this._emitMsg({
              kind: 'error',
              text: `进程退出码 ${code}(若提示未登录/无 API key,请到"环境配置"页设置)` +
                (detail ? `\n—— 最近输出 ——\n${detail}` : '')
            });
          }
        }
        resolve(code);
      }));
      // 仅在成功后标记,避免失败的首轮把下一轮误设为 resume
      if (this.opts.agent === 'codex' && (exitCode === 0 || exitCode == null)) this.codexStarted = true;
      if (this.opts.agent === 'dsh') {
        // dsh 只在 stdout 打最终文本,收尾时整段发出(没有流式增量可用)
        const text = this.dshBuffer.trim();
        this.dshBuffer = '';
        if (text) {
          this._emitMsg({ kind: 'text', text });
        } else if (exitCode === 0 || exitCode == null) {
          /* 退 0 却没有任何输出:用户发完消息之后画面上什么都不会出现。
           * 静默是最糟的失败方式 —— 宁可多说一句,也不能让人对着空白猜。
           * (非 0 已在上面的 describeExit 分支报过,不重复。) */
          this._emitMsg({ kind: 'error', text: explainSilence(exitCode, this.lastStderr) });
        }
        /* dsh 没有 --resume,每轮都是全新进程。之前 withHistory 拿到的
         * 永远是空数组 —— 上一轮说了什么它根本不知道,自然没法迭代优化。
         * 会话对象自己记账,不依赖渲染层传回来。 */
        this._recordDshTurn(prompt, text);
      }
      return { imagePaths: [...this.imagePaths] };
    } finally {
      this.running = false;
      this.stream = null;
    }
  }

  cancel() {
    if (this.stream) { try { this.stream.signal('INT'); this.stream.close(); } catch (_) {} }
    // 兜底:SSH 信号不一定送达,按记录的远端 PID 精确终止(先 TERM,2 秒后 KILL)
    if (this.remotePid && !this.ssh?.isLocal) {
      const pid = this.remotePid;
      this.ssh.exec(
        `kill -TERM ${pid} 2>/dev/null; (sleep 2; kill -KILL ${pid} 2>/dev/null) >/dev/null 2>&1 &`
      ).catch(() => {});
      this.remotePid = null;
    }
    this.running = false;
  }

  _parseLine(line) {
    // PID 标记行:记录远端进程号,不进入消息流
    const pidMatch = line.match(/^__RAS_PID_(\d+)__$/);
    if (pidMatch) { this.remotePid = Number(pidMatch[1]); return; }
    /* dsh 的 stdout 是纯文本(官方 headless 只打最终 assistant 文本),
     * 不是 NDJSON。硬走 JSON 解析会把每行都当成 raw 冒泡,刷一屏碎片。 */
    if (this.opts.agent === 'dsh') {
      if (this.lastLines) {
        this.lastLines.push(line.slice(0, 400));
        if (this.lastLines.length > 5) this.lastLines.shift();
      }
      this.dshBuffer += (this.dshBuffer ? '\n' : '') + line;
      return;
    }
    if (this.lastLines) {
      this.lastLines.push(line.slice(0, 400));
      if (this.lastLines.length > 5) this.lastLines.shift();
    }
    let ev;
    try { ev = JSON.parse(line); } catch (_) {
      this._emitMsg({ kind: 'raw', text: line });
      return;
    }
    for (const imagePath of extractImagePaths(ev)) {
      if (!this.imagePaths.includes(imagePath)) this.imagePaths.push(imagePath);
    }
    if (this.opts.agent === 'codex') this._parseCodex(ev);

    else this._parseClaude(ev);
  }

  _maybeEmitPermissionHint(text) {
    if (this.opts.permissionMode !== 'workspace' || this.permissionHintEmitted || !DOCKER_PERMISSION_ERROR.test(text)) return;
    this.permissionHintEmitted = true;
    this._emitMsg({
      kind: 'permission_hint',
      text: 'Docker access is blocked in workspace mode (/var/run/docker.sock). Enable System Mode and retry.'
    });
  }

  /** codex exec --json 的事件(兼容新旧两种格式) */
  _parseCodex(ev) {
    // 新格式: {type:'item.completed', item:{type,text,...}}
    const item = ev.item || null;
    const t = ev.type || '';
    // 捕获会话/线程 ID,供下一轮精确 resume
    if ((t === 'thread.started' || t === 'session.created') && (ev.thread_id || ev.session_id)) {
      this.codexSessionId = ev.thread_id || ev.session_id;
    }
    // 新格式的增量事件(流式输出)
    if (t === 'item.delta') {
      const delta = ev.delta ?? ev.item?.delta ?? '';
      if (typeof delta === 'string' && delta) {
        const it = ev.item?.item_type || ev.item?.type || '';
        return this._emitMsg({ kind: it === 'reasoning' ? 'reasoning_delta' : 'text_delta', text: delta });
      }
      return;
    }
    // 新格式的顶层错误事件(旧解析器会静默丢弃,导致只看到退出码)
    if (t === 'error') {
      return this._emitMsg({ kind: 'error', text: ev.message || JSON.stringify(ev) });
    }
    if (t === 'turn.failed' || t === 'thread.failed') {
      const err = ev.error || {};
      return this._emitMsg({ kind: 'error', text: err.message || JSON.stringify(err) || '任务失败' });
    }
    // 回合用量统计(token)
    if (t === 'turn.completed' && ev.usage) {
      return this._emitMsg({
        kind: 'usage',
        inputTokens: (ev.usage.input_tokens || 0) + (ev.usage.cached_input_tokens || 0),
        outputTokens: ev.usage.output_tokens || 0
      });
    }
    if (item) {
      const it = item.item_type || item.type;
      if (t === 'item.completed' || t === 'item.updated') {
        if (it === 'error') return this._emitMsg({ kind: 'stderr', text: item.message || item.text || '' });
        if (it === 'agent_message') return this._emitMsg({ kind: 'text', text: item.text || '' });
        if (it === 'reasoning') return this._emitMsg({ kind: 'reasoning', text: item.text || '' });
        if (it === 'command_execution') {
          const output = (item.aggregated_output || '').slice(0, 4000);
          this._maybeEmitPermissionHint(output);
          return this._emitMsg({ kind: 'tool', name: '执行命令', detail: item.command, output, dangerous: isDangerousCommand(item.command) });
        }
        if (it === 'file_change' || it === 'patch')
          return this._emitMsg({ kind: 'tool', name: '修改文件', detail: (item.changes || []).map(c => `${c.kind || ''} ${c.path || ''}`).join('\n') || item.path });
      }
      return;
    }
    // 旧格式: {msg:{type:...}}
    const msg = ev.msg || {};
    switch (msg.type) {
      case 'session_configured':
        if (msg.session_id) this.codexSessionId = msg.session_id;
        return;
      case 'agent_message': return this._emitMsg({ kind: 'text', text: msg.message || '' });
      case 'agent_reasoning': return this._emitMsg({ kind: 'reasoning', text: msg.text || '' });
      case 'agent_message_delta':
        return msg.delta ? this._emitMsg({ kind: 'text_delta', text: msg.delta }) : undefined;
      case 'agent_reasoning_delta':
        return msg.delta ? this._emitMsg({ kind: 'reasoning_delta', text: msg.delta }) : undefined;
      case 'turn_diff':
        return msg.unified_diff ? this._emitMsg({ kind: 'diff', text: msg.unified_diff }) : undefined;
      case 'exec_command_begin': {
        const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : msg.command;
        return this._emitMsg({ kind: 'tool', name: '执行命令', detail: cmd, dangerous: isDangerousCommand(cmd) });
      }
      case 'exec_command_end': {
        const output = (msg.aggregated_output || '').slice(0, 4000);
        this._maybeEmitPermissionHint(output);
        return this._emitMsg({ kind: 'tool_output', output });
      }
      case 'patch_apply_begin':
        return this._emitMsg({ kind: 'tool', name: '修改文件', detail: Object.keys(msg.changes || {}).join('\n') });
      case 'task_complete':
        return this._emitMsg({ kind: 'result', text: msg.last_agent_message || '' });
      case 'error':
        return this._emitMsg({ kind: 'error', text: msg.message || JSON.stringify(msg) });
      default: return;
    }
  }

  /** claude -p --output-format stream-json 的事件 */
  _parseClaude(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.session_id) this.claudeSessionId = ev.session_id;
        return;
      case 'stream_event': {
        // --include-partial-messages 的增量事件(流式输出)
        const e = ev.event || {};
        if (e.type === 'content_block_delta') {
          const d = e.delta || {};
          if (d.type === 'text_delta' && d.text) this._emitMsg({ kind: 'text_delta', text: d.text });
          else if (d.type === 'thinking_delta' && d.thinking) this._emitMsg({ kind: 'reasoning_delta', text: d.thinking });
        }
        return;
      }
      case 'assistant': {
        const blocks = ev.message?.content || [];
        for (const b of blocks) {
          if (b.type === 'text' && b.text) this._emitMsg({ kind: 'text', text: b.text });
          else if (b.type === 'thinking' && b.thinking) this._emitMsg({ kind: 'reasoning', text: b.thinking });
          else if (b.type === 'tool_use') {
            const input = b.input || {};
            const detail = input.command || input.file_path || input.pattern ||
              JSON.stringify(input).slice(0, 500);
            const msg = { kind: 'tool', name: b.name, detail, dangerous: isDangerousCommand(input.command) };
            // 文件编辑类工具:携带 old/new 内容供前端渲染红绿 diff
            if (/^(Edit|MultiEdit|Write)$/i.test(b.name || '')) {
              if (input.old_string != null || input.new_string != null) {
                msg.diff = {
                  old: String(input.old_string || '').slice(0, 4000),
                  new: String(input.new_string || input.content || '').slice(0, 4000)
                };
              } else if (input.content != null) {
                msg.diff = { old: '', new: String(input.content).slice(0, 4000) };
              }
            }
            this._emitMsg(msg);
          }
        }
        return;
      }
      case 'user': {
        // 工具结果
        const blocks = ev.message?.content || [];
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content
              : (b.content || []).map((c) => c.text || '').join('\n');
            this._maybeEmitPermissionHint(text);
            if (text.trim()) this._emitMsg({ kind: 'tool_output', output: text.slice(0, 4000) });
          }
        }
        return;
      }
      case 'result':
        if (ev.session_id) this.claudeSessionId = ev.session_id;
        // result 里可能带 "API Error: Connection closed mid-response" 这类中断信息,
        // 即使 is_error 为真、退出码为 0,也要据此判定可续跑
        if (ev.result) this.lastResultText = String(ev.result).slice(0, 1000);
        if (ev.usage || ev.total_cost_usd != null) {
          this._emitMsg({
            kind: 'usage',
            inputTokens: ev.usage?.input_tokens || 0,
            outputTokens: ev.usage?.output_tokens || 0,
            costUsd: ev.total_cost_usd || 0
          });
        }
        return this._emitMsg({
          kind: 'result',
          text: ev.result || '',
          costUsd: ev.total_cost_usd,
          durationMs: ev.duration_ms
        });
      default: return;
    }
  }
}

module.exports = { AgentSession, filterStderrNoise, isRetryNotice };
