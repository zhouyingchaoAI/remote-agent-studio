const fs = require('fs');
const path = require('path');

/**
 * Enumerate the regular files below a user-selected directory. Symlinks are
 * deliberately excluded so a transfer cannot unexpectedly read outside root.
 */
async function buildLocalDirectoryManifest(rootPath) {
  const root = path.resolve(rootPath);
  const files = [];
  let total = 0;
  let skippedSymlinks = 0;

  async function visit(currentPath) {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
      } else if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const size = (await fs.promises.stat(absolutePath)).size;
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        files.push({ absolutePath, relativePath, size });
        total += size;
      }
    }
  }

  await visit(root);
  return { files, total, skippedSymlinks };
}

module.exports = { buildLocalDirectoryManifest };
