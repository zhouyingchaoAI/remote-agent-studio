const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BIN_PATH, AGENT_ENV } = require('../electron/ssh/agentEnv');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* ============================================================
 * "检测说 codex 可用,实际却跑不起来"。
 *
 * 成因:这段 PATH 以前有两份,而且**顺序是反的** ——
 *   实际执行:PATH="$HOME/.npm-global/bin:…:$PATH"   ← 前置
 *   可用性检测:PATH="$PATH:$HOME/.npm-global/bin:…" ← 追加
 *
 * 系统里只要另有一个 codex(装过没卸干净、发行版自带、别人装在
 * /usr/local/bin 的),两边解析到的就是**不同的二进制**,
 * 而用户完全没法从界面上看出这个矛盾。
 * ============================================================ */

test('家目录里的优先级高于系统同名命令', () => {
  /* 前置而不是追加:我们装的那份必须盖过系统里可能存在的旧版本。
     追加的话,一个残留的 /usr/local/bin/codex 就能让新装的形同虚设。 */
  assert.match(BIN_PATH, /PATH="\$HOME\/\.npm-global\/bin:\$HOME\/\.local\/bin:\$PATH"/);
});

test('非交互式 ssh 拿不到 nvm,必须自己 source', () => {
  /* ssh exec 不读 .bashrc/.profile,nvm 装的 node 不在 PATH 上 ——
     表现为"终端里明明能跑,应用里说找不到"。 */
  assert.match(AGENT_ENV, /NVM_DIR/);
  assert.match(AGENT_ENV, /nvm\.sh/);
  assert.match(AGENT_ENV, /remote-agent-node-env\.sh/);
  assert.match(AGENT_ENV, /remote-agent-env\.sh/);
});

test('只此一份:执行、检测、安装校验都引用同一个常量', () => {
  /* 这正是这次的 bug —— 两份定义各自演化,最后互相矛盾。 */
  for (const f of ['electron/ssh/AgentSession.js', 'electron/ssh/Installer.js']) {
    assert.match(read(f), /require\('\.\/agentEnv'\)/, `${f} 应该引用共享定义`);
  }
  /* 谁都不许再就地写一份给**我们自己的命令**用的 PATH。
     写进用户 ~/.bashrc 的那行不算 —— 那是给交互式 shell 的,
     和我们非交互执行时的前缀是两回事。 */
  for (const f of ['electron/ssh/AgentSession.js', 'electron/ssh/Installer.js']) {
    const lines = read(f).split('\n').filter((l) => !l.includes('.bashrc'));
    for (const l of lines) {
      assert.ok(!/export PATH="\$HOME\/\.npm-global/.test(l), `${f} 里还有一份就地定义的 PATH:${l.trim()}`);
      assert.ok(!/PATH="\$PATH:\$HOME\/\.npm-global/.test(l), `${f} 里还有追加式的 PATH(顺序反了):${l.trim()}`);
    }
  }
});

test('检测脚本用的就是执行时那份环境', () => {
  const s = read('electron/ssh/Installer.js');
  const detect = s.slice(s.indexOf('async detect()'), s.indexOf('async ensureNode'));
  assert.match(detect, /\$\{AGENT_ENV\}/);
});

test('检测会报出解析到的二进制路径', () => {
  /* 光一个版本号看不出用的是哪一份,而"装了好几份 codex"
     恰恰是这类问题最常见的成因。 */
  const s = read('electron/ssh/Installer.js');
  assert.match(s, /CODEX_BIN=\$\(command -v codex/);
  assert.match(s, /codexBin: get\('CODEX_BIN'\)/);
  assert.match(read('src/components/SetupPanel.jsx'), /env\.codexBin/);
});

test('检测脚本能在真 bash 里干净地跑完', () => {
  /* 这个脚本是拼出来的,里面既有 shell 又有 JS 模板 ——
     注释写成 `/* *\/` 会被当成通配符去执行(这一轮已经踩过一次)。
     所以要真的跑一遍,而不是看着像对。 */
  const s = read('electron/ssh/Installer.js');
  const m = s.match(/const script = `([\s\S]*?)`;/);
  assert.ok(m, '没找到检测脚本');
  const script = m[1].replace('${AGENT_ENV}', AGENT_ENV);

  const r = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(r, /^OS=/m);
  assert.match(r, /^CODEX=/m);
  assert.match(r, /^CODEX_BIN=/m, '路径行必须有,哪怕是空的');
});

test('检测脚本不往 stderr 吐垃圾', () => {
  /* 有杂音的话,真正的报错会被淹掉 —— 而这个脚本正是排查问题的起点。 */
  const s = read('electron/ssh/Installer.js');
  const script = s.match(/const script = `([\s\S]*?)`;/)[1].replace('${AGENT_ENV}', AGENT_ENV);
  const err = execFileSync('bash', ['-c', `{ ${script} } 2>&1 1>/dev/null`], { encoding: 'utf8' });
  assert.equal(err.trim(), '');
});
