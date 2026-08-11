/**
 * 语音相关纯函数(无 Electron 依赖,便于单测且可在 preload 直接复用):
 * - normalizeTranscribeUrl:把用户填的 base_url 归一化成转写端点
 * - interpretVoiceCommand:把转写文本映射成"确认/取消/选项号"指令
 */

/** OpenAI 兼容转写端点:baseUrl 可填到 /v1,自动补 /audio/transcriptions */
function normalizeTranscribeUrl(baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/audio\/transcriptions$/.test(u)) return u;
  return `${u}/audio/transcriptions`;
}

// 中文数字 → 阿拉伯数字(选项一般 1-8)
const CN_NUM = { 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8' };
const CONFIRM_WORDS = ['确认', '确定', '继续', '好的', '可以', '同意', '是的', '批准', 'confirm', 'continue', 'yes', 'ok', 'okay', 'sure', 'approve'];
const CANCEL_WORDS = ['取消', '停止', '不要', '不行', '拒绝', '否', 'cancel', 'stop', 'no', 'reject', 'deny'];

function hasAny(text, words) {
  return words.some((w) => text.includes(w));
}

/**
 * 把语音转写文本解释成可点击动作。
 * @param transcript 转写文本
 * @param ctx { mode:'confirm'|'options', options?:[{n,label}] }
 * @returns { value } 要传给 onQuickReply 的字符串,或 null(听不懂)
 */
function interpretVoiceCommand(transcript, ctx = {}) {
  const raw = String(transcript || '').trim();
  if (!raw) return null;
  const text = raw.toLowerCase();
  const options = Array.isArray(ctx.options) ? ctx.options : [];

  // 选项模式:优先匹配"第N个/N/中文数字/标签关键词"
  if (ctx.mode === 'options' && options.length) {
    // 数字(阿拉伯或中文)
    const digit = (text.match(/\b([1-8])\b/) || [])[1]
      || (Object.keys(CN_NUM).find((c) => raw.includes(c)) ? CN_NUM[Object.keys(CN_NUM).find((c) => raw.includes(c))] : null);
    if (digit && options.some((o) => String(o.n) === digit)) return digit;
    // 标签子串命中(取标签前若干字)
    const byLabel = options.find((o) => {
      const label = String(o.label || '').toLowerCase().trim();
      return label.length >= 2 && (text.includes(label) || label.includes(text));
    });
    if (byLabel) return String(byLabel.n);
    // 选项模式下也允许"取消"
    if (hasAny(text, CANCEL_WORDS)) return '取消';
    return null;
  }

  // 确认模式:取消优先(更安全),再确认
  if (hasAny(text, CANCEL_WORDS)) return '取消';
  if (hasAny(text, CONFIRM_WORDS)) return '确认';
  return null;
}

module.exports = { normalizeTranscribeUrl, interpretVoiceCommand, CONFIRM_WORDS, CANCEL_WORDS };
