import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { capturePageEvidence } from '../src/page-evidence.mjs';

test('a closed page records capture errors without inventing HTML or screenshot evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-closed-page-'));
  try {
    const page = { url: () => 'https://www.goindigo.in/book/flight-select.html?token=secret',
      content: async () => { throw new Error('Target page has been closed'); },
      screenshot: async () => { throw new Error('Target page has been closed'); } };
    const evidence = await capturePageEvidence(page, dir, 'failure-attempt-2');
    assert.equal(evidence.url, 'https://www.goindigo.in/book/flight-select.html');
    assert.equal(evidence.html, null);
    assert.equal(evidence.screenshot, null);
    assert.equal(evidence.captureErrorFile, 'failure-attempt-2-capture-error.json');
    const data = await fs.readFile(path.join(dir, evidence.captureErrorFile));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),
      evidence.captureErrorSha256);
    assert.deepEqual(JSON.parse(data), [
      { part: 'html', error: 'Error: Target page has been closed' },
      { part: 'screenshot', error: 'Error: Target page has been closed' }
    ]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
