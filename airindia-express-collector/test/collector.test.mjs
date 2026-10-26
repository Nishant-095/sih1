import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, dayAccessibleLabel, isFirstParty, isObservedHost,
  shouldCaptureJsonBody, classifyPageState, withDeadline, sourceRole,
  parseBookingHandoff, isFareResponseCandidate, selectBookingPage } from '../src/collect.mjs';
import { parseSearchResponse } from '../src/parse.mjs';

test('invalid route, date, browser, and browser-specific HTTP/2 input are rejected', () => {
  assert.throws(() => parseArgs(['--search', 'DEL:DEL:2026-10-02']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-02-30']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--browser', 'safari']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--browser', 'firefox', '--disable-http2']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--http-transport', 'proxy']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--retries', '2']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--retries', '-1']));
  assert.throws(() => parseArgs(['--search', 'DEL:BOM:2026-10-02', '--renew-session=true']));
  assert.equal(parseArgs(['--search', 'DEL:BOM:2026-10-02', '--renew-session']).renewSession, true);
});

test('search defaults to headed Chrome and the AIX calendar label is exact', () => {
  const options = parseArgs(['--search', 'del:bom:2026-10-02']);
  assert.equal(options.browser, 'chrome');
  assert.equal(options.mode, 'headed');
  assert.equal(options.disableHttp2, false);
  assert.equal(dayAccessibleLabel('2026-10-02'), 'Fri, Oct 02 2026');
  assert.throws(() => dayAccessibleLabel('2026-02-30'), /Invalid calendar date/);
});

test('response capture is limited to observed first-party hosts and post-submit JSON', () => {
  assert.equal(isFirstParty('https://www.airindiaexpress.com/en/book-flights/'), true);
  assert.equal(isFirstParty('https://openair-california.airtrfx.com/api'), false);
  assert.equal(isObservedHost('https://openair-california.airtrfx.com/api'), true);
  assert.equal(isObservedHost('https://example.com/api'), false);
  const submittedAt = 1000;
  const capture = (host, responseAt, contentType = 'application/json') =>
    shouldCaptureJsonBody({ submittedAt, responseAt, contentType, host });
  assert.equal(capture('airindiaexpress.com', 1001), true);
  assert.equal(capture('openair-california.airtrfx.com', 1001), true);
  assert.equal(capture('example.com', 1001), false);
  assert.equal(capture('airindiaexpress.com', 999), false);
  assert.equal(capture('airindiaexpress.com', 1001, 'text/html'), false);
  assert.equal(capture('airindiaexpress.com', NaN), false);
});

test('booking challenges and denials are classified as blocking states', () => {
  assert.equal(classifyPageState('Complete the CAPTCHA').code, 'CAPTCHA');
  assert.equal(classifyPageState('', [{ sourceRole: 'aix-site', status: 403 }]).code, 'ACCESS_DENIED');
  assert.equal(classifyPageState('', [{ sourceRole: 'aix-site', status: 429 }]).code, 'RATE_LIMITED');
  assert.equal(classifyPageState('Your session has expired').code, 'SESSION_EXPIRED');
  assert.equal(classifyPageState('No flights found').code, 'EMPTY_RESULTS');
  assert.equal(classifyPageState('Search results'), null);
});

test('unknown AIX response schema fails closed without emitting fare rows', () => {
  const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-02' };
  assert.equal(parseSearchResponse({ fares: [{ flight: 'IX123', price: 1 }] }, query), null);
  assert.equal(parseSearchResponse('{"fares":[{"flight":"IX123","price":1}]}', query), null);
  assert.throws(() => parseSearchResponse('not json', query), error =>
    error.code === 'FARE_RESPONSE_UNVERIFIED');
  assert.throws(() => parseSearchResponse('{}', { ...query, origin: 'DEL2' }), error =>
    error.code === 'FARE_RESPONSE_UNVERIFIED');
});

test('an unresponsive browser operation has a bounded diagnostic failure', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 15, 'Read page'),
    error => error.code === 'TIMEOUT' && /Read page exceeded 15 ms/.test(error.message));
  assert.equal(await withDeadline(Promise.resolve('ready'), 100, 'Read page'), 'ready');
});

test('the booking deeplink is a handoff and cannot be treated as a fare response', () => {
  const handoffUrl = 'https://openair-california.airtrfx.com/deeplink-service/v2/i5/deeplinks';
  const role = sourceRole(handoffUrl);
  assert.equal(role, 'booking-handoff');
  assert.equal(isFareResponseCandidate({ sourceRole: role, status: 200,
    contentType: 'application/json', path: '/deeplink-service/v2/i5/deeplinks' }), false);
  assert.deepEqual(parseBookingHandoff({ method: 'POST', url: 'https://www.airindiaexpress.com/booking' }),
    { method: 'POST', url: 'https://www.airindiaexpress.com/booking' });
  assert.equal(parseBookingHandoff({ method: 'GET', url: 'http://www.airindiaexpress.com/booking' }), null);
  assert.equal(parseBookingHandoff({ method: 'GET', url: 'https://user:secret@example.com/' }), null);
  assert.equal(parseBookingHandoff({ method: 'DELETE', url: 'https://www.airindiaexpress.com/booking' }), null);
  assert.equal(isFareResponseCandidate({ sourceRole: 'airport-suggestions', status: 200,
    contentType: 'application/json', path: '/airports/search' }), false);
  assert.equal(isFareResponseCandidate({ sourceRole: 'aix-booking-engine', status: 200,
    contentType: 'application/json', path: '/api/availability' }), true);
  assert.equal(isFareResponseCandidate({ sourceRole: 'aix-booking-engine', status: 403,
    contentType: 'application/json', path: '/api/availability' }), false);
});

test('a delayed popup is followed only after it reaches the booking destination', () => {
  const landing = { url: () => 'https://www.airindiaexpress.com/en/book-flights/' };
  let destination = 'about:blank';
  const popup = { url: () => destination, isClosed: () => false };
  const pages = new Set([landing, popup]);
  assert.equal(selectBookingPage(pages, landing), landing);
  destination = 'https://www.airindiaexpress.com/booking';
  assert.equal(selectBookingPage(pages, landing), popup);
  destination = 'https://unconfirmed.example/booking';
  assert.equal(selectBookingPage(pages, landing), landing);
  assert.equal(selectBookingPage(pages, landing, landing.url(), new Set(['unconfirmed.example'])), popup);
});
