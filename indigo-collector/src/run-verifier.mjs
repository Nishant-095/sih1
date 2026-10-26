import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifiedResponseFares } from './fare-response.mjs';
import { displayedStartingFare } from './starting-fare.mjs';

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const validQuery = q => /^[A-Z]{3}$/.test(q?.origin || '') &&
  /^[A-Z]{3}$/.test(q?.destination || '') && /^\d{4}-\d{2}-\d{2}$/.test(q?.travelDate || '');

async function readEvidence(dir, name, expectedHash, errors, label, requiredHash) {
  if (typeof name !== 'string' || path.basename(name) !== name) {
    errors.push(`${label}: invalid evidence filename`);
    return null;
  }
  try {
    const data = await fs.readFile(path.join(dir, name));
    if (requiredHash && !expectedHash) errors.push(`${label}: missing SHA-256`);
    if (expectedHash && hash(data) !== expectedHash) errors.push(`${label}: SHA-256 mismatch`);
    return data;
  } catch {
    errors.push(`${label}: missing ${name}`);
    return null;
  }
}

export async function verifyRun(root) {
  const errors = [], warnings = [];
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const versioned = manifest.evidenceProtocolVersion === 1;
  if (!versioned) warnings.push('Legacy run has no required per-file fare hashes');
  const eventRecords = [];
  if (versioned) {
    try {
      const log = await fs.readFile(path.join(root, 'events.ndjson'), 'utf8');
      if (!log.trim()) errors.push('Run event log is empty');
      else for (const [index, line] of log.trim().split('\n').entries()) {
        try { eventRecords.push(JSON.parse(line)); }
        catch { errors.push(`Run event log line ${index + 1} is invalid JSON`); }
      }
    } catch { errors.push('Run event log is missing'); }
  }
  if (eventRecords.some(event => event.event === 'test_fault_injected') &&
      !manifest.diagnosticInjection)
    errors.push('Injected diagnostic fault is not declared in the manifest');
  if (!Array.isArray(manifest.requestedSearches) ||
      manifest.searches?.length !== manifest.requestedSearches.length)
    errors.push('Manifest does not record every requested search');
  const searches = [];
  for (const [index, summary] of (manifest.searches || []).entries()) {
    const query = summary.query;
    if (!validQuery(query)) { errors.push(`Search ${index + 1}: invalid route/date`); continue; }
    const expectedQuery = manifest.requestedSearches?.[index];
    if (JSON.stringify(query) !== JSON.stringify(expectedQuery))
      errors.push(`Search ${index + 1}: query differs from request`);
    const dir = path.join(root,
      `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`);
    let result;
    try { result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8')); }
    catch { errors.push(`Search ${index + 1}: missing or invalid result.json`); continue; }
    if (JSON.stringify(result.query) !== JSON.stringify(query) || result.status !== summary.status)
      errors.push(`Search ${index + 1}: result and manifest disagree`);
    if (!result.collectedAt || !Number.isFinite(Date.parse(result.collectedAt)))
      errors.push(`Search ${index + 1}: missing collection timestamp`);
    if (['failed', 'blocked', 'skipped'].includes(result.status) && !result.cause)
      errors.push(`Search ${index + 1}: failure cause missing`);
    if (['ok', 'partial'].includes(result.status) && !result.fares?.length)
      errors.push(`Search ${index + 1}: success has no fares`);
    if (versioned && result.status !== 'skipped') {
      const network = await readEvidence(dir, 'network.json', null, errors,
        `Search ${index + 1} network log`, false);
      const pageErrors = await readEvidence(dir, 'page-errors.json', null, errors,
        `Search ${index + 1} page errors`, false);
      for (const [name, data] of [['network.json', network], ['page-errors.json', pageErrors]]) {
        if (!data) continue;
        try {
          if (!Array.isArray(JSON.parse(data.toString('utf8'))))
            errors.push(`Search ${index + 1}: ${name} is not an array`);
        } catch { errors.push(`Search ${index + 1}: ${name} is invalid JSON`); }
      }
      if (!Array.isArray(result.attempts) || !result.attempts.length)
        errors.push(`Search ${index + 1}: no attempt record`);
      if (!Array.isArray(result.evidence) || !result.evidence.length)
        errors.push(`Search ${index + 1}: no page or network evidence`);
      for (const [evidenceIndex, item] of (result.evidence || []).entries()) {
        const label = `Search ${index + 1} evidence ${evidenceIndex + 1}`;
        if (item.html || item.screenshot || item.captureErrorFile) {
          if (item.html) await readEvidence(dir, item.html, item.htmlSha256, errors,
            `${label} HTML`, true);
          else if (!item.captureErrorFile) errors.push(`${label}: HTML capture missing`);
          if (item.screenshot) await readEvidence(dir, item.screenshot,
            item.screenshotSha256, errors, `${label} screenshot`, true);
          else if (!item.captureErrorFile) errors.push(`${label}: screenshot capture missing`);
          if (item.captureErrorFile) await readEvidence(dir, item.captureErrorFile,
            item.captureErrorSha256, errors, `${label} capture error`, true);
        } else if (item.file) {
          await readEvidence(dir, item.file, item.sha256, errors, label, true);
        } else errors.push(`${label}: no evidence filename`);
      }
      const finalAttempt = result.attempts?.at(-1);
      if (['failed', 'blocked'].includes(result.status) &&
          finalAttempt?.failure?.code !== result.cause?.code)
        errors.push(`Search ${index + 1}: final attempt and failure cause disagree`);
      if (['failed', 'blocked'].includes(result.status) &&
          !eventRecords.some(event => event.event === 'search_failure' &&
            event.code === result.cause?.code &&
            JSON.stringify(event.query) === JSON.stringify(query)))
        errors.push(`Search ${index + 1}: failure is absent from event log`);
    }
    const resultEvidence = result.evidence?.findLast(item =>
      /^results(?:-attempt-\d+)?\.html$/.test(item.html || ''));
    if (result.fares?.length) {
      await readEvidence(dir, resultEvidence?.html, resultEvidence?.htmlSha256, errors,
        `Search ${index + 1} results HTML`, versioned);
      await readEvidence(dir, resultEvidence?.screenshot, resultEvidence?.screenshotSha256, errors,
        `Search ${index + 1} results screenshot`, versioned);
    }
    for (const [fareIndex, fare] of (result.fares || []).entries()) {
      const label = `Search ${index + 1} fare ${fareIndex + 1}`;
      if (fare.evidence?.resultPage !== resultEvidence?.html ||
          fare.evidence?.resultScreenshot !== resultEvidence?.screenshot ||
          (versioned && (fare.evidence?.resultPageSha256 !== resultEvidence?.htmlSha256 ||
            fare.evidence?.resultScreenshotSha256 !== resultEvidence?.screenshotSha256)))
        errors.push(`${label}: quoted result page does not match saved page evidence`);
      if (fare.origin !== query.origin || fare.destination !== query.destination ||
          fare.travelDate !== query.travelDate || !Number.isFinite(Date.parse(fare.collectedAt)))
        errors.push(`${label}: route, date, or timestamp mismatch`);
      const price = fare.price || {};
      if (price.currency !== 'INR' || !Number.isFinite(price.base) || price.base <= 0 ||
          !Number.isFinite(price.taxesAndFees) || price.taxesAndFees < 0 ||
          !Number.isFinite(price.total) || Math.abs(price.base + price.taxesAndFees - price.total) > 1)
        errors.push(`${label}: inconsistent price`);
      const response = await readEvidence(dir, fare.sourceOffer?.responseFile,
        fare.sourceOffer?.responseSha256, errors, `${label} airline response`, true);
      if (response) {
        try {
          const journeys = verifiedResponseFares(JSON.parse(response.toString('utf8')), query);
          const journey = journeys.get(fare.journeyKey);
          if (!journey || journey.flights.join(',') !== (fare.flights || []).join(',') ||
              !journey.offers.some(offer => offer.currency === price.currency &&
                Math.abs(offer.base - price.base) <= 1 &&
                Math.abs(offer.taxesAndFees - price.taxesAndFees) <= 1 &&
                Math.abs(offer.total - price.total) <= 1))
            errors.push(`${label}: fare not found in airline response`);
        } catch (error) { errors.push(`${label}: invalid airline response (${error.message})`); }
      }
      const row = await readEvidence(dir, fare.evidence?.rowHtml, fare.evidence?.rowSha256,
        errors, `${label} row HTML`, versioned);
      const responseRow = manifest.fareCaptureMode === 'all_starting_fares_v1' &&
        fare.evidence?.mode === 'response_row';
      const detail = responseRow ? null : await readEvidence(dir, fare.evidence?.detailHtml,
        fare.evidence?.detailSha256, errors, `${label} details HTML`, versioned);
      if (!responseRow) await readEvidence(dir, fare.evidence?.detailScreenshot,
        fare.evidence?.detailScreenshotSha256, errors, `${label} details screenshot`, versioned);
      if (row) {
        const rowHtml = row.toString('utf8');
        const rowText = rowHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
        if (!rowHtml.includes(fare.journeyKey) ||
            !(fare.flights || []).every(flight => rowText.includes(flight)))
          errors.push(`${label}: row HTML does not identify the quoted journey`);
        if (responseRow && (displayedStartingFare(fare.rowLabel) !== price.total ||
            !rowHtml.includes(fare.rowLabel)))
          errors.push(`${label}: displayed starting fare does not match the airline response`);
      }
      if (detail && ![price.base, price.taxesAndFees, price.total].every(amount =>
        detail.toString('utf8').includes(Number(amount).toLocaleString('en-IN'))))
        errors.push(`${label}: details HTML does not show the quoted breakdown`);
    }
    if (manifest.fareCaptureMode === 'all_starting_fares_v1' &&
        (result.coverage || ['ok', 'partial'].includes(result.status))) {
      const coverage = result.coverage;
      const responseItem = result.evidence?.find(item =>
        /^flight-search-attempt-\d+\.json$/.test(item.file || ''));
      const response = responseItem ? await readEvidence(dir, responseItem.file,
        responseItem.sha256, errors, `Search ${index + 1} inventory response`, true) : null;
      if (!coverage || !response) errors.push(`Search ${index + 1}: missing inventory coverage`);
      else {
        try {
          const journeys = verifiedResponseFares(JSON.parse(response.toString('utf8')), query);
          const captured = new Set((result.fares || []).map(fare => fare.journeyKey));
          const missing = [...journeys.keys()].filter(key => !captured.has(key));
          if (coverage.expectedJourneys !== journeys.size || coverage.captured !== captured.size ||
              captured.size !== (result.fares || []).length ||
              JSON.stringify(coverage.missingJourneyKeys) !== JSON.stringify(missing) ||
              coverage.complete !== (missing.length === 0 && !result.errors?.length))
            errors.push(`Search ${index + 1}: inventory coverage disagrees with source evidence`);
          if (result.status === 'ok' && (!coverage.complete || missing.length))
            errors.push(`Search ${index + 1}: success does not include every airline journey`);
        } catch (error) { errors.push(`Search ${index + 1}: invalid inventory response (${error.message})`); }
      }
    }
    searches.push({ query, status: result.status, fares: result.fares?.length || 0,
      cause: result.cause?.code || null, stage: result.attempts?.at(-1)?.stage || null });
  }
  if (manifest.status === 'ok' && searches.some(search => search.status !== 'ok'))
    errors.push('Manifest claims success while a search did not complete');
  return { runId: manifest.runId, root: path.resolve(root), status: manifest.status,
    startedAt: manifest.startedAt, diagnosticInjection: manifest.diagnosticInjection || null,
    diagnosticModeComparison: manifest.diagnosticModeComparison || null,
    sourceFingerprint: manifest.sourceFingerprint || null,
    searches, validEvidence: errors.length === 0, errors, warnings };
}

export function reliabilityGate(reports) {
  const eligible = reports.filter(report => !report.diagnosticInjection && !report.diagnosticModeComparison);
  const fingerprints = new Set(eligible.map(report => report.sourceFingerprint).filter(Boolean));
  const missingSourceFingerprints = eligible.filter(report => !report.sourceFingerprint).length;
  const searches = eligible.flatMap(report => report.searches || [])
    .filter(search => search.status !== 'skipped');
  const completed = searches.filter(search => search.status === 'ok').length;
  const routes = new Set(searches.map(search =>
    `${search.query.origin}-${search.query.destination}`));
  const dates = new Set(searches.map(search => search.query.travelDate));
  const days = new Set(eligible.map(report => report.startedAt?.slice(0, 10)).filter(Boolean));
  const successRate = searches.length ? completed / searches.length : 0;
  const criteria = { atLeast20Searches: searches.length >= 20, atLeastTwoRoutes: routes.size >= 2,
    atLeastTwoDates: dates.size >= 2, atLeastThreeDays: days.size >= 3,
    successRateAtLeast95Percent: successRate >= 0.95,
    singleSourceFingerprint: fingerprints.size === 1 && missingSourceFingerprints === 0,
    allEvidenceValid: eligible.every(report => report.validEvidence) };
  return { ready: Object.values(criteria).every(Boolean), criteria,
    searches: searches.length, completed, successRate, routes: routes.size,
    travelDates: dates.size, runDays: days.size,
    sourceFingerprints: fingerprints.size, missingSourceFingerprints,
    excludedDiagnosticRuns: reports.length - eligible.length };
}
