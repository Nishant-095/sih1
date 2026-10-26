#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { parseSearchResponse, extractPageCards, matchFaresToCards } from './parse.mjs';
import { verifySearch } from './verify.mjs';
import { chromeExecutable } from './browser-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = 'https://www.airindia.com/in/en/book/search-flights.html';
const HANDOFF = '/in/en/refx-booking.html';
const DENIAL = new Set(['CAPTCHA', 'ACCESS_DENIED', 'RATE_LIMITED', 'SESSION_EXPIRED']);
const RETRYABLE = new Set(['TIMEOUT', 'SITE_NETWORK_FAILURE', 'FORM_UNCONFIRMED',
  'AIRPORT_PICKER_UNAVAILABLE', 'CALENDAR_NAVIGATION_FAILED']);
const stamp = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const codedError = (code, detail) => Object.assign(new Error(detail), { code });

export function parseArgs(args) {
  const options = { searches: [], mode: 'headless', output: path.join(root, 'runs'),
    profile: null, proxy: null, proxyUser: null, proxyPassword: null,
    interactionDelayMs: 1800, minIntervalMs: 20000, retries: 1, externalChrome: false,
    browser: 'chrome',
    simpleCaptcha: false, localCaptchaSolver: false, audioCaptchaSolver: false,
    deferVerification: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--headed') { options.mode = 'headed'; continue; }
    if (arg === '--headless') { options.mode = 'headless'; continue; }
    if (arg === '--external-chrome') { options.externalChrome = true; continue; }
    if (arg === '--simple-captcha') { options.simpleCaptcha = true; continue; }
    if (arg === '--local-captcha-solver') { options.localCaptchaSolver = true; continue; }
    if (arg === '--audio-captcha-solver') { options.audioCaptchaSolver = true; continue; }
    if (arg === '--defer-verification') { options.deferVerification = true; continue; }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--search') {
      const match = /^([A-Z]{3}):([A-Z]{3}):(\d{4}-\d{2}-\d{2})$/.exec(value.toUpperCase());
      if (!match || match[1] === match[2] || Number.isNaN(Date.parse(`${match[3]}T00:00:00Z`)) ||
          new Date(`${match[3]}T00:00:00Z`).toISOString().slice(0, 10) !== match[3])
        throw new Error(`Invalid search ${value}; use DEL:BOM:YYYY-MM-DD`);
      options.searches.push({ origin: match[1], destination: match[2], travelDate: match[3] });
    } else if (arg === '--output') options.output = path.resolve(value);
    else if (arg === '--browser') options.browser = value;
    else if (arg === '--profile') options.profile = path.resolve(value);
    else if (arg === '--proxy') options.proxy = value;
    else if (arg === '--proxy-user') options.proxyUser = value;
    else if (arg === '--proxy-password') options.proxyPassword = value;
    else if (arg === '--interaction-delay-ms') options.interactionDelayMs = Number(value);
    else if (arg === '--min-interval-ms') options.minIntervalMs = Number(value);
    else if (arg === '--retries') options.retries = Number(value);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.searches.length || options.searches.length > 54)
    throw new Error('Provide 1–54 searches');
  if (!Number.isInteger(options.interactionDelayMs) || options.interactionDelayMs < 0 ||
      options.interactionDelayMs > 10000) throw new Error('Invalid interaction delay');
  if (!Number.isInteger(options.minIntervalMs) || options.minIntervalMs < 0 ||
      options.minIntervalMs > 3600000) throw new Error('Invalid search interval');
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 2)
    throw new Error('Retries must be 0, 1, or 2');
  if (!['chrome', 'firefox'].includes(options.browser))
    throw new Error('--browser must be chrome or firefox');
  if (options.simpleCaptcha && options.mode !== 'headed')
    throw new Error('--simple-captcha requires --headed');
  if (options.localCaptchaSolver && (options.simpleCaptcha || !options.externalChrome))
    throw new Error('--local-captcha-solver requires --external-chrome and cannot combine with --simple-captcha');
  if (options.audioCaptchaSolver && (options.simpleCaptcha || options.localCaptchaSolver || !options.externalChrome))
    throw new Error('--audio-captcha-solver requires --external-chrome and cannot combine with another CAPTCHA solver');
  if (options.proxy) {
    const url = new URL(options.proxy);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash)
      throw new Error('Proxy must be a plain HTTP, HTTPS, or SOCKS5 server URL');
  } else if (options.proxyUser || options.proxyPassword) throw new Error('Proxy credentials require --proxy');
  if (options.externalChrome && (options.mode !== 'headed' || options.proxy || options.browser !== 'chrome'))
    throw new Error('--external-chrome requires --headed --browser chrome and no proxy');
  return options;
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function launchBrowser(manifest, options) {
  const executablePath = options.browser === 'firefox' ? null : chromeExecutable();
  if (!options.externalChrome) {
    const engine = options.browser === 'firefox' ? firefox : chromium;
    const context = await engine.launchPersistentContext(manifest.profile, {
      ...(options.browser === 'chrome' ? { executablePath } : {}),
      headless: options.mode === 'headless', viewport: { width: 1440, height: 900 },
      ...(options.proxy ? { proxy: { server: options.proxy,
        ...(options.proxyUser ? { username: options.proxyUser } : {}),
        ...(options.proxyPassword ? { password: options.proxyPassword } : {}) } } : {})
    });
    return { context, close: () => context.close() };
  }
  const port = await freeLoopbackPort();
  const chrome = spawn(executablePath, [
    `--user-data-dir=${manifest.profile}`, `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', 'about:blank'
  ], { stdio: 'ignore' });
  let launchError = null;
  chrome.on('error', error => { launchError = error; });
  try {
    let browser;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (launchError) throw launchError;
      if (chrome.exitCode !== null) throw new Error(`Chrome exited with code ${chrome.exitCode}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 }); break; }
      catch { await sleep(250); }
    }
    if (!browser) throw new Error('Chrome debugging endpoint did not become ready');
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome did not provide a persistent browser context');
    return { context, cdpUrl: `http://127.0.0.1:${port}`, close: async () => {
      await browser.close().catch(() => {});
      if (chrome.exitCode === null) chrome.kill('SIGTERM');
    } };
  } catch (error) {
    if (chrome.exitCode === null) chrome.kill('SIGTERM');
    throw error;
  }
}

