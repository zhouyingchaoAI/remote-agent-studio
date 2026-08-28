/**
 * 后台下载任务面板。
 *
 * 场景:智能体在对话里起了一堆后台活儿 —— docker pull 大镜像、wget 权重、
 * pip 装依赖 —— 然后对话往下滚,这些任务就消失在视野里了。等你想起来看,
 * 要么早就完了,要么卡了半小时没人知道。
 *
 * 三个设计前提,决定了这个模块长什么样:
 *
 * 1. **我们看不到智能体执行的命令。** codex/claude 是在远端自己开进程跑命令的,
 *    应用只转发它的输出。所以不能在"启动时登记",只能**主动扫描**主机上正在跑
 *    什么 —— 这也意味着用户手动在终端里敲的下载同样会被列出来,是好事。
 *
 * 2. **进度经常拿不到,但速率几乎总能拿到。** 大多数下载器不会把总量告诉外人,
 *    硬凑一个百分比就是编。所以默认只报「已下载 3.4 GB · 12 MB/s」,
 *    只有真解析到总量时才显示百分比。
 *
 * 3. **最有价值的信号不是进度,是「停滞」。** 一个还在跑但字节数不再增长的下载,
 *    表现和正常下载一模一样,却能白等一小时。判定停滞必须建立在真的量到了字节数
 *    之上 —— 量不到就说「进度未知」,**绝不能把"没测到"显示成"卡住了"**,
 *    那会让人去查一个根本不存在的问题。
 */
const { redact } = require('./errorLog');

/** 认得出的下载类任务。顺序有意义:先匹配到的先算。 */
const KINDS = [
  /* docker-build 必须排在 docker-pull **前面**:`docker build --pull` 两个都匹配,
     而它实质是构建。反过来放会把每一次带 --pull 的构建都显示成"拉取镜像"。 */
  { id: 'docker-build', re: /\bdocker\b[^|]*\bbuild\b/, label: '构建镜像' },
  { id: 'docker-pull', re: /\bdocker\b[^|]*\b(pull|load)\b/, label: '拉取镜像' },
  { id: 'ollama', re: /\bollama\s+(pull|run)\b/, label: '拉取模型' },
  { id: 'hf', re: /\b(huggingface-cli|hf)\s+download\b|\bmodelscope\s+download\b/, label: '下载模型' },
  { id: 'git-clone', re: /\bgit\b[^|]*\bclone\b/, label: '克隆仓库' },
  { id: 'pip', re: /\bpip3?\s+install\b/, label: '安装 Python 包' },
  { id: 'npm', re: /\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b/, label: '安装 Node 包' },
  { id: 'apt', re: /\b(apt-get|apt|yum|dnf|zypper)\s+(install|upgrade|update)\b/, label: '安装系统包' },
  { id: 'rsync', re: /\brsync\b/, label: '同步文件' },
  { id: 'scp', re: /\bscp\b/, label: '传输文件' },
  { id: 'wget', re: /\bwget\b/, label: '下载文件' },
  { id: 'curl', re: /\bcurl\b.*(-O|--remote-name|-o\s|--output)/, label: '下载文件' },
  /* 下载之外的长跑活儿。同样是"起了就看不见"的一类,而且失败得更安静 ——
     编译挂了往往只在几百行输出的中间留一行。 */
  { id: 'compile', re: /\b(make|cmake|ninja|cargo\s+(build|install)|go\s+build|mvn|gradle)\b/, label: '编译' },
  { id: 'train', re: /\b(torchrun|deepspeed|accelerate\s+launch)\b|python[\d.]*\s+\S*train\S*\.py/, label: '训练' }
];

function classifyKind(cmd) {
  const c = String(cmd || '');
  for (const k of KINDS) if (k.re.test(c)) return k.id;
  return 'other';
}

function kindLabel(kind) {
  return (KINDS.find((k) => k.id === kind) || {}).label || '后台任务';
}

/* --------------------------------------------------------------- 扫描 */

/* 字段分隔符用 US(0x1F)。不能用制表符或空格 —— 被扫描的命令行本身
   就带一堆空白、还可能带制表符,分隔符必须是命令行里不可能出现的字符。 */
const FIELD = '\x1f';

/**
 * 扫描命令。要求:只读、便宜、能在 busybox/精简镜像里跑。
 *
 * 为什么连 dockerd 的 io 一起读:`docker pull` 的下载**是守护进程做的**,
 * 客户端进程几乎不写盘。只看客户端会得出"一直 0 B/s"的结论,
 * 从而把一个正常的拉取误报成卡住 —— 这正是最要避免的错误。
 */
