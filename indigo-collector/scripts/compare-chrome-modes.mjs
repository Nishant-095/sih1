#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChromeWorker } from '../src/chrome-worker.mjs';
import { tryBrowserLease } from '../src/browser-admission.mjs';
import { verifyRun } from '../src/run-verifier.mjs';

// One bounded diagnostic comparison; no profile resets or retries after denial.
const argv = process.argv.slice(2);
const value = flag => argv[argv.indexOf(flag) + 1];
if (!argv.includes('--base-profile') || !argv.includes('--search'))
  throw new Error('Use --base-profile PATH --search ORIGIN:DESTINATION:YYYY-MM-DD');
const base = path.resolve(value('--base-profile'));
const search = value('--search');
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
const root = path.resolve('runs', `mode-comparison-${id}`);
const profiles = path.resolve('.session', 'mode-comparison', id);
for (const name of ['DevToolsActivePort', '.indigo-cdp-port']) {
  const port = Number((await fs.readFile(path.join(base, name), 'utf8').catch(() => '')).split('\n')[0]);
  if (port > 0) {
    const live = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (live?.ok) throw new Error('Comparison base profile is active; it was not copied');
  }
}
await fs.mkdir(root, { recursive: true, mode: 0o700 });
for (const mode of ['headless', 'headed']) await fs.cp(base, path.join(profiles, mode), {
  recursive: true, filter: file => !/^(?:Singleton.*|DevToolsActivePort|\.indigo-cdp-port|chrome-stderr\.log)$/.test(path.basename(file))
});
const report = { id, startedAt: new Date().toISOString(), search,
  kind: 'diagnostic_mode_comparison', sameStartingProfileSnapshot: true, modes: [] };
console.log(`COMPARISON_DIR=${root}`);
for (const mode of ['headless', 'headed']) {
  let lease;
  const deadline = Date.now() + 180000;
  while (!lease && Date.now() < deadline) {
    lease = await tryBrowserLease();
    if (!lease) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!lease) throw new Error('Shared browser slot remained busy; comparison stopped');
  await lease.attach(process.pid);
  const worker = new ChromeWorker({ profile: path.join(profiles, mode), headless: mode === 'headless',
    proxy: process.env.INDIGO_PROXY_SERVER || null });
  try {
    const result = await worker.run(['--search', search, '--output', path.join(root, mode),
      '--profile', path.join(profiles, mode), '--browser', 'chromium', '--interaction-delay-ms', '1800',
      '--retries', '0', '--all-flights', ...(mode === 'headless' ? ['--headless'] : [])],
      async event => { if (['search_stage', 'search_failure'].includes(event.event))
        console.log(JSON.stringify({ mode, ...event })); });
    const manifestFile = path.join(result.runRoot, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.diagnosticModeComparison = id;
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const verified = await verifyRun(result.runRoot);
    const query = manifest.searches[0];
    report.modes.push({ mode, runRoot: result.runRoot, sourceFingerprint: manifest.sourceFingerprint,
      status: result.status, validEvidence: verified.validEvidence, evidenceErrors: verified.errors,
      cause: query.cause, fareCount: verified.validEvidence ? query.fares.length : 0,
      environment: query.attempts?.at(-1)?.browserEnvironment || null });
    await fs.writeFile(path.join(root, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  } finally { await worker.close(); await lease.release(); }
  if (mode === 'headless') await new Promise(resolve => setTimeout(resolve, 20000));
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(root, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ comparison: report.modes.map(({ mode, status, fareCount, validEvidence }) =>
  ({ mode, status, fareCount, validEvidence })), file: path.join(root, 'comparison.json') }));
