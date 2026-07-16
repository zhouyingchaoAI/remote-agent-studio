const path = require('path');
const { shellQuote } = require('../ssh/SSHManager');
const { psQuote } = require('../LocalExecutor');

function safeSegment(value) {
  const result = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!result) throw new Error('taskId and stageId are required');
  return result;
}

function createWorktreeCommand({ baseCwd, taskId, stageId, isWindowsNative }) {
  if (!baseCwd) throw new Error('baseCwd is required');
  const name = `${safeSegment(taskId)}-${safeSegment(stageId)}`;
  const branch = `ras/${name}`;
  const apiPath = isWindowsNative ? path.win32 : path.posix;
  const cwd = apiPath.join(baseCwd, '.ras-worktrees', name);
  const parent = apiPath.dirname(cwd);
  if (isWindowsNative) {
    return { cwd, branch, command: `New-Item -ItemType Directory -Force -Path ${psQuote(parent)} | Out-Null; git -C ${psQuote(baseCwd)} worktree add -b ${psQuote(branch)} ${psQuote(cwd)}` };
  }
  return { cwd, branch, command: `mkdir -p ${shellQuote(parent)} && git -C ${shellQuote(baseCwd)} worktree add -b ${shellQuote(branch)} ${shellQuote(cwd)}` };
}

async function createWorktree(ssh, fields) {
  const plan = createWorktreeCommand({ ...fields, isWindowsNative: !!ssh?.isWindowsNative });
  const result = await ssh.exec(plan.command);
  if (result.code !== 0) throw new Error(`创建隔离 worktree 失败：${String(result.stderr || result.stdout || '').trim() || `exit ${result.code}`}`);
  return { cwd: plan.cwd, branch: plan.branch };
}

module.exports = { safeSegment, createWorktreeCommand, createWorktree };
