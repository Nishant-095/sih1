import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function sourceFingerprint(root = packageRoot) {
  const files = ['package.json', 'package-lock.json'];
  for (const dir of ['src', 'scripts']) {
    for (const name of await fs.readdir(path.join(root, dir))) {
      if (/\.(?:mjs|py)$/.test(name)) files.push(`${dir}/${name}`);
    }
  }
  const digest = crypto.createHash('sha256');
  for (const name of files.sort()) {
    digest.update(name).update('\0');
    digest.update(await fs.readFile(path.join(root, name)));
    digest.update('\0');
  }
  return digest.digest('hex');
}
