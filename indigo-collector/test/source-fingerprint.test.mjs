import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceFingerprint } from '../src/source-fingerprint.mjs';

test('source fingerprint is stable across copies and changes with collector code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-source-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
    await fs.writeFile(path.join(root, 'src', 'collect.mjs'), 'const version = 1;');
    const first = await sourceFingerprint(root);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await sourceFingerprint(root), first);
    await fs.writeFile(path.join(root, 'src', 'collect.mjs'), 'const version = 2;');
    assert.notEqual(await sourceFingerprint(root), first);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
