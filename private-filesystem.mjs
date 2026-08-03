import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function privateFileError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function ignoreMissing(operation) {
  try {
    await operation();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function createPrivateFileSystem({
  operations = fs,
  randomId = crypto.randomUUID,
  processId = process.pid
} = {}) {
  async function syncDirectory(directoryPath) {
    let handle = null;
    try {
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
      handle = await operations.open(directoryPath, fsConstants.O_RDONLY | noFollow);
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function relativeSegments(boundaryPath, directoryPath) {
    if (!path.isAbsolute(boundaryPath) || !path.isAbsolute(directoryPath)) {
      throw privateFileError('private_boundary_required');
    }
    const relative = path.relative(boundaryPath, directoryPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw privateFileError('private_path_escape');
    }
    return relative ? relative.split(path.sep).filter(Boolean) : [];
  }

  async function walkPrivateDirectories(directoryPath, { boundaryPath, create }) {
    const segments = relativeSegments(boundaryPath, directoryPath);
    const boundaryStat = await operations.lstat(boundaryPath);
    if (boundaryStat.isSymbolicLink()) throw privateFileError('private_boundary_symlink');
    if (!boundaryStat.isDirectory()) throw privateFileError('private_boundary_not_directory');
    let currentPath = boundaryPath;
    for (const segment of segments) {
      const parentPath = currentPath;
      currentPath = path.join(currentPath, segment);
      let stat;
      try {
        stat = await operations.lstat(currentPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (!create) return false;
        try {
          await operations.mkdir(currentPath, { mode: PRIVATE_DIRECTORY_MODE });
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') throw mkdirError;
        }
        stat = await operations.lstat(currentPath);
      }
      if (stat.isSymbolicLink()) throw privateFileError('private_directory_symlink');
      if (!stat.isDirectory()) throw privateFileError('private_path_not_directory');
      if (create) {
        await operations.chmod(currentPath, PRIVATE_DIRECTORY_MODE);
      } else if (process.platform !== 'win32' && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw privateFileError('private_directory_mode');
      }
      if (create) await syncDirectory(parentPath);
    }
    return true;
  }

  async function ensurePrivateDirectory(directoryPath, { boundaryPath } = {}) {
    await walkPrivateDirectories(directoryPath, { boundaryPath, create: true });
  }

  async function writePrivateTemp(finalPath, bytes, { boundaryPath } = {}) {
    const directoryPath = path.dirname(finalPath);
    await ensurePrivateDirectory(directoryPath, { boundaryPath });
    const tempPath = path.join(
      directoryPath,
      `.${path.basename(finalPath)}.tmp-${processId}-${randomId()}`
    );
    let handle = null;
    try {
      handle = await operations.open(tempPath, 'wx', PRIVATE_FILE_MODE);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await operations.chmod(tempPath, PRIVATE_FILE_MODE);
      return tempPath;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await ignoreMissing(async () => await operations.unlink(tempPath));
      throw error;
    }
  }

  async function publishImmutable(finalPath, bytes, { boundaryPath } = {}) {
    const tempPath = await writePrivateTemp(finalPath, bytes, { boundaryPath });
    let published = false;
    try {
      try {
        await operations.link(tempPath, finalPath);
        published = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (published) {
        await operations.chmod(finalPath, PRIVATE_FILE_MODE);
        await ignoreMissing(async () => await operations.unlink(tempPath));
        await syncDirectory(path.dirname(finalPath));
      }
      return { published };
    } finally {
      await ignoreMissing(async () => await operations.unlink(tempPath));
    }
  }

  async function replaceFile(finalPath, bytes, { boundaryPath } = {}) {
    const tempPath = await writePrivateTemp(finalPath, bytes, { boundaryPath });
    try {
      await operations.rename(tempPath, finalPath);
      await operations.chmod(finalPath, PRIVATE_FILE_MODE);
      await syncDirectory(path.dirname(finalPath));
    } finally {
      await ignoreMissing(async () => await operations.unlink(tempPath));
    }
  }

  async function readPrivateFile(filePath, {
    maxBytes = 64 * 1024 * 1024,
    boundaryPath
  } = {}) {
    const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 64 * 1024 * 1024;
    const parentExists = await walkPrivateDirectories(path.dirname(filePath), {
      boundaryPath,
      create: false
    });
    if (!parentExists) {
      const error = new Error('private_file_missing');
      error.code = 'ENOENT';
      throw error;
    }
    const before = await operations.lstat(filePath);
    if (before.isSymbolicLink()) throw privateFileError('private_file_symlink');
    if (!before.isFile()) throw privateFileError('private_path_not_file');
    if (Number(before.nlink || 1) !== 1) throw privateFileError('private_file_link_count');
    if (process.platform !== 'win32' && (before.mode & 0o777) !== PRIVATE_FILE_MODE) {
      throw privateFileError('private_file_mode');
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) {
      throw privateFileError('private_file_size_limit');
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    let handle;
    try {
      handle = await operations.open(filePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      if (error?.code === 'ELOOP') throw privateFileError('private_file_symlink');
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) throw privateFileError('private_path_not_file');
      if (Number(opened.nlink || 1) !== 1) throw privateFileError('private_file_link_count');
      if (process.platform !== 'win32' && (opened.mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw privateFileError('private_file_mode');
      }
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.size > limit
      ) {
        throw privateFileError('private_file_changed');
      }
      const bytes = await handle.readFile();
      if (bytes.length !== opened.size) throw privateFileError('private_file_changed');
      return Buffer.from(bytes);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function pathKind(filePath, { boundaryPath } = {}) {
    const parentExists = await walkPrivateDirectories(path.dirname(filePath), {
      boundaryPath,
      create: false
    });
    if (!parentExists) return 'missing';
    try {
      const stat = await operations.lstat(filePath);
      if (stat.isSymbolicLink()) return 'symlink';
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
      return 'other';
    } catch (error) {
      if (error?.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  async function settleImmutable(finalPath, { boundaryPath } = {}) {
    const directoryPath = path.dirname(finalPath);
    const parentExists = await walkPrivateDirectories(directoryPath, {
      boundaryPath,
      create: false
    });
    if (!parentExists) throw privateFileError('private_file_missing');
    const baseName = path.basename(finalPath);
    const tempPrefix = `.${baseName}.tmp-`;
    const finalStat = await operations.lstat(finalPath);
    if (finalStat.isSymbolicLink()) throw privateFileError('private_file_symlink');
    if (!finalStat.isFile()) throw privateFileError('private_path_not_file');
    if (Number(finalStat.nlink || 1) === 1) {
      await syncDirectory(directoryPath);
      return;
    }
    const names = await operations.readdir(directoryPath);
    for (const name of names) {
      if (!name.startsWith(tempPrefix)) continue;
      const candidatePath = path.join(directoryPath, name);
      let candidateStat;
      try {
        candidateStat = await operations.lstat(candidatePath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (
        candidateStat.isFile() &&
        !candidateStat.isSymbolicLink() &&
        candidateStat.dev === finalStat.dev &&
        candidateStat.ino === finalStat.ino
      ) {
        await operations.unlink(candidatePath);
      }
    }
    await syncDirectory(directoryPath);
    const settled = await operations.lstat(finalPath);
    if (
      !settled.isFile() ||
      settled.isSymbolicLink() ||
      settled.dev !== finalStat.dev ||
      settled.ino !== finalStat.ino ||
      Number(settled.nlink || 1) !== 1
    ) {
      throw privateFileError('private_file_link_count');
    }
  }

  return Object.freeze({
    ensurePrivateDirectory,
    publishImmutable,
    replaceFile,
    readPrivateFile,
    settleImmutable,
    pathKind
  });
}

export const privateFileSystem = createPrivateFileSystem();
