/**
 * 平台异常日志。
 *
 * 目的不是"记下来",而是"能定期拿它修平台"。所以三件事比落盘本身更重要:
 *
 *  1. 脱敏。日志会被导出、贴进 issue、发给别人看。命令行、环境变量、
 *     报错正文里全是 API key 和密码,不洗干净就是一次泄漏。
 *  2. 指纹聚合。同一个 bug 会产生几十条只有路径和行号不同的记录。
 *     「这个错出了 27 次」远比翻 27 条有用。
 *  3. 有界。异常日志自己把磁盘写爆是很蠢的失败方式。
 */
const fs = require('fs');
const path = require('path');

/** 单文件上限,超了就滚存一份 .1 */
const MAX_BYTES = 4 * 1024 * 1024;
/** 读取时最多返回多少条,避免界面被几万条噎住 */
const DEFAULT_LIMIT = 2000;

/* ------------------------------------------------------------ 脱敏 */

/**
 * 抹掉可能是凭据的片段。
 *
 * 宁可多抹:少抹一次就是一次泄漏,多抹只是少看几个字符。
 * 每条规则都保留前缀,便于分辨"是哪一类凭据出了问题"。
 */
const SECRET_RULES = [
  // sk-xxx / sk-ant-xxx 这类 API key
  [/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, '$1***'],
  [/\b(ghp_|gho_|github_pat_)[A-Za-z0-9_]{10,}/g, '$1***'],
  [/\b(xox[baprs]-)[A-Za-z0-9-]{10,}/g, '$1***'],
  // Authorization: Bearer xxx
  [/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***'],
  /* KEY=value / "apiKey": "value" / password: xxx
     用替换函数而不是字符串:前面的专用规则已经把 sk-xxx 打成 sk-fOc2***,
     这条若无脑整段替换会把那点前缀也吃掉 —— 而前缀正是用来分辨
     「到底是哪一把 key 出的问题」的。已打码的就放过。 */
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*)["']?([^\s"',;]{6,})/gi,
    (m, head, val) => (val.includes('***') ? m : `${head}***`)],
  [/\b(api[_-]?key["']?\s*[:=]\s*)["']?([^\s"',;]{6,})/gi,
    (m, head, val) => (val.includes('***') ? m : `${head}***`)],
  // URL 里的账号密码 https://user:pass@host
  [/(\/\/[^/\s:@]+:)[^/\s@]+(@)/g, '$1***$2'],
  // 私钥整段
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----']
];

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  return out;
}

/* ------------------------------------------------------------ 分类与指纹 */

/**
 * 归类。分类决定"该找谁修":认证问题找配置页,网络问题找代理,
 * 崩溃类才是真正需要改代码的。
 */
const CATEGORIES = [
  ['auth', /unauthorized|not logged in|api[_ ]?key|401|403|认证|登录|凭据|invalid.*key/i],
  // ETIMEDOUT 既不含 timeout 也不含 timed out —— 最常见的连接超时曾经整个漏掉
  ['network', /e?time[d]?[ _]?out|econn|enotfound|ehostunreach|getaddrinfo|network|proxy|socket hang up|连接(中断|失败|超时)|断开/i],
  ['quota', /quota|rate limit|usage limit|额度|限流|too many requests|429/i],
  ['install', /command not found|not found|enoent|no such file|未安装|安装失败/i],
  ['ssh', /ssh|sftp|channel|authentication failed|host key|MaxSessions/i],
  ['transfer', /传输|上传失败|下载失败|transfer|upload|download/i],
  ['crash', /TypeError|ReferenceError|SyntaxError|RangeError|Cannot read propert|is not a function|undefined is not/i],
  ['permission', /permission denied|eacces|eperm|权限不足/i]
];

function classifyError(text = '') {
  const t = String(text || '');
  // crash 优先:TypeError 里也常带 "not a function" 之类会被别的规则蹭到的词,
  // 而代码 bug 是唯一必须改代码的类别,不能被归到 install/network 里埋掉
  const crash = CATEGORIES.find(([name]) => name === 'crash');
  if (crash[1].test(t)) return 'crash';
  for (const [name, re] of CATEGORIES) {
    if (name === 'crash') continue;
    if (re.test(t)) return name;
  }
  return 'unknown';
}

