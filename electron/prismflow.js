/**
 * PrismFlowAgent(流光)集成客户端。
 *
 * 流光是一个开源的自动化资讯聚合系统(抓 GitHub Trending / 论文 / RSS / 社媒,AI 总结),
 * 官方提供 AI Interop API 供外部 Agent 接管。我们**通过 HTTP 调用**它,
 * 而不是把它的源码并入本仓库 —— 流光是 GPL-3.0,进程分离调用不影响本项目的 MIT 许可。
 *
 * API 约定(见其 AI_INTEROP.md):
 *   POST /api/ai/v1/register   {name} -> {apiKey, verificationUrl}
 *   GET  /api/ai/v1/context    动态操作手册(Markdown)
 *   GET  /api/ai/v1/discovery  可用 agents/workflows/tools
 *   POST /api/ai/v1/execute    {action,id,input}
 *   认证头:X-API-Key: sk_pf_...
 */
const fs = require('fs');
const path = require('path');

let _app = null;
let _safeStorage = null;
function init(app, safeStorage) { _app = app; _safeStorage = safeStorage; }

function cfgPath() { return path.join(_app.getPath('userData'), 'prismflow.json'); }

const DEFAULTS = { baseUrl: 'http://localhost:3000', agentName: 'RemoteAgentStudio' };

/** 归一化 base URL:补协议、去尾斜杠(纯函数,便于单测) */
function normalizeBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

/** 拼接 API 路径,避免出现双斜杠或漏斜杠 */
function apiUrl(baseUrl, pathname) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return '';
  const p = String(pathname || '').startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${p}`;
}

function _readRaw() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}

function _decryptKey(raw) {
  if (!raw || !raw.keyEnc) return '';
  try {
    if (_safeStorage && _safeStorage.isEncryptionAvailable())
      return _safeStorage.decryptString(Buffer.from(raw.keyEnc, 'base64'));
    return Buffer.from(raw.keyEnc, 'base64').toString('utf8');
  } catch (_) { return ''; }
}

/** 给界面的安全视图:不含明文 key */
function getConfig() {
  const raw = _readRaw();
  return {
    baseUrl: raw.baseUrl,
    agentName: raw.agentName || DEFAULTS.agentName,
    hasKey: !!raw.keyEnc,
    verificationUrl: raw.verificationUrl || ''
  };
}

/** apiKey: 传字符串写入,传 null 清除,不传则保持 */
function setConfig({ baseUrl, agentName, apiKey, verificationUrl } = {}) {
  const raw = _readRaw();
  const next = {
    baseUrl: baseUrl != null ? normalizeBaseUrl(baseUrl) : raw.baseUrl,
    agentName: agentName != null ? String(agentName).trim() : raw.agentName,
    verificationUrl: verificationUrl != null ? String(verificationUrl) : (raw.verificationUrl || ''),
    keyEnc: raw.keyEnc || ''
  };
  if (apiKey === null) next.keyEnc = '';
  else if (typeof apiKey === 'string' && apiKey.trim()) {
    const buf = (_safeStorage && _safeStorage.isEncryptionAvailable())
      ? _safeStorage.encryptString(apiKey.trim())
      : Buffer.from(apiKey.trim(), 'utf8');
    next.keyEnc = buf.toString('base64');
  }
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return getConfig();
}

async function request(pathname, { method = 'GET', body, timeoutMs = 30000, withAuth = true } = {}) {
  const raw = _readRaw();
  const url = apiUrl(raw.baseUrl, pathname);
  if (!url) throw new Error('未配置 PrismFlowAgent 地址(设置 → 资讯聚合)');
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) {
    const key = _decryptKey(raw);
    if (!key) throw new Error('尚未完成接入授权:请先在设置里点「注册并授权」');
    headers['X-API-Key'] = key;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method, headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (e) {
    throw new Error(
      e?.name === 'AbortError'
        ? `请求超时:${url}`
        : `连不上 PrismFlowAgent(${url}):${e?.message || e}。确认它已启动、地址与端口正确。`
    );
  } finally { clearTimeout(timer); }

  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`PrismFlowAgent 返回 HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

