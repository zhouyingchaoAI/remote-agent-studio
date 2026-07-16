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
  const [local, setLocal] = useState({ path: '', entries: [] });
  const [remote, setRemote] = useState({ path: '', entries: [] });
  const [selLocal, setSelLocal] = useState(null);
  const [selRemote, setSelRemote] = useState(null);
  const [transfers, setTransfers] = useState([]); // {id,name,dir,transferred,total,done,error}
  const [err, setErr] = useState('');
  // Electron 不支持 window.prompt,新建文件夹用内联输入框
  const [newDirName, setNewDirName] = useState(null); // null=隐藏, ''=输入中
  const [preview, setPreview] = useState(null); // {hostId, path, name}

  const loadLocal = useCallback(async (p) => {
    try { setLocal(await window.api.files.listLocal(p || null)); setSelLocal(null); }
    catch (e) { setErr(e.message); }
  }, []);
  const loadRemote = useCallback(async (p) => {
    try { setRemote(await window.api.files.listRemote({ hostId, dirPath: p || '~' })); setSelRemote(null); }
    catch (e) { setErr(e.message); }
  }, [hostId]);

  useEffect(() => { loadLocal(); loadRemote(); }, [loadLocal, loadRemote]);

  useEffect(() => window.api.files.onProgress(({ hostId: progressHostId, transferId, transferred, total }) => {
    if (progressHostId !== hostId) return;
    setTransfers((ts) => ts.map((t) => t.id === transferId ? { ...t, transferred, total } : t));
  }), [hostId]);

  const joinPath = (dir, name, sep = '/') =>
    dir.endsWith(sep) ? dir + name : dir + sep + name;
  const localSep = local.path.includes('\\') ? '\\' : '/';

  /** 上传单个本地文件到当前远程目录(点击上传/拖拽/重试共用) */
  const uploadOne = async (localPath, name, size) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const remotePath = joinPath(remote.path, name);
    setTransfers((ts) => [...ts, { id, name, dir: '↑', transferred: 0, total: size, localPath, remotePath }]);
    try {
      await window.api.files.upload({ hostId, localPath, remotePath, transferId: id });
      setTransfers((ts) => ts.map((t) => t.id === id ? { ...t, done: true } : t));
      loadRemote(remote.path);
    } catch (e) {
      setTransfers((ts) => ts.map((t) => t.id === id ? { ...t, error: e.message } : t));
    }
  };

  const upload = async () => {
    if (!selLocal || selLocal.isDir) return;
    await uploadOne(joinPath(local.path, selLocal.name, localSep), selLocal.name, selLocal.size);
  };

  /** 失败重试:复用记录中的路径重新上传/下载 */
  const retryTransfer = async (t) => {
    setTransfers((ts) => ts.map((x) => x.id === t.id ? { ...x, error: null, transferred: 0 } : x));
    try {
      if (t.dir === '↑') await window.api.files.upload({ hostId, localPath: t.localPath, remotePath: t.remotePath, transferId: t.id });
      else await window.api.files.download({ hostId, remotePath: t.remotePath, localPath: t.localPath, transferId: t.id });
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
    if (!selRemote || selRemote.isDir) return;
    const id = `t_${Date.now()}`;
    const remotePath = joinPath(remote.path, selRemote.name);
    const localPath = joinPath(local.path, selRemote.name, localSep);
    setTransfers((ts) => [...ts, { id, name: selRemote.name, dir: '↓', transferred: 0, total: selRemote.size, localPath, remotePath }]);
    try {
      await window.api.files.download({ hostId, remotePath, localPath, transferId: id });
      setTransfers((ts) => ts.map((t) => t.id === id ? { ...t, done: true } : t));
      loadLocal(local.path);
    } catch (e) {
      setTransfers((ts) => ts.map((t) => t.id === id ? { ...t, error: e.message } : t));
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
        <Pane title={`本机 ${local.path}`} data={local} sel={selLocal}
          onUp={() => loadLocal(parentOf(local.path, localSep))}
          onOpen={(e) => e.isDir
            ? loadLocal(joinPath(local.path, e.name, localSep))
            : setPreview({ hostId: 'local', path: joinPath(local.path, e.name, localSep), name: e.name })}
          onSelect={setSelLocal} />
        <div className="file-actions">
          <button className="btn" title="上传" onClick={upload} disabled={!selLocal || selLocal.isDir}>→</button>
          <button className="btn" title="下载" onClick={download} disabled={!selRemote || selRemote.isDir}>←</button>
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
              <span>{t.dir} {t.name}</span>
              {t.error ? (
                <>
                  <span className="error-text">{t.error}</span>
                  <button className="btn small" onClick={() => retryTransfer(t)}>重试</button>
                </>
              ) : t.done ? <span className="ok">完成</span>
                : <progress value={t.transferred} max={t.total || 1} />}
              <span className="muted small">{fmtSize(t.transferred)} / {fmtSize(t.total)}</span>
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
