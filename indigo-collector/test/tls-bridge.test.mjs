import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeBridgeResources, isCacheablePublicAsset, shouldBridge, startWorker } from '../src/tls-bridge.mjs';

test('bridges the public site and booking code but not other hosts', () => {
  assert.equal(shouldBridge('https://www.goindigo.in/', 'GET'), true);
  assert.equal(shouldBridge('https://app-prod-skyplus6e.goindigo.in/login/734.js', 'GET'), true);
  assert.equal(shouldBridge('https://example.com/', 'GET'), false);
  assert.equal(shouldBridge('https://www.goindigo.in/banner.jpg', 'GET', 'image'), false);
});

test('bridges the airport lookup with its request body', () => {
  const url = 'https://api-prod-skyplus.goindigo.in/bookingwidgetsearchengine/search';
  assert.equal(shouldBridge(url, 'POST'), true);
  assert.equal(shouldBridge(url, 'GET'), true);
  assert.equal(shouldBridge(url, 'DELETE'), false);
});

test('experimental flight transport is opt-in and scoped to one IndiGo POST', () => {
  const url = 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search';
  assert.equal(shouldBridge(url, 'POST', 'fetch'), false);
  assert.equal(shouldBridge(url, 'POST', 'fetch', true), true);
  assert.equal(shouldBridge(url, 'GET', 'fetch', true), false);
  assert.equal(shouldBridge('https://example.com/v2/flight/search', 'POST', 'fetch', true), false);
});

test('caches only public site code, never searches, prices, or page HTML', () => {
  assert.equal(isCacheablePublicAsset('https://app-prod-skyplus6e.goindigo.in/booking/3521712cffc765b04cfbf05.js', 'GET'), true);
  assert.equal(isCacheablePublicAsset('https://www.goindigo.in/etc.clientlibs/skyplus6ev2/clientlibs/site.css', 'GET'), true);
  assert.equal(isCacheablePublicAsset('https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search', 'POST'), false);
  assert.equal(isCacheablePublicAsset('https://www.goindigo.in/content/api/s6web/in/en/v1/bw-main.json', 'GET'), false);
  assert.equal(isCacheablePublicAsset('https://www.goindigo.in/book/flight-select.html', 'GET'), false);
  assert.equal(isCacheablePublicAsset('https://app-prod-skyplus6e.goindigo.in/booking/remoteEntry.js?session=1', 'GET'), false);
  assert.equal(isCacheablePublicAsset('https://example.com/booking/code.js', 'GET'), false);
});

test('bridge worker closes even when the browser route cannot be removed', async () => {
  let closed = false;
  const context = { unroute: async () => { throw new Error('browser closed'); } };
  const worker = { close: async () => { closed = true; } };
  await assert.rejects(closeBridgeResources(context, () => {}, worker), /browser closed/);
  assert.equal(closed, true);
});

test('an unresponsive bridge worker is killed during shutdown', { timeout: 10000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-worker-'));
  try {
    const executable = path.join(dir, 'unresponsive-worker');
    await fs.writeFile(executable, '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    const worker = startWorker(executable, 120);
    await new Promise(resolve => setTimeout(resolve, 150));
    await assert.rejects(worker.fetch({ method: 'GET', url: 'https://example.test/',
      headers: {} }), /did not respond within 120 ms/);
    await worker.close();
    assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
