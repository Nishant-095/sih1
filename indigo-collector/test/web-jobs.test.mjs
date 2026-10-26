import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobManager, istDate, validatePlan } from '../src/web-jobs.mjs';

test('India day rollover determines all six offered dates', () => {
  const now = new Date('2026-09-26T19:00:00Z'); // 27 September in India
  assert.equal(istDate(1, now), '2026-09-28');
  assert.equal(istDate(45, now), '2026-11-11');
});

test('expands deduplicated route and date pairs within worker limits', () => {
  const plan = validatePlan({ routes: ['del-bom', 'DEL-BOM', 'BLR-HYD'],
    offsets: [5, 1, 5], concurrency: 3 }, new Date('2026-09-26T10:00:00Z'));
  assert.equal(plan.tasks.length, 4);
  assert.deepEqual(plan.tasks.map(task => `${task.origin}-${task.destination}:${task.travelDate}`),
    ['DEL-BOM:2026-09-27', 'DEL-BOM:2026-10-01',
      'BLR-HYD:2026-09-27', 'BLR-HYD:2026-10-01']);
  assert.throws(() => validatePlan({ routes: ['DEL-DEL'], offsets: [1] }), /Invalid route/);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [2] }), /Choose/);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [1], concurrency: 4 }), /Agents/);
  assert.equal(validatePlan({ routes: ['DEL-BOM'], offsets: [1], browserMode: 'headless' }).browserMode,
    'headless');
  assert.equal(validatePlan({ routes: ['DEL-BOM'], offsets: [1] }).concurrency, 1);
  assert.equal(validatePlan({ routes: ['DEL-BOM', 'DEL-BLR'], offsets: [1] }).concurrency, 2);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [1], browserMode: 'unknown' }), /Browser mode/);
});

