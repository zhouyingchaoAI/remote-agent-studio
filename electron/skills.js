/**
 * Agent Skills(技能)—— 跨引擎通用能力包。
 *
 * 2025 年 12 月起 SKILL.md 成为开放标准,Claude Code / Codex / Cursor / Gemini CLI
 * 用的是同一套格式:一个目录 + 一个带 YAML frontmatter 的 SKILL.md。
 * 引擎会根据 description 自动判断何时加载,不占常驻上下文。
 *
 * 本模块只做纯逻辑(解析/校验/路径映射),下发动作在 skillsService.js,
 * 这样格式规则可以脱离 SSH 单测。
 */

/** 各引擎读取技能的目录(相对 $HOME) */
const ENGINE_SKILL_DIRS = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  dsh: '.dsh/skills',
  // deepseek 引擎复用 claude CLI,所以共用 claude 的目录
  deepseek: '.claude/skills'
};

/** 去重后的目录列表 —— 下发时避免把同一个目录写两遍 */
function uniqueDirsFor(engines = []) {
  const dirs = engines.map((e) => ENGINE_SKILL_DIRS[e]).filter(Boolean);
  return [...new Set(dirs)];
}

/**
 * 技能名规范:小写字母、数字、连字符。
 * 这既是目录名也是 Codex 里 `$name` 的调用名,不能有空格或中文,
 * 否则 shell 路径和调用都会出问题。
 */
function safeSkillName(name = '') {
  return String(name || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** 解析 YAML frontmatter 里的一行 key: value(够用即可,不引入 yaml 依赖) */
function parseScalar(raw = '') {
  let v = String(raw).trim();
  // 去掉成对引号
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

/**
 * 解析 SKILL.md。
 * @returns {{ok, name, description, body, frontmatter, error}}
 */
function parseSkill(text = '') {
  const src = String(text || '').replace(/^﻿/, ''); // 去 BOM
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { ok: false, error: '缺少 YAML frontmatter(文件需以 --- 开头)', body: src, frontmatter: {} };

  const [, head, body] = m;
  const frontmatter = {};
  const lines = head.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2];

    // 块标量(| 或 >):把后续缩进行并进来。官方技能的长 description 常用这种写法
    if (/^[|>][-+]?\s*$/.test(value.trim())) {
      const fold = value.trim().startsWith('>');
      const collected = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        collected.push(lines[++i].replace(/^\s+/, ''));
      }
      value = collected.join(fold ? ' ' : '\n');
    } else {
      value = parseScalar(value);
    }
    frontmatter[key] = value;
  }

  const name = String(frontmatter.name || '').trim();
  const description = String(frontmatter.description || '').trim();
  const result = { ok: true, name, description, body: body.trim(), frontmatter };

  if (!name) return { ...result, ok: false, error: 'frontmatter 缺少 name' };
  if (!description) return { ...result, ok: false, error: 'frontmatter 缺少 description' };
  return result;
}

/**
 * 校验并给出可执行的改进建议。
 * description 是引擎决定「要不要加载这个技能」的唯一依据,写不好技能就永远不触发 ——
 * 这是社区里技能失效最常见的原因,所以单独提示。
 */
function lintSkill(text = '') {
  const parsed = parseSkill(text);
  const warnings = [];
  if (!parsed.ok) return { ...parsed, warnings };

  if (parsed.name !== safeSkillName(parsed.name)) {
    warnings.push(`name「${parsed.name}」含非法字符,建议改为「${safeSkillName(parsed.name)}」`);
  }
  if (parsed.description.length < 30) {
    warnings.push('description 过短:引擎靠它判断何时加载,应写清「什么场景用/什么场景不用」');
  }
  if (parsed.description.length > 1024) {
    warnings.push('description 过长(>1024 字符),建议精简到一两句触发条件');
  }
  if (!parsed.body) warnings.push('正文为空,技能被加载后没有任何指导');
  return { ...parsed, warnings };
}

/** 由结构化字段生成 SKILL.md 文本 */
function renderSkill({ name, description, body = '' }) {
  // description 里的换行会破坏 frontmatter,压成一行
  const desc = String(description || '').replace(/\s*\n\s*/g, ' ').trim();
  return `---\nname: ${safeSkillName(name)}\ndescription: ${desc}\n---\n\n${String(body).trim()}\n`;
}

/** 远程/本地技能目录下某个技能的完整相对路径 */
function skillPath(engine, name) {
  const dir = ENGINE_SKILL_DIRS[engine];
  if (!dir) throw new Error(`未知引擎: ${engine}`);
  return `${dir}/${safeSkillName(name)}/SKILL.md`;
}

module.exports = {
  ENGINE_SKILL_DIRS, uniqueDirsFor, safeSkillName,
  parseSkill, lintSkill, renderSkill, skillPath
};