function buildScanCommand() {
  const pattern = KINDS.map((k) => k.id).join('|');   // 仅用于注释,真正的匹配在下面
  return [
    `# kinds: ${pattern}`,
    'LC_ALL=C ps -eo pid=,etimes=,args= 2>/dev/null | while read -r p e a; do',
    '  case "$a" in',
    '    *grep*) continue ;;',
    '    *"docker "*pull*|*"docker "*load*|*ollama*pull*|*huggingface-cli*download*'
      + '|*modelscope*download*|*"git "*clone*|*pip*install*|*npm*install*|*pnpm*install*'
      + '|*yarn*add*|*apt-get*install*|*apt*install*|*yum*install*|*dnf*install*'
      + '|*rsync*|*scp*|*wget*|*curl*-O*|*curl*-o*'
      + '|*"docker "*build*|*make*|*cmake*|*ninja*|*cargo*build*|*"go "*build*'
      + '|*mvn*|*gradle*|*torchrun*|*deepspeed*|*accelerate*launch*) ;;',
    '    *) continue ;;',
    '  esac',
    `  w=$(awk '/^write_bytes:/{print $2}' /proc/$p/io 2>/dev/null || echo -1)`,
    `  r=$(awk '/^rchar:/{print $2}' /proc/$p/io 2>/dev/null || echo -1)`,
    `  printf 'TASK%s%s%s%s%s%s%s%s%s\\n' "\x1f" "$p" "\x1f" "$e" "\x1f" "\${w:--1}" "\x1f" "\${r:--1}" "\x1f$a"`,
    'done',
    // 守护进程的写入量:docker pull 的真实进度只能从这里看
    'for d in dockerd containerd; do',
    '  dp=$(pgrep -x "$d" 2>/dev/null | head -1)',
    `  [ -n "$dp" ] && printf 'DAEMON%s%s%s%s\\n' "\x1f" "$d" "\x1f" `
      + `"$(awk '/^write_bytes:/{print $2}' /proc/$dp/io 2>/dev/null || echo -1)"`,
    'done',
    /* 磁盘余量:大镜像/权重把盘写满是这些任务最常见的死法,
       而报错往往埋在几百行输出里,不如直接摆出来 */
    `df -P -k 2>/dev/null | awk 'NR>1 && $1 ~ /^\\// {printf "DISK\x1f%s\x1f%s\x1f%s\\n", $6, $4, $5}'`
  ].join('\n');
}

