import React from 'react';
import { useStore } from '../store.js';
import { translate as tr } from '../i18n.mjs';

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export default function TransferPanel({ hostId }) {
  const language = useStore((s) => s.settings.language);
  const transferMap = useStore((s) => s.transfers);
  const transfers = Object.values(transferMap)
    .filter((transfer) => transfer.hostId === hostId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const finishTransfer = useStore((s) => s.finishTransfer);
  const t = (key) => tr(language, key);

  const retry = async (transfer) => {
    finishTransfer(transfer.id, { error: null, cancelled: false, done: false, transferred: 0 });
    try {
      if (transfer.dir === '↑' && transfer.kind === 'directory') {
        const result = await window.api.files.uploadDirectory({ hostId, localPath: transfer.localPath, remotePath: transfer.remotePath, transferId: transfer.id });
        finishTransfer(transfer.id, { done: true, skippedSymlinks: result.skippedSymlinks });
      } else if (transfer.dir === '↑') {
        await window.api.files.upload({ hostId, localPath: transfer.localPath, remotePath: transfer.remotePath, transferId: transfer.id, resume: true });
        finishTransfer(transfer.id, { done: true });
      } else if (transfer.kind === 'directory') {
        const result = await window.api.files.downloadDirectory({ hostId, remotePath: transfer.remotePath, localPath: transfer.localPath, transferId: transfer.id });
        finishTransfer(transfer.id, { done: true, skippedSymlinks: result.skippedSymlinks });
      } else {
        await window.api.files.download({ hostId, remotePath: transfer.remotePath, localPath: transfer.localPath, transferId: transfer.id, resume: true });
        finishTransfer(transfer.id, { done: true });
      }
    } catch (error) {
      finishTransfer(transfer.id, { error: error.message });
    }
  };

  const cancel = async (transfer) => {
    const cancelled = await window.api.files.cancelTransfer({ hostId, transferId: transfer.id });
    if (cancelled) finishTransfer(transfer.id, { cancelled: true });
  };

  return (
    <div className="transfer-panel">
      <div className="transfer-panel-heading">
        <h3>{t('transfers')}</h3>
        <p className="muted">{t('transferHelp')}</p>
      </div>
      {transfers.length === 0 ? <p className="muted">{t('noTransfers')}</p> : (
        <div className="transfer-list">
          {transfers.map((transfer) => (
            <div key={transfer.id} className="transfer-item transfer-task-item">
              <span>{transfer.dir} {transfer.name}</span>
              {transfer.error ? <><span className="error-text">{transfer.error}</span><button className="btn small" onClick={() => retry(transfer)}>{t('retry')}</button></>
                : transfer.cancelled ? <span className="muted">{t('cancelled')}</span>
                  : transfer.done ? <span className="ok">{t('completed')}</span>
                    : <progress value={transfer.transferred} max={transfer.total || 1} />}
              <span className="muted small">{fmtSize(transfer.transferred)} / {fmtSize(transfer.total)}</span>
              {!transfer.done && !transfer.error && !transfer.cancelled && <button className="btn small ghost" onClick={() => cancel(transfer)}>{t('cancel')}</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
