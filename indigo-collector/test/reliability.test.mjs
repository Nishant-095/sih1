import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceStage, FailureCircuit, failureSignature, shouldTryBridge } from '../src/reliability.mjs';

const failure = (url, error = 'net::ERR_HTTP2_PROTOCOL_ERROR') => ({
  code: 'SITE_NETWORK_FAILURE', failedResources: [{ url, failed: error }]
});

test('search stages cannot claim a completed fare before verified response and page', () => {
  const attempt = { stages: [], stage: 'starting' };
  advanceStage(attempt, 'browser_ready');
  assert.throws(() => advanceStage(attempt, 'fare_verified'), /Invalid search transition/);
  assert.equal(attempt.stage, 'browser_ready');
});

test('circuit opens after the same network failure twice on one exit', () => {
  const circuit = new FailureCircuit(2);
  const widget = failure('https://www.goindigo.in/content/api/s6web/in/en/v1/bw-main.json');
  assert.deepEqual(circuit.record('direct', widget),
    { open: false, signature: 'booking_widget:ERR_HTTP2_PROTOCOL_ERROR', count: 1 });
  assert.equal(circuit.record('other-exit', widget).open, false);
  assert.equal(circuit.record('direct', widget).open, true);
  circuit.reset('direct');
  assert.equal(circuit.record('direct', widget).open, false);
});

test('a stalled flight POST takes priority over an unrelated pending image', () => {
  const cause = { code: 'SITE_NETWORK_FAILURE', failedResources: [], stalledResources: [
    { resourceType: 'image', url: 'https://app-prod-skyplus6e.goindigo.in/booking/icon.svg' },
    { resourceType: 'fetch', url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' }
  ] };
  assert.equal(failureSignature(cause), 'flight_search:STALLED');
  const circuit = new FailureCircuit(2);
  assert.equal(circuit.record('direct', cause).open, false);
  assert.equal(circuit.record('direct', cause).open, true);
});

test('bridge fallback applies to widget transport, not flight denial or failed fare POST', () => {
  const widget = failure('https://www.goindigo.in/v1/setting/indigowidgets');
  const flight = failure('https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search');
  const siteCode = failure('https://www.goindigo.in/etc.clientlibs/skyplus6ev2/clientlibs/clientlib-site/resources/7408/7408.js');
  assert.equal(shouldTryBridge(widget, 'browser', true, 'homepage_loaded'), true);
  assert.equal(shouldTryBridge(siteCode, 'browser', true, 'homepage_loaded'), true);
  assert.equal(shouldTryBridge(widget, 'bridge', true, 'homepage_loaded'), false);
  assert.equal(shouldTryBridge(flight, 'browser', true, 'search_submitted'), false);
  assert.equal(failureSignature({ code: 'ACCESS_DENIED', failedResources: [] }), null);
});