/** 命令行里常有密钥(curl -H "Authorization: Bearer …"、带账号的 URL),展示前必须脱敏 */
function parseScan(text) {
  const tasks = [];
  const daemons = {};
  const disks = [];
  for (const line of String(text || '').split('\n')) {
    const parts = line.split(FIELD);
    // TASK ␟ pid ␟ etimes ␟ write_bytes ␟ rchar ␟ 完整命令行
    if (parts[0] === 'TASK' && parts.length >= 6) {
      const pid = Number(parts[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      // 命令行本身可能含分隔符?不会,但 slice+join 比 parts[5] 更稳
      const command = redact(parts.slice(5).join(FIELD).trim());
      const kind = classifyKind(command);
      tasks.push({
        pid,
        elapsedSec: Math.max(0, Number(parts[2]) || 0),
        /* -1 表示读不到 /proc/<pid>/io(不是同一个用户,或内核没开)。
           必须和"读到了 0"区分开:前者是测不了,后者是真没写盘。 */
        writeBytes: Number(parts[3]),
        readChars: Number(parts[4]),
        command,
        kind,
        label: kindLabel(kind)
      });
    } else if (parts[0] === 'DAEMON' && parts.length >= 3) {
      daemons[parts[1]] = Number(parts[2]);
    } else if (parts[0] === 'DISK' && parts.length >= 4) {
      disks.push({
        mount: parts[1],
        availBytes: (Number(parts[2]) || 0) * 1024,
        usePercent: parseInt(parts[3], 10) || 0
      });
    }
  }
  return { tasks, daemons, disks };
}

/* --------------------------------------------------------------- 进度 */

const STALL_AFTER_MS = 90 * 1000;   // 连续这么久没有字节增长才叫停滞

/**
 * 只有这些类型适用"停滞"判定。
 *
 * 编译和训练**本来就会长时间不写盘** —— 编译在内存里跑、训练几分钟才存一次
 * checkpoint。把它们按下载的标准判死,会给一个完全健康的任务打上"卡住了",
 * 这正是本模块反复强调要避免的那类错误。
 */
const STALL_KINDS = new Set([
  'docker-pull', 'ollama', 'hf', 'git-clone', 'pip', 'npm', 'apt', 'rsync', 'scp', 'wget', 'curl'
]);

/**
 * 拿这次扫描和上次比,算出速率和是否停滞。
 *
 * @param prev  上一轮的任务列表(按 pid 索引)
 * @param scan  parseScan 的结果
 * @param nowMs 当前时间
 *
 * 关键规则:**测不到就说测不到**。progress === 'unknown' 的任务永远不会被标成停滞 ——
 * 把"我没量到"显示成"它卡住了",会让人去排查一个不存在的故障,比不显示更糟。
 */
function mergeTasks(prev, scan, nowMs) {
  const byPid = new Map((prev || []).map((t) => [t.pid, t]));
  const dockerBytes = pickDaemonBytes(scan.daemons);
  const dockerTasks = scan.tasks.filter((t) => t.kind === 'docker-pull');

  return scan.tasks.map((t) => {
    const old = byPid.get(t.pid);
    /* docker pull 的字节数要从守护进程上取。
       只有恰好一个拉取在跑时才能归到它头上 —— 有多个时无法区分是谁下的,
       与其平摊出一个假数字,不如老实说进度未知。 */
    const useDaemon = t.kind === 'docker-pull' && dockerTasks.length === 1 && dockerBytes >= 0;
    const bytes = useDaemon ? dockerBytes : t.writeBytes;
    const measurable = bytes >= 0;

    const base = {
      ...t,
      title: taskTitle(t),
      startedAtMs: old?.startedAtMs ?? (nowMs - t.elapsedSec * 1000),
      bytes: measurable ? bytes : null,
      bytesSource: useDaemon ? 'daemon' : 'process',
      sampledAtMs: nowMs
    };

    if (!measurable) {
      return { ...base, progress: 'unknown', bytesPerSec: null, stalled: false, movedAtMs: null };
    }
    /* 注意是 == null 而不是 !old.sampledAtMs:时间戳可能就是 0,
       用真值判断会把它当成"没有上一次采样",速率永远算不出来。 */
    if (!old || old.bytes == null || old.sampledAtMs == null) {
      // 第一次采样没有基准,报 0 B/s 会被读成"卡住了",所以速率留空
      return { ...base, progress: 'measured', bytesPerSec: null, stalled: false, movedAtMs: nowMs };
    }

    const dt = (nowMs - old.sampledAtMs) / 1000;
    const db = bytes - old.bytes;
    const bytesPerSec = dt > 0 ? Math.max(0, db / dt) : null;
    /* 字节数只要动过就刷新"最后活动时间"。
       用 >0 而不是 >某个阈值:慢速下载也是在下载,不该被判死。 */
    const movedAtMs = db > 0 ? nowMs : (old.movedAtMs ?? nowMs);
    return {
      ...base,
      progress: 'measured',
      bytesPerSec,
      movedAtMs,
      stalled: STALL_KINDS.has(t.kind) && nowMs - movedAtMs >= STALL_AFTER_MS
    };
  });
}

function pickDaemonBytes(daemons = {}) {
  for (const k of ['dockerd', 'containerd']) {
    if (typeof daemons[k] === 'number' && daemons[k] >= 0) return daemons[k];
  }
  return -1;
}

/* --------------------------------------------------------------- 展示 */

function formatBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 一句话说清这个任务在干嘛。
 * 直接摆整条命令行会又长又难认(docker pull 的镜像名常常一百多个字符),
 * 所以抽出最能标识它的那一段 —— 镜像名 / URL 的文件名 / 仓库名。
 */
function taskTitle(task) {
  const cmd = String(task.command || '');
  const pick = (re) => (cmd.match(re) || [])[1];
  let target = '';
  switch (task.kind) {
    case 'docker-pull': target = pick(/\b(?:pull|load)\s+(?:-\S+\s+)*(\S+)/); break;
    case 'ollama': target = pick(/\bollama\s+\w+\s+(\S+)/); break;
    case 'git-clone': target = pick(/\bclone\s+(?:-\S+\s+)*(\S+)/); break;
    case 'wget':
    case 'curl': target = pick(/(https?:\/\/\S+)/); break;
    default: target = '';
  }
  if (!target) {
    // 兜底:去掉路径前缀的可执行名 + 头两个参数,够认出是什么
    const words = cmd.split(/\s+/).filter(Boolean);
    target = words.slice(0, 3).map((w) => w.replace(/^\/\S*\//, '')).join(' ');
  }
  if (target.length > 72) target = `…${target.slice(-71)}`;
  return `${task.label} ${target}`.trim();
}

/** 停止任务。先 TERM 不 KILL —— docker pull 收到 TERM 会清掉半截的层,-9 会留下垃圾。 */
function buildStopCommand(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 1) throw new Error(`非法 PID:${pid}`);
  return `kill -TERM ${p} 2>&1; echo __STOP_SENT__`;
}

/** 磁盘要不要预警。大文件下载把盘写满是这些任务最常见的死法。 */
function diskWarning(disks = [], { minFreeBytes = 5 * 1024 ** 3 } = {}) {
  const tight = disks
    .filter((d) => d.availBytes < minFreeBytes)
    .sort((a, b) => a.availBytes - b.availBytes)[0];
  if (!tight) return null;
  return {
    mount: tight.mount,
    availBytes: tight.availBytes,
    message: `${tight.mount} 只剩 ${formatBytes(tight.availBytes)},大文件下载可能写满`
  };
}

module.exports = {
  KINDS, STALL_AFTER_MS, STALL_KINDS, FIELD,
  classifyKind, kindLabel,
  buildScanCommand, parseScan, mergeTasks, pickDaemonBytes,
  formatBytes, formatDuration, taskTitle,
  buildStopCommand, diskWarning
};
