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

/** 单引号包裹法:内部的单引号用 '\'' 转义。路径来自命令行,必须当不可信处理。 */
function shellQuote(v) {
  return `'${String(v).replace(/'/g, "'\\''")}'`;
}

/** 认得出的下载类任务。顺序有意义:先匹配到的先算。 */
const KINDS = [
  /* docker-build 必须排在 docker-pull **前面**:`docker build --pull` 两个都匹配,
     而它实质是构建。反过来放会把每一次带 --pull 的构建都显示成"拉取镜像"。 */
  { id: 'docker-build', re: /\bdocker\b[^|]*\bbuild\b/, label: '构建镜像' },
  /* `docker run` 在本地没有镜像时会**隐式拉取** —— 那时候整台机器上
     一个 docker pull 进程都没有,拉取完全发生在守护进程里。
     截图里那台机器就是这样:服务 ExecStart 是 docker run,人却在等镜像。
     不认它的话,最该被看见的那段时间恰好什么都看不见。 */
  { id: 'docker-run', re: /\bdocker\b[^|]*\b(run|create|start)\b|\bdocker[- ]compose\b[^|]*\bup\b/, label: '启动容器' },
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
  /* 服务包装脚本。它自己不下载,但**它是那次下载的门面** ——
     进度在它的 journal 里,子进程才是真正在拉的那个。
     放在最后:任何更具体的类型都优先。 */
  { id: 'script', re: /^\/?(usr\/)?(bin|sbin|local\/bin)?\/?(ba)?sh\s+\S*\.sh\b|\bbash\s+-c\b/, label: '脚本' },
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
function buildScanCommand({ watchPaths = [], extraUnits = [] } = {}) {
  const pattern = KINDS.map((k) => k.id).join('|');   // 仅用于注释,真正的匹配在下面
  return [
    `# kinds: ${pattern}`,
    'LC_ALL=C ps -eo pid=,ppid=,etimes=,args= 2>/dev/null | while read -r p pp e a; do',
    /* 先取"它属于哪个 systemd 单元"—— cgroup 路径里就写着。
       这一步必须在分类之前:一个进程**属于某个服务**本身就说明它是后台任务,
       下面的兜底分支要靠它判断。 */
    `  u=$(sed -n 's/.*\\/\\([A-Za-z0-9@._-]*\\.service\\).*/\\1/p' /proc/$p/cgroup 2>/dev/null | head -1)`,
    '  case "$a" in',
    '    *grep*) continue ;;',
    '    *"docker "*pull*|*"docker "*load*|*ollama*pull*|*huggingface-cli*download*'
      + '|*modelscope*download*|*"git "*clone*|*pip*install*|*npm*install*|*pnpm*install*'
      + '|*yarn*add*|*apt-get*install*|*apt*install*|*yum*install*|*dnf*install*'
      + '|*rsync*|*scp*|*wget*|*curl*-O*|*curl*-o*'
      + '|*"docker "*build*|*make*|*cmake*|*ninja*|*cargo*build*|*"go "*build*'
      + '|*mvn*|*gradle*|*torchrun*|*deepspeed*|*accelerate*launch*'
      + '|*"docker "*run*|*"docker "*create*|*docker-compose*up*|*"docker "*compose*up*'
      /* compose 的 pull 之前完全没放行:`docker-compose ... pull` 只匹配到
         *compose*up*(要求有 up),于是掉进"其他长跑进程"那个默认隐藏的桶里。
         而截图里正在下的就是它。 */
      + '|*docker-compose*pull*|*"docker "*compose*pull*|*git-lfs*|*lfs*smudge*) long=0 ;;',
    /* 没匹配上的:只要跑够久,也留一条(打 LONG 标记,界面默认不显示)。
       KINDS 是一份**人工列举**,一定会漏 —— 智能体完全可能起一个我没想到的
       长命令。漏掉的那个恰恰最需要被看见,因为你连它叫什么都不知道。
       但默认全列会被 sshd/agetty 这类常驻守护进程淹没,所以做成开关。 */
    '    *) case "$a" in',
    /* 常驻守护进程排除掉:它们永远在跑,列出来只会把真正的任务淹没。
       模式里不放引号和反斜杠 —— case 的 glob 里它们的转义规则很绕,
       写错了不会报错,只会静默地不匹配。 */
    /* 只排交互式登录 shell,**不能排所有 bash**。
       之前写的是 *bash*,结果把 `/bin/bash /usr/local/bin/xxx-bootstrap.sh`
       也吃掉了 —— 而那个包装脚本正是拥有整个下载的进程,
       它一被丢掉,整个任务就从面板上消失了(截图里面板全空就是这么来的)。 */
    '         -bash|-sh|-zsh|bash|sh|zsh|/bin/bash|/bin/sh|/usr/bin/bash|/usr/bin/zsh) continue ;;',
    '         *sshd*|*systemd*|*agetty*|*crond*|*cron*|*rsyslog*|*dbus*|*polkit*'
      + '|*NetworkManager*|*containerd-shim*|*docker-proxy*|*chronyd*|*ntpd*'
      + '|*auditd*|*irqbalance*|*udev*|*"login "*) continue ;;',
    '       esac',
    /* 兜底分支的三档,按"这东西多像一个后台作业"从强到弱:
     *
     * 1. **shell 脚本跑够一分钟** —— 不管归不归某个服务。智能体很爱用
     *    `nohup xxx-retry.sh &` 起重试循环,那种进程的 cgroup 是会话作用域
     *    而不是 .service,只按"属于服务"判会把它漏进隐藏桶。
     *    而它恰恰最该盯:截图里那个 ragflow-pull-retry.sh 已经重试 186 次了。
     * 2. **属于某个 systemd 服务且跑够一分钟** —— "属于一个服务"就是
     *    "有人特意让它在后台跑"的证据。
     * 3. 其余的按"跑够 5 分钟"收进默认隐藏的桶。短命进程每轮扫描都在变,
     *    列出来是一片闪烁的噪音。
     *
     * glob 里的空格必须加引号(`*".sh "*`),不加会被 case 当成语法错误。
     */
    '       isjob=0',
    '       case "$a" in',
    '         *.sh|*".sh "*|*"bash -c"*|*"sh -c"*) isjob=1 ;;',
    '       esac',
    '       if [ "$isjob" = 1 ] && [ "${e:-0}" -ge 60 ] 2>/dev/null; then long=0;',
    '       elif [ -n "${u:-}" ] && [ "${e:-0}" -ge 60 ] 2>/dev/null; then long=0;',
    '       else [ "${e:-0}" -ge 300 ] 2>/dev/null || continue; long=1; fi ;;',
    '  esac',
    `  w=$(awk '/^write_bytes:/{print $2}' /proc/$p/io 2>/dev/null || echo -1)`,
    `  r=$(awk '/^rchar:/{print $2}' /proc/$p/io 2>/dev/null || echo -1)`,
    /* 这个进程属于哪个 systemd 单元 —— cgroup 路径里就写着。
       靠它才能把进程和"它的服务日志"对上:截图里那条 docker compose pull
       的分层进度只存在于 ragflow-bootstrap.service 的 journal 里,
       而那个单元名不含 pull/download,按名字过滤根本扫不到。 */
    `  printf 'TASK%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s\\n' "\x1f" "$p" "\x1f" "\${pp:-0}" "\x1f" "$e" "\x1f" "\${w:--1}" "\x1f" "\${r:--1}" "\x1f" "\${long:-0}" "\x1f" "\${u:-}" "\x1f$a"`,
    'done',
    /* 全机进程的父子关系 + 写入量,各来一遍。
     *
     * 为什么需要:很多下载器**自己不写盘,写盘的是它 fork 出来的子进程**。
     * `git clone` 拉大仓库时真正干活的是 git-remote-https 和 git-lfs;
     * 截图里那个用 git-lfs 拉权重的服务就是这样,父进程 io 恒为 0。
     * 只看被匹配到的那个 pid,会得出"一直 0 B"的错误结论。
     *
     * 用一次 awk 读完所有 /proc/<pid>/io —— 逐个起子 shell 去读会慢到不可用。
     */
    'LC_ALL=C ps -eo pid=,ppid= 2>/dev/null'
      + ` | awk '{printf "PPID\x1f%s\x1f%s\\n", $1, $2}'`,
    `awk 'FNR==1{split(FILENAME,a,"/"); pid=a[3]} /^write_bytes:/{printf "IO\x1f%s\x1f%s\\n", pid, $2}'`
      + ' /proc/[0-9]*/io 2>/dev/null',
    // 守护进程的写入量:docker pull 的真实进度只能从这里看
    'for d in dockerd containerd; do',
    '  dp=$(pgrep -x "$d" 2>/dev/null | head -1)',
    `  [ -n "$dp" ] && printf 'DAEMON%s%s%s%s\\n' "\x1f" "$d" "\x1f" `
      + `"$(awk '/^write_bytes:/{print $2}' /proc/$dp/io 2>/dev/null || echo -1)"`,
    'done',
    /* systemd 单元。
     *
     * 智能体很爱把长活儿包成服务跑(截图里就是 qwen7b-vllm.service 在拉镜像),
     * 而这时:
     *   · ExecStart 是 docker run,拉取发生在守护进程里 —— 没有 docker pull 进程;
     *   · 单元停在 activating,既没起来也没报错,对话里只剩一句"正在下载"。
     * activating 本身就是最好的信号:它的意思就是"在启动,还没就绪"。
     *
     * 只看 activating 的 + 名字像下载/镜像的 running 单元,并限量 —— 
     * 给每个 running 单元都跑一次 systemctl show 会很慢。
     */
    'if command -v systemctl >/dev/null 2>&1; then',
    '  { systemctl list-units --type=service --state=activating --no-legend --plain 2>/dev/null;',
    '    systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null'
      + " | grep -Ei 'pull|download|image|fetch|install|vllm|model|sync';"
      /* 再加上"正在跑下载任务的那些进程所属的单元"。
         名字过滤一定会漏 —— 截图里的 ragflow-bootstrap.service 不含任何
         下载相关的词,可它的 journal 里正是那份分层进度。 */
      + extraUnits.map((u) => ` printf '%s\\n' ${shellQuote(u)};`).join('')
      + " }"
      // 管道必须留在上一行末尾:`}` 换行再 `| awk` 在 sh 里是语法错误
      + " | awk '{print $1}' | sort -u | head -8 | while read -r u; do",
    '    [ -n "$u" ] || continue',
    /* 一次 systemctl show 取三个属性(跑三次太慢:8 个单元 × 3 = 24 次进程启动)。
       **但绝不能用 --value 按位置取** —— systemctl 是按它自己的内部顺序返回的,
       不是你请求的顺序。界面上出现过 `143995769/active` 这种东西,
       就是把时间戳当成了 ActiveState:字段整体错位了。
       所以保留 KEY=VALUE 形式,按名字各取各的。 */
    '    v=$(systemctl show "$u" -p ActiveState -p SubState'
      + ' -p ExecMainStartTimestampMonotonic 2>/dev/null)',
    `    st=$(printf '%s\\n' "$v" | sed -n 's/^ActiveState=//p' | head -1)`,
    `    sub=$(printf '%s\\n' "$v" | sed -n 's/^SubState=//p' | head -1)`,
    `    since=$(printf '%s\\n' "$v" | sed -n 's/^ExecMainStartTimestampMonotonic=//p' | head -1)`,
    '    st=${st:-?}; sub=${sub:-?}; since=${since:-0}',
    /* 最后一行日志:服务在拉镜像时,进度和报错**都只在这里**。
       没有它,面板只能说"在启动中",等于没说。
       顺手删掉日志里的分隔符,否则里面正好出现一个就会把字段切错位。 */
    /* 取最后 6 行而不是 1 行:一次拉取会把每一层刷成一行,
       只看最后一行常常正好落在"Verifying"这类没有数字的行上,
       而带 `1.2GB/4.5GB` 的那条就在它上面一两行。合成一行传回来。 */
    '    last=$(timeout 3 journalctl -u "$u" -n 6 --no-pager -o cat 2>/dev/null'
      + " | tr -d '\\037' | tr '\\n' '|' | tail -c 400)",
    "    printf 'UNIT\\037%s\\037%s\\037%s\\037%s\\037%s\\n'"
      + ' "$u" "$st" "$sub" "$since" "$last"',
    '  done',
    'fi',
    /* 系统运行时长。systemd 给的是**单调时钟**的时间戳(开机以来的微秒数),
       不减去它就没法换算成"这个单元跑了多久" —— 界面上会一直显示「已运行 0 秒」,
       而那个服务其实已经下了半小时。 */
    `awk '{printf "UPTIME\x1f%s\\n", $1}' /proc/uptime 2>/dev/null`,
    /* 磁盘余量:大镜像/权重把盘写满是这些任务最常见的死法,
       而报错往往埋在几百行输出里,不如直接摆出来 */
    `df -P -k 2>/dev/null | awk 'NR>1 && $1 ~ /^\\// {printf "DISK\x1f%s\x1f%s\x1f%s\\n", $6, $4, $5}'`,
    /* 量一下下载目标目录有多大。
       路径由上一轮扫描的结果推出来(见 collectWatchPaths),所以第一轮没有、
       第二轮起才有 —— 用一轮的延迟换掉一次额外往返,划算。 */
    /* 每个 du 单独限时 4 秒。目录里文件极多时 du 会很慢,
       而它只是锦上添花的一项 —— 不该把整轮扫描拖到超时,
       导致连"有哪些任务"都显示不出来。 */
    ...watchPaths.map((p) => `timeout 4 du -sb ${shellQuote(p)} 2>/dev/null`
      + ` | awk '{printf "PATHSZ\x1f%s\x1f%s\\n", $2, $1}'`)
  ].join('\n');
}

/** 命令行里常有密钥(curl -H "Authorization: Bearer …"、带账号的 URL),展示前必须脱敏 */
function parseScan(text) {
  const tasks = [];
  const daemons = {};
  const disks = [];
  const units = [];
  let uptimeSec = 0;
  const pathSizes = new Map();   // 目标目录 -> 字节数
  const ppids = new Map();   // pid -> ppid
  const io = new Map();      // pid -> write_bytes
  for (const line of String(text || '').split('\n')) {
    const parts = line.split(FIELD);
    // TASK ␟ pid ␟ ppid ␟ etimes ␟ write_bytes ␟ rchar ␟ long ␟ unit ␟ 完整命令行
    if (parts[0] === 'TASK' && parts.length >= 9) {
      const pid = Number(parts[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const command = redact(parts.slice(8).join(FIELD).trim());
      const kind = classifyKind(command);
      tasks.push({
        pid,
        ppid: Number(parts[2]) || 0,
        elapsedSec: Math.max(0, Number(parts[3]) || 0),
        /* 没匹配上任何已知类型、只是"跑得久"而被捞进来的。
           界面默认不显示这一类 —— KINDS 是人工列举的,一定会漏,
           但把所有长跑进程都摊开又会淹掉真正的任务。 */
        longRunning: parts[6] === '1',
        // 它属于哪个 systemd 单元(可能为空:不是被服务拉起来的)
        unit: String(parts[7] || '').trim(),
        /* -1 表示读不到 /proc/<pid>/io(不是同一个用户,或内核没开)。
           必须和"读到了 0"区分开:前者是测不了,后者是真没写盘。 */
        writeBytes: Number(parts[4]),
        readChars: Number(parts[5]),
        command,
        kind,
        label: kindLabel(kind)
      });
    } else if (parts[0] === 'PATHSZ' && parts.length >= 3) {
      pathSizes.set(parts[1], Number(parts[2]) || 0);
    } else if (parts[0] === 'UPTIME' && parts.length >= 2) {
      uptimeSec = Number(parts[1]) || 0;
    } else if (parts[0] === 'PPID' && parts.length >= 3) {
      ppids.set(Number(parts[1]), Number(parts[2]));
    } else if (parts[0] === 'IO' && parts.length >= 3) {
      io.set(Number(parts[1]), Number(parts[2]));
    } else if (parts[0] === 'DAEMON' && parts.length >= 3) {
      daemons[parts[1]] = Number(parts[2]);
    // UNIT ␟ 单元名 ␟ ActiveState ␟ SubState ␟ 启动时刻(单调,微秒) ␟ 最后一行日志
    } else if (parts[0] === 'UNIT' && parts.length >= 6) {
      const name = String(parts[1] || '').trim();
      if (!name.endsWith('.service')) continue;
      units.push({
        unit: name,
        activeState: parts[2],
        subState: parts[3],
        // 单调时钟的微秒数,配合 /proc/uptime 才能算出"跑了多久"
        startedMonotonicUs: Number(parts[4]) || 0,
        // 日志里可能有 token(拉私有仓库的报错常带 Authorization),照例脱敏
        lastLog: redact(String(parts[5] || '').trim()).slice(-200)
      });
    } else if (parts[0] === 'DISK' && parts.length >= 4) {
      disks.push({
        mount: parts[1],
        availBytes: (Number(parts[2]) || 0) * 1024,
        usePercent: parseInt(parts[3], 10) || 0
      });
    }
  }
  return { tasks, daemons, disks, units, ppids, io, uptimeSec, pathSizes };
}

/* ------------------------------------------------- systemd 单元 → 任务 */

/**
 * 把 systemd 单元变成面板上的一条任务。
 *
 * 为什么值得单独一路:智能体很爱把长活儿包成服务跑,而这时候
 *   · ExecStart 往往是 `docker run` —— 镜像的拉取发生在守护进程里,
 *     整台机器上**一个 docker pull 进程都没有**,只扫 ps 什么也看不到;
 *   · 单元停在 activating,既没起来也没报错,对话里只留一句"正在下载"。
 *
 * `activating` 就是最好的信号 —— 它的字面意思就是"在启动,还没就绪"。
 * 而真正说明"到哪一步了"的,是最后一行日志。
 */
/**
 * 这个单元值不值得摆到面板上。
 *
 * 光"它在 running"是不够的 —— 每台机器上都有几十个常驻服务,
 * 面板被 auditd / mdmonitor / libstoragemgmt 塞满时,你要等的那个下载
 * 反而被挤到了看不见的地方(截图里就是这样)。
 *
 * 只有三种情况才算"有事发生":
 *  · **activating** —— 字面意思就是"在启动、还没就绪",正是你在等的状态;
 *  · **失败** —— 最该立刻看到的一条;
 *  · **日志里解析出了真实进度** —— 那说明它确实在下载。
 */
function unitIsInteresting(task) {
  if (!task) return false;
  if (task.activeState === 'activating') return true;
  if (task.state === 'failed') return true;
  if (task.progress && task.progress.total > 0) return true;
  return false;
}

function unitTask(u, { now = Date.now(), uptimeSec = 0, pathSizes = null } = {}) {
  const starting = u.activeState === 'activating';
  /* systemd 的时间戳是单调时钟(开机以来的微秒),减去系统已运行时长才是"跑了多久"。
     之前这里直接写死 0,于是一个下了半小时的服务显示「已运行 0 秒」—— 
     比不显示更糟,因为它看起来像刚起来、没问题。 */
  const startedSec = u.startedMonotonicUs > 0 ? u.startedMonotonicUs / 1e6 : 0;
  const elapsedMs = (startedSec > 0 && uptimeSec > startedSec)
    ? Math.round((uptimeSec - startedSec) * 1000)
    : 0;
  const unitPath = watchPathForUnit(u);
  const unitBytes = unitPath && pathSizes ? (pathSizes.get(unitPath) ?? -1) : -1;
  const failed = u.activeState === 'failed' || u.subState === 'failed';
  return {
    unit: u.unit,
    kind: 'systemd',
    label: '服务',
    title: `服务 ${u.unit.replace(/\.service$/, '')}`,
    /* activating 也算"进行中":它确实在推进。
       但**永远不判停滞** —— 服务可能就是启动慢,而我们手上没有任何字节数
       能证明它没在动,凭时长判死就是猜。 */
    state: failed ? 'failed' : 'running',
    activeState: u.activeState,
    subState: u.subState,
    /* 这一行是整条记录里最有用的东西:服务拉镜像时,进度和报错都只在这里。
       没有它,面板只能说"在启动中",等于没说。 */
    lastLog: u.lastLog,
    /* 日志里如果有 `1.2GB/4.5GB`,那就是**真实**的总量 —— 界面据此画进度条。
       解析不到就是 null,界面不画,绝不用别的数字凑一个。 */
    progress: parseSizeProgress(u.lastLog),
    /* 说清这个百分比是什么的百分比。docker 是按层刷进度的,
       日志里那对数字是**当前这一层**,不是整个镜像 ——
       不写明的话,进度条走到 100% 又跳回去会像出错了。 */
    progressNote: '来自服务日志(docker 按层计,不是整个镜像)',
    note: starting ? '单元仍在 activating —— 尚未就绪,常见于还在拉镜像' : '',
    elapsedMs,
    /* 服务往哪儿下的,以及那个目录现在多大 —— 这是"对话里说的 2GB"
       在面板上的对应物。 */
    watchPath: unitPath,
    bytes: unitBytes >= 0 ? unitBytes : null,
    progressMode: unitBytes >= 0 ? 'measured' : 'unknown',
    bytesSource: unitBytes >= 0 ? 'dir' : '',
    sampledAtMs: now
  };
}

/* ------------------------------------------------------- 下载目标目录 */

/**
 * 绝不去 du 的目录。
 *
 * 这里防的**不是注入**(路径会被 shellQuote),而是**卡死**:
 * `du -sb /` 在一台有几 TB 数据的机器上要跑几分钟,而扫描是 12 秒超时的 ——
 * 结果就是整个面板每一轮都超时,什么都显示不出来。
 */
const DU_DENY = /^\/(usr|etc|proc|sys|dev|boot|bin|sbin|lib|lib64|run|var\/lib\/docker)(\/|$)|^\/?$/;

function safeWatchPath(pth) {
  const p = String(pth || '').trim().replace(/[",;|&$`]/g, '');
  if (!p.startsWith('/') || p.length < 5) return '';
  if (DU_DENY.test(p)) return '';
  return p;
}

/**
 * 猜这个任务把东西下到哪儿了。
 *
 * 为什么要猜:对话里智能体会说「当前约下载 2GB」—— 它是 du 出来的。
 * 而面板只会读 /proc 的写入量,那个数字在很多情况下拿不到(比如
 * 写盘的是孙子进程、或者进程属于别的用户)。**目录大小是最稳的一手数据**,
 * 而且和智能体报的是同一个数,不会出现"对话说 2GB、面板说 0 B"。
 */
function watchPathFor(task) {
  const cmd = String(task?.command || '');
  const pick = (re) => safeWatchPath((cmd.match(re) || [])[1]);
  switch (task?.kind) {
    case 'git-clone': {
      // 目标目录是最后一个非选项、非 URL、非纯数字的参数
      const dest = cmd.split(/\s+/).reverse()
        .find((w) => w.startsWith('/') && !/^-/.test(w));
      return safeWatchPath(dest);
    }
    case 'wget': return pick(/-P\s+(\S+)/) || pick(/-O\s+(\S+)/);
    case 'curl': return pick(/-o\s+(\S+)/) || pick(/--output\s+(\S+)/);
    case 'hf': return pick(/--local-dir[= ](\S+)/) || pick(/--cache-dir[= ](\S+)/);
    case 'rsync':
    case 'scp': {
      const last = cmd.split(/\s+/).pop();
      return safeWatchPath(last);
    }
    default: return '';
  }
}

/** 服务的目标目录只能从日志里找 —— 截图里那条就写着「weights to /home/models.」 */
function watchPathForUnit(u) {
  const m = String(u?.lastLog || '').match(/(\/[A-Za-z0-9._\-/]{4,})/g) || [];
  for (const raw of m) {
    const p = safeWatchPath(raw.replace(/[.,;:]$/, ''));
    if (p) return p;
  }
  return '';
}

/** 汇总本轮要量的目录。限量:du 再快也架不住一次量十几个。 */
/** 本轮扫到的进程分别属于哪些单元 —— 下一轮把它们也纳入 journal 抓取 */
function collectUnits({ tasks = [] } = {}, { max = 6 } = {}) {
  const out = [];
  for (const t of tasks) {
    /* **只拉"认得出是什么活儿"的那些进程所属的单元。**
       之前不加这个过滤,面板被 auditd / mdmonitor / libstoragemgmt 这类
       系统守护进程塞满了 —— 它们只是碰巧有个子进程被扫到,
       跟你在等的下载毫无关系。 */
    if (!t.unit || t.kind === 'other' || t.longRunning) continue;
    const u = String(t.unit).trim();
    if (u.endsWith('.service') && !out.includes(u) && out.length < max) out.push(u);
  }
  return out;
}

function collectWatchPaths({ tasks = [], units = [] } = {}, { max = 4 } = {}) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p) && out.length < max) out.push(p); };
  for (const t of tasks) add(watchPathFor(t));
  for (const u of units) add(watchPathForUnit(u));
  return out;
}

/* ----------------------------------------------------- 从日志里抠出真进度 */

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/**
 * 从一行输出里找 `1.2GB/4.5GB` 这样的进度。
 *
 * 这是**唯一**能拿到真实总量的途径。字节数只能告诉你"下了多少",
 * 而人真正想知道的是"还有多少" —— 截图里那句「还有多少没下载」问的就是这个。
 * docker pull、wget、curl 的进度行都是这个格式。
 *
 * 取最后一处匹配:一行里可能有多层的数字,越靠后越新。
 */
function parseSizeProgress(text) {
  const re = /(\d+(?:\.\d+)?)\s*([kKMGT]?i?B)\s*\/\s*(\d+(?:\.\d+)?)\s*([kKMGT]?i?B)/g;
  let last = null;
  let m;
  while ((m = re.exec(String(text || '')))) last = m;
  if (!last) return null;
  const unit = (u) => SIZE_UNITS[String(u).replace('i', '').toUpperCase().replace(/^K/, 'K')] || SIZE_UNITS[`${String(u)[0].toUpperCase()}B`] || 1;
  const transferred = Number(last[1]) * unit(last[2]);
  const total = Number(last[3]) * unit(last[4]);
  /* 总量必须大于已下载才可信。反过来的话多半是我们把两个不相干的数字
     配成了一对(比如内存占用),宁可不显示也不要给一个 300% 的进度条。 */
  if (!(total > 0) || transferred > total * 1.05) return null;
  return { transferred, total };
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
  'docker-pull', 'docker-run', 'ollama', 'hf', 'git-clone', 'pip', 'npm', 'apt', 'rsync', 'scp', 'wget', 'curl'
]);

