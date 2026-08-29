/**
 * 从对话里智能体实际执行的命令,解析出「该盯哪几个东西」。
 *
 * 这是对前一版做法的一次纠正。原来是**全机扫描** —— 把主机上所有像下载的
 * 进程都捞回来,再靠一层层启发式把噪音滤掉。结果是两头不讨好:
 * 该看见的漏(nohup 起的重试脚本、被 *bash* 规则吃掉的包装脚本),
 * 不该看见的一堆(auditd、mdmonitor、libstoragemgmt)。
 * 每修一次就换一种错法。
 *
 * 换个信号源就干净了:**智能体自己说了它要跑什么**。
 * 它写了 `/etc/systemd/system/qwen36-vllm.service`,它执行了
 * `systemctl start ragflow-bootstrap`,它敲了 `nohup xxx-retry.sh &` ——
 * 这些命令都在对话里,应用本来就转发过。从里面抽出单元名、脚本名、
 * 目标目录,只监控这几个。
 *
 * 好处不只是干净:**范围是用户自己划定的**。面板上出现的每一条,
 * 都能在对话里找到那句"我起了它"。
 */

/** 一次提取的上限。同一轮对话可能敲几十条命令,不能无限攒。 */
const MAX_PER_KIND = 12;

/** systemd 单元名的合法字符,顺便挡住把整行命令当成单元名 */
const UNIT_RE = /[A-Za-z0-9@._-]+\.service/g;

/**
 * 从一条命令里找 systemd 单元。
 *
 * 四种来源都要认,因为智能体这四种写法都用:
 *  · `systemctl start|restart|enable --now X`(可能不带 .service 后缀)
 *  · 写文件 `/etc/systemd/system/X.service`
 *  · `journalctl -u X`
 *  · 命令里直接出现 `X.service`
 */
function extractUnits(cmd) {
  const s = String(cmd || '');
  const out = new Set();

  for (const m of s.match(UNIT_RE) || []) out.add(m);

  /* 不带后缀的写法:`systemctl restart --no-block ragflow-bootstrap`。
   *
   * 关键是**扫完这一段里的每个词**,而不是取第一个。
   * 早先的写法取第一个非空词,于是 `systemctl daemon-reload && systemctl
   * restart --no-block ragflow-bootstrap` 只取到 daemon-reload(动词),
   * 真正的单元名反而漏了 —— 而那正是要盯的那个。
   */
  const SUBCMD = /^(start|stop|restart|reload|enable|disable|status|mask|unmask|kill|cat|edit|daemon-reload|daemon-reexec|is-active|is-enabled|is-failed|show|list-units|list-unit-files|reset-failed)$/;
  const segRe = /\b(?:systemctl|journalctl)\b([^|;&]*)/g;
  let seg;
  while ((seg = segRe.exec(s))) {
    for (const w of String(seg[1]).split(/\s+/)) {
      if (!w || w.startsWith('-')) continue;          // 选项不是单元名
      if (SUBCMD.test(w)) continue;                   // 子命令不是单元名
      if (/^\d+$/.test(w)) continue;                  // `-n 35` 里的数字
      if (!/^[A-Za-z][A-Za-z0-9@._-]{2,}$/.test(w)) continue;
      out.add(w.endsWith('.service') ? w : `${w}.service`);
    }
  }
  return [...out].slice(0, MAX_PER_KIND);
}

/** 系统目录一律不盯:既没意义,`du` 起来还可能很慢 */
const PATH_DENY = /^\/(usr|etc|proc|sys|dev|boot|bin|sbin|lib|lib64|run|tmp|var\/lib\/docker)(\/|$)/;

/**
 * 下载/输出的目标目录。
 *
 * 只认**明确写出来的输出位置**,不做猜测 —— 猜错的代价是去 du 一个
 * 巨大的无关目录,把整轮扫描拖超时。
 */