test('schedules two independent agents with a launch gap and reports worker failure honestly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-web-jobs-'));
  const launched = [];
  let active = 0, peak = 0;
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    launched.push(Date.now());
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      active--;
      child.stdout.end(); child.stderr.end(); child.emit('close', 2, null);
    }, 80);
    return child;
  };
  const manager = new JobManager({ root, packageRoot: path.resolve('.'),
    minLaunchGapMs: 30, spawnWorker: fakeSpawn,
    memoryInfo: async () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 }) });
  try {
    const run = await manager.create({ routes: ['DEL-BOM', 'BLR-HYD', 'MAA-CCU'],
      offsets: [1], concurrency: 2 });
    const finished = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Batch did not finish')), 1000);
      manager.on('change', (id, snapshot) => {
        if (id === run.id && snapshot.status === 'partial') {
          clearTimeout(timeout); resolve(snapshot);
        }
      });
    });
    assert.equal(launched.length, 3);
    assert.equal(peak, 2);
    assert.ok(launched[1] - launched[0] >= 25);
    assert.equal(finished.tasks.every(task => task.status === 'failed'), true);
    assert.equal(finished.tasks.every(task => task.fares.length === 0), true);
    assert.equal(finished.tasks.every(task => task.cause.code === 'WORKER_DID_NOT_SAVE_RUN'), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('single-search retry preserves the saved date and mode without changing original evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-retry-'));
  const sourceId = 'saved-run';
  const sourceRoot = path.join(root, sourceId);
  await fs.mkdir(sourceRoot);
  const source = { id: sourceId, status: 'partial', stopReason: 'REPEATED_SITE_NETWORK_FAILURE',
    browserMode: 'headless', tasks: [{ id: '001', origin: 'BLR', destination: 'CCU',
      travelDate: istDate(20), offset: 45, status: 'failed',
      cause: { code: 'SITE_NETWORK_FAILURE' } }] };
  await fs.writeFile(path.join(sourceRoot, 'jobs.json'), JSON.stringify(source));
  const launched = [];
  const fakeSpawn = (command, args) => {
    launched.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  };
  const manager = new JobManager({ root, packageRoot: path.resolve('.'),
    minLaunchGapMs: 0, spawnWorker: fakeSpawn,
    memoryInfo: async () => ({ totalBytes: 16 * 1024 ** 3, availableBytes: 12 * 1024 ** 3 }) });
  try {
    const retried = await manager.retry(sourceId, '001');
    assert.equal(retried.tasks.length, 1);
    assert.equal(retried.tasks[0].travelDate, source.tasks[0].travelDate);
    assert.equal(retried.tasks[0].offset, 45);
    assert.equal(retried.browserMode, 'headless');
    assert.deepEqual(retried.retryOf, { runId: sourceId, taskId: '001' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(launched[0].args.slice(1, 3),
      ['--search', `BLR:CCU:${source.tasks[0].travelDate}`]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(sourceRoot, 'jobs.json'))), source);
    await assert.rejects(manager.retry(sourceId, '001'), /already running/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker completion and a server restart both preserve the search gap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-completion-gap-'));
  const launched = [], closed = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    launched.push(Date.now());
    setTimeout(() => { closed.push(Date.now()); child.emit('close', 2, null); }, 60);
    return child;
  };
  const makeManager = () => new JobManager({ root, packageRoot: root,
    minLaunchGapMs: 30, spawnWorker: fakeSpawn });
  async function batch(manager, offsets) {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Batch did not finish')), 1500);
      manager.on('change', (_, snapshot) => {
        if (snapshot.status === 'partial') { clearTimeout(timer); resolve(snapshot); }
      });
    });
    await manager.create({ routes: ['DEL-BOM'], offsets, concurrency: 1 });
    return done;
  }
  try {
    await batch(makeManager(), [1, 5]);
    assert.ok(launched[1] - closed[0] >= 30, 'completion gap was bypassed');
    await batch(makeManager(), [9]);
    assert.ok(launched[2] - closed[1] >= 30, 'new batch/restart removed the gap');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('burst rest cannot expire while the last browser is still working', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-burst-rest-'));
  const launched = [], closed = [];
  const manager = new JobManager({ root, packageRoot: root,
    minLaunchGapMs: 5, burstSize: 1, burstRestMs: 15,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      launched.push(Date.now());
      setTimeout(() => { closed.push(Date.now()); child.emit('close', 2, null); }, 60);
      return child;
    } });
  try {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Batch did not finish')), 1500);
      manager.on('change', (_, run) => {
        if (run.status === 'partial') { clearTimeout(timer); resolve(); }
      });
    });
    await manager.create({ routes: ['DEL-BOM'], offsets: [1, 5], concurrency: 2 });
    await done;
    assert.equal(launched.length, 2);
    assert.ok(launched[1] - closed[0] >= 15, 'a new browser bypassed the burst rest');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed headless flight POST retries the saved search in visible Chrome', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-headed-retry-'));
  const id = 'headless-post-failed';
  await fs.mkdir(path.join(root, id));
  await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify({
    id, status: 'partial', browserMode: 'headless', tasks: [{ id: '001',
      origin: 'DEL', destination: 'BOM', travelDate: istDate(5), offset: 5,
      status: 'failed', cause: { code: 'SITE_NETWORK_FAILURE',
        detail: 'IndiGo flight search request failed: net::ERR_FAILED' } }]
  }));
  const launched = [];
  const manager = new JobManager({ root, packageRoot: path.resolve('.'), minLaunchGapMs: 0,
    spawnWorker: (command, args) => {
      launched.push(args);
      const child = new EventEmitter(); child.stdout = new PassThrough();
      child.stderr = new PassThrough(); return child;
    } });
  try {
    const retried = await manager.retry(id, '001');
    assert.equal(retried.browserMode, 'headed');
    assert.equal(retried.tasks[0].travelDate, istDate(5));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(launched[0].includes('--headless'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('batch retry of failed headless flight POST uses headed mode and saved dates', async () => {
  const manager = new JobManager({ root: os.tmpdir(), packageRoot: path.resolve('.') });
  const savedDate = istDate(15);
  manager.get = async () => ({ status: 'partial', browserMode: 'headless',
    tasks: [{ id: '001', origin: 'DEL', destination: 'BOM', offset: 5,
      travelDate: savedDate, status: 'failed', cause: { code: 'SITE_NETWORK_FAILURE',
        detail: 'IndiGo flight search request failed: net::ERR_FAILED' } }] });
  manager.admitPlan = async plan => plan;
  manager.createPlan = async plan => plan;
  const plan = await manager.retryFailed('source');
  assert.equal(plan.browserMode, 'headed');
  assert.equal(plan.tasks[0].travelDate, savedDate);
});

test('retry refuses an explicit denial and a past travel date', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-retry-denial-'));
  const manager = new JobManager({ root, packageRoot: path.resolve('.') });
  try {
    const sourceRoot = path.join(root, 'denied-run');
    await fs.mkdir(sourceRoot);
    await fs.writeFile(path.join(sourceRoot, 'jobs.json'), JSON.stringify({
      id: 'denied-run', status: 'blocked', stopReason: 'ACCESS_DENIED',
      tasks: [{ id: '001', origin: 'DEL', destination: 'BOM',
        travelDate: istDate(5), offset: 5, status: 'skipped', cause: { code: 'BATCH_STOPPED' } }]
    }));
    await assert.rejects(manager.retry('denied-run', '001'), /denied access/);
    const expiredRoot = path.join(root, 'expired-run');
    await fs.mkdir(expiredRoot);
    await fs.writeFile(path.join(expiredRoot, 'jobs.json'), JSON.stringify({
      id: 'expired-run', status: 'partial', stopReason: null,
      tasks: [{ id: '001', origin: 'DEL', destination: 'BOM',
        travelDate: istDate(-1), offset: 5, status: 'failed', cause: { code: 'TIMEOUT' } }]
    }));
    await assert.rejects(manager.retry('expired-run', '001'), /date has passed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('deleting a saved run removes its fare evidence and listing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-run-delete-'));
  const id = 'saved-run';
  const manager = new JobManager({ root, packageRoot: root });
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify({ id, status: 'complete', tasks: [] }));
    await fs.writeFile(path.join(root, id, 'evidence.html'), 'saved page');
    assert.deepEqual(await manager.deleteRun(id), { id, deleted: true });
    await assert.rejects(fs.access(path.join(root, id)));
    assert.deepEqual(await manager.recent(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
