/**
 * 每日速览(Daily Brief):让 agent 联网收集 AI 情报,产出结构化四栏内容。
 *
 * 模型输出不可控,所以这里做两件事:
 *  1) 提示词强约束成"只输出 JSON"
 *  2) 解析端极度容错(围栏、前后废话、尾随逗号),并对字段做归一化与安全校验
 * 纯函数,便于单测。
 */

const SECTIONS = ['news', 'ideas', 'papers', 'repos'];

/** 生成给 agent 的提示词;date 用于提示时效性,topics 可自定义关注方向 */
function buildBriefPrompt({ date, topics = '' } = {}) {
  const focus = topics.trim() ? `\n特别关注方向:${topics.trim()}` : '';
  return `你是我的 AI 情报助理。今天是 ${date}。请联网检索,给我一份当日 AI 领域速览。${focus}

需要四个部分:
1. news —— AI 最新资讯(模型发布、产品更新、行业动态),6~8 条
2. ideas —— AI 产品创意(结合当下技术与真实痛点,可落地的产品点子),4~6 条
3. papers —— 最新 AI 论文(优先 arXiv 近期、有影响力的),5~6 条
4. repos —— GitHub 优秀开源项目(近期热门或高质量,注明用途),5~6 条

硬性要求:
- 只输出一个 JSON 对象,不要任何解释文字、不要 markdown 围栏之外的内容
- url 必须是你实际检索到的真实链接,不确定就不要编,宁可少给几条
- summary 用中文,一到两句话说清"是什么 + 为什么值得看"
- 若某部分实在没检索到内容,给空数组,不要编造

严格按此结构输出:
{
  "news":   [{"title":"","summary":"","url":"","source":""}],
  "ideas":  [{"title":"","summary":"","basis":""}],
  "papers": [{"title":"","summary":"","url":"","authors":""}],
  "repos":  [{"name":"","summary":"","url":"","lang":"","stars":""}]
}`;
}

/** 在一段文本里找出最外层完整的 JSON 对象(能跳过字符串内的花括号) */
function sliceJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return '';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

/**
 * 从模型输出中提取 JSON。容忍:```json 围栏、前后解释文字、尾随逗号。
 * @returns 解析后的对象,失败返回 null
 */
function extractBriefJson(output) {
  const text = String(output || '');
  if (!text.trim()) return null;
  // 优先取围栏内内容
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : '', text].filter(Boolean);
  for (const candidate of candidates) {
    const raw = sliceJsonObject(candidate);
    if (!raw) continue;
    for (const attempt of [raw, raw.replace(/,\s*([}\]])/g, '$1')]) { // 去尾随逗号
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch (_) { /* 试下一种 */ }
    }
  }
  return null;
}

const clean = (v, max = 400) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** 仅接受 http(s) 链接,挡掉 javascript: 之类 */
const safeUrl = (v) => (/^https?:\/\/\S+$/i.test(String(v ?? '').trim()) ? String(v).trim() : '');

/** 归一化成界面可直接渲染的结构;脏数据一律丢弃而不是硬塞 */
function normalizeBrief(parsed, { maxPerSection = 12 } = {}) {
  const out = { news: [], ideas: [], papers: [], repos: [] };
  if (!parsed || typeof parsed !== 'object') return out;

  for (const key of SECTIONS) {
    const list = Array.isArray(parsed[key]) ? parsed[key] : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const title = clean(item.title || item.name, 160);
      const summary = clean(item.summary || item.desc || item.description, 400);
      if (!title) continue; // 无标题的条目没有展示价值
      const entry = { title, summary, url: safeUrl(item.url || item.link) };
      if (key === 'news') entry.meta = clean(item.source, 60);
      if (key === 'ideas') entry.meta = clean(item.basis, 200);
      if (key === 'papers') entry.meta = clean(item.authors, 120);
      if (key === 'repos') {
        entry.meta = [clean(item.lang, 30), clean(item.stars, 20)].filter(Boolean).join(' · ');
      }
      out[key].push(entry);
      if (out[key].length >= maxPerSection) break;
    }
  }
  return out;
}

/** 四个栏目是否全空(用于判断"这次跑失败了") */
function isBriefEmpty(brief) {
  return SECTIONS.every((k) => !brief || !Array.isArray(brief[k]) || brief[k].length === 0);
}

/** 本地日期 YYYY-MM-DD(按用户时区,不用 UTC 以免"今天"错位) */
function todayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

module.exports = {
  SECTIONS, buildBriefPrompt, extractBriefJson, normalizeBrief, isBriefEmpty, todayKey, sliceJsonObject
};
