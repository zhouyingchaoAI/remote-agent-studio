const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_ATTACHMENT_BYTES,
  classifyFile,
  sanitizeFilename,
  uniqueRemoteNames,
  validateFiles,
  extractImagePaths
} = require('../electron/chat/attachments');
const { AttachmentService } = require('../electron/chat/AttachmentService');

test('validates the 20 MB limit and required metadata', () => {
  assert.doesNotThrow(() => validateFiles([{ path: '/tmp/a', name: 'a.png', size: MAX_ATTACHMENT_BYTES }]));
  assert.throws(
    () => validateFiles([{ path: '/tmp/a', name: 'a.png', size: MAX_ATTACHMENT_BYTES + 1 }]),
    /20 MB/
  );
  assert.throws(() => validateFiles([{ name: 'a.png', size: 1 }]), /信息不完整/);
});

test('sanitizes filenames and assigns deterministic collision suffixes', () => {
  assert.equal(sanitizeFilename('../../产品 图.png'), '产品_图.png');
  assert.deepEqual(
    uniqueRemoteNames([{ name: 'a b.txt' }, { name: 'a_b.txt' }, { name: 'a b.txt' }]),
    ['a_b.txt', 'a_b-2.txt', 'a_b-3.txt']
  );
  assert.deepEqual(
    uniqueRemoteNames([{ name: 'a.txt' }, { name: 'a.txt' }, { name: 'a-2.txt' }]),
    ['a.txt', 'a-2.txt', 'a-2-2.txt']
  );
});

test('classifies supported image extensions case-insensitively', () => {
  assert.equal(classifyFile('SHOT.WEBP'), 'image');
  assert.equal(classifyFile('photo.jpeg'), 'image');
  assert.equal(classifyFile('brief.md'), 'file');
});

test('extracts and deduplicates nested local image paths while ignoring URLs', () => {
  const result = extractImagePaths({
    output: ['saved /tmp/generated/a.png', { path: '/tmp/generated/a.png' }],
    other: 'https://example.com/not-local.png and C:\\work\\preview.webp'
  });
  assert.deepEqual(result, ['/tmp/generated/a.png', 'C:\\work\\preview.webp']);
});

test('prepare creates a remote message directory before uploading files', async () => {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-upload-'));
  const localPath = path.join(localDir, 'note.md');
  fs.writeFileSync(localPath, 'note');
  const calls = [];
  const ssh = {
    exec: async (command) => {
      calls.push(['exec', command]);
      if (command.includes('__RAS_HOME__')) return { code: 0, stdout: '__RAS_HOME__/home/test__RAS_HOME__', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    upload: async (local, remote) => calls.push(['upload', local, remote])
  };
  const service = new AttachmentService(ssh, { cacheRoot: path.join(os.tmpdir(), 'ras-test-cache') });
  const result = await service.prepare({
    hostId: 'h1', convId: 'c1', messageId: 'm1', isLocal: false,
    files: [{ path: localPath, name: 'note.md', size: 4 }]
  });

  assert.equal(result[0].remotePath, '/home/test/.remote-agent-studio/attachments/c1/m1/note.md');
  assert.equal(result[0].kind, 'file');
  assert.equal(calls[1][0], 'exec');
  assert.equal(calls[2][0], 'upload');
});

test('local preparation copies into the conversation cache and image resolution returns a data URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-attachment-'));
  const imagePath = path.join(dir, 'tiny.png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const ssh = { exec: async () => { throw new Error('must not execute'); } };
  const service = new AttachmentService(ssh, { cacheRoot: path.join(dir, 'cache'), homeDir: dir });

  const [prepared] = await service.prepare({
    hostId: 'local', convId: 'c1', messageId: 'm1', isLocal: true,
    files: [{ path: imagePath, name: 'tiny.png', size: 4 }]
  });
  const resolved = await service.resolveImage({
    hostId: 'local', convId: 'c1', remotePath: prepared.remotePath, isLocal: true
  });

  assert.notEqual(prepared.remotePath, imagePath);
  assert.match(prepared.remotePath.replace(/\\/g, '/'), /attachments\/c1\/m1\/tiny\.png$/);
  assert.match(resolved.src, /^data:image\/png;base64,/);
  assert.equal(resolved.size, 4);
});

test('local preparation enforces the actual file size instead of renderer metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-size-'));
  const largePath = path.join(dir, 'large.bin');
  fs.writeFileSync(largePath, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  const service = new AttachmentService({}, { homeDir: dir });
  await assert.rejects(() => service.prepare({
    hostId: 'local', convId: 'c1', messageId: 'm1', isLocal: true,
    files: [{ path: largePath, name: 'large.bin', size: 1 }]
    // 断言「按实际大小拒绝」这件事,不写死具体 MB 数,免得调整上限就得改测试
  }), new RegExp(`${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`));
});

