import React, { useState, useEffect } from 'react';
import { CLAUDE_MODELS, modelVersionProblem } from '../claudeModels.js';
import { mergeModels } from '../mergeModels.js';

/* 模型选择器:预设 + 自定义输入,留空表示跟随 CLI 自身配置(~/.codex/config.toml 等)
 * deepseek 留空时后端默认 deepseek-v4-pro[1m] */
const MODEL_PRESETS = {
  /* Codex(2026-09 按 developers.openai.com/codex/models 核对)。
     排序按官方的推荐顺序,不是按发布时间 —— 列表是给人选的,
     第一个应该是"多数情况下该选的那个"。
     已退役的 gpt-5 / gpt-5-codex / gpt-5.4 / gpt-5.3-codex-spark 都拿掉了:
     留着只会让人选中一个已经不存在的模型,然后收到一句没头没尾的报错。
     (自建/中转端点的自定义模型名走「自定义…」那一项,不受这里影响。) */
  codex: [
    { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol · 推荐,近 Astra 能力、成本更低' },
    { value: 'gpt-6-astra', label: 'gpt-6-astra · 最强,最难的端到端工作' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna · 最快最省,重复性任务' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol · 上一代 Sol' },
    // 5.6 系在换代过渡期仍然可用,而且不少自建端点就叫这几个名字
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }
  ],
  /* claude 这份带版本门槛(新模型对 CLI 有最低版本要求),
     所以单独放在 claudeModels.js 里,是 {value,label,minCli} 结构。 */
  claude: CLAUDE_MODELS,
  deepseek: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
  // dsh 没有 --model 开关:模型由它自己的 profile 配置决定,这里给不出可选项
  dsh: []
};

const CUSTOM_MODEL = '__custom__';

// 稳定引用:避免 selector 每次返回新数组导致无限重渲染

/**
 * 已发现模型的缓存(渲染端)。主进程也有一层 6 小时的缓存,
 * 这一层是为了**切对话/重挂载时不再发一次 IPC** —— 同一台机器同一个引擎,
 * 一个会话里问一次就够了。
 */
const discoveredModels = new Map();

// `${hostId}|${agent}` -> {models, error}

function useDiscoveredModels(hostId, agent, enabled) {
  const key = `${hostId}|${agent}`;
  const [state, setState] = useState(() => discoveredModels.get(key) || null);
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(async (force = false) => {
    if (!enabled || !hostId) return;
    setBusy(true);
    try {
      const r = await window.api.models.discover({ hostId, engine: agent, force });
      const next = { models: r.models || [], error: r.ok ? '' : (r.error || '') };
      discoveredModels.set(key, next);
      setState(next);
    } catch (e) {
      setState({ models: [], error: e.message });
    } finally {
      setBusy(false);
    }
  }, [hostId, agent, key, enabled]);

  useEffect(() => {
    const cached = discoveredModels.get(key);
    if (cached) { setState(cached); return; }
    /* 自动查一次。**失败不打扰** —— 拿不到就用内置清单,
       用户没要求这件事,不该因为它失败就弹一个错误挡在面前。 */
    load(false);
  }, [key, load]);

  return { ...(state || { models: [], error: '' }), busy, reload: () => load(true) };
}

function ModelPicker({ agent, value, disabled, onChange, cliVersion = '', hostId = '' }) {
  /* 预设项既可能是纯字符串(codex/deepseek),也可能是 {value,label,minCli}
     (claude —— 新模型有 CLI 版本门槛)。两种都认,省得为了加一个字段
     把另外两个引擎的列表也改一遍。 */
  /* dsh 没有 --model,查也没意义 */
  const canDiscover = agent !== 'dsh';
  const found = useDiscoveredModels(hostId, agent, canDiscover);

  const builtin = (MODEL_PRESETS[agent] || []).map(
    (m) => (typeof m === 'string' ? { value: m, label: m } : m)
  );
  /* **以端点说的为准,内置清单只补位。**
     端点列出来的才是这台机器此刻真能用的;内置清单的唯一作用
     是发现失败时不至于两手空空。
     没被列出来的预设仍然保留 —— 有些中转不在 /v1/models 里公布全部模型,
     直接指定却能用,删掉等于替用户断定"这个不能用",而我们并不知道。 */
  const presets = mergeModels(found.models, builtin);
  const presetValues = presets.map((p) => p.value);
  /* 版本不够时在**选之前**就说清楚。
     不拦着不让选 —— 检测可能不准,而拦错了是凭空堵住一个本来能用的模型;
     但也不能不说,否则 CLI 甩一句自己的错误,人完全联想不到是版本太旧。 */
  const versionNote = agent === 'claude' ? modelVersionProblem(value, cliVersion) : '';
  const isPreset = value === '' || presetValues.includes(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onChange(next);
  };

  if (editing || !isPreset) {
    return (
      <span className="model-picker" title="自定义模型名,回车确认">
        <input
          className="model-input"
          value={editing ? draft : value}
          autoFocus={editing}
          disabled={disabled}
          placeholder="模型名"
          onFocus={() => { setDraft(value); setEditing(true); }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setDraft(value); setEditing(false); }
          }}
          onBlur={commit}
        />
        <button className="btn small ghost" type="button" disabled={disabled}
          title="回到预设列表" onClick={() => { setEditing(false); onChange(''); }}>预设</button>
      </span>
    );
  }

  return (
    <>
      <select
        className="model-select"
        value={value}
        disabled={disabled}
        title="切换模型(立即生效,上下文保留)"
        onChange={(e) => {
          if (e.target.value === CUSTOM_MODEL) { setDraft(value); setEditing(true); return; }
          onChange(e.target.value);
        }}>
        <option value="">{
          agent === 'deepseek' ? '默认(deepseek-v4-pro[1m])' :
          agent === 'dsh' ? '由 dsh profile 决定(此处选择无效)' : '默认模型(跟随 CLI 配置)'}</option>
        {/* 端点确认可用的排前面并标出来。没标的是内置清单里的,
            可能可用也可能不可用 —— 这个区别对自建端点尤其要紧。 */}
        {presets.map((m) => (
          <option key={m.value} value={m.value}>
            {m.discovered === false && found.models.length ? `${m.label}(未列出)` : m.label}
          </option>
        ))}
        <option value={CUSTOM_MODEL}>自定义…</option>
      </select>
      {canDiscover && (
        <button type="button" className="icon-btn" disabled={found.busy}
          title={found.error
            ? `自动获取模型列表失败:${found.error}\n点击重试(当前用的是内置清单)`
            : `已从端点获取 ${found.models.length} 个模型,点击刷新`}
          onClick={found.reload}>{found.busy ? '⋯' : '⟳'}</button>
      )}
      {versionNote && <span className="model-warn" title={versionNote}>⚠ 版本不足</span>}
    </>
  );
}

export { MODEL_PRESETS, CUSTOM_MODEL, discoveredModels, useDiscoveredModels, ModelPicker };
