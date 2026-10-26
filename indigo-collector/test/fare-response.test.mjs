import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFlightSearchResponse, verifiedResponseFares } from '../src/fare-response.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
const journey = (origin, destination, date, key) => ({
  journeyKey: key,
  designator: { origin, destination, departure: `${date}T03:00:00` },
  segments: [{ identifier: { carrierCode: '6E', identifier: '353' } }],
  passengerFares: [{ isActive: true, productClass: 'B', totalPublishFare: 4700,
    totalTax: 1447, totalFareAmount: 6147 }]
});

test('recognizes only the IndiGo flight search response', () => {
  assert.equal(isFlightSearchResponse('https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search'), true);
  assert.equal(isFlightSearchResponse('https://example.com/v2/flight/search'), false);
});

test('matches route, date, journey key, flight, and complete airline price', () => {
  const payload = { data: { currencyCode: 'INR', trips: [{ origin: 'DEL', destination: 'BOM',
    journeysAvailable: [
      journey('DXN', 'BOM', '2026-10-03', 'nearby'),
      journey('DEL', 'BOM', '2026-10-04', 'wrong-day'),
      journey('DEL', 'BOM', '2026-10-03', 'exact')
    ] }] } };
  const fares = verifiedResponseFares(payload, query);
  assert.deepEqual([...fares.keys()], ['exact']);
  assert.deepEqual(fares.get('exact'), { flights: ['6E 353'], offers: [{ productClass: 'B',
    base: 4700, taxesAndFees: 1447, total: 6147, currency: 'INR' }] });
});

test('rejects a fare whose total does not equal base plus tax', () => {
  const invalid = journey('DEL', 'BOM', '2026-10-03', 'bad-price');
  invalid.passengerFares[0].totalFareAmount = 9999;
  const payload = { data: { currencyCode: 'INR', trips: [{ origin: 'DEL', destination: 'BOM', journeysAvailable: [invalid] }] } };
  assert.equal(verifiedResponseFares(payload, query).size, 0);
});

test('does not invent a currency when the airline response omits it', () => {
  const payload = { data: { trips: [{ origin: 'DEL', destination: 'BOM',
    journeysAvailable: [journey('DEL', 'BOM', '2026-10-03', 'exact')] }] } };
  assert.throws(() => verifiedResponseFares(payload, query), /confirm INR currency/);
});
