import React from 'react';

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

export default function Markdown({ text = '', onFileLink }) {
  const parts = String(text).split('```');
  const out = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(<pre className="md-code" key={`c${i}`}>{part.replace(/^[\w+-]*\n/, '')}</pre>);
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
