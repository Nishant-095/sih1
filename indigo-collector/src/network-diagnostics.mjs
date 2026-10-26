import { isIndigoUrl, isCriticalPageResource } from './faults.mjs';
import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const flightSearch = url => new URL(url).pathname === '/v2/flight/search';
const headerMap = headers => Object.fromEntries(Object.entries(headers || {})
  .map(([name, value]) => [name.toLowerCase(), String(value)]));
function requestShape(headers, postData) {
  const h = headerMap(headers);
  const safe = {};
  for (const name of ['content-type', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'])
    if (h[name]) safe[name] = h[name].slice(0, 512);
  for (const name of ['origin', 'referer']) {
    try { const url = new URL(h[name]); safe[name] = url.origin + url.pathname; } catch { /* absent */ }
  }
  const shape = { headerNames: Object.keys(h).sort(), publicHeaders: safe,
    authorizationPresent: Boolean(h.authorization),
    cookieNames: (h.cookie || '').split(';').map(part => part.trim().split('=')[0]).filter(Boolean).sort() };
  if (h.authorization) shape.authorizationSha256 = digest(h.authorization);
  for (const name of ['user_key', 'x-api-key'])
    if (h[name]) (shape.privateHeaderHashes ||= {})[name] = digest(h[name]);
  if (typeof postData === 'string') {
    shape.postDataBytes = Buffer.byteLength(postData);
    shape.postDataSha256 = digest(postData);
    try { shape.payloadKeys = Object.keys(JSON.parse(postData)).sort(); } catch { /* non-JSON */ }
  }
  return shape;
}
function responseMeta(headers) {
  const h = headerMap(headers), safe = {};
  for (const name of ['server', 'content-type', 'content-length', 'retry-after',
    'x-cache', 'cf-ray', 'x-amz-cf-id', 'x-akamai-request-id'])
    if (h[name]) safe[name] = h[name].slice(0, 512);
  return safe;
}

// Store selected public metadata and hashes, never raw authentication values,
// cookie values, URL queries, POST bodies, or rejection bodies.
export async function observeNetwork(page) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
  } catch (error) {
    await session?.detach().catch(() => {});
    return { available: false, reason: error.message.split('\n')[0], events: [], close: async () => {} };
  }
  const events = [];
  const requests = new Map();
  const earlyHeaders = new Map();
  const rejectedRequests = new Set();
  const pendingBodies = [];
  const add = entry => { if (events.length < 400) events.push({ at: new Date().toISOString(), ...entry }); };
  session.on('Network.requestWillBeSent', event => {
    const url = event.request?.url;
    if (url && isIndigoUrl(url) && isCriticalPageResource(url, event.type?.toLowerCase() || 'fetch')) {
      const request = { url: new URL(url).origin + new URL(url).pathname,
        method: event.request.method };
      requests.set(event.requestId, request);
      add({ kind: 'request', ...request });
      if (flightSearch(url) && request.method === 'POST') {
        add({ kind: 'request_shape', ...request,
          ...requestShape(event.request.headers, event.request.postData) });
        if (earlyHeaders.has(event.requestId)) {
          add({ kind: 'request_headers', ...request,
            ...earlyHeaders.get(event.requestId) });
          earlyHeaders.delete(event.requestId);
        }
      }
    }
  });
  session.on('Network.requestWillBeSentExtraInfo', event => {
    const request = requests.get(event.requestId);
    if (request && flightSearch(request.url) && request.method === 'POST')
      add({ kind: 'request_headers', ...request, ...requestShape(event.headers) });
    else if (!request && earlyHeaders.size < 200)
      // Sanitize before retaining even an out-of-order header event.
      earlyHeaders.set(event.requestId, requestShape(event.headers));
  });
  session.on('Network.responseReceived', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    const response = event.response || {};
    add({ kind: 'response', ...request, status: response.status,
      protocol: response.protocol || null, remoteIp: response.remoteIPAddress || null,
      connectionReused: Boolean(response.connectionReused),
      tlsProtocol: response.securityDetails?.protocol || null,
      certificateIssuer: response.securityDetails?.issuer || null });
  });
  // CORS failures can hide responseReceived from the page. CDP still exposes
  // the actual HTTP status here; retain only the public CORS header presence.
  session.on('Network.responseReceivedExtraInfo', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    const names = Object.keys(event.headers || {}).map(name => name.toLowerCase());
    add({ kind: 'response_status', ...request, status: event.statusCode,
      allowOriginPresent: names.includes('access-control-allow-origin'),
      ...(flightSearch(request.url) ? { responseMeta: responseMeta(event.headers) } : {}) });
    if (flightSearch(request.url) && request.method === 'POST' && event.statusCode >= 400)
      rejectedRequests.add(event.requestId);
  });
  const finishRequest = requestId => {
    const request = requests.get(requestId);
    if (request && rejectedRequests.has(requestId)) {
      // Read the already received body from Chrome. This sends no new HTTP request.
      pendingBodies.push((async () => {
        let timeout;
        try {
          const response = await Promise.race([
            session.send('Network.getResponseBody', { requestId }),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Body unavailable')), 2000); })
          ]);
          const body = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
          add({ kind: 'rejection_body', ...request, available: true,
            bytes: body.length, sha256: digest(body) });
        } catch {
          add({ kind: 'rejection_body', ...request, available: false,
            reason: 'Chrome did not expose the received response body' });
        } finally { clearTimeout(timeout); }
      })());
    }
    requests.delete(requestId);
    earlyHeaders.delete(requestId);
    rejectedRequests.delete(requestId);
  };
  session.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId);
    if (!request) return;
    add({ kind: 'failed', ...request, error: event.errorText || null,
      blockedReason: event.blockedReason || null,
      corsError: event.corsErrorStatus?.corsError || null });
    finishRequest(event.requestId);
  });
  session.on('Network.loadingFinished', event => finishRequest(event.requestId));
  return { available: true, events, close: async () => {
    await Promise.allSettled(pendingBodies);
    await session.detach().catch(() => {});
  } };
}
