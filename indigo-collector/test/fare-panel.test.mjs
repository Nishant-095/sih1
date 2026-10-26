import test from 'node:test';
import assert from 'node:assert/strict';
import { openFareDetails } from '../src/fare-panel.mjs';

test('fare details retries once after dismissing the Lite popup', async () => {
  let clicks = 0, dismissals = 0, popupVisible = false;
  const popup = { isVisible: async () => popupVisible,
    locator: () => ({ click: async () => { dismissals++; popupVisible = false; } }) };
  const page = {
    isClosed: () => false,
    locator: () => popup,
    getByRole: role => role === 'dialog' ? {
      waitFor: async () => { if (clicks === 1) throw new Error('not visible'); }
    } : { click: async () => { clicks++; if (clicks === 1) popupVisible = true; } }
  };
  await openFareDetails(page);
  assert.equal(clicks, 2);
  assert.equal(dismissals, 1);
});

test('a closed results page stops fare inspection', async () => {
  const page = {
    isClosed: () => true,
    locator: () => ({ isVisible: async () => false }),
    getByRole: role => role === 'dialog' ? { waitFor: async () => {} } : {
      click: async () => { throw new Error('target closed'); }
    }
  };
  await assert.rejects(openFareDetails(page), error => error.code === 'PAGE_CLOSED');
});
