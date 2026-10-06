/**
 * "ChatPanel 的源码"现在是一组文件,不是一个文件。
 *
 * ChatPanel.jsx 原来 1850 行、24 个组件,拆成了 7 个文件。
 * 仓库里几十条测试是**读源码找模式**的(查某个回调有没有、某段文案在不在),
 * 它们关心的是"聊天面板这块代码",不是"叫 ChatPanel.jsx 的那个文件"。
 * 拆分后逐条改路径既繁琐又容易改错,所以统一走这里:把这组文件拼起来读。
 *
 * 顺序固定、文件之间用标记隔开 —— 万一某条断言依赖"A 出现在 B 之前",
 * 拼接顺序变了会悄悄改变结论。
 */
const fs = require('fs');
const path = require('path');

const CHAT_FILES = [
  'ChatPanel.jsx',
  'Message.jsx',
  'ToolMessages.jsx',
  'ImageMessages.jsx',
  'ModelPicker.jsx',
  'GoalBar.jsx',
  'ConversationHome.jsx'
];

function readChatSources() {
  const dir = path.join(__dirname, '..', '..', 'src', 'components');
  return CHAT_FILES
    .map((f) => `/* ===== ${f} ===== */\n${fs.readFileSync(path.join(dir, f), 'utf8')}`)
    .join('\n\n');
}

module.exports = { readChatSources, CHAT_FILES };
