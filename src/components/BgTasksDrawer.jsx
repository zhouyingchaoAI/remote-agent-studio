import React, { useEffect, useState } from 'react';

/**
 * 后台任务面板。
 *
 * 后台跑的活儿远不止下载:传文件、装引擎、下发技能、跑速览、自动沉淀、
 * 智能体的每一轮对话,以及主机上那些智能体自己起的进程。它们本来散在各自的
 * 页面里,有的连"在跑"都看不出来 —— 这里把它们收到一处。
 *
 * 两条贯穿始终的原则:
 *
 * 1. **不编进度。** 多数下载器不给总量,硬凑百分比就是编数字。有精确进度就画进度条,
 *    只能测到字节数就报「已写入 3.4 GB · 12 MB/s」,什么都测不到就直说测不到。
 * 2. **终态要说清是哪一种。** 「完成」是应用亲眼看到它成功返回;
 *    「已结束(结果未知)」是主机上的进程消失了但我们拿不到退出码。
 *    这两个混为一谈,面板就失去了存在的意义。
 */

const STATE_TEXT = {
  running: '进行中',
  stalled: '停滞',
  done: '完成',
  failed: '失败',
  ended: '已结束(结果未知)'
};

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 顶栏角标。
 *
 * 存在的理由:面板不打开时也得让人知道后台有活儿 —— 人恰恰是想不起来看的时候
 * 才最需要它。所以保持一个 30 秒的慢档轮询,面板打开才切到 6 秒的快档。
 */
export function BgTasksBadge({ onClick, hostId = '', convId = '' }) {
  const [snap, setSnap] = useState({ running: 0, stalled: 0, failed: 0 });

  useEffect(() => {
    /* 角标和面板用同一套作用域 —— 否则会出现「角标说有 3 个,点进去一个没有」
       (那 3 个在别的主机上)。 */
    window.api.bg.start({ fast: false, hostId, convId });
    const off = window.api.bg.onUpdate(setSnap);
    window.api.bg.snapshot({ hostId, convId }).then(setSnap).catch(() => {});
    return () => off?.();
  }, [hostId, convId]);

  const bad = (snap.stalled || 0) + (snap.failed || 0);
  if (!snap.running && !bad) return null;
  return (
    <button className={`bg-badge${bad ? ' warn' : ''}`} onClick={onClick}
      title={bad ? `${snap.running} 个在跑,${snap.stalled || 0} 个停滞,${snap.failed || 0} 个失败`
        : `${snap.running} 个后台任务在跑`}>
      {bad ? '⚠' : '⬇'} {snap.running || bad}
    </button>
  );
}

/** 有确切总量时才画进度条 —— 画一根不知道走到哪的条,比不画更误导 */
function ProgressBar({ p, note }) {
  if (!p || !p.total || !(p.total > 0)) return null;
  const pct = Math.min(100, Math.round(((p.transferred || 0) / p.total) * 100));
  return (
    <div className="bg-bar-wrap">
      <div className="bg-bar" title={note || `${fmtBytes(p.transferred)} / ${fmtBytes(p.total)}`}>
        <div className="bg-bar-fill" style={{ width: `${pct}%` }} />
        <span className="bg-bar-text">
          {pct}% · {fmtBytes(p.transferred)} / {fmtBytes(p.total)}
        </span>
      </div>
      {/* 说清这是什么的百分比:docker 按层刷,走到 100% 又跳回去不是出错 */}
      {note && <span className="bg-bar-note small muted">{note}</span>}
    </div>
  );
}

const TARGET_STATE = {
  starting: { text: '启动中', cls: 's-running' },
  active: { text: '运行中', cls: 's-done' },
  failed: { text: '失败', cls: 's-failed' },
  running: { text: '进行中', cls: 's-running' },
  idle: { text: '当前无进程', cls: 's-ended' },
  watching: { text: '监控中', cls: 's-running' },
  unknown: { text: '本轮没查到', cls: 's-ended' }
};

