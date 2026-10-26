import { isIP } from 'node:net';
import { chromium, firefox } from 'playwright';
import { ProxyPool } from './proxy-pool.mjs';

const IP_SOURCES = [
  { url: 'https://api.ipify.org?format=json', parse: body => JSON.parse(body).ip },
  { url: 'https://www.cloudflare.com/cdn-cgi/trace',
    parse: body => body.split(/\r?\n/).find(line => line.startsWith('ip='))?.slice(3) }
];

async function readExitIp(page) {
  const failures = [];
  for (const source of IP_SOURCES) {
    try {
      const response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (response?.status() !== 200) throw new Error(`HTTP ${response?.status() ?? 'no response'}`);
      const body = await page.locator('body').innerText({ timeout: 3000 });
      const ip = source.parse(body);
      if (typeof ip !== 'string' || !isIP(ip)) throw new Error('invalid IP response');
      return ip;
    } catch (error) { failures.push(`${new URL(source.url).hostname}: ${error.message.split('\n')[0]}`); }
  }
  throw new Error(`IP check failed through both providers (${failures.join('; ')})`);
}

export async function probeProxyExit(entry, opts) {
  const engine = opts.browserEngine === 'firefox' ? firefox : chromium;
  const launch = { headless: true, proxy: entry.proxy };
  if (opts.chromePath) launch.executablePath = opts.chromePath;
  if (opts.chromeHttp1) launch.args = ['--disable-http2'];
  let browser;
  try {
    browser = await engine.launch(launch);
    const page = await browser.newPage();
    return await readExitIp(page);
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function currentContextExit(context) {
  const page = await context.newPage();
  try { return await readExitIp(page); }
  finally { await page.close().catch(() => {}); }
}

function safeError(error, proxy) {
  let message = String(error?.message || error).replace(/:\/\/[^/@\s]+@/g, '://[redacted]@');
  for (const secret of [proxy?.username, proxy?.password])
    if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 220);
}

export async function preflightProxyPool(pool, opts, log, probe = probeProxyExit) {
  if (pool.entries.length < 2 || pool.entries.some(entry => !entry.proxy))
    throw new Error('IP rotation requires at least two configured proxy endpoints; direct access is not a rotating exit');
  const accepted = [];
  const usedIps = new Set();
  for (let i = 0; i < pool.entries.length; i += 3) {
    const batch = pool.entries.slice(i, i + 3);
    const results = await Promise.all(batch.map(async entry => {
      try { return { entry, ip: await probe(entry, opts) }; }
      catch (error) { return { entry, error: safeError(error, entry.proxy) }; }
    }));
    for (const result of results) {
      if (result.error) {
        await log('proxy_preflight_failure', { proxyId: result.entry.id, reason: result.error });
      } else if (usedIps.has(result.ip)) {
        await log('proxy_preflight_duplicate', { proxyId: result.entry.id, exitIp: result.ip });
      } else {
        usedIps.add(result.ip);
        const verifiedAt = new Date().toISOString();
        accepted.push({ ...result.entry, exitIp: result.ip, verifiedAt });
        await log('proxy_preflight_ok', { proxyId: result.entry.id, exitIp: result.ip, verifiedAt });
      }
    }
  }
  if (accepted.length < 2)
    throw new Error(`IP rotation unavailable: only ${accepted.length} distinct working proxy exit IP${accepted.length === 1 ? '' : 's'} verified`);
  return new ProxyPool(accepted);
}
