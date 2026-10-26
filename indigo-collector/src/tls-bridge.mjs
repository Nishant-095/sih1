import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';

const script = fileURLToPath(new URL('./tls-fetch.py', import.meta.url));
const MAX_IN_FLIGHT = 4;

function isFlightPost(url, method) {
  try {
    const parsed = new URL(url);
    return method === 'POST' && /^api-prod-flight-[a-z0-9-]+\.goindigo\.in$/i.test(parsed.hostname) &&
      parsed.pathname === '/v2/flight/search';
  } catch { return false; }
}

export function shouldBridge(url, method, resourceType, flightHttp1 = false) {
  try {
    const parsed = new URL(url);
    if (resourceType === 'image' || resourceType === 'media') return false;
    if (flightHttp1 && isFlightPost(url, method)) return true;
    if (parsed.hostname === 'api-prod-skyplus.goindigo.in' &&
        parsed.pathname === '/bookingwidgetsearchengine/search')
      return method === 'GET' || method === 'POST';
    if (method !== 'GET') return false;
    return parsed.hostname === 'www.goindigo.in' ||
      parsed.hostname === 'app-prod-skyplus6e.goindigo.in';
  } catch { return false; }
}

export function isCacheablePublicAsset(url, method) {
  if (method !== 'GET') return false;
  try {
    const parsed = new URL(url);
    if (parsed.search || parsed.hash || !/\.(?:js|css)$/i.test(parsed.pathname)) return false;
    return (parsed.hostname === 'www.goindigo.in' &&
      parsed.pathname.startsWith('/etc.clientlibs/skyplus6ev2/')) ||
      (parsed.hostname === 'app-prod-skyplus6e.goindigo.in' &&
        /^\/(?:booking|search-results)\//.test(parsed.pathname));
  } catch { return false; }
}

export function startWorker(pythonExecutable = process.env.INDIGO_PYTHON || 'python3', timeoutMs = 15000) {
  const child = spawn(pythonExecutable, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1, exited = false, stderr = '', closing;
  const rejectPending = error => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) return;
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    } catch (error) { rejectPending(error); }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-300); });
  child.on('error', rejectPending);
  child.on('close', code => {
    exited = true;
    rejectPending(new Error(`TLS bridge exited ${code}: ${stderr}`));
  });
  child.stdin.on('error', rejectPending);
  return {
    pid: child.pid,
    fetch(item) {
      return new Promise((resolve, reject) => {
        if (exited) return reject(new Error('TLS bridge process exited'));
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`TLS bridge worker did not respond within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { child.stdin.write(JSON.stringify({ id, ...item }) + '\n'); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    async close() {
      if (exited) return;
      if (closing) return closing;
      closing = (async () => {
        const closed = new Promise(resolve => child.once('close', resolve));
        child.stdin.end();
        await Promise.race([closed, sleep(1500)]);
        if (!exited) child.kill('SIGTERM');
        await Promise.race([closed, sleep(1500)]);
        if (!exited) child.kill('SIGKILL');
        await Promise.race([closed, sleep(1500)]);
        if (!exited) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
      })();
      return closing;
    }
  };
}

export async function closeBridgeResources(context, handler, worker) {
  try { await context.unroute('**/*', handler); }
  finally { await worker.close(); }
}

export async function installTlsBridge(context, proxy, log, onFailure = () => {}, assetCache = new Map(),
  { flightHttp1 = false } = {}) {
  const worker = startWorker();
  let inFlight = 0;
  const waiting = [];
  const acquire = async () => {
    if (inFlight < MAX_IN_FLIGHT) { inFlight++; return; }
    await new Promise(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  };
  const handler = async route => {
    const request = route.request();
    if (!shouldBridge(request.url(), request.method(), request.resourceType(), flightHttp1)) return route.continue();
    const url = new URL(request.url());
    const flightPost = flightHttp1 && isFlightPost(request.url(), request.method());
    const cacheable = isCacheablePublicAsset(request.url(), request.method());
    const cached = cacheable ? assetCache.get(request.url()) : null;
    if (cached) {
      await log('tls_bridge_cache_hit', { path: url.pathname, bytes: cached.body.length });
      return route.fulfill({ status: 200, contentType: cached.contentType, body: cached.body });
    }
    await acquire();
    try {
      const item = { method: request.method(), url: request.url(),
        headers: await request.allHeaders(), proxy,
        body: request.postDataBuffer()?.toString('base64') || '',
        ...(flightPost ? { httpVersion: 'v1.1' } : {}) };
      let response;
      const maxAttempts = flightPost ? 1 : 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        response = await worker.fetch(item);
        if (!response.error) break;
        if (attempt + 1 < maxAttempts) await sleep(500 * 2 ** attempt);
      }
      if (response.error) throw new Error(response.error);
      if (url.pathname === '/' && response.cookies?.length)
        await context.addCookies(response.cookies);
      await log('tls_bridge_response', { path: url.pathname, status: response.status,
        bytes: Buffer.byteLength(response.body, 'base64') });
      if (response.finalUrl && new URL(response.finalUrl).hostname !== url.hostname)
        throw new Error(`Bridge redirected outside ${url.hostname}`);
      const body = Buffer.from(response.body, 'base64');
      if (cacheable && response.status === 200 && body.length >= 64 && body.length <= 2_000_000 &&
          /(?:javascript|css)/i.test(response.contentType) &&
          !/access denied|request blocked|something went wrong/i.test(body.toString('utf8', 0, 512))) {
        assetCache.set(request.url(), { body, contentType: response.contentType });
      }
      await route.fulfill({ status: response.status, contentType: response.contentType,
        ...(flightPost ? { headers: response.corsHeaders || {} } : {}), body });
    } catch (error) {
      if (flightPost) {
        onFailure({ path: url.pathname, message: error.message.slice(0, 200) });
        await log('flight_http1_bridge_failure', { path: url.pathname, message: error.message.slice(0, 200) });
        await route.abort('failed').catch(() => {});
        return;
      }
      await log('tls_bridge_fallback', { path: url.pathname, message: error.message.slice(0, 200) });
      try { await route.continue(); }
      catch (fallbackError) {
        onFailure({ path: url.pathname, message: fallbackError.message.slice(0, 200) });
        await log('tls_bridge_failure', { path: url.pathname, message: fallbackError.message.slice(0, 200) });
        await route.abort('failed').catch(() => {});
      }
    } finally {
      release();
    }
  };
  await context.route('**/*', handler);
  return () => closeBridgeResources(context, handler, worker);
}
