import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const root = createRoot(document.getElementById('root'));

/**
 * 顶层守卫:preload 失败时 window.api 不存在,直接渲染 App 会在首次访问 api 时崩成黑屏。
 * 这里改为渲染可读的诊断页,避免"点了启动只有黑屏"这类无从下手的故障。
 */
if (!window.api) {
  root.render(
    <div style={{
      padding: 32, color: '#e4e8f1', background: '#0f1117', height: '100vh',
      fontFamily: 'system-ui, sans-serif', lineHeight: 1.7
    }}>
      <h2 style={{ color: '#fca5a5' }}>初始化失败:预加载脚本未能注入</h2>
      <p>主进程接口(window.api)不可用,界面无法启动。常见原因与处理:</p>
      <ul>
        <li>从源码运行时构建产物过期 —— 执行 <code>npm run build</code> 后重试</li>
        <li>预加载脚本报错 —— 菜单「视图 → 开发者工具」查看 Console 中的红色报错</li>
        <li>安装包损坏或被安全软件拦截 —— 重新下载安装</li>
      </ul>
      <p style={{ opacity: 0.7 }}>若问题持续,请带上 Console 报错到 GitHub Issues 反馈。</p>
    </div>
  );
} else {
  root.render(<App />);
}
