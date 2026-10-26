import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { openChromeSession } from './chrome-session.mjs';
import { collectSearches } from './collect.mjs';

export class ChromeWorker {
  constructor(options, { open = openChromeSession, connect = chromium.connectOverCDP.bind(chromium),
    collect = collectSearches } = {}) {
    this.options = options;
    this.open = open; this.connect = connect; this.collect = collect;
    this.id = crypto.randomUUID();
    this.searchCount = 0;
    this.busy = false;
    this.denied = false;
    this.closing = false;
    this.chrome = null;
    this.browser = null;
    this.page = null;
  }

  async initialize() {
    if (this.closing) throw Object.assign(new Error('Browser worker is shutting down'), { code: 'COLLECTION_CANCELLED' });
    if (this.browser) {
      if (!this.browser.isConnected()) throw Object.assign(new Error('Persistent Chrome disconnected'),
        { code: 'BROWSER_DISCONNECTED' });
      return;
    }
    this.chrome = await this.open(this.options);
    try {
      if (this.closing) throw Object.assign(new Error('Browser worker is shutting down'), { code: 'COLLECTION_CANCELLED' });
      this.browser = await this.connect(`http://127.0.0.1:${this.chrome.port}`);
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new Error('Persistent Chrome has no browser context');
    } catch (error) {
      await this.chrome.close().catch(() => {});
      this.browser = null;
      throw error;
    }
  }

  async run(argv, onEvent) {
    if (this.busy || this.denied || this.closing)
      throw Object.assign(new Error('Worker is busy, denied, or shutting down'), { code: 'WORKER_UNAVAILABLE' });
    this.busy = true;
    this.onEvent = async record => {
      if (record.event === 'search_failure' && ['ACCESS_DENIED', 'CAPTCHA', 'RATE_LIMITED',
        'SESSION_EXPIRED', 'SESSION_INVALID'].includes(record.code)) this.denied = true;
      await onEvent(record);
    };
    try { return await this.collect(argv, this); }
    finally { this.busy = false; this.onEvent = null; }
  }

  async close() {
    this.closing = true;
    await this.chrome?.close();
    this.browser = null;
  }
}
