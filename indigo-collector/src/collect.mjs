#!/usr/bin/env node
import { chromium, firefox } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { loadProxyPool } from './proxy-pool.mjs';
import { currentContextExit, preflightProxyPool, probeProxyExit } from './proxy-egress.mjs';
import { flightHttpFault, flightSearchTransportFault, isBookingResource, isCriticalPageResource, isIndigoUrl, networkAccessFault, preferFlightTransportFailure, stalledFlightSearchFault, stalledResultsDocumentFault } from './faults.mjs';
import { isFlightSearchResponse, verifiedResponseFares } from './fare-response.mjs';
import { installTlsBridge } from './tls-bridge.mjs';
import { observeNetwork } from './network-diagnostics.mjs';
import { capturePageEvidence as evidence } from './page-evidence.mjs';
import { advanceStage, FailureCircuit, shouldTryBridge } from './reliability.mjs';
import { mayResetIndigoSession, resetIndigoSiteSession } from './session-recovery.mjs';
import { sourceFingerprint } from './source-fingerprint.mjs';
import { openFareDetails } from './fare-panel.mjs';
import { displayedStartingFare } from './starting-fare.mjs';
import { waitForBookingSession, browserEnvironment } from './booking-session.mjs';

const HOME = 'https://www.goindigo.in/';
const RESULTS_PATH = '/book/flight-select.html';
const AIRPORT = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function options(argv) {
  const opts = { searches: [], output: 'runs', profile: '.session', maxFlights: 5, allFlights: true,
    minIntervalMs: 10000, interactionDelayMs: 0, retries: 2, headless: false, captchaHandoff: false,
    browserEngine: 'firefox', chromePath: null, cdpUrl: null, chromeHttp1: false,
    tlsBridge: false, autoTransport: false, flightHttp1Bridge: false,
    proxyPool: null, proxy: process.env.INDIGO_PROXY_SERVER || null,
    proxyUsername: process.env.INDIGO_PROXY_USERNAME || null,
    proxyPassword: process.env.INDIGO_PROXY_PASSWORD || null };
  const named = new Map([
    ['--search', 'searches'], ['--output', 'output'], ['--profile', 'profile'],
    ['--max-flights', 'maxFlights'], ['--min-interval-ms', 'minIntervalMs'],
    ['--interaction-delay-ms', 'interactionDelayMs'],
    ['--retries', 'retries'], ['--browser', 'browserEngine'],
    ['--chrome-path', 'chromePath'], ['--cdp-url', 'cdpUrl'],
    ['--proxy', 'proxy'], ['--proxy-pool', 'proxyPool'],
    ['--proxy-username', 'proxyUsername'], ['--proxy-password', 'proxyPassword']
  ]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--headless') { opts.headless = true; continue; }
    if (argv[i] === '--all-flights') { opts.allFlights = true; continue; }
    if (argv[i] === '--chrome-http1') { opts.chromeHttp1 = true; continue; }
    if (argv[i] === '--tls-bridge') { opts.tlsBridge = true; continue; }
    if (argv[i] === '--flight-http1-bridge') { opts.flightHttp1Bridge = true; continue; }
    if (argv[i] === '--auto-transport') { opts.autoTransport = true; continue; }
    if (argv[i] === '--captcha-handoff') { opts.captchaHandoff = true; continue; }
    if (argv[i] === '--help') { opts.help = true; continue; }
    const key = named.get(argv[i]);
    if (!key || !argv[i + 1]) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    const value = argv[++i];
    if (key === 'searches') {
      const [origin, destination, travelDate, extra] = value.split(':');
      if (extra || !AIRPORT.test(origin || '') || !AIRPORT.test(destination || '') ||
          origin === destination || !DATE.test(travelDate || '') ||
          Number.isNaN(Date.parse(`${travelDate}T00:00:00Z`)) ||
          new Date(`${travelDate}T00:00:00Z`).toISOString().slice(0, 10) !== travelDate) {
        throw new Error(`Invalid search ${value}; use ORIGIN:DESTINATION:YYYY-MM-DD`);
      }
      opts.searches.push({ origin, destination, travelDate });
    } else {
      opts[key] = value;
      if (key === 'maxFlights') opts.allFlights = false;
    }
  }
  for (const key of ['maxFlights', 'minIntervalMs', 'interactionDelayMs', 'retries']) opts[key] = Number(opts[key]);
  if (!Number.isInteger(opts.maxFlights) || opts.maxFlights < 1 || opts.maxFlights > 100 ||
      !Number.isInteger(opts.minIntervalMs) || opts.minIntervalMs < 1000 ||
      !Number.isInteger(opts.interactionDelayMs) || opts.interactionDelayMs < 0 ||
      opts.interactionDelayMs > 5000 ||
      !Number.isInteger(opts.retries) || opts.retries < 0 || opts.retries > 3) {
    throw new Error('Invalid limits: max-flights 1..100, min-interval-ms >=1000, interaction-delay-ms 0..5000, retries 0..3');
  }
  if (opts.cdpUrl && opts.proxy && (opts.proxyUsername || opts.proxyPassword))
    throw new Error('An attached Chrome proxy must be configured without credentials');
  if (!['firefox', 'chromium'].includes(opts.browserEngine)) throw new Error('--browser must be firefox or chromium');
  if (opts.browserEngine === 'firefox' && (opts.chromePath || opts.cdpUrl))
    throw new Error('--chrome-path and --cdp-url require --browser chromium');
  if (opts.chromeHttp1 && opts.browserEngine !== 'chromium')
    throw new Error('--chrome-http1 requires chromium');
  if (opts.autoTransport && opts.tlsBridge)
    throw new Error('Choose --auto-transport or --tls-bridge, not both');
  if (opts.flightHttp1Bridge && !opts.tlsBridge)
    throw new Error('--flight-http1-bridge requires --tls-bridge');
  if (!opts.help && !opts.searches.length) throw new Error('At least one --search is required');
  return opts;
}

function help() {
  console.log(`Direct IndiGo fare collector

Usage: npm run collect -- --search DEL:BOM:2026-09-30 [--search DEL:BLR:2026-10-03]

Options:
  --output DIR             New timestamped run directory under DIR (default runs)
  --profile DIR            Persistent browser session (default .session)
  --all-flights            Verify every displayed route-matched starting fare (default)
  --max-flights N          Diagnostic limit on fare-detail panels (disables all-flights mode)
  --min-interval-ms N      Minimum gap between searches (default 10000)
  --interaction-delay-ms N Pause between form actions and type airport codes slowly (0..5000, default 0)
  --retries N              Transient page retries (default 2)
  --browser ENGINE         firefox (default) or chromium
  --headless               Headless browser (headed is default)
  --captcha-handoff        Pause once for a person to solve a visible CAPTCHA
  --chrome-path PATH       Use installed Chrome instead of bundled Chromium
  --chrome-http1           Disable HTTP/2 in launched Chrome; with CDP, assert it was launched that way
  --tls-bridge             Fetch failing IndiGo site assets with curl_cffi browser transport
  --flight-http1-bridge    Experimental: send the flight POST once over HTTP/1.1 with browser session headers
  --auto-transport         Retry a failed booking-widget transport once with the optional bridge
  --cdp-url URL            Attach to a user-launched Chrome CDP session
  --proxy URL              HTTP/SOCKS proxy server, configured before browser launch
  --proxy-pool FILE        Rotate between verified, distinct proxy exit IPs on transport failure
  --proxy-username USER    Proxy authentication username
  --proxy-password PASS    Proxy authentication password (prefer environment variable)

Never place proxy credentials in --proxy URL or share run evidence without review.`);
}

function redactUrl(raw) {
  try { const u = new URL(raw); return `${u.origin}${u.pathname}`; } catch { return '[invalid-url]'; }
}

