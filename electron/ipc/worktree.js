const worktree = require('../ssh/worktree');

/**
 * 分路(git worktree)
 *
 * 从 main.js 拆出来的。main.js 原来 3000 多行、148 个 IPC handler,
 * 任何功能都往里堆,改一处要读一千行。按领域拆成 electron/ipc/<领域>.js,
 * 每个模块导出 register(ctx),只拿自己需要的依赖。
 *
 * **行为不变**:这是纯搬家。拆的时候不顺手改逻辑 —— 两件事混在一个提交里,
 * 出了问题分不清是搬坏的还是改坏的。
 */

function register({ ipcMain, getSession }) {
  /* ---- 分路(git worktree):一条对话拆成几路,各做一个功能 ----
   *
   * 独立目录是这件事的**前提**,不是锦上添花:几路共用一个工作目录的话,
   * 几个智能体会同时改同一批文件,互相覆盖,而且谁也不知道被谁覆盖了。
   * 那不是并行,是竞态。 */

  ipcMain.handle('worktree:detect', async (_e, { hostId, cwd } = {}) => {
    const s = getSession(hostId);
    const r = await s.ssh.exec(worktree.buildDetectRepoCommand(cwd), { timeoutMs: 15000 });
    return worktree.parseDetect(r.stdout || '');
  });

  ipcMain.handle('worktree:create', async (_e, { hostId, root, slug, branch, base } = {}) => {
    const cmd = worktree.buildCreateWorktreeCommand({ root, slug, branch, base });
    if (!cmd) return { ok: false, error: '参数不完整' };
    const s = getSession(hostId);
    /* git worktree add 要复制整棵工作树,大仓库会跑一会儿。
       给足时间 —— 超时中断会留下一个半成品目录,比慢更麻烦。 */
    const r = await s.ssh.exec(cmd, { timeoutMs: 180000 });
    if (r.code === 124) return { ok: false, error: '创建超时(仓库较大时可稍后重试)' };
    return worktree.parseCreate(r.stdout || '');
  });

  ipcMain.handle('worktree:list', async (_e, { hostId, root } = {}) => {
    const s = getSession(hostId);
    const r = await s.ssh.exec(worktree.buildListCommand(root), { timeoutMs: 15000 });
    return worktree.parseList(r.stdout || '');
  });
}

module.exports = { register };
