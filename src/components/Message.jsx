import React, { useState } from 'react';
import { isAwaitingConfirm } from '../store.js';
import { useVoiceInput } from '../useVoiceInput.js';
import { extractOptions } from '../quickReplies.js';
import Markdown from './Markdown.jsx';
import { ToolOutput, ToolCall, DiffView } from './ToolMessages.jsx';
import { ImagePreview, ArtifactFile } from './ImageMessages.jsx';

/* 语音确认/选择:录音转写后按关键词匹配「确认/取消/选项号」并触发对应按钮 */
function VoiceReplyButton({ mode, options, onReply }) {
  const [hint, setHint] = useState('');
  const voice = useVoiceInput(async (text) => {
    const value = await window.api.voice.interpret({ transcript: text, ctx: { mode, options } }).catch(() => null);
    if (value != null) { setHint(''); onReply(value); }
    else setHint(`没听懂「${text.slice(0, 20)}」`);
  });
  return (
    <span className="voice-reply-wrap">
      <button className={`btn small quick-reply mic-button ${voice.state}`} type="button"
        onClick={voice.toggle} disabled={voice.state === 'transcribing'}
        title={mode === 'confirm' ? '语音说「确认 / 取消」' : '语音说选项号或名称'}>
        {voice.state === 'recording' ? '● 说话中' : voice.state === 'transcribing' ? '识别中…' : '🎤 语音'}
      </button>
      {(hint || voice.error) && <span className="voice-error">{hint || voice.error}</span>}
    </span>
  );
}

/**
 * **memo 是长对话流式输出时最关键的一处优化。**
 *
 * 不包的话,每来一个 delta,窗口内的 200 条消息**全部**重渲染,
 * 每条都重新解析一遍 Markdown —— 流式输出每秒十几次 delta,
 * 就是每秒几千次 Markdown 解析。2000 条的对话一输出就卡,根因在这儿,
 * 不在持久化(那个量过,每次才 1.5ms)。
 *
 * memo 生效的前提是 props 稳定:store 只替换被改动的那条消息对象,
 * 其余保持引用不变;三个回调在 ChatView 里用 useCallback 固定住。
 * 少做任何一项,memo 都形同虚设 —— 下面的测试会守着。
 */
const Message = React.memo(function Message({ m, hostId, convId, onEnableSystemMode, isLast, running, onQuickReply, onFileLink }) {
  const [open, setOpen] = useState(false);
  if (m.role === 'user')
    return (
      <div className="msg user">
        <pre>{m.text}</pre>
        {m.attachments?.length > 0 && (
          <div className="message-attachments">
            {m.attachments.map((file) => file.kind === 'image'
              ? <ImagePreview key={file.remotePath} hostId={hostId} convId={convId} remotePath={file.remotePath} name={file.originalName || file.name} compact />
              : <span className="message-file" key={file.remotePath}>{file.originalName || file.name}</span>)}
          </div>
        )}
      </div>
    );

  switch (m.kind) {
    case 'text':
    case 'result': {
      /* 引擎的收尾事件与最后一段回复重复时,后端只留下费用/耗时。
         这里就渲染成一行元信息,不要套一个空气泡。 */
      if (!m.text) {
        return m.costUsd != null ? (
          <div className="msg-meta standalone">
            ${m.costUsd?.toFixed(4)}{m.durationMs != null && ` · ${(m.durationMs / 1000).toFixed(1)}s`}
          </div>
        ) : null;
      }
      const opts = (isLast && !running && onQuickReply) ? extractOptions(m.text) : [];
      const asksConfirm = isLast && !running && onQuickReply && !opts.length &&
        isAwaitingConfirm(m.text);
      return (
        <div className="msg agent">
          <Markdown text={m.text} onFileLink={onFileLink} />
          {m.kind === 'result' && m.costUsd != null && (
            <div className="msg-meta">${m.costUsd?.toFixed(4)} · {(m.durationMs / 1000).toFixed(1)}s</div>
          )}
          {opts.length > 0 && (
            <div className="quick-replies">
              {opts.map((o) => (
                <button key={o.n} className="btn small quick-reply"
                  onClick={() => onQuickReply(o.n)}>{o.n}. {o.label}</button>
              ))}
              <VoiceReplyButton mode="options" options={opts} onReply={onQuickReply} />
            </div>
          )}
          {asksConfirm && (
            <div className="quick-replies">
              <button className="btn small quick-reply" onClick={() => onQuickReply('确认')}>✅ 确认</button>
              <button className="btn small quick-reply" onClick={() => onQuickReply('取消')}>✕ 取消</button>
              <VoiceReplyButton mode="confirm" onReply={onQuickReply} />
            </div>
          )}
        </div>
      );
    }
    case 'reasoning':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">🧠 思考 {open ? '▾' : '▸'}</span>
          {open && <pre className="dim">{m.text}</pre>}
        </div>
      );
    case 'tool':
      return <ToolCall m={m} hostId={hostId} convId={convId} />;
    case 'diff':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">± 本轮文件改动 {open ? '▾' : '▸'}</span>
          {open && <DiffView text={m.text} />}
        </div>
      );
    case 'tool_output':
      return <ToolOutput output={m.output} exitCode={m.exitCode} />;
    case 'error':
      return <div className="msg error-msg"><pre>{m.text}</pre></div>;
    case 'stderr':
      return (
        <div className="msg thin" onClick={() => setOpen(!open)}>
          <span className="chip">⚠ stderr {open ? '▾' : '▸'}</span>
          {open && <pre className="dim">{m.text}</pre>}
        </div>
      );
    case 'permission_hint':
      return (
        <div className="msg permission-hint">
          <pre>{m.text}</pre>
          <button className="btn small permission-hint-action" onClick={onEnableSystemMode}>Enable System Mode</button>
        </div>
      );
    case 'image':
      return <ImagePreview hostId={hostId} convId={convId} remotePath={m.remotePath} name={m.name} />;
    case 'file':
      return <ArtifactFile hostId={hostId} remotePath={m.remotePath} name={m.name} />;
    default:
      return <div className="msg thin"><pre className="dim">{m.text || JSON.stringify(m)}</pre></div>;
  }
});

export { VoiceReplyButton, Message };
