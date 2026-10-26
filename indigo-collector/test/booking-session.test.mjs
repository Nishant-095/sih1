import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForBookingSession } from '../src/booking-session.mjs';

test('pending token refresh must settle before search submission', async () => {
  const pending = new Map([['refresh', { url: 'https://api-prod-session-skyplus6e.goindigo.in/v1/token/refresh' }]]);
  let reads = 0;
  const page = { evaluate: async () => { if (++reads === 3) pending.clear(); return 'complete'; } };
  await waitForBookingSession(page, pending, async () => null, { timeoutMs: 100, pollMs: 1 });
  assert.equal(reads, 3);
});

test('unrelated advertising requests do not prevent booking readiness', async () => {
  const pending = new Map([['ad', { url: 'https://example.com/never-ending-ad' }]]);
  const result = await waitForBookingSession({ evaluate: async () => 'complete' }, pending,
    async () => null, { timeoutMs: 100, pollMs: 1 });
  assert.equal(result.pendingSessionRequests, 0);
});

test('access rejection terminates readiness without waiting or submitting', async () => {
  let evaluated = false;
  await assert.rejects(waitForBookingSession({ evaluate: async () => { evaluated = true; } }, new Map(),
    async () => ({ code: 'ACCESS_DENIED', detail: 'HTTP 403' })), error => error.code === 'ACCESS_DENIED');
  assert.equal(evaluated, false);
});

test('stalled session initialization is reported explicitly', async () => {
  await assert.rejects(waitForBookingSession({ evaluate: async () => 'loading' }, new Map(),
    async () => null, { timeoutMs: 10, pollMs: 1 }), error => error.code === 'SESSION_NOT_READY');
});
