/**
 * 端到端冒烟:**真的把 Electron 起起来**,走一遍"开对话 → 发消息 → 收回复"。
 *
 * ── 为什么非要有这一层 ──
 *
 * 这个仓库有近千条单测,外加 lint 和构建。它们证明的是:各模块自洽、
 * 渲染层能打包、主进程 require 得通。**没有一条证明"应用能用"。**
 * 窗口起不来、preload 没桥上、IPC 通道名写错、store 收到消息没渲染 ——
 * 这些全都能一路通过上述所有检查,直到用户双击启动才发现。
 * 「启动.command 无法启动」就是这么来的。
 *
 * ── 测什么、不测什么 ──
 *
 * 测**我们自己的平台**:窗口、preload 桥、IPC 往返、store 的消息流、渲染、持久化。
 * **不测引擎**:codex / claude 是外部依赖,装没装、登没登录都不是平台的事。
 * 所以 E2E 模式下把 agent:send 换成一个假引擎 —— 它走**真实的**
 * `agent:message` 通道把回复发回去,路径和真引擎完全一样,只是不花钱、不联网。
 *
 * ── 怎么跑 ──
 *
 *   npm run e2e        (= 构建 + RAS_E2E=1 electron .)
 *
 * 退出码:0 通过 / 1 断言失败 / 2 超时(卡住了,连失败都报不出来)。
 * 结果同时写到 userData/e2e-result.json,方便看具体哪一步挂了。
 *
 * 不引入 Playwright 之类的依赖:沙箱里装不上,而且这条链路本来就不需要
 * 浏览器自动化 —— 我们自己就是宿主,直接从里面驱动。
 */
const fs = require('fs');
const path = require('path');

const E2E_TIMEOUT_MS = 60 * 1000;

function isE2E() {
  return process.env.RAS_E2E === '1';
}

/**
 * 装上假引擎与结果收集。必须在所有真实 handler 注册**之后**调用,
 * 因为要覆盖掉 agent:start / agent:send。
 */
function installE2E({ ipcMain, app, send, log = () => {} }) {
  if (!isE2E()) return;
  log('[e2e] 模式开启');

  const userData = app.getPath('userData');
  const resultFile = path.join(userData, 'e2e-result.json');
  let finished = false;

  const finish = (code, payload) => {
    if (finished) return;
    finished = true;
    try { fs.writeFileSync(resultFile, JSON.stringify(payload, null, 2)); } catch (_) { /* 写不进也要退出 */ }
    log(`[e2e] ${payload.ok ? '通过' : '失败'}:${JSON.stringify(payload)}`);
    // 给日志一点时间刷出去
    const t = setTimeout(() => app.exit(code), 200);
    if (typeof t.unref === 'function') t.unref();
  };

  /* 看门狗:卡住比失败更糟 —— 失败至少能告诉你哪一步错了。 */
  const watchdog = setTimeout(() => {
    finish(2, { ok: false, error: `超时 ${E2E_TIMEOUT_MS / 1000}s,流程没跑完`, steps: [] });
  }, E2E_TIMEOUT_MS);
  /* unref:看门狗不能成为拖着进程不退出的那个东西。
     (测试里就是被它拖住的 —— 每装一次留一个 60 秒定时器,进程退不了。) */
  if (typeof watchdog.unref === 'function') watchdog.unref();

  /* ---- 假引擎 ----
     覆盖 agent:start / agent:send。回复走真实的 agent:message 通道,
     这样 store、渲染、持久化全是真的,只有"模型"是假的。 */
  ipcMain.removeHandler('agent:start');
  ipcMain.removeHandler('agent:send');

  ipcMain.handle('agent:start', async () => true);

  ipcMain.handle('agent:send', async (_e, { hostId, convId, prompt } = {}) => {
    const reply = (msg) => send('agent:message', { hostId, convId, msg });
    // 按真引擎的事件顺序来:状态 → 工具 → 正文 → 用量 → 完成
    reply({ kind: 'status', text: '正在远程执行...' });
    reply({ kind: 'tool', id: 'e2e-cmd-1', name: '执行命令', detail: 'echo e2e', running: true, output: '' });
    await new Promise((r) => setTimeout(r, 50));
    reply({ kind: 'tool', id: 'e2e-cmd-1', name: '执行命令', detail: 'echo e2e', running: false, output: 'e2e\n', exitCode: 0 });
    reply({ kind: 'text', text: `E2E_ECHO:${String(prompt || '').slice(0, 80)}` });
    reply({ kind: 'usage', inputTokens: 10, outputTokens: 5 });
    reply({ kind: 'done', agent: 'codex', codexSessionId: 'e2e-thread', codexStarted: true });
    return true;
  });

  /* ---- 结果上报:渲染层跑完脚本后调这个 ---- */
  ipcMain.handle('e2e:report', async (_e, payload = {}) => {
    clearTimeout(watchdog);
    finish(payload.ok ? 0 : 1, payload);
    return true;
  });

  // 给测试用:拆掉看门狗
  return { dispose: () => clearTimeout(watchdog) };
}

module.exports = { isE2E, installE2E, E2E_TIMEOUT_MS };
