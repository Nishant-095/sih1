import test from 'node:test';
import assert from 'node:assert/strict';
import { mayResetIndigoSession, resetIndigoSiteSession } from '../src/session-recovery.mjs';

test('only one owned Chromium retry can reset an invalid session', () => {
  const base = { code: 'SESSION_INVALID', resetUsed: false, attempt: 0, retries: 2,
    browserEngine: 'chromium', cdpUrl: 'http://127.0.0.1:9222', launcherOwned: true };
  assert.equal(mayResetIndigoSession(base), true);
  assert.equal(mayResetIndigoSession({ ...base, code: 'ACCESS_DENIED' }), false);
  assert.equal(mayResetIndigoSession({ ...base, resetUsed: true }), false);
  assert.equal(mayResetIndigoSession({ ...base, attempt: 2 }), false);
  assert.equal(mayResetIndigoSession({ ...base, browserEngine: 'firefox' }), false);
  assert.equal(mayResetIndigoSession({ ...base, launcherOwned: false }), false);
});

test('session reset only clears IndiGo origins and cookies', async () => {
  const calls = [];
  const session = {
    send: async (method, args) => calls.push({ method, args }),
    detach: async () => calls.push({ method: 'detach' })
  };
  const context = {
    newCDPSession: async () => session,
    clearCookies: async options => calls.push({ method: 'clearCookies', options })
  };
  const count = await resetIndigoSiteSession(context, {}, [
    { url: 'https://www.goindigo.in/' },
    { url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' },
    { url: 'https://example.com/collect' },
    { url: 'https://www.goindigo.in.evil.example/collect' }
  ]);
  assert.equal(count, 2);
  assert.deepEqual(calls.filter(item => item.method === 'Storage.clearDataForOrigin')
    .map(item => item.args.origin), [
      'https://www.goindigo.in', 'https://api-prod-flight-skyplus6e.goindigo.in'
    ]);
  assert.equal(calls.filter(item => item.method === 'clearCookies').length, 1);
  assert.equal(calls.at(-1).method, 'detach');
});
