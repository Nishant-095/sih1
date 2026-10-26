import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chooseDate } from '../src/collect.mjs';

test('calendar keeps an already selected date and can reach a third month when the arrow stalls', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.INDIGO_CHROME_PATH || '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="departure" aria-label="departureDate 29 September 2026">Departure</button>
      <div id="calendar" hidden></div>
      <script>
        let selected = '2026-09-29';
        let opens = 0;
        const calendar = document.getElementById('calendar');
        const departure = document.getElementById('departure');
        const month = (name, date, day) => '<div class="rdrMonth"><div class="rdrMonthName">' +
          name + '</div><button class="rdrDay"><div class="custom-calendar-day" data-date="' +
          date + '">' + day + '</div></button></div>';
        function render() {
          const later = selected === '2026-10-31';
          calendar.innerHTML = '<button aria-label="Next Month">Next</button>' +
            (later ? month('October 2026', '2026-10-31', '31') +
              month('November 2026', '2026-11-12', '12') :
              month('September 2026', '2026-09-29', '29') +
              month('October 2026', '2026-10-31', '31'));
          calendar.hidden = false;
          opens++;
        }
        departure.addEventListener('click', render);
        document.addEventListener('click', event => {
          if (!calendar.contains(event.target) && event.target !== departure) calendar.hidden = true;
        });
        calendar.addEventListener('click', event => {
          const date = event.target.closest('[data-date]')?.dataset.date;
          if (!date) return; // The next-month button deliberately does nothing.
          selected = date;
          const d = new Date(date + 'T12:00:00Z');
          departure.setAttribute('aria-label', 'departureDate ' + d.getUTCDate() + ' ' +
            d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }) + ' ' + d.getUTCFullYear());
          calendar.hidden = true;
        });
        window.calendarOpens = () => opens;
      </script>`);
    await chooseDate(page, '2026-09-29');
    assert.equal(await page.evaluate(() => window.calendarOpens()), 0);
    await page.locator('#departure').click();
    await chooseDate(page, '2026-09-29');
    assert.equal(await page.locator('#calendar').isVisible(), false);
    await chooseDate(page, '2026-11-12');
    assert.equal(await page.locator('#departure').getAttribute('aria-label'),
      'departureDate 12 November 2026');
    assert.equal(await page.evaluate(() => window.calendarOpens()), 3);
  } finally { await browser.close(); }
});
