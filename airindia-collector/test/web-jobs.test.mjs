import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobManager, istDate, validatePlan } from '../src/web-jobs.mjs';

const GIB = 1024 ** 3;
const roomyMemory = async () => ({ totalBytes: 16 * GIB, availableBytes: 12 * GIB });

test('the route/date plan deduplicates inputs and caps work and agents', () => {
  const plan = validatePlan({ routes: ['DEL-BOM', 'del-bom', 'DEL-BLR'],
    offsets: [5, 1, 5], concurrency: 2, browserMode: 'headed' },
  new Date('2026-09-27T06:00:00Z'));
  assert.equal(plan.tasks.length, 4);
  assert.equal(plan.tasks[0].travelDate, '2026-09-28');
  assert.equal(plan.tasks[1].travelDate, '2026-10-02');
  assert.equal(plan.audioCaptchaSolver, false);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [5],
    browserMode: 'headless', audioCaptchaSolver: true }), /visible Chrome/);
  assert.throws(() => validatePlan({ routes: ['DEL-DEL'], offsets: [1] }), /Invalid route/);
  assert.throws(() => validatePlan({ routes: ['DEL-BOM'], offsets: [1], concurrency: 4 }), /Agents/);
  assert.throws(() => validatePlan({ routes: Array.from({ length: 10 }, (_, i) =>
    `DEL-${String.fromCharCode(65 + i)}AA`), offsets: [1, 5, 9, 15, 30, 45] }), /54/);
});