function bridgeInstalled() {
  try {
    execFileSync(process.env.INDIGO_PYTHON || 'python3', ['-c', 'import curl_cffi'],
      { timeout: 4000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function writeJson(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}

function classify(body, httpStatus) {
  if (httpStatus === 429) return { code: 'RATE_LIMITED', detail: 'HTTP 429' };
  if ([401, 403, 407].includes(httpStatus)) return { code: 'ACCESS_DENIED', detail: `HTTP ${httpStatus}` };
  if (/captcha|verify you are human|i am not a robot|security challenge/i.test(body))
    return { code: 'CAPTCHA', detail: 'Visible challenge text' };
  if (/access denied|request blocked|forbidden|unusual traffic|temporarily blocked/i.test(body))
    return { code: 'ACCESS_DENIED', detail: 'Visible access-block text' };
  if (/session (has )?(expired|timed out)|session timeout|your session has ended/i.test(body))
    return { code: 'SESSION_EXPIRED', detail: 'Visible session-expiry text' };
  if (/something went wrong\s*please contact our customer support team/i.test(body))
    return { code: 'SITE_ERROR', detail: 'IndiGo failover/error page' };
  return null;
}

async function visibleText(page) {
  return page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
}

async function pageFault(page, httpStatus, net, startIndex) {
  const textFault = classify(await visibleText(page), httpStatus);
  if (textFault && ['CAPTCHA', 'ACCESS_DENIED'].includes(textFault.code)) return textFault;
  const challenge = page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]');
  if (await challenge.filter({ visible: true }).count())
    return { code: 'CAPTCHA', detail: 'Visible challenge iframe' };
  return networkAccessFault(net, startIndex) || textFault;
}

async function stopOnPageFault(page, net, startIndex) {
  const fault = await pageFault(page, null, net, startIndex);
  if (fault) throw Object.assign(new Error(fault.detail), { code: fault.code });
}

async function manualCaptchaHandoff(page, log) {
  if (!process.stdin.isTTY) {
    await log('captcha_handoff_unavailable', { reason: 'No interactive terminal' });
    return false;
  }
  await log('captcha_handoff', { detail: 'Solve the visible challenge in the browser, then press Enter here' });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let timer;
  let outcome;
  try {
    outcome = await Promise.race([
      rl.question('Solve the CAPTCHA in the browser and press Enter (3 minute limit): ').then(() => 'entered'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 180000); })
    ]);
  } finally {
    clearTimeout(timer);
    rl.close();
  }
  if (outcome === 'timeout') {
    await log('captcha_handoff_result', { solved: false, reason: 'timeout' });
    return false;
  }
  const fault = await pageFault(page, null, [], 0);
  const solved = !fault || !['CAPTCHA', 'ACCESS_DENIED'].includes(fault.code);
  await log('captcha_handoff_result', { solved, remainingFault: fault?.code || null });
  return solved;
}

async function waitForState(page, predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await predicate();
    if (state) return state;
    await sleep(800);
  }
  return null;
}

async function chooseAirport(page, kind, code, pause = async () => {}, typingDelayMs = 0,
  allowSelectedFastPath = false) {
  const button = page.getByRole('button', { name: new RegExp(`^${kind}City`) }).first();
  if ((await button.innerText()).includes(`, ${code}`)) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    await pause(`${kind}_open`);
    await button.click({ timeout: 12000 });
    const modernSearch = page.locator('input[role="searchbox"][placeholder="Search"]').filter({ visible: true }).first();
    const legacySearch = page.getByRole('combobox', { name: 'Start typing..' }).filter({ visible: true }).first();
    const input = legacySearch.or(modernSearch).first();
    let originalViewport = null;
    if (!await input.isVisible().catch(() => false)) {
      // This widget sometimes hides its search field in the desktop picker; mobile exposes it.
      originalViewport = page.viewportSize() || { width: 1440, height: 900 };
      await page.setViewportSize({ width: 430, height: 844 });
      const opened = await waitForState(page, () => input.isVisible().catch(() => false), 3500);
      if (!opened) {
        await button.click({ timeout: 12000 });
        await waitForState(page, () => input.isVisible().catch(() => false), 3500);
      }
    }
    try {
      if (!await input.isVisible().catch(() => false))
        throw Object.assign(new Error(`${kind} airport picker did not expose a search field`),
          { code: 'AIRPORT_PICKER_UNAVAILABLE' });
      const modernPicker = await input.getAttribute('role') === 'searchbox';
      await pause(`${kind}_type`);
      if (typingDelayMs) {
        await input.fill('');
        await input.pressSequentially(code, { delay: typingDelayMs });
      } else await input.fill(code);
      // Wait for filtered suggestions; the initially visible popular list can be stale.
      if (!modernPicker) await page.getByRole('status').filter({ hasText: /Suggestions Available/ }).first()
        .waitFor({ state: 'visible', timeout: 12000 });
      const item = page.getByRole('button', { name: new RegExp(`\\b${code}$`) })
        .or(page.getByRole('main', { name: 'Booking Widget' }).getByText(code, { exact: true }))
        .filter({ visible: true }).first();
      await item.waitFor({ state: 'visible', timeout: 12000 });
      await pause(`${kind}_select`);
      await item.click();
      if (allowSelectedFastPath) {
        const confirmed = await waitForState(page, async () => {
          const field = button.locator('.booking-widget-field').first();
          const label = await field.getAttribute('aria-label').catch(() => '');
          return label?.endsWith('Selected') &&
            (await field.innerText()).includes(`, ${code}`) || null;
        }, 5000);
        if (confirmed) {
          const close = page.getByRole('button', { name: 'Close panel' })
            .filter({ visible: true }).first();
          if (await close.count()) await close.click();
          return;
        }
      }
      // IndiGo keeps the input in edit mode until a field outside the popup is clicked.
      await pause(`${kind}_commit`);
      await page.getByRole('button', { name: /^departureDate/ }).first().click();
      const selected = await button.innerText();
      if (selected.includes(code)) return;
    } finally {
      if (originalViewport) await page.setViewportSize(originalViewport);
    }
  }
  throw new Error(`${kind} airport did not commit as ${code}`);
}

export async function selectedAirportCode(page, kind) {
  const field = page.getByRole('button', { name: new RegExp(`^${kind}City`) }).first();
  // The labelled booking-widget-field is nested inside the clickable wrapper.
  const selectedField = field.locator('.booking-widget-field').first();
  const label = await selectedField.getAttribute('aria-label').catch(() => '');
  if (!label?.endsWith('Selected')) return null;
  const value = await selectedField.locator('input[data-value]').first()
    .getAttribute('data-value').catch(() => null);
  if (value) {
    try { return JSON.parse(value).stationCode || null; } catch { /* Fall back to the visible label. */ }
  }
  return /,\s*([A-Z]{3})\b/.exec(await field.innerText().catch(() => ''))?.[1] || null;
}

