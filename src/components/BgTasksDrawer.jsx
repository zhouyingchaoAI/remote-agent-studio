import React, { useEffect, useState } from 'react';

/**
 * 后台下载任务抽屉。
 *
 * 智能体在对话里起的 docker pull / wget / pip install 会随着对话往下滚
 * 而消失在视野里,等你想起来看,要么早完了,要么卡了半小时没人知道。
 *
 * 这个面板刻意**不追求百分比**。多数下载器不把总量告诉外人,硬凑一个百分比
 * 就是编数字。真正值钱的是三样:在跑没跑、速率、有没有停滞。
 */

function fmtBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/**
 * 顶栏角标。
 *
 * 这个东西存在的理由:面板不打开时也得让人知道"有东西在下" —— 人恰恰是
 * 想不起来看的时候才最需要它。所以后台保持一个 30 秒的慢档轮询,
 * 面板打开时才切到 6 秒的快档(见主进程 bg:start 的 fast 参数)。
 *
 * 没有任务时整个角标隐藏,不留一个常驻的 0。
 */
export function BgTasksBadge({ onClick }) {
  const [snap, setSnap] = useState({ running: 0, stalled: 0 });

  useEffect(() => {
    window.api.bg.start({ fast: false });
    const off = window.api.bg.onUpdate((s) => setSnap(s));
    window.api.bg.snapshot().then(setSnap).catch(() => {});
    return () => off?.();
  }, []);

  if (!snap.running) return null;
  return (
    <button className={`bg-badge${snap.stalled ? ' warn' : ''}`} onClick={onClick}
      title={snap.stalled ? `${snap.running} 个后台任务,其中 ${snap.stalled} 个已停滞` : `${snap.running} 个后台任务在跑`}>
      {snap.stalled ? '⚠' : '⬇'} {snap.running}
    </button>
  );
}

function TaskRow({ hostId, task, onStopped }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const stop = async () => {
    setBusy(true);
    try {
      await window.api.bg.stopTask({ hostId, pid: task.pid });
      onStopped?.();
    } finally { setBusy(false); setConfirming(false); }
  };

  return (
    <div className={`bg-task${task.stalled ? ' stalled' : ''}`}>
      <div className="row gap bg-task-head">
        <span className="bg-kind">{task.label}</span>
        <span className="bg-title" title={task.command}>{task.title}</span>
        <span className="flex1" />
        {!confirming && (
          <button className="btn tiny ghost" onClick={() => setConfirming(true)}>停止</button>
        )}
      </div>

      <div className="row gap bg-task-meta small muted">
        <span>已运行 {fmtDur(task.elapsedSec)}</span>
        {task.progress === 'measured' ? (
          <>
            <span>已写入 {fmtBytes(task.bytes)}</span>
            <span>{task.bytesPerSec == null ? '测速中…' : `${fmtBytes(task.bytesPerSec)}/s`}</span>
          </>
        ) : (
          /* 读不到 /proc/<pid>/io(不同用户或内核没开)。
             这里必须说"读不到",不能显示成 0 B/s —— 那会被看成卡住了。 */
          <span title="读不到该进程的 /proc/<pid>/io,多半是它属于另一个用户">进度读不到</span>
        )}
        {task.bytesSource === 'daemon' && (
          <span title="docker pull 的下载是守护进程做的,客户端进程几乎不写盘,所以这里读的是 dockerd 的写入量">
            按 dockerd 计
          </span>
        )}
        <span>PID {task.pid}</span>
      </div>

      {task.stalled && (
        <p className="bg-stall small">
          ⚠ 超过 90 秒没有新数据写入 —— 进程还在,但很可能已经连不上源了
        </p>
      )}

      {confirming && (
        <div className="bg-confirm">
          <p className="small">确认停止?会向 PID {task.pid} 发送 SIGTERM。</p>
          <pre className="bg-cmd">{task.command}</pre>
          <div className="row gap">
            <button className="btn tiny" onClick={() => setConfirming(false)}>取消</button>
            <button className="btn tiny danger" disabled={busy} onClick={stop}>
              {busy ? '停止中…' : '确认停止'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BgTasksDrawer({ open, onClose, hostName }) {
  const [snap, setSnap] = useState({ hosts: [], running: 0, stalled: 0 });

  /* 只在抽屉打开时轮询。每次扫描占一条 SSH 通道,常驻轮询会在用户毫无察觉的
     情况下把远端 sshd 的 MaxSessions 吃光 —— 表现是"新对话打不开",极难联想到这里。 */
  useEffect(() => {
    if (!open) return undefined;
    window.api.bg.start({ fast: true });
    const off = window.api.bg.onUpdate((s) => setSnap(s));
    /* 关面板只降回慢档,不整个停掉 —— 角标还要靠它更新。
       慢档 30 秒一次的通道开销可以接受,6 秒一次常驻就不行了。 */
    return () => { off?.(); window.api.bg.start({ fast: false }); };
  }, [open]);

  if (!open) return null;

  const hosts = (snap.hosts || []).filter((h) => (h.tasks || []).length || h.warning || h.error);

  return (
    <>
      <div className="bg-scrim" onClick={onClose} />
      <aside className="bg-drawer">
        <div className="row gap bg-drawer-head">
          <b>后台任务</b>
          <span className="muted small">
            {snap.running ? `${snap.running} 个在跑` : '暂无'}
            {snap.stalled ? ` · ${snap.stalled} 个停滞` : ''}
          </span>
          <span className="flex1" />
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="bg-drawer-body">
          {hosts.length === 0 && (
            <p className="muted small pad center">
              没有检测到正在跑的下载或安装任务。
              <br />
              扫的是已连接主机上的进程,所以智能体起的和你自己在终端敲的都会出现在这里。
            </p>
          )}

          {hosts.map((h) => (
            <div key={h.hostId} className="bg-host">
              <div className="bg-host-name small">{hostName?.(h.hostId) || h.hostId}</div>

              {h.warning && (
                <p className="bg-warn small">💾 {h.warning.message}</p>
              )}
              {h.error && (
                /* 扫不动时保留上一次的列表,只是标出来 —— 主机抖一下就清空列表,
                   会让人误以为任务都跑完了 */
                <p className="bg-warn small">扫描失败({h.error}),下面是上一次的结果</p>
              )}

              {(h.tasks || []).map((t) => (
                <TaskRow key={t.pid} hostId={h.hostId} task={t}
                  onStopped={() => window.api.bg.snapshot().then(setSnap)} />
              ))}
            </div>
          ))}
        </div>

        <p className="bg-drawer-foot muted small">
          命令行展示前已脱敏(key/token 换成 ***)。关掉此面板即停止轮询。
        </p>
      </aside>
    </>
  );
}
