import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseSearchResponse, extractCardsFromHtml, matchFaresToCards } from './parse.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export async function verifySavedEvidence(directory, result) {
  const errors = [];
  for (const [key, filename] of Object.entries(result.evidence || {})) {
    if (key.endsWith('Sha256') || !filename) continue;
    const digest = result.evidence[`${key}Sha256`];
    if (!digest || path.basename(filename) !== filename) {
      errors.push(`${key} has no valid filename or hash`);
      continue;
    }
    try {
      if (sha256(await fs.readFile(path.join(directory, filename))) !== digest)
        errors.push(`${key} hash differs from the saved file`);
    } catch { errors.push(`${key} file is missing`); }
  }
  return { ok: errors.length === 0, errors };
}

export async function verifySearch(directory, savedResult = null) {
  const result = savedResult || JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  const integrity = await verifySavedEvidence(directory, result);
  if (result.status !== 'ok') return { ok: false, evidenceIntegrityOk: integrity.ok,
    errors: [`Search status is ${result.status}: ${result.cause?.code || 'UNKNOWN'}`,
      ...integrity.errors] };
  const errors = [...integrity.errors];
  if (!result.fares?.length || !result.evidence?.resultPage ||
      !result.evidence?.airlineResponse || !result.evidence?.resultScreenshot)
    errors.push('Fare or result evidence is missing');
  if (errors.length) return { ok: false, errors };
  const response = await fs.readFile(path.join(directory, result.evidence.airlineResponse));
  const page = await fs.readFile(path.join(directory, result.evidence.resultPage));
  const screenshot = await fs.readFile(path.join(directory, result.evidence.resultScreenshot));
  if (sha256(response) !== result.evidence.airlineResponseSha256 ||
      sha256(page) !== result.evidence.resultPageSha256 ||
      sha256(screenshot) !== result.evidence.resultScreenshotSha256)
    errors.push('Saved response or page hash differs from the recorded hash');
  try {
    const offers = parseSearchResponse(response.toString(), result.query);
    if (!offers || offers.length !== result.fares.length)
      errors.push('Airline response fare count differs');
    const unmatched = [...(offers || [])];
    for (const fare of result.fares) {
      const index = unmatched.findIndex(item => {
        // Cabin is additive for older saved records only. Every other field
        // remains part of the exact comparison, including unexpected fields.
        const comparable = { ...item };
        if (!Object.hasOwn(fare, 'cabin') && result.fareEvidenceVersion !== 2) delete comparable.cabin;
        return JSON.stringify(comparable) === JSON.stringify(fare);
      });
      if (index < 0) errors.push(`Saved fare differs from airline response for ${fare.flight}`);
      else unmatched.splice(index, 1);
    }
    if (offers?.length) matchFaresToCards(offers,
      extractCardsFromHtml(page.toString()), result.query,
      { requireCabin: result.fareEvidenceVersion === 2 || result.fares.some(fare => Object.hasOwn(fare, 'cabin')) });
  } catch (error) { errors.push(error.code || error.message); }
  return { ok: errors.length === 0, evidenceIntegrityOk: integrity.ok, errors,
    fareCount: result.fares.length,
    query: result.query };
}

async function verifyAgentRun(directory, manifest) {
  const checks = [];
  for (const [index, query] of manifest.searches.entries()) {
    const name = `${String(index + 1).padStart(2, '0')}-${query.origin}-${query.destination}-${query.travelDate}`;
    try {
      const searchDir = path.join(directory, name);
      const check = await verifySearch(searchDir);
      const attempts = [];
      for (const filename of (await fs.readdir(searchDir)).filter(file => /^attempt-\d+\.json$/.test(file)).sort()) {
        const attempt = JSON.parse(await fs.readFile(path.join(searchDir, filename), 'utf8'));
        attempts.push({ filename, status: attempt.status,
          cause: attempt.cause?.code || null,
          evidence: await verifySavedEvidence(searchDir, attempt) });
      }
      checks.push({ name, ...check, attempts });
    }
    catch (error) { checks.push({ name, ok: false, errors: [error.message] }); }
  }
  return { run: manifest.id, status: manifest.status,
    ok: checks.length > 0 && checks.every(check => check.ok), checks };
}

async function verifyWebRun(directory, job) {
  const checks = [];
  for (const task of job.tasks || []) {
    if (!task.runRoot) {
      checks.push({ task: task.id, status: task.status, ok: false,
        errors: [`No collector run: ${task.cause?.code || task.status}`] });
      continue;
    }
    const agentRoot = path.resolve(task.runRoot);
    if (!agentRoot.startsWith(path.resolve(directory) + path.sep)) {
      checks.push({ task: task.id, status: task.status, ok: false,
        errors: ['Collector run path is outside this desk run'] });
      continue;
    }
    try { checks.push({ task: task.id, ...await verifyRun(agentRoot) }); }
    catch (error) { checks.push({ task: task.id, status: task.status,
      ok: false, errors: [error.message] }); }
  }
  return { run: job.id, kind: 'desk', status: job.status,
    ok: checks.length > 0 && checks.every(check => check.ok), checks };
}

export async function verifyRun(directory) {
  const manifestFile = path.join(directory, 'manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    return verifyAgentRun(directory, manifest);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const job = JSON.parse(await fs.readFile(path.join(directory, 'jobs.json'), 'utf8'));
    return verifyWebRun(directory, job);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const directory of process.argv.slice(2)) {
    const report = await verifyRun(path.resolve(directory));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  }
}
