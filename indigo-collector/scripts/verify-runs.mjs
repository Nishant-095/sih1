#!/usr/bin/env node
import { verifyRun, reliabilityGate } from '../src/run-verifier.mjs';

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('Usage: npm run verify:runs -- /path/to/run [more run directories]');
  process.exitCode = 2;
} else {
  const reports = [];
  for (const root of roots) {
    try { reports.push(await verifyRun(root)); }
    catch (error) { reports.push({ root, validEvidence: false, searches: [],
      errors: [error.message], warnings: [] }); }
  }
  const gate = reliabilityGate(reports);
  console.log(JSON.stringify({ reports, gate }, null, 2));
  if (reports.some(report => !report.validEvidence)) process.exitCode = 2;
}
