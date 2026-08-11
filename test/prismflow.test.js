const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeBaseUrl, apiUrl, extractCapabilities, extractExecuteText, buildDeployPrompt
} = require('../electron/prismflow');

test('normalizeBaseUrl 补协议、去尾斜杠', () => {
  assert.equal(normalizeBaseUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeBaseUrl('http://1.2.3.4:3000/'), 'http://1.2.3.4:3000');
  assert.equal(normalizeBaseUrl('https://x.com///'), 'https://x.com');
  assert.equal(normalizeBaseUrl('  '), '');
});

test('apiUrl 不产生双斜杠也不漏斜杠', () => {
  assert.equal(apiUrl('http://a:3000/', '/api/ai/v1/context'), 'http://a:3000/api/ai/v1/context');
  assert.equal(apiUrl('a:3000', 'api/ai/v1/context'), 'http://a:3000/api/ai/v1/context');
  assert.equal(apiUrl('', '/x'), '');
});

test('extractCapabilities 兼容 data 包裹与多种字段名', () => {
  const caps = extractCapabilities({
    data: {
      agents: [{ id: 'daily', name: '每日速览', description: '聚合 AI 资讯' }],
      workflows: [{ key: 'wf1', title: '论文流' }],
      tools: [{ name: 'github-trending' }]
    }
  });
  assert.deepEqual(caps.map((c) => [c.action, c.id]), [
    ['agent', 'daily'], ['workflow', 'wf1'], ['tool', 'github-trending']
  ]);
  assert.equal(caps[0].name, '每日速览');
  assert.equal(caps[1].name, '论文流');   // title 兜底
});

test('extractCapabilities 丢弃无 id 的脏项、非数组不报错', () => {
  assert.deepEqual(extractCapabilities({ agents: [{ description: '没有 id' }, null, 'x'] }), []);
  assert.deepEqual(extractCapabilities({ agents: 'not-array' }), []);
  assert.deepEqual(extractCapabilities(null), []);
});

test('extractExecuteText 从不固定的返回结构里挖出可读文本', () => {
  assert.equal(extractExecuteText('直接是字符串'), '直接是字符串');
  assert.equal(extractExecuteText({ content: '正文' }), '正文');
  assert.equal(extractExecuteText({ data: { output: '嵌套输出' } }), '嵌套输出');
  // 完全不认识的结构:退化成 JSON 字符串而不是丢失内容
  assert.match(extractExecuteText({ weird: { a: 1 } }), /weird/);
  assert.equal(extractExecuteText(null), '');
});

test('部署指令包含仓库地址与验证步骤,且限定不要乱改文件', () => {
  const p = buildDeployPrompt({ port: 3000 });
  assert.match(p, /PrismFlowAgent/);
  assert.match(p, /github\.com\/justlovemaki\/PrismFlowAgent/);
  assert.match(p, /api\/ai\/v1\/discovery/);
  assert.match(p, /不要修改我其它项目的文件/);
});
