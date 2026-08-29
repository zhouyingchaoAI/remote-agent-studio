/**
 * 斜杠命令(/ 开头)—— 对标 codex 的命令面板。
 * 纯解析层:只负责"这句话是什么命令、参数是什么、有哪些候选",
 * 具体动作由调用方执行,便于单测与复用。
 */

export const COMMANDS = [
  { name: 'goal', args: '<目标> [--check 命令] [--plan 文件] | check <命令> | plan <文件> | replan | budget 5m | status | pause | resume | clear',
    desc: '目标模式:先拆成清单再逐条推进,状态条显示「第 N / M 步」。--check 以命令退出码 0 为达成判据(强烈建议);replan 重新拆解' },
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
  if (['status', 'pause', 'resume', 'clear', 'stop', 'replan'].includes(lower)) {
    return { sub: lower === 'stop' ? 'pause' : lower };
  }
  // /goal max 100 —— 大任务一次把预算调够,不用反复点「继续」
  const max = lower.match(/^max\s+(\d+)$/);
  if (max) return { sub: 'max', rounds: parseInt(max[1], 10) };
  /* /goal budget 5m —— token 预算才是真闸门(一轮可能烧 2k 也可能 200k) */
  const budget = lower.match(/^budget\s+(\S+)$/);
  if (budget) return { sub: 'budget', raw: budget[1] };
  /* /goal check <命令> —— 给当前目标设一条**验收命令**,退出码 0 才算达成。
     这是目标模式里唯一的硬判据:模型说"已完成"的成本是零,
     而 `npm test` 或 `curl -fsS .../health` 不会撒谎。 */
  const check = a.match(/^check\s+([\s\S]+)$/i);
  if (check) return { sub: 'check', command: check[1].trim() };
  /* /goal plan <文件路径> —— 指定一份计划文件,把"第 12 轮"换成「第 3 / 18 步」。
     路径不含空格,所以这里可以严格些,顺手挡住把整句话当路径。 */
  const plan = a.match(/^plan\s+(\S+)$/i);
  if (plan) return { sub: 'plan', planPath: plan[1].trim() };

  /* 设目标时就带上验收命令 / 计划文件:
       /goal 部署 vLLM --check curl -fsS localhost:8000/v1/models
       /goal 重构 XXX --plan /root/progress.md
   *
   * 两个后缀都要能识别,且**先切 --plan 再切 --check**:
   * --check 的值会贪婪吃到行尾,先切它的话 `--plan` 就被吞进验收命令里了。
   */
  let rest = a;
  let planPath = '';
  let verifyCommand = '';
  const mPlan = rest.match(/^([\s\S]+?)\s+--plan\s+(\S+)\s*([\s\S]*)$/);
  if (mPlan) {
    planPath = mPlan[2].trim();
    rest = `${mPlan[1]}${mPlan[3] ? ' ' + mPlan[3] : ''}`.trim();
  }
  const mCheck = rest.match(/^([\s\S]+?)\s+--check\s+([\s\S]+)$/);
  if (mCheck) { verifyCommand = mCheck[2].trim(); rest = mCheck[1].trim(); }
  if (planPath || verifyCommand) return { sub: 'set', text: rest, verifyCommand, planPath };
  return { sub: 'set', text: a };
}

/** /help 的展示文本 */
export function helpText() {
  return ['可用命令:', ...COMMANDS.map((c) => `/${c.name}${c.args ? ' ' + c.args : ''} —— ${c.desc}`)].join('\n');
}
