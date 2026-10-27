import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSearchResponse } from '../src/parse.mjs';
import { verifyRun, verifySearch } from '../src/verify.mjs';

const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function sourceResponse() {
  return JSON.stringify({ status: 'SUCCESS', hasError: false,
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
          total: 6581, taxes: [{ code: 'YQ', value: 1581, currencyCode: 'INR' }] }] } }]
    }] }]
  });
}

function twoOfferResponse() {
  const data = JSON.parse(sourceResponse());
  const second = structuredClone(data.dictionaries.flight.one);
  second.marketingFlightNumber = '456';
  second.departure.dateTime = '2026-10-03T12:00:00+05:30';
  second.arrival.dateTime = '2026-10-03T14:00:00+05:30';
  data.dictionaries.flight.two = second;
  const group = structuredClone(data.responsePayload[0].airBoundGroups[0]);
  group.boundDetails.segments = [{ flightId: 'two' }];
  group.airBounds[0].aiUnitPrice.value = 7581;
  const price = group.airBounds[0].prices.totalPrices[0];
  price.base = 6000;
  price.total = 7581;
  data.responsePayload[0].airBoundGroups.push(group);
  return JSON.stringify(data);
}

const page = `<div class="ai-pb-flight-item">
  <span class="ai-pb-flight-id">AI 123</span>
  <span class="ai-pb-departure-city-code">DEL</span>
  <span class="ai-pb-actual-arrival-city">BOM</span>
  <span class="ai-pb-departure-time">09:00</span>
  <span class="ai-pb-arrival-time">11:00</span>
  <span class="ai-pb-currency-code">INR</span>
  <span class="ai-pb-price">₹ 6,581</span>
</div>`;

async function savedEvidence(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-verify-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = { airlineResponse: sourceResponse(), resultPage: page, resultScreenshot: 'fake image bytes' };
  const evidence = {};
  for (const [key, contents] of Object.entries(files)) {
    const filename = `${key}.dat`;
    await fs.writeFile(path.join(directory, filename), contents);
    evidence[key] = filename;
    evidence[`${key}Sha256`] = sha256(contents);
  }
  const result = { status: 'ok', query, fares: parseSearchResponse(files.airlineResponse, query), evidence };
  return { directory, result };
}

test('saved search verifies complete response, page, and screenshot file hashes', async t => {
  const { directory, result } = await savedEvidence(t);
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, true, report.errors.join('; '));
  assert.equal(report.evidenceIntegrityOk, true);
});

test('saved verifier rejects same-count duplicate substitution across two source offers', async t => {
  const { directory, result } = await savedEvidence(t);
  const response = twoOfferResponse();
  await fs.writeFile(path.join(directory, result.evidence.airlineResponse), response);
  result.evidence.airlineResponseSha256 = sha256(response);
  const secondCard = page.replace('AI 123', 'AI 456').replace('09:00', '12:00')
    .replace('11:00', '14:00').replace('6,581', '7,581');
  const pageFile = path.join(directory, result.evidence.resultPage);
  const twoCardPage = `${page}${secondCard}`;
  await fs.writeFile(pageFile, twoCardPage);
  result.evidence.resultPageSha256 = sha256(twoCardPage);
  result.fares = parseSearchResponse(response, query);
  assert.equal(result.fares.length, 2);
  result.fares = [result.fares[0], result.fares[0]];
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => /Saved fare differs/.test(error)));
});

test('saved verifier rejects a tampered HTML result page', async t => {
  const { directory, result } = await savedEvidence(t);
  await fs.appendFile(path.join(directory, result.evidence.resultPage), '<!-- changed -->');
  const report = await verifySearch(directory, result);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some(error => /hash differs/.test(error)));
});

test('agent run verifier rejects an empty manifest', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'airindia-empty-manifest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ id: 'empty', searches: [] }));
  const report = await verifyRun(directory);
  assert.equal(report.ok, false);
  assert.equal(report.checks.length, 0);
});