async function sourceFingerprint() {
  const files = ['src/collect.mjs', 'src/parse.mjs', 'src/verify.mjs', 'src/web-jobs.mjs',
    'src/browser-path.mjs', 'src/local_recaptcha_solver.py',
    'src/local_audio_solver.py', 'package-lock.json'];
  return hash(Buffer.concat(await Promise.all(files.map(file => fs.readFile(path.join(root, file))))));
}
async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function savePage(page, directory, label) {
  const html = await page.content().catch(() => null);
  const screenshot = await page.screenshot({ fullPage: true, timeout: 15000 }).catch(() => null);
  if (html) await fs.writeFile(path.join(directory, `${label}.html`), html, { mode: 0o600 });
  if (screenshot) await fs.writeFile(path.join(directory, `${label}.png`), screenshot, { mode: 0o600 });
  return { html: html ? `${label}.html` : null, htmlSha256: html ? hash(html) : null,
    screenshot: screenshot ? `${label}.png` : null,
    screenshotSha256: screenshot ? hash(screenshot) : null };
}

async function runLocalSolver(cdpUrl, directory, mode = 'image') {
  const executable = process.env.AIRINDIA_SOLVER_PYTHON || 'python3';
  const script = path.join(root, 'src', mode === 'audio' ? 'local_audio_solver.py' : 'local_recaptcha_solver.py');
  const resultFile = path.join(directory, 'local-solver-result.json');
  await fs.rm(resultFile, { force: true });
  return new Promise(resolve => {
    const child = spawn(executable, [script, '--cdp', cdpUrl, '--out', directory],
      { stdio: 'ignore' });
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ status: 'timeout', detail: 'Local solver exceeded 180 seconds' });
    }, 180000);
    child.on('error', error => finish({ status: 'failed', detail: error.message }));
    child.on('close', async code => {
      try {
        const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
        finish({ status: result.status, detail: result.error?.detail || null, exitCode: code });
      } catch (error) {
        finish({ status: 'failed', detail: `Local solver exited ${code}; result read failed: ${error.code || error.name}` });
      }
    });
  });
}

