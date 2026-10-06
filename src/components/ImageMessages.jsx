import { useState, useEffect } from 'react';
import { fileKind } from '../fileKind.js';

/**
 * 已解析图片的进程内缓存。
 *
 * 原来每次挂载都重新走一遍 IPC —— 而一次解析要在远端 stat、读完整文件、
 * 再 base64 传回来。切对话、分屏、滚动窗口滑动,任何一次重挂载都会让
 * 旧图重新转圈。放在模块作用域而不是组件里,正是为了让它**跨挂载存活**。
 *
 * 不做失效:同一路径的内容变了,主进程那边的缓存键带着 mtime+size,
 * 会返回新的 payload,这里跟着更新即可。
 */
const imageMemo = new Map();

const IMAGE_MEMO_MAX = 32;

function ImagePreview({ hostId, convId, remotePath, name, compact = false }) {
  const memoKey = `${hostId}|${convId}|${remotePath}`;
  // 有缓存就直接拿来当初始值 —— 连一帧"加载中"都不闪
  const [image, setImage] = useState(() => imageMemo.get(memoKey) || null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const cached = imageMemo.get(memoKey);
    /* **有缓存就不清空。** 原来无条件 setImage(null),
       于是每次重挂载都会先闪一下"图片加载中…"。
       重试(attempt 变化)时才该真的重来一遍。 */
    if (!cached) setImage(null);
    setError('');
    window.api.attachments.resolveImage({ hostId, convId, remotePath })
      .then((result) => {
        imageMemo.set(memoKey, result);
        if (imageMemo.size > IMAGE_MEMO_MAX) imageMemo.delete(imageMemo.keys().next().value);
        if (active) setImage(result);
      })
      .catch((reason) => {
        // 已经有图在显示时,后台校验失败不该把它换成报错
        if (active && !imageMemo.get(memoKey)) setError(reason.message);
      });
    return () => { active = false; };
  }, [hostId, convId, remotePath, memoKey, attempt]);

  if (error) return (
    <div className="image-error">
      <span>{name || '图片'} 加载失败</span>
      <button className="btn small" onClick={() => setAttempt((value) => value + 1)}>重试</button>
    </div>
  );
  if (!image) return <div className="image-loading">图片加载中...</div>;
  const label = name || image.name;
  return (
    <>
      <div className="image-block">
        <button className={`image-preview ${compact ? 'compact' : ''}`} onClick={() => setOpen(true)} title="查看大图">
          <img src={image.src} alt={label} />
          <span>{label}</span>
        </button>
        {/* 悬停才出现,免得挡住图 */}
        <div className="image-tools">
          <ImageActions image={image} name={label} />
        </div>
      </div>
      {open && (
        <div className="image-lightbox" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <button className="lightbox-close" title="关闭" onClick={() => setOpen(false)}>×</button>
          <img src={image.src} alt={label} onClick={(e) => e.stopPropagation()} />
          <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
            <span>{label}</span>
            <ImageActions image={image} name={label} />
          </div>
        </div>
      )}
    </>
  );
}

/** 图片操作:复制到剪贴板 / 另存为。两处(缩略图与大图)共用 */
function ImageActions({ image, name }) {
  const [hint, setHint] = useState('');
  const flash = (t) => { setHint(t); setTimeout(() => setHint(''), 1500); };

  const copy = async (e) => {
    e.stopPropagation();
    try { await window.api.clipboard.writeImage(image.src); flash('已复制'); }
    catch (err) { flash(`失败:${err.message}`); }
  };
  const saveAs = async (e) => {
    e.stopPropagation();
    try {
      const r = await window.api.clipboard.saveImageAs({ dataUrl: image.src, name });
      if (r?.saved) flash('已保存');
    } catch (err) { flash(`失败:${err.message}`); }
  };

  return (
    <>
      <button className="btn tiny ghost" onClick={copy} title="复制图片,可直接粘贴到别处">复制</button>
      <button className="btn tiny ghost" onClick={saveAs} title="另存为文件">保存</button>
      {hint && <span className="muted small">{hint}</span>}
    </>
  );
}

/**
 * 非图片产物(docx/pdf/xlsx/zip…)的下载入口。
 *
 * 这类文件以前根本到不了界面:产物扫描只认图片扩展名,
 * 模型写的那句「下载 xxx」只是纯文本,点了当然没反应。
 */
function ArtifactFile({ hostId, remotePath, name }) {
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind = fileKind(name);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await window.api.artifacts.saveAs({ hostId, remotePath, name });
      if (!r.canceled) setSaved(r.localPath);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="artifact-card" title={remotePath}>
      <span className="artifact-badge" style={{ background: kind.color }}>{kind.letter}</span>
      <div className="artifact-body">
        <div className="artifact-title">{name}</div>
        <div className="artifact-sub">
          {error
            ? <span className="error-text">{error}</span>
            : saved ? `已保存到 ${saved}` : `${kind.label} · ${kind.ext}`}
        </div>
      </div>
      {saved
        ? <button className="btn small ghost"
          onClick={() => window.api.artifacts.reveal({ localPath: saved })}>在文件夹中显示</button>
        : <button className="btn small" disabled={busy} onClick={save}>
          {busy ? '保存中…' : '保存'}
        </button>}
    </div>
  );
}

export { imageMemo, IMAGE_MEMO_MAX, ImagePreview, ImageActions, ArtifactFile };
