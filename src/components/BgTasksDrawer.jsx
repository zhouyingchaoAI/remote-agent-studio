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
function ProgressBar({ p }) {
  if (!p || !p.total || !(p.total > 0)) return null;
  const pct = Math.min(100, Math.round(((p.transferred || 0) / p.total) * 100));
  return (
    <div className="bg-bar" title={`${fmtBytes(p.transferred)} / ${fmtBytes(p.total)}`}>
      <div className="bg-bar-fill" style={{ width: `${pct}%` }} />
      <span className="bg-bar-text">{pct}%</span>
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

      <ProgressBar p={task.progress} />

      <div className="row gap bg-task-meta small muted">
        {hostName && <span>{hostName}</span>}
        <span>{task.state === 'running' || task.state === 'stalled' ? '已运行' : '耗时'} {fmtDur(task.elapsedMs)}</span>

        {task.activeState && <span title="systemd 的 ActiveState/SubState">{task.activeState}/{task.subState}</span>}

        {isHost && task.kind !== 'systemd' && (task.progressMode === 'measured' ? (
          <>
            <span>已写入 {fmtBytes(task.bytes)}</span>
            <span>{task.bytesPerSec == null ? '测速中…' : `${fmtBytes(task.bytesPerSec)}/s`}</span>
          </>
        ) : task.state !== 'ended' && (
          /* 读不到 /proc/<pid>/io。必须说"读不到"而不是显示 0 B/s ——
             后者会被看成卡住了,让人去查一个不存在的问题。 */
          <span title="读不到该进程的 /proc/<pid>/io,多半是它属于另一个用户">进度读不到</span>
        ))}

        {task.bytesSource === 'daemon' && (
          <span title="docker pull 的下载是守护进程做的,客户端几乎不写盘,所以这里读的是 dockerd 的写入量">
            按 dockerd 计
          </span>
        )}
        {isHost && task.pid && <span>PID {task.pid}</span>}
      </div>

      {/* 服务的最后一行日志。这是整条记录里最有用的东西 ——
          服务在拉镜像时,进度和报错都只在这里;没有它,面板只能说"在启动中"。 */}
      {task.lastLog && (
        <pre className="bg-log" title={task.lastLog}>{task.lastLog}</pre>
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
          {(snap.warnings || []).map((w) => (
            <p key={w.hostId + w.mount} className="bg-warn small">
              💾 {hostName?.(w.hostId) || w.hostId}:{w.message}
            </p>
          ))}

          {tasks.length === 0 && (
            <p className="muted small pad center">
              这台主机上没有正在跑的后台任务。
              <br />
              勾选「显示全部」可以查看刚跑完的、以及其他主机上的。
            </p>
          )}

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
