const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// src 下是 ESM,测试里轻量转换加载(与 goal-slash.test.js 同一套办法)
function loadEsm(rel, names) {
  const src = read(path.join('src', rel))
    .replace(/export const/g, 'const')
    .replace(/export function/g, 'function');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`${src}\nmodule.exports = { ${names.join(', ')} };`, sandbox);
  return sandbox.module.exports;
}

const T = loadEsm('themes.js', [
  'THEMES', 'REQUIRED_TOKENS', 'DEFAULT_THEME', 'getTheme', 'applyTheme', 'isHexColor', 'contrast', 'luminance'
]);

/* ---------------------------------------------------------- 完整性 */

test('每个皮肤都定义了全部 token', () => {
  /* 这是整个皮肤功能里最重要的一条。
     少一个 token 不是"稍微丑一点":background: var(--panel) 在变量
     未定义时**整条声明失效**,控件直接变透明 —— 而且只在切到那个皮肤时
     才出现,平时根本发现不了。项目已经因为 --panel/--fg 栽过一次。 */
  for (const t of T.THEMES) {
    for (const token of T.REQUIRED_TOKENS) {
      assert.ok(t.colors[token], `皮肤 ${t.id} 缺少 --${token}`);
      assert.ok(T.isHexColor(t.colors[token]), `${t.id}.${token} 不是合法颜色:${t.colors[token]}`);
    }
  }
});

test('别名与本体保持一致', () => {
  for (const t of T.THEMES) {
    assert.equal(t.colors.fg, t.colors.text, `${t.id} 的 --fg 应等于 --text`);
    assert.equal(t.colors.panel, t.colors.bg2, `${t.id} 的 --panel 应等于 --bg2`);
    assert.equal(t.colors.ok, t.colors.green, `${t.id} 的 --ok 应等于 --green`);
  }
});

