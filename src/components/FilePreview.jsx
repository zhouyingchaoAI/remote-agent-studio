import React, { useState, useEffect } from 'react';
import Markdown from './Markdown.jsx';

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

/** 文件内容预览弹层:文本 / 图片 / 二进制提示 */
export default function FilePreview({ hostId, filePath, name, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const isMarkdown = /\.(md|markdown)$/i.test(name || filePath || '');
  const [reading, setReading] = useState(true); // md 文件默认阅读模式

  useEffect(() => {
    let active = true;
    setData(null); setErr('');
    window.api.files.readFile({ hostId, filePath })
      .then((r) => { if (active) setData(r); })
      .catch((e) => { if (active) setErr(e.message); });
    return () => { active = false; };
  }, [hostId, filePath]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="file-preview-overlay" onClick={onClose}>
      <div className="file-preview" onClick={(e) => e.stopPropagation()}>
        <div className="file-preview-head">
          <b>{name || data?.name || '文件'}</b>
          <span className="muted small file-preview-path" title={data?.path || filePath}>{data?.path || filePath}</span>
          {data && <span className="muted small">{fmtSize(data.size)}</span>}
          {isMarkdown && data?.kind === 'text' && (
            <button className="btn small ghost" onClick={() => setReading(!reading)}>
              {reading ? '查看原文' : '阅读模式'}
            </button>
          )}
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>✕</button>
        </div>
        <div className="file-preview-body">
          {err && <p className="error-text pad">{err}</p>}
          {!err && !data && <p className="muted pad">加载中...</p>}
          {data?.kind === 'image' && <img className="file-preview-image" src={data.src} alt={data.name} />}
          {data?.kind === 'binary' && <p className="muted pad">二进制文件,不支持预览。可到「文件」页下载到本机查看。</p>}
          {data?.kind === 'text' && (
            <>
              {data.truncated && <p className="muted small pad">文件较大,仅显示前 512 KB</p>}
              {isMarkdown && reading
                ? <div className="file-preview-md"><Markdown text={data.content} /></div>
                : <pre className="file-preview-text">{data.content}</pre>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
