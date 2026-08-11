const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadQuickReplies() {
  const file = path.join(__dirname, '..', 'src', 'quickReplies.js');
  const src = fs.readFileSync(file, 'utf8').replace(/export function/g, 'function');
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(`${src}\nmodule.exports = { extractOptions };`, sandbox);
  return sandbox.module.exports;
}
const { extractOptions } = loadQuickReplies();

test('真实周报的编号清单不应被当成选项(回归:曾误渲染成 1~5 按钮)', () => {
  const weekly = [
    '本周进展',
    '1. 完善每日资讯模块，支持微信公众号作为独立来源进行配置、检索与文章采集，优化资讯历史查看、来源管理和生成稳定性。',
    '2. 完成工作流中心接入，在办公平台新增工作流入口并嵌入智能体页面，打通菜单、路由及工作台展示流程。',
    '3. 开发 AI 写作助手，支持素材上传、文本提取、模板管理、提纲生成、内容生成与改写等核心功能。',
    '4. 完善写作助手的草稿自动保存、历史记录、内容统计和文档导出能力，并支持调用知识库资料辅助写作与引用展示。',
    '5. 优化知识库问答体验，完善检索结果重排、引用异常兜底及清空会话二次确认；相关自动化测试已全部通过。'
  ].join('\n');
  assert.deepEqual(extractOptions(weekly), []);
});

test('计划/步骤类清单同样不误判', () => {
  const plan = '下周计划\n1. 完成前端构建\n2. 优化采集稳定性\n3. 推进上线验收';
  assert.deepEqual(extractOptions(plan), []); // 短但没有"让你选"的线索
});

test('模型确实在让你选时才给出选项', () => {
  const ask = '请选择接下来的操作:\n1. 继续执行\n2. 修改方案\n3. 取消';
  const opts = extractOptions(ask);
  assert.deepEqual(opts.map((o) => o.n), ['1', '2', '3']);
  assert.equal(opts[0].label, '继续执行');
});

test('线索在清单之后(疑问句收尾)也能识别', () => {
  const ask = '1. 用方案 A\n2. 用方案 B\n\n你想用哪个?';
  assert.deepEqual(extractOptions(ask).map((o) => o.label), ['用方案 A', '用方案 B']);
});

test('英文选择提示同样支持', () => {
  const ask = 'Which approach would you prefer?\n1. Refactor now\n2. Ship first';
  assert.equal(extractOptions(ask).length, 2);
});

test('编号不连续、数量过少或选项过长都不算选项', () => {
  assert.deepEqual(extractOptions('请选择:\n1. A\n3. B'), []);          // 跳号
  assert.deepEqual(extractOptions('请选择:\n1. 只有一项'), []);          // 少于 2 项
  const longOne = '请选择:\n1. ' + '很'.repeat(45) + '\n2. 短项';
  assert.deepEqual(extractOptions(longOne), []);                        // 单项过长 -> 更像正文
});

test('选项自身含"选择"字样不足以触发(线索只看前后文)', () => {
  const listOnly = '1. 选择方案A\n2. 选择方案B';
  assert.deepEqual(extractOptions(listOnly), []);
});
