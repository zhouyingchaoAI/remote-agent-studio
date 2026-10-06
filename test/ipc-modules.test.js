const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* ============================================================
 * main.js 按领域拆分。
 *
 * 原来 3000 多行、148 个 IPC handler 堆在一个文件里。新领域一律放
 * electron/ipc/<领域>.js,导出 register(ctx)。这条测试守的是**模式**:
 * 写了模块却忘了在 main.js 注册,handler 就静默不存在 ——
 * 渲染层调它只会得到一个看不出原因的 "No handler registered"。
 * ============================================================ */

const modules = fs.readdirSync(path.join(root, 'electron/ipc')).filter((f) => f.endsWith('.js'));

test('electron/ipc 下至少有拆出来的模块', () => {
  assert.ok(modules.length >= 3, `只有 ${modules.length} 个`);
});

for (const f of modules) {
  const name = f.replace(/\.js$/, '');

  test(`${f} 导出 register`, () => {
    const m = require(path.join(root, 'electron/ipc', f));
    assert.equal(typeof m.register, 'function');
  });

  test(`${f} 在 main.js 里被注册`, () => {
    /* 写了没注册 = 静默不存在。 */
    assert.match(read('electron/main.js'), new RegExp(`require\\('\\./ipc/${name}'\\)\\.register`), `${f} 没在 main.js 注册`);
  });

  test(`${f} 里的 handler 不再重复出现在 main.js`, () => {
    /* 搬家搬一半:两边都注册同一个通道,后注册的悄悄覆盖先注册的,
       改了一边另一边"没生效" —— 查起来极其费时。 */
    const channels = [...read(`electron/ipc/${f}`).matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(channels.length > 0, `${f} 里没有 handler`);
    const main = read('electron/main.js');
    for (const ch of channels) {
      assert.ok(!main.includes(`ipcMain.handle('${ch}'`), `${ch} 在 main.js 里还有一份`);
    }
  });

  test(`${f} 只从 ctx 拿依赖,不自己去 require main.js`, () => {
    // 反向依赖 main.js 会形成环,而且让模块没法单独加载测试
    assert.ok(!/require\(['"]\.\.\/main/.test(read(`electron/ipc/${f}`)));
  });
}

test('同一个通道不能出现在两个模块里', () => {
  /* 这条是被真实事故逼出来的:拆分时切片边界算错,goal:readPlan 同时落到了
     goal.js 和 worktree.js。原来的检查只看"模块 vs main.js",两个模块之间
     的重复一个都没抓到 —— 后注册的悄悄覆盖先注册的,lint 报的还是一个
     不相干的 "shellQuote 未定义"。模块之间也必须互斥。 */
  const owner = new Map();
  for (const f of modules) {
    for (const m of read(`electron/ipc/${f}`).matchAll(/ipcMain\.handle\('([^']+)'/g)) {
      const ch = m[1];
      assert.ok(!owner.has(ch), `通道 ${ch} 同时出现在 ${owner.get(ch)} 和 ${f}`);
      owner.set(ch, f);
    }
  }
});

test('模块里引用的标识符都来自 ctx 或自己的 require', () => {
  /* 搬家时最容易漏的就是闭包变量:在 main.js 里能用,搬出去就是 undefined,
     而且要等那个 handler 被调用时才炸。lint 能抓到一部分,这里再补一道。 */
  for (const f of modules) {
    const src = read(`electron/ipc/${f}`);
    const params = (src.match(/function register\(\{([^}]*)\}\)/) || [])[1] || '';
    const provided = new Set(params.split(',').map((x) => x.trim()).filter(Boolean));
    for (const need of ['getSession', 'shellQuote', 'LOCAL_ID', 'Installer']) {
      if (new RegExp(`\\b${need}\\b`).test(src.replace(/function register\([^)]*\)/, ''))) {
        assert.ok(provided.has(need), `${f} 用到了 ${need} 但 register 没有从 ctx 里取`);
      }
    }
  }
});

test('register 用桩 ctx 能跑通,不在注册阶段就炸', () => {
  for (const f of modules) {
    const calls = [];
    const ctx = {
      ipcMain: { handle: (ch) => calls.push(ch) },
      getSession: () => ({}), LOCAL_ID: 'local', Installer: { BIN_PATH: '' }, shellQuote: (v) => `'${v}'`
    };
    assert.doesNotThrow(() => require(path.join(root, 'electron/ipc', f)).register(ctx), f);
    assert.ok(calls.length > 0, `${f} 注册了 0 个 handler`);
  }
});