function classify(error, network, text = '') {
  if (/verify you are human|please check the box below|captcha|security challenge/i.test(text))
    return { code: 'CAPTCHA', detail: 'Air India displayed a human verification challenge' };
  if (/access denied|you don't have permission|request blocked/i.test(text))
    return { code: 'ACCESS_DENIED', detail: 'Air India displayed an access denial' };
  const handoff = network.findLast(item => item.path === HANDOFF && item.method === 'POST');
  if (handoff?.status === 403) return { code: 'ACCESS_DENIED', detail: 'Air India booking handoff returned HTTP 403' };
  if (handoff?.status === 429) return { code: 'RATE_LIMITED', detail: 'Air India booking handoff returned HTTP 429' };
  if (handoff?.status === 401) return { code: 'SESSION_EXPIRED', detail: 'Air India booking handoff returned HTTP 401' };
  if (error.code) return { code: error.code, detail: error.message };
  if (/ERR_CERT_|CERTIFICATE_VERIFY_FAILED/i.test(error.message))
    return { code: 'TLS_TRUST_FAILURE', detail: error.message };
  if (/timeout/i.test(error.message)) return { code: 'TIMEOUT', detail: error.message };
  if (network.some(item => item.failed)) return { code: 'SITE_NETWORK_FAILURE', detail: error.message };
  return { code: 'SEARCH_FAILED', detail: error.message };
}

export function classifyFailure(error, network, text = '') {
  const cause = classify(error, network, text);
  if (error.code && cause.code === error.code) cause.detail = error.message;
  return cause;
}

async function selectAirport(page, label, code, delayMs) {
  const open = page.getByRole('button', { name: label, exact: true }).first();
  await open.click({ timeout: 10000 });
  const input = page.getByPlaceholder('Search airport...');
  await input.fill(code);
  const option = page.locator('button').filter({ has: page.locator(`div:text-is("${code}")`) }).last();
  const waitForOption = async () => {
    try { await option.waitFor({ state: 'visible', timeout: 10000 }); }
    catch { throw codedError('AIRPORT_PICKER_UNAVAILABLE',
      `Air India did not show airport ${code} in the ${label} picker`); }
  };
  await waitForOption();
  await sleep(delayMs);
  if (!await input.isVisible().catch(() => false)) {
    await open.click({ timeout: 10000 });
    await input.fill(code);
    await waitForOption();
  }
  let clickError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await option.waitFor({ state: 'visible', timeout: 5000 });
      await option.click({ timeout: 7000 });
      clickError = null;
      break;
    } catch (error) {
      clickError = error;
      if (attempt === 0) {
        if (!await input.isVisible().catch(() => false)) await open.click({ timeout: 5000 });
        await input.fill(code);
      }
    }
  }
  if (clickError) throw codedError('AIRPORT_PICKER_UNAVAILABLE',
    `Air India showed airport ${code}, but the ${label} choice could not be selected: ` +
    clickError.message.split('\n')[0]);
  const selected = await page.locator('button').filter({ has: page.locator(`div:text-is("${code}")`) })
    .first().innerText().catch(() => '');
  if (!selected.includes(code)) throw codedError('FORM_UNCONFIRMED', `${label} did not confirm ${code}`);
}

async function selectDate(page, isoDate, delayMs) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  const option = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  const day = String(date.getUTCDate());
  await page.getByRole('button', { name: /Depart\s*Select Date/ }).first().click({ timeout: 10000 });
  const monthHeading = page.locator('h4').filter({ hasText: month }).filter({ visible: true });
  if (!await monthHeading.count()) {
    const selector = page.locator('select').filter({ has: page.locator(`option[value="${option}"]`) }).first();
    await selector.selectOption(option);
  }
  const calendar = page.locator('h4').filter({ hasText: month }).filter({ visible: true }).last().locator('..');
  const dayButton = calendar.getByRole('button', { name: day, exact: true });
  await dayButton.click({ timeout: 10000 });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 10000 });
  await sleep(delayMs);
  const actual = await page.getByRole('button', { name: /Depart/i }).first().innerText();
  const expected = `${day.padStart(2, '0')} ${new Intl.DateTimeFormat('en-US',
    { month: 'short', timeZone: 'UTC' }).format(date).toUpperCase()} ${date.getUTCFullYear()}`;
  if (!actual.includes(expected)) throw codedError('FORM_UNCONFIRMED',
    `Departure date displayed ${actual.replace(/\s+/g, ' ')} instead of ${expected}`);
}

