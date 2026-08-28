/**
 * 测试用临时目录。
 *
 * 起因是一次真实事故:`npm test` 每跑一次就在 /tmp 留下一个 200 MB 的目录
 * 且从不清理 —— 攒了几十次之后磁盘满了,表现是**一堆毫不相干的测试开始失败**
 * (写文件的那些先挂),让人以为是刚改的代码有问题。
 *
 * 所以临时目录一律走这里:登记 + 退出时统一删。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const created = [];
let hooked = false;

function cleanupAll() {
  for (const d of created.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理失败不该让测试挂 */ }
  }
}

/** 建一个临时目录,进程退出时自动删掉 */
function tmpDir(prefix = 'ras-test-') {
  if (!hooked) {
    hooked = true;
    // exit 覆盖正常结束;信号覆盖 Ctrl-C 打断的情况
    process.on('exit', cleanupAll);
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => { cleanupAll(); process.exit(1); });
    }
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

/**
 * 造一个"看起来有这么大"的文件,但不真的占磁盘。
 *
 * 只想验证"按实际大小拒绝"的话,没必要真写 200 MB —— 稀疏文件的
 * stat().size 就是这个数,而占用接近 0,还快得多。
 */
function sparseFile(filePath, size) {
  fs.writeFileSync(filePath, '');
  fs.truncateSync(filePath, size);
  return filePath;
}

module.exports = { tmpDir, sparseFile, cleanupAll };
