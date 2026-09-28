const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { shellQuote } = require('../ssh/SSHManager');
const {
  MAX_ATTACHMENT_BYTES,
  classifyFile,
  uniqueRemoteNames,
  validateFiles
} = require('./attachments');

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
}

class AttachmentService {
  constructor(ssh, { cacheRoot, homeDir } = {}) {
    this.ssh = ssh;
    this.cacheRoot = cacheRoot || path.join(os.tmpdir(), 'remote-agent-studio-artifacts');
    this.homeDir = homeDir || os.homedir();
    this.remoteHome = '';
    /* 已解析图片的内存缓存:key -> {src,name,size}。
       一次解析要读完整文件再 base64,几 MB 的图每次都做一遍,
       界面上就是"一发消息旧图又转圈"。键里带上 mtime+size,
       所以图被覆盖重画时会自动失效 —— 只按路径缓存会显示过期的旧图,
       那比多加载一次糟得多。 */
    this.imageCache = new Map();
    this.imageCacheMax = 24;
  }

  async _home(isLocal) {
    if (isLocal) return this.homeDir;
    if (this.remoteHome) return this.remoteHome;
    // 标记提取,避免远程 .bashrc 往 stdout 打印内容污染结果
    const { stdout } = await this.ssh.exec('printf "__RAS_HOME__%s__RAS_HOME__" "$HOME"');
    const match = String(stdout || '').match(/__RAS_HOME__([\s\S]*?)__RAS_HOME__/);
    this.remoteHome = match ? match[1].trim() : '';
    if (!this.remoteHome) throw new Error('Unable to determine the remote HOME directory');
    return this.remoteHome;
  }

  async directory(kind, convId, messageId, isLocal) {
    const home = await this._home(isLocal);
    return path.posix.join(
      home.replace(/\\/g, '/'),
      '.remote-agent-studio',
      kind,
      safeId(convId),
      ...(messageId ? [safeId(messageId)] : [])
    );
  }

