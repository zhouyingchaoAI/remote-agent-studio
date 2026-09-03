/**
 * SSHManager - 单个远程主机的 SSH 会话管理
 * 提供:连接、命令执行(exec)、交互 shell、SFTP、反向端口转发(remote -> local)
 */
const { Client } = require('ssh2');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { TransferCancelled } = require('./transfer');
const { ChannelPool, parseMaxSessions, MAX_SESSIONS_PROBE } = require('./channelPool');

class SSHManager extends EventEmitter {
  constructor(hostConfig) {
    super();
    this.config = hostConfig; // {id,name,host,port,username,password,privateKeyPath,passphrase}
    this.client = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.sftpSession = null;
    this.shells = new Map();         // termId -> shell stream(多终端标签)
    this.reverseTunnels = new Map(); // remotePort -> {targetHost,targetPort}
    this.manualClose = false;        // 用户主动断开时不做自动重连
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    // 通道闸门:主动排队,而不是等 sshd 拒绝再报「Channel open failure」
    this.channels = new ChannelPool();
    this.sftpRelease = null;
    this.sftpPromise = null;       // 初始化中的 SFTP 会话(并发请求共用)
  }

  _setStatus(status, detail) {
    this.status = status;
    this.emit('status', { status, detail });
  }

  async connect() {
    if (this.status === 'connected') return;
    this.manualClose = false;
    this._setStatus('connecting');
    const conn = new Client();
    this.client = conn;

    const connectCfg = {
      host: this.config.host,
      port: this.config.port || 22,
      username: this.config.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true // 兼容仅支持 keyboard-interactive 密码认证的服务器
    };
    // 主机指纹校验(TOFU):校验策略由外部注入(config.verifyHostKey),
    // 返回 false 时中断握手,防止中间人攻击
    if (typeof this.config.verifyHostKey === 'function') {
      connectCfg.hostVerifier = (key, verify) => {
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64');
        Promise.resolve(this.config.verifyHostKey(fingerprint))
          .then((ok) => verify(!!ok))
          .catch(() => verify(false));
      };
    }
    if (this.config.password) connectCfg.password = this.config.password;
    if (this.config.privateKeyPath) {
      connectCfg.privateKey = fs.readFileSync(untildify(this.config.privateKeyPath));
      if (this.config.passphrase) connectCfg.passphrase = this.config.passphrase;
    }
    // 无密码且无私钥时,尝试默认密钥
    if (!connectCfg.password && !connectCfg.privateKey) {
      for (const name of ['id_ed25519', 'id_rsa']) {
        const p = path.join(require('os').homedir(), '.ssh', name);
        if (fs.existsSync(p)) { connectCfg.privateKey = fs.readFileSync(p); break; }
      }
    }

    await new Promise((resolve, reject) => {
      conn
        .on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
          finish(prompts.map(() => this.config.password || ''));
        })
        .on('ready', () => {
          this.reconnectAttempt = 0;
          this.channels.reset();               // 新连接,旧名额一并作废
          this._setStatus('connected');
          resolve();
          // 探到真实 MaxSessions 才能把闸门开到刚好,不阻塞连接完成
          this.detectMaxSessions().catch(() => {});
        })
        .on('error', (err) => { this._setStatus('error', err.message); reject(err); })
        .on('close', () => {
          const wasConnected = this.status === 'connected';
          this.sftpSession = null;
          this.sftpRelease = null;
          this.sftpPromise = null;
          this.shells.clear();
          // 通道随连接一起没了:清空占用并让排队者立刻失败,不要挂到超时
          this.channels.reset(new Error('SSH 连接已断开'));
          if (this.status !== 'error') this._setStatus('disconnected');
          // 意外掉线 -> 指数退避自动重连(用户主动断开除外)
          if (wasConnected && !this.manualClose) this._scheduleReconnect();
        })
        .on('tcp connection', (info, accept, rejectConn) => {
          this._handleReverseConnection(info, accept, rejectConn);
        })
        .connect(connectCfg);
    });
  }

  disconnect() {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.client) { try { this.client.end(); } catch (_) {} }
    this.client = null;
    this._setStatus('disconnected');
  }

  /** 意外掉线后的自动重连:1s/2s/4s/8s/16s 五次,成功后重建反向隧道 */
  _scheduleReconnect() {
    if (this.reconnectAttempt >= 5) {
      this._setStatus('error', '自动重连失败(已重试 5 次),请手动重新连接');
      this.reconnectAttempt = 0;
      return;
    }
    this.reconnectAttempt += 1;
    const delay = 1000 * Math.pow(2, this.reconnectAttempt - 1);
    this._setStatus('connecting', `连接已断开,${Math.round(delay / 1000)}s 后自动重连 (${this.reconnectAttempt}/5)`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.manualClose) return;
      try {
        this.status = 'disconnected'; // 允许 connect() 重新执行
        await this.connect();
        // 重建之前的反向隧道
        for (const [remotePort, t] of [...this.reverseTunnels]) {
          try {
            await new Promise((resolve, reject) =>
              this.client.forwardIn('127.0.0.1', remotePort, (err) => (err ? reject(err) : resolve())));
            this.emit('tunnel', { remotePort, ...t, active: true });
          } catch (_) {
            this.emit('status', { status: 'connected', detail: `隧道 ${remotePort} 重建失败,请到环境配置页重新应用代理` });
          }
        }
      } catch (_) {
        this._scheduleReconnect();
      }
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  /** 是否为"通道开不出来"类错误(sshd MaxSessions 占满时的典型报错) */
  static isChannelExhausted(err) {
    return /channel open failure|open failed|administratively prohibited|resource shortage/i
      .test(String(err?.message || err || ''));
  }

  /** 释放可随时重建的 SFTP 通道,给新命令腾出名额 */
  _releaseSftp() {
    if (!this.sftpSession) return false;
    try { this.sftpSession.end(); } catch (_) {}
    this.sftpSession = null;
    this.sftpPromise = null;
    // end() 的 close 事件不一定同步到达,这里显式归还名额(release 幂等)
    if (this.sftpRelease) { this.sftpRelease(); this.sftpRelease = null; }
    return true;
  }

  /**
   * 探测远程 sshd 的 MaxSessions,据此调整闸门上限。
   * 探测不到就保持默认(按 10 算),多探一次总比让用户自己猜好。
   */
  async detectMaxSessions() {
    try {
      const r = await this.exec(MAX_SESSIONS_PROBE);
      const n = parseMaxSessions(r.stdout);
      if (n) return { maxSessions: n, limit: this.channels.setMaxSessions(n) };
    } catch (_) { /* 探测失败不影响使用 */ }
    return { maxSessions: null, limit: this.channels.limit };
  }

  /**
   * 打开 exec 通道;通道耗尽时先回收 SFTP 通道再退避重试,
   * 仍失败则抛出可操作的中文提示(而不是 ssh2 的 "open failed")。
   */
  async _openExec(command, channelOpts = {}) {
    // 先排队拿名额,拿不到就等 —— 这一步把绝大多数「通道用尽」挡在发生之前
    const release = await this.channels.acquire({ label: 'exec' });
    let stream;
    try {
      stream = await this._openExecRaw(command, channelOpts);
    } catch (e) {
      release();
      throw e;
    }
    // close 与 error 都可能触发,release 本身幂等
    stream.on('close', release);
    stream.on('error', release);
    return stream;
  }

  async _openExecRaw(command, channelOpts = {}) {
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await new Promise((resolve, reject) => {
          if (!this.client) return reject(new Error('未连接'));
          this.client.exec(command, channelOpts, (err, stream) => (err ? reject(err) : resolve(stream)));
        });
      } catch (err) {
        lastErr = err;
        if (!SSHManager.isChannelExhausted(err)) throw err;
        this._releaseSftp(); // 回收一个通道名额
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    const s = this.channels.stats();
    throw new Error(
      'SSH 通道已用尽,无法执行新命令。\n' +
      `当前占用 ${s.inUse}/${s.limit},排队 ${s.pending}。\n` +
      '常见原因:远程 sshd 的 MaxSessions(默认 10)被终端标签、文件传输、后台任务占满。\n' +
      '处理:关闭多余的「终端」标签后重试;或在远程 /etc/ssh/sshd_config 调大 MaxSessions 后 reload sshd。\n' +
      `原始错误:${lastErr?.message || lastErr}`
    );
  }

  /** 执行命令,整体返回 {code, stdout, stderr} */
  async exec(command, opts = {}) {
    const stream = await this._openExec(command, { pty: opts.pty || false });
    return new Promise((resolve) => {
      let stdout = '', stderr = '';
      stream.on('data', (d) => {
        stdout += d.toString();
        if (opts.onStdout) opts.onStdout(d.toString());
      });
      stream.stderr.on('data', (d) => {
        stderr += d.toString();
        if (opts.onStderr) opts.onStderr(d.toString());
      });
      /* 超时:远端命令(尤其 docker login 连不上仓库时)能挂很久,
         界面就一直停在「登录中…」。给个明确结论好过让人对着转圈猜。 */
      let timer = null;
      const done = (r) => { if (timer) clearTimeout(timer); resolve(r); };
      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          try { stream.close?.() || stream.signal?.('KILL'); } catch (_) {}
          done({ code: 124, stdout, stderr: `${stderr}\n[超时] 命令超过 ${Math.round(opts.timeoutMs / 1000)} 秒未返回` });
        }, opts.timeoutMs);
      }
      stream.on('close', (code) => done({ code: code ?? 0, stdout, stderr }));
      if (opts.stdin != null) { stream.write(opts.stdin); stream.end(); }
    });
  }

  /** 流式执行,返回 stream 句柄(供 AgentSession 使用) */
  execStream(command) {
    return this._openExec(command, {});
  }

  /** 打开交互 shell(支持多终端标签,按 termId 区分) */
  async openShell({ termId = 'default', cols = 80, rows = 24 } = {}) {
    const existing = this.shells.get(termId);
    if (existing) return existing;
    if (!this.client) throw new Error('未连接');
    // 终端是长期占用通道的大户,同样要走闸门,否则开几个标签就把名额吃光
    const release = await this.channels.acquire({ label: `shell:${termId}` });
    const stream = await new Promise((resolve, reject) => {
      this.client.shell(
        { term: 'xterm-256color', cols, rows },
        // 设置 UTF-8 locale 修复中文乱码;传递代理相关环境变量
        { env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color' } },
        (err, s) => {
          if (err) { release(); return reject(err); }
          s.on('close', () => { this.shells.delete(termId); release(); });
          s.on('error', release);
          // shell 启动后自动加载代理配置与 agent PATH,并确保 UTF-8
          const init =
            'export LANG=C.UTF-8 LC_ALL=C.UTF-8 2>/dev/null; ' +
            '[ -f ~/.remote-agent-proxy.sh ] && . ~/.remote-agent-proxy.sh; ' +
            'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"; ' +
            'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; ' +
            '[ -s "$HOME/.remote-agent-node-env.sh" ] && . "$HOME/.remote-agent-node-env.sh"; ' +
            '[ -s "$HOME/.remote-agent-env.sh" ] && . "$HOME/.remote-agent-env.sh"; ' +
            'clear\n';
          s.write(init);
          resolve(s);
        }
      );
    });
    this.shells.set(termId, stream);
    return stream;
  }

  getShell(termId = 'default') { return this.shells.get(termId) || null; }
  writeShell(termId, data) { const s = this.shells.get(termId); if (s) s.write(data); }
  resizeShell(termId, cols, rows) { const s = this.shells.get(termId); if (s) s.setWindow(rows, cols, 0, 0); }
  closeShell(termId) {
    const s = this.shells.get(termId);
    if (s) { try { s.end(); } catch (_) {} this.shells.delete(termId); }
  }

  /** SFTP 会话(懒加载,同样占一个通道名额) */
  async sftp() {
    if (this.sftpSession) return this.sftpSession;
    // 对话恢复会同时拉取多张图片。首个 sftp() 还在握手时，
    // 不能让后续调用各开一条 SFTP 通道，否则很快耗尽 MaxSessions。
    if (this.sftpPromise) return this.sftpPromise;
    this.sftpPromise = (async () => {
      const release = await this.channels.acquire({ label: 'sftp' });
      return new Promise((resolve, reject) => {
        if (!this.client) { release(); return reject(new Error('未连接')); }
        this.client.sftp((err, sftp) => {
          if (err) { release(); return reject(err); }
          this.sftpSession = sftp;
          this.sftpRelease = release;
          sftp.on('close', () => {
            this.sftpSession = null;
            this.sftpRelease = null;
            this.sftpPromise = null;
            release();
          });
          resolve(sftp);
        });
      });
    })();
    this.sftpPromise.catch(() => { this.sftpPromise = null; });
    return this.sftpPromise;
  }

  /** SFTP realpath(promise 化):解析 ~ / 符号链接 / 相对路径 */
  _sftpRealpath(sftp, p) {
    return new Promise((resolve, reject) =>
      sftp.realpath(p, (err, resolved) => (err ? reject(err) : resolve(resolved))));
  }

  _sftpReaddir(sftp, p) {
    return new Promise((resolve, reject) =>
      sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list))));
  }

  /** 解析远程路径:~ 展开(经 SFTP,不依赖 shell)+ 规范化 */
  async resolveRemotePath(remotePath) {
    const sftp = await this.sftp();
    let target = remotePath || '~';
    if (target === '~') target = await this._sftpRealpath(sftp, '.');
    else if (target.startsWith('~/')) {
      const home = await this._sftpRealpath(sftp, '.');
      target = `${home}/${target.slice(2)}`;
    }
    target = target.replace(/\/{2,}/g, '/');
    if (target.length > 1) target = target.replace(/\/+$/, '');
    return target;
  }

  async statRemote(remotePath) {
    const sftp = await this.sftp();
    const p = await this.resolveRemotePath(remotePath);
    return new Promise((resolve, reject) =>
      sftp.stat(p, (err, st) => (err ? reject(new Error(`无法读取 ${p}: ${err.message}`)) : resolve({ path: p, size: st.size, mtime: st.mtime * 1000 }))));
  }

  /** 读取远程文件前 maxBytes 字节(预览用,不落盘) */
  async readRemoteFile(remotePath, maxBytes) {
    const sftp = await this.sftp();
    const p = await this.resolveRemotePath(remotePath);
    return new Promise((resolve, reject) => {
      const chunks = [];
      const rs = sftp.createReadStream(p, { start: 0, end: Math.max(0, maxBytes - 1) });
      rs.on('data', (c) => chunks.push(c));
      rs.on('error', (err) => reject(new Error(`无法读取 ${p}: ${err.message}`)));
      rs.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async listRemoteDir(remotePath) {
    const sftp = await this.sftp();
    let target = await this.resolveRemotePath(remotePath);

    let list;
    try {
      list = await this._sftpReaddir(sftp, target);
    } catch (err) {
      // 符号链接/相对路径导致的失败,realpath 解析后重试一次
      const resolved = await this._sftpRealpath(sftp, target).catch(() => null);
      if (resolved && resolved !== target) {
        try {
          list = await this._sftpReaddir(sftp, resolved);
          target = resolved;
        } catch (err2) {
          throw new Error(`无法打开目录 ${target}: ${err2.message}`);
        }
      } else {
        throw new Error(`无法打开目录 ${target}: ${err.message}`);
      }
    }
    const entries = list.map((e) => ({
      name: e.filename,
      size: e.attrs.size,
      mtime: e.attrs.mtime * 1000,
      isDir: (e.attrs.mode & 0o170000) === 0o040000,
      isLink: (e.attrs.mode & 0o170000) === 0o120000
    })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    return { path: target, entries };
  }

  /**
   * 上传单个文件。
   *
   * 用流而不是 fastPut:fastPut 没有中止手段,一旦开始就只能等它跑完 ——
   * 21 GB 的文件传错了也停不下来。流可以 destroy(),代价是没有并行分块,
   * 高延迟链路上略慢,但可控性更重要。
   * @param signal {aborted:boolean, onAbort:fn} 简易取消令牌
   */
  async upload(localPath, remotePath, onProgress, signal) {
    const sftp = await this.sftp();
    const total = fs.statSync(localPath).size;
    return new Promise((resolve, reject) => {
      let transferred = 0;
      let settled = false;
      const rs = fs.createReadStream(localPath);
      const ws = sftp.createWriteStream(remotePath);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (signal) signal.onAbort = null;
        if (err) { try { rs.destroy(); ws.destroy(); } catch (_) {} return reject(err); }
        resolve({ total });
      };

      if (signal) {
        if (signal.aborted) return finish(new TransferCancelled());
        signal.onAbort = () => finish(new TransferCancelled());
      }

      rs.on('data', (chunk) => {
        transferred += chunk.length;
        if (onProgress) onProgress({ transferred, total });
      });
      rs.on('error', finish);
      ws.on('error', finish);
      ws.on('close', () => finish(null));
      rs.pipe(ws);
    });
  }

  /** 下载单个文件。同样用流,理由见 upload */
  async download(remotePath, localPath, onProgress, signal) {
    const sftp = await this.sftp();
    const stat = await new Promise((res, rej) =>
      sftp.stat(remotePath, (e, s) => (e ? rej(e) : res(s))));
    const total = stat.size;
    return new Promise((resolve, reject) => {
      let transferred = 0;
      let settled = false;
      const rs = sftp.createReadStream(remotePath);
      const ws = fs.createWriteStream(localPath);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (signal) signal.onAbort = null;
        if (err) {
          try { rs.destroy(); ws.destroy(); } catch (_) {}
          // 取消/失败留下的半截文件要删掉,否则用户以为下完了
          try { fs.unlinkSync(localPath); } catch (_) {}
          return reject(err);
        }
        resolve({ total });
      };

      if (signal) {
        if (signal.aborted) return finish(new TransferCancelled());
        signal.onAbort = () => finish(new TransferCancelled());
      }

      rs.on('data', (chunk) => {
        transferred += chunk.length;
        if (onProgress) onProgress({ transferred, total });
      });
      rs.on('error', finish);
      ws.on('error', finish);
      ws.on('close', () => finish(null));
      rs.pipe(ws);
    });
  }

  async mkdirRemote(remotePath) {
    await this.exec(`mkdir -p ${shellQuote(remotePath)}`);
  }

  async deleteRemote(remotePath, isDir) {
    await this.exec(`rm -${isDir ? 'rf' : 'f'} ${shellQuote(remotePath)}`);
  }

  /**
   * 反向隧道:让远程机的 127.0.0.1:remotePort 转发到
   * 本机可达的 targetHost:targetPort(通常是本机/局域网代理)
   */
  async startReverseTunnel(remotePort, targetHost, targetPort) {
    if (!this.client) throw new Error('未连接');
    await new Promise((resolve, reject) => {
      this.client.forwardIn('127.0.0.1', remotePort, (err) =>
        err ? reject(err) : resolve());
    });
    this.reverseTunnels.set(remotePort, { targetHost, targetPort });
    this.emit('tunnel', { remotePort, targetHost, targetPort, active: true });
    return { remotePort, targetHost, targetPort };
  }

  async stopReverseTunnel(remotePort) {
    if (!this.client) return;
    await new Promise((resolve) =>
      this.client.unforwardIn('127.0.0.1', remotePort, () => resolve()));
    this.reverseTunnels.delete(remotePort);
    this.emit('tunnel', { remotePort, active: false });
  }

  _handleReverseConnection(info, accept, rejectConn) {
    const t = this.reverseTunnels.get(info.destPort);
    if (!t) return rejectConn();
    const stream = accept();
    const socket = net.connect(t.targetPort, t.targetHost);
    // 连接阶段设超时:代理不可达时不让通道/套接字悬挂累积
    socket.setTimeout(15000);
    // 用 destroy 强制回收(end 是半关闭,对端不响应时通道会一直挂着)
    const cleanup = () => {
      try { stream.destroy(); } catch (_) { try { stream.end(); } catch (_) {} }
      try { socket.destroy(); } catch (_) {}
    };
    socket.on('connect', () => {
      socket.setTimeout(0); // 建连后取消超时,长连接正常传输
      stream.pipe(socket);
      socket.pipe(stream);
    });
    socket.on('timeout', cleanup);
    socket.on('error', cleanup);
    stream.on('error', cleanup);
    stream.on('close', cleanup);
    socket.on('close', cleanup);
  }
}

function untildify(p) {
  if (p && p.startsWith('~')) return path.join(require('os').homedir(), p.slice(1));
  return p;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { SSHManager, shellQuote };
