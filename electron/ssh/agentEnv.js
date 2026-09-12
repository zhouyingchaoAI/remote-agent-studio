/**
 * 远端跑引擎时的环境前缀 —— **只此一份**。
 *
 * ── 为什么要单独抽出来 ──
 *
 * 这段 PATH 以前有两份,而且**顺序是反的**:
 *
 *   实际执行(AgentSession):PATH="$HOME/.npm-global/bin:...:$PATH"   ← 前置
 *   可用性检测(Installer.detect):PATH="$PATH:$HOME/.npm-global/bin:..." ← 追加
 *
 * 平时看不出差别,但只要系统 PATH 里**另有一个 codex**
 * (装过一次没卸干净、发行版自带的包装脚本、别人装在 /usr/local/bin 的),
 * 两边解析到的就是**不同的二进制**:
 *
 *   检测走追加 → 找到系统那个 → 界面显示「codex 可用 v0.x」
 *   执行走前置 → 用的是家目录那个 → 可能根本跑不起来
 *
 * 结果就是"检测说有、实际用不了",而且用户完全没法从界面上看出矛盾 ——
 * 这类不一致比直接报错难查得多。
 *
 * 所以:检测、安装校验、实际执行,统统用这里的同一份。
 */

/** PATH 前缀。前置,因为我们装的那份优先级必须高于系统里可能存在的同名命令。 */
const BIN_PATH = 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH";';

/**
 * 完整前缀:PATH + nvm + 两个 env 脚本。
 *
 * 非交互式 ssh exec 不会读 .bashrc/.profile,nvm 装的 node 因此不在 PATH 上 ——
 * 必须自己 source 一遍,否则表现为"终端里明明能跑,应用里说找不到"。
 */
const AGENT_ENV = [
  BIN_PATH,
  'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1;',
  '[ -s "$HOME/.remote-agent-node-env.sh" ] && . "$HOME/.remote-agent-node-env.sh";',
  '[ -s "$HOME/.remote-agent-env.sh" ] && . "$HOME/.remote-agent-env.sh";'
].join(' ');

module.exports = { BIN_PATH, AGENT_ENV };
