/**
 * 斜杠命令(/ 开头)—— 对标 codex 的命令面板。
 * 纯解析层:只负责"这句话是什么命令、参数是什么、有哪些候选",
 * 具体动作由调用方执行,便于单测与复用。
 */

export const COMMANDS = [
  { name: 'goal', args: '<目标描述> | status | pause | resume | max <轮数> | clear',
    desc: '目标模式:设定目标后跨轮自动推进,直到达成或触发上限' },
  { name: 'team', args: '<执行方>+<审查方> | status | off',
    desc: '团队模式:一个引擎干活、另一个审查,配合目标模式自动推进(如 /team claude+codex)' },
  { name: 'engine', args: 'codex | claude | deepseek | dsh',
    desc: '切换引擎(同对话内上下文自动接力)' },
  { name: 'model', args: '<模型名>', desc: '切换模型,留空恢复默认' },
  { name: 'mode', args: 'workspace | system', desc: '切换权限模式' },
  { name: 'auto', args: 'on | off', desc: '开关全自动(自动确认)' },
  { name: 'github', args: 'status | login | sync',
    desc: 'GitHub 登录:查看状态 / 设备流登录 / 把本机凭据下发到当前远程主机' },
  { name: 'skill', args: '', desc: '打开技能管理(内置技能库 / 主机已装 / 技能市场)' },
  { name: 'new', args: '', desc: '新建对话' },
  { name: 'export', args: '', desc: '导出当前对话为 Markdown' },
  { name: 'clear', args: '', desc: '清空输入框' },
  { name: 'help', args: '', desc: '列出全部命令' }
];

/** 是否处于"正在输入命令"状态(输入框以 / 开头且只有一行) */
export function isSlashInput(text = '') {
  const t = String(text || '');
  return t.startsWith('/') && !t.includes('\n');
}

/**
 * 解析命令。
 * @returns {isCommand, name, args, known} —— known=false 表示 / 开头但不是已知命令
 */
export function parseSlash(text = '') {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return { isCommand: false };
  const m = t.match(/^\/(\S*)\s*([\s\S]*)$/);
  const name = (m?.[1] || '').toLowerCase();
  const args = (m?.[2] || '').trim();
  const known = COMMANDS.some((c) => c.name === name);
  return { isCommand: true, name, args, known };
}

/** 根据已输入的前缀给出候选命令(用于补全菜单) */
export function matchCommands(text = '') {
  if (!isSlashInput(text)) return [];
  const { name } = parseSlash(text);
  // 已经输入完整命令名且后面跟了空格 -> 不再弹菜单(在填参数了)
  if (/^\/\S+\s/.test(text)) return [];
  return COMMANDS.filter((c) => c.name.startsWith(name || ''));
}

/** 把选中的命令补全进输入框(带参数的命令补一个空格等你填) */
export function applyCompletion(command) {
  return command.args ? `/${command.name} ` : `/${command.name}`;
}

/** /goal 的子动作解析 */
export function parseGoalArgs(args = '') {
  const a = String(args || '').trim();
  if (!a) return { sub: 'status' };
  const lower = a.toLowerCase();
  if (['status', 'pause', 'resume', 'clear', 'stop'].includes(lower)) {
    return { sub: lower === 'stop' ? 'pause' : lower };
  }
  // /goal max 100 —— 大任务一次把预算调够,不用反复点「继续」
  const max = lower.match(/^max\s+(\d+)$/);
  if (max) return { sub: 'max', rounds: parseInt(max[1], 10) };
  return { sub: 'set', text: a };
}

/** /help 的展示文本 */
export function helpText() {
  return ['可用命令:', ...COMMANDS.map((c) => `/${c.name}${c.args ? ' ' + c.args : ''} —— ${c.desc}`)].join('\n');
}
