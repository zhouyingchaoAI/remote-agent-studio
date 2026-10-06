import React, { useState } from 'react';
import { useStore, saveHosts } from '../store.js';

export default function HostForm() {
  const { editingHost, hosts, setEditingHost, setActiveHost } = useStore();
  const [form, setForm] = useState({
    name: editingHost.name || '',
    host: editingHost.host || '',
    port: editingHost.port || 22,
    username: editingHost.username || 'root',
    authType: editingHost.privateKeyPath ? 'key' : 'password',
    password: editingHost.password || '',
    privateKeyPath: editingHost.privateKeyPath || '',
    passphrase: editingHost.passphrase || ''
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target ? e.target.value : e });

  const pickKey = async () => {
    const p = await window.api.dialog.pickKeyFile();
    if (p) setForm({ ...form, privateKeyPath: p });
  };

  const save = async (andConnect) => {
    if (!form.host || !form.username) return setError('主机地址和用户名必填');
    const host = {
      id: editingHost.id || `h_${Date.now()}`,
      name: form.name,
      host: form.host.trim(),
      port: Number(form.port) || 22,
      username: form.username.trim(),
      password: form.authType === 'password' ? form.password : '',
      privateKeyPath: form.authType === 'key' ? form.privateKeyPath : '',
      passphrase: form.authType === 'key' ? form.passphrase : ''
    };
    const next = editingHost.id
      ? hosts.map((h) => (h.id === host.id ? host : h))
      : [...hosts, host];
    await saveHosts(next);
    setEditingHost(null);
    if (andConnect) {
      setActiveHost(host.id);
      try { await window.api.ssh.connect(host); }
      catch (e) { useStore.getState().setStatus(host.id, 'error', e.message); }
    }
  };

  return (
    <div className="form-page">
      <h2>{editingHost.id ? '编辑主机' : '添加主机'}</h2>
      <p className="muted small">
        {editingHost.id
          ? '修改连接地址、端口不会新建对话：原聊天记录、工作目录和续聊标识保持不变。切换内网 / 外网地址时请编辑此主机，不要另加一台主机。请确保仍连接同一服务器、同一用户。'
          : '如果只是切换已有服务器的内网 / 外网地址，请取消并编辑原主机；添加主机会建立独立的对话列表。'}
      </p>
      <div className="form-grid">
        <label>备注名<input value={form.name} onChange={set('name')} placeholder="如: 开发机-A100" /></label>
        <label>主机地址 *<input value={form.host} onChange={set('host')} placeholder="192.168.1.100 或 域名" /></label>
        <label>端口<input type="number" value={form.port} onChange={set('port')} /></label>
        <label>用户名 *<input value={form.username} onChange={set('username')} /></label>
        <label>认证方式
          <select value={form.authType} onChange={set('authType')}>
            <option value="password">密码</option>
            <option value="key">私钥文件</option>
          </select>
        </label>
        {form.authType === 'password' ? (
          <label>密码<input type="password" value={form.password} onChange={set('password')} /></label>
        ) : (
          <>
            <label>私钥路径
              <div className="row">
                <input value={form.privateKeyPath} onChange={set('privateKeyPath')} placeholder="~/.ssh/id_ed25519" />
                <button className="btn" onClick={pickKey}>浏览</button>
              </div>
            </label>
            <label>私钥口令(可选)<input type="password" value={form.passphrase} onChange={set('passphrase')} /></label>
          </>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="row gap">
        <button className="btn primary" onClick={() => save(true)}>保存并连接</button>
        <button className="btn" onClick={() => save(false)}>仅保存</button>
        <button className="btn ghost" onClick={() => setEditingHost(null)}>取消</button>
      </div>
      <p className="muted small">密码/口令使用系统钥匙串加密后存储在本机。</p>
    </div>
  );
}