async function collectAttempt(context, query, directory, options, log, attempt, cdpUrl) {
  const page = await context.newPage();
  await page.addLocatorHandler(page.locator('#onetrust-accept-btn-handler'), async accept => {
    await accept.click({ timeout: 5000 });
    await log('cookie_consent_dismissed', { query, attempt });
  });
  const network = [];
  const candidateResponses = [];
  let submitted = false;
  let stage = 'browser_ready';
  let evidence = {};
  const stageLog = async value => { stage = value; await log('stage', { query, attempt, stage: value }); };
  const site = url => { try { const parsed = new URL(url); return parsed.hostname.endsWith('airindia.com') ?
    { host: parsed.hostname, path: parsed.pathname } : null; } catch { return null; } };
  page.on('response', response => {
    const target = site(response.url());
    if (!target) return;
    const record = { at: stamp(), ...target, method: response.request().method(), status: response.status() };
    if (record.status >= 400 || record.path === HANDOFF) network.push(record);
    if (submitted && /json/.test(response.headers()['content-type'] || '') &&
        !record.path.startsWith('/nNnW/') && /api|availability|offer|flight|search|journey|shopping/i.test(record.path))
      candidateResponses.push(response.text().then(body => ({ record, body })).catch(() => null));
  });
  page.on('requestfailed', request => {
    const target = site(request.url());
    if (target) network.push({ at: stamp(), ...target, method: request.method(),
      failed: request.failure()?.errorText || 'unknown' });
  });
  try {
    await stageLog('browser_ready');
    const home = await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await stageLog('homepage_loaded');
    if (home?.status() === 403) throw codedError('ACCESS_DENIED', 'Air India booking page returned HTTP 403');
    await page.locator('input[value="one-way"]').waitFor({ state: 'visible', timeout: 20000 });
    await sleep(options.interactionDelayMs);
    await page.locator('input[value="one-way"]').check();
    await stageLog('airports_ready');
    await selectAirport(page, 'FROM', query.origin, options.interactionDelayMs);
    await selectAirport(page, 'TO', query.destination, options.interactionDelayMs);
    await selectDate(page, query.travelDate, options.interactionDelayMs);
    await stageLog('form_confirmed');
    const form = await savePage(page, directory, `form-attempt-${attempt}`);
    evidence.formPage = form.html;
    evidence.formPageSha256 = form.htmlSha256;
    evidence.formScreenshot = form.screenshot;
    evidence.formScreenshotSha256 = form.screenshotSha256;
    const search = page.getByRole('button', { name: 'Search', exact: true }).first();
    const widgetText = await page.locator('.ai-booking-widget').first().innerText();
    const expectedDate = new Date(`${query.travelDate}T12:00:00Z`);
    const dateLabel = `${String(expectedDate.getUTCDate()).padStart(2, '0')} ${new Intl.DateTimeFormat('en-US',
      { month: 'short', timeZone: 'UTC' }).format(expectedDate).toUpperCase()} ${expectedDate.getUTCFullYear()}`;
    if (![query.origin, query.destination, dateLabel].every(value => widgetText.includes(value)))
      throw codedError('FORM_UNCONFIRMED', 'The booking form changed after the cookie dialog');
    if (!await search.isEnabled()) throw codedError('FORM_UNCONFIRMED', 'Air India search remained disabled');
    const handoffWait = page.waitForResponse(response => {
      const target = site(response.url());
      return target?.path === HANDOFF && response.request().method() === 'POST';
    }, { timeout: 50000 }).catch(() => null);
    submitted = true;
    await search.click({ timeout: 12000 });
    await stageLog('search_submitted');
    const handoff = await handoffWait;
    if (!handoff) throw codedError('SITE_NETWORK_FAILURE', 'No Air India booking handoff response arrived');
    const handoffBody = await handoff.text().catch(() => null);
    if (handoffBody) {
      const filename = `booking-response-attempt-${attempt}.html`;
      await fs.writeFile(path.join(directory, filename), handoffBody, { mode: 0o600 });
      evidence.bookingResponse = filename;
      evidence.bookingResponseSha256 = hash(handoffBody);
    }
    await page.waitForTimeout(2500);
    let text = await page.locator('body').innerText().catch(() => '');
    let captchaPuzzleRequired = false;
    let solverOutcome = null;
    if ((options.localCaptchaSolver || options.audioCaptchaSolver) &&
        classify(new Error('Air India access check'), network, text).code === 'CAPTCHA') {
      const solverMode = options.audioCaptchaSolver ? 'audio' : 'image';
      await stageLog(`${solverMode}_captcha_solver`);
      const outcome = await runLocalSolver(cdpUrl, directory, solverMode);
      solverOutcome = outcome;
      await log(`${solverMode}_captcha_solver_result`, { query, attempt, ...outcome });
      if (outcome.status === 'challenge_submitted') await page.waitForTimeout(10000);
      text = await page.locator('body').innerText().catch(() => '');
    }
    if (options.simpleCaptcha && classify(new Error('Air India access check'), network, text).code === 'CAPTCHA') {
      await stageLog('simple_captcha');
      await log('captcha_checkbox_attempt', { query, attempt });
      try {
        await page.frameLocator('iframe[title="reCAPTCHA"]').locator('#recaptcha-anchor').click({ timeout: 10000 });
        await page.waitForTimeout(3500);
        const submit = page.locator('#refx-submit-btn');
        if (await submit.isEnabled().catch(() => false)) {
          await submit.click({ timeout: 10000 });
          await page.waitForTimeout(8000);
          await log('captcha_submit_attempt', { query, attempt, pageHost: site(page.url())?.host || null });
        } else {
          captchaPuzzleRequired = true;
          await log('captcha_puzzle_required', { query, attempt });
        }
      } catch (captchaError) {
        await log('captcha_checkbox_failed', { query, attempt, detail: captchaError.message.slice(0, 300) });
      }
      text = await page.locator('body').innerText().catch(() => '');
    }
    const access = classify(new Error('Air India access check'), network, text);
    if (captchaPuzzleRequired && access.code === 'CAPTCHA')
      access.detail = 'Google reCAPTCHA opened an image-selection puzzle after the checkbox';
    if (solverOutcome?.status === 'rate_limited' && access.code === 'CAPTCHA')
      throw codedError('RATE_LIMITED', 'Google limited the audio challenge');
    if (solverOutcome && solverOutcome.status !== 'challenge_submitted' && access.code === 'CAPTCHA')
      access.detail = `Access check remained open after local helper: ${solverOutcome.status}${solverOutcome.detail ? ` (${solverOutcome.detail})` : ''}`;
    if (DENIAL.has(access.code)) throw codedError(access.code, access.detail);
    if (handoff.status() !== 200) throw codedError('SITE_NETWORK_FAILURE',
      `Air India booking handoff returned HTTP ${handoff.status()}`);
    const resultsDeadline = Date.now() + 20000;
    while (Date.now() < resultsDeadline) {
      if (candidateResponses.length && await page.locator('.ai-pb-flight-card-wrapper').count()) break;
      await page.waitForTimeout(1000);
      text = await page.locator('body').innerText().catch(() => '');
      const lateAccess = classify(new Error('Air India results check'), network, text);
      if (DENIAL.has(lateAccess.code)) throw codedError(lateAccess.code, lateAccess.detail);
    }
    const resultPage = await savePage(page, directory, `results-attempt-${attempt}`);
    evidence.resultPage = resultPage.html;
    evidence.resultPageSha256 = resultPage.htmlSha256;
    evidence.resultScreenshot = resultPage.screenshot;
    evidence.resultScreenshotSha256 = resultPage.screenshotSha256;
    if (!await page.locator('.ai-pb-flight-card-wrapper').count())
      throw codedError('RESULTS_NOT_RENDERED',
        'Air India returned the booking shell but displayed no flight cards within 20 seconds');
    await stageLog('results_rendered');
    const responses = (await Promise.all(candidateResponses)).filter(Boolean);
    if (!responses.length) throw codedError('FARE_RESPONSE_UNVERIFIED',
      'No matching Air India flight-response JSON was observed after submission');
    let offer;
    for (const [index, response] of responses.entries()) {
      const filename = `candidate-response-attempt-${attempt}-${index + 1}.json`;
      await fs.writeFile(path.join(directory, filename), response.body, { mode: 0o600 });
      evidence[`candidateResponse${index + 1}`] = filename;
      evidence[`candidateResponse${index + 1}Sha256`] = hash(response.body);
    }
    for (const [index, response] of responses.entries()) {
      const fares = parseSearchResponse(response.body, query);
      if (fares !== null) { offer = { ...response, fares, index }; break; }
    }
    if (!offer) throw codedError('FARE_RESPONSE_UNVERIFIED',
      'No Air India flight-offer response was observed after submission');
    await stageLog('airline_response_verified');
    const fares = offer.fares;
    if (!fares.length) throw codedError('EMPTY_RESULTS', 'No exact-route Air India flight offers in the response');
    const cards = await extractPageCards(page);
    matchFaresToCards(fares, cards, query);
    evidence.airlineResponse = evidence[`candidateResponse${offer.index + 1}`];
    evidence.airlineResponseSha256 = hash(offer.body);
    await stageLog('fare_verified');
    await log('fare_verified', { query, attempt, exactAirportFlightCount: fares.length,
      renderedFlightCount: cards.length, lowestDisplayedFare: Math.min(...fares.map(fare => fare.price.displayedTotal)) });
    return { status: 'ok', stage, query, collectedAt: stamp(), fares,
      expectedJourneys: fares.length, coverage: { captured: fares.length, expectedJourneys: fares.length },
      network, evidence, attempt };
  } catch (error) {
    const text = await page.locator('body').innerText().catch(() => '');
    const cause = classifyFailure(error, network, text);
    const failure = await savePage(page, directory, `failure-attempt-${attempt}`);
    evidence.failurePage = failure.html;
    evidence.failurePageSha256 = failure.htmlSha256;
    evidence.failureScreenshot = failure.screenshot;
    evidence.failureScreenshotSha256 = failure.screenshotSha256;
    await log('failure', { query, attempt, stage, cause, network });
    return { status: DENIAL.has(cause.code) ? 'blocked' : 'failed', stage, cause, query,
      collectedAt: stamp(), fares: [], network, evidence, attempt };
  } finally { await page.close().catch(() => {}); }
}

