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

class SSHManager extends EventEmitter {
  constructor(hostConfig) {
    super();
    this.config = hostConfig; // {id,name,host,port,username,password,privateKeyPath,passphrase}
    this.client = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.sftpSession = null;
    this.shells = new Map();         // termId -> shell stream(多终端标签)
    this.reverseTunnels = new Map(); // remotePort -> {targetHost,targetPort}
    this.activeTransfers = new Map(); // transferId -> {source,destination}
    this.manualClose = false;        // 用户主动断开时不做自动重连
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
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
        .on('ready', () => { this.reconnectAttempt = 0; this._setStatus('connected'); resolve(); })
        .on('error', (err) => { this._setStatus('error', err.message); reject(err); })
        .on('close', () => {
          const wasConnected = this.status === 'connected';
          this.sftpSession = null;
          this.shells.clear();
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

  /** 执行命令,整体返回 {code, stdout, stderr} */
  exec(command, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('未连接'));
      this.client.exec(command, { pty: opts.pty || false }, (err, stream) => {
        if (err) return reject(err);
        let stdout = '', stderr = '';
        stream.on('data', (d) => {
          stdout += d.toString();
          if (opts.onStdout) opts.onStdout(d.toString());
        });
        stream.stderr.on('data', (d) => {
          stderr += d.toString();
          if (opts.onStderr) opts.onStderr(d.toString());
        });
        stream.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
        if (opts.stdin != null) { stream.write(opts.stdin); stream.end(); }
      });
    });
  }

  /** 流式执行,返回 stream 句柄(供 AgentSession 使用) */
  execStream(command) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('未连接'));
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  /** 打开交互 shell(支持多终端标签,按 termId 区分) */
  async openShell({ termId = 'default', cols = 80, rows = 24 } = {}) {
    const existing = this.shells.get(termId);
    if (existing) return existing;
    if (!this.client) throw new Error('未连接');
    const stream = await new Promise((resolve, reject) => {
      this.client.shell(
        { term: 'xterm-256color', cols, rows },
        // 设置 UTF-8 locale 修复中文乱码;传递代理相关环境变量
        { env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color' } },
        (err, s) => {
          if (err) return reject(err);
          s.on('close', () => { this.shells.delete(termId); });
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

  /** SFTP 会话(懒加载) */
  sftp() {
    return new Promise((resolve, reject) => {
      if (this.sftpSession) return resolve(this.sftpSession);
      if (!this.client) return reject(new Error('未连接'));
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        this.sftpSession = sftp;
        sftp.on('close', () => { this.sftpSession = null; });
        resolve(sftp);
      });
    });
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

  async upload(localPath, remotePath, onProgress, transferId, { resume = false } = {}) {
    const sftp = await this.sftp();
    const total = fs.statSync(localPath).size;
    let offset = 0;
    if (resume) {
      const remote = await new Promise((resolve) => sftp.stat(remotePath, (err, stat) => resolve(err ? null : stat)));
      if (remote?.size > 0 && remote.size < total) offset = remote.size;
    }
    return this._streamTransfer(fs.createReadStream(localPath, { start: offset }), sftp.createWriteStream(remotePath, { flags: offset ? 'a' : 'w' }), total, onProgress, transferId, offset);
  }

  async download(remotePath, localPath, onProgress, transferId, { resume = false } = {}) {
    const sftp = await this.sftp();
    const stat = await new Promise((res, rej) =>
      sftp.stat(remotePath, (e, s) => (e ? rej(e) : res(s))));
    const total = stat.size;
    const existing = resume && fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
    const offset = existing > 0 && existing < total ? existing : 0;
    return this._streamTransfer(sftp.createReadStream(remotePath, { start: offset }), fs.createWriteStream(localPath, { flags: offset ? 'a' : 'w' }), total, onProgress, transferId, offset);
  }

  _streamTransfer(source, destination, total, onProgress, transferId, initialTransferred = 0) {
    const id = transferId || `internal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return new Promise((resolve, reject) => {
      let transferred = initialTransferred;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.activeTransfers.delete(id);
        error ? reject(error) : resolve({ total });
      };
      this.activeTransfers.set(id, { source, destination });
      source.on('data', (chunk) => { transferred += chunk.length; if (onProgress) onProgress({ transferred, total }); });
      source.once('error', finish);
      destination.once('error', finish);
      destination.once('finish', () => finish());
      source.pipe(destination);
    });
  }

  cancelTransfer(transferId) {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return false;
    const error = new Error('传输已取消');
    transfer.source.destroy(error);
    transfer.destination.destroy(error);
    return true;
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
    socket.on('connect', () => { stream.pipe(socket); socket.pipe(stream); });
    const cleanup = () => { try { stream.end(); } catch (_) {} try { socket.end(); } catch (_) {} };
    socket.on('error', cleanup);
    stream.on('error', cleanup);
    stream.on('close', () => socket.end());
    socket.on('close', () => stream.end());
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
