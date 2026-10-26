const BOOKING_RESOURCE = /\/booking\/|\/bookingwidgetsearchengine\/search|\/bw-(?:main|additional)\.json|\/book\/flight-select|\/v1\/setting\/indigowidgets|\/v1\/token\/refresh/;

export function isIndigoUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'goindigo.in' || hostname.endsWith('.goindigo.in');
  } catch {
    return false;
  }
}

export function isBookingResource(url) {
  try {
    const parsed = new URL(url);
    if (!isIndigoUrl(url)) return false;
    return BOOKING_RESOURCE.test(parsed.pathname) ||
      /^api-prod-flight-[a-z0-9-]+\.goindigo\.in$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function isCriticalPageResource(url, resourceType) {
  if (isBookingResource(url)) return true;
  try {
    const parsed = new URL(url);
    return (resourceType === 'script' || resourceType === 'stylesheet') &&
      parsed.hostname === 'www.goindigo.in' &&
      parsed.pathname.startsWith('/etc.clientlibs/skyplus6ev2/clientlibs/clientlib-site/resources/');
  } catch {
    return false;
  }
}

export function networkAccessFault(net, startIndex) {
  const relevant = net.slice(startIndex).filter(item => isBookingResource(item.url));
  const denied = relevant.find(item => [401, 403].includes(item.status) &&
    !(item.url.includes('/v1/token/refresh') && [401, 403].includes(item.status)));
  if (denied)
    return { code: 'ACCESS_DENIED', detail: `IndiGo booking resource HTTP ${denied.status}: ${denied.url}` };
  const expired = relevant.find(item => [401, 403].includes(item.status) &&
    item.url.includes('/v1/token/refresh'));
  if (expired)
    return { code: 'SESSION_EXPIRED', detail: `IndiGo session refresh HTTP ${expired.status}: ${expired.url}` };
  const throttled = relevant.find(item => item.status === 429);
  if (throttled)
    return { code: 'RATE_LIMITED', detail: `IndiGo booking resource HTTP 429: ${throttled.url}` };
  return null;
}

export function flightHttpFault(status, body) {
  if (status === 429) return { code: 'RATE_LIMITED', detail: 'IndiGo flight search HTTP 429' };
  if (status === 401) {
    try {
      const error = JSON.parse(body)?.errors;
      if (/core:Token:Invalid/i.test(`${error?.code || ''} ${error?.message || ''}`))
        return { code: 'SESSION_INVALID', detail: 'IndiGo flight-search token invalid (HTTP 401)' };
    } catch { /* A non-JSON 401 remains an access denial. */ }
  }
  if ([401, 403].includes(status))
    return { code: 'ACCESS_DENIED', detail: `IndiGo flight search HTTP ${status}` };
  return null;
}

export function flightSearchTransportFault(net, startIndex) {
  const failed = net.slice(startIndex).find(item => {
    if (!item.failed || !isIndigoUrl(item.url)) return false;
    try {
      const url = new URL(item.url);
      return /^api-prod-flight-[a-z0-9-]+\.goindigo\.in$/i.test(url.hostname) &&
        url.pathname === '/v2/flight/search';
    } catch { return false; }
  });
  return failed ? { code: 'SITE_NETWORK_FAILURE',
    detail: `IndiGo flight search request failed: ${failed.failed} at ${failed.url}` } : null;
}

export function preferFlightTransportFailure(code, flightFault) {
  return flightFault && ['EMPTY_RESULTS', 'RESULTS_UNVERIFIED', 'SEARCH_ERROR', 'TIMEOUT'].includes(code) ?
    flightFault.code : code;
}

export function stalledFlightSearchFault(resources) {
  const stalled = resources.find(item => {
    if (item.resourceType !== 'fetch' || !isIndigoUrl(item.url)) return false;
    try {
      const url = new URL(item.url);
      return /^api-prod-flight-[a-z0-9-]+\.goindigo\.in$/i.test(url.hostname) &&
        url.pathname === '/v2/flight/search';
    } catch { return false; }
  });
  return stalled ? { code: 'SITE_NETWORK_FAILURE',
    detail: `IndiGo flight search request did not receive a response before the result timeout: ${stalled.url}` } : null;
}

export function stalledResultsDocumentFault(resources) {
  const stalled = resources.find(item => item.resourceType === 'document' &&
    isIndigoUrl(item.url) && new URL(item.url).pathname.endsWith('/book/flight-select.html'));
  return stalled ? { code: 'SITE_NETWORK_FAILURE',
    detail: `IndiGo results document did not finish loading: ${stalled.url}` } : null;
}
