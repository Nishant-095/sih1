import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { selectedAirportCode } from '../src/collect.mjs';

test('reads selected station code from nested IndiGo booking field', async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div role="button"><div class="booking-widget-field" aria-label="sourceCity Delhi Selected">
      <input data-value='{"stationCode":"DEL"}'></div></div>
    <div role="button"><div class="booking-widget-field" aria-label="destinationCity Bengaluru Selected">
      <input data-value='{"stationCode":"BLR"}'></div></div>`);
  assert.equal(await selectedAirportCode(page, 'source'), 'DEL');
  assert.equal(await selectedAirportCode(page, 'destination'), 'BLR');
});
