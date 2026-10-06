const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 端到端冒烟的**骨架**本身要可信。
 *
 * 这套东西在沙箱里跑不起来(Linux 沙箱、macOS 版 Electron、没网络下不了
 * Linux 版),只能在用户的 Mac 上 `npm run e2e`。所以更要保证:
 * 等它真的跑起来时,挂掉的是被测代码,而不是测试骨架自己。
 * ============================================================ */

/** 假的 ipcMain / app / send,记录发生了什么 */
function fakeWorld() {
  const handlers = new Map();
  const removed = [];
  const sent = [];
  const exits = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  process.on('exit', () => { try { fs.rmSync(userData, { recursive: true, force: true }); } catch {} });
  return {
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => { removed.push(ch); handlers.delete(ch); }
    },
    app: { getPath: () => userData, exit: (c) => exits.push(c) },
    send: (ch, payload) => sent.push({ ch, payload }),
    handlers, removed, sent, exits, userData
  };
}

function loadFresh() {
  const p = require.resolve('../electron/e2e');
  delete require.cache[p];
  return require(p);
}

test('不带 RAS_E2E 时什么都不装', () => {
  /* 这是最重要的一条:冒烟骨架**绝不能**在正常运行时生效 ——
     它会把真引擎换成假的,用户发什么都只收到回声。 */
  delete process.env.RAS_E2E;
  const w = fakeWorld();
  loadFresh().installE2E(w);
  assert.equal(w.handlers.size, 0);
  assert.equal(w.removed.length, 0);
});

test('开启时覆盖 agent:start / agent:send,并注册上报通道', () => {
  process.env.RAS_E2E = '1';
  const w = fakeWorld();
  loadFresh().installE2E(w);
  assert.deepEqual(w.removed.sort(), ['agent:send', 'agent:start']);
  assert.ok(w.handlers.has('agent:send'));
  assert.ok(w.handlers.has('e2e:report'));
  delete process.env.RAS_E2E;
});

test('假引擎按真引擎的事件顺序发,且走真实的 agent:message 通道', async () => {
  /* 顺序必须和 AgentSession 一致:status → tool(跑着)→ tool(跑完)→ text → usage → done。
     乱了的话,冒烟脚本的断言会在一个和真实情况无关的地方挂掉。 */
  process.env.RAS_E2E = '1';
  const w = fakeWorld();
  loadFresh().installE2E(w);
  await w.handlers.get('agent:send')({}, { hostId: 'local', convId: 'c1', prompt: 'ping' });

  const kinds = w.sent.map((s) => s.payload.msg.kind);
  assert.deepEqual(kinds, ['status', 'tool', 'tool', 'text', 'usage', 'done']);
  assert.ok(w.sent.every((s) => s.ch === 'agent:message'), '必须走真实通道,否则 store 收不到');
  assert.ok(w.sent.every((s) => s.payload.convId === 'c1'));

  // 回声里要带原话,冒烟脚本靠它确认"发出去的就是收回来的"
  const text = w.sent.find((s) => s.payload.msg.kind === 'text').payload.msg.text;
  assert.match(text, /E2E_ECHO:ping/);

  // 两条 tool 事件同 id:一条 running、一条带退出码 —— 用来验证实时日志的合并逻辑
  const tools = w.sent.filter((s) => s.payload.msg.kind === 'tool').map((s) => s.payload.msg);
  assert.equal(tools[0].id, tools[1].id);
  assert.equal(tools[0].running, true);
  assert.equal(tools[1].running, false);
  assert.equal(tools[1].exitCode, 0);
  delete process.env.RAS_E2E;
});

test('上报通过 → 退出码 0 并写结果文件;失败 → 1', async () => {
  process.env.RAS_E2E = '1';
  const w = fakeWorld();
  loadFresh().installE2E(w);
  await w.handlers.get('e2e:report')({}, { ok: true, steps: [{ name: 'x', ok: true }] });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(w.exits, [0]);
  const saved = JSON.parse(fs.readFileSync(path.join(w.userData, 'e2e-result.json'), 'utf8'));
  assert.equal(saved.ok, true);

  const w2 = fakeWorld();
  loadFresh().installE2E(w2);
  await w2.handlers.get('e2e:report')({}, { ok: false, error: '某步挂了' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(w2.exits, [1]);
  delete process.env.RAS_E2E;
});

test('只上报一次:重复上报不会再次退出', async () => {
  // 脚本的 catch 分支和正常分支都可能调 report,第二次必须是空操作
  process.env.RAS_E2E = '1';
  const w = fakeWorld();
  loadFresh().installE2E(w);
  await w.handlers.get('e2e:report')({}, { ok: true });
  await w.handlers.get('e2e:report')({}, { ok: false });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(w.exits, [0], '第二次上报不该再触发退出');
  delete process.env.RAS_E2E;
});

/* ---------------------------------------------- 接线 */

test('E2E 安装在 main.js 最末 —— 要覆盖掉前面注册的真实 handler', () => {
  const main = read('electron/main.js');
  const at = main.lastIndexOf("require('./e2e').installE2E");
  assert.ok(at > 0);
  // 之后不能再有 ipcMain.handle('agent:send'),否则会把假引擎又盖回去
  assert.ok(!main.slice(at).includes("ipcMain.handle('agent:send'"));
});

test('E2E 标记通过 additionalArguments 传给 preload', () => {
  /* 沙箱里的 preload 读不到主进程 env,只能读 process.argv。
     用 env 传的话,preload 永远看到 enabled=false,脚本一行都不跑,
     而 npm run e2e 会"通过"得莫名其妙 —— 因为什么都没测。 */
  assert.match(read('electron/main.js'), /additionalArguments: process\.env\.RAS_E2E === '1' \? \['--ras-e2e'\]/);
  assert.match(read('electron/preload.js'), /enabled: process\.argv\.includes\('--ras-e2e'\)/);
});

test('渲染层脚本只在 enabled 时跑', () => {
  const src = read('src/e2e.js');
  assert.match(src, /if \(!window\.api\?\.e2e\?\.enabled\) return;/);
  assert.match(read('src/App.jsx'), /runE2E\(\);/);
});

test('渲染层脚本每一步都有名字,失败能定位', () => {
  /* "失败了"三个字等于没说。冒烟脚本最大的价值就是告诉你**哪一步**。 */
  const src = read('src/e2e.js');
  const steps = (src.match(/ok\('([^']+)'/g) || []).length;
  assert.ok(steps >= 8, `只有 ${steps} 步被记录`);
  assert.match(src, /等待「\$\{label\}」超时/, '超时也要说在等什么');
});

test('渲染层脚本验证的是平台链路,不是引擎', () => {
  const src = read('src/e2e.js');
  for (const must of ['preload', 'createConversation', 'sendToAgent', 'E2E_ECHO', 'convos.list']) {
    assert.ok(src.includes(must), `缺少对 ${must} 的检查`);
  }
});

test('npm run e2e 存在', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.e2e, /RAS_E2E=1 electron/);
});
