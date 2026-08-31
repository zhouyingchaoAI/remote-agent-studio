import React, { useState } from 'react';
import { useStore, saveHosts } from '../store.js';
import FilePreview from './FilePreview.jsx';

export default function Sidebar() {
  const { hosts, activeHostId, statuses, setActiveHost, setEditingHost } = useStore();
  const activeConvByHost = useStore((s) => s.activeConvByHost);
  const conversations = useStore((s) => s.conversations);
  const [expanded, setExpanded] = useState({}); // hostId -> bool(展开文件树)
  const [preview, setPreview] = useState(null); // {hostId, path, name}
  const [homeMode, setHomeMode] = useState({}); // hostId -> true 时强制家目录

  // 文件树根目录:默认当前对话的项目目录,否则家目录
  const treeRootOf = (hostId) => {
    if (homeMode[hostId]) return '~';
    const convId = activeConvByHost[hostId];
    return (convId && conversations[convId]?.cwd) || '~';
  };

  const connect = async (host) => {
    setActiveHost(host.id);
    setEditingHost(null);
    if (host.local) { useStore.getState().setStatus('local', 'connected'); return; }
    const st = useStore.getState().statuses[host.id];
    if (st !== 'connected' && st !== 'connecting') {
      try { await window.api.ssh.connect(host); }
      catch (e) { useStore.getState().setStatus(host.id, 'error', e.message); }
    }
  };

  const remove = async (e, host) => {
    e.stopPropagation();
    if (!confirm(`删除主机 ${host.name || host.host}?`)) return;
    await window.api.ssh.disconnect(host.id).catch(() => {});
    const next = useStore.getState().hosts.filter((h) => h.id !== host.id);
    await saveHosts(next);
    if (useStore.getState().activeHostId === host.id) setActiveHost(null);
  };

  const toggleTree = async (e, host) => {
    e.stopPropagation();
    const willOpen = !expanded[host.id];
    setExpanded((s) => ({ ...s, [host.id]: willOpen }));
    if (willOpen) await connect(host); // 展开需要已连接
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="logo">🛰️ Remote Agent</span>
      </div>
      <div className="host-list">
        {hosts.map((h) => {
          const st = statuses[h.id] || 'disconnected';
          return (
            <div key={h.id}>
              <div
                className={`host-item ${activeHostId === h.id ? 'active' : ''}`}
                onClick={() => connect(h)}>
                <button className="tree-toggle" title="展开文件"
                  onClick={(e) => toggleTree(e, h)}>{expanded[h.id] ? '▾' : '▸'}</button>
                <span className={`dot ${st}`} />
                <div className="host-info">
                  <div className="host-name">{h.name || h.host}</div>
                  <div className="host-addr">{h.username}@{h.host}</div>
                </div>
                {!h.local && (
                  <div className="host-actions">
                    <button className="icon-btn" title="编辑"
                      onClick={(e) => { e.stopPropagation(); setEditingHost(h); }}>✎</button>
                    <button className="icon-btn danger" title="删除"
                      onClick={(e) => remove(e, h)}>✕</button>
                  </div>
                )}
              </div>
              {expanded[h.id] && (
                <div className="host-tree">
                  {st === 'connected' ? (
                    <>
                      <div className="tree-root-bar">
                        <span className="muted small tree-root-path" title={treeRootOf(h.id)}>
                          {treeRootOf(h.id) === '~' ? '⌂ 家目录' : `📁 ${treeRootOf(h.id).split('/').filter(Boolean).pop()}`}
                        </span>
                        {treeRootOf(h.id) !== '~' && (
                          <button className="btn small ghost" title="切换到家目录"
                            onClick={(e) => { e.stopPropagation(); setHomeMode((s) => ({ ...s, [h.id]: true })); }}>⌂</button>
                        )}
                        {homeMode[h.id] && activeConvByHost[h.id] && conversations[activeConvByHost[h.id]]?.cwd && (
                          <button className="btn small ghost" title="切换到项目目录"
                            onClick={(e) => { e.stopPropagation(); setHomeMode((s) => ({ ...s, [h.id]: false })); }}>📁</button>
                        )}
                      </div>
                      <TreeNode key={treeRootOf(h.id)} hostId={h.id} path={treeRootOf(h.id)}
                        name={treeRootOf(h.id)} depth={0} defaultOpen isRoot
                        onFile={(f) => setPreview({ hostId: h.id, ...f })} />
                    </>
                  ) : <div className="tree-hint muted small">{st === 'connecting' ? '连接中...' : '未连接'}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <button className="btn ghost add-host" onClick={() => setEditingHost({})}>
          + 添加主机
        </button>
        {/* **带上文字。** 原来是个光秃秃的 ⚙,而顶栏「环境配置」用的也是齿轮 ——
            找皮肤的人会去点那个显眼的、有文字的,翻不到就以为功能没做。
            齿轮现在只代表这一个入口。 */}
        <button className="btn ghost settings-btn" title="设置(⌘,)"
          onClick={() => useStore.getState().setShowSettings(true)}>⚙ 设置</button>
      </div>
      {preview && (
        <FilePreview hostId={preview.hostId} filePath={preview.path} name={preview.name}
          onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

/** 远程文件树节点(懒加载子目录) */
function TreeNode({ hostId, path, name, depth, isDir = true, defaultOpen = false, isRoot = false, onFile }) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const d = await window.api.files.listRemote({ hostId, dirPath: path });
      setEntries(d.entries);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  const toggle = async () => {
    if (!isDir) {
      // 点击文件 -> 预览内容
      if (onFile) onFile({ path, name });
      return;
    }
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && entries == null) await load();
  };

  // eslint-disable-next-line
  React.useEffect(() => { if (defaultOpen && entries == null) load(); }, []);

  const childPath = (n) => (path === '~' ? `~/${n}` : `${path}/${n}`.replace(/\/+/g, '/'));

  return (
    <div className="tree-node">
      {!isRoot && (
        <div className="tree-row" style={{ paddingLeft: depth * 12 + 6 }} onClick={toggle}>
          <span className="tree-icon">{isDir ? (open ? '📂' : '📁') : '📄'}</span>
          <span className="tree-name">{name}</span>
        </div>
      )}
      {(open || isRoot) && (
        <div className="tree-children">
          {loading && <div className="tree-hint muted small" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>加载中...</div>}
          {err && <div className="tree-hint error-text" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>{err}</div>}
          {entries && entries.length === 0 && <div className="tree-hint muted small" style={{ paddingLeft: (depth + 1) * 12 + 6 }}>(空)</div>}
          {entries && entries.map((e) => (
            <TreeNode key={e.name} hostId={hostId} path={childPath(e.name)}
              name={e.name} depth={depth + 1} isDir={e.isDir || e.isLink} onFile={onFile} />
          ))}
        </div>
      )}
    </div>
  );
}
