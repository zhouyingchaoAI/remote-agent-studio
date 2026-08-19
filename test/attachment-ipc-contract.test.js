const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('preload exposes attachment selection, dropped-file paths, and image resolution', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  assert.match(source, /pickFiles: invoke\('dialog:pickFiles'\)/);
  assert.match(source, /pathForDroppedFile: \(file\) => webUtils\.getPathForFile\(file\)/);
  assert.match(source, /prepare: invoke\('attachments:prepare'\)/);
  assert.match(source, /resolveImage: invoke\('attachments:resolveImage'\)/);
});

test('main send contract carries message attachments through artifact discovery', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  assert.match(source, /messageId, prompt, attachments = \[\]/);
  assert.match(source, /ensureArtifactDir\(\{ convId, messageId: turnId, isLocal \}\)/);
  assert.match(source, /agent\.send\(prompt, \{ attachments, artifactDir \}\)/);
  assert.match(source, /service\.listArtifacts/);
  // 产物按类型分派了:图片内联,docx/pdf 之类走文件卡片。
  // 原来这里断言的是「一律发 image」,那正是 docx 点不动的原因。
  assert.match(source, /kind: artifact\.kind === 'file' \? 'file' : 'image'/);
});
