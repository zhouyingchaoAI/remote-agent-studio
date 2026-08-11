/**
 * 技能下发:把 SKILL.md 装到本机/远程主机的各引擎技能目录。
 *
 * 传输一律走 base64 —— 技能正文里有反引号、单双引号、$、换行、中文,
 * 直接拼进 shell 命令必然被转义问题咬到。base64 只含 A-Za-z0-9+/=,绝对安全。
 */
const fs = require('fs');
const path = require('path');
const { parseSkill, lintSkill, safeSkillName, ENGINE_SKILL_DIRS, uniqueDirsFor } = require('./skills');

/** 内置技能目录(随 asar 一起打包,不需要额外的 extraResources 配置) */
const BUILTIN_DIR = path.join(__dirname, 'skills-builtin');

/** 单条命令携带的 base64 上限,超出则分块追加,避免撞 ARG_MAX */
const CHUNK = 60 * 1024;

/** 扫描内置技能库 */
function listBuiltin(dir = BUILTIN_DIR) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }

  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'SKILL.md');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const parsed = lintSkill(text);
    out.push({
      id: ent.name,
      name: parsed.name || ent.name,
      description: parsed.description || '',
      ok: parsed.ok,
      error: parsed.error || '',
      warnings: parsed.warnings || [],
      builtin: true,
      content: text
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读取一条内置技能的原文(供界面预览) */
function readBuiltin(id, dir = BUILTIN_DIR) {
  // safeSkillName 已经把 . / \ 全部剥掉,不存在路径穿越的余地
  const safe = safeSkillName(id);
  if (!safe) throw new Error('技能名非法');
  return fs.readFileSync(path.join(dir, safe, 'SKILL.md'), 'utf8');
}

/* ---------------------------------------------------------------- 命令构造 */

/**
 * 生成把内容写入远程文件的命令序列(posix)。
 * base64 -d 在 GNU 上是 -d,老版 macOS 只有 -D,两个都试。
 */
function writeFileCommands(remotePath, content) {
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const dir = remotePath.replace(/\/[^/]*$/, '');
  const cmds = [`mkdir -p ${dir}`];

  const tmp = `${remotePath}.b64.tmp`;
  cmds.push(`: > ${tmp}`);
  for (let i = 0; i < b64.length; i += CHUNK) {
    cmds.push(`printf %s '${b64.slice(i, i + CHUNK)}' >> ${tmp}`);
  }
  cmds.push(`(base64 -d < ${tmp} > ${remotePath} 2>/dev/null || base64 -D < ${tmp} > ${remotePath}) && rm -f ${tmp}`);
  return cmds;
}

/** Windows 原生主机:走 PowerShell 的 base64 解码 */
function writeFileCommandsWindows(remotePath, content) {
  const b64 = Buffer.from(String(content), 'utf8').toString('base64');
  const win = remotePath.replace(/^~\//, '$HOME\\').replace(/\//g, '\\');
  const dir = win.replace(/\\[^\\]*$/, '');
  return [
    `New-Item -ItemType Directory -Force -Path "${dir}" | Out-Null`,
    `[IO.File]::WriteAllBytes("${win}", [Convert]::FromBase64String("${b64}"))`
  ];
}

/* ---------------------------------------------------------------- 下发动作 */

/**
 * 把一批技能装到指定引擎的技能目录。
 * @param ssh   SSHManager(本机会话同样适用,它自己区分 isLocal)
 * @param opts  { engines:['claude','codex'], skills:[{name, content}], log }
 */
async function installSkills(ssh, { engines = [], skills = [], log = () => {} } = {}) {
  const dirs = uniqueDirsFor(engines);
  if (!dirs.length) throw new Error('未选择目标引擎');
  if (!skills.length) throw new Error('未选择技能');

  const isWin = !!ssh.isWindowsNative;
  const results = [];

  for (const skill of skills) {
    const parsed = parseSkill(skill.content);
    const name = safeSkillName(parsed.name || skill.name);
    if (!name) { results.push({ name: skill.name, ok: false, error: '技能名非法' }); continue; }
    if (!parsed.ok) { results.push({ name, ok: false, error: parsed.error }); continue; }

    for (const dir of dirs) {
      const target = `${isWin ? '$HOME/' : '~/'}${dir}/${name}/SKILL.md`;
      const cmds = isWin
        ? writeFileCommandsWindows(target, skill.content)
        : writeFileCommands(target, skill.content);
      const joined = isWin ? cmds.join('; ') : cmds.join(' && ');

      const r = await ssh.exec(joined);
      const ok = r.code === 0;
      log(`${ok ? '✓' : '✗'} ${name} → ~/${dir}/${name}/SKILL.md${ok ? '' : ' :' + (r.stderr || '').trim()}\n`);
      results.push({ name, dir, ok, error: ok ? '' : (r.stderr || `exit ${r.code}`) });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  log(`\n完成:${okCount}/${results.length} 项写入成功\n`);
  return { results, ok: okCount === results.length, okCount, total: results.length };
}

/** 列出主机上已安装的技能(读 frontmatter 的 name/description) */
async function listInstalled(ssh, engine) {
  const dir = ENGINE_SKILL_DIRS[engine];
  if (!dir) throw new Error(`未知引擎: ${engine}`);
  if (ssh.isWindowsNative) {
    const r = await ssh.exec(`Get-ChildItem -Path "$HOME\\${dir.replace(/\//g, '\\')}" -Filter SKILL.md -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.Directory.Name }`);
    return String(r.stdout || '').split(/\r?\n/).filter(Boolean).map((name) => ({ name, description: '' }));
  }

  // 每个技能输出 <名字>\t<description 首行>,一次 exec 拿全
  const cmd = `for d in ~/${dir}/*/; do `
    + `[ -f "$d/SKILL.md" ] || continue; `
    + `n=$(basename "$d"); `
    + `desc=$(sed -n '1,20p' "$d/SKILL.md" | grep -m1 -i '^description:' | cut -c13- | cut -c1-160); `
    + `printf '%s\\t%s\\n' "$n" "$desc"; done`;
  const r = await ssh.exec(cmd);
  return String(r.stdout || '')
    .split(/\r?\n/).filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split('\t');
      return { name: name.trim(), description: rest.join('\t').trim() };
    })
    .filter((s) => s.name);
}

/** 删除主机上的一条技能 */
async function removeSkill(ssh, engine, name) {
  const dir = ENGINE_SKILL_DIRS[engine];
  const safe = safeSkillName(name);
  if (!dir || !safe) throw new Error('参数非法');
  const r = ssh.isWindowsNative
    ? await ssh.exec(`Remove-Item -Recurse -Force "$HOME\\${dir.replace(/\//g, '\\')}\\${safe}" -ErrorAction SilentlyContinue`)
    : await ssh.exec(`rm -rf ~/${dir}/${safe}`);
  return { ok: r.code === 0, error: r.stderr || '' };
}

module.exports = {
  BUILTIN_DIR, listBuiltin, readBuiltin,
  writeFileCommands, writeFileCommandsWindows,
  installSkills, listInstalled, removeSkill
};