/** 这几类的实际下载都发生在 docker 守护进程里,客户端进程不写盘 */
const DOCKER_KINDS = new Set(['docker-pull', 'docker-run', 'docker-build']);

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
/**
 * 一个进程连同它所有后代的写入量。
 *
 * 存在的理由:**很多下载器自己不写盘,写盘的是它 fork 出来的子进程。**
 * `git clone` 拉大仓库时干活的是 git-remote-https / git-lfs;
 * 只看父进程会得出"一直 0 B"的错误结论,而那正是最误导人的一种显示 ——
 * 它和"真的卡住了"长得一模一样。
 *
 * 有 cap 是因为进程表可能有环(理论上不该有,但 ppid 是异步采样的两份数据
 * 拼起来的,不能假设它一定是棵树)—— 没有上限的话这里会死循环,
 * 表现是整个扫描永远不返回。
 */
function subtreeWriteBytes(pid, { ppids, io }, { maxNodes = 4000 } = {}) {
  if (!ppids || !io) return io?.get(pid) ?? -1;
  // 先把 ppid 反向索引成 parent -> children,否则每层都要全表扫一遍
  const children = new Map();
  for (const [child, parent] of ppids) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  let sum = 0;
  let sawAny = false;
  const seen = new Set();
  const stack = [pid];
  while (stack.length && seen.size < maxNodes) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    const w = io.get(p);
    if (typeof w === 'number' && w >= 0) { sum += w; sawAny = true; }
    for (const c of children.get(p) || []) stack.push(c);
  }
  // 一个都没读到就是"测不到",不是"写了 0 字节" —— 这两者绝不能混
  return sawAny ? sum : -1;
}