/**
 * 生成指纹:抹掉每次都不同的部分,让同一个 bug 归到一组。
 * 不做这步的话,同一个错因为路径/行号/时间戳不同会散成几十条。
 */
function fingerprint(text = '') {
  return String(text || '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, '<time>')
    .replace(/(\/[\w.@-]+){2,}/g, '<path>')          // 绝对路径
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')       // Windows 路径
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(:\d+)?/g, '<ip>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/* ------------------------------------------------------------ 条目 */

/**
 * 组装一条日志。text 一律先脱敏再存 —— 不能指望调用方记得洗。
 */
function makeEntry({ source, text, detail, hostId, convId, agent, level = 'error' } = {}) {
  const clean = redact(text);
  return {
    ts: Date.now(),
    level,
    source: String(source || 'unknown'),
    category: classifyError(`${clean} ${redact(detail)}`),
    fingerprint: fingerprint(clean),
    text: clean.slice(0, 2000),
    detail: redact(detail).slice(0, 4000) || undefined,
    hostId: hostId || undefined,
    convId: convId || undefined,
    agent: agent || undefined,
    appVersion: process.env.npm_package_version || undefined
  };
}

/* ------------------------------------------------------------ 落盘 */

class ErrorLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'error-log.jsonl');
  }

  append(input) {
    const entry = makeEntry(input);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // 先滚存再写:写完再判会让单文件短暂超限,而超限的那次可能正是最大的一条
      this._rotateIfNeeded();
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (_) {
      // 记日志本身失败绝不能影响主流程 —— 它只是观测,不是业务
    }
    return entry;
  }

  _rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size < MAX_BYTES) return;
      fs.renameSync(this.file, `${this.file}.1`);   // 只留一代,再老的没人看
    } catch (_) { /* 文件还不存在 */ }
  }

  /** 读取最近的条目(倒序:最新在前) */
  read({ limit = DEFAULT_LIMIT } = {}) {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      // 单行坏了不该让整个日志页打不开
      try { out.push(JSON.parse(line)); } catch (_) { /* 跳过 */ }
    }
    return out.slice(-limit).reverse();
  }

  clear() {
    for (const f of [this.file, `${this.file}.1`]) {
      try { fs.unlinkSync(f); } catch (_) { /* 本来就没有 */ }
    }
    return { ok: true };
  }
}

/* ------------------------------------------------------------ 聚合 */

/**
 * 按指纹聚合。「这个错出了 27 次、最近一次在 3 分钟前」
 * 比 27 条流水有用得多 —— 定期修平台看的就是这个。
 */
function aggregate(entries = []) {
  const map = new Map();
  for (const e of entries) {
    if (!e) continue;
    const key = `${e.category}|${e.fingerprint}`;
    const g = map.get(key);
    if (g) {
      g.count += 1;
      g.firstSeen = Math.min(g.firstSeen, e.ts);
      g.lastSeen = Math.max(g.lastSeen, e.ts);
      if (e.hostId) g.hosts.add(e.hostId);
      if (e.source) g.sources.add(e.source);
    } else {
      map.set(key, {
        key,
        category: e.category,
        fingerprint: e.fingerprint,
        sample: e.text,
        detail: e.detail,
        count: 1,
        firstSeen: e.ts,
        lastSeen: e.ts,
        hosts: new Set(e.hostId ? [e.hostId] : []),
        sources: new Set(e.source ? [e.source] : [])
      });
    }
  }
  return [...map.values()]
    .map((g) => ({ ...g, hosts: [...g.hosts], sources: [...g.sources] }))
    // 先按次数、再按最近 —— 修平台的优先级就是这个顺序
    .sort((a, b) => (b.count - a.count) || (b.lastSeen - a.lastSeen));
}

module.exports = {
  ErrorLog, redact, classifyError, fingerprint, makeEntry, aggregate,
  MAX_BYTES, CATEGORIES
};
