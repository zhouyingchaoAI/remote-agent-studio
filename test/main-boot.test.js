const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

/* ============================================================
 * 启动冒烟测试:主进程能不能加载。
 *
 * ── 为什么这条一直缺着 ──
 *
 * 整个测试套件跑 900 多条,却**没有一条验证"应用能起来"**。
 * 单测证明的是各个模块自洽,构建证明的是渲染层能打包 ——
 * 两者都跟"主进程 require 得通"没有关系。
 * 于是主进程里一个笔误(拼错的路径、循环依赖、顶层就抛的调用)
 * 可以一路通过全部检查,直到用户双击启动才发现。
 *
 * ── 为什么要用 Module._load 拦截 ──
 *
 * 直接 NODE_PATH 塞个假 electron 是不行的:真实的 electron 包
 * 在纯 Node 下会被优先解析到,而它导出的是**二进制文件路径这个字符串**,
 * 于是 `const { ipcMain } = require('electron')` 拿到 undefined,
 * 测试失败在自己的桩上,看不出被测代码有没有问题。
 * 我第一次就是这么被误导的,所以这里必须从模块解析这一层接管。
 * ============================================================ */

/** 一个"怎么用都不炸"的桩:取任何属性、当函数调用、new 都返回它自己 */
function makeStub() {
  const fn = function stub() { return proxy; };
  const proxy = new Proxy(fn, {
    get(_t, prop) {
      // 这几个要像真的,否则解构/判断会走进奇怪的分支
      /* `then` 必须是个**可链式调用但永不兑现**的函数:
         返回 undefined 的话 `app.whenReady().then(...)` 当场报
         "then is not a function"(我第一版就是这样,查了半天发现是桩的锅);
         而真的去 resolve,又会把整个 app 初始化跑起来 ——
         这条测试要验的是"加载阶段不炸",不是"启动流程正确"。 */
      if (prop === 'then') return () => proxy;
      if (prop === Symbol.toPrimitive) return () => 'stub';
      if (prop === 'isPackaged') return false;
      if (prop === 'platform') return process.platform;
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
    has: () => true
  });
  return proxy;
}

test('主进程模块图能加载,不在 require 阶段就炸', () => {
  const stub = makeStub();
  const original = Module._load;
  const loaded = [];

  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return stub;
    // 原生模块在纯 Node 下加载不了,一并顶掉
    if (request === 'ssh2' || request === 'node-pty') {
      try { return original(request, parent, isMain); } catch { return stub; }
    }
    const m = original(request, parent, isMain);
    loaded.push(request);
    return m;
  };

  try {
    const mainPath = path.join(__dirname, '..', 'electron', 'main.js');
    delete require.cache[require.resolve(mainPath)];
    assert.doesNotThrow(() => require(mainPath), '主进程在加载阶段就抛错了');
  } finally {
    Module._load = original;
  }
});

test('这次新增的模块都能被主进程链路解析到', () => {
  /* 漏提交一个文件,单测照跑、构建照过,只有启动时才报
     "Cannot find module" —— 而那时候用户已经在骂了。 */
  for (const rel of [
    'electron/ssh/agentEnv.js',
    'electron/ssh/threadGuard.js',
    'electron/transientErrors.js',
    'electron/ssh/outputClip.js'
  ]) {
    assert.doesNotThrow(
      () => require(path.join(__dirname, '..', rel)),
      `${rel} 加载失败`
    );
  }
});

test('渲染层入口引用的新模块都真实存在', () => {
  /* 构建会抓到这个,但构建跑得慢、也不总是跟着单测跑;
     这条便宜,顺手守住。 */
  const fs = require('fs');
  const root = path.join(__dirname, '..');
  for (const rel of [
    'src/termFit.js', 'src/shortenPath.js',
    'src/attachmentFile.js', 'src/planProgress.js'
  ]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} 不存在`);
  }
});
