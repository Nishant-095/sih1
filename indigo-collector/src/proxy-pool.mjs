import fs from 'node:fs/promises';

function validate(entry, index) {
  if (!entry || typeof entry !== 'object' || !/^[a-zA-Z0-9_-]{1,32}$/.test(entry.id || ''))
    throw new Error(`Proxy ${index + 1} needs a unique id containing letters, digits, _ or -`);
  if (entry.server === null) return { id: entry.id, proxy: null };
  let url;
  try { url = new URL(entry.server); } catch { throw new Error(`Proxy ${entry.id} has an invalid server URL`); }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error(`Proxy ${entry.id} must be an HTTP(S) or SOCKS5 server URL without credentials or path`);
  const username = entry.usernameEnv ? process.env[entry.usernameEnv] : undefined;
  const password = entry.passwordEnv ? process.env[entry.passwordEnv] : undefined;
  if (entry.usernameEnv && !username) throw new Error(`Missing environment variable ${entry.usernameEnv}`);
  if (entry.passwordEnv && !password) throw new Error(`Missing environment variable ${entry.passwordEnv}`);
  return { id: entry.id, proxy: { server: entry.server,
    ...(username && { username }), ...(password && { password }) } };
}

export async function loadProxyPool(opts) {
  if (opts.proxyPool && (opts.proxy || opts.cdpUrl))
    throw new Error('--proxy-pool cannot be combined with --proxy or --cdp-url');
  let entries;
  if (opts.proxyPool) {
    const data = JSON.parse(await fs.readFile(opts.proxyPool, 'utf8'));
    if (!Array.isArray(data.proxies) || !data.proxies.length || data.proxies.length > 20)
      throw new Error('Proxy pool must contain 1 to 20 entries in "proxies"');
    entries = data.proxies.map(validate);
  } else if (opts.proxy) {
    entries = [validate({ id: 'configured', server: opts.proxy }, 0)];
    if (opts.proxyUsername) entries[0].proxy.username = opts.proxyUsername;
    if (opts.proxyPassword) entries[0].proxy.password = opts.proxyPassword;
  } else entries = [{ id: 'direct', proxy: null }];
  if (new Set(entries.map(e => e.id)).size !== entries.length)
    throw new Error('Proxy ids must be unique');
  return new ProxyPool(entries);
}

export class ProxyPool {
  constructor(entries) {
    this.entries = entries;
    this.cursor = 0;
    this.health = new Map(entries.map(e => [e.id, { failures: 0, cooldownUntil: 0 }]));
  }

  choose(preferredId = null) {
    const now = Date.now();
    const preferred = this.entries.find(e => e.id === preferredId);
    if (preferred && this.health.get(preferred.id).cooldownUntil <= now)
      return { entry: preferred, waitMs: 0 };
    for (let i = 0; i < this.entries.length; i++) {
      const index = (this.cursor + i) % this.entries.length;
      const entry = this.entries[index];
      if (this.health.get(entry.id).cooldownUntil <= now) {
        this.cursor = (index + 1) % this.entries.length;
        return { entry, waitMs: 0 };
      }
    }
    const waitMs = Math.min(...this.entries.map(e => this.health.get(e.id).cooldownUntil - now));
    return { entry: null, waitMs: Math.max(0, waitMs) };
  }

  success(id) {
    this.health.set(id, { failures: 0, cooldownUntil: 0 });
  }

  transportFailure(id) {
    // Direct access has no proxy exit to rotate or cool down. The collector's
    // normal retry backoff still applies to a failed airline request.
    if (!this.entries.find(entry => entry.id === id)?.proxy) return 0;
    const prior = this.health.get(id);
    const failures = prior.failures + 1;
    const delay = Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 5));
    this.health.set(id, { failures, cooldownUntil: Date.now() + delay });
    return delay;
  }

  snapshot() {
    return this.entries.map(e => ({ id: e.id, exitIp: e.exitIp || null,
      verifiedAt: e.verifiedAt || null, ...this.health.get(e.id) }));
  }
}