export async function chooseDate(page, isoDate, pause = async () => {}) {
  const target = new Date(`${isoDate}T12:00:00Z`);
  const departure = page.getByRole('button', { name: /^departureDate/ }).first();
  const selectedLabel = async () => page.getByRole('button', { name: /^departureDate/ })
    .last().getAttribute('aria-label').catch(() => null);
  const labelFor = date => `departureDate ${date.getUTCDate()} ` +
    `${date.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${date.getUTCFullYear()}`;
  const expected = labelFor(target);
  // The widget often starts with T+1 already selected; opening and advancing it can change a valid date.
  if (await selectedLabel() === expected) {
    // The airport commit can leave the selected-date calendar open over Search.
    // Dismiss it with a real outside click; selecting the same day does not
    // close this version of IndiGo's picker.
    const calendar = page.locator('.rdrMonthName').filter({ visible: true }).first();
    if (await calendar.isVisible().catch(() => false)) {
      await page.mouse.click(12, Math.floor((page.viewportSize()?.height || 900) / 2));
      await calendar.waitFor({ state: 'hidden', timeout: 5000 });
      if (await selectedLabel() !== expected) throw Object.assign(
        new Error(`Departure date changed while closing calendar for ${isoDate}`),
        { code: 'FORM_UNCONFIRMED' });
    }
    return;
  }
  const monthNames = page.locator('.rdrMonthName').filter({ visible: true });
  const headings = () => monthNames.allInnerTexts();
  const monthButton = (heading, date) => page.locator('.rdrMonth')
    .filter({ has: page.locator('.rdrMonthName').filter({ hasText: heading }) })
    .locator(`button.rdrDay:not(.rdrDayPassive):not(.rdrDayDisabled):has(.custom-calendar-day[data-date="${date}"])`)
    .filter({ visible: true }).first();
  await pause('date_open');
  if (!await monthNames.first().isVisible().catch(() => false)) await departure.click();
  await monthNames.first().waitFor({ state: 'visible', timeout: 10000 });
  const targetHeading = target.toLocaleString('en-GB',
    { month: 'long', year: 'numeric', timeZone: 'UTC' });
  for (let n = 0; n < 13; n++) {
    const before = await headings();
    if (before.includes(targetHeading)) break;
    if (!before.length) throw Object.assign(new Error('Calendar month heading is unavailable'),
      { code: 'CALENDAR_NAVIGATION_FAILED' });
    await pause('date_next_month');
    const next = page.getByRole('button', { name: 'Next Month' }).filter({ visible: true }).first();
    await next.click({ timeout: 10000 });
    let changed = await waitForState(page, async () => {
      const after = await headings();
      return after.join('|') !== before.join('|') ? after : null;
    }, 4500);
    if (!changed) {
      // Some sessions ignore the arrow. Select the last day of the right-hand month,
      // then reopen the calendar so the picker starts from the new selected month.
      const right = before.at(-1);
      const parsed = new Date(`1 ${right} 12:00:00 GMT`);
      if (Number.isNaN(parsed.getTime())) throw Object.assign(
        new Error(`Unrecognised calendar heading ${right}`), { code: 'CALENDAR_NAVIGATION_FAILED' });
      const bridge = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0, 12));
      const bridgeIso = bridge.toISOString().slice(0, 10);
      if (bridgeIso >= isoDate) throw Object.assign(
        new Error(`Calendar showed ${before.join(' and ')} but not ${isoDate}`),
        { code: 'CALENDAR_NAVIGATION_FAILED' });
      await pause('date_bridge_month');
      await monthButton(right, bridgeIso).click({ timeout: 10000 });
      if (await selectedLabel() !== labelFor(bridge)) throw Object.assign(
        new Error(`Calendar did not confirm bridge date ${bridgeIso}`),
        { code: 'CALENDAR_NAVIGATION_FAILED' });
      await departure.click({ timeout: 10000 });
      await monthNames.first().waitFor({ state: 'visible', timeout: 10000 });
      changed = await headings();
    }
    if (changed.join('|') === before.join('|')) throw Object.assign(
      new Error(`Calendar stayed at ${before.join(' and ')} toward ${isoDate}`),
      { code: 'CALENDAR_NAVIGATION_FAILED' });
  }
  const visibleMonths = await headings();
  if (!visibleMonths.includes(targetHeading)) throw Object.assign(
    new Error(`Travel month ${targetHeading} did not appear; visible: ${visibleMonths.join(' and ')}`),
    { code: 'DATE_UNAVAILABLE' });
  await monthButton(targetHeading, isoDate).click({ timeout: 10000 });
  const chosen = await selectedLabel();
  if (chosen !== expected) throw Object.assign(
    new Error(`Departure date not confirmed as ${isoDate}: ${chosen}`),
    { code: 'FORM_UNCONFIRMED' });
}

function money(text) {
  const m = String(text).match(/(?:₹|INR\s*)([\d,]+(?:\.\d{1,2})?)/i);
  return m ? Number(m[1].replaceAll(',', '')) : null;
}

async function rowInfo(row, query) {
  return row.evaluate((el, q) => {
    const text = selector => el.querySelector(selector)?.textContent?.trim() || null;
    const flights = [...el.querySelectorAll('.flight-number')].flatMap(e => e.textContent.match(/6E\s*\d{2,4}/g) || []);
    return {
      origin: q.origin, destination: q.destination, travelDate: q.travelDate,
      flights: [...new Set(flights.map(s => s.replace(/\s+/g, ' ').trim()))],
      departureAirport: text('.details-wrapper__flight-departure .city-text')?.slice(0, 3) || null,
      arrivalAirport: text('.details-wrapper__flight-arrival .city-text')?.slice(0, 3) || null,
      departureTime: text('.details-wrapper__flight-departure .time'),
      arrivalTime: text('.details-wrapper__flight-arrival .time'),
      journeyKey: el.getAttribute('data-journey-key'),
      rowLabel: el.getAttribute('aria-label'),
      rowHtml: el.outerHTML
    };
  }, query);
}

async function breakdown(page) {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const detail = await dialog.evaluate(el => {
    const section = name => [...el.querySelectorAll('.srp-fare-details-accordian')]
      .find(e => e.querySelector('.heading')?.textContent?.trim() === name);
    const base = section('Base Airfare');
    const taxes = section('Taxes & Fees');
    return {
      baseText: base?.querySelector('.srp-fare-details-accordian-footer')?.textContent?.trim() || null,
      taxesText: taxes?.querySelector('.srp-fare-details-accordian-footer')?.textContent?.trim() || null,
      totalText: el.querySelector('.srp-fare-details-item-footer .totalprice')?.textContent?.trim() || null,
      note: el.querySelector('.srp-fare-details-item-footer .sub-text')?.textContent?.trim() || null,
      html: el.outerHTML
    };
  });
  return { ...detail, base: money(detail.baseText), taxesAndFees: money(detail.taxesText),
    total: money(detail.totalText), currency: 'INR' };
}

