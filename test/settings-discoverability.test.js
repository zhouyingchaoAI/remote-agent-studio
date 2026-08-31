const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadEsm } = require('./helpers/loadEsm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * 「皮肤功能去哪了」
 *
 * 功能一直都在,而且是设置面板的第一项 —— 找不到是**入口的问题**:
 *  · 左下角是个没有文字的 ⚙;
 *  · 顶栏「环境配置」用的**也是齿轮**,而且又大又有文字。
 * 于是找皮肤的人一定先点顶栏那个,翻不到就以为功能没做。
 *
 * 这类"功能在、但等于不在"的问题,单测抓不到,只能把结论钉在这里。
 * ============================================================ */

test('齿轮图标只对应一个入口', () => {
  /* 两个地方都用齿轮,用户就得靠试。而试错的成本是
     "以为这个功能不存在" —— 比多点一次严重得多。 */
  const app = read('src/App.jsx');
  const tabs = app.slice(app.indexOf('const TABS = ['), app.indexOf('];', app.indexOf('const TABS = [')));
  assert.ok(!/⚙/.test(tabs), '顶栏标签不该再用齿轮 —— 那是「设置」的图标');
  assert.match(tabs, /label: '环境配置', icon: '🧰'/);
});

test('设置入口带文字,不是光秃秃一个图标', () => {
  const bar = read('src/components/Sidebar.jsx');
  assert.match(bar, /⚙ 设置/);
  assert.match(bar, /title="设置\(⌘,\)"/, '顺手把快捷键写进 tooltip');
});

test('⌘, / Ctrl+, 能打开设置', () => {
  /* 各家桌面应用的通用位置。找不到入口的人第一反应就是按它 ——
     它是这个问题最后一道保险。 */
  const app = read('src/App.jsx');
  assert.match(app, /e\.key !== ',' \|\| !\(e\.metaKey \|\| e\.ctrlKey\)/);
  assert.match(app, /setShowSettings\(true\)/);
  // 监听要摘掉,否则热更新时会越挂越多
  assert.match(app, /removeEventListener\('keydown', onSettingsKey\)/);
});

/* ---------------------------------------------- 功能本身还在 */

const T = loadEsm('src/themes.js');

test('皮肤功能本身完好', () => {
  assert.ok(T.THEMES.length >= 5, '配色数量');
  for (const t of T.THEMES) {
    assert.ok(t.id && t.name && t.colors, `${t.id} 结构完整`);
  }
});

test('设置面板里皮肤排第一', () => {
  /* 它是唯一一个"看一眼就知道有没有生效"的设置项,
     排在后面等于藏起来。 */
  const m = read('src/components/SettingsModal.jsx');
  const body = m.slice(m.indexOf('settings-body'));
  assert.ok(body.indexOf('皮肤') < body.indexOf('终端字号'));
  assert.ok(body.indexOf('皮肤') < body.indexOf('新对话默认权限'));
});

test('皮肤用色块展示,不是下拉列表', () => {
  // 配色是用来看的,名字说明不了任何事
  const m = read('src/components/SettingsModal.jsx');
  assert.match(m, /theme-swatch/);
  assert.match(m, /THEMES\.map/);
});
