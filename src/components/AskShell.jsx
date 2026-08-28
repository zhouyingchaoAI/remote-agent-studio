import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../store.js';

/**
 * 各引擎里最快的那个模型。
 *
 * 这个面板的全部价值是「快」—— 你是在终端里卡住了、想立刻拿回一条命令。
 * 等 20 秒的深度推理不如自己去搜,那时这个功能就不如不存在。
 *
 * 所以对话里选的是什么模型不重要,**引擎**才重要:引擎决定用哪套凭据、
 * 账单记在哪、装没装。引擎跟着对话走,模型固定挑最快的。
 */
const FASTEST_MODEL = {
  codex: 'gpt-5',
  claude: 'haiku',
  deepseek: 'deepseek-v4-flash',
  // dsh 没有 --model 开关,模型由它自己的 profile 决定,给了也没用
  dsh: ''
};

export function pickAskEngine(state, hostId) {
  const convs = Object.values(state.conversations || {}).filter((c) => c.hostId === hostId);
  const activeId = state.activeConvByHost?.[hostId];
  const conv = (activeId && state.conversations[activeId])
    || convs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const agent = conv?.agent || 'codex';
  return {
    agent,
    /* 固定用最快的模型,不跟对话走。
       引擎仍跟着对话 —— 换引擎意味着换凭据和账单,那个必须一致。 */
    model: FASTEST_MODEL[agent] ?? '',
    /* 推理强度压到最低。这是延迟差别最大的一个开关:
       同一个模型 minimal 和 high 能差好几倍,而"某某命令怎么写"
       根本不需要推理 —— 它是回忆,不是解题。 */
    reasoningEffort: agent === 'codex' ? 'minimal' : '',
    fast: true,
    source: conv ? (activeId && state.conversations[activeId] ? 'active' : 'recent') : 'default',
    title: conv?.title || ''
  };
}

/**
 * 终端里的「快速问一下」。
 *
 * 场景:命令记不清了,不想切出去查。所以整个交互只有三步 ——
 * 打开(⌘K)、问、把命令拿走。
 *
 * 关键取舍:命令**只填进终端,绝不自动执行**。模型给的可能是 rm -rf,
 * 也可能只是版本对不上;让人看一眼再按回车,成本是一秒,省掉的是不可逆的事故。
 */
const ENGINE_LABEL = { codex: 'Codex', claude: 'Claude', deepseek: 'DeepSeek', dsh: 'DeepSeek Harness' };

