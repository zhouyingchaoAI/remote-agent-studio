/**
 * 语音转写(STT)配置与调用。
 * 走 OpenAI 兼容的 /audio/transcriptions 端点(OpenAI Whisper、通义 ASR、各中转站通用)。
 * 配置存 userData/stt.json;API Key 用 safeStorage 加密,绝不明文落盘,也不返回给渲染层。
 */
const fs = require('fs');
const path = require('path');
const { normalizeTranscribeUrl } = require('./voice');

let _app = null;
let _safeStorage = null;
function init(app, safeStorage) { _app = app; _safeStorage = safeStorage; }

function cfgPath() { return path.join(_app.getPath('userData'), 'stt.json'); }

const DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', language: '' };

function _readRaw() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}

function _decryptKey(raw) {
  if (!raw || !raw.keyEnc) return '';
  try {
    if (_safeStorage && _safeStorage.isEncryptionAvailable())
      return _safeStorage.decryptString(Buffer.from(raw.keyEnc, 'base64'));
    return Buffer.from(raw.keyEnc, 'base64').toString('utf8'); // 兜底(无加密支持时)
  } catch (_) { return ''; }
}

/** 返回给渲染层的安全视图:不含明文 key,只报是否已设置 */
function getConfig() {
  const raw = _readRaw();
  return { baseUrl: raw.baseUrl, model: raw.model, language: raw.language || '', hasKey: !!raw.keyEnc };
}

/** 保存配置;apiKey 传空字符串=不改动,传 null=清除 */
function setConfig({ baseUrl, model, language, apiKey } = {}) {
  const raw = _readRaw();
  const next = {
    baseUrl: baseUrl != null ? String(baseUrl).trim() : raw.baseUrl,
    model: model != null ? String(model).trim() : raw.model,
    language: language != null ? String(language).trim() : (raw.language || ''),
    keyEnc: raw.keyEnc || ''
  };
  if (apiKey === null) {
    next.keyEnc = '';
  } else if (typeof apiKey === 'string' && apiKey.trim()) {
    const buf = (_safeStorage && _safeStorage.isEncryptionAvailable())
      ? _safeStorage.encryptString(apiKey.trim())
      : Buffer.from(apiKey.trim(), 'utf8');
    next.keyEnc = buf.toString('base64');
  }
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(next, null, 2));
  return getConfig();
}

/**
 * 转写:audioBase64 为渲染层录制的音频(webm/mp4/wav)。
 * @returns { text }
 */
async function transcribe({ audioBase64, mimeType, filename } = {}) {
  const raw = _readRaw();
  const url = normalizeTranscribeUrl(raw.baseUrl);
  const key = _decryptKey(raw);
  if (!url) throw new Error('未配置语音转写端点(设置 → 语音输入)');
  if (!key) throw new Error('未配置语音转写 API Key(设置 → 语音输入)');
  if (!audioBase64) throw new Error('没有录到音频');

  const bytes = Buffer.from(audioBase64, 'base64');
  const form = new FormData();
  const name = filename || (mimeType && mimeType.includes('mp4') ? 'audio.mp4' : 'audio.webm');
  form.append('file', new Blob([bytes], { type: mimeType || 'audio/webm' }), name);
  form.append('model', raw.model || DEFAULTS.model);
  if (raw.language) form.append('language', raw.language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal
    });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`转写失败 (HTTP ${res.status})${detail ? ': ' + detail.slice(0, 300) : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  const text = (data.text || data.result || '').trim();
  return { text };
}

module.exports = { init, getConfig, setConfig, transcribe, DEFAULTS };
