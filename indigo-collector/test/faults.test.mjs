import test from 'node:test';
import assert from 'node:assert/strict';
import { flightHttpFault, flightSearchTransportFault, isCriticalPageResource, isIndigoUrl, networkAccessFault, preferFlightTransportFailure, stalledFlightSearchFault, stalledResultsDocumentFault } from '../src/faults.mjs';

test('an invalid flight-search token is a session fault, not generic denial', () => {
  assert.equal(flightHttpFault(401, JSON.stringify({ errors: {
    code: 'core:Token:Invalid', message: 'core:Token:Invalid' } }))?.code, 'SESSION_INVALID');
  assert.equal(flightHttpFault(401, '{"error":"denied"}')?.code, 'ACCESS_DENIED');
  assert.equal(flightHttpFault(403, '')?.code, 'ACCESS_DENIED');
});

test('a denied flight-search request stops collection', () => {
  const fault = networkAccessFault([{ status: 403,
    url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' }], 0);
  assert.equal(fault?.code, 'ACCESS_DENIED');
});

test('a denied airport search stops collection', () => {
  const fault = networkAccessFault([{ status: 403,
    url: 'https://api-prod-skyplus.goindigo.in/bookingwidgetsearchengine/search' }], 0);
  assert.equal(fault?.code, 'ACCESS_DENIED');
});

test('a reset flight-search request is a network failure, not an empty result', () => {
  const fault = flightSearchTransportFault([{ failed: 'NS_ERROR_NET_RESET',
    url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' }], 0);
  assert.equal(fault?.code, 'SITE_NETWORK_FAILURE');
  assert.match(fault?.detail, /NS_ERROR_NET_RESET/);
});

test('a closed results page does not hide an observed flight transport failure', () => {
  const flightFault = { code: 'SITE_NETWORK_FAILURE', detail: 'flight POST failed' };
  assert.equal(preferFlightTransportFailure('SEARCH_ERROR', flightFault), 'SITE_NETWORK_FAILURE');
  assert.equal(preferFlightTransportFailure('EMPTY_RESULTS', flightFault), 'SITE_NETWORK_FAILURE');
  assert.equal(preferFlightTransportFailure('EMPTY_RESULTS', null), 'EMPTY_RESULTS');
  assert.equal(preferFlightTransportFailure('ACCESS_DENIED', flightFault), 'ACCESS_DENIED');
  assert.equal(preferFlightTransportFailure('CAPTCHA', flightFault), 'CAPTCHA');
});

test('a stalled IndiGo results document is a transport failure, not an empty result', () => {
  const fault = stalledResultsDocumentFault([{ resourceType: 'document',
    url: 'https://www.goindigo.in/content/skyplus6e/in/en/book/flight-select.html' }]);
  assert.equal(fault?.code, 'SITE_NETWORK_FAILURE');
  assert.equal(stalledResultsDocumentFault([{ resourceType: 'document',
    url: 'https://example.com/book/flight-select.html' }]), null);
});

test('a pending IndiGo flight request is a transport failure, not an empty result', () => {
  const pending = { resourceType: 'fetch',
    url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' };
  assert.equal(stalledFlightSearchFault([pending])?.code, 'SITE_NETWORK_FAILURE');
  assert.equal(stalledFlightSearchFault([{ ...pending,
    url: 'https://example.com/v2/flight/search' }]), null);
});

test('HTTP 429 is rate limiting rather than an access block', () => {
  const fault = networkAccessFault([{ status: 429,
    url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' }], 0);
  assert.equal(fault?.code, 'RATE_LIMITED');
});

test('a failed session refresh is recorded as expiry', () => {
  const fault = networkAccessFault([{ status: 401,
    url: 'https://api-prod-session-skyplus6e.goindigo.in/v1/token/refresh' }], 0);
  assert.equal(fault?.code, 'SESSION_EXPIRED');
});

test('an unrelated chat 403 does not block fare collection', () => {
  const fault = networkAccessFault([{ status: 403,
    url: 'https://6ewai.goindigo.in/sse/api/auth/guest' }], 0);
  assert.equal(fault, null);
});

test('a flight-search denial takes precedence over session expiry', () => {
  const fault = networkAccessFault([
    { status: 401, url: 'https://api-prod-session-skyplus6e.goindigo.in/v1/token/refresh' },
    { status: 403, url: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' }
  ], 0);
  assert.equal(fault?.code, 'ACCESS_DENIED');
});

test('a matching path on another domain is not an IndiGo booking resource', () => {
  const fault = networkAccessFault([{ status: 403,
    url: 'https://example.com/booking/remoteEntry.js' }], 0);
  assert.equal(fault, null);
});

test('an analytics URL mentioning IndiGo is not an IndiGo response', () => {
  assert.equal(isIndigoUrl('https://www.google.com/ccm/collect?url=https://www.goindigo.in/'), false);
});

test('tracks site code needed to render the booking form but ignores chat', () => {
  assert.equal(isCriticalPageResource('https://www.goindigo.in/etc.clientlibs/skyplus6ev2/clientlibs/clientlib-site/resources/5510/5510.js', 'script'), true);
  assert.equal(isCriticalPageResource('https://6ewai.goindigo.in/web-assets/chat.js', 'script'), false);
});