test('image resolution rejects paths outside the conversation cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-scope-'));
  const outside = path.join(dir, 'outside.png');
  fs.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const service = new AttachmentService({}, { homeDir: path.join(dir, 'home') });
  await assert.rejects(() => service.resolveImage({
    hostId: 'local', convId: 'c1', remotePath: outside, isLocal: true
  }), /current conversation/);
});

test('image resolution allows images generated in the conversation working dir (cwd)', async () => {
  // agent(尤其系统权限的 Claude Code)常把图片写进工作目录而非产物目录 —— 应可预览
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cwd-'));
  const img = path.join(cwd, 'zh-account-model.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const service = new AttachmentService({}, { homeDir: path.join(cwd, 'home') });
  const result = await service.resolveImage({
    hostId: 'local', convId: 'c1', remotePath: img, isLocal: true, cwd
  });
  assert.match(result.src, /^data:image\/png;base64,/);
  assert.equal(result.name, 'zh-account-model.png');
  // 没有传 cwd 时仍应拒绝(不放大攻击面)
  await assert.rejects(() => service.resolveImage({
    hostId: 'local', convId: 'c1', remotePath: img, isLocal: true
  }), /current conversation/);
});

test('remote image cache keys include the complete remote path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-cache-key-'));
  let downloads = 0;
  const ssh = {
    exec: async (command) => {
      if (command.includes('__RAS_HOME__')) return { code: 0, stdout: '__RAS_HOME__/home/test__RAS_HOME__', stderr: '' };
      if (command.startsWith('readlink -f')) {
        const match = command.match(/'([^']+)'/);
        return { code: 0, stdout: `${match[1]}\n`, stderr: '' };
      }
      return { code: 0, stdout: '1\n', stderr: '' };
    },
    download: async (_remote, local) => {
      downloads += 1;
      fs.writeFileSync(local, Buffer.from([downloads]));
    }
  };
  const service = new AttachmentService(ssh, { cacheRoot: dir });
  await service.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: '/home/test/.remote-agent-studio/artifacts/c1/m1/output.png', isLocal: false });
  await service.resolveImage({ hostId: 'h1', convId: 'c1', remotePath: '/home/test/.remote-agent-studio/artifacts/c1/m2/output.png', isLocal: false });
  assert.equal(downloads, 2);
  assert.equal(fs.readdirSync(path.join(dir, 'h1', 'c1')).length, 2);
});

test('conversation cleanup is best effort when the remote host is offline', async () => {
  const service = new AttachmentService({ exec: async () => { throw new Error('offline'); } });
  await assert.doesNotReject(() => service.cleanupConversation({ hostId: 'h1', convId: 'c1', isLocal: false }));
});

test('prepared attachment paths must belong to the current message', async () => {
  const service = new AttachmentService({}, { homeDir: os.tmpdir() });
  await assert.rejects(() => service.validatePrepared({
    convId: 'c1', messageId: 'm1', isLocal: true,
    attachments: [{ remotePath: path.join(os.tmpdir(), 'outside.png') }]
  }), /does not belong/);
});

test('listArtifacts merges scanned and event paths without duplicates', async () => {
  const ssh = {
    exec: async (command) => command.includes('__RAS_HOME__')
      ? { code: 0, stdout: '__RAS_HOME__/home/test__RAS_HOME__', stderr: '' }
      : { code: 0, stdout: '/home/test/.remote-agent-studio/artifacts/c1/m1/a.png\n', stderr: '' }
  };
  const service = new AttachmentService(ssh, { cacheRoot: path.join(os.tmpdir(), 'ras-test-cache') });
  const result = await service.listArtifacts({
    convId: 'c1', messageId: 'm1', isLocal: false,
    extraPaths: ['/home/test/.remote-agent-studio/artifacts/c1/m1/a.png']
  });
  assert.deepEqual(result.map((item) => item.remotePath), [
    '/home/test/.remote-agent-studio/artifacts/c1/m1/a.png'
  ]);
});

test('local artifact discovery collapses escaped Windows path duplicates', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-win-artifact-'));
  const service = new AttachmentService({}, { homeDir: home });
  const dir = await service.ensureArtifactDir({ convId: 'c1', messageId: 'm1', isLocal: true });
  const imagePath = path.join(dir, 'preview.png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const escaped = imagePath.replace(/\\/g, '\\\\');

  const result = await service.listArtifacts({
    convId: 'c1', messageId: 'm1', isLocal: true, extraPaths: [escaped]
  });

  assert.deepEqual(result, [{ remotePath: imagePath, name: 'preview.png' }]);
});
