const STAGES = [
  'browser_ready', 'homepage_loaded', 'widget_ready', 'route_date_confirmed',
  'search_submitted', 'results_rendered', 'airline_response_verified',
  'fare_verified', 'complete'
];

export function advanceStage(attempt, stage, at = new Date().toISOString()) {
  const next = attempt.stages.length;
  if (STAGES[next] !== stage)
    throw new Error(`Invalid search transition: ${attempt.stages.at(-1)?.stage || 'start'} -> ${stage}`);
  attempt.stages.push({ stage, at });
  attempt.stage = stage;
  return attempt.stages.at(-1);
}

function resourceKind(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/v2/flight/search') return 'flight_search';
    if (/\/bw-(?:main|additional)\.json|\/v1\/setting\/indigowidgets/.test(parsed.pathname))
      return 'booking_widget';
    if (parsed.hostname === 'www.goindigo.in' &&
        parsed.pathname.startsWith('/etc.clientlibs/skyplus6ev2/clientlibs/clientlib-site/resources/'))
      return 'site_code';
    if (parsed.hostname === 'app-prod-skyplus6e.goindigo.in' &&
        /^\/booking\/.*\.(?:js|css)$/.test(parsed.pathname)) return 'booking_code';
    if (parsed.pathname.endsWith('/book/flight-select.html')) return 'results_document';
    if (parsed.pathname.includes('/v1/token/refresh')) return 'session_refresh';
    return parsed.hostname === 'www.goindigo.in' ? 'site_resource' : 'booking_resource';
  } catch { return 'unknown_resource'; }
}

export function failureSignature(cause) {
  if (!cause || cause.code !== 'SITE_NETWORK_FAILURE') return null;
  const resource = (cause.failedResources || []).find(item => resourceKind(item.url) === 'flight_search') ||
    (cause.failedResources || []).find(item => resourceKind(item.url) === 'booking_widget') ||
    (cause.stalledResources || []).find(item => resourceKind(item.url) === 'flight_search') ||
    (cause.failedResources || [])[0] || (cause.stalledResources || [])[0];
  if (!resource) return null;
  const error = resource.failed ?
    (String(resource.failed).match(/ERR_[A-Z0-9_]+|NS_ERROR_[A-Z0-9_]+/)?.[0] || 'OTHER') :
    'STALLED';
  return `${resourceKind(resource.url)}:${error}`;
}

export function shouldTryBridge(cause, strategy, bridgeAvailable, failedAtStage) {
  const signature = failureSignature(cause);
  return strategy === 'browser' && bridgeAvailable && failedAtStage === 'homepage_loaded' &&
    /^(booking_widget|site_code|booking_code):/.test(signature || '');
}

export class FailureCircuit {
  constructor(threshold = 2) {
    this.threshold = threshold;
    this.counts = new Map();
  }
  record(proxyId, cause) {
    const signature = failureSignature(cause);
    if (!signature) return { open: false, signature: null, count: 0 };
    const key = `${proxyId}:${signature}`;
    const count = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, count);
    return { open: count >= this.threshold, signature, count };
  }
  reset(proxyId) {
    for (const key of this.counts.keys()) if (key.startsWith(`${proxyId}:`)) this.counts.delete(key);
  }
}
