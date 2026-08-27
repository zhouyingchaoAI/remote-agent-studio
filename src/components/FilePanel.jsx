import React, { useState, useEffect, useCallback } from 'react';
import FilePreview from './FilePreview.jsx';

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export default function FilePanel({ hostId }) {
  /* 左栏原来写死是本机。选成另一台远程主机后就变成「远程 → 远程」,
     由主进程决定走直连还是经本机中转。 */
  const [leftHostId, setLeftHostId] = useState('local');
  const [hosts, setHosts] = useState([]);
  const leftIsLocal = leftHostId === 'local';
  const [local, setLocal] = useState({ path: '', entries: [] });
  const [remote, setRemote] = useState({ path: '', entries: [] });
  const [selLocal, setSelLocal] = useState(null);
  const [selRemote, setSelRemote] = useState(null);
  const [transfers, setTransfers] = useState([]); // {id,name,dir,transferred,total,done,error}
  const [err, setErr] = useState('');
  // Electron 不支持 window.prompt,新建文件夹用内联输入框
  const [newDirName, setNewDirName] = useState(null); // null=隐藏, ''=输入中
  const [preview, setPreview] = useState(null); // {hostId, path, name}

  useEffect(() => { window.api.hosts.list().then(setHosts).catch(() => {}); }, []);

  /* 左栏的列目录:本机走 listLocal,选了远程主机就走 listRemote。
     两个接口返回同样的形状,所以下面的渲染不用分叉。 */
  const loadLocal = useCallback(async (p) => {
    try {
      setLocal(leftIsLocal
        ? await window.api.files.listLocal(p || null)
        : await window.api.files.listRemote({ hostId: leftHostId, dirPath: p || '~' }));
      setSelLocal(null);
    } catch (e) { setErr(e.message); }
  }, [leftHostId, leftIsLocal]);
  const loadRemote = useCallback(async (p) => {
    try { setRemote(await window.api.files.listRemote({ hostId, dirPath: p || '~' })); setSelRemote(null); }
    catch (e) { setErr(e.message); }
  }, [hostId]);

  useEffect(() => { loadLocal(); loadRemote(); }, [loadLocal, loadRemote]);

  useEffect(() => window.api.files.onProgress((p) => {
    /* 远程→远程时进度带的是源主机 id,不一定等于当前页面的 hostId。
       按 transferId 认更稳 —— id 本来就是我们自己生成的。 */
    if (p.hostId !== hostId && p.hostId !== leftHostId) return;
    setTransfers((ts) => ts.map((t) => t.id === p.transferId ? {
      ...t,
      transferred: p.transferred ?? t.transferred,
      total: p.total ?? t.total,
      doneFiles: p.doneFiles ?? t.doneFiles,
      totalFiles: p.totalFiles ?? t.totalFiles,
      scanning: p.scanning ?? false,
      phase: p.phase ?? t.phase,
      relayReason: p.relayReason ?? t.relayReason,
      relayCode: p.relayCode ?? t.relayCode
    } : t));
  }), [hostId, leftHostId]);

  /** 中断:大目录/大文件传错了不用干等 */
  const cancelTransfer = async (t) => {
    await window.api.files.cancelTransfer({ transferId: t.id }).catch(() => {});
    setTransfers((ts) => ts.map((x) => x.id === t.id ? { ...x, cancelling: true } : x));
  };

  const dropTransfer = (id) => setTransfers((ts) => ts.filter((t) => t.id !== id));

  /* 配置直连:在源主机生成公钥并写进目标主机的 authorized_keys。
     这是一次真实的授权变更,所以要用户确认,不在传输失败时自动做掉。 */
  const [setupBusy, setSetupBusy] = useState('');
  const setupDirect = async (t) => {
    if (!window.confirm(
      `将在源主机生成 SSH 密钥(若无),并把它的公钥写入目标主机的 ~/.ssh/authorized_keys。\n`
      + '这等于给目标主机加了一把可免密登录的钥匙。是否继续?'
    )) return;
    setSetupBusy(t.id);
    try {
      const r = await window.api.files.setupDirect({
        fromHostId: t.fromHostId, toHostId: t.toHostId
      });
      setTransfers((ts) => ts.map((x) => x.id === t.id
        ? { ...x, setupMsg: r.message, setupOk: r.ok } : x));
    } catch (e) {
      setTransfers((ts) => ts.map((x) => x.id === t.id ? { ...x, setupMsg: e.message } : x));
    } finally { setSetupBusy(''); }
  };

  /** 直连不可用时,只有「缺密钥」是我们能一键解决的 */
  const canSetupDirect = (t) => t.relayCode === 'auth'
    && t.fromHostId && t.toHostId && t.fromHostId !== 'local' && t.toHostId !== 'local';

  const joinPath = (dir, name, sep = '/') =>
    dir.endsWith(sep) ? dir + name : dir + sep + name;
  // 远程一律 posix 分隔符,只有本机可能是 Windows 风格
  const localSep = leftIsLocal && local.path.includes('\\') ? '\\' : '/';

  /** 上传本地文件或目录到当前远程目录(点击上传/拖拽/重试共用) */
  const uploadOne = async (localPath, name, size, isDir = false) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const remotePath = joinPath(remote.path, name);
    setTransfers((ts) => [...ts, {
      id, name, dir: '↑', transferred: 0, total: size || 0, localPath, remotePath, isDir,
      fromHostId: leftHostId, toHostId: hostId
    }]);
    try {
      if (!leftIsLocal) {
        const r = await window.api.files.copyHostToHost({
          fromHostId: leftHostId, toHostId: hostId,
          srcPath: localPath, destPath: remotePath, name, transferId: id, isDir
        });
        setTransfers((ts) => ts.map((t) => t.id === id
          ? { ...t, done: true, mode: r.mode, relayReason: r.relayReason } : t));
        loadRemote(remote.path);
        return;
      }
      await window.api.files.upload({ hostId, localPath, remotePath, transferId: id, isDir });
      setTransfers((ts) => ts.map((t) => t.id === id ? { ...t, done: true } : t));
      loadRemote(remote.path);
    } catch (e) {
      const cancelled = /已取消/.test(e.message);
      setTransfers((ts) => ts.map((t) => t.id === id
        ? { ...t, error: e.message, cancelled, cancelling: false } : t));
      if (cancelled) loadRemote(remote.path); // 取消后远程可能已有部分文件
    }
  };

  const upload = async () => {
    if (!selLocal) return;
    await uploadOne(
      joinPath(local.path, selLocal.name, localSep),
      selLocal.name, selLocal.size, !!selLocal.isDir
    );
  };

  /** 失败重试:复用记录中的路径重新上传/下载 */
  const retryTransfer = async (t) => {
    setTransfers((ts) => ts.map((x) => x.id === t.id
      ? { ...x, error: null, cancelled: false, cancelling: false, transferred: 0, doneFiles: 0 } : x));
    try {
      const args = { hostId, transferId: t.id, isDir: t.isDir };
      if (t.dir === '↑') await window.api.files.upload({ ...args, localPath: t.localPath, remotePath: t.remotePath });
      else await window.api.files.download({ ...args, remotePath: t.remotePath, localPath: t.localPath });
      setTransfers((ts) => ts.map((x) => x.id === t.id ? { ...x, done: true } : x));
      if (t.dir === '↑') loadRemote(remote.path); else loadLocal(local.path);
    } catch (e) {
      setTransfers((ts) => ts.map((x) => x.id === t.id ? { ...x, error: e.message } : x));
    }
  };

  /** 从系统拖文件到远程栏 -> 直接上传 */
  const [dropActive, setDropActive] = useState(false);
  const onRemoteDrop = (event) => {
    event.preventDefault();
    setDropActive(false);
    for (const file of [...event.dataTransfer.files]) {
      const p = window.api.dialog.pathForDroppedFile(file);
      if (p) uploadOne(p, file.name, file.size);
    }
  };

  const download = async () => {
    if (!selRemote) return;
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const isDir = !!selRemote.isDir;
    const remotePath = joinPath(remote.path, selRemote.name);
    const localPath = joinPath(local.path, selRemote.name, localSep);
    setTransfers((ts) => [...ts, {
      id, name: selRemote.name, dir: '↓', transferred: 0,
      total: selRemote.size || 0, localPath, remotePath, isDir,
      fromHostId: hostId, toHostId: leftHostId
    }]);
    try {
      if (!leftIsLocal) {
        const r = await window.api.files.copyHostToHost({
          fromHostId: hostId, toHostId: leftHostId,
          srcPath: remotePath, destPath: localPath, name: selRemote.name, transferId: id, isDir
        });
        setTransfers((ts) => ts.map((t) => t.id === id
          ? { ...t, done: true, mode: r.mode, relayReason: r.relayReason } : t));
      } else {
        await window.api.files.download({ hostId, remotePath, localPath, transferId: id, isDir });
        setTransfers((ts) => ts.map((t) => t.id === id ? { ...t, done: true } : t));
      }
      loadLocal(local.path);
    } catch (e) {
      const cancelled = /已取消/.test(e.message);
      setTransfers((ts) => ts.map((t) => t.id === id
        ? { ...t, error: e.message, cancelled, cancelling: false } : t));
      loadLocal(local.path);
    }
  };

  const removeRemote = async () => {
    if (!selRemote) return;
    if (!confirm(`删除远程 ${selRemote.name}?`)) return;
    await window.api.files.deleteRemote({
      hostId, remotePath: joinPath(remote.path, selRemote.name), isDir: selRemote.isDir
    });
    loadRemote(remote.path);
  };

  const mkdir = async () => {
    const name = (newDirName || '').trim();
    setNewDirName(null);
    if (!name || name.includes('/') || name.includes('\\')) return;
    await window.api.files.mkdirRemote({ hostId, remotePath: joinPath(remote.path, name) });
    loadRemote(remote.path);
  };

  const parentOf = (p, sep = '/') => {
    const parts = p.split(sep).filter(Boolean);
    parts.pop();
    return sep === '/' ? '/' + parts.join('/') : parts.join(sep) || p;
  };

  return (
    <div className="file-panel">
      <div className="file-panes">
        <Pane
          title={
            <span className="pane-title-row">
              <select className="pane-host-select" value={leftHostId}
                onChange={(e) => { setLeftHostId(e.target.value); setSelLocal(null); }}
                title="选另一台远程主机即可远程→远程传输">
                <option value="local">本机</option>
                {hosts.filter((h) => h.id !== hostId).map((h) => (
                  <option key={h.id} value={h.id}>{h.name || h.host}</option>
                ))}
              </select>
              <span className="muted small">{local.path}</span>
            </span>
          }
          data={local} sel={selLocal}
          onUp={() => loadLocal(parentOf(local.path, localSep))}
          onOpen={(e) => e.isDir
            ? loadLocal(joinPath(local.path, e.name, localSep))
            : setPreview({ hostId: 'local', path: joinPath(local.path, e.name, localSep), name: e.name })}
          onSelect={setSelLocal} />
        <div className="file-actions">
          <button className="btn" title="上传(支持整个文件夹)" onClick={upload} disabled={!selLocal}>→</button>
          <button className="btn" title="下载(支持整个文件夹)" onClick={download} disabled={!selRemote}>←</button>
          <button className="btn" title="远程新建文件夹" onClick={() => setNewDirName('')}>📁+</button>
          <button className="btn danger" title="删除远程" onClick={removeRemote} disabled={!selRemote}>🗑</button>
        </div>
        <div className={`remote-pane-drop ${dropActive ? 'drop-active' : ''}`}
          onDragEnter={(e) => { e.preventDefault(); setDropActive(true); }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropActive(false); }}
          onDrop={onRemoteDrop}>
          <Pane title={`远程 ${remote.path}${dropActive ? ' — 松开上传' : ''}`} data={remote} sel={selRemote}
            onUp={() => loadRemote(parentOf(remote.path))}
            onOpen={(e) => (e.isDir || e.isLink)
              ? loadRemote(joinPath(remote.path, e.name))
              : setPreview({ hostId, path: joinPath(remote.path, e.name), name: e.name })}
            onSelect={setSelRemote} />
        </div>
      </div>
      {preview && (
        <FilePreview hostId={preview.hostId} filePath={preview.path} name={preview.name}
          onClose={() => setPreview(null)} />
      )}
      {newDirName !== null && (
        <div className="transfer-list">
          <div className="transfer-item">
            <span>新建远程文件夹:</span>
            <input value={newDirName} autoFocus
              onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') mkdir();
                if (e.key === 'Escape') setNewDirName(null);
              }} />
            <button className="btn" onClick={mkdir}>创建</button>
            <button className="btn" onClick={() => setNewDirName(null)}>取消</button>
          </div>
        </div>
      )}
      {err && <p className="error-text">{err}</p>}
      {transfers.length > 0 && (
        <div className="transfer-list">
          {transfers.slice(-5).map((t) => (
            <div key={t.id} className="transfer-item">
              <span>{t.dir} {t.isDir ? '📁 ' : ''}{t.name}</span>
              {t.error ? (
                <>
                  <span className={t.cancelled ? 'muted' : 'error-text'}>
                    {t.cancelled ? '已取消' : t.error}
                  </span>
                  <button className="btn small" onClick={() => retryTransfer(t)}>重试</button>
                  <button className="btn small ghost" onClick={() => dropTransfer(t.id)}>移除</button>
                </>
              ) : t.done ? (
                <>
                  {/* 直连和中转的代价差很多,做完告诉用户走的哪条 */}
                  <span className="ok">
                    完成{t.mode === 'direct' ? '(源主机直连)' : t.mode === 'relay' ? '(经本机中转)' : ''}
                  </span>
                  {t.relayReason && (
                    <span className="muted small" title="下次想走直连就解决这个">
                      直连不可用:{t.relayReason}
                    </span>
                  )}
                  {canSetupDirect(t) && (
                    <button className="btn tiny" disabled={setupBusy === t.id}
                      onClick={() => setupDirect(t)}>
                      {setupBusy === t.id ? '配置中…' : '配置直连'}
                    </button>
                  )}
                  {t.setupMsg && (
                    <span className={t.setupOk ? 'ok small' : 'error-text small'}>{t.setupMsg}</span>
                  )}
                  <button className="btn small ghost" onClick={() => dropTransfer(t.id)}>移除</button>
                </>
              ) : t.phase === 'probe' ? (
                <>
                  <span className="muted small">正在探测源主机能否直连目标…</span>
                  <button className="btn small ghost" onClick={() => cancelTransfer(t)}>取消</button>
                </>
              ) : t.phase === 'direct' ? (
                <>
                  <span className="muted small">源主机直连传输中(数据不经过本机)…</span>
                  <button className="btn small ghost" onClick={() => cancelTransfer(t)}>取消</button>
                </>
              ) : t.scanning ? (
                <>
                  <span className="muted small">正在统计目录…</span>
                  <button className="btn small ghost" onClick={() => cancelTransfer(t)}>取消</button>
                </>
              ) : (
                <>
                  {/* 中转是两段,不标出来的话进度条会先冲到 100 再跳回 0 */}
                  {t.phase === 'download' && <span className="muted small">中转 1/2 下载</span>}
                  {t.phase === 'upload' && <span className="muted small">中转 2/2 上传</span>}
                  {/* 传 1.8G 时用户正盯着进度条,该在这时候就说清为什么没走直连 */}
                  {t.relayReason && (
                    <span className="muted small" title="解决之后就能走直连,数据不必经过本机">
                      直连不可用:{t.relayReason}
                    </span>
                  )}
                  {canSetupDirect(t) && (
                    <button className="btn tiny" disabled={setupBusy === t.id}
                      onClick={() => setupDirect(t)}
                      title="在源主机生成密钥并写入目标主机的 authorized_keys">
                      {setupBusy === t.id ? '配置中…' : '配置直连'}
                    </button>
                  )}
                  {t.setupMsg && (
                    <span className={t.setupOk ? 'ok small' : 'error-text small'}>{t.setupMsg}</span>
                  )}
                  <progress value={t.transferred} max={t.total || 1} />
                  <button className="btn small ghost" disabled={t.cancelling}
                    onClick={() => cancelTransfer(t)}>{t.cancelling ? '取消中…' : '取消'}</button>
                </>
              )}
              <span className="muted small">
                {fmtSize(t.transferred)} / {fmtSize(t.total)}
                {t.totalFiles > 1 && ` · ${t.doneFiles || 0}/${t.totalFiles} 个文件`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Pane({ title, data, sel, onUp, onOpen, onSelect }) {
  return (
    <div className="pane">
      <div className="pane-title" title={title}>{title}</div>
      <div className="pane-list">
        <div className="file-row" onDoubleClick={onUp}>📁 ..</div>
        {data.entries.map((e) => (
          <div key={e.name}
            className={`file-row ${sel?.name === e.name ? 'selected' : ''}`}
            onClick={() => onSelect(e)}
            onDoubleClick={() => onOpen(e)}>
            <span className="fname">{e.isDir ? '📁' : e.isLink ? '🔗' : '📄'} {e.name}</span>
            <span className="muted small">{e.isDir ? '' : fmtSize(e.size)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
