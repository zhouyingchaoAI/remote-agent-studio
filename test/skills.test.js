const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseSkill, lintSkill, renderSkill, safeSkillName, uniqueDirsFor, skillPath, ENGINE_SKILL_DIRS
} = require('../electron/skills');
const {
  listBuiltin, writeFileCommands, writeFileCommandsWindows, BUILTIN_DIR
} = require('../electron/skillsService');
const { extractSkillEntries, parseRepoSpec } = require('../electron/skillsMarket');

/* ------------------------------------------------------------ 解析 */

test('解析官方格式的 SKILL.md(引号 description + 正文)', () => {
  // 取自 anthropics/skills 的真实写法:description 很长且带引号
  const src = `---
name: pdf
description: "Use this skill whenever the user wants to do anything with PDF files, including reading, merging, splitting, or creating PDFs."
---

# PDF 处理

正文内容。
`;
  const r = parseSkill(src);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'pdf');
  assert.match(r.description, /^Use this skill whenever/);
  assert.ok(!r.description.includes('"'), 'description 的引号应被剥掉');
  assert.match(r.body, /^# PDF 处理/);
});

test('解析块标量写法的 description(折叠成一行)', () => {
  const src = `---
name: demo
description: >
  第一行描述
  第二行描述
extra: 忽略我
---
正文
`;
  const r = parseSkill(src);
  assert.equal(r.ok, true);
  assert.equal(r.description, '第一行描述 第二行描述');
  assert.equal(r.frontmatter.extra, '忽略我');
});

test('缺 frontmatter / 缺字段时给出明确错误,而不是静默通过', () => {
  assert.equal(parseSkill('# 只有正文').ok, false);
  assert.match(parseSkill('# 只有正文').error, /frontmatter/);

  const noName = parseSkill('---\ndescription: 有描述\n---\n正文');
  assert.equal(noName.ok, false);
  assert.match(noName.error, /name/);

  const noDesc = parseSkill('---\nname: foo\n---\n正文');
  assert.equal(noDesc.ok, false);
  assert.match(noDesc.error, /description/);
});

test('BOM 与 CRLF 不影响解析(Windows 上编辑过的文件)', () => {
  const src = '﻿---\r\nname: foo\r\ndescription: 一段足够长的描述用于通过校验检查\r\n---\r\n正文\r\n';
  const r = parseSkill(src);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'foo');
});

test('技能名规范化:中文/空格/大写都能落到合法目录名', () => {
  assert.equal(safeSkillName('Verify Before Done'), 'verify-before-done');
  assert.equal(safeSkillName('  --Foo__Bar--  '), 'foo-bar');
  assert.equal(safeSkillName('中文技能'), ''); // 全中文没有合法字符,应判为非法
  assert.equal(safeSkillName('../../etc/passwd'), 'etc-passwd'); // 路径穿越被剥干净
});

test('lint 提示 description 过短(引擎靠它判断是否加载)', () => {
  const r = lintSkill('---\nname: foo\ndescription: 太短\n---\n正文');
  assert.ok(r.warnings.some((w) => w.includes('过短')));
});

test('renderSkill 生成的内容能被 parseSkill 读回来', () => {
  const out = renderSkill({
    name: 'My Skill', description: '一段\n跨行的描述,应该被压成一行才不会破坏 frontmatter', body: '# 标题\n\n内容'
  });
  const back = parseSkill(out);
  assert.equal(back.ok, true);
  assert.equal(back.name, 'my-skill');
  assert.ok(!back.description.includes('\n'));
});

/* ------------------------------------------------------------ 目录映射 */

test('deepseek 复用 claude 目录,下发时不重复写两遍', () => {
  assert.equal(ENGINE_SKILL_DIRS.deepseek, ENGINE_SKILL_DIRS.claude);
  assert.deepEqual(uniqueDirsFor(['claude', 'deepseek']), ['.claude/skills']);
  assert.deepEqual(uniqueDirsFor(['claude', 'codex', 'dsh']),
    ['.claude/skills', '.codex/skills', '.dsh/skills']);
  assert.deepEqual(uniqueDirsFor(['不存在的引擎']), []);
});

test('skillPath 拼出各引擎的正确路径', () => {
  assert.equal(skillPath('codex', 'Verify Before Done'), '.codex/skills/verify-before-done/SKILL.md');
  assert.throws(() => skillPath('nope', 'x'), /未知引擎/);
});

/* ------------------------------------------------------------ 写入命令(真跑一遍) */