async function collectRows(page, query, dir, maxFlights, log, net, attemptNetStart, result,
  responseFares, responseEvidence, resultPageEvidence, persist) {
  const rows = page.locator('[role="row"][data-journey-key]');
  const count = await rows.count();
  result.visibleRowCount = count;
  let panelFailures = 0;
  let consecutiveRowErrors = 0;
  for (let i = 0; i < count && result.fares.length < maxFlights; i++) {
    const row = rows.nth(i);
    let info;
    try {
      await stopOnPageFault(page, net, attemptNetStart);
      info = await rowInfo(row, query);
      if (info.departureAirport !== query.origin || info.arrivalAirport !== query.destination) continue;
      if (!info.flights.length || !info.journeyKey || !info.departureTime || !info.arrivalTime) {
        result.errors.push({ row: i, cause: 'FLIGHT_IDENTITY_INCOMPLETE' }); continue;
      }
      const economy = row.getByRole('button', { name: /Economy Starts at/ }).first();
      if (!await economy.count()) continue;
      await economy.click({ timeout: 12000 });
      await stopOnPageFault(page, net, attemptNetStart);
      const selected = row.getByRole('radio', { checked: true }).first();
      if (!await selected.count()) await row.getByRole('radio').first().click();
      const fareBrand = (await row.getByRole('radio', { checked: true }).first().innerText()).split('\n')[0].trim();
      await openFareDetails(page);
      await stopOnPageFault(page, net, attemptNetStart);
      const price = await breakdown(page);
      if (!price.base || price.taxesAndFees === null || !price.total ||
          Math.abs(price.base + price.taxesAndFees - price.total) > 1) {
        throw new Error(`Invalid or inconsistent fare breakdown: ${JSON.stringify(price)}`);
      }
      const sourceJourney = responseFares.get(info.journeyKey);
      const sourceOffer = sourceJourney?.offers.find(offer =>
        offer.currency === price.currency &&
        Math.abs(offer.base - price.base) <= 1 &&
        Math.abs(offer.taxesAndFees - price.taxesAndFees) <= 1 &&
        Math.abs(offer.total - price.total) <= 1);
      if (!sourceOffer || sourceJourney.flights.join(',') !== info.flights.join(','))
        throw new Error('Displayed flight or fare breakdown does not match IndiGo flight-search response');
      const screenshot = `fare-${String(result.fares.length + 1).padStart(3, '0')}.png`;
      const detailHtml = `fare-${String(result.fares.length + 1).padStart(3, '0')}-details.html`;
      const screenshotBytes = await page.screenshot({ path: path.join(dir, screenshot), timeout: 15000 });
      await fs.writeFile(path.join(dir, detailHtml), price.html, { mode: 0o600 });
      await page.getByRole('button', { name: 'FARE DETAILS Close' }).click();
      const quote = { ...info, rowHtml: undefined, collectedAt: now(), cabin: 'Economy', fareBrand,
        price: { currency: price.currency, base: price.base, taxesAndFees: price.taxesAndFees,
          total: price.total, displayedAs: 'selected fare before possible convenience fee',
          note: price.note },
        sourceOffer: { productClass: sourceOffer.productClass, responseFile: responseEvidence.file,
          responseSha256: responseEvidence.sha256 },
        evidence: { resultPage: resultPageEvidence.html,
          resultScreenshot: resultPageEvidence.screenshot,
          resultPageSha256: resultPageEvidence.htmlSha256,
          resultScreenshotSha256: resultPageEvidence.screenshotSha256,
          rowHtml: `fare-${String(result.fares.length + 1).padStart(3, '0')}-row.html`,
          detailHtml, detailScreenshot: screenshot,
          rowSha256: sha256(info.rowHtml), detailSha256: sha256(price.html),
          detailScreenshotSha256: sha256(screenshotBytes) } };
      await fs.writeFile(path.join(dir, quote.evidence.rowHtml), info.rowHtml, { mode: 0o600 });
      result.fares.push(quote);
      panelFailures = 0;
      consecutiveRowErrors = 0;
      await persist();
      await log('fare', { flights: quote.flights, total: quote.price.total, base: quote.price.base,
        taxesAndFees: quote.price.taxesAndFees });
      await sleep(800 + Math.floor(Math.random() * 400));
    } catch (error) {
      if (page.isClosed()) throw Object.assign(new Error('Results page closed during fare inspection'),
        { code: 'PAGE_CLOSED' });
      if (['ACCESS_DENIED', 'CAPTCHA', 'SESSION_EXPIRED', 'SESSION_INVALID',
        'RATE_LIMITED', 'SITE_ERROR'].includes(error.code)) throw error;
      result.errors.push({ row: i, journeyKey: info?.journeyKey, cause: error.message });
      await log('fare_error', { row: i, cause: error.message });
      consecutiveRowErrors++;
      if (error.code === 'FARE_DETAILS_UNAVAILABLE') {
        panelFailures++;
        result.evidence.push(await evidence(page, dir, `fare-panel-failure-row-${i}`));
        if (panelFailures >= 2) throw error;
      }
      if (consecutiveRowErrors >= 5) {
        result.evidence.push(await evidence(page, dir, `row-inspection-failure-${i}`));
        throw Object.assign(new Error(`Five consecutive fare rows could not be verified; last error: ${error.message}`),
          { code: 'ROW_INSPECTION_FAILURE' });
      }
      const litePopup = page.locator('#liteFarePopup');
      if (await litePopup.isVisible().catch(() => false))
        await litePopup.locator('#changeFare').click({ timeout: 5000 }).catch(() => {});
      await page.getByRole('dialog').getByRole('button', { name: /Close/ }).click().catch(() => {});
    }
  }
}

async function collectAllRows(page, query, dir, log, net, attemptNetStart, result,
  responseFares, responseEvidence, resultPageEvidence, persist) {
  const rows = page.locator('[role="row"][data-journey-key]');
  const count = await rows.count();
  result.visibleRowCount = count;
  result.coverage = { expectedJourneys: responseFares.size, displayedEligibleRows: 0,
    captured: 0, excludedNearbyRows: 0, complete: false, missingJourneyKeys: [] };
  await log('inventory_count', { query, displayedRows: count,
    expectedJourneys: responseFares.size });
  const captured = new Set();
  for (let i = 0; i < count; i++) {
    await stopOnPageFault(page, net, attemptNetStart);
    const info = await rowInfo(rows.nth(i), query);
    const sourceJourney = responseFares.get(info.journeyKey);
    if (!sourceJourney || info.departureAirport !== query.origin ||
        info.arrivalAirport !== query.destination) {
      result.coverage.excludedNearbyRows++;
      continue;
    }
    result.coverage.displayedEligibleRows++;
    if (captured.has(info.journeyKey)) continue;
    const start = displayedStartingFare(info.rowLabel);
    const offer = sourceJourney.offers.filter(item => item.currency === 'INR')
      .sort((a, b) => a.total - b.total)[0];
    if (!info.flights.length || !info.departureTime || !info.arrivalTime ||
        sourceJourney.flights.join(',') !== info.flights.join(',') ||
        !offer || start === null || Math.abs(start - offer.total) > 1) {
      result.errors.push({ row: i, journeyKey: info.journeyKey,
        cause: 'PAGE_RESPONSE_FARE_MISMATCH', displayedStart: start,
        responseStart: offer?.total || null });
      continue;
    }
    const rowFile = `fare-${String(result.fares.length + 1).padStart(3, '0')}-row.html`;
    await fs.writeFile(path.join(dir, rowFile), info.rowHtml, { mode: 0o600 });
    const quote = { ...info, rowHtml: undefined, collectedAt: now(),
      cabin: 'Displayed starting fare', fareBrand: 'Starting fare',
      price: { currency: 'INR', base: offer.base, taxesAndFees: offer.taxesAndFees,
        total: offer.total, displayedAs: 'lowest displayed starting fare before possible convenience fee',
        note: 'Breakdown from matching IndiGo flight-search response' },
      sourceOffer: { productClass: offer.productClass, responseFile: responseEvidence.file,
        responseSha256: responseEvidence.sha256 },
      evidence: { mode: 'response_row', resultPage: resultPageEvidence.html,
        resultScreenshot: resultPageEvidence.screenshot,
        resultPageSha256: resultPageEvidence.htmlSha256,
        resultScreenshotSha256: resultPageEvidence.screenshotSha256,
        rowHtml: rowFile, rowSha256: sha256(info.rowHtml) } };
    result.fares.push(quote);
    captured.add(info.journeyKey);
    result.coverage.captured = captured.size;
    await persist();
    await log('fare', { flights: quote.flights, total: quote.price.total,
      base: quote.price.base, taxesAndFees: quote.price.taxesAndFees,
      captured: captured.size, expected: responseFares.size });
  }
  result.coverage.missingJourneyKeys = [...responseFares.keys()].filter(key => !captured.has(key));
  result.coverage.complete = result.coverage.missingJourneyKeys.length === 0 &&
    result.coverage.captured === responseFares.size && result.errors.length === 0;
  await persist();
  await log('inventory_complete', { query, ...result.coverage });
  if (!result.coverage.complete)
    throw Object.assign(new Error(`Verified ${captured.size}/${responseFares.size} route-matched journeys; ${result.coverage.missingJourneyKeys.length} could not be matched to a displayed starting fare`),
      { code: 'COVERAGE_INCOMPLETE' });
}

