import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(filePath, data, { mode } = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : { encoding: 'utf8' });
  await fs.rename(tmp, filePath);
}

export async function atomicWriteJson(filePath, obj, opts) {
  await atomicWriteFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, opts);
}
