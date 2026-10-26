import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchPacing } from '../src/search-pacing.mjs';

async function pacingTest(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-pacing-'));
  const options = { file: path.join(root, '.search-pacing.json'), launchGapMs: 20,
    completionGapMs: 20, burstSize: 2, burstRestMs: 90 };
  try { await fn(new SearchPacing(options), options); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('a long-running search still gets a full completion rest', async () => pacingTest(async pacing => {
  await pacing.load();
  await pacing.started(1000);
  await pacing.finished(1100); // launch gap elapsed while the browser was busy
  assert.deepEqual(pacing.gate(1102), { waitMs: 18,
    nextSearchAt: new Date(1120).toISOString(), reason: 'between_searches' });
  assert.equal(pacing.gate(1120).waitMs, 0);
}));

test('batch rest survives a new scheduler and starts after the last completion', async () => pacingTest(async (pacing, options) => {
  await pacing.started(1000); await pacing.finished(1030);
  await pacing.started(1050); await pacing.finished(1080);
  const restarted = new SearchPacing(options);
  await restarted.load();
  assert.equal(restarted.gate(1090).reason, 'batch_rest');
  assert.equal(restarted.gate(1090).waitMs, 80);
  await restarted.finished(1100); // another admitted worker finished later
  assert.equal(restarted.gate(1170).waitMs, 20);
  assert.equal(restarted.gate(1190).waitMs, 0);
  await restarted.started(1190);
  assert.equal(restarted.state.burstCount, 1);
}));

test('starting a new batch cannot erase an unfinished completion rest', async () => pacingTest(async (pacing, options) => {
  await pacing.started(1000); await pacing.finished(1050);
  const restarted = new SearchPacing(options);
  await restarted.load();
  assert.equal(restarted.gate(1060).waitMs, 10);
}));

test('bad persisted pacing does not silently remove rate protection', async () => pacingTest(async (pacing, options) => {
  await fs.writeFile(options.file, '{"version":1,"lastLaunchAt":-1}');
  await assert.rejects(pacing.load(), /Invalid saved/);
}));
