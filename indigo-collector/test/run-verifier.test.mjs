import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { reliabilityGate, verifyRun } from '../src/run-verifier.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('injected diagnostics cannot raise the measured reliability gate', () => {
  const search = { query: { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' },
    status: 'ok', fares: 1 };
  const diagnostic = { startedAt: '2026-09-26T05:00:00Z', diagnosticInjection: 'token-invalid',
    validEvidence: true, searches: Array(20).fill(search) };
  const ordinary = { startedAt: '2026-09-26T06:00:00Z', diagnosticInjection: null,
    validEvidence: true, searches: [search] };
  const gate = reliabilityGate([diagnostic, ordinary]);
  assert.equal(gate.searches, 1);
  assert.equal(gate.excludedDiagnosticRuns, 1);
  assert.equal(gate.ready, false);
});

test('the reliability gate requires one collector source build', () => {
  const reports = [0, 1, 2].map(day => ({
    startedAt: `2026-09-${String(26 + day).padStart(2, '0')}T05:00:00Z`,
    sourceFingerprint: 'same-build', validEvidence: true,
    searches: Array.from({ length: 7 }, (_, index) => ({
      query: { origin: 'DEL', destination: index % 2 ? 'BOM' : 'BLR',
        travelDate: index % 2 ? '2026-10-03' : '2026-10-05' },
      status: 'ok', fares: 1
    }))
  }));
  assert.equal(reliabilityGate(reports).ready, true);
  reports[2].sourceFingerprint = 'changed-build';
  const mixed = reliabilityGate(reports);
  assert.equal(mixed.ready, false);
  assert.equal(mixed.criteria.singleSourceFingerprint, false);
});

