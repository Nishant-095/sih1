import test from 'node:test';
import assert from 'node:assert/strict';
import { installHttpTransport } from '../src/http-transport.mjs';

function mockContext() {
  return {
    installed: null,
    removed: null,
    async route(pattern, handler) { this.installed = { pattern, handler }; },
    async unroute(pattern, handler) { this.removed = { pattern, handler }; }
  };
}

function mockRoute({ url, status = 200, body = Buffer.from('fresh response'), fetchError = null }) {
  const response = {
    status: () => status,
    headers: () => ({ 'content-type': 'application/json', 'x-origin': 'booking-server' }),
    async body() { return body; },
    async dispose() { this.disposed = true; }
  };
  const request = { url: () => url, method: () => 'GET', resourceType: () => 'document' };
  return {
    response,
    request: () => request,
    fetchOptions: null,
    fulfilled: null,
    continued: false,
    aborted: null,
    async fetch(options) {
      this.fetchOptions = options;
      if (fetchError) throw fetchError;
      return response;
    },
    async fulfill(options) { this.fulfilled = options; },
    async continue() { this.continued = true; },
    async abort(reason) { this.aborted = reason; }
  };
}

test('fresh route.fetch forwards a 403 response unchanged and records it', async () => {
  const context = mockContext();
  const records = [];
  await installHttpTransport(context, { accepts: url => url.includes('airindiaexpress.com'),
    record: async entry => records.push(entry) });
  assert.equal(context.installed.pattern, '**/*');

  const route = mockRoute({ url: 'https://www.airindiaexpress.com/en/book-flights/',
    status: 403, body: Buffer.from('access denied') });
  await context.installed.handler(route);

  assert.deepEqual(route.fetchOptions, { timeout: 15000, maxRedirects: 0, maxRetries: 0 });
  assert.deepEqual(route.fulfilled, { response: route.response, body: Buffer.from('access denied') });
  assert.equal(route.fulfilled.response.status(), 403);
  assert.deepEqual(route.fulfilled.response.headers(), {
    'content-type': 'application/json', 'x-origin': 'booking-server'
  });
  assert.equal(route.fulfilled.body.toString(), 'access denied');
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 403);
  assert.equal(records[0].bytes, 13);
  assert.equal(records[0].transport, 'playwright-http1-forwarder');
  assert.equal(route.response.disposed, true);
});

test('unaccepted hosts continue through the browser without transport fetch', async () => {
  const context = mockContext();
  const records = [];
  await installHttpTransport(context, { accepts: url => url.includes('airindiaexpress.com'),
    record: async entry => records.push(entry) });
  const route = mockRoute({ url: 'https://cdn.example.net/widget.js' });
  await context.installed.handler(route);

  assert.equal(route.continued, true);
  assert.equal(route.fetchOptions, null);
  assert.equal(route.fulfilled, null);
  assert.deepEqual(records, []);
});

test('transport failure is recorded and the browser request is aborted', async () => {
  const context = mockContext();
  const records = [];
  await installHttpTransport(context, { accepts: () => true,
    record: async entry => records.push(entry) });
  const route = mockRoute({ url: 'https://www.airindiaexpress.com/en/book-flights/',
    fetchError: new Error('socket closed\nextra details') });
  await context.installed.handler(route);

  assert.equal(route.aborted, 'connectionfailed');
  assert.equal(route.fulfilled, null);
  assert.equal(records.length, 1);
  assert.equal(records[0].failed, 'socket closed');
  assert.equal(records[0].transport, 'playwright-http1-forwarder');
});

test('returned cleanup removes the same route handler', async () => {
  const context = mockContext();
  const cleanup = await installHttpTransport(context, { accepts: () => true, record: async () => {} });
  await cleanup();

  assert.equal(context.removed.pattern, '**/*');
  assert.equal(context.removed.handler, context.installed.handler);
});
