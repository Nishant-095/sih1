import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool } from '../src/proxy-pool.mjs';

test('transport failure cools one proxy and selects the other', () => {
  const pool = new ProxyPool([
    { id: 'one', proxy: { server: 'http://one.example:8080' } },
    { id: 'two', proxy: { server: 'http://two.example:8080' } }
  ]);
  assert.equal(pool.choose().entry.id, 'one');
  const cooldown = pool.transportFailure('one');
  assert.ok(cooldown >= 15000);
  assert.equal(pool.choose().entry.id, 'two');
  pool.success('one');
  assert.equal(pool.choose().entry.id, 'one');
});

test('a single cooled proxy waits instead of silently switching to direct access', () => {
  const pool = new ProxyPool([{ id: 'only', proxy: { server: 'http://one.example:8080' } }]);
  pool.transportFailure('only');
  const choice = pool.choose();
  assert.equal(choice.entry, null);
  assert.ok(choice.waitMs > 0);
});

test('direct network failure does not trigger a fictitious proxy cooldown', () => {
  const pool = new ProxyPool([{ id: 'direct', proxy: null }]);
  assert.equal(pool.transportFailure('direct'), 0);
  assert.equal(pool.choose().entry.id, 'direct');
  assert.equal(pool.snapshot()[0].cooldownUntil, 0);
});

test('a retry keeps the same healthy proxy and its browser profile', () => {
  const pool = new ProxyPool([
    { id: 'one', proxy: { server: 'http://one.example:8080' } },
    { id: 'two', proxy: { server: 'http://two.example:8080' } }
  ]);
  assert.equal(pool.choose().entry.id, 'one');
  assert.equal(pool.choose('one').entry.id, 'one');
  assert.equal(pool.choose().entry.id, 'two');
});
