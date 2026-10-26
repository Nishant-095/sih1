import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tryBrowserLease } from '../src/browser-admission.mjs';

test('simultaneous callers share one slot; release allows the next caller', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-slot-test-'));
  try {
    const leases = await Promise.all(Array.from({length: 3}, () => tryBrowserLease({ root, slots: 1 })));
    assert.equal(leases.filter(Boolean).length, 1);
    await leases.find(Boolean).attach(process.pid);
    assert.equal(await tryBrowserLease({ root, slots: 1 }), null);
    await leases.find(Boolean).release();
    const next = await tryBrowserLease({ root, slots: 1 });
    assert.ok(next); await next.release();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('dead owners are reclaimed, but a surviving worker retains admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-stale-test-'));
  try {
    await fs.mkdir(path.join(root, '0'));
    await fs.writeFile(path.join(root, '0/owner.json'), JSON.stringify({pid: 2147483647, workerPid: process.pid}));
    assert.equal(await tryBrowserLease({ root, slots: 1 }), null);
    await fs.writeFile(path.join(root, '0/owner.json'), JSON.stringify({pid: 2147483647, workerPid: null}));
    assert.equal(await tryBrowserLease({ root, slots: 1 }), null);
    const next = await tryBrowserLease({ root, slots: 1 });
    assert.ok(next); await next.release();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
