const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** 把 ESM 里的纯函数抠出来跑 */
function loadFn(rel, name) {
  const src = read(rel)
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export\s+default\s+function[\s\S]*$/m, '')   // 组件本体不参与
    .replace(/^export\s+(function|const)\s+/gm, '$1 ');
  const box = { console };
  vm.createContext(box);
  vm.runInContext(`${src}\n;__out = ${name};`, box);
  return box.__out;
}

const engineReadiness = loadFn('src/components/EngineStatus.jsx', 'engineReadiness');

/* 用户 2026-08-11 反馈:对话框看不出当前模型是否可用,
 * 下发配置还得切到「环境配置」页。状态与操作要出现在干活的地方。 */

test('没检测过时是「未检测」,不能误报成可用', () => {
  const r = engineReadiness('codex', null);
  assert.equal(r.level, 'unknown');
  assert.match(r.text, /未检测/);
});

test('命令不存在判为未安装,并允许原地安装', () => {
  const r = engineReadiness('codex', { os: 'Linux', node: 'v22', codex: '', claude: '2.1' });
  assert.equal(r.level, 'missing');
  assert.equal(r.canInstall, true);
  assert.match(r.hint, /codex/);
});

test('deepseek 复用 claude CLI —— 装了 claude 就算就绪', () => {
  const env = { claude: '2.1.211 (Claude Code)', codex: '' };
  assert.equal(engineReadiness('deepseek', env).level, 'ready');
  // 反过来:只有 codex 时 deepseek 不该算就绪
  assert.equal(engineReadiness('deepseek', { codex: '0.144.4', claude: '' }).level, 'missing');
});

test('就绪时展示版本号首段,不把整行说明塞进徽标', () => {
  const r = engineReadiness('claude', { claude: '2.1.211 (Claude Code)' });
  assert.equal(r.level, 'ready');
  assert.equal(r.text, '2.1.211');
  assert.match(r.hint, /Claude Code/);
});

test('grok 引擎看 grok 命令', () => {
  assert.equal(engineReadiness('grok', { grok: '' }).level, 'missing');
  assert.equal(engineReadiness('grok', { grok: '1.0.0' }).level, 'ready');
});

/* ---------------- 接线 ---------------- */

test('徽标挂在对话框顶栏,而不是只在环境配置页', () => {
  const chat = read('src/components/ChatPanel.jsx');
  assert.match(chat, /<EngineStatus hostId=\{hostId\} engine=\{conv\.agent\}/);
  assert.match(chat, /import EngineStatus/);
});

test('弹层里能原地完成安装/下发认证/测试,不用切页', () => {
  const src = read('src/components/EngineStatus.jsx');
  for (const api of ['setup.detect', 'setup.installAgent', 'setup.syncAuth', 'setup.testRemoteAgent']) {
    assert.ok(src.includes(`window.api.${api}(`), `弹层应能调用 ${api}`);
  }
  // 仍保留去完整配置页的出口
  assert.match(src, /setTab\('setup'\)/);
});

test('本机没有「下发认证」的概念,按钮要禁用', () => {
  const src = read('src/components/EngineStatus.jsx');
  assert.match(src, /hostId === 'local'/);
});

test('环境配置页改成折叠分区,不再一屏铺满', () => {
  const src = read('src/components/SetupPanel.jsx');
  const folds = src.match(/<Fold /g) || [];
  assert.ok(folds.length >= 3, `应有多个折叠分区,实际 ${folds.length}`);
  assert.ok(!/<section>\s*\n\s*<h3>网络代理/.test(src), '网络代理应已改为折叠');
  // 常用的默认展开,其余收起
  assert.match(src, /title="认证与下发"[^>]*defaultOpen/);
  assert.ok(!/title="网络代理"[^>]*defaultOpen/.test(src), '网络代理不该默认展开');
});