export async function collect(options) {
  const id = `${stamp().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(options.output, id);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  const manifest = { id, startedAt: stamp(), finishedAt: null, source: HOME,
    sourceFingerprint: await sourceFingerprint(), browserMode: options.mode,
    profile: options.profile || path.join(root, '.session',
      options.browser === 'chrome' ? options.mode : `firefox-${options.mode}`),
    proxyConfigured: Boolean(options.proxy), browserEngine: options.browser,
    browserTransport: options.externalChrome ? 'external-chrome-cdp' : 'playwright-launch',
    networkName: process.env.AIRINDIA_NETWORK_NAME || null, simpleCaptcha: options.simpleCaptcha,
    localCaptchaSolver: options.localCaptchaSolver,
    audioCaptchaSolver: options.audioCaptchaSolver,
    deferredVerification: options.deferVerification,
    interactionDelayMs: options.interactionDelayMs,
    minIntervalMs: options.minIntervalMs, searches: options.searches, status: 'running' };
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  console.log(`RUN_DIR=${runDir}`);
  const log = async (event, detail) => {
    const record = { at: stamp(), event, ...detail };
    await fs.appendFile(path.join(runDir, 'events.ndjson'), JSON.stringify(record) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(record));
  };
  let browserSession;
  try {
    browserSession = await launchBrowser(manifest, options);
  } catch (error) {
    const code = 'BROWSER_START_FAILED';
    await log('browser_failure', { cause: { code, detail: error.message } });
    for (const [index, query] of options.searches.entries()) {
      const directory = path.join(runDir,
        `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeJson(path.join(directory, 'result.json'), { query, status: 'failed',
        collectedAt: stamp(), fares: [], cause: { code, detail: error.message } });
    }
    manifest.status = 'failed'; manifest.finishedAt = stamp();
    await writeJson(path.join(runDir, 'manifest.json'), manifest);
    return { runDir, manifest };
  }
  let lastSearchAt = 0;
  try {
    for (const [index, query] of options.searches.entries()) {
      const directory = path.join(runDir,
        `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let result;
      for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
        const gap = options.minIntervalMs - (Date.now() - lastSearchAt);
        if (gap > 0) await sleep(gap);
        lastSearchAt = Date.now();
        await log('search_start', { query, attempt });
        try {
          result = await collectAttempt(browserSession.context, query, directory, options, log, attempt,
            browserSession.cdpUrl);
        } catch (error) {
          const closed = /Target page, context or browser has been closed|Target crashed/i.test(error.message);
          const cause = { code: closed ? 'BROWSER_CONTEXT_CLOSED' : 'COLLECTOR_UNCAUGHT',
            detail: String(error.message).slice(0, 800) };
          result = { status: 'failed', stage: 'browser_ready', query,
            collectedAt: stamp(), fares: [], network: [], evidence: {}, cause, attempt };
          await log('failure', { query, attempt, stage: result.stage, cause });
        }
        await writeJson(path.join(directory, `attempt-${attempt}.json`), result);
        if (result.status === 'ok' || DENIAL.has(result.cause?.code) ||
            !RETRYABLE.has(result.cause?.code) || attempt > options.retries) break;
        const backoffMs = Math.min(12000, 2000 * 2 ** (attempt - 1));
        await log('backoff', { query, attempt, cause: result.cause.code, backoffMs });
        await sleep(backoffMs);
      }
      await writeJson(path.join(directory, 'result.json'), result);
      if (result.status !== 'ok')
        await log('search_finished', { query, status: result.status, cause: result.cause,
          fareCount: 0, expectedJourneys: result.expectedJourneys ?? null });
      if (DENIAL.has(result.cause?.code)) {
        manifest.status = 'blocked';
        for (const [remainingIndex, remainingQuery] of options.searches.entries()) {
          if (remainingIndex <= index) continue;
          const skipped = path.join(runDir, `${String(remainingIndex + 1).padStart(2, '0')}-` +
            `${remainingQuery.origin}-${remainingQuery.destination}-${remainingQuery.travelDate}`);
          await fs.mkdir(skipped, { recursive: true, mode: 0o700 });
          await writeJson(path.join(skipped, 'result.json'), { query: remainingQuery,
            collectedAt: stamp(), status: 'skipped', fares: [],
            cause: { code: 'BATCH_STOPPED', detail: result.cause.code } });
        }
        break;
      }
    }
  } finally {
    await browserSession.close().catch(() => {});
  }
  // The independent verifier starts a fresh Chrome. Close the collection
  // browser first so a crowded machine does not crash its evidence tab.
  for (const [index, query] of options.searches.entries()) {
    const directory = path.join(runDir, `${String(index + 1).padStart(2, '0')}-` +
      `${query.origin}-${query.destination}-${query.travelDate}`);
    const file = path.join(directory, 'result.json');
    const result = JSON.parse(await fs.readFile(file));
    if (result.status !== 'ok') continue;
    if (options.deferVerification) {
      await log('evidence_pending', { query, reason: 'desk_verifies_after_workers_exit' });
      continue;
    }
    let check = await verifySearch(directory).catch(error => ({ ok: false, errors: [error.message] }));
    if (!check.ok && check.errors.some(error => /Target crashed|browser has been closed/i.test(error))) {
      await sleep(2000);
      check = await verifySearch(directory).catch(error => ({ ok: false, errors: [error.message] }));
    }
    if (!check.ok) {
      result.status = 'failed'; result.fares = [];
      result.cause = { code: 'EVIDENCE_VERIFICATION_FAILED', detail: check.errors.join('; ') };
      await writeJson(file, result);
    }
    await log('evidence_checked', { query, ok: check.ok, errors: check.errors });
    if (check.ok) await log('stage', { query, attempt: result.attempt, stage: 'complete' });
    await log('search_finished', { query, status: result.status, cause: result.cause,
      fareCount: result.fares.length, expectedJourneys: result.expectedJourneys ?? null });
  }
  if (manifest.status !== 'blocked') {
    const results = await Promise.all(options.searches.map(async (query, index) => {
      const file = path.join(runDir, `${String(index + 1).padStart(2, '0')}-` +
        `${query.origin}-${query.destination}-${query.travelDate}`, 'result.json');
      return JSON.parse(await fs.readFile(file));
    }));
    manifest.status = results.every(result => result.status === 'ok') ? 'complete' : 'partial';
  }
  manifest.finishedAt = stamp();
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  return { runDir, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await collect(parseArgs(process.argv.slice(2)));
    console.log(`RUN_STATUS=${result.manifest.status}`);
    if (result.manifest.status !== 'complete') process.exitCode = 2;
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 2; }
}
