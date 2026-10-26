#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openChromeSession } from '../src/chrome-session.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.resolve(process.env.INDIGO_CHROME_PROFILE || path.join(packageRoot, '.session', 'normal-chrome'));

const forceHttp1 = process.env.INDIGO_CHROME_HTTP1 === '1';
const args = process.argv.slice(2);

function takeFlag(name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args.splice(index, 2)[1];
}

async function main() {
  const captureNetLog = takeFlag('--netlog');
  const headless = takeFlag('--headless');
  if (args.includes('--cdp-url') || args.includes('--proxy-pool') || args.includes('--profile'))
    throw new Error('This launcher owns its Chrome session; use INDIGO_CHROME_PROFILE or npm run collect for --cdp-url, --proxy-pool, or --profile');
  const proxy = takeOption('--proxy') || process.env.INDIGO_PROXY_SERVER || null;
  if (proxy) {
    const parsed = new URL(proxy);
    if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash)
      throw new Error('--proxy must be an HTTP, HTTPS, or SOCKS5 server URL without credentials');
    if (process.env.INDIGO_PROXY_USERNAME || process.env.INDIGO_PROXY_PASSWORD)
      throw new Error('Chrome launcher does not support proxy authentication; use npm run collect with --proxy');
  }
  if (!args.includes('--search')) throw new Error('At least one --search is required');
  const chrome = await openChromeSession({ profile, headless, proxy, forceHttp1, captureNetLog });
  const { port, netLogPath } = chrome;
  const env = { ...process.env };
  env.INDIGO_LAUNCHER_OWNED = '1';
  env.INDIGO_BROWSER_CAPACITY_HELD = '1';
  if (headless) env.INDIGO_LAUNCHER_HEADLESS = '1';
  delete env.INDIGO_PROXY_SERVER;
  delete env.INDIGO_PROXY_USERNAME;
  delete env.INDIGO_PROXY_PASSWORD;
  console.log(`CHROME_PROFILE=${profile}`);
  console.log('CHROME_MODE=launched');
  if (proxy) console.log('CHROME_PROXY_CONFIGURED=true');
  if (forceHttp1) console.log('CHROME_HTTP1_DIAGNOSTIC=true');
  if (netLogPath) console.log(`CHROME_NETLOG_PRIVATE=${netLogPath}`);
  try {
    const collector = spawn(process.execPath,
      [path.join(packageRoot, 'src', 'collect.mjs'), ...args,
        ...(headless ? ['--headless'] : []), '--browser', 'chromium',
        '--profile', profile,
        ...(proxy ? ['--proxy', proxy] : []),
        ...(forceHttp1 ? ['--chrome-http1'] : []),
        '--cdp-url', `http://127.0.0.1:${port}`],
      { cwd: packageRoot, stdio: 'inherit', env });
    const code = await new Promise((resolve, reject) => {
      collector.once('error', reject);
      collector.once('exit', (exitCode, signal) => resolve(signal ? 2 : exitCode ?? 2));
    });
    process.exitCode = code;
  } finally {
    await chrome.close();
  }
}

main().catch(error => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'browser_start_failure',
    code: error.code || 'BROWSER_START_FAILED', detail: error.message }));
  console.error(error.message);
  process.exitCode = 2;
});