export async function collectSearches(argv = process.argv.slice(2), runtime = null) {
  const opts = options(argv);
  if (runtime) opts.cdpUrl = 'worker-owned';
  if (opts.help) { help(); return; }
  const runId = `${now().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const root = path.resolve(opts.output, runId);
  await fs.mkdir(root, { recursive: true });
  const runLog = path.join(root, 'events.ndjson');
  const manifest = { runId, startedAt: now(), source: HOME, sourceType: 'DIRECT_AIRLINE_WEBSITE',
    evidenceProtocolVersion: 1,
    sourceFingerprint: await sourceFingerprint(),
    requestedSearches: opts.searches,
    profile: path.resolve(opts.profile), browserEngine: opts.browserEngine,
    browserMode: opts.cdpUrl ? (process.env.INDIGO_VIRTUAL_DISPLAY === '1' ?
      'virtual-display-cdp' : opts.headless ? 'headless-cdp' : 'headed-cdp') :
      opts.headless ? 'headless' : 'headed',
    chromeHttp1: opts.chromeHttp1, tlsBridge: opts.tlsBridge,
    autoTransport: opts.autoTransport, flightHttp1Bridge: opts.flightHttp1Bridge,
    interactionDelayMs: opts.interactionDelayMs,
    fareCaptureMode: opts.allFlights ? 'all_starting_fares_v1' : 'fare_panels_v1',
    searches: [], status: 'running' };
  const log = async (event, fields = {}) => {
    const record = { at: now(), event, ...fields };
    await fs.appendFile(runLog, JSON.stringify(record) + '\n');
    if (runtime?.onEvent) await runtime.onEvent(record);
    else console.log(JSON.stringify(record));
  };
  await writeJson(path.join(root, 'manifest.json'), manifest);
  let browser, context, pool, anchorPage;
  const assetCache = new Map();
  const failureCircuit = new FailureCircuit(2);
  const strategyByProxy = new Map();
  try {
    pool = await loadProxyPool(opts);
    if (opts.proxyPool) pool = await preflightProxyPool(pool, opts, log);
    manifest.proxyPool = pool.snapshot();
    manifest.ipRotationEnabled = Boolean(opts.proxyPool);
    const autoBridgeAvailable = opts.autoTransport && bridgeInstalled();
    if (opts.autoTransport) await log('transport_capability',
      { browser: true, bridge: autoBridgeAvailable });
    if (runtime) {
      await runtime.initialize();
      browser = runtime.browser;
      context = runtime.context;
      manifest.browserSession = { id: runtime.id, chromePid: runtime.chrome.pid,
        searchNumber: ++runtime.searchCount, reused: runtime.searchCount > 1 };
      await log('browser_session', manifest.browserSession);
    } else if (opts.cdpUrl) {
      browser = await chromium.connectOverCDP(opts.cdpUrl);
      context = browser.contexts()[0];
      if (!context) throw new Error('CDP browser has no context');
      // Keep a tab alive between searches. Some standalone Chrome sessions exit
      // when the just-collected search tab is their last open tab.
      anchorPage = await context.newPage();
    }
    let lastSearch = 0;
    let sessionResetUsed = false;
    for (let index = 0; index < opts.searches.length; index++) {
      const query = opts.searches[index];
      const dir = path.join(root, `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(dir, { recursive: true });
      const result = { query, startedAt: now(), collectedAt: null, status: 'running', cause: null,
        fares: [], evidence: [], errors: [], attempts: [] };
      manifest.searches.push(result);
      await writeJson(path.join(root, 'manifest.json'), manifest);
      const net = [];
      let noncriticalNetworkCount = 0;
      const recordNetwork = item => {
        if (!isBookingResource(item.url)) {
          if (noncriticalNetworkCount >= 500) return;
          noncriticalNetworkCount++;
        }
        net.push(item);
      };
      const pageErrors = [];
      let stopBatch = false;
      let handoffUsed = false;
      let pinnedProxyId = null;
      try {
        for (let attempt = 0; attempt <= opts.retries; attempt++) {
          let page, selectedProxy, closeTlsBridge, diagnostics;
          const listeners = [];
          const listen = (name, handler) => { page.on(name, handler); listeners.push([name, handler]); };
          const attemptRecord = { number: attempt + 1, startedAt: now(), stage: 'starting',
            stages: [], strategy: null, proxyId: null, qualification: null, failure: null };
          result.attempts.push(attemptRecord);
          const stage = async name => {
            advanceStage(attemptRecord, name);
            await log('search_stage', { query, attempt: attempt + 1, stage: name,
              proxyId: attemptRecord.proxyId });
            await writeJson(path.join(dir, 'result.json'), result);
          };
          const pause = async action => {
            if (!opts.interactionDelayMs) return;
            const milliseconds = opts.interactionDelayMs +
              Math.floor(Math.random() * Math.max(1, Math.floor(opts.interactionDelayMs * 0.4)));
            await log('interaction_pause', { query, attempt: attempt + 1, action, milliseconds });
            await sleep(milliseconds);
          };
          const attemptNetStart = net.length;
          const responseReads = [];
          const flightResponses = [];
          const failureResponseReads = [];
          const flightHttpFaults = [];
          const pendingResources = new Map();
          const bridgeFailures = [];
          try {
            let choice = pool.choose(pinnedProxyId);
            if (!choice.entry) {
              await log('proxy_cooldown', { waitMs: choice.waitMs, health: pool.snapshot() });
              await sleep(Math.min(choice.waitMs + 50, 300000));
              choice = pool.choose();
            }
            if (!choice.entry) throw Object.assign(new Error('All configured proxies remain in cooldown'), { code: 'PROXY_POOL_UNAVAILABLE' });
            selectedProxy = choice.entry;
            pinnedProxyId = selectedProxy.id;
            result.proxyId = selectedProxy.id;
            attemptRecord.proxyId = selectedProxy.id;
            attemptRecord.strategy = opts.tlsBridge ||
              (opts.autoTransport && strategyByProxy.get(selectedProxy.id) === 'bridge') ?
              'bridge' : 'browser';
            if (!opts.cdpUrl) {
              const launch = { headless: opts.headless, viewport: { width: 1440, height: 900 },
                locale: 'en-IN', timezoneId: 'Asia/Kolkata' };
              if (opts.chromePath) launch.executablePath = opts.chromePath;
              if (opts.chromeHttp1) launch.args = ['--disable-http2'];
              if (selectedProxy.proxy) launch.proxy = selectedProxy.proxy;
              const profile = pool.entries.length === 1 ? path.resolve(opts.profile, opts.browserEngine) :
                path.resolve(opts.profile, `proxy-${selectedProxy.id}`, opts.browserEngine);
              const engine = opts.browserEngine === 'firefox' ? firefox : chromium;
              context = await engine.launchPersistentContext(profile, launch);
            }
            if (selectedProxy.proxy) {
              let observedExit;
              try {
                // A CDP attachment cannot configure Chrome. Confirm that its actual exit
                // matches a separate browser using the requested proxy before site access.
                if (opts.cdpUrl && !selectedProxy.exitIp)
                  selectedProxy.exitIp = await probeProxyExit(selectedProxy, opts);
                observedExit = await currentContextExit(context);
              } catch (error) { throw Object.assign(new Error(`Proxy exit check failed: ${error.message}`),
                { code: 'PROXY_EGRESS_UNVERIFIED' }); }
              if (selectedProxy.exitIp && observedExit !== selectedProxy.exitIp)
                throw Object.assign(new Error(`Proxy exit changed from ${selectedProxy.exitIp} to ${observedExit}`),
                  { code: 'PROXY_EXIT_CHANGED' });
              selectedProxy.exitIp = observedExit;
              selectedProxy.verifiedAt = now();
              result.proxyExitIp = observedExit;
              await log('proxy_exit_verified', { proxyId: selectedProxy.id, exitIp: observedExit });
            }
            if (attemptRecord.strategy === 'bridge') closeTlsBridge = await installTlsBridge(context, selectedProxy.proxy, log,
              failure => bridgeFailures.push(failure), assetCache,
              { flightHttp1: opts.flightHttp1Bridge });
            if (runtime?.closing) throw Object.assign(new Error('Browser worker is shutting down'), { code: 'COLLECTION_CANCELLED' });
            page = runtime?.page && !runtime.page.isClosed() ? runtime.page : await context.newPage();
            if (runtime) {
              runtime.page = page;
              await page.setViewportSize({ width: 1440, height: 900 });
            }
            diagnostics = await observeNetwork(page);
            const navigatorWebdriver = await page.evaluate(() => navigator.webdriver).catch(() => null);
            const navigatorUserAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
            attemptRecord.navigatorWebdriver = navigatorWebdriver;
            await log('browser_automation_signal', { query, attempt: attempt + 1,
              navigatorWebdriver, navigatorUserAgent });
            await stage('browser_ready');
            listen('request', request => {
              if (!isCriticalPageResource(request.url(), request.resourceType())) return;
              const item = { at: now(), proxyId: selectedProxy.id,
                started: true, resourceType: request.resourceType(), url: redactUrl(request.url()) };
              pendingResources.set(request, item);
              recordNetwork(item);
            });
            listen('requestfinished', request => pendingResources.delete(request));
            listen('response', response => {
              const url = response.url();
              if (isIndigoUrl(url)) {
                const item = { at: now(), proxyId: selectedProxy.id, status: response.status(),
                  resourceType: response.request().resourceType(), url: redactUrl(url) };
                recordNetwork(item);
              }
              if (isFlightSearchResponse(url) && response.status() === 200) {
                responseReads.push(response.text().then(body => {
                  flightResponses.push({ body, capturedAt: now() });
                }).catch(error => {
                  pageErrors.push({ at: now(), proxyId: selectedProxy.id,
                    message: `Flight-search response body unavailable: ${error.message}` });
                }));
              } else if (isFlightSearchResponse(url) && [401, 403, 429].includes(response.status())) {
                const status = response.status();
                const file = `flight-search-http-${status}-attempt-${attempt + 1}-${failureResponseReads.length + 1}.bin`;
                failureResponseReads.push(response.body().then(async body => {
                  const saved = body.subarray(0, 65536);
                  const fault = flightHttpFault(status, saved.toString('utf8'));
                  if (fault) flightHttpFaults.push(fault);
                  await fs.writeFile(path.join(dir, file), saved, { mode: 0o600 });
                  result.evidence.push({ file, status, sourceUrl: redactUrl(url),
                    contentType: response.headers()['content-type'] || null,
                    bytes: saved.length, truncated: body.length > saved.length,
                    sha256: sha256(saved), capturedAt: now() });
                  await log('flight_http_failure_evidence', { status, file, bytes: saved.length });
                }).catch(error => {
                  pageErrors.push({ at: now(), proxyId: selectedProxy.id,
                    message: `Flight-search HTTP ${status} body unavailable: ${error.message}` });
                }));
              }
            });
            listen('requestfailed', request => {
              pendingResources.delete(request);
              if (isIndigoUrl(request.url())) recordNetwork({ at: now(), proxyId: selectedProxy.id,
                failed: request.failure()?.errorText, resourceType: request.resourceType(),
                url: redactUrl(request.url()) });
            });
            listen('pageerror', error => {
              if (pageErrors.length < 50) pageErrors.push({ at: now(), proxyId: selectedProxy.id,
                message: error.message });
            });
            const gap = opts.minIntervalMs - (Date.now() - lastSearch);
            if (gap > 0) await sleep(gap);
            lastSearch = Date.now();
            await log('search_start', { query, proxyId: selectedProxy.id,
              strategy: attemptRecord.strategy, attempt: attempt + 1 });
            const response = await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
            const homeStatus = response?.status() ?? null;
            await stage('homepage_loaded');
            const homeState = await waitForState(page, async () => {
              const fault = await pageFault(page, homeStatus, net, attemptNetStart);
              if (fault) return { fault };
              if (await page.getByRole('main', { name: 'Booking Widget' }).getByRole('button', { name: /^sourceCity/ }).count()) return { ready: true };
              return null;
            }, 20000);
            result.evidence.push(await evidence(page, dir, `home-attempt-${attempt + 1}`));
            if (homeState?.fault) {
              const { code, detail } = homeState.fault;
              throw Object.assign(new Error(detail), { code });
            }
            if (!homeState?.ready) throw Object.assign(new Error('Booking widget did not render within 20 seconds'), { code: 'BOOKING_WIDGET_UNAVAILABLE' });
            attemptRecord.qualification = { at: now(), homeStatus, widgetVisible: true,
              proxyExitIp: selectedProxy.exitIp || null,
              widgetResources: net.slice(attemptNetStart).filter(item =>
                /\/bw-(?:main|additional)\.json|\/v1\/setting\/indigowidgets/.test(item.url))
                .map(({ url, status, failed }) => ({ url, status: status || null, failed: failed || null })) };
            await stage('widget_ready');
            const cookie = page.getByRole('button', { name: 'Accept Essential Only' });
            if (await cookie.count()) {
              await pause('cookie_choice');
              await cookie.click().catch(() => {});
            }
            const typingDelayMs = opts.interactionDelayMs ?
              Math.max(80, Math.min(300, Math.floor(opts.interactionDelayMs / 6))) : 0;
            await chooseAirport(page, 'source', query.origin, pause, typingDelayMs,
              opts.headless);
            await chooseAirport(page, 'destination', query.destination, pause, typingDelayMs);
            await chooseDate(page, query.travelDate, pause);
            const selectedOrigin = await selectedAirportCode(page, 'source');
            const selectedDestination = await selectedAirportCode(page, 'destination');
            if (selectedOrigin !== query.origin || selectedDestination !== query.destination)
              throw Object.assign(new Error(`Form route did not match query: selected ${selectedOrigin || 'none'}-${selectedDestination || 'none'}`),
                { code: 'FORM_MISMATCH' });
            await stage('route_date_confirmed');
            result.evidence.push(await evidence(page, dir, `filled-search-attempt-${attempt + 1}`));
            await pause('review_before_search');
            const readiness = await waitForBookingSession(page, pendingResources,
              () => pageFault(page, null, net, attemptNetStart));
            attemptRecord.browserEnvironment = await browserEnvironment(page);
            await log('booking_session_ready', { query, ...readiness,
              browserEnvironment: attemptRecord.browserEnvironment });
            await stopOnPageFault(page, net, attemptNetStart);
            await page.getByRole('button', { name: 'Search', exact: true }).click();
            await log('search_submitted', { query, atUrl: redactUrl(page.url()) });
            await stage('search_submitted');
            const state = await waitForState(page, async () => {
              const fault = await pageFault(page, null, net, attemptNetStart);
              if (fault) return { fault };
              if (page.url().includes(RESULTS_PATH) && await page.locator('[role="row"][data-journey-key]').count())
                return { results: true };
              if (page.url().includes(RESULTS_PATH) && /no flights (found|available)|no results found/i.test(await visibleText(page)))
                return { empty: true };
              return null;
            }, 45000);
            const resultPageEvidence = await evidence(page, dir, `results-attempt-${attempt + 1}`);
            result.evidence.push(resultPageEvidence);
            if (state?.fault) throw Object.assign(new Error(state.fault.detail), { code: state.fault.code });
            if (state?.empty) throw Object.assign(new Error('IndiGo displayed an empty result state'), { code: 'EMPTY_RESULTS' });
            if (!state?.results) throw Object.assign(new Error(`No validated result state at ${redactUrl(page.url())}`), { code: 'RESULTS_UNVERIFIED' });
            if (!resultPageEvidence.html || !resultPageEvidence.screenshot)
              throw Object.assign(new Error('Results page HTML or screenshot could not be saved'),
                { code: 'EVIDENCE_CAPTURE_FAILED' });
            await stage('results_rendered');
            await Promise.allSettled(responseReads);
            const flightResponse = flightResponses.at(-1);
            if (!flightResponse) throw Object.assign(new Error('Results appeared without a readable IndiGo flight-search response'),
              { code: 'FARE_RESPONSE_UNVERIFIED' });
            let responseFares;
            try { responseFares = verifiedResponseFares(JSON.parse(flightResponse.body), query); }
            catch (error) { throw Object.assign(error, { code: 'FARE_RESPONSE_UNVERIFIED' }); }
            if (!responseFares.size) throw Object.assign(new Error('IndiGo response contained no route-matched fares with a valid price breakdown'),
              { code: 'FARE_RESPONSE_UNVERIFIED' });
            const responseFile = `flight-search-attempt-${attempt + 1}.json`;
            await fs.writeFile(path.join(dir, responseFile), flightResponse.body, { mode: 0o600 });
            const responseEvidence = { file: responseFile, sha256: sha256(flightResponse.body),
              capturedAt: flightResponse.capturedAt,
              sourceUrl: 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search' };
            result.evidence.push(responseEvidence);
            await stage('airline_response_verified');
            if (opts.allFlights)
              await collectAllRows(page, query, dir, log, net, attemptNetStart, result,
                responseFares, responseEvidence, resultPageEvidence,
                () => writeJson(path.join(dir, 'result.json'), result));
            else
              await collectRows(page, query, dir, opts.maxFlights, log, net, attemptNetStart, result,
                responseFares, responseEvidence, resultPageEvidence,
                () => writeJson(path.join(dir, 'result.json'), result));
            if (!result.fares.length) throw Object.assign(new Error('Rows existed, but no route-matched fare with a valid breakdown was captured'), { code: 'PARSER_UNVERIFIED' });
            await stage('fare_verified');
            result.status = result.errors.length ? 'partial' : 'ok';
            result.cause = null;
            pool.success(selectedProxy.id);
            failureCircuit.reset(selectedProxy.id);
            await stage('complete');
            await log('search_complete', { query, status: result.status, fares: result.fares.length });
            break;
          } catch (error) {
            await Promise.race([Promise.allSettled(failureResponseReads), sleep(5000)]);
            const code = error.code ||
              (/ERR_CERT_|SEC_ERROR_UNKNOWN_ISSUER|SSL_ERROR_BAD_CERT/.test(error.message) ?
                'TLS_TRUST_FAILURE' : error.name === 'TimeoutError' ? 'TIMEOUT' : 'SEARCH_ERROR');
            const failedResources = net.slice(attemptNetStart).filter(item => item.failed &&
              isCriticalPageResource(item.url, item.resourceType) &&
              item.proxyId === selectedProxy?.id).slice(-5);
            const stalledResources = [...pendingResources.values()].slice(-10);
            const bridgeCertFailure = bridgeFailures.find(item =>
              /CertificateVerifyError|self.signed certificate|certificate verify failed|curl: \(60\)/i.test(item.message));
            const browserCertFailure = failedResources.find(item =>
              /ERR_CERT_|SEC_ERROR_|SSL_ERROR_/i.test(item.failed || ''));
            let actualCode = bridgeCertFailure || browserCertFailure ? 'TLS_TRUST_FAILURE' :
              (/page\.goto:.*(?:NS_ERROR_NET_RESET|ERR_CONNECTION_RESET|ERR_HTTP2_PROTOCOL_ERROR)/s.test(error.message) ?
                'SITE_NETWORK_FAILURE' :
              ['BOOKING_WIDGET_UNAVAILABLE', 'TIMEOUT'].includes(code) &&
              (failedResources.length || stalledResources.length) ? 'SITE_NETWORK_FAILURE' : code);
            const observedFault = page ? await pageFault(page, null, net, attemptNetStart).catch(() => null) : null;
            const diagnosticFault = networkAccessFault((diagnostics?.events || [])
              .filter(item => item.kind === 'response_status' && item.method !== 'OPTIONS'), 0);
            if (observedFault && ['ACCESS_DENIED', 'CAPTCHA', 'SESSION_EXPIRED', 'RATE_LIMITED'].includes(observedFault.code))
              actualCode = observedFault.code;
            const flightHttpFaultSeen = flightHttpFaults.at(-1);
            if (flightHttpFaultSeen?.code === 'SESSION_INVALID') actualCode = 'SESSION_INVALID';
            const bridgeFlightFailure = bridgeFailures.findLast(item => item.path === '/v2/flight/search');
            if (bridgeFlightFailure && !['ACCESS_DENIED', 'CAPTCHA', 'SESSION_EXPIRED', 'SESSION_INVALID',
              'RATE_LIMITED', 'TLS_TRUST_FAILURE'].includes(actualCode)) actualCode = 'SITE_NETWORK_FAILURE';
            const flightTransportFault = flightSearchTransportFault(net, attemptNetStart);
            actualCode = preferFlightTransportFailure(actualCode, flightTransportFault);
            const stalledFlightFault = stalledFlightSearchFault(stalledResources);
            if (['EMPTY_RESULTS', 'RESULTS_UNVERIFIED'].includes(actualCode) && stalledFlightFault)
              actualCode = stalledFlightFault.code;
            const resultsDocumentFault = stalledResultsDocumentFault(stalledResources);
            if (actualCode === 'RESULTS_UNVERIFIED' && resultsDocumentFault)
              actualCode = resultsDocumentFault.code;
            if (diagnosticFault) actualCode = diagnosticFault.code;
            result.cause = { code: actualCode,
              detail: flightHttpFaultSeen && actualCode === flightHttpFaultSeen.code ? flightHttpFaultSeen.detail :
                diagnosticFault && actualCode === diagnosticFault.code ? diagnosticFault.detail :
                observedFault && actualCode === observedFault.code ? observedFault.detail :
                bridgeFlightFailure && actualCode === 'SITE_NETWORK_FAILURE' ?
                  `IndiGo flight search HTTP/1.1 bridge failed: ${bridgeFlightFailure.message}` :
                flightTransportFault && actualCode === flightTransportFault.code ? flightTransportFault.detail :
                stalledFlightFault && actualCode === stalledFlightFault.code ? stalledFlightFault.detail :
                resultsDocumentFault && actualCode === resultsDocumentFault.code ? resultsDocumentFault.detail :
                bridgeCertFailure ? `Bridge certificate validation failed at ${bridgeCertFailure.path}: ${bridgeCertFailure.message}` :
                browserCertFailure ? `Browser certificate validation failed at ${browserCertFailure.url}: ${browserCertFailure.failed}` : error.message,
              stageUrl: page ? redactUrl(page.url()) : null, proxyId: selectedProxy?.id || null,
              failedResources, stalledResources, bridgeFailures: bridgeFailures.slice(-5), attempt: attempt + 1 };
            attemptRecord.failure = { at: now(), failedAtStage: attemptRecord.stage,
              code: actualCode, detail: result.cause.detail };
            await writeJson(path.join(dir, 'result.json'), result);
            if (page) result.evidence.push(await evidence(page, dir, `failure-attempt-${attempt + 1}`));
            await log('search_failure', { query, ...result.cause });
            if (actualCode === 'CAPTCHA' && opts.captchaHandoff && !opts.headless && !handoffUsed && page) {
              handoffUsed = true;
              if (await manualCaptchaHandoff(page, log)) {
                attempt--;
                continue;
              }
            }
            if (page && context && mayResetIndigoSession({ code: actualCode,
                resetUsed: sessionResetUsed, attempt, retries: opts.retries,
                browserEngine: opts.browserEngine, cdpUrl: opts.cdpUrl,
                launcherOwned: process.env.INDIGO_LAUNCHER_OWNED === '1' })) {
              sessionResetUsed = true;
              try {
                const clearedOrigins = await resetIndigoSiteSession(context, page, net);
                await log('session_reset', { query, reason: actualCode, clearedOrigins,
                  attempt: attempt + 1 });
                await sleep(2000 + Math.floor(Math.random() * 1000));
                continue;
              } catch (resetError) {
                result.cause.resetFailure = resetError.message;
                await log('session_reset_failed', { query, reason: actualCode,
                  detail: resetError.message });
              }
            }
            if (['ACCESS_DENIED', 'CAPTCHA', 'SESSION_EXPIRED', 'SESSION_INVALID'].includes(actualCode)) {
              stopBatch = true;
              result.status = ['SESSION_EXPIRED', 'SESSION_INVALID'].includes(actualCode) ? 'failed' : 'blocked';
              break;
            }
            const transportFailure = ['SITE_NETWORK_FAILURE', 'PROXY_EGRESS_UNVERIFIED',
              'PROXY_EXIT_CHANGED'].includes(actualCode) ||
              (actualCode === 'TLS_TRUST_FAILURE' && pool.entries.length > 1) ||
              (actualCode === 'TIMEOUT' && /page\.goto|net::|NS_ERROR/.test(error.message));
            if (selectedProxy && transportFailure) {
              const cooldownMs = pool.transportFailure(selectedProxy.id);
              pinnedProxyId = null;
              await log(selectedProxy.proxy ? 'proxy_transport_failure' : 'direct_transport_failure',
                { proxyId: selectedProxy.id, cooldownMs });
            }
            if (selectedProxy && opts.autoTransport && attempt < opts.retries &&
                shouldTryBridge(result.cause, attemptRecord.strategy, autoBridgeAvailable,
                  attemptRecord.stage)) {
              strategyByProxy.set(selectedProxy.id, 'bridge');
              await log('transport_strategy_changed', { proxyId: selectedProxy.id,
                from: 'browser', to: 'bridge', reason: 'booking widget transport failure' });
            }
            const circuit = selectedProxy && failureCircuit.record(selectedProxy.id, result.cause);
            if (circuit?.open && pool.entries.length === 1) {
              result.status = result.fares.length ? 'partial' : 'failed';
              result.cause.circuit = circuit;
              stopBatch = true;
              await log('circuit_open', { proxyId: selectedProxy.id, ...circuit });
              break;
            }
            if (['EMPTY_RESULTS', 'PARSER_UNVERIFIED', 'FARE_RESPONSE_UNVERIFIED',
                'FORM_MISMATCH', 'SITE_ERROR', 'COVERAGE_INCOMPLETE', 'COLLECTION_CANCELLED'].includes(actualCode) ||
                (actualCode === 'TLS_TRUST_FAILURE' && pool.entries.length === 1) ||
                result.fares.length || attempt === opts.retries) {
              result.status = result.fares.length ? 'partial' : 'failed'; break;
            }
            const delay = Math.min(30000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
            await log('backoff', { milliseconds: delay, reason: actualCode });
            await sleep(delay);
          } finally {
            attemptRecord.finishedAt = now();
            const diagnosticFile = `network-diagnostics-attempt-${attempt + 1}.json`;
            if (diagnostics) {
              await diagnostics.close();
              const diagnostic = { available: diagnostics.available,
                reason: diagnostics.reason || null, events: diagnostics.events };
              const diagnosticText = JSON.stringify(diagnostic, null, 2) + '\n';
              await fs.writeFile(path.join(dir, diagnosticFile), diagnosticText, { mode: 0o600 });
              result.evidence.push({ file: diagnosticFile, type: 'network_diagnostics',
                sha256: sha256(diagnosticText), capturedAt: now() });
            }
            for (const [name, handler] of listeners) page?.off(name, handler);
            if (!runtime) await page?.close().catch(() => {});
            await closeTlsBridge?.().catch(() => {});
            if (!opts.cdpUrl) {
              await context?.close().catch(() => {});
              context = null;
            }
          }
        }
      } finally {
        result.collectedAt = now();
        await writeJson(path.join(dir, 'network.json'), net);
        await writeJson(path.join(dir, 'page-errors.json'), pageErrors);
        await writeJson(path.join(dir, 'result.json'), result);
        manifest.proxyPool = pool.snapshot();
        await writeJson(path.join(root, 'manifest.json'), manifest);
      }
      if (stopBatch) {
        await log('batch_stopped', { reason: result.cause?.code, after: query });
        for (let remaining = index + 1; remaining < opts.searches.length; remaining++) {
          const skippedQuery = opts.searches[remaining];
          const skippedDir = path.join(root,
            `${String(remaining + 1).padStart(2, '0')}-${skippedQuery.origin}-${skippedQuery.destination}-${skippedQuery.travelDate}`);
          await fs.mkdir(skippedDir, { recursive: true });
          const skipped = { query: skippedQuery, startedAt: null, collectedAt: now(),
            status: 'skipped', cause: { code: 'BATCH_STOPPED', after: query,
              reason: result.cause?.code || 'UNKNOWN' }, fares: [], evidence: [], errors: [], attempts: [] };
          manifest.searches.push(skipped);
          await writeJson(path.join(skippedDir, 'result.json'), skipped);
          await log('search_skipped', { query: skippedQuery, reason: skipped.cause });
        }
        break;
      }
    }
    manifest.status = manifest.searches.every(r => r.status === 'ok') ? 'ok' :
      manifest.searches.some(r => r.status === 'blocked') ? 'blocked' :
      manifest.searches.some(r => r.status === 'ok' || r.status === 'partial') ? 'partial' : 'failed';
  } catch (error) {
    manifest.status = 'failed';
    manifest.setupFailure = { at: now(), code: error.code || 'BROWSER_START_FAILED',
      cause: error.message };
    await log('setup_failure', manifest.setupFailure);
    for (const [index, query] of opts.searches.entries()) {
      const directory = path.join(root,
        `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(directory, { recursive: true });
      const result = { query, startedAt: null, collectedAt: now(), status: 'failed',
        cause: { code: manifest.setupFailure.code, detail: error.message },
        fares: [], evidence: [], errors: [], attempts: [{ number: 1,
          startedAt: manifest.startedAt, finishedAt: now(), stage: 'starting', stages: [],
          failure: { at: now(), failedAtStage: 'starting', code: manifest.setupFailure.code, detail: error.message } }] };
      const setupText = JSON.stringify(manifest.setupFailure, null, 2) + '\n';
      await fs.writeFile(path.join(directory, 'setup-failure.json'), setupText, { mode: 0o600 });
      await writeJson(path.join(directory, 'network.json'), []);
      await writeJson(path.join(directory, 'page-errors.json'), []);
      result.evidence.push({ file: 'setup-failure.json', type: 'setup_failure',
        sha256: sha256(setupText), capturedAt: now() });
      await log('search_failure', { query, ...result.cause });
      manifest.searches.push(result);
      await writeJson(path.join(directory, 'result.json'), result);
    }
  } finally {
    manifest.finishedAt = now();
    await writeJson(path.join(root, 'manifest.json'), manifest);
    if (!opts.cdpUrl) await context?.close().catch(() => {});
    if (!runtime) {
      await anchorPage?.close().catch(() => {});
      await browser?.close().catch(() => {});
      console.log(`RUN_DIR=${root}`);
      process.exitCode = manifest.status === 'ok' ? 0 : 2;
    }
  }
  return { runRoot: root, status: manifest.status, exitCode: manifest.status === 'ok' ? 0 : 2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  collectSearches().catch(error => { console.error(error.stack || error.message); process.exitCode = 2; });
