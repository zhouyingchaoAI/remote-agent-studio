/**
 * 端到端冒烟(渲染层):在真实的 store 上走一遍用户会走的路。
 *
 * 只在 `window.api.e2e.enabled` 为真时跑(主进程带了 --ras-e2e)。
 * 平时这个文件 import 进来但什么都不做。
 *
 * 每一步都记进 steps,**失败时报的是具体哪一步**,不是笼统的"失败了"。
 * 整个流程走的是 store 的公开函数,和界面上点按钮触发的是同一套代码 ——
 * 所以它验证的就是用户实际会碰到的那条链路。
 */
import { useStore, sendToAgent } from './store.js';

const STEP_TIMEOUT_MS = 10 * 1000;

/** 等到条件成立,或者超时 —— 超时要说清在等什么 */
function waitFor(label, pred, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      try {
        if (pred()) return resolve();
      } catch (e) { return reject(new Error(`${label}:${e.message}`)); }
      if (Date.now() - started > timeoutMs) return reject(new Error(`等待「${label}」超时`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function runE2E() {
  if (!window.api?.e2e?.enabled) return;
  const steps = [];
  const ok = (name, extra) => steps.push({ name, ok: true, ...extra });
  let convId = '';

  try {
    /* 1. 桥接:preload 把 api 暴露出来了吗?少一个命名空间都算挂。
          这是「白屏」最常见的根因,而单测永远测不到。 */
    for (const ns of ['agent', 'convos', 'settings', 'hosts', 'ssh', 'term', 'attachments', 'goal', 'models']) {
      if (!window.api[ns]) throw new Error(`preload 没有暴露 api.${ns}`);
    }
    ok('preload 桥接完整');

    // 2. 主机列表里有「本地」(它是硬编码的,没有说明 loadHosts 没跑)
    await waitFor('主机列表加载', () => useStore.getState().hosts.some((h) => h.id === 'local'));
    ok('主机列表加载');

    // 3. 建对话 —— 和点「新建对话」走同一个函数
    const conv = useStore.getState().createConversation('local', {
      agent: 'codex', cwd: '/tmp', title: 'E2E 冒烟'
    });
    convId = conv.id;
    if (!useStore.getState().conversations[convId]) throw new Error('createConversation 后 store 里没有这条对话');
    ok('创建对话', { convId });

    // 4. 发消息 —— 和点「发送」走同一个函数
    await sendToAgent('local', convId, 'ping-e2e', []);
    ok('发送消息');

    // 5. 等假引擎的回复经由真实的 agent:message 通道落到 store 里
    await waitFor('收到回复', () => {
      const c = useStore.getState().conversations[convId];
      return c && c.messages.some((m) => m.role === 'agent' && m.kind === 'text' && /E2E_ECHO:ping-e2e/.test(m.text || ''));
    });
    ok('收到回复');

    // 6. 工具调用要被**合并**成一条,而不是两条(验证实时日志那套 id 合并逻辑)
    const msgs = useStore.getState().conversations[convId].messages;
    const tools = msgs.filter((m) => m.kind === 'tool' && m.id === 'e2e-cmd-1');
    if (tools.length !== 1) throw new Error(`同 id 的工具消息应合并成 1 条,实际 ${tools.length} 条`);
    if (tools[0].running !== false) throw new Error('工具消息跑完后 running 应为 false');
    if (!/e2e/.test(tools[0].output || '')) throw new Error('工具输出没落到消息上');
    ok('工具消息按 id 合并');

    // 7. 本轮结束:running 要回到 false,会话 id 要记下来
    await waitFor('本轮结束', () => !useStore.getState().agentRunning[convId]);
    const after = useStore.getState().conversations[convId];
    if (after.codexSessionId !== 'e2e-thread') throw new Error('done 事件里的会话 id 没写回对话');
    ok('本轮收尾');

    // 8. 用量累加
    if ((after.usage?.inputTokens || 0) < 10) throw new Error('usage 没累加');
    ok('用量累加');

    // 9. 持久化:等 debounce 过去,再从磁盘读回来确认真的写了
    await new Promise((r) => setTimeout(r, 600));
    const saved = await window.api.convos.list();
    const hit = (saved || []).find((c) => c.id === convId);
    if (!hit) throw new Error('对话没有持久化到磁盘');
    if (!hit.messages.some((m) => /E2E_ECHO/.test(m.text || ''))) throw new Error('持久化的对话里没有回复');
    ok('持久化落盘');

    await window.api.e2e.report({ ok: true, steps });
  } catch (e) {
    steps.push({ name: '失败', ok: false, error: e.message });
    await window.api.e2e.report({ ok: false, error: e.message, steps, convId });
  }
}
