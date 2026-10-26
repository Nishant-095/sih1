import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tryBrowserLease } from './browser-admission.mjs';
import { verifyRun } from './run-verifier.mjs';
import { SearchPacing } from './search-pacing.mjs';

export const STAGES = Object.freeze([
  'browser_ready', 'homepage_loaded', 'widget_ready', 'route_date_confirmed',
  'search_submitted', 'results_rendered', 'airline_response_verified',
  'fare_verified', 'complete'
]);
export const OFFSETS = Object.freeze([1, 5, 9, 15, 30, 45]);
const DENIAL = new Set(['ACCESS_DENIED', 'CAPTCHA', 'RATE_LIMITED', 'SESSION_EXPIRED', 'SESSION_INVALID']);
const MAX_TASKS = 54;
const MAX_WORKERS = 3;
const inputError = message => Object.assign(new Error(message), { status: 400 });

export function istDate(offset, at = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
}

export function validatePlan(input, at = new Date()) {
  const raw = Array.isArray(input?.routes) ? input.routes : [];
  const routes = [...new Set(raw.map(route => String(route).trim().toUpperCase().replace(/\s+/g, '')))].map(route => {
    const match = /^([A-Z]{3})[-:→]([A-Z]{3})$/.exec(route);
    if (!match || match[1] === match[2]) throw inputError(`Invalid route: ${route}. Use DEL-BOM.`);
    return { origin: match[1], destination: match[2] };
  });
  if (!routes.length) throw inputError('Enter at least one route.');
  const offsets = [...new Set(Array.isArray(input.offsets) ? input.offsets.map(Number) : [])]
    .sort((a, b) => a - b);
  if (!offsets.length || offsets.some(offset => !OFFSETS.includes(offset)))
    throw inputError('Choose at least one offered travel date.');
  const concurrency = Number(input.concurrency ?? Math.min(2, routes.length * offsets.length));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_WORKERS)
    throw inputError(`Agents must be between 1 and ${MAX_WORKERS}.`);
  if (routes.length * offsets.length > MAX_TASKS)
    throw inputError(`This batch is limited to ${MAX_TASKS} searches.`);
  const browserMode = input.browserMode ?? 'headed';
  if (!['headed', 'headless'].includes(browserMode))
    throw inputError('Browser mode must be headed or headless.');
  return { routes, offsets, concurrency, browserMode,
    tasks: routes.flatMap(route => offsets.map(offset => ({
    ...route, offset, travelDate: istDate(offset, at)
  }))) };
}

const publicTask = task => ({
  id: task.id, origin: task.origin, destination: task.destination,
  travelDate: task.travelDate, offset: task.offset, status: task.status,
  stage: task.stage, attempt: task.attempt, worker: task.worker,
  startedAt: task.startedAt, finishedAt: task.finishedAt,
  cause: task.cause, fareCount: task.fares.length, fares: task.fares,
  coverage: task.coverage, observedFareCount: task.observedFareCount,
  expectedJourneys: task.expectedJourneys,
  evidenceVerified: task.evidenceVerified, evidenceErrors: task.evidenceErrors,
  events: task.events.slice(-25), runRoot: task.runRoot,
  recovery: task.recovery || null
});

export class JobManager extends EventEmitter {
  constructor({ root, packageRoot, minLaunchGapMs = 20000,
    completionGapMs = minLaunchGapMs, burstSize = 6, burstRestMs = 90000,
    spawnWorker = spawn, persistentWorkers = spawnWorker === spawn } = {}) {
    super();
    this.root = path.resolve(root);
    this.packageRoot = path.resolve(packageRoot);
    this.minLaunchGapMs = minLaunchGapMs;
    this.spawnWorker = spawnWorker;
    this.browserAdmission = spawnWorker === spawn;
    this.persistentWorkers = persistentWorkers;
    this.jobs = new Map();
    this.activeJob = null;
    this.children = new Map();
    this.launchTimer = null;
    this.pacing = new SearchPacing({ file: path.join(this.root, '.search-pacing.json'),
      launchGapMs: minLaunchGapMs, completionGapMs, burstSize, burstRestMs });
    this.pacingReady = null;
  }