test('生成的写入命令在真实 shell 里能还原出一字不差的内容', () => {
  // 只断言字符串没意义 —— 转义问题只有真跑才暴露。
  // 内容里塞满 shell 元字符:单双引号、反引号、$、换行、中文、emoji
  const nasty = `---
name: nasty
description: 含 'single' 与 "double" 引号、\`反引号\`、$VAR、$(whoami)、中文与 emoji 🧩 的描述
---

# 标题

\`\`\`bash
echo "hello $USER" && rm -rf /tmp/nope || true
printf '%s\\n' 'it'"'"'s tricky'
\`\`\`

结尾中文。
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-skill-'));
  const target = path.join(tmp, 'sub', 'SKILL.md');
  const cmd = writeFileCommands(target, nasty).join(' && ');

  execFileSync('sh', ['-c', cmd], { stdio: 'pipe' });

  assert.equal(fs.readFileSync(target, 'utf8'), nasty, '还原内容必须与原文完全一致');
  assert.equal(fs.existsSync(`${target}.b64.tmp`), false, '临时文件应被清理');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('超长内容会分块写入,不会撞 ARG_MAX', () => {
  const big = '---\nname: big\ndescription: ' + 'x'.repeat(100) + '\n---\n' + 'A'.repeat(200 * 1024);
  const cmds = writeFileCommands('~/x/SKILL.md', big);
  const appends = cmds.filter((c) => c.startsWith('printf %s'));
  assert.ok(appends.length > 1, `应分成多块,实际 ${appends.length} 块`);
  // 每块 base64 都不超过限额
  for (const c of appends) assert.ok(c.length < 70 * 1024);
});

test('写入命令里没有裸的内容拼接(全部走 base64)', () => {
  const cmds = writeFileCommands('~/a/SKILL.md', '危险内容 $(rm -rf /) `whoami`').join(' && ');
  assert.ok(!cmds.includes('rm -rf /'), '原始内容不应出现在命令里');
  assert.ok(!cmds.includes('whoami'));
  assert.match(cmds, /base64 -d|base64 -D/);
});

test('Windows 主机走 PowerShell 的 base64 解码', () => {
  const cmds = writeFileCommandsWindows('$HOME/.claude/skills/foo/SKILL.md', 'hi');
  assert.match(cmds.join('; '), /FromBase64String/);
  assert.match(cmds.join('; '), /New-Item -ItemType Directory/);
  assert.ok(!cmds.join('; ').includes('/'), '路径应已转成反斜杠');
});

/* ------------------------------------------------------------ 内置技能库 */

test('内置技能全部格式合法且无告警(自己写的东西先过自己的校验)', () => {
  const list = listBuiltin();
  assert.ok(list.length >= 8, `内置技能至少 8 条,实际 ${list.length}`);
  for (const s of list) {
    assert.equal(s.ok, true, `${s.id} 解析失败:${s.error}`);
    assert.deepEqual(s.warnings, [], `${s.id} 有告警:${s.warnings.join(';')}`);
    assert.equal(s.name, safeSkillName(s.name), `${s.id} 的 name 不是合法目录名`);
    assert.equal(s.name, s.id, `${s.id} 的目录名与 frontmatter name 应一致`);
    assert.ok(s.description.length >= 30, `${s.id} 描述过短`);
    assert.ok(s.content.length > 500, `${s.id} 正文过于单薄`);
  }
});

test('内置技能目录名唯一,不会互相覆盖', () => {
  const names = listBuiltin().map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('内置技能真实存在于打包目录内(避免 asar 打包漏文件)', () => {
  assert.ok(fs.existsSync(BUILTIN_DIR));
  assert.ok(BUILTIN_DIR.includes(`electron${path.sep}skills-builtin`),
    '必须放在 electron/ 下,否则 package.json 的 files 白名单不会打包它');
});

/* ------------------------------------------------------------ 市场 */

test('从 GitHub tree 响应里筛出技能条目', () => {
  // 贴近真实结构:混有 README、脚本、非技能目录
  const tree = [
    { path: 'README.md', type: 'blob' },
    { path: 'document-skills/pdf/SKILL.md', type: 'blob', size: 4210 },
    { path: 'document-skills/pdf/scripts/fill.py', type: 'blob' },
    { path: 'document-skills/docx/SKILL.md', type: 'blob', size: 8100 },
    { path: 'artifacts-builder/SKILL.md', type: 'blob', size: 1200 },
    { path: 'document-skills', type: 'tree' },
    { path: 'notes/SKILL.md.bak', type: 'blob' }
  ];
  const out = extractSkillEntries(tree, 'anthropics/skills');
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((s) => s.name), ['artifacts-builder', 'docx', 'pdf']);
  assert.equal(out.find((s) => s.name === 'pdf').category, 'document-skills');
  assert.equal(out.find((s) => s.name === 'artifacts-builder').category, '');
  assert.equal(out[0].repo, 'anthropics/skills');
});

test('仓库地址校验:挡住拼进 URL 的注入', () => {
  assert.equal(parseRepoSpec('anthropics/skills'), 'anthropics/skills');
  assert.equal(parseRepoSpec('https://github.com/openai/skills.git'), 'openai/skills');
  assert.equal(parseRepoSpec('  owner/repo  '), 'owner/repo');
  for (const bad of ['../../etc', 'a/b/c', 'evil.com/x?y=1', 'owner', '', 'a/b;rm -rf /']) {
    assert.equal(parseRepoSpec(bad), null, `应拒绝: ${bad}`);
  }
});