test('the explicitly selected audio helper reaches the worker with its existing interpreter', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-audio-option-'));
  const python = path.join(root, '.session', 'audio-venv',
    ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, 'mock interpreter for the intercepted spawn');
  let started, child;
  const manager = new JobManager({ root: path.join(root, 'runs'), packageRoot: root,
    spawnWorker: (command, args, options) => {
      started = { args, env: options.env };
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM'); return child;
    } });
  try {
    const run = await manager.create({ routes: ['DEL-BOM'], offsets: [5], audioCaptchaSolver: true });
    while (!started) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(run.audioCaptchaSolver, true);
    assert.ok(started.args.includes('--audio-captcha-solver'));
    assert.ok(started.args.includes('--external-chrome'));
    assert.equal(started.env.AIRINDIA_SOLVER_PYTHON, process.env.AIRINDIA_SOLVER_PYTHON || python);
    await manager.cancel(run.id);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('parallel workers have separate profiles and spaced launches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-web-jobs-'));
  const starts = [];
  const children = [];
  const spawnWorker = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', null, 'SIGTERM');
    starts.push({ at: Date.now(), args });
    children.push(child);
    return child;
  };
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 35, spawnWorker,
    memoryInfo: async () => ({ totalBytes: 16 * GIB, availableBytes: 12 * GIB }) });
  try {
    const job = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'], offsets: [1],
      concurrency: 2, browserMode: 'headless' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Two workers did not launch')), 1000);
      const poll = setInterval(() => {
        if (children.length === 2) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 5);
    });
    assert.ok(starts[1].at - starts[0].at >= 25);
    assert.notEqual(starts[0].args.at(starts[0].args.indexOf('--profile') + 1),
      starts[1].args.at(starts[1].args.indexOf('--profile') + 1));
    assert.ok(starts.every(start => start.args.includes('--defer-verification')));
    const snapshot = await manager.get(job.id);
    assert.deepEqual(snapshot.tasks.map(task => task.worker), [1, 2]);
    children.forEach(child => child.emit('close', 2, null));
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('requested worker concurrency is preserved without a RAM gate', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-memory-'));
  const children = [];
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 35,
    memoryInfo: async () => ({ totalBytes: 5.2 * GIB, availableBytes: 3 * GIB }),
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      children.push(child);
      return child;
    } });
  try {
    const run = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'],
      offsets: [9], concurrency: 2 });
    assert.equal(run.requestedConcurrency, 2);
    assert.equal(run.concurrency, 2);
    assert.equal(run.resourceNote, null);
    assert.equal(run.tasks.length, 2);
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(children.length, 2);
    await manager.cancel(run.id);
  } finally {
    await manager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('admission does not inspect RAM or reject a batch for low memory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-memory-refusal-'));
  const plan = validatePlan({ routes: ['DEL-BOM'], offsets: [9], concurrency: 2 });
  const waiting = new JobManager({ root, packageRoot: root,
    memoryInfo: async () => ({ totalBytes: 5.2 * GIB, availableBytes: 1.6 * GIB }) });
  const critical = new JobManager({ root, packageRoot: root,
    memoryInfo: async () => ({ totalBytes: 5.2 * GIB, availableBytes: 0.5 * GIB }) });
  try {
    const queued = await waiting.admitPlan(plan);
    assert.equal(queued.concurrency, 2);
    assert.equal(queued.resourceNote, null);
    assert.equal((await critical.admitPlan(plan)).concurrency, 2);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('desk verification waits for all browser workers and runs one check at a time', async () => {
  const seen = [];
  let activeChecks = 0;
  let peakChecks = 0;
  const manager = new JobManager({ root: os.tmpdir(), packageRoot: os.tmpdir(),
    verifySavedSearch: async directory => {
      seen.push(directory);
      activeChecks++;
      peakChecks = Math.max(peakChecks, activeChecks);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeChecks--;
      return { ok: true, errors: [] };
    } });
  manager.children.set('worker', {});
  const first = manager.verifyWhenIdle('first');
  const second = manager.verifyWhenIdle('second');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(seen, []);
  manager.children.delete('worker');
  const checks = await Promise.all([first, second]);
  assert.ok(checks.every(check => check.ok));
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(peakChecks, 1);
  assert.equal(manager.verifying, 0);
});

test('a stopped server records interrupted work on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-recovery-'));
  const id = 'saved-batch';
  try {
    await fs.mkdir(path.join(root, id));
    await fs.writeFile(path.join(root, id, 'jobs.json'), JSON.stringify({ id,
      status: 'running', startedAt: '2026-09-27T10:00:00Z', tasks: [
        { id: '001', status: 'running', stage: 'markets_ready', events: [], fares: [] } ] }));
    const manager = new JobManager({ root, packageRoot: root });
    const recovered = await manager.get(id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.tasks[0].cause.code, 'SERVER_INTERRUPTED');
    const stored = JSON.parse(await fs.readFile(path.join(root, id, 'jobs.json'), 'utf8'));
    assert.equal(stored.status, 'interrupted');
    assert.ok(stored.finishedAt);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CAPTCHA stops queued searches before another airline request starts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-denial-'));
  let child;
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    const created = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'],
      offsets: [1], concurrency: 1, browserMode: 'headless' });
    while (!child) await new Promise(resolve => setTimeout(resolve, 5));
    const job = manager.jobs.get(created.id);
    await manager.event(job, job.tasks[0], { event: 'failure',
      cause: { code: 'CAPTCHA', detail: 'Challenge shown' } });
    assert.equal(job.stopReason, 'CAPTCHA');
    assert.equal(job.tasks[1].status, 'skipped');
    assert.equal(job.tasks[1].worker, null);
    child.emit('close', 2, null);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a failed worker exposes its saved failure evidence without a fare', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-failure-evidence-'));
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    const created = await manager.create({ routes: ['DEL-BOM'], offsets: [5],
      concurrency: 1, browserMode: 'headed' });
    const job = manager.jobs.get(created.id);
    while (job.tasks[0].status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    const task = job.tasks[0];
    const run = path.join(job.root, 'agent-1', 'saved-attempt');
    const directory = path.join(run, `01-${task.origin}-${task.destination}-${task.travelDate}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({
      status: 'blocked', query: { origin: task.origin, destination: task.destination,
        travelDate: task.travelDate }, fares: [], attempt: 1,
      cause: { code: 'ACCESS_DENIED', detail: 'Booking handoff returned HTTP 403' },
      evidence: { failurePage: 'failure-attempt-1.html',
        failureScreenshot: 'failure-attempt-1.png',
        bookingResponse: 'booking-response-attempt-1.html' }
    }));
    task.runRoot = run;
    await manager.finish(job, task, 2, null, null);
    const snapshot = await manager.get(created.id);
    assert.equal(snapshot.status, 'blocked');
    assert.deepEqual(snapshot.tasks[0].fares, []);
    assert.equal(snapshot.tasks[0].failureEvidence.screenshot, 'failure-attempt-1.png');
    assert.equal(snapshot.tasks[0].cause.code, 'ACCESS_DENIED');
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Stop interrupts the active worker and skips unsent searches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-stop-'));
  let launches = 0;
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      launches++;
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    const created = await manager.create({ routes: ['DEL-BOM', 'DEL-BLR'],
      offsets: [5], concurrency: 1, browserMode: 'headed' });
    while (!launches) await new Promise(resolve => setTimeout(resolve, 5));
    const stopped = await manager.cancel(created.id);
    assert.equal(stopped.stopReason, 'USER_CANCELLED');
    assert.equal(stopped.tasks[1].status, 'skipped');
    assert.equal(stopped.tasks[1].worker, null);
    assert.equal(launches, 1);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('single-search retry keeps the original future travel date', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-retry-'));
  const sourceId = 'saved-failure';
  const travelDate = istDate(5);
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 1000,
    memoryInfo: roomyMemory,
    spawnWorker: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => child.emit('close', null, 'SIGTERM');
      return child;
    } });
  try {
    await fs.mkdir(path.join(root, sourceId));
    await fs.writeFile(path.join(root, sourceId, 'jobs.json'), JSON.stringify({
      id: sourceId, status: 'partial', stopReason: null, browserMode: 'headed',
      tasks: [{ id: '001', origin: 'DEL', destination: 'BOM', travelDate,
        offset: 5, status: 'failed', cause: { code: 'SITE_NETWORK_FAILURE' },
        events: [], fares: [] }] }));
    const retry = await manager.retry(sourceId, '001');
    assert.equal(retry.tasks.length, 1);
    assert.equal(retry.tasks[0].travelDate, travelDate);
    assert.equal(retry.retryOf.runId, sourceId);
    await manager.cancel(retry.id);
    const second = await manager.retry(sourceId, '001');
    assert.equal(second.tasks[0].travelDate, travelDate);
    await manager.cancel(second.id);
  } finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }
});
