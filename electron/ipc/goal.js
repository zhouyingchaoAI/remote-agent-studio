/**
 * 目标模式:验收命令、计划文件
 *
 * 从 main.js 拆出来的。main.js 原来 3000 多行、148 个 IPC handler,
 * 任何功能都往里堆,改一处要读一千行。按领域拆成 electron/ipc/<领域>.js,
 * 每个模块导出 register(ctx),只拿自己需要的依赖。
 *
 * **行为不变**:这是纯搬家。拆的时候不顺手改逻辑 —— 两件事混在一个提交里,
 * 出了问题分不清是搬坏的还是改坏的。
 */

function register({ ipcMain, getSession, LOCAL_ID, Installer, shellQuote }) {
  /**
   * 跑一条目标的验收命令。
   *
   * 这是目标模式里唯一的**硬判据**:模型说"已完成"的成本是零,
   * 而 `npm test` / `curl -fsS .../health` 的退出码不会撒谎。
   *
   * 命令是用户在 /goal --check 里自己写的,所以这里不做白名单 ——
   * 但**有超时**:验收命令挂住会让整个目标循环停在那儿,
   * 而那看起来就像"任务还在跑",最难察觉。
   */
  ipcMain.handle('goal:check', async (_e, { hostId, command } = {}) => {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('没有验收命令');
    const s = getSession(hostId);
    const r = await s.ssh.exec(
      `${hostId === LOCAL_ID ? '' : Installer.BIN_PATH + ' '}${cmd}`,
      { timeoutMs: 60000 });
    return {
      code: r.code,
      // 输出会进提示词发给模型,照例脱敏
      output: require('../errorLog').redact(`${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(-4000))
    };
  });

  /**
   * 读计划文件。
   *
   * 目标模式原来只能显示"第 12 轮",而轮次不含任何信息 —— 看不出在做第几件事、
   * 总共几件。让智能体自己维护一份 markdown 清单(它本来就爱写 progress.md),
   * 应用每轮读一次,就能变成「第 3 / 18 步」。
   *
   * 读**失败一律返回空**而不是抛错:文件还没被创建、路径写错、主机暂时断开,
   * 这些都不该把整轮对话打断 —— 计划只是个观察窗口,不是必需品。
   */
  ipcMain.handle('goal:readPlan', async (_e, { hostId, path: p } = {}) => {
    const file = String(p || '').trim();
    if (!file) return { ok: false, text: '', error: '没有计划文件路径' };
    /* 路径来自用户输入,会拼进 shell —— 用仓库里已有的 shellQuote,
       不要在这儿再手写一遍引用逻辑。shell 引用的边角情况多到没法靠肉眼判断,
       每多一份实现就多一处会出错的地方。

       `~/` 要单独处理:整段引起来的话 `~` 不会展开,会去找一个名字里
       真带波浪号的目录 —— 默认计划路径正是 `~/.remote-agent-studio/…`,
       不处理的话这个功能默认就是坏的。展开交给 shell 的 $HOME,
       剩下的部分照常引用,注入面没变大。 */
    const quoted = file.startsWith('~/')
      ? `"$HOME"/${shellQuote(file.slice(2))}`
      : shellQuote(file);
    try {
      const s = getSession(hostId);
      // 计划文件不该很大;截断避免有人把日志当计划
      const r = await s.ssh.exec(`head -c 60000 ${quoted} 2>/dev/null`, { timeoutMs: 15000 });
      if (r.code === 124) return { ok: false, text: '', error: '读取超时' };
      const text = String(r.stdout || '');
      if (!text.trim()) return { ok: false, text: '', error: '文件为空或不存在' };
      return { ok: true, text };
    } catch (e) {
      return { ok: false, text: '', error: e.message };
    }
  });
}

module.exports = { register };
