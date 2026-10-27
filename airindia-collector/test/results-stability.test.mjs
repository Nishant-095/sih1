import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForMatchingResults, classifyFailure } from '../src/collect.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
const body = JSON.stringify({ status: 'SUCCESS', hasError: false,
  dictionaries: { flight: { one: {
    departure: { locationCode: 'DEL', dateTime: '2026-10-03T09:00:00+05:30' },
    arrival: { locationCode: 'BOM', dateTime: '2026-10-03T11:00:00+05:30' },
    marketingAirlineCode: 'AI', marketingFlightNumber: '123', operatingAirlineCode: 'AI'
  } } },
  responsePayload: [{ airBoundGroups: [{
    boundDetails: { originLocationCode: 'DEL', destinationLocationCode: 'BOM',
      segments: [{ flightId: 'one' }] },
    airBounds: [{ aiUnitPrice: { value: 6581, currencyCode: 'INR' },
      prices: { totalPrices: [{ currencyCode: 'INR', base: 5000, totalTaxes: 1581,
        total: 6581 }] } }]
  }] }]
});

function resultPage(price = '6,581') {
  return `<div class="ai-pb-flight-card-wrapper"><div class="ai-pb-flight-item">
    <span class="ai-pb-flight-id">AI 123</span>
    <span class="ai-pb-departure-city-code">DEL</span>
    <span class="ai-pb-actual-arrival-city">BOM</span>
    <span class="ai-pb-departure-time">09:00</span>
    <span class="ai-pb-arrival-time">11:00</span>
    <span class="ai-pb-currency-code">INR</span>
    <span class="ai-pb-price">₹ ${price}</span>
  </div></div>`;
}

function mockPage({ pages, text = '' }) {
  let pageIndex = 0;
  let waits = 0;
  return {
    get waits() { return waits; },
    evaluate: async () => ({ ready: true, text,
      visibleChallenge: /verify you are human|please check the box below|security challenge/i.test(text) }),
    locator(selector) {
      return {
        innerText: async () => selector === 'body' ? text : '',
        count: async () => selector === '.ai-pb-flight-card-wrapper' ? 1 : 0
      };
    },
    content: async () => pages[Math.min(pageIndex, pages.length - 1)],
    waitForTimeout: async () => { waits++; pageIndex++; }
  };
}

test('waits through partial cards, then requires a stable complete match', async () => {
  const page = mockPage({ pages: [resultPage(''), resultPage(), resultPage()] });
  const responses = [{ body }];
  const stable = await waitForMatchingResults(page, responses, query, [],
    { timeoutMs: 40, pollingMs: 1 });
  assert.equal(stable, true);
  assert.ok(page.waits >= 2);
});

test('uses an older matching response despite newer stale and malformed candidates', async () => {
  const stale = body.replace('"value":6581', '"value":7000')
    .replace('"base":5000', '"base":5419').replace('"total":6581', '"total":7000');
  const page = mockPage({ pages: [resultPage(), resultPage(), resultPage()] });
  assert.equal(await waitForMatchingResults(page, [
    { body }, { body: stale }, { body: '{invalid json' }
  ], query, [], { timeoutMs: 40, pollingMs: 1 }), true);
});

test('stops immediately when access challenge appears', async () => {
  const page = mockPage({ pages: [resultPage()], text: 'Please check the box below' });
  await assert.rejects(waitForMatchingResults(page, [], query, [],
    { timeoutMs: 100, pollingMs: 1 }), error => error.code === 'CAPTCHA');
  assert.equal(page.waits, 0);
});

test('returns false within a zero-length deadline when no response is available', async () => {
  const page = mockPage({ pages: [resultPage()] });
  assert.equal(await waitForMatchingResults(page, [], query, [],
    { timeoutMs: 0, pollingMs: 1 }), false);
  assert.equal(page.waits, 0);
});

test('rebinds readiness polling after the old active page closes during its wait', async () => {
  let active = mockPage({ pages: ['<body>old</body>'] });
  let oldWaits = 0;
  active.waitForTimeout = async () => {
    oldWaits++;
    active = mockPage({ pages: [resultPage(), resultPage()] });
    throw new Error('Target page, context or browser has been closed');
  };
  const matched = await waitForMatchingResults(() => active, [{ body }], query, [],
    { timeoutMs: 100, pollingMs: 1 });
  assert.equal(matched, true);
  assert.equal(oldWaits, 1);
});

test('classifies Air India homepage and fare API 401, 403, and 429 responses', () => {
  for (const [status, expected] of [[401, 'SESSION_EXPIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED']]) {
    const homepage = classifyFailure(new Error('search failed'), [
      { path: '/in/en/book/search-flights.html', method: 'GET', status, navigationResponse: true }
    ]);
    const api = classifyFailure(new Error('search failed'), [
      { path: '/api/availability', method: 'POST', status, fareResponse: true }
    ]);
    assert.equal(homepage.code, expected);
    assert.equal(api.code, expected);
  }
});

test('ignores static asset 403 responses when classifying a search failure', () => {
  const cause = classifyFailure(new Error('search failed'), [
    { path: '/assets/logo.svg', method: 'GET', status: 403, fareResponse: false }
  ]);
  assert.equal(cause.code, 'SEARCH_FAILED');
});