  snapshot(job) {
    return { id: job.id, status: job.status, startedAt: job.startedAt,
      finishedAt: job.finishedAt, stopReason: job.stopReason,
      retryOf: job.retryOf || null,
      routes: job.routes, offsets: job.offsets, concurrency: job.concurrency,
      requestedConcurrency: job.requestedConcurrency, resourceNote: job.resourceNote,
      browserMode: job.browserMode,
      browserLifecycle: job.browserLifecycle || 'per_search',
      nextSearchAt: job.status === 'running' ? job.nextSearchAt || null : null,
      tasks: job.tasks.map(publicTask) };
  }

  async persist(job) {
    const snapshot = this.snapshot(job);
    job.writeChain = (job.writeChain || Promise.resolve()).then(async () => {
      const file = path.join(job.root, 'jobs.json');
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temporary, file);
    });
    await job.writeChain;
  }

  async publish(job) {
    await this.persist(job);
    this.emit('change', job.id, this.snapshot(job));
  }

  async createPlan(plan, retryOf = null) {
    await (this.pacingReady ||= this.pacing.load());
    if (['running', 'stopping'].includes(this.activeJob?.status))
      throw Object.assign(new Error('A batch is already running.'), { status: 409 });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const root = path.join(this.root, id);
    const job = { id, root, status: 'running', startedAt: new Date().toISOString(),
      finishedAt: null, stopReason: null, routes: plan.routes, offsets: plan.offsets,
      concurrency: plan.concurrency, requestedConcurrency: plan.requestedConcurrency || plan.concurrency,
      resourceNote: plan.resourceNote || null, browserMode: plan.browserMode, retryOf,
      browserLifecycle: this.persistentWorkers ? 'persistent_worker' : 'per_search',
      sessions: new Map(),
      writeChain: Promise.resolve(),
      tasks: plan.tasks.map((task, index) => ({ ...task, id: String(index + 1).padStart(3, '0'),
        status: 'queued', stage: null, attempt: 0, worker: null,
        startedAt: null, finishedAt: null, cause: null, fares: [],
        evidenceVerified: false, evidenceErrors: [], events: [], runRoot: null,
        coverage: null, observedFareCount: 0, expectedJourneys: null })) };
    this.activeJob = job;
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      this.jobs.set(id, job);
      await this.publish(job);
      this.pump(job);
      return this.snapshot(job);
    } catch (error) {
      if (this.activeJob === job) this.activeJob = null;
      this.jobs.delete(id);
      throw error;
    }
  }

  async admitPlan(plan) {
    return { ...plan, requestedConcurrency: plan.concurrency, resourceNote: null };
  }

  async create(input) {
    return this.createPlan(await this.admitPlan(validatePlan(input)));
  }

  async retry(runId, taskId) {
    const source = await this.get(runId);
    const task = source?.tasks.find(item => item.id === taskId);
    if (!task) throw inputError('Saved search not found.');
    if (!['failed', 'partial', 'skipped', 'interrupted'].includes(task.status))
      throw Object.assign(new Error('Only unfinished searches can be run again.'), { status: 409 });
    if (DENIAL.has(source.stopReason) || DENIAL.has(task.cause?.code))
      throw Object.assign(new Error('IndiGo denied access. Check access before starting a new search.'), { status: 409 });
    if (task.travelDate <= istDate(0))
      throw Object.assign(new Error('This travel date has passed. Choose a future date in a new collection.'), { status: 409 });
    const route = { origin: task.origin, destination: task.destination };
    // A headless flight-search POST can fail at the site edge with no fare
    // response. Retry that exact saved search in visible Chrome, which has a
    // separate persistent profile; keep every other retry in its original mode.
    const browserMode = source.browserMode === 'headless' &&
      task.cause?.code === 'SITE_NETWORK_FAILURE' &&
      /flight search request failed/i.test(task.cause.detail || '') ? 'headed' :
      source.browserMode || 'headed';
    return this.createPlan(await this.admitPlan({ routes: [route], offsets: [task.offset], concurrency: 1,
      browserMode,
      tasks: [{ ...route, offset: task.offset, travelDate: task.travelDate }] }),
    { runId, taskId });
  }

  async retryFailed(runId) {
    const source = await this.get(runId);
    if (!source) throw inputError('Saved run not found.');
    if (['running', 'stopping'].includes(source.status))
      throw Object.assign(new Error('Wait until the saved run finishes.'), { status: 409 });
    if (DENIAL.has(source.stopReason))
      throw Object.assign(new Error('IndiGo denied access. Check access before retrying.'), { status: 409 });
    const tasks = source.tasks.filter(task =>
      ['failed', 'partial', 'skipped', 'interrupted'].includes(task.status) &&
      !DENIAL.has(task.cause?.code) && task.travelDate > istDate(0));
    if (!tasks.length)
      throw Object.assign(new Error('This run has no retryable future searches.'), { status: 409 });
    const routes = [...new Map(tasks.map(task => [
      `${task.origin}-${task.destination}`, { origin: task.origin, destination: task.destination }
    ])).values()];
    const offsets = [...new Set(tasks.map(task => task.offset))].sort((a, b) => a - b);
    const browserMode = source.browserMode === 'headless' && tasks.some(task =>
      task.cause?.code === 'SITE_NETWORK_FAILURE' &&
      /flight search request failed/i.test(task.cause.detail || '')) ? 'headed' :
      source.browserMode || 'headed';
    const plan = { routes, offsets, browserMode,
      concurrency: Math.min(MAX_WORKERS, source.concurrency || 1, tasks.length),
      tasks: tasks.map(task => ({ origin: task.origin, destination: task.destination,
        travelDate: task.travelDate, offset: task.offset })) };
    return this.createPlan(await this.admitPlan(plan),
      { runId, taskIds: tasks.map(task => task.id) });
  }

  async deleteRun(id) {
    if (!/^[\w-]+$/.test(id)) throw inputError('Invalid run ID.');
    const run = await this.get(id);
    if (!run) throw Object.assign(new Error('Saved run not found.'), { status: 404 });
    if (['running', 'stopping'].includes(run.status))
      throw Object.assign(new Error('Stop this run before deleting it.'), { status: 409 });
    const job = this.jobs.get(id);
    if (job?.writeChain) await job.writeChain;
    await fs.rm(path.join(this.root, id), { recursive: true });
    this.jobs.delete(id);
    if (this.activeJob?.id === id) this.activeJob = null;
    return { id, deleted: true };
  }

  async get(id) {
    if (this.jobs.has(id)) return this.snapshot(this.jobs.get(id));
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      const snapshot = JSON.parse(await fs.readFile(path.join(this.root, id, 'jobs.json'), 'utf8'));
      if (['running', 'stopping'].includes(snapshot.status)) {
        snapshot.status = 'interrupted';
        snapshot.stopReason = 'Server stopped while this batch was running';
        for (const task of snapshot.tasks) if (['queued', 'running'].includes(task.status)) {
          task.status = 'interrupted';
          task.cause = { code: 'SERVER_INTERRUPTED' };
        }
      }
      return snapshot;
    } catch { return null; }
  }

  async latest() {
    const names = (await fs.readdir(this.root, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
    for (const id of names) {
      const job = await this.get(id);
      if (job) return job;
    }
    return null;
  }

  async recent(limit = 10) {
    const names = (await fs.readdir(this.root, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse().slice(0, limit);
    const runs = await Promise.all(names.map(id => this.get(id)));
    return runs.filter(Boolean).map(run => ({ id: run.id, status: run.status,
      startedAt: run.startedAt, browserMode: run.browserMode || 'headed',
      routes: run.routes?.map(route => `${route.origin}-${route.destination}`) || [],
      searches: run.tasks?.length || 0 }));
  }

  async event(job, task, record) {
    if (task.status !== 'running') return;
    if (record.event === 'search_start') task.cause = null;
    if (record.event === 'search_stage' && STAGES.includes(record.stage)) {
      task.stage = record.stage;
      task.attempt = record.attempt || task.attempt;
    }
    if (record.event === 'search_failure' || record.event === 'browser_capacity_failure') task.cause = { code: record.code || 'UNKNOWN',
      detail: record.detail || null };
    if (record.event === 'inventory_count') task.expectedJourneys = record.expectedJourneys;
    if (record.event === 'fare') task.observedFareCount = record.captured || task.observedFareCount + 1;
    task.events.push({ at: record.at || new Date().toISOString(), event: record.event,
      stage: record.stage || null, code: record.code || null,
      message: record.detail || record.reason || null });
    task.events = task.events.slice(-80);
    await this.publish(job);
    if (record.event === 'search_failure' && DENIAL.has(record.code))
      await this.stop(job, record.code, task.id);
  }

  consumeLine(job, task, line) {
    if (line.startsWith('RUN_DIR=')) {
      const candidate = path.resolve(line.slice(8).trim());
      const expected = path.join(job.root, `agent-${task.worker}`);
      if (candidate.startsWith(expected + path.sep)) task.runRoot = candidate;
      return;
    }
    if (!line.startsWith('{')) return;
    try {
      const record = JSON.parse(line);
      task.eventChain = (task.eventChain || Promise.resolve())
        .then(() => this.event(job, task, record)).catch(error => this.emit('error', error));
    }
    catch { /* Chrome startup output is not collector JSON. */ }
  }

  launch(job, task, worker, lease = null) {
    if (this.persistentWorkers) return this.launchPersistent(job, task, worker, lease);
    task.worker = worker;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    const output = path.join(job.root, `agent-${worker}`);
    const profileMode = job.browserMode === 'headless' ? 'headless-ua-v1' : job.browserMode;
    const profile = path.join(this.packageRoot, '.session', 'web-agents',
      profileMode, `agent-${worker}`);
    const args = [path.join(this.packageRoot, 'scripts', 'collect-with-chrome.mjs'),
      '--search', `${task.origin}:${task.destination}:${task.travelDate}`,
      '--output', output, '--interaction-delay-ms', '1800', '--retries', '1',
      '--all-flights'];
    if (job.browserMode === 'headless') args.push('--headless');
    const child = this.spawnWorker(process.execPath, args, { cwd: this.packageRoot,
      env: { ...process.env, INDIGO_CHROME_PROFILE: profile },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.children.set(task.id, child);
    void lease?.attach(child.pid).catch(failure => this.emit('error', failure));
    let buffer = '';
    child.stdout?.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) this.consumeLine(job, task, line.trim());
    });
    child.stderr?.on('data', data => {
      const message = data.toString().trim().slice(0, 500);
      if (message) {
        task.events.push({ at: new Date().toISOString(), event: 'worker_stderr', message });
        task.events = task.events.slice(-80);
        void this.publish(job).catch(error => this.emit('error', error));
      }
    });
    let finishStarted = false;
    const finish = (code, signal, error) => {
      if (finishStarted) return;
      finishStarted = true;
      if (buffer.trim()) this.consumeLine(job, task, buffer.trim());
      void this.finish(job, task, code, signal, error)
        .finally(() => lease?.release()).catch(failure => this.emit('error', failure));
    };
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));
    void this.publish(job).catch(error => this.emit('error', error));
  }

  launchPersistent(job, task, worker, lease) {
    let session = job.sessions.get(worker);
    if (!session) {
      // Use one dedicated Chrome profile in both modes. Retain the existing
      // headed profile's historical path; do not clear or replace its cookies
      // in response to denial. Active batches serialize profile ownership.
      const profile = path.join(this.packageRoot, '.session', 'web-agents', 'headed', `agent-${worker}`);
      const args = [path.join(this.packageRoot, 'scripts', 'chrome-worker.mjs')];
      if (job.browserMode === 'headless') args.push('--headless');
      const child = this.spawnWorker(process.execPath, args, { cwd: this.packageRoot,
        env: { ...process.env, INDIGO_CHROME_PROFILE: profile, INDIGO_LAUNCHER_OWNED: '1',
          INDIGO_BROWSER_CAPACITY_HELD: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true });
      session = { child, lease, profile, worker, ready: false, closing: false,
        task: null, searches: 0, shutdownTimer: null };
      job.sessions.set(worker, session);
      void lease?.attach(child.pid).catch(error => this.emit('error', error));
      child.stdout?.resume();
      child.stderr?.on('data', data => {
        if (!session.task) return;
        session.task.events.push({ at: new Date().toISOString(), event: 'worker_stderr',
          message: data.toString().trim().slice(0, 500) });
      });
      child.on('message', message => {
        if (message?.type === 'ready') { session.ready = true; this.sendSearch(job, session); return; }
        const current = session.task;
        if (!current || message?.taskId !== current.id) return;
        if (message.type === 'event') {
          current.eventChain = (current.eventChain || Promise.resolve())
            .then(() => this.event(job, current, message.record)).catch(error => this.emit('error', error));
        } else if (message.type === 'done' || message.type === 'error') {
          if (message.runRoot) {
            const candidate = path.resolve(message.runRoot);
            if (candidate.startsWith(path.join(job.root, `agent-${worker}`) + path.sep)) current.runRoot = candidate;
          }
          if (message.type === 'error') current.cause = { code: message.code, detail: message.detail };
          session.task = null;
          void this.finish(job, current, message.exitCode ?? 2, null, null)
            .catch(error => this.emit('error', error));
        }
      });
      let closed = false;
      const onClose = (code, signal, error) => {
        if (closed) return;
        closed = true;
        clearTimeout(session.shutdownTimer);
        job.sessions.delete(worker);
        void lease?.release().catch(failure => this.emit('error', failure));
        const current = session.task;
        session.task = null;
        if (current) {
          current.cause ||= { code: 'PERSISTENT_WORKER_EXIT',
            detail: error?.message || `Persistent worker exited ${code ?? signal ?? 'unknown'}` };
          void this.finish(job, current, code, signal, error).catch(failure => this.emit('error', failure));
        }
        if (!session.closing && job.status === 'running')
          void this.stop(job, 'PERSISTENT_WORKER_EXIT', current?.id).catch(failure => this.emit('error', failure));
      };
      child.once('error', error => onClose(null, null, error));
      child.once('close', (code, signal) => onClose(code, signal, null));
    }
    task.worker = worker;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.events.push({ at: task.startedAt, event: 'persistent_browser_worker',
      message: session.searches ? 'Reusing the live Chrome browser and search tab.' : 'Starting a persistent Chrome worker.' });
    session.task = task;
    this.children.set(task.id, session.child);
    if (session.ready) this.sendSearch(job, session);
    void this.publish(job).catch(error => this.emit('error', error));
  }

  sendSearch(job, session) {
    const task = session.task;
    if (!task || task.sentToWorker || session.closing || job.status !== 'running') return;
    task.sentToWorker = true;
    const argv = ['--search', `${task.origin}:${task.destination}:${task.travelDate}`,
      '--output', path.join(job.root, `agent-${session.worker}`), '--profile', session.profile,
      '--browser', 'chromium', '--interaction-delay-ms', '1800', '--retries', '1', '--all-flights'];
    if (job.browserMode === 'headless') argv.push('--headless');
    if (process.env.INDIGO_CHROME_HTTP1 === '1') argv.push('--chrome-http1');
    session.searches++;
    session.child.send({ type: 'search', taskId: task.id, argv }, error => {
      if (!error) return;
      task.cause = { code: 'WORKER_IPC_FAILED', detail: error.message };
      void this.stop(job, 'WORKER_IPC_FAILED').catch(failure => this.emit('error', failure));
    });
  }

  shutdownWorkers(job, exceptId = null) {
    for (const session of job.sessions?.values() || []) {
      if (session.closing || (exceptId && session.task?.id === exceptId)) continue;
      session.closing = true;
      session.child.send({ type: 'shutdown' }, () => {});
      session.shutdownTimer = setTimeout(() => {
        if (!session.child.pid) return;
        try { process.kill(-session.child.pid, 'SIGKILL'); } catch { session.child.kill('SIGKILL'); }
      }, 10000);
      session.shutdownTimer.unref();
    }
  }

  async finish(job, task, code, signal, error) {
    if (task.finishedAt) return;
    await task.eventChain;
    if (task.finishedAt) return;
    this.children.delete(task.id);
    task.finishedAt = new Date().toISOString();
    try { await this.pacing.finished(); }
    catch (failure) {
      await this.stop(job, 'PACING_STATE_UNAVAILABLE', task.id);
      this.emit('error', failure);
    }
    if (task.runRoot) {
      try {
        const report = await verifyRun(task.runRoot);
        task.evidenceVerified = report.validEvidence;
        task.evidenceErrors = report.errors;
        const dir = path.join(task.runRoot,
          `01-${task.origin}-${task.destination}-${task.travelDate}`);
        const result = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
        task.coverage = result.coverage || null;
        task.expectedJourneys = result.coverage?.expectedJourneys ?? task.expectedJourneys;
        task.observedFareCount = result.fares?.length || 0;
        task.cause = result.cause ? { code: result.cause.code, detail: result.cause.detail } : null;
        if (report.validEvidence && ['ok', 'partial', 'blocked'].includes(result.status))
          task.fares = result.fares.map((fare, index) => ({
            flight: fare.flights.join(' · '), collectedAt: fare.collectedAt,
            price: fare.price, fareBrand: fare.fareBrand,
            departureTime: fare.departureTime, arrivalTime: fare.arrivalTime,
            stops: Math.max(0, fare.flights.length - 1),
            screenshot: fare.evidence.detailScreenshot || fare.evidence.resultScreenshot,
            rowFile: fare.evidence.rowHtml,
            resultPage: fare.evidence.resultPage,
            response: fare.sourceOffer.responseFile
          }));
        if (task.status === 'running') task.status = report.validEvidence ? result.status : 'failed';
        if (!report.validEvidence) task.cause = { code: 'EVIDENCE_UNVERIFIED',
          detail: report.errors.join('; ').slice(0, 700) };
      } catch (failure) {
        if (task.status === 'running') task.status = 'failed';
        task.cause = { code: 'WORKER_RESULT_UNAVAILABLE', detail: failure.message };
      }
    } else if (task.status === 'running') {
      task.status = 'failed';
      task.cause ||= { code: 'WORKER_DID_NOT_SAVE_RUN',
        detail: error?.message || `Exit ${code ?? signal ?? 'unknown'} before run evidence was available` };
    }
    if (!task.cause && code !== 0 && task.status !== 'ok')
      task.cause = { code: 'WORKER_EXIT', detail: `Exit ${code ?? signal ?? 'unknown'}` };
    await this.publish(job);
    if (DENIAL.has(task.cause?.code)) await this.stop(job, task.cause.code, task.id);
    if (job.status === 'running') {
      const repeatable = new Set(['SITE_NETWORK_FAILURE', 'TLS_TRUST_FAILURE',
        'BOOKING_WIDGET_UNAVAILABLE', 'RESULTS_UNVERIFIED', 'SESSION_NOT_READY', 'BROWSER_DISCONNECTED']);
      const code = task.status === 'failed' ? task.cause?.code : null;
      job.lastFailure = repeatable.has(code) ?
        { code, count: job.lastFailure?.code === code ? job.lastFailure.count + 1 : 1 } : null;
      if (job.lastFailure?.count >= 2) await this.stop(job, `REPEATED_${code}`);
    }
    if (job.status === 'stopping' && this.children.size === 0) {
      this.shutdownWorkers(job);
      job.status = job.stopKind;
      job.finishedAt = new Date().toISOString();
      await this.publish(job);
    } else this.pump(job);
  }

  async stop(job, reason, exceptId = null) {
    if (job.status !== 'running') return;
    job.status = 'stopping';
    job.stopKind = reason === 'USER_CANCELLED' || reason === 'SERVER_INTERRUPTED' ? 'cancelled' :
      DENIAL.has(reason) ? 'blocked' : 'partial';
    job.stopReason = reason;
    const stoppedAt = new Date().toISOString();
    clearTimeout(this.launchTimer);
    this.launchTimer = null;
    for (const task of job.tasks) {
      if (task.status === 'queued') {
        task.status = 'skipped'; task.finishedAt = stoppedAt;
        task.cause = { code: 'BATCH_STOPPED', detail: reason };
      } else if (task.status === 'running' && task.id !== exceptId) {
        task.status = 'interrupted';
        task.cause = { code: 'BATCH_STOPPED', detail: reason };
        const child = this.children.get(task.id);
        if (child?.pid && !this.persistentWorkers) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
      }
    }
    this.shutdownWorkers(job, exceptId);
    if (this.children.size === 0) {
      job.status = job.stopKind;
      job.finishedAt = stoppedAt;
    }
    await this.publish(job);
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return null;
    await this.stop(job, 'USER_CANCELLED');
    return this.snapshot(job);
  }

  pump(job) {
    if (job.status !== 'running') return;
    const active = job.tasks.filter(task => task.status === 'running').length;
    const next = job.tasks.find(task => task.status === 'queued');
    if (!next && active === 0) {
      this.shutdownWorkers(job);
      job.status = job.tasks.every(task => task.status === 'ok') ? 'complete' : 'partial';
      job.finishedAt = new Date().toISOString();
      void this.publish(job).catch(error => this.emit('error', error));
      return;
    }
    if (!next || active >= job.concurrency || this.launchTimer) return;
    if (active > 0 && this.pacing.state.burstCount >= this.pacing.burstSize) {
      const note = 'Finishing the current searches before the batch rest.';
      if (job.resourceNote !== note) {
        job.resourceNote = note;
        job.nextSearchAt = null;
        void this.publish(job).catch(error => this.emit('error', error));
      }
      return;
    }
    const gate = this.pacing.gate();
    if (job.nextSearchAt !== gate.nextSearchAt) {
      job.nextSearchAt = gate.nextSearchAt;
      if (gate.waitMs) {
        job.resourceNote = gate.reason === 'batch_rest' ?
          `Taking a short rest after ${this.pacing.burstSize} searches. Next search at ${gate.nextSearchAt}.` :
          `Spacing searches to reduce request pressure. Next search at ${gate.nextSearchAt}.`;
        next.events.push({ at: new Date().toISOString(), event: 'search_pacing',
          message: job.resourceNote });
      }
      void this.publish(job).catch(error => this.emit('error', error));
    }
    this.launchTimer = setTimeout(async () => {
      if (job.status !== 'running') { this.launchTimer = null; return; }
      // A worker may have completed while this timer waited. Recheck the
      // completion gap rather than launching on an obsolete deadline.
      if (this.pacing.gate().waitMs) { this.launchTimer = null; this.pump(job); return; }
      const task = job.tasks.find(item => item.status === 'queued');
      const used = new Set(job.tasks.filter(item => item.status === 'running').map(item => item.worker));
      const worker = Array.from({ length: job.concurrency }, (_, index) => index + 1)
        .find(index => !used.has(index));
      if (task && worker) {
        let lease;
        const existing = this.persistentWorkers ? job.sessions.get(worker) : null;
        try { lease = this.browserAdmission && !existing ? await tryBrowserLease() : null; }
        catch (failure) {
          this.launchTimer = null;
          await this.stop(job, 'RESOURCE_ADMISSION_FAILED');
          this.emit('error', failure); return;
        }
        if (this.browserAdmission && !existing && !lease) {
          job.resourceNote = 'Waiting for another airline browser to finish; shared memory protection is active.';
          await this.publish(job);
          this.launchTimer = setTimeout(() => { this.launchTimer = null; this.pump(job); }, 1000);
          return;
        }
        if (job.status !== 'running') { await lease?.release(); this.launchTimer = null; return; }
        if (this.pacing.gate().waitMs) {
          await lease?.release(); this.launchTimer = null; this.pump(job); return;
        }
        try { await this.pacing.started(); }
        catch (failure) {
          await lease?.release(); this.launchTimer = null;
          await this.stop(job, 'PACING_STATE_UNAVAILABLE'); this.emit('error', failure); return;
        }
        if (job.status !== 'running') { await lease?.release(); this.launchTimer = null; return; }
        job.nextSearchAt = null;
        job.resourceNote = 'Shared browser admission is active across the airline collectors.';
        try { this.launch(job, task, worker, lease); }
        catch (failure) { await lease?.release(); this.launchTimer = null; task.status = 'failed'; task.cause = { code: 'WORKER_LAUNCH_FAILED', detail: failure.message }; task.finishedAt = new Date().toISOString(); await this.stop(job, 'WORKER_LAUNCH_FAILED'); this.emit('error', failure); return; }
      }
      this.launchTimer = null;
      this.pump(job);
    }, gate.waitMs);
  }

  async close() {
    if (this.activeJob?.status === 'running') await this.stop(this.activeJob, 'SERVER_INTERRUPTED');
    for (const job of this.jobs.values()) this.shutdownWorkers(job);
  }
}