test('browser mode comparisons are excluded from production reliability', () => {
  const diagnostic = { diagnosticModeComparison: 'paired-starting-profile',
    sourceFingerprint: 'diagnostic-build', validEvidence: true,
    startedAt: '2026-10-09T13:00:00Z', searches: [{ status: 'ok',
      query: { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-24' } }] };
  const gate = reliabilityGate([diagnostic]);
  assert.equal(gate.searches, 0);
  assert.equal(gate.excludedDiagnosticRuns, 1);
  assert.equal(gate.ready, false);
});

test('a retry keeps distinct failure-page evidence and detects a changed earlier page', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-evidence-'));
  try {
    const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
    const dir = path.join(root, '01-DEL-BOM-2026-10-03');
    await fs.mkdir(dir);
    const evidence = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const html = `results-attempt-${attempt}.html`;
      const screenshot = `results-attempt-${attempt}.png`;
      const htmlData = `<html>attempt ${attempt}</html>`;
      const imageData = Buffer.from(`image ${attempt}`);
      await fs.writeFile(path.join(dir, html), htmlData);
      await fs.writeFile(path.join(dir, screenshot), imageData);
      evidence.push({ html, screenshot,
        htmlSha256: sha256(htmlData), screenshotSha256: sha256(imageData) });
    }
    const result = { query, collectedAt: new Date().toISOString(), status: 'failed',
      cause: { code: 'SITE_NETWORK_FAILURE' }, fares: [], evidence,
      attempts: [{ failure: { code: 'SITE_NETWORK_FAILURE' } }] };
    const manifest = { runId: 'evidence-test', startedAt: new Date().toISOString(),
      evidenceProtocolVersion: 1, requestedSearches: [query], status: 'failed',
      searches: [{ query, status: 'failed' }] };
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, 'events.ndjson'), JSON.stringify({
      event: 'search_failure', query, code: 'SITE_NETWORK_FAILURE'
    }) + '\n');
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result));
    await fs.writeFile(path.join(dir, 'network.json'), '[]\n');
    await fs.writeFile(path.join(dir, 'page-errors.json'), '[]\n');
    assert.equal((await verifyRun(root)).validEvidence, true);
    const errorFile = 'failure-attempt-2-capture-error.json';
    const errorBody = '[{"part":"screenshot","error":"page closed"}]\n';
    await fs.writeFile(path.join(dir, errorFile), errorBody);
    result.evidence.push({ html: null, screenshot: null,
      captureErrorFile: errorFile, captureErrorSha256: sha256(errorBody) });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result));
    assert.equal((await verifyRun(root)).validEvidence, true);
    await fs.writeFile(path.join(dir, 'results-attempt-1.html'), '<html>overwritten</html>');
    const changed = await verifyRun(root);
    assert.equal(changed.validEvidence, false);
    assert.match(changed.errors.join(' '), /results-attempt-1\.html|SHA-256 mismatch/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a quoted fare must point to its attempt-specific results page', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'indigo-quote-evidence-'));
  try {
    const query = { origin: 'DEL', destination: 'BOM', travelDate: '2026-10-03' };
    const dir = path.join(root, '01-DEL-BOM-2026-10-03');
    await fs.mkdir(dir);
    const saved = async (name, data) => {
      await fs.writeFile(path.join(dir, name), data);
      return sha256(data);
    };
    const page = 'results-attempt-2.html';
    const image = 'results-attempt-2.png';
    const pageHash = await saved(page, '<html>IndiGo flight selection</html>');
    const imageHash = await saved(image, Buffer.from('image'));
    const responseName = 'flight-search-attempt-2.json';
    const response = { data: { currencyCode: 'INR', trips: [{ origin: 'DEL',
      destination: 'BOM', journeysAvailable: [{ journeyKey: 'exact',
        designator: { origin: 'DEL', destination: 'BOM', departure: '2026-10-03T03:00:00' },
        segments: [{ identifier: { carrierCode: '6E', identifier: '353' } }],
        passengerFares: [{ isActive: true, totalPublishFare: 4700,
          totalTax: 1447, totalFareAmount: 6147 }] }] }] } };
    const responseHash = await saved(responseName, JSON.stringify(response));
    const rowName = 'fare-001-row.html';
    const detailName = 'fare-001-details.html';
    const detailImage = 'fare-001.png';
    const rowHash = await saved(rowName, '<div data-journey-key="exact">6E 353</div>');
    const detailHash = await saved(detailName, '<div>4,700 1,447 6,147</div>');
    const detailImageHash = await saved(detailImage, Buffer.from('detail image'));
    const fare = { ...query, journeyKey: 'exact', flights: ['6E 353'],
      collectedAt: new Date().toISOString(),
      price: { currency: 'INR', base: 4700, taxesAndFees: 1447, total: 6147 },
      sourceOffer: { responseFile: responseName, responseSha256: responseHash },
      evidence: { resultPage: page, resultScreenshot: image,
        resultPageSha256: pageHash, resultScreenshotSha256: imageHash,
        rowHtml: rowName, rowSha256: rowHash, detailHtml: detailName,
        detailSha256: detailHash, detailScreenshot: detailImage,
        detailScreenshotSha256: detailImageHash } };
    const result = { query, collectedAt: new Date().toISOString(), status: 'ok',
      cause: null, fares: [fare], attempts: [{ stage: 'complete' }],
      evidence: [{ html: page, screenshot: image,
        htmlSha256: pageHash, screenshotSha256: imageHash }] };
    const manifest = { runId: 'quote-evidence-test', startedAt: new Date().toISOString(),
      evidenceProtocolVersion: 1, requestedSearches: [query], status: 'ok',
      searches: [{ query, status: 'ok' }] };
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, 'events.ndjson'), '{}\n');
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result));
    await fs.writeFile(path.join(dir, 'network.json'), '[]\n');
    await fs.writeFile(path.join(dir, 'page-errors.json'), '[]\n');
    assert.equal((await verifyRun(root)).validEvidence, true);
    fare.evidence.resultPage = 'results-attempt-1.html';
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result));
    const mismatched = await verifyRun(root);
    assert.equal(mismatched.validEvidence, false);
    assert.match(mismatched.errors.join(' '), /quoted result page does not match/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
