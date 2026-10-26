import fs from 'node:fs/promises';
import path from 'node:path';

// Conservative local pacing, not a claim about IndiGo's unpublished limits.
// Keep this outside individual runs so new batches/restarts cannot reset it.
export class SearchPacing {
  constructor({ file, launchGapMs = 20000, completionGapMs = launchGapMs,
    burstSize = 6, burstRestMs = 90000 }) {
    this.file = file;
    this.launchGapMs = launchGapMs;
    this.completionGapMs = completionGapMs;
    this.burstSize = burstSize;
    this.burstRestMs = burstRestMs;
    this.state = { version: 1, lastLaunchAt: 0, lastFinishedAt: 0, burstCount: 0 };
    this.writeChain = Promise.resolve();
  }

  async load() {
    try {
      const state = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (state.version !== 1 || ['lastLaunchAt', 'lastFinishedAt', 'burstCount']
        .some(key => !Number.isSafeInteger(state[key]) || state[key] < 0))
        throw new Error('Invalid saved search pacing state');
      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  gate(now = Date.now()) {
    const { lastLaunchAt, lastFinishedAt, burstCount } = this.state;
    const reference = Math.max(lastLaunchAt, lastFinishedAt);
    const candidates = [
      { until: lastLaunchAt ? lastLaunchAt + this.launchGapMs : 0, reason: 'launch_gap' },
      { until: lastFinishedAt ? lastFinishedAt + this.completionGapMs : 0, reason: 'between_searches' },
      { until: burstCount >= this.burstSize ? reference + this.burstRestMs : 0, reason: 'batch_rest' }
    ];
    const gate = candidates.reduce((a, b) => b.until > a.until ? b : a);
    return { waitMs: Math.max(0, gate.until - now),
      nextSearchAt: gate.until > now ? new Date(gate.until).toISOString() : null,
      reason: gate.until > now ? gate.reason : null };
  }

  async started(now = Date.now()) {
    const reference = Math.max(this.state.lastLaunchAt, this.state.lastFinishedAt);
    if (!reference || now - reference >= this.burstRestMs) this.state.burstCount = 0;
    this.state.lastLaunchAt = now;
    this.state.burstCount++;
    await this.persist();
  }

  async finished(now = Date.now()) {
    this.state.lastFinishedAt = now;
    await this.persist();
  }

  async persist() {
    const contents = JSON.stringify(this.state) + '\n';
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, contents, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    await this.writeChain;
  }
}
