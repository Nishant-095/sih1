import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyPool } from '../src/proxy-pool.mjs';
import { preflightProxyPool } from '../src/proxy-egress.mjs';

const entries = [
  { id: 'a', proxy: { server: 'http://a.example:8080' } },
  { id: 'b', proxy: { server: 'http://b.example:8080' } },
  { id: 'c', proxy: { server: 'http://c.example:8080' } }
];
const log = async () => {};

test('rotation preflight keeps distinct verified exits and rotates to the second', async () => {
  const pool = await preflightProxyPool(new ProxyPool(entries), {}, log,
    async entry => ({ a: '198.51.100.1', b: '198.51.100.2', c: '198.51.100.2' })[entry.id]);
  assert.equal(pool.entries.length, 2);
  assert.deepEqual(pool.entries.map(entry => entry.exitIp), ['198.51.100.1', '198.51.100.2']);
  const first = pool.choose().entry;
  pool.transportFailure(first.id);
  assert.equal(pool.choose().entry.id, 'b');
});

test('rotation preflight refuses duplicate exits and unusable proxies', async () => {
  const events = [];
  await assert.rejects(preflightProxyPool(new ProxyPool(entries), {},
    async (event, data) => events.push({ event, data }),
    async entry => {
      if (entry.id === 'c') throw new Error('connect failed');
      return '198.51.100.1';
    }), /only 1 distinct working proxy exit IP/);
  assert.ok(events.some(item => item.event === 'proxy_preflight_duplicate'));
  assert.ok(events.some(item => item.event === 'proxy_preflight_failure'));
});

test('rotation preflight rejects direct access and a single endpoint', async () => {
  await assert.rejects(preflightProxyPool(new ProxyPool([entries[0]]), {}, log,
    async () => '198.51.100.1'), /at least two configured proxy endpoints/);
  await assert.rejects(preflightProxyPool(new ProxyPool([entries[0], { id: 'direct', proxy: null }]),
    {}, log, async () => '198.51.100.1'), /direct access is not a rotating exit/);
});
