import React, { useEffect, useState } from 'react';
import { useStore } from '../store.js';

/**
 * Claude Code 接 DeepSeek —— 官方端点或自建中转(new-api / one-api)。
 *
 * 这一版把流程拉成一条直线。上一版有两个会改字段的预设按钮、一个配置串框、
 * 四个输入框、外加「保存 / 写 key / 测试」三个各干各的按钮,用户不知道
 * 从哪下手,也记不住顺序 —— 反馈原话是「都不会填了」。
 *
 * 现在:选来源 → 填该来源需要的东西 → 一个「保存并测试」按钮做完全部。
 * 官方模式下地址和模型是固定的,直接不显示,少两个要决策的框。
 */

const OFFICIAL = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-v4-pro[1m]',
  flashModel: 'deepseek-v4-flash',
  envKey: 'DEEPSEEK_API_KEY'
};
const RELAY_DEFAULTS = { baseUrl: '', model: 'deepseek-chat', flashModel: '', envKey: 'DEEPSEEK_API_KEY' };

const URL_RE = /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._\-/]*)?$/;

export default function DeepseekEndpoint({ hostId, isLocal, busy, setBusy }) {
  const saved = useStore((s) => s.settings.deepseekEndpoint);
  // 已保存的地址是官方域名 -> 认为在官方模式
  const [source, setSource] = useState(
    () => (!saved || saved.baseUrl === OFFICIAL.baseUrl ? 'official' : 'relay')
  );
  const [form, setForm] = useState(() => saved || OFFICIAL);
  const [apiKey, setApiKey] = useState('');
  const [relayText, setRelayText] = useState('');
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [result, setResult] = useState(null);
  const [note, setNote] = useState('');
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => { if (saved) setForm(saved); }, [saved]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const effective = source === 'official' ? { ...OFFICIAL } : form;

  const pickSource = (next) => {
    setSource(next);
    setResult(null); setNote(''); setModels([]);
    // 只在切到官方时覆盖字段;切到中转保留已填的,免得清空后无从下手
    if (next === 'official') setForm(OFFICIAL);
    else if (form.baseUrl === OFFICIAL.baseUrl) setForm({ ...RELAY_DEFAULTS });
  };

  const importRelay = async () => {
    setNote(''); setResult(null);
    try {
      const r = await window.api.deepseek.parseRelay({ text: relayText });
      setForm((f) => ({ ...f, baseUrl: r.baseUrl }));
      if (r.key) setApiKey(r.key);
      setRelayText('');   // 含密钥的原文不留在界面上
      setNote(`已识别地址 ${r.baseUrl}${r.keyMasked ? ` · 密钥 ${r.keyMasked}` : ''}`);
    } catch (e) { setNote(`解析失败:${e.message}`); }
  };

  const fetchModels = async () => {
    setLoadingModels(true); setNote(''); setResult(null);
    try {
      const r = await window.api.deepseek.listModels({ hostId, cfg: effective });
      setModels(r.models || []);
      if (!r.models?.length) setNote(`没拉到模型列表,手动填即可。原始响应:${r.raw || '空'}`);
      else {
        setNote(`拉到 ${r.models.length} 个模型`);
        if (!r.models.includes(form.model)) setForm((f) => ({ ...f, model: r.models[0] }));
      }
    } catch (e) { setNote(`拉取失败:${e.message}`); }
    finally { setLoadingModels(false); }
  };

  /**
   * 一步做完:校验 → 存端点 → 写 key(填了才写)→ 实测。
   * 拆成三个按钮时用户要记顺序,漏一步就得到看不懂的报错。
   */
  const saveAndTest = async () => {
    setNote(''); setResult(null);
    const url = String(effective.baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) { setNote('请先填端点地址'); return; }
    if (!URL_RE.test(url)) { setNote('端点地址不合法:只允许 http(s)://主机[:端口][/路径]'); return; }

    setBusy(true);
    try {
      const cfg = { ...effective, baseUrl: url };
      useStore.getState().applySettings({ deepseekEndpoint: cfg });

      if (apiKey.trim()) {
        await window.api.setup.setEnvKey({
          hostId, envKey: cfg.envKey || 'DEEPSEEK_API_KEY', key: apiKey.trim()
        });
        setApiKey('');
      }
      setResult(await window.api.deepseek.testEndpoint({ hostId, cfg }));
    } catch (e) {
      setResult({ ok: false, message: `失败:${e.message}` });
    } finally { setBusy(false); }
  };

  const needUrl = source === 'relay' && !String(form.baseUrl || '').trim();

  return (
    <Fold title="Claude Code 接 DeepSeek" hint="用 claude CLI 驱动 DeepSeek 或自建中转">
      {/* 第 1 步:选来源 */}
      <div className="step-row">
        <span className="step-num">1</span>
        <b>用哪个端点</b>
      </div>
      <div className="row gap seg">
        <button className={`btn small ${source === 'official' ? 'primary' : ''}`}
          onClick={() => pickSource('official')}>DeepSeek 官方</button>
        <button className={`btn small ${source === 'relay' ? 'primary' : ''}`}
          onClick={() => pickSource('relay')}>自建中转(new-api)</button>
      </div>
      {source === 'official' && (
        <p className="muted small">地址与模型用官方默认,你只需要下面填一个 API Key。</p>
      )}

      {/* 第 2 步:中转才需要填地址与模型 */}
      {source === 'relay' && (
        <>
          <div className="step-row"><span className="step-num">2</span><b>中转站地址与模型</b></div>
          <p className="muted small">
            后台给的配置串直接粘进来最省事(形如 <code>{'{"key":"sk-…","url":"http://…:3000"}'}</code>):
          </p>
          <div className="row gap">
            <input value={relayText} onChange={(e) => setRelayText(e.target.value)}
              placeholder="把配置串粘到这里" style={{ flex: 1 }} />
            <button className="btn small" disabled={!relayText.trim()} onClick={importRelay}>解析</button>
          </div>

          <div className="form-grid" style={{ marginTop: 10 }}>
            <label>
              端点地址{needUrl && <span className="error-text small"> ← 还没填</span>}
              <input value={form.baseUrl} onChange={set('baseUrl')}
                className={needUrl ? 'input-missing' : ''}
                placeholder="http://1.2.3.4:3000(填根地址,不要带 /v1)" />
            </label>
            <label>模型
              <div className="row gap">
                {models.length ? (
                  <select value={form.model} onChange={set('model')} style={{ flex: 1 }}>
                    {!models.includes(form.model) && form.model &&
                      <option value={form.model}>{form.model}(当前)</option>}
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input value={form.model} onChange={set('model')}
                    placeholder="deepseek-chat" style={{ flex: 1 }} />
                )}
                <button className="btn small" type="button"
                  disabled={busy || loadingModels || needUrl} onClick={fetchModels}
                  title="向中转站询问它实际挂了哪些模型">
                  {loadingModels ? '拉取中…' : '拉取列表'}
                </button>
              </div>
            </label>
          </div>
        </>
      )}

      {/* 第 3 步:key */}
      <div className="step-row">
        <span className="step-num">{source === 'official' ? 2 : 3}</span>
        <b>API Key</b>
      </div>
      <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
        placeholder={saved ? 'sk-…(留空表示沿用已写入的)' : 'sk-…'} />
      <p className="muted small">
        只写到 <code>~/.remote-agent-env.sh</code>(600 权限),不进本应用的配置文件,也不出现在日志里。
      </p>

      {/* 第 4 步:一步做完 */}
      <div className="step-row">
        <span className="step-num">{source === 'official' ? 3 : 4}</span>
        <b>保存并验证</b>
      </div>
      <button className="btn primary" disabled={busy || needUrl} onClick={saveAndTest}>
        {busy ? '处理中…' : '保存并测试'}
      </button>
      <p className="muted small">保存端点 → 写入 Key → 真打一次接口,一步完成。</p>

      {note && <p className="muted small">{note}</p>}
      {result && <pre className={`endpoint-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</pre>}

      <details className="adv" open={advanced} onToggle={(e) => setAdvanced(e.target.open)}>
        <summary>高级(一般不用改)</summary>
        <div className="form-grid">
          <label>轻量模型(子代理用,留空则同主模型)
            <input value={form.flashModel} onChange={set('flashModel')} placeholder="留空即可" />
          </label>
          <label>API Key 环境变量名
            <input value={form.envKey} onChange={set('envKey')} placeholder="DEEPSEEK_API_KEY" />
          </label>
        </div>
      </details>
    </Fold>
  );
}

/** 可折叠分区(与 SetupPanel 内的同名组件保持一致的外观) */
function Fold({ title, hint, children }) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`fold ${open ? 'open' : ''}`}>
      <button className="fold-head" onClick={() => setOpen((v) => !v)}>
        <span className="fold-caret">{open ? '▾' : '▸'}</span>
        <b>{title}</b>
        {hint && <span className="muted small">{hint}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
