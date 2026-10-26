import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { JobManager } from '../src/web-jobs.mjs';

async function runFake({ deny = false, hold = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-persistent-jobs-'));
  const launches = [], commands = [];
  const manager = new JobManager({ root, packageRoot: root, minLaunchGapMs: 5,
    persistentWorkers: true, spawnWorker: (_, args) => {
      launches.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.send = (message, callback) => {
        commands.push(message); callback?.();
        if (message.type === 'shutdown') {
          setImmediate(() => child.emit('close', 0, null)); return;
        }
        if (hold) return;
        setImmediate(() => {
          if (deny) child.emit('message', { type: 'event', taskId: message.taskId,
            record: { event: 'search_failure', code: 'ACCESS_DENIED', detail: 'HTTP 403' } });
          child.emit('message', { type: 'done', taskId: message.taskId, exitCode: 2 });
        });
      };
      setImmediate(() => child.emit('message', { type: 'ready' }));
      return child;
    } });
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Persistent batch did not finish')), 2000);
    manager.on('change', (_, run) => {
      if (['partial', 'blocked', 'cancelled'].includes(run.status)) { clearTimeout(timer); resolve(run); }
    });
  });
  const initial = await manager.create({ routes: ['DEL-BOM'], offsets: [1, 5, 45], concurrency: 1,
    browserMode: 'headless' });
  return { root, manager, initial, finished, launches, commands };
}

test('console reuses one IPC worker across three separately saved queries', async () => {
  const f = await runFake();
  try {
    const run = await f.finished;
    assert.equal(f.launches.length, 1);
    assert.match(f.launches[0][0], /chrome-worker\.mjs$/);
    assert.equal(f.commands.filter(m => m.type === 'search').length, 3);
    assert.equal(run.browserLifecycle, 'persistent_worker');
    assert.equal(run.tasks.every(t => t.status === 'failed' && t.fares.length === 0), true);
    assert.equal(f.commands.filter(m => m.type === 'shutdown').length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('a denied persistent search leaves the remaining queue unsent', async () => {
  const f = await runFake({ deny: true });
  try {
    const run = await f.finished;
    assert.equal(run.status, 'blocked'); assert.equal(run.stopReason, 'ACCESS_DENIED');
    assert.equal(f.commands.filter(m => m.type === 'search').length, 1);
    assert.equal(run.tasks.filter(t => t.status === 'skipped').length, 2);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('cancelling a persistent batch shuts its worker down and never launches the queue', async () => {
  const f = await runFake({ hold: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    await f.manager.cancel(f.initial.id);
    const run = await f.finished;
    assert.equal(run.status, 'cancelled');
    assert.equal(f.commands.filter(m => m.type === 'search').length, 1);
    assert.equal(f.commands.filter(m => m.type === 'shutdown').length, 1);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