/** 自助注册:拿到 apiKey(待激活)与需要用户点击确认的 verificationUrl */
async function register(name) {
  const agentName = String(name || _readRaw().agentName || DEFAULTS.agentName).trim();
  const data = await request('/api/ai/v1/register', {
    method: 'POST', body: { name: agentName }, withAuth: false
  });
  const apiKey = data.apiKey || data.key || '';
  const verificationUrl = data.verificationUrl || data.verifyUrl || '';
  if (!apiKey) throw new Error('注册未返回 apiKey,请检查 PrismFlowAgent 版本与地址');
  setConfig({ agentName, apiKey, verificationUrl });
  return { verificationUrl, agentName };
}

const context = () => request('/api/ai/v1/context');
const discovery = () => request('/api/ai/v1/discovery');
const settings = () => request('/api/ai/v1/settings');
const execute = ({ action, id, input } = {}) =>
  request('/api/ai/v1/execute', { method: 'POST', body: { action, id, input }, timeoutMs: 300000 });

/** 探活:未授权也算"服务在线",便于区分"没启动"和"没授权" */
async function health() {
  const raw = _readRaw();
  if (!normalizeBaseUrl(raw.baseUrl)) return { online: false, authorized: false, error: '未配置地址' };
  try {
    await request('/api/ai/v1/discovery');
    return { online: true, authorized: true, error: '' };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/连不上|超时/.test(msg)) return { online: false, authorized: false, error: msg };
    return { online: true, authorized: false, error: msg };
  }
}

/**
 * 从 discovery 响应里提取可执行项(不同版本字段可能不同,做兼容)。
 * @returns [{action, id, name, description}]
 */
function extractCapabilities(data) {
  const out = [];
  const push = (action, list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || item.key || item.name || '').trim();
      if (!id) continue;
      out.push({
        action,
        id,
        name: String(item.name || item.title || id).slice(0, 80),
        description: String(item.description || item.desc || '').slice(0, 200)
      });
    }
  };
  const root = (data && typeof data === 'object') ? (data.data || data) : {};
  push('agent', root.agents);
  push('workflow', root.workflows);
  push('tool', root.tools);
  return out;
}

/** execute 返回结构不固定:尽量取出可读文本 */
function extractExecuteText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const candidates = [
    result.content, result.text, result.output, result.result,
    result.message, result.raw, result.data
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  // data 里再挖一层
  if (result.data && typeof result.data === 'object') {
    const inner = extractExecuteText(result.data);
    if (inner) return inner;
  }
  try { return JSON.stringify(result, null, 2); } catch (_) { return String(result); }
}

/** 生成让 codex 自动部署流光的指令(用户复制到对话即可) */
function buildDeployPrompt({ port = 3000 } = {}) {
  return `请在这台机器上部署开源项目 PrismFlowAgent(流光),用于自动聚合 AI 资讯/论文/开源项目:

1. 确认已安装 Node.js 20+ 与 pnpm(缺就装)
2. git clone https://github.com/justlovemaki/PrismFlowAgent.git 到合适目录
3. 按其 README 安装依赖:根目录 npm install;frontend 目录 pnpm install
4. 启动:npm run dev:all(后端默认 ${port} 端口,前端 5173)
5. 用 curl 验证 http://localhost:${port}/api/ai/v1/discovery 能返回内容(未授权返回 401 也算服务已起)
6. 最后告诉我:后端实际监听的地址和端口、前端登录地址、以及是否需要我提供 AI API Key

注意:只做部署与启动,不要修改我其它项目的文件。`;
}

module.exports = {
  init, getConfig, setConfig, register, context, discovery, settings, execute, health,
  normalizeBaseUrl, apiUrl, extractCapabilities, extractExecuteText, buildDeployPrompt
};
