const test = require('node:test');
const assert = require('node:assert');
const { normalizeTranscribeUrl, interpretVoiceCommand } = require('../electron/voice');
const { screenshotCommands } = require('../electron/screenshot');

test('normalizeTranscribeUrl appends the transcriptions path once', () => {
  assert.equal(normalizeTranscribeUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(normalizeTranscribeUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/audio/transcriptions');
  // 已是完整端点则原样返回
  assert.equal(normalizeTranscribeUrl('https://x/v1/audio/transcriptions'), 'https://x/v1/audio/transcriptions');
  assert.equal(normalizeTranscribeUrl(''), '');
});

test('interpretVoiceCommand: confirm mode maps words to 确认/取消, cancel wins', () => {
  assert.equal(interpretVoiceCommand('好的确认继续', { mode: 'confirm' }), '确认');
  assert.equal(interpretVoiceCommand('yes please', { mode: 'confirm' }), '确认');
  assert.equal(interpretVoiceCommand('算了取消吧', { mode: 'confirm' }), '取消');
  assert.equal(interpretVoiceCommand('no', { mode: 'confirm' }), '取消');
  // 同时含确认与取消 → 取消优先(更安全)
  assert.equal(interpretVoiceCommand('确认还是取消', { mode: 'confirm' }), '取消');
  assert.equal(interpretVoiceCommand('随便说点别的', { mode: 'confirm' }), null);
  assert.equal(interpretVoiceCommand('', { mode: 'confirm' }), null);
});

test('interpretVoiceCommand: options mode matches digit, chinese numeral, and label', () => {
  const options = [{ n: '1', label: '重构这个函数' }, { n: '2', label: '添加测试' }, { n: '3', label: '保持不变' }];
  assert.equal(interpretVoiceCommand('选第2个', { mode: 'options', options }), '2');
  assert.equal(interpretVoiceCommand('二', { mode: 'options', options }), '2');
  assert.equal(interpretVoiceCommand('添加测试', { mode: 'options', options }), '2');
  assert.equal(interpretVoiceCommand('保持不变就好', { mode: 'options', options }), '3');
  // 超出范围的数字不匹配
  assert.equal(interpretVoiceCommand('第9个', { mode: 'options', options }), null);
  // 选项模式也允许取消
  assert.equal(interpretVoiceCommand('取消', { mode: 'options', options }), '取消');
});

test('screenshotCommands: mac uses interactive screencapture, linux has candidates, win empty', () => {
  const mac = screenshotCommands('darwin', '/tmp/a.png');
  assert.equal(mac.length, 1);
  assert.equal(mac[0].bin, 'screencapture');
  assert.ok(mac[0].args.includes('-i') && mac[0].args.includes('/tmp/a.png'));

  const linux = screenshotCommands('linux', '/tmp/a.png');
  assert.ok(linux.length >= 3);
  assert.ok(linux.some((c) => c.bin === 'gnome-screenshot'));
  assert.ok(linux.every((c) => c.args.includes('/tmp/a.png')));

  assert.deepEqual(screenshotCommands('win32', '/tmp/a.png'), []);
});
