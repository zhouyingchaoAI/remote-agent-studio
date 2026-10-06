const test = require('node:test');
const { readChatSources } = require('./helpers/chatSource');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers/tmp');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* 用户在远程生成了一份 .docx,对话里出现「下载《…》」但点不动。
 * 根因:产物扫描只认图片扩展名,docx 从未到达界面;那句「下载」
 * 只是模型写的纯文本,背后没有任何链接。 */

test('产物扫描不再只认图片(远程 find 不带扩展名过滤)', () => {
  const src = read('electron/chat/AttachmentService.js');
  assert.match(src, /find \$\{shellQuote\(dir\)\} -maxdepth 2 -type f -print/);
  assert.ok(!/IMAGE_EXTENSIONS[\s\S]{0,120}-iname/.test(src),
    '远程扫描不该再按图片扩展名过滤');
  // 本机同理
  assert.ok(!/entry\.isFile\(\) && classifyFile\(entry\.name\) === 'image'/.test(src));
});

test('产物按类型分派:图片内联,其余走文件卡片', () => {
  const svc = read('electron/chat/AttachmentService.js');
  assert.match(svc, /kind: classifyFile\(remotePath\) === 'image' \? 'image' : 'file'/);

  const main = read('electron/main.js');
  // 原来无论什么产物都发 kind:'image'
  assert.match(main, /kind: artifact\.kind === 'file' \? 'file' : 'image'/);
  assert.ok(!/msg: \{ kind: 'image', \.\.\.artifact \}/.test(main));
});

test('提供另存与在文件夹中显示的通道', () => {
  const main = read('electron/main.js');
  assert.match(main, /ipcMain\.handle\('artifact:saveAs'/);
  assert.match(main, /showSaveDialog/);
  // 本机产物就在本地磁盘上,没有「下载」这回事
  assert.match(main, /hostId === LOCAL_ID[\s\S]{0,120}copyFile/);
  assert.match(main, /ipcMain\.handle\('artifact:reveal'/);

  const preload = read('electron/preload.js');
  assert.match(preload, /saveAs: invoke\('artifact:saveAs'\)/);
  assert.match(preload, /reveal: invoke\('artifact:reveal'\)/);
});

test('前端渲染文件卡片并能保存', () => {
  const src = readChatSources();
  assert.match(src, /case 'file':/);
  assert.match(src, /function ArtifactFile/);
  assert.match(src, /window\.api\.artifacts\.saveAs/);
  assert.match(src, /在文件夹中显示/);
});

test('按扩展名给出类型标签与配色,Word 与 Excel 要能一眼区分', () => {
  // 纯逻辑抽在 src/fileKind.js:JSX 文件 node 直接 require 不了,
  // 而这类映射表恰恰最该被测
  const { fileKind } = require('../src/fileKind.js');
  assert.deepEqual(
    { ...fileKind('轨交智能客流识别平台产品说明书.docx') },
    { ext: 'DOCX', label: '文档', color: '#2b5797', letter: 'W' });
  assert.equal(fileKind('data.xlsx').letter, 'X');
  assert.notEqual(fileKind('a.docx').color, fileKind('a.xlsx').color);
  // 未知扩展名不能崩,也不能给出误导性的类型
  assert.equal(fileKind('noext').label, '文件');
  assert.equal(fileKind('').letter, '?');
});

test('端到端:真实 docx 落在产物目录里能被发现并标为 file', async () => {
  const { AttachmentService } = require('../electron/chat/AttachmentService');
  const home = tmpDir('ras-artifact-doc-');
  const service = new AttachmentService({}, { homeDir: home });
  const dir = await service.ensureArtifactDir({ convId: 'c1', messageId: 'm1', isLocal: true });

  // 复刻用户的真实场景:中文名的 docx + 一张图,混在一起
  const docx = path.join(dir, '轨交智能客流识别平台产品说明书.docx');
  fs.writeFileSync(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // zip 头
  fs.writeFileSync(path.join(dir, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const out = await service.listArtifacts({ convId: 'c1', messageId: 'm1', isLocal: true });
  const found = out.find((a) => a.name.endsWith('.docx'));
  assert.ok(found, `docx 没被发现,实际结果:${JSON.stringify(out)}`);
  assert.equal(found.kind, 'file');
  assert.equal(found.remotePath, docx);
  assert.equal(out.find((a) => a.name === 'chart.png').kind, 'image');

  fs.rmSync(home, { recursive: true, force: true });
});