  async prepare({ hostId, convId, messageId, files, isLocal }) {
    validateFiles(files);
    const names = uniqueRemoteNames(files);
    const targetDir = await this.directory('attachments', convId, messageId, isLocal);

    if (isLocal) fs.mkdirSync(targetDir, { recursive: true });
    else await this.ssh.exec(`mkdir -p ${shellQuote(targetDir)}`);

    const prepared = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const stat = fs.statSync(file.path);
      if (!stat.isFile()) throw new Error(`${file.name} is not a file`);
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`${file.name} 超过上限(${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB)`);
      }
      const remotePath = isLocal
        ? path.join(targetDir, names[index])
        : path.posix.join(targetDir, names[index]);
      try {
        if (isLocal) fs.copyFileSync(file.path, remotePath);
        else await this.ssh.upload(file.path, remotePath);
      } catch (error) {
        const wrapped = new Error(`Failed to upload ${file.name}: ${error.message}`);
        wrapped.completed = [...prepared];
        throw wrapped;
      }
      prepared.push({
        name: names[index],
        originalName: file.name,
        remotePath,
        size: stat.size,
        kind: classifyFile(file.name),
        hostId
      });
    }
    return prepared;
  }

  async ensureArtifactDir({ convId, messageId, isLocal }) {
    const dir = await this.directory('artifacts', convId, messageId, isLocal);
    if (isLocal) fs.mkdirSync(dir, { recursive: true });
    else await this.ssh.exec(`mkdir -p ${shellQuote(dir)}`);
    return dir;
  }

  async validatePrepared({ convId, messageId, attachments, isLocal }) {
    const dir = await this.directory('attachments', convId, messageId, isLocal);
    for (const file of attachments || []) {
      if (!file?.remotePath || !this._isWithin(file.remotePath, dir, isLocal)) {
        throw new Error('Attachment path does not belong to this message');
      }
    }
    return attachments || [];
  }

  async listArtifacts({ convId, messageId, extraPaths = [], isLocal }) {
    const dir = await this.directory('artifacts', convId, messageId, isLocal);
    /* 产物不只有图片。agent 交付最多的其实是 docx/pdf/xlsx/zip ——
     * 原来这里只扫图片扩展名,文档生成出来就被静默丢掉,
     * 对话里那句「下载 xxx」只是模型写的纯文本,背后什么都没有。 */
    let scanned = [];
    if (isLocal) {
      if (fs.existsSync(dir)) {
        scanned = fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(dir, entry.name));
      }
    } else {
      const result = await this.ssh.exec(
        `find ${shellQuote(dir)} -maxdepth 2 -type f -print 2>/dev/null`
      );
      scanned = (result.stdout || '').split(/\r?\n/).filter(Boolean);
    }
    const seen = new Set();
    return [...extraPaths, ...scanned]
      .map((candidate) => isLocal && /^[A-Za-z]:/.test(candidate)
        ? candidate.replace(/\\{2,}/g, '\\')
        : candidate)
      .filter((candidate) => this._isWithin(candidate, dir, isLocal))
      .filter((candidate) => {
        const key = candidate.replace(/\\/g, '/');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      // 标注类型:图片直接内联预览,其余走「保存到本机」
      .map((remotePath) => ({
        remotePath,
        name: path.basename(remotePath),
        kind: classifyFile(remotePath) === 'image' ? 'image' : 'file'
      }));
  }

  async resolveImage({ hostId, convId, remotePath, isLocal, cwd }) {
    if (classifyFile(remotePath) !== 'image') throw new Error('Unsupported image type');
    const allowedRoots = await Promise.all([
      this.directory('attachments', convId, null, isLocal),
      this.directory('artifacts', convId, null, isLocal)
    ]);
    // 也允许预览会话工作目录下的图片(agent 常把生成的图直接写进 cwd,尤其系统权限模式)
    if (cwd && String(cwd).trim()) allowedRoots.push(String(cwd).trim());
    if (!allowedRoots.some((root) => this._isWithin(remotePath, root, isLocal))) {
      throw new Error('Image is not in the current conversation directory');
    }

    let safePath = remotePath;
    /* 缓存校验用的指纹:大小 + 修改时间。
       智能体经常用同一个文件名重画一张图,只按路径缓存会拿到旧图。 */
    let stamp = '';
    if (isLocal) {
      safePath = fs.realpathSync(remotePath);
      const realRoots = allowedRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
      if (!realRoots.some((root) => this._isWithin(safePath, root, true))) {
        throw new Error('Image symlink leaves the current conversation directory');
      }
      const st = fs.statSync(safePath);
      if (st.size > MAX_PREVIEW_BYTES) throw new Error('Image preview exceeds 25 MB');
      stamp = `${st.size}-${Math.floor(st.mtimeMs)}`;
    } else {
      /* 原来这里是两次 exec(readlink 一次、stat 一次)。每张图每次预览
         都要两个 SSH 往返,几张图叠加起来就是肉眼可见的卡顿。
         合成一次,顺带把 mtime 取回来做缓存校验。 */
      const probe = await this.ssh.exec(
        `p=$(readlink -f ${shellQuote(remotePath)}) && printf '%s\\n' "$p" && stat -c '%s %Y' "$p"`
      );
      const [pathLine, statLine] = String(probe.stdout || '').split('\n');
      safePath = (pathLine || '').trim();
      if (!safePath || !allowedRoots.some((root) => this._isWithin(safePath, root, false))) {
        throw new Error('Image symlink leaves the current conversation directory');
      }
      const [sizeStr, mtimeStr] = String(statLine || '').trim().split(/\s+/);
      const size = Number(sizeStr);
      if (!Number.isFinite(size) || size > MAX_PREVIEW_BYTES) throw new Error('Image preview exceeds 25 MB');
      stamp = `${size}-${mtimeStr || ''}`;
    }

    const cacheKey = `${hostId}|${safePath}|${stamp}`;
    const hit = this.imageCache.get(cacheKey);
    if (hit) {
      // 命中即提到队尾,简单的 LRU
      this.imageCache.delete(cacheKey);
      this.imageCache.set(cacheKey, hit);
      return hit;
    }

    let localPath = safePath;
    if (!isLocal) {
      const cacheDir = path.join(this.cacheRoot, safeId(hostId), safeId(convId));
      fs.mkdirSync(cacheDir, { recursive: true });
      /* **落盘缓存的文件名必须带上指纹。**
         原来只按远端路径哈希,于是智能体用同一个文件名重画一张图之后,
         这里永远命中那份旧的 —— 界面上显示的是过期的图,
         而人会以为"改了没生效"。缓存给错内容比不缓存糟得多。 */
      /* 文件名分两段:**路径哈希 + 指纹哈希**。
         路径哈希标识"是哪张图",指纹标识"是哪一版"。
         只用一段都不行 ——
         只按路径:智能体用同名文件重画后永远命中旧的,显示过期的图;
         只按指纹:两张不同的图凑巧同名同大小时会互相覆盖。 */
      const pathKey = crypto.createHash('sha256').update(remotePath).digest('hex').slice(0, 20);
      const stampKey = crypto.createHash('sha256').update(String(stamp)).digest('hex').slice(0, 12);
      localPath = path.join(cacheDir, `${pathKey}-${stampKey}-${path.basename(remotePath)}`);
      if (!fs.existsSync(localPath)) {
        await this.ssh.download(safePath, localPath);
        // 同一张图的旧版本留着只占地方。按**路径哈希**筛,不按文件名 ——
        // 不同目录下的同名图片是两张图,不是两个版本。
        this._pruneStale(cacheDir, pathKey, path.basename(localPath));
      }
    }
    const data = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const payload = {
      src: `data:${MIME_TYPES[ext] || 'application/octet-stream'};base64,${data.toString('base64')}`,
      name: path.basename(remotePath),
      size: data.length
    };
    /* 只缓存有限张:base64 比原图还大三分之一,无上限地攒会把内存吃光。
       淘汰最早的那张(Map 的插入顺序就是使用顺序)。 */
    this.imageCache.set(cacheKey, payload);
    if (this.imageCache.size > this.imageCacheMax) {
      this.imageCache.delete(this.imageCache.keys().next().value);
    }
    return payload;
  }

  /**
   * 删掉**同一张远端图片**的旧版本缓存。
   * 按路径哈希前缀筛:`a/output.png` 和 `b/output.png` 是两张不同的图,
   * 按文件名筛会把另一张误删(旧实现正是这么错的)。
   */
  _pruneStale(dir, pathKey, keep) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f !== keep && f.startsWith(`${pathKey}-`)) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch (_) { /* 清理失败不影响主流程 */ }
  }

  async cleanupConversation({ hostId, convId, isLocal }) {
    try {
      const home = await this._home(isLocal);
      const roots = ['attachments', 'artifacts'].map((kind) => path.posix.join(
        home.replace(/\\/g, '/'), '.remote-agent-studio', kind, safeId(convId)
      ));
      if (isLocal) {
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      } else {
        await this.ssh.exec(`rm -rf ${roots.map(shellQuote).join(' ')}`).catch(() => {});
      }
    } catch (_) {}
    try {
      fs.rmSync(path.join(this.cacheRoot, safeId(hostId), safeId(convId)), { recursive: true, force: true });
    } catch (_) {}
  }

  _isWithin(candidate, root, isLocal) {
    if (!candidate || !root) return false;
    if (isLocal) {
      const resolved = path.resolve(candidate).toLocaleLowerCase();
      const base = path.resolve(root).toLocaleLowerCase();
      return resolved === base || resolved.startsWith(`${base}${path.sep}`);
    }
    const resolved = path.posix.resolve(candidate);
    const base = path.posix.resolve(root);
    return resolved === base || resolved.startsWith(`${base}/`);
  }
}

module.exports = { AttachmentService, safeId };