export default function AskShell({ hostId, termId, getTail, onInsert }) {
  /* 引擎跟当前对话走,模型固定挑最快的(见 pickAskEngine)。
     必须选原始值再 memo:选择器里直接返回新对象的话,每次 store 变动
     (任何一条传输进度、任何一条消息)都会让这个组件重渲,
     React 18 的 useSyncExternalStore 还会报 getSnapshot 没缓存。 */
  const conversations = useStore((st) => st.conversations);
  const activeConvByHost = useStore((st) => st.activeConvByHost);
  const engine = useMemo(
    () => pickAskEngine({ conversations, activeConvByHost }, hostId),
    [conversations, activeConvByHost, hostId]
  );
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [withTail, setWithTail] = useState(true);
  const [shot, setShot] = useState(null);   // {path, name}
  const [partial, setPartial] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const askIdRef = useRef('');
  const inputRef = useRef(null);

  /* 「问中…」转到底、既没进度也没出口,是最糟的等待界面。
     所以边出边显示,并且把已等秒数摆出来。 */
  useEffect(() => window.api.ask.onProgress(({ askId, partial: p }) => {
    if (askId === askIdRef.current) setPartial(p || '');
  }), []);
  useEffect(() => {
    if (!busy) { setElapsed(0); return undefined; }
    const t = window.setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  // ⌘K / Ctrl+K 唤起 —— 手已经在键盘上,不该逼人去够鼠标
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 30); }, [open]);

  const ask = async () => {
    if (!q.trim() || busy) return;
    const askId = `ask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    askIdRef.current = askId;
    setBusy(true); setErr(''); setResult(null); setPartial('');
    try {
      const r = await window.api.ask.shell({
        hostId, question: q, askId,
        tail: withTail ? (getTail?.() || '') : '',
        imagePath: shot?.path || '',
        agent: engine.agent, model: engine.model, reasoningEffort: engine.reasoningEffort
      });
      setResult(r);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); setPartial(''); }
  };

  const capture = async () => {
    try {
      const r = await window.api.screenshot.capture();
      if (r?.path) setShot({ path: r.path, name: r.name || '截图' });
    } catch (e) { setErr(`截图失败:${e.message}`); }
  };

  if (!open) {
    return (
      <button className="ask-fab" title="快速问一下(⌘K)" onClick={() => setOpen(true)}>
        💬 问一下
      </button>
    );
  }

  return (
    <div className="ask-panel">
      <div className="row gap ask-head">
        <b>快速问一下</b>
        {/* 标出用的是哪个引擎/模型 —— 这关系到费用和答案风格,不该藏着 */}
        <span className="muted small"
          title="固定用最快的模型、最低推理强度 —— 这里要的是立刻拿回一条命令。引擎跟着当前对话走(凭据和账单要一致)">
          {ENGINE_LABEL[engine.agent] || engine.agent}
          {engine.model ? ` · ${engine.model}` : ''}
          {engine.fast ? ' · 极速' : ''}
        </span>
        <span className="muted small">⌘K · Esc</span>
        <span className="flex1" />
        <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
      </div>

      <div className="row gap">
        <input ref={inputRef} className="ask-input" value={q}
          placeholder="例如:怎么看某个容器最近 100 行日志"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        {busy ? (
          <button className="btn small ghost" title="停止这次提问"
            onClick={() => {
              window.api.ask.cancel({ askId: askIdRef.current });
              setBusy(false); setErr('已取消');
            }}>
            取消 {elapsed}s
          </button>
        ) : (
          <button className="btn small primary" disabled={!q.trim()} onClick={ask}>问</button>
        )}
      </div>

      <div className="row gap ask-opts">
        <label className="check-row inline"
          title="终端输出会随问题一起发给模型;发送前会把 key/token 类内容替换成 ***(本地正则,不影响速度)">
          <input type="checkbox" checked={withTail} onChange={(e) => setWithTail(e.target.checked)} />
          <span className="small">带上终端最近输出</span>
        </label>
        <button className="btn tiny ghost" onClick={capture}>截图</button>
        {shot && (
          <span className="muted small">
            已附 {shot.name}
            <button className="icon-btn" onClick={() => setShot(null)}>✕</button>
          </span>
        )}
      </div>

      {busy && (
        <pre className="ask-answer">
          {partial || `正在问 ${ENGINE_LABEL[engine.agent] || engine.agent}…(已等 ${elapsed}s)`}
        </pre>
      )}
      {err && <p className="error-text small">{err}</p>}

      {result && (
        <div className="ask-result">
          {result.commands.length > 0 && (
            <div className="ask-cmds">
              {result.commands.map((c, i) => (
                <div key={i} className="ask-cmd">
                  <pre>{c}</pre>
                  <div className="row gap">
                    <button className="btn tiny" onClick={() => {
                      window.api.clipboard.writeText(c);
                    }}>复制</button>
                    {/* 只填不执行:让人看一眼再按回车 */}
                    <button className="btn tiny primary"
                      title="填进终端但不回车,你确认后自己执行"
                      onClick={() => { onInsert?.(c); setOpen(false); }}>
                      填入终端
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <pre className="ask-answer">{result.answer}</pre>
          <p className="muted small">
            命令只会填进终端、不会自动执行 —— 按回车前请自己看一眼。
            {result.env?.os ? ` 已按「${result.env.os}」作答。` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
