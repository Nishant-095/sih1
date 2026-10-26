import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeNetwork } from '../src/network-diagnostics.mjs';
import { networkAccessFault } from '../src/faults.mjs';

test('records hidden CORS denial status without leaking headers or tokens', async () => {
  const session = new EventEmitter();
  session.send = async () => {};
  session.detach = async () => {};
  const diagnostics = await observeNetwork({ context: () => ({ newCDPSession: async () => session }) });
  session.emit('Network.requestWillBeSent', { requestId: 'post', type: 'Fetch', request: {
    url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search?secret=hidden', method: 'POST' } });
  session.emit('Network.responseReceivedExtraInfo', { requestId: 'post', statusCode: 403,
    headers: { 'Set-Cookie': 'secret-token' } });
  session.emit('Network.loadingFailed', { requestId: 'post', errorText: 'net::ERR_FAILED',
    corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } });
  assert.equal(networkAccessFault(diagnostics.events, 0)?.code, 'ACCESS_DENIED');
  assert.equal(diagnostics.events.find(event => event.kind === 'response_status').allowOriginPresent, false);
  assert.doesNotMatch(JSON.stringify(diagnostics.events), /secret|token|Set-Cookie/);
  await diagnostics.close();
});

test('safe shape survives reordered CDP events and rejection evidence does not leak secrets', async () => {
  const session = new EventEmitter();
  const calls = [];
  session.send = async (method) => {
    calls.push(method);
    if (method === 'Network.getResponseBody') return { body: 'private-response-secret', base64Encoded: false };
  };
  session.detach = async () => {};
  const diagnostics = await observeNetwork({ context: () => ({ newCDPSession: async () => session }) });
  session.emit('Network.requestWillBeSentExtraInfo', { requestId: 'post', headers: {
    Authorization: 'Bearer private-auth-secret', Cookie: 'session=private-cookie-secret',
    Origin: 'https://www.goindigo.in', Referer: 'https://www.goindigo.in/book/flight-select.html?private-query-secret'
  } });
  session.emit('Network.requestWillBeSent', { requestId: 'post', type: 'Fetch', request: {
    url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-client': 'private-header-secret' },
    postData: JSON.stringify({ route: 'DEL-BOM', auth: 'private-post-secret' })
  } });
  session.emit('Network.responseReceivedExtraInfo', { requestId: 'post', statusCode: 403,
    headers: { 'X-Akamai-Request-ID': 'public-reference', 'Set-Cookie': 'private-set-cookie-secret' } });
  session.emit('Network.loadingFailed', { requestId: 'post', errorText: 'net::ERR_FAILED',
    corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } });
  await diagnostics.close();
  const headers = diagnostics.events.find(event => event.kind === 'request_headers');
  assert.equal(headers.authorizationPresent, true);
  assert.equal(headers.authorizationSha256.length, 64);
  assert.deepEqual(headers.cookieNames, ['session']);
  assert.equal(headers.publicHeaders.referer, 'https://www.goindigo.in/book/flight-select.html');
  const shape = diagnostics.events.find(event => event.kind === 'request_shape');
  assert.deepEqual(shape.payloadKeys, ['auth', 'route']);
  assert.equal(shape.postDataSha256.length, 64);
  assert.equal(diagnostics.events.find(event => event.kind === 'response_status')
    .responseMeta['x-akamai-request-id'], 'public-reference');
  assert.equal(diagnostics.events.find(event => event.kind === 'rejection_body').available, true);
  assert.deepEqual(calls, ['Network.enable', 'Network.getResponseBody']);
  assert.doesNotMatch(JSON.stringify(diagnostics.events), /private-|Bearer|session=/);
});