function extractPaths(cmd) {
  const s = String(cmd || '');
  const out = new Set();
  const add = (p) => {
    const v = String(p || '').replace(/["';,]+$/, '');
    if (v.startsWith('/') && v.length > 5 && !PATH_DENY.test(v)) out.add(v);
  };

  for (const re of [
    /-P\s+(\S+)/g,                    // wget -P dir
    /-O\s+(\/\S+)/g,                  // wget -O file
    /-o\s+(\/\S+)/g,                  // curl -o file
    /--output[= ](\/\S+)/g,
    /--local-dir[= ](\S+)/g,          // huggingface-cli
    /--cache-dir[= ](\S+)/g,
    /\bclone\b[^|;&]*?\s(\/\S+)/g,    // git clone <url> <dest>
    /\b(?:mkdir|cd)\s+(?:-p\s+)?(\/\S+)/g
  ]) {
    let m;
    while ((m = re.exec(s))) add(m[1]);
  }
  return [...out].slice(0, MAX_PER_KIND);
}

/**
 * 脚本名。
 *
 * 智能体很爱把长活儿包成一个 .sh 再 `nohup` 起来,那种进程不属于任何
 * systemd 单元,只能靠名字认。存的是**文件名**而不是全路径:
 * 写文件时是 `/usr/local/bin/x.sh`,而 ps 里可能是 `bash /usr/local/bin/x.sh`
 * 也可能是相对路径,用文件名匹配才对得上。
 */
function extractScripts(cmd) {
  const s = String(cmd || '');
  const out = new Set();
  const re = /([A-Za-z0-9._-]+\.sh)\b/g;
  let m;
  while ((m = re.exec(s))) out.add(m[1]);
  return [...out].slice(0, MAX_PER_KIND);
}

/** 镜像名 —— 用来在 ps 里认出对应的 docker 命令 */
function extractImages(cmd) {
  const s = String(cmd || '');
  const out = new Set();
  const re = /\b(?:docker|podman)\b[^|;&]*?\b(?:pull|run|load)\b[^|;&]*?\s([a-z0-9][a-z0-9._\-/]*(?::[A-Za-z0-9._-]+)?)(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[1];
    if (/^-/.test(v) || v.length < 3) continue;
    out.add(v);
  }
  /* compose 没有镜像名,但有**项目名**:`docker compose -p ragflow pull`。
     ps 里那条命令行带着它,足够把进程认出来。 */
  const proj = s.match(/\b(?:docker[- ]compose|docker\s+compose)\b[^|;&]*?-p\s+([A-Za-z0-9._-]{2,})/);
  if (proj) out.add(proj[1]);
  return [...out].slice(0, MAX_PER_KIND);
}

/** 一条命令能给出的全部监控目标 */
function extractTargets(cmd) {
  return {
    units: extractUnits(cmd),
    paths: extractPaths(cmd),
    scripts: extractScripts(cmd),
    images: extractImages(cmd)
  };
}

/**
 * 每台主机维护一份监控目标。
 *
 * 有上限也有过期:一轮对话可能敲上百条命令,而其中绝大多数是查状态、
 * 看日志这类一次性的。不设上限,面板迟早又会变成一锅粥 —— 那正是
 * 这次重做要解决的问题。
 */
const TARGET_TTL_MS = 60 * 60 * 1000;   // 一小时没再提到就不再盯
const TARGET_MAX = 24;

class WatchList {
  constructor({ ttlMs = TARGET_TTL_MS, max = TARGET_MAX } = {}) {
    this.items = new Map();   // `${kind}:${value}` -> { kind, value, at, convId }
    this.ttlMs = ttlMs;
    this.max = max;
  }

  /** 记下一条命令里出现的所有目标。同一个目标再次出现会刷新时间。 */
  addFromCommand(cmd, { convId = '', now = Date.now() } = {}) {
    const t = extractTargets(cmd);
    for (const [kind, list] of Object.entries(t)) {
      for (const value of list) this.items.set(`${kind}:${value}`, { kind, value, at: now, convId });
    }
    this.prune(now);
    return t;
  }

  prune(now = Date.now()) {
    const alive = [...this.items.entries()]
      .filter(([, v]) => now - v.at <= this.ttlMs)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, this.max);
    this.items = new Map(alive);
  }

  list(kind, { now = Date.now() } = {}) {
    this.prune(now);
    return [...this.items.values()].filter((v) => v.kind === kind).map((v) => v.value);
  }

  /** 这条命令行是不是我们盯的目标之一 */
  matchesCommand(cmd, { now = Date.now() } = {}) {
    this.prune(now);
    const s = String(cmd || '');
    for (const v of this.items.values()) {
      if (v.kind === 'units' && s.includes(v.value.replace(/\.service$/, ''))) return true;
      if ((v.kind === 'scripts' || v.kind === 'images' || v.kind === 'paths') && s.includes(v.value)) return true;
    }
    return false;
  }

  get size() { return this.items.size; }
}

module.exports = {
  extractTargets, extractUnits, extractPaths, extractScripts, extractImages,
  WatchList, TARGET_TTL_MS, TARGET_MAX, MAX_PER_KIND
};
