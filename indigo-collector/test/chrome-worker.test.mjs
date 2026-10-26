import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChromeWorker } from '../src/chrome-worker.mjs';
import { collectSearches } from '../src/collect.mjs';
import { verifyRun } from '../src/run-verifier.mjs';

test('consecutive searches initialize Chrome once and keep the same browser/context/page', async () => {
  let opened = 0, connected = 0, closed = 0;
  const page = {}, context = {}, browser = { contexts: () => [context], isConnected: () => true };
  const worker = new ChromeWorker({}, {
    open: async () => { opened++; return { port: 1234, pid: 123, close: async () => { closed++; } }; },
    connect: async () => { connected++; return browser; },
    collect: async (_, runtime) => {
      await runtime.initialize();
      runtime.page ||= page;
      assert.equal(runtime.page, page);
      assert.equal(runtime.context, context);
      return { status: 'ok' };
    }
  });
  await worker.run([], async () => {}); await worker.run([], async () => {});
  assert.equal(opened, 1); assert.equal(connected, 1);
  await worker.close(); assert.equal(closed, 1);
});

test('denied workers refuse another search without relaunching Chrome', async () => {
  const worker = new ChromeWorker({}, { collect: async (_, runtime) => {
    await runtime.onEvent({ event: 'search_failure', code: 'ACCESS_DENIED' });
    return { status: 'blocked' };
  } });
  await worker.run([], async () => {});
  await assert.rejects(worker.run([], async () => {}), /unavailable|denied/);
});

test('partial startup failure closes the owned Chrome process', async () => {
  let closed = 0;
  const worker = new ChromeWorker({}, {
    open: async () => ({ port: 1234, close: async () => { closed++; } }),
    connect: async () => { throw new Error('Connection failed'); }
  });
  await assert.rejects(worker.initialize(), /Connection failed/);
  assert.equal(closed, 1); assert.equal(worker.browser, null);
});

test('worker startup failure records attributable query evidence and its real cause', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-worker-start-failure-'));
  const events = [];
  try {
    const result = await collectSearches(['--search', 'DEL:BOM:2026-11-23', '--output', root,
      '--browser', 'chromium', '--headless'], {
      initialize: async () => { throw Object.assign(new Error('Controlled startup failure'), { code: 'BROWSER_DISCONNECTED' }); },
      onEvent: async event => events.push(event)
    });
    assert.equal(result.status, 'failed');
    const report = await verifyRun(result.runRoot);
    assert.equal(report.validEvidence, true, report.errors.join('; '));
    assert.equal(events.find(event => event.event === 'search_failure').code, 'BROWSER_DISCONNECTED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
