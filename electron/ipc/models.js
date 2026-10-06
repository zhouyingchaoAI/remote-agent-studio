/**
 * 模型列表自动发现
 *
 * 从 main.js 拆出来的。main.js 原来 3000 多行、148 个 IPC handler,
 * 任何功能都往里堆,改一处要读一千行。按领域拆成 electron/ipc/<领域>.js,
 * 每个模块导出 register(ctx),只拿自己需要的依赖。
 *
 * **行为不变**:这是纯搬家。拆的时候不顺手改逻辑 —— 两件事混在一个提交里,
 * 出了问题分不清是搬坏的还是改坏的。
 */

function register({ ipcMain, getSession }) {
  /* ---- 模型列表自动发现 ----
   *
   * 写死的清单有两个躲不开的问题:永远落后一轮,而且对自建/中转端点
   * 完全无关(那里的模型叫 gpt-5.6-terra 这种名字,官方列表里一个都没有)。
   * 端点自己知道答案,问它一次即可。
   *
   * 结果按 主机+引擎 缓存:每次打开对话都去问一遍,既慢又没必要 ——
   * 模型列表几周才变一次。 */
  const modelDiscovery = require('../ssh/modelDiscovery');
  /* 复用执行引擎时那份环境前缀 —— 密钥在 ~/.remote-agent-env.sh 里,
     不 source 一遍 ${OPENAI_API_KEY} 就是空的,结果永远 401。 */
  const { AGENT_ENV: AGENT_ENV_PREFIX } = require('../ssh/agentEnv');
  const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  const modelCache = new Map();   // `${hostId}|${engine}` -> {at, result}

  ipcMain.handle('models:discover', async (_e, { hostId, engine, baseUrl, envKey, force } = {}) => {
    const key = `${hostId}|${engine}`;
    const hit = modelCache.get(key);
    if (!force && hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }
    const cmd = modelDiscovery.buildDiscoverCommand({ engine, baseUrl, envKey });
    if (!cmd) return { ok: false, error: '端点或密钥变量名不合法', models: [] };
    try {
      const s = getSession(hostId);
      /* 带上引擎环境前缀:密钥在 ~/.remote-agent-env.sh 里,
         不 source 一遍的话 ${OPENAI_API_KEY} 是空的,结果永远是 401。 */
      const r = await s.ssh.exec(`${AGENT_ENV_PREFIX} ${cmd}`, { timeoutMs: 30000 });
      if (r.code === 124) return { ok: false, error: '查询超时', models: [] };
      const result = modelDiscovery.parseDiscover(r.stdout || '');
      // 只缓存成功的:失败多半是暂时的(密钥没配好、网络抖),缓存住会把人困住
      if (result.ok) modelCache.set(key, { at: Date.now(), result });
      return result;
    } catch (e) {
      return { ok: false, error: e.message, models: [] };
    }
  });
}

module.exports = { register };
