import React, { useState } from 'react';

/* ---------- 轻量 Markdown 渲染(标题/列表/代码块/行内代码/加粗/链接/引用/分割线) ---------- */
export function inlineMd(text, onFileLink) {
  const nodes = [];
  let rest = String(text);
  let k = 0;
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(<?[^)>\s][^)>]*>?\))/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) nodes.push(<b key={k}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith('`')) nodes.push(<code key={k} className="md-inline-code">{tok.slice(1, -1)}</code>);
    else {
      const lm = tok.match(/\[([^\]]+)\]\(<?([^)>]+)>?\)/);
      const label = lm[1];
      const url = lm[2].trim();
      if (/^https?:/i.test(url)) {
        nodes.push(<a key={k} href="#" className="md-link"
          onClick={(e) => { e.preventDefault(); window.api.shell.openExternal(url); }}>{label}</a>);
      } else if ((url.startsWith('/') || url.startsWith('~') || /^[A-Za-z]:\\/.test(url)) && onFileLink) {
        // 本地/远程文件路径 -> 应用内预览
        nodes.push(<a key={k} href="#" className="md-link file-link" title={url}
          onClick={(e) => { e.preventDefault(); onFileLink(url); }}>📄 {label}</a>);
      } else {
        nodes.push(label);
      }
    }
    rest = rest.slice(m.index + tok.length);
    k += 1;
  }
  return nodes;
}

/**
 * 代码块:带语言标签和复制按钮。
 * 复制走主进程剪贴板 —— navigator.clipboard 在非安全上下文里会静默失败。
 */
export function CodeBlock({ code, lang }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await window.api.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-code-wrap">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button className="btn tiny ghost" onClick={copy}>{copied ? '已复制' : '复制'}</button>
      </div>
      <pre className="md-code">{code}</pre>
    </div>
  );
}

export default function Markdown({ text = '', onFileLink }) {
  const parts = String(text).split('```');
  const out = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // ```lang\n... 首行是语言标记,展示时去掉但保留下来做标签
      const lang = (part.match(/^([\w+-]*)\n/) || [, ''])[1];
      out.push(<CodeBlock key={`c${i}`} lang={lang} code={part.replace(/^[\w+-]*\n/, '')} />);
      return;
    }
    part.split('\n').forEach((line, j) => {
      const key = `${i}-${j}`;
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        out.push(<div key={key} className={`md-h md-h${Math.min(h[1].length, 4)}`}>{inlineMd(h[2], onFileLink)}</div>);
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push(<hr key={key} className="md-hr" />);
      } else if (/^\s*>\s?/.test(line)) {
        out.push(<div key={key} className="md-quote">{inlineMd(line.replace(/^\s*>\s?/, ''), onFileLink)}</div>);
      } else if (/^\s*[-*+]\s+/.test(line)) {
        out.push(<div key={key} className="md-li">• {inlineMd(line.replace(/^\s*[-*+]\s+/, ''), onFileLink)}</div>);
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        out.push(<div key={key} className="md-li">{inlineMd(line.trim(), onFileLink)}</div>);
      } else {
        out.push(<div key={key} className="md-p">{inlineMd(line, onFileLink)}</div>);
      }
    });
  });
  return <div className="md">{out}</div>;
}