test('皮肤 id 不重复', () => {
  const ids = T.THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('每个皮肤都有中文名和用途说明', () => {
  // 说明写的是"什么时候用它",不是形容词 —— 否则选择器等于让人凭色块猜
  for (const t of T.THEMES) {
    assert.ok(t.name && t.name.length <= 6, `${t.id} 的名字不合适`);
    assert.ok(t.desc && t.desc.length > 4, `${t.id} 缺少用途说明`);
  }
});

/* ---------------------------------------------------------- 可读性 */

test('正文对比度达到 WCAG AA(4.5:1)', () => {
  // 这是个天天读日志和 diff 的工具,"好看但读不清"不能接受
  for (const t of T.THEMES) {
    const r = T.contrast(t.colors.text, t.colors.bg);
    assert.ok(r >= 4.5, `皮肤 ${t.id} 正文对比度只有 ${r.toFixed(2)}`);
  }
});

test('次要文字对比度达到 3:1', () => {
  for (const t of T.THEMES) {
    const r = T.contrast(t.colors.muted, t.colors.bg);
    assert.ok(r >= 3, `皮肤 ${t.id} 次要文字对比度只有 ${r.toFixed(2)}`);
  }
});

test('语义色在各自底色上仍然可读', () => {
  // 报错是红的、成功是绿的 —— 这两个色读不清,等于状态传达失败
  for (const t of T.THEMES) {
    for (const key of ['red', 'green', 'yellow', 'accent']) {
      const r = T.contrast(t.colors[key], t.colors.bg);
      assert.ok(r >= 3, `皮肤 ${t.id} 的 ${key} 对比度只有 ${r.toFixed(2)}`);
    }
  }
});

test('面板色与底色能区分开', () => {
  // 完全相同的话,卡片、侧栏、输入框全都糊成一片,界面失去层次
  for (const t of T.THEMES) {
    assert.notEqual(t.colors.bg2, t.colors.bg, `皮肤 ${t.id} 的面板色和底色一样`);
    assert.ok(Math.abs(T.luminance(t.colors.bg2) - T.luminance(t.colors.bg)) > 0.001,
      `皮肤 ${t.id} 的面板色和底色几乎无差别`);
  }
});

/* ---------------------------------------------------------- 应用 */

function fakeRoot() {
  const props = {};
  const attrs = {};
  return {
    style: { setProperty: (k, v) => { props[k] = v; } },
    setAttribute: (k, v) => { attrs[k] = v; },
    props, attrs
  };
}

test('applyTheme 写入全部 token 并设置 data-theme', () => {
  const el = fakeRoot();
  T.applyTheme('forest', {}, el);
  for (const token of T.REQUIRED_TOKENS) {
    assert.ok(el.props[`--${token}`], `没写入 --${token}`);
  }
  // data-theme 仍要设:已有 CSS 和其他逻辑按它取值
  assert.equal(el.attrs['data-theme'], 'forest');
});

test('自定义强调色覆盖皮肤原色,其余不动', () => {
  const el = fakeRoot();
  T.applyTheme('dark', { accent: '#ff0088' }, el);
  assert.equal(el.props['--accent'], '#ff0088');
  assert.equal(el.props['--bg'], T.getTheme('dark').colors.bg);
});

test('非法强调色被忽略', () => {
  /* 这个值最终会走到 style.setProperty。CSS 自己会丢弃无效值,
     但 `red; } body{display:none` 这类字符串不该有机会走到那一步。 */
  const el = fakeRoot();
  T.applyTheme('dark', { accent: 'red; } body{display:none' }, el);
  assert.equal(el.props['--accent'], T.getTheme('dark').colors.accent);
  T.applyTheme('dark', { accent: 'javascript:alert(1)' }, el);
  assert.equal(el.props['--accent'], T.getTheme('dark').colors.accent);
});

test('未知皮肤退回默认,不抛异常', () => {
  // 配置里存着一个已被删掉的皮肤时,界面必须还能起来
  assert.equal(T.getTheme('已经删掉的皮肤').id, T.DEFAULT_THEME);
  assert.equal(T.getTheme('').id, T.DEFAULT_THEME);
  assert.equal(T.getTheme(undefined).id, T.DEFAULT_THEME);
  const el = fakeRoot();
  assert.doesNotThrow(() => T.applyTheme('nope', {}, el));
  assert.equal(el.attrs['data-theme'], T.DEFAULT_THEME);
});

test('对比度计算本身是对的', () => {
  assert.ok(Math.abs(T.contrast('#000000', '#ffffff') - 21) < 0.1);
  assert.ok(Math.abs(T.contrast('#4f8cff', '#4f8cff') - 1) < 1e-6);
  // 与顺序无关
  assert.ok(Math.abs(T.contrast('#000', '#fff') - T.contrast('#fff', '#000')) < 1e-6);
  // 支持三位简写
  assert.ok(Math.abs(T.contrast('#000', '#ffffff') - 21) < 0.1);
});

/* ---------------------------------------------------------- 接线 */

test('样式表补上了 --panel/--fg/--ok 别名', () => {
  /* 这三个一直被组件用着却从没定义过。JS 起来后会写行内变量,
     但首帧(JS 执行前)靠的是这里 —— 缺了会闪一下没背景的控件。 */
  const css = read('src/styles.css');
  for (const alias of ['--fg: var(--text)', '--panel: var(--bg2)', '--ok: var(--green)']) {
    assert.ok(css.includes(alias), `styles.css 缺少别名 ${alias}`);
  }
});

test('滚动条不写死白色', () => {
  // 写死 rgba(255,255,255,…) 在浅色皮肤上等于白底白条,滚动条直接消失
  const css = read('src/styles.css');
  const thumb = css.match(/::-webkit-scrollbar-thumb \{[\s\S]*?\}/)[0];
  assert.ok(!/rgba\(255, ?255, ?255/.test(thumb), '滚动条滑块仍写死了白色');
  assert.match(thumb, /var\(--/);
});

test('代码块与 diff 用主题变量,不用半透明黑白', () => {
  /* rgba(255,255,255,0.06) 在浅色皮肤上没有底色,代码和正文糊成一片;
     rgba(0,0,0,0.25) 则在浅色皮肤上变成深灰底 + 深色字,基本读不了。 */
  const css = read('src/styles.css');
  for (const sel of ['.md-code', '.md-inline-code', '.diff-view']) {
    const rule = css.match(new RegExp(`\\${sel} \\{[^}]*\\}`))[0];
    assert.ok(!/rgba\((255|0)/.test(rule), `${sel} 仍在用写死的半透明黑白`);
  }
});

test('终端配色跟随皮肤,且换肤时会刷新', () => {
  /* xterm 的 theme 是构造时传进去的普通对象,不认 CSS 变量。
     不监听换肤事件就会出现「界面切成浅色了、终端还是一块黑」。 */
  const term = read('src/components/TerminalPanel.jsx');
  assert.match(term, /theme: xtermTheme\(\)/);
  assert.match(term, /onThemeChange/);
  assert.match(term, /offTheme\(\)/);   // 必须解绑,否则每开一个终端标签就泄漏一个监听
  assert.ok(!/#0b0d12/.test(term.replace(/themeVar\([^)]*\)/g, '')), '终端仍有写死的深色兜底之外的用法');
});

test('二维码终端故意不跟随皮肤', () => {
  /* 半块字符拼的 QR 在浅色皮肤下会变成反色,不少扫码器认不出。
     宁可这一块配色不统一,也不能让人扫不出来 —— 这是有意为之,要有注释挡住"顺手改一下"。 */
  const setup = read('src/components/SetupTerminal.jsx');
  assert.match(setup, /故意不跟随皮肤/);
  assert.match(setup, /background: '#0b0d12'/);
});

test('换肤只过渡颜色,不过渡 all', () => {
  // transition: all 会把布局属性一起动上,拖分栏时整个界面会飘
  const css = read('src/styles.css');
  const rule = css.match(/:root, body, \.app \{[^}]*\}/)[0];
  assert.ok(!/transition: all/.test(rule));
  assert.match(rule, /background-color/);
});

test('store 在强调色变化时也重新应用主题', () => {
  // 只判断 patch.theme 的话,改强调色不会生效 —— 它是叠在主题上的覆盖
  const store = read('src/store.js');
  assert.match(store, /patch\.theme !== undefined \|\| patch\.accent !== undefined/);
  assert.match(store, /applyTheme\(next\.theme, \{ accent: next\.accent \}\)/);
});
