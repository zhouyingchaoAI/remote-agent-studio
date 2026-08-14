/**
 * SSH 通道并发闸门。
 *
 * sshd 的 MaxSessions 默认是 10,而本应用会同时占用多个通道:
 * 每个终端标签一个、SFTP 一个、每次 exec 一个、agent 会话一个。
 * 没有上限的话,开几个终端 + 传个文件 + 发条消息就撞满,
 * 表现为「Channel open failure: open failed」这种看不懂的报错。
 *
 * 与其等 sshd 拒绝再报错,不如自己排队 —— 慢一点总比失败好。
 */

const DEFAULT_MAX_SESSIONS = 10;
/** 给 sshd 留出余量:它自己也会用掉名额,顶满了反而更容易出错 */
const RESERVE = 2;

class ChannelPool {
  constructor(limit = DEFAULT_MAX_SESSIONS - RESERVE) {
    this.limit = Math.max(1, limit);
    this.inUse = 0;
    this.queue = []; // [{resolve, reject, timer, label}]
  }

  /** 根据探测到的 MaxSessions 调整上限 */
  setMaxSessions(maxSessions) {
    const n = Number(maxSessions);
    if (!Number.isFinite(n) || n < 1) return this.limit;
    this.limit = Math.max(1, Math.floor(n) - RESERVE);
    this._drain();
    return this.limit;
  }

  get pending() { return this.queue.length; }
  get available() { return Math.max(0, this.limit - this.inUse); }

  /**
   * 取一个名额。拿不到就排队。
   * @returns release 函数(幂等)
   */
  acquire({ timeoutMs = 60000, label = '' } = {}) {
    if (this.inUse < this.limit) {
      this.inUse += 1;
      return Promise.resolve(this._makeRelease());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, label, timer: null };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(
          `等待 SSH 通道超时(已占用 ${this.inUse}/${this.limit},排队 ${this.queue.length})。\n`
          + '多为终端标签或文件传输占满通道:关掉不用的「终端」标签,或等传输结束后重试。'
        ));
      }, timeoutMs);
      this.queue.push(entry);
    });
  }

  _makeRelease() {
    let released = false;
    return () => {
      if (released) return;      // 幂等:stream 的 close 与 error 可能都触发
      released = true;
      this.inUse = Math.max(0, this.inUse - 1);
      this._drain();
    };
  }

  _drain() {
    while (this.queue.length && this.inUse < this.limit) {
      const entry = this.queue.shift();
      clearTimeout(entry.timer);
      this.inUse += 1;
      entry.resolve(this._makeRelease());
    }
  }

  /** 断线重连时清空:旧通道随连接一起没了 */
  reset(err) {
    this.inUse = 0;
    const pending = this.queue.splice(0);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(err || new Error('连接已断开'));
    }
  }

  stats() {
    return { limit: this.limit, inUse: this.inUse, pending: this.queue.length };
  }
}

/** 从 sshd_config / sshd -T 输出里解析 MaxSessions */
function parseMaxSessions(text = '') {
  const m = String(text || '').match(/^\s*maxsessions\s+(\d+)/im);
  return m ? parseInt(m[1], 10) : null;
}

/** 探测命令:sshd -T 要 root,读配置文件是通用兜底 */
const MAX_SESSIONS_PROBE =
  'sshd -T 2>/dev/null | grep -i "^maxsessions" '
  + '|| grep -iE "^[[:space:]]*MaxSessions[[:space:]]+[0-9]+" /etc/ssh/sshd_config 2>/dev/null '
  + '|| true';

module.exports = {
  ChannelPool, parseMaxSessions, MAX_SESSIONS_PROBE,
  DEFAULT_MAX_SESSIONS, RESERVE
};
