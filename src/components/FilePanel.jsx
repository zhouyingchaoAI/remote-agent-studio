import React, { useState, useEffect, useCallback } from 'react';
import FilePreview from './FilePreview.jsx';
import { useStore } from '../store.js';
import { translate as tr } from '../i18n.mjs';

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export default function FilePanel({ hostId }) {
  const language = useStore((s) => s.settings.language);
  const transferMap = useStore((s) => s.transfers);
  const transfers = Object.values(transferMap).filter((transfer) => transfer.hostId === hostId);
  const createTransfer = useStore((s) => s.createTransfer);
  const finishTransfer = useStore((s) => s.finishTransfer);
  const t = (key) => tr(language, key);
  const [local, setLocal] = useState({ path: '', entries: [] });
  const [remote, setRemote] = useState({ path: '', entries: [] });
  const [selLocal, setSelLocal] = useState(null);
  const [selRemote, setSelRemote] = useState(null);
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

  const joinPath = (dir, name, sep = '/') =>
    dir.endsWith(sep) ? dir + name : dir + sep + name;
  const localSep = local.path.includes('\\') ? '\\' : '/';

  /** 上传单个本地文件到当前远程目录(点击上传/拖拽/重试共用) */
  const uploadOne = async (localPath, name, size) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const remotePath = joinPath(remote.path, name);
    createTransfer({ id, hostId, name, dir: '↑', transferred: 0, total: size, localPath, remotePath });
    try {
      await window.api.files.upload({ hostId, localPath, remotePath, transferId: id });
      finishTransfer(id, { done: true });
      loadRemote(remote.path);
    } catch (e) {
      finishTransfer(id, { error: e.message });
    }
  };

  const upload = async () => {
    if (!selLocal) return;
    if (selLocal.isDir) {
      const localPath = joinPath(local.path, selLocal.name, localSep);
      const remotePath = joinPath(remote.path, selLocal.name);
      const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      createTransfer({ id, hostId, name: selLocal.name, dir: '↑', kind: 'directory', transferred: 0, total: 0, localPath, remotePath });
      try {
        const result = await window.api.files.uploadDirectory({ hostId, localPath, remotePath, transferId: id });
        finishTransfer(id, { done: true, skippedSymlinks: result.skippedSymlinks });
        loadRemote(remote.path);
      } catch (e) {
        finishTransfer(id, { error: e.message });
      }
      return;
    }
    await uploadOne(joinPath(local.path, selLocal.name, localSep), selLocal.name, selLocal.size);
  };

  /** 失败重试:复用记录中的路径重新上传/下载 */
  const retryTransfer = async (t) => {
    finishTransfer(t.id, { error: null, cancelled: false, done: false, transferred: 0 });
    try {
      if (t.dir === '↑' && t.kind === 'directory') await window.api.files.uploadDirectory({ hostId, localPath: t.localPath, remotePath: t.remotePath, transferId: t.id });
      else if (t.dir === '↑') await window.api.files.upload({ hostId, localPath: t.localPath, remotePath: t.remotePath, transferId: t.id, resume: true });
      else if (t.kind === 'directory') await window.api.files.downloadDirectory({ hostId, remotePath: t.remotePath, localPath: t.localPath, transferId: t.id });
      else await window.api.files.download({ hostId, remotePath: t.remotePath, localPath: t.localPath, transferId: t.id, resume: true });
      finishTransfer(t.id, { done: true });
      if (t.dir === '↑') loadRemote(remote.path); else loadLocal(local.path);
    } catch (e) {
      finishTransfer(t.id, { error: e.message });
    }
  };

  const cancelTransfer = async (t) => {
    const cancelled = await window.api.files.cancelTransfer({ hostId, transferId: t.id });
    if (cancelled) finishTransfer(t.id, { cancelled: true });
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
    if (selRemote.isDir) {
      const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const remotePath = joinPath(remote.path, selRemote.name);
      const localPath = joinPath(local.path, selRemote.name, localSep);
      createTransfer({ id, hostId, name: selRemote.name, dir: '↓', kind: 'directory', transferred: 0, total: 0, localPath, remotePath });
      try {
        const result = await window.api.files.downloadDirectory({ hostId, remotePath, localPath, transferId: id });
        finishTransfer(id, { done: true, skippedSymlinks: result.skippedSymlinks });
        loadLocal(local.path);
      } catch (e) {
        finishTransfer(id, { error: e.message });
      }
      return;
    }
    const id = `t_${Date.now()}`;
    const remotePath = joinPath(remote.path, selRemote.name);
    const localPath = joinPath(local.path, selRemote.name, localSep);
    createTransfer({ id, hostId, name: selRemote.name, dir: '↓', transferred: 0, total: selRemote.size, localPath, remotePath });
    try {
      await window.api.files.download({ hostId, remotePath, localPath, transferId: id });
      finishTransfer(id, { done: true });
      loadLocal(local.path);
    } catch (e) {
      finishTransfer(id, { error: e.message });
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
          <button className="btn" title={t('upload')} onClick={upload} disabled={!selLocal}>→</button>
          <button className="btn" title={t('download')} onClick={download} disabled={!selRemote}>←</button>
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
          {transfers.slice(-5).map((transfer) => (
            <div key={transfer.id} className="transfer-item">
              <span>{transfer.dir} {transfer.name}</span>
              {transfer.error ? (
                <>
                  <span className="error-text">{transfer.error}</span>
                  <button className="btn small" onClick={() => retryTransfer(transfer)}>{t('retry')}</button>
                </>
              ) : transfer.cancelled ? <span className="muted">{t('cancelled')}</span>
                : transfer.done ? <span className="ok">{t('completed')}</span>
                : <progress value={transfer.transferred} max={transfer.total || 1} />}
              <span className="muted small">{fmtSize(transfer.transferred)} / {fmtSize(transfer.total)}</span>
              {transfer.skippedSymlinks > 0 && <span className="muted small">已跳过 {transfer.skippedSymlinks} 个链接</span>}
              {!transfer.done && !transfer.error && !transfer.cancelled && <button className="btn small ghost" onClick={() => cancelTransfer(transfer)}>{t('cancel')}</button>}
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