/** 一条极简趋势线:只要能看出"在涨/平了"就够,不需要坐标轴 */
function Spark({ points = [] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((v, i) =>
    `${(i / (points.length - 1)) * 100},${20 - ((v - min) / span) * 18}`).join(' ');
  return (
    <svg className="bg-spark" viewBox="0 0 100 20" preserveAspectRatio="none">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * 对话启动的后台目标。
 *
 * 和上面那些"应用自己发起的任务"分开显示,因为信息完整度不是一回事:
 * 这里是**跨采样累积**出来的 —— 从开始到现在涨了多少、现在还动不动,
 * 而不是某一刻的进程快照。进程消失不影响这条卡片存在。
 */
function TargetRow({ rec, hostName }) {
  const st = TARGET_STATE[rec.state] || { text: rec.state, cls: '' };
  return (
    <div className={`bg-task st-${rec.state === 'failed' ? 'failed' : 'running'}`}>
      <div className="row gap bg-task-head">
        <span className="bg-kind">{rec.label}</span>
        <span className="bg-title" title={rec.command || rec.name}>{rec.name}</span>
        <span className="flex1" />
        <span className={`bg-state ${st.cls}`}>{st.text}</span>
      </div>

      <div className="row gap bg-task-meta small muted">
        {hostName && <span>{hostName}</span>}
        <span>已持续 {fmtDur(Date.now() - (rec.firstSeenAt || Date.now()))}</span>
        {/* 「涨了多少」比「现在多大」有用:后者看不出这段时间有没有推进 */}
        {rec.grownBytes != null && <span>已增长 {fmtBytes(rec.grownBytes)}</span>}
        {rec.bytesPerSec != null && <span>{fmtBytes(rec.bytesPerSec)}/s</span>}
        {rec.activeState && <span>{rec.activeState}/{rec.subState}</span>}
        {rec.pid && <span>PID {rec.pid}</span>}
      </div>

      {rec.sparkline?.length >= 2 && <Spark points={rec.sparkline} />}

      {rec.lastLog && <pre className="bg-log" title={rec.lastLog}>{rec.lastLog}</pre>}

      {rec.idle && (
        <p className="bg-stall small">
          ⚠ 两分钟没有新增数据 —— 可能已经完成,也可能卡住了
        </p>
      )}
      {rec.state === 'idle' && (
        /* 「当前没有进程」不等于「结束了」:重试脚本在 sleep 间隙、
           systemd 在两次重启之间,都会有一段时间没有进程。 */
        <p className="bg-note small muted">
          这一刻没扫到进程 —— 重试型任务在两次尝试之间本来就没有进程,继续观察。
        </p>
      )}
    </div>
  );
}

function TaskRow({ task, hostName }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const isHost = task.source === 'host';
  const canStop = task.state === 'running' || task.state === 'stalled';
  /* systemd 单元这一版不给停止按钮:停一个服务和杀一个进程完全是两回事
     (要 systemctl stop,还得考虑 Restart= 会不会把它又拉起来)。
     与其给一个点了可能没反应的按钮,不如先不给。 */
  const stoppable = isHost ? (canStop && !!task.pid) : (canStop && !!task.cancelChannel);

  const doStop = async () => {
    setBusy(true); setErr('');
    try {
      if (isHost) await window.api.bg.stopTask({ hostId: task.hostId, pid: task.pid });
      else await window.api.bg.cancel({ id: task.id });
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); setConfirming(false); }
  };

  return (
    <div className={`bg-task st-${task.state}`}>
      <div className="row gap bg-task-head">
        <span className="bg-kind">{task.label}</span>
        <span className="bg-title" title={task.command || task.title}>{task.title}</span>
        <span className="flex1" />
        <span className={`bg-state s-${task.state}`}>{STATE_TEXT[task.state] || task.state}</span>
        {stoppable && !confirming && (
          <button className="btn tiny ghost" onClick={() => setConfirming(true)}>停止</button>
        )}
      </div>

      {/* progress 是应用自己发起的传输(总量确定);progressFromLog 是从
          服务日志里解析出的分层进度。两者都没有才不画条。 */}
      <ProgressBar p={task.progress || task.progressFromLog} note={task.progressNote} />

      <div className="row gap bg-task-meta small muted">
        {hostName && <span>{hostName}</span>}
        <span>{task.state === 'running' || task.state === 'stalled' ? '已运行' : '耗时'} {fmtDur(task.elapsedMs)}</span>

        {task.activeState && <span title="systemd 的 ActiveState/SubState">{task.activeState}/{task.subState}</span>}

        {isHost && (task.progressMode === 'measured' ? (
          <>
            <span>已写入 {fmtBytes(task.bytes)}</span>
            <span>{task.bytesPerSec == null ? '测速中…' : `${fmtBytes(task.bytesPerSec)}/s`}</span>
          </>
        ) : task.state !== 'ended' && (
          /* 量不到时必须说"量不到",而不是显示 0 B/s —— 后者会被看成卡住了,
             让人去查一个不存在的问题。
             两种量不到的原因完全不同,文案也得不同:服务根本没有 pid,
             跟人说"读不到 /proc/<pid>/io"等于答非所问。 */
          task.kind === 'systemd'
            ? <span title="日志里没提到下载目录,所以量不出已下载多少">未找到下载目录</span>
            : <span title="读不到该进程的 /proc/<pid>/io,多半是它属于另一个用户">进度读不到</span>
        ))}

        {/* 这个数字是怎么来的 —— 三种来源差别很大,不说清楚没法判断可不可信 */}
        {task.bytesSource === 'daemon' && (
          <span title="docker 的下载是守护进程做的,客户端几乎不写盘,所以读的是 dockerd 的写入量">
            按 dockerd 计
          </span>
        )}
        {task.bytesSource === 'tree' && (
          <span title="下载器自己常常不写盘,写盘的是它 fork 出来的子进程,所以按整棵进程树求和">
            按进程树计
          </span>
        )}
        {task.bytesSource === 'dir' && (
          <span title={`量的是目标目录 ${task.watchPath} 的大小 —— 和智能体在对话里报的是同一个数`}>
            目标目录 {task.watchPath}
          </span>
        )}
        {isHost && task.pid && <span>PID {task.pid}</span>}
      </div>

      {/* 服务的最后一行日志。这是整条记录里最有用的东西 ——
          服务在拉镜像时,进度和报错都只在这里;没有它,面板只能说"在启动中"。 */}
      {task.lastLog && (
        <pre className="bg-log" title={task.lastLog}>{task.lastLog}</pre>
      )}
      {/* 有字节数但没总量:明说为什么没有百分比,否则会被当成"进度条坏了" */}
      {task.progressMode === 'measured' && !task.progress?.total && !task.progressFromLog && (
        <p className="bg-note small muted">
          没有百分比:这个下载器不报总量,只能量出已下载多少。
        </p>
      )}
      {task.note && <p className="bg-note small muted">{task.note}</p>}
      {task.state === 'stalled' && (
        <p className="bg-stall small">⚠ 超过 90 秒没有新数据写入 —— 进程还在,但很可能已经连不上源了</p>
      )}
      {task.error && <p className="error-text small">{task.error}</p>}
      {err && <p className="error-text small">{err}</p>}

      {confirming && (
        <div className="bg-confirm">
          <p className="small">
            {isHost
              ? `确认停止?会向 PID ${task.pid} 发送 SIGTERM。`
              : '确认取消这个任务?'}
          </p>
          {task.command && <pre className="bg-cmd">{task.command}</pre>}
          <div className="row gap">
            <button className="btn tiny" onClick={() => setConfirming(false)}>取消</button>
            <button className="btn tiny danger" disabled={busy} onClick={doStop}>
              {busy ? '处理中…' : '确认停止'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BgTasksDrawer({ open, onClose, hostName, hostId = '', convId = '' }) {
  const [snap, setSnap] = useState({ tasks: [], warnings: [], running: 0, stalled: 0, failed: 0 });
  /* 默认只看**当前主机、正在跑**的任务。
     跑完的仍然留在后台登记表里,打开这个开关就能查到刚才那条成没成 ——
     只是不该默认占着屏幕。 */
  const [showAll, setShowAll] = useState(false);
  /* 「其他长跑进程」默认关。
     认得出的类型是一份人工列举,一定会漏 —— 所以扫描顺带把跑了 5 分钟以上、
     又不是常驻守护进程的都捞了回来。但默认摊开会淹掉真正的任务,
     所以做成开关:平时清爽,找不到东西时一键看全。 */
  const [showOther, setShowOther] = useState(false);
  const [diag, setDiag] = useState(null);

  const runDiagnose = async () => {
    setDiag('loading');
    try { setDiag(await window.api.bg.diagnose({ hostId })); }
    catch (e) { setDiag(`诊断失败:${e.message}`); }
  };

  useEffect(() => {
    if (!open) return undefined;
    window.api.bg.start({ fast: true, hostId, convId, all: showAll });
    const off = window.api.bg.onUpdate(setSnap);
    window.api.bg.snapshot({ hostId, convId, all: showAll }).then(setSnap).catch(() => {});
    /* 关面板只降回慢档,不整个停掉 —— 角标还要靠它更新。
       慢档 30 秒的通道开销可以接受,6 秒常驻就不行了。 */
    return () => { off?.(); window.api.bg.start({ fast: false, hostId, convId }); };
  }, [open, hostId, convId, showAll]);

  if (!open) return null;

  // 状态和作用域的筛选在主进程做(见 taskRegistry.snapshot),这里只管"其他长跑进程"
  const tasks = (snap.tasks || []).filter((t) => showOther || !t.longRunning);
  const nothing = tasks.length === 0 && (snap.targets || []).length === 0;
  const otherCount = (snap.tasks || []).filter((t) => t.longRunning).length;

  return (
    <>
      <div className="bg-scrim" onClick={onClose} />
      <aside className="bg-drawer">
        <div className="row gap bg-drawer-head">
          <b>后台任务</b>
          <span className="muted small">
            {snap.running ? `${snap.running} 个在跑` : '暂无进行中'}
            {snap.stalled ? ` · ${snap.stalled} 停滞` : ''}
            {snap.failed ? ` · ${snap.failed} 失败` : ''}
          </span>
          <span className="flex1" />
          {otherCount > 0 && (
            <label className="check-row inline"
              title="跑了 5 分钟以上、但不属于已知类型的进程。已排除 sshd/systemd 这类常驻守护进程">
              <input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} />
              <span className="small">其他长跑进程 {otherCount}</span>
            </label>
          )}
          <label className="check-row inline"
            title="默认只显示当前主机正在跑的(失败的也会显示)。勾上可以查看刚跑完的和其他主机的">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            <span className="small">显示全部</span>
          </label>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="bg-drawer-body">
          {/* 扫描失败必须显眼。之前它只存在主进程里,界面上
              「扫描挂了」和「确实没任务」长得一模一样 —— 查了好几轮才发现。 */}
          {(snap.errors || []).map((e) => (
            <p key={e.hostId} className="bg-warn small">
              ⚠ {hostName?.(e.hostId) || e.hostId} 扫描失败:{e.message}
            </p>
          ))}
          {(snap.warnings || []).map((w) => (
            <p key={w.hostId + w.mount} className="bg-warn small">
              💾 {hostName?.(w.hostId) || w.hostId}:{w.message}
            </p>
          ))}

          {nothing && (
            <p className="muted small pad center">
              {snap.watching
                ? `正在盯 ${snap.watching} 个目标,暂时都没有动静。`
                : '还没有可监控的目标。'}
              <br />
              监控范围来自**对话里智能体实际执行的命令** —— 它起过哪个服务、
              跑过哪个脚本、下到哪个目录,才会出现在这里。
              <br />
              (这样做是为了不把整台机器的进程都摊开:那样该看的会被淹没。)
              <br />
              <button className="btn tiny ghost" style={{ marginTop: 10 }}
                onClick={runDiagnose} disabled={diag === 'loading'}>
                {diag === 'loading' ? '诊断中…' : '诊断:看看扫描到底看见了什么'}
              </button>
            </p>
          )}
          {/* 连着几轮"面板是空的"都只能靠猜,是因为没有任何办法看见
              扫描的真实输出。有了它,一次就能分清是命令没跑、超时了、
              还是解析没认出来。 */}
          {diag && diag !== 'loading' && (
            <pre className="bg-log" style={{ maxHeight: 300 }}>
              {typeof diag === 'string' ? diag : JSON.stringify(diag, null, 1)}
            </pre>
          )}

          {/* 对话启动的目标排在最前:那才是你打开这个面板要看的东西 */}
          {(snap.targets || []).map((r) => (
            <TargetRow key={r.key} rec={r} hostName={hostName?.(r.hostId) || r.hostId} />
          ))}

          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} hostName={t.hostId ? (hostName?.(t.hostId) || t.hostId) : ''} />
          ))}
        </div>

        <p className="bg-drawer-foot muted small">
          命令与参数展示前已脱敏。「完成」是应用确认成功;「已结束(结果未知)」
          是主机进程消失但拿不到退出码。
        </p>
      </aside>
    </>
  );
}
