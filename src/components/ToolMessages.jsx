import { useState, useRef, useEffect } from 'react';
import { outputSummary, looksFailed } from '../toolOutput.js';

/* 统一 diff(unified diff)红绿渲染 */
/**
 * 命令输出。
 *
 * 之前这里是整个"看不到中间过程"的根源:codex 新格式把输出挂在 tool 消息的
 * output 字段上,而渲染器只画命令、**根本不看 output** —— 于是对话里只剩
 * 一行命令和一段结论,你没法验证结论对不对。
 *
 * 折叠但给一行摘要:全展开会把对话冲垮,全折起来等于没有中间过程。
 * 失败的默认展开 —— 那正是你想看的那种。
 */
function ToolOutput({ output = '', exitCode, running = false, onStop = null }) {
  const failed = looksFailed(output, exitCode);
  /* 跑着的默认展开。命令跑了十分钟你却要先点一下才能看见它在干什么,
     等于这个日志不存在 —— 想看进度的时刻正是它还在跑的时刻。 */
  const [open, setOpen] = useState(failed || running);
  const bodyRef = useRef(null);
  const followRef = useRef(true);

  /* 跟随到底部,但**只在用户本来就贴着底部时**。
     日志一直在长,如果不管三七二十一都滚到底,
     人正往上翻看某一行报错时会被反复拽回去 —— 那比不自动滚更烦。 */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !running) return;
    if (followRef.current) el.scrollTop = el.scrollHeight;
  }, [output, open, running]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const { lines, preview } = outputSummary(output);
  // 跑着但还没有输出时也要出现:否则界面上什么都没有,和卡死没区别
  if (!String(output).trim() && !running) return null;
  return (
    <div className={`tool-output${failed ? ' failed' : ''}${running ? ' running' : ''}`}>
      <button className="tool-output-head" onClick={() => setOpen(!open)}>
        <span className="chip">
          {running ? <span className="live-dot" /> : (failed ? '⚠' : '📄')} 输出 {open ? '▾' : '▸'}
        </span>
        <span className="muted small">{lines} 行{running ? ' · 持续输出中' : ''}</span>
        {exitCode != null && (
          <span className={`small ${Number(exitCode) === 0 ? 'muted' : 'exit-bad'}`}>退出码 {exitCode}</span>
        )}
        {/* 折叠时也让人看见点东西:取最后一行非空输出 —— 结论在末尾,不在开头 */}
        {!open && preview && <code className="tool-output-preview">{preview}</code>}
      </button>
      {open && (
        <>
          <pre className="dim tool-output-body" ref={bodyRef} onScroll={onScroll}>
            {output || '(还没有输出)'}
          </pre>
          <div className="row gap">
            <button className="btn tiny ghost" onClick={() => window.api.clipboard.writeText(output)}>
              复制输出
            </button>
            {running && onStop && (
              /* 复用会话本身的取消通道 —— 它会 kill 远端进程。
                 在这儿另写一套"停止命令"必然和它不一致。 */
              <button className="btn tiny ghost" onClick={onStop} title="中断当前这一轮,并结束远端进程">
                停止
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 一次工具调用:命令 + 它的输出 */
function ToolCall({ m, hostId = '', convId = '' }) {
  const [showFull, setShowFull] = useState(false);
  const detail = String(m.detail || '');
  const stop = (hostId && convId)
    ? () => window.api.agent.cancel({ hostId, convId }).catch(() => {})
    : null;
  // 200 字符经常正好把命令切在关键参数上,所以留一个"看全"的出口
  const long = detail.length > 200;
  return (
    <div className={`msg thin ${m.dangerous ? 'tool-dangerous' : ''}`}>
      <div className="row gap tool-head">
        <span className={`chip tool ${m.dangerous ? 'danger' : ''}`}>{m.dangerous ? '⚠️' : '🔧'} {m.name}</span>
        {m.dangerous && <span className="danger-tag">危险操作</span>}
        {detail && (
          <code className="tool-detail" onClick={() => long && setShowFull(!showFull)}
            title={long ? '点击展开完整命令' : ''}>
            {showFull || !long ? detail : `${detail.slice(0, 200)}…`}
          </code>
        )}
        {long && (
          <button className="btn tiny ghost" onClick={() => window.api.clipboard.writeText(detail)}>复制</button>
        )}
      </div>
      {m.diff && <EditDiff diff={m.diff} />}
      {/* 这一行是这次修复的核心:输出本来就传过来了,只是从没被画出来 */}
      <ToolOutput output={m.output} exitCode={m.exitCode} running={m.running} onStop={stop} />
    </div>
  );
}

function DiffView({ text = '' }) {
  return (
    <pre className="diff-view">
      {String(text).split('\n').map((line, i) => {
        let cls = '';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-add';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-del';
        else if (line.startsWith('@@')) cls = 'diff-hunk';
        else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) cls = 'diff-file';
        return <div key={i} className={`diff-line ${cls}`}>{line || ' '}</div>;
      })}
    </pre>
  );
}

/* 编辑类工具的 old/new 内容 diff */
function EditDiff({ diff }) {
  return (
    <div className="edit-diff">
      {diff.old && (
        <pre className="diff-view">
          {diff.old.split('\n').map((l, i) => <div key={i} className="diff-line diff-del">- {l}</div>)}
        </pre>
      )}
      {diff.new && (
        <pre className="diff-view">
          {diff.new.split('\n').map((l, i) => <div key={i} className="diff-line diff-add">+ {l}</div>)}
        </pre>
      )}
    </div>
  );
}

export { ToolOutput, ToolCall, DiffView, EditDiff };
