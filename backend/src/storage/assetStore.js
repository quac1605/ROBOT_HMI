import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function createAssetStore({ dataDir }) {
  const baseDir = path.resolve(dataDir);
  const stagingDir = path.join(baseDir, 'staging');
  const assetsDir = path.join(baseDir, 'assets');

  async function ensureRealDirectory(dir) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('ASSET_UNSAFE_DIRECTORY');
  }

  async function init() {
    await ensureRealDirectory(baseDir);
    await ensureRealDirectory(stagingDir);
    await ensureRealDirectory(assetsDir);
  }

  function resolveSafePath(relativeKey) {
    if (typeof relativeKey !== 'string' || relativeKey.length > 512 ||
        path.isAbsolute(relativeKey) || relativeKey.includes('\\') ||
        relativeKey.split('/').some(segment => !segment || segment === '.' ||
          segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) {
      throw new Error('ASSET_INVALID_KEY');
    }
    return path.join(assetsDir, ...relativeKey.split('/'));
  }

  async function ensureParents(filePath, create) {
    let current = assetsDir;
    for (const segment of path.relative(assetsDir, path.dirname(filePath)).split(path.sep)) {
      if (!segment || segment === '.') continue;
      current = path.join(current, segment);
      if (create) await fs.mkdir(current, { recursive: false, mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('ASSET_UNSAFE_DIRECTORY');
    }
  }

  async function storeAsset({ relativeKey, data }) {
    await init();
    const finalPath = resolveSafePath(relativeKey);
    await ensureParents(finalPath, true);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sha256 = digest(buffer);
    const tempPath = path.join(stagingDir, `${randomUUID()}.tmp`);
    let committed = false;
    try {
      const handle = await fs.open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(buffer);
        await handle.sync();
      } finally { await handle.close(); }
      const staged = await fs.readFile(tempPath);
      if (staged.byteLength !== buffer.byteLength || digest(staged) !== sha256) {
        throw new Error('ASSET_STAGING_VERIFY_FAILED');
      }
      // Hard link trên cùng filesystem là atomic và KHÔNG ghi đè revision ready.
      await fs.link(tempPath, finalPath);
      const directory = await fs.open(path.dirname(finalPath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      committed = true;
      return { storageKey: relativeKey, sha256, byteCount: buffer.byteLength };
    } finally {
      await fs.unlink(tempPath).catch(error => {
        if (error.code !== 'ENOENT' && !committed) throw error;
      });
    }
  }

  async function readAsset(relativeKey, expected = {}) {
    await init();
    const filePath = resolveSafePath(relativeKey);
    await ensureParents(filePath, false);
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('ASSET_NOT_REGULAR_FILE');
      const data = await handle.readFile();
      if (expected.byteCount !== undefined && data.byteLength !== expected.byteCount) {
        throw new Error('ASSET_SIZE_MISMATCH');
      }
      if (expected.sha256 !== undefined && digest(data) !== expected.sha256) {
        throw new Error('ASSET_HASH_MISMATCH');
      }
      return data;
    } finally { await handle.close(); }
  }

  // Caller must first prove in PostgreSQL that this key is staging/failed.
  async function removeUncommittedAsset(relativeKey) {
    await init();
    const filePath = resolveSafePath(relativeKey);
    try { await ensureParents(filePath, false); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    const stat = await fs.lstat(filePath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ASSET_NOT_REGULAR_FILE');
    await fs.unlink(filePath);
    const directory = await fs.open(path.dirname(filePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }

  async function cleanupStagingTemps() {
    await init();
    let removed = 0;
    for (const entry of await fs.readdir(stagingDir, { withFileTypes: true })) {
      if (!/^[a-f0-9-]{36}\.tmp$/.test(entry.name) || !entry.isFile()) continue;
      await fs.unlink(path.join(stagingDir, entry.name));
      removed += 1;
    }
    return removed;
  }

  return { init, storeAsset, readAsset, removeUncommittedAsset,
    cleanupStagingTemps, baseDir };
}