function mergeTasks(prev, scan, nowMs) {
  const byPid = new Map((prev || []).map((t) => [t.pid, t]));
  const dockerBytes = pickDaemonBytes(scan.daemons);
  /* 哪些任务的字节数该从守护进程上读。
     **不只是 docker pull** —— `docker run` 在本地没有镜像时会隐式拉取,
     `docker build` 拉基础镜像同理。截图里那条「启动容器 docker run」
     跑了 15 分钟一直显示 0 B,就是因为这里只认了 docker-pull:
     客户端进程本来就不写盘,活是 dockerd 干的。 */
  const dockerTasks = scan.tasks.filter((t) => DOCKER_KINDS.has(t.kind));

  return scan.tasks.map((t) => {
    const old = byPid.get(t.pid);
    /* docker pull 的字节数要从守护进程上取。
       只有恰好一个拉取在跑时才能归到它头上 —— 有多个时无法区分是谁下的,
       与其平摊出一个假数字,不如老实说进度未知。 */
    const useDaemon = DOCKER_KINDS.has(t.kind) && dockerTasks.length === 1 && dockerBytes >= 0;
    /* docker 客户端进程**本来就不写盘**。归不到守护进程头上时(比如同时有
       好几个 docker 命令在跑),它自己那个 0 是没有意义的 ——
       显示「已写入 0 B · 0 B/s」会被读成"卡住了",而它其实下得好好的。
       这种情况必须报"测不到",不能报 0。 */
    const dockerUnattributed = DOCKER_KINDS.has(t.kind) && !useDaemon;
    /* 非 docker 的一律按**进程树**求和,而不是只看这一个 pid ——
       git/wget/pip 真正写盘的往往是子进程。 */
    const treeBytes = useDaemon ? -1 : subtreeWriteBytes(t.pid, scan);
    /* 目标目录的大小优先级最高:它和智能体在对话里报的是**同一个数**
       (它也是 du 出来的)。否则会出现"对话说已下 2GB、面板说 0 B"这种
       自相矛盾 —— 那比没有数字更让人不信任面板。 */
    const watchPath = watchPathFor(t);
    const dirBytes = watchPath && scan.pathSizes ? (scan.pathSizes.get(watchPath) ?? -1) : -1;
    const bytes = dirBytes >= 0 ? dirBytes
      : (useDaemon ? dockerBytes
        : (dockerUnattributed ? -1 : (treeBytes >= 0 ? treeBytes : t.writeBytes)));
    const measurable = bytes >= 0;

    /* 它所属服务的 journal 里可能正带着分层进度(`146.7MB/323.8MB`)。
       截图里智能体报的那三行百分比就是从这里读的 —— 面板没理由拿不到。 */
    const ownUnit = t.unit ? (scan.units || []).find((u) => u.unit === t.unit) : null;
    const logProgress = ownUnit ? parseSizeProgress(ownUnit.lastLog) : null;

    const base = {
      ...t,
      title: taskTitle(t),
      progressFromLog: logProgress,
      progressNote: logProgress ? `来自 ${t.unit} 的日志(docker 按层计,不是整个镜像)` : '',
      lastLog: ownUnit ? ownUnit.lastLog : '',
      startedAtMs: old?.startedAtMs ?? (nowMs - t.elapsedSec * 1000),
      bytes: measurable ? bytes : null,
      bytesSource: dirBytes >= 0 ? 'dir'
        : (useDaemon ? 'daemon' : (treeBytes >= 0 ? 'tree' : 'process')),
      watchPath: dirBytes >= 0 ? watchPath : '',
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
    /* git clone 的参数里常混着 -c key=value、--depth 1、--branch x。
       之前只跳过 `-开头` 的词,于是 `--depth 1` 的那个 `1` 被当成了目标 ——
       界面上就出现了没有任何信息量的「克隆仓库 1」。
       改成直接找 URL,找不到再退到最后一个非选项参数(本地路径的情况)。 */
    case 'git-clone':
      target = pick(/((?:https?|git|ssh):\/\/\S+|\S+@\S+:\S+)/)
        || (cmd.split(/\s+/).filter((w) => !w.startsWith('-') && !/^\d+$/.test(w)).pop() || '');
      break;
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
  KINDS, STALL_AFTER_MS, STALL_KINDS, DOCKER_KINDS, FIELD,
  watchPathFor, watchPathForUnit, collectWatchPaths, collectUnits, safeWatchPath,
  classifyKind, kindLabel,
  buildScanCommand, parseScan, mergeTasks, pickDaemonBytes, unitTask, unitIsInteresting,
  parseSizeProgress,
  subtreeWriteBytes,
  formatBytes, formatDuration, taskTitle,
  buildStopCommand, diskWarning
};
