import { isIndigoUrl } from './faults.mjs';

export function mayResetIndigoSession({ code, resetUsed, attempt, retries, browserEngine,
  cdpUrl, launcherOwned }) {
  return ['SESSION_EXPIRED', 'SESSION_INVALID'].includes(code) && !resetUsed &&
    attempt < retries && browserEngine === 'chromium' && (!cdpUrl || launcherOwned);
}

export async function resetIndigoSiteSession(context, page, network) {
  const origins = [...new Set([
    'https://www.goindigo.in',
    ...network.filter(item => isIndigoUrl(item.url)).map(item => new URL(item.url).origin)
  ])];
  const session = await context.newCDPSession(page);
  try {
    for (const origin of origins)
      await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await context.clearCookies({ domain: /(^|\.)goindigo\.in$/ });
  } finally {
    await session.detach();
  }
  return origins.length;
}
