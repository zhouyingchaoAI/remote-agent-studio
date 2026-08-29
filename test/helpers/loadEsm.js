/**
 * 在 node:test 里加载 src/ 下的 ESM 模块。
 *
 * 仓库里 src 是 ESM、测试是 CommonJS,又不想为几个纯函数模块引入一整套构建。
 * 原来各测试文件各写一份 `loadEsm`,只会把 `export` 抹掉;
 * 现在 goalMode 引入了 planProgress,**import 语句会让那种写法直接语法错误**,
 * 所以抽成一份公用的,并支持注入依赖。
 *
 * 只处理这个仓库实际用到的写法(静态具名 import/export),
 * 不打算做成通用打包器 —— 那样反而会掩盖真实的模块问题。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * @param rel  相对仓库根的路径,如 'src/goalMode.js'
 * @param deps { './planProgress.js': <已加载的模块对象> } —— 被 import 的模块
 * @returns    该模块所有具名导出组成的对象
 */
function loadEsm(rel, deps = {}) {
  const abs = path.join(__dirname, '..', '..', rel);
  let src = fs.readFileSync(abs, 'utf8');

  /* 收集 import 的绑定名,再从 deps 里取值塞进沙箱。
     取不到就抛错而不是塞 undefined —— 一个 undefined 的依赖会让测试
     以某种莫名其妙的方式失败,排查起来比"依赖没给"难得多。 */
  const preamble = [];
  src = src.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (_m, names, from) => {
    const mod = deps[from];
    if (!mod) throw new Error(`loadEsm(${rel}): 缺少依赖 ${from},请在 deps 里传入`);
    for (const raw of names.split(',')) {
      const [orig, alias] = raw.split(/\s+as\s+/).map((s) => s.trim());
      if (!orig) continue;
      const local = alias || orig;
      if (!(orig in mod)) throw new Error(`loadEsm(${rel}): ${from} 没有导出 ${orig}`);
      preamble.push(`const ${local} = __deps[${JSON.stringify(from)}][${JSON.stringify(orig)}];`);
    }
    return '';
  });

  // 具名导出 -> 普通声明,同时记下名字用于最后组装 module.exports
  const names = [];
  src = src.replace(/^export\s+(async\s+)?function\s+(\w+)/gm, (_m, a, n) => {
    names.push(n); return `${a || ''}function ${n}`;
  });
  src = src.replace(/^export\s+(const|let|var)\s+(\w+)/gm, (_m, kw, n) => {
    names.push(n); return `${kw} ${n}`;
  });
  src = src.replace(/^export\s+class\s+(\w+)/gm, (_m, n) => { names.push(n); return `class ${n}`; });

  const sandbox = { module: { exports: {} }, __deps: deps, console };
  const body = `${preamble.join('\n')}\n${src}\nmodule.exports = { ${names.join(', ')} };`;
  vm.runInNewContext(body, sandbox, { filename: abs });
  return sandbox.module.exports;
}

module.exports = { loadEsm };
