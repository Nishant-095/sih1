#!/usr/bin/env node
import { ChromeWorker } from '../src/chrome-worker.mjs';

if (!process.send) throw new Error('Persistent Chrome worker requires its local IPC controller');
const send = message => new Promise((resolve, reject) => {
  if (!process.connected) return reject(new Error('Worker controller disconnected'));
  process.send(message, error => error ? reject(error) : resolve());
});
const worker = new ChromeWorker({ profile: process.env.INDIGO_CHROME_PROFILE,
  headless: process.argv.includes('--headless'), proxy: process.env.INDIGO_PROXY_SERVER || null,
  forceHttp1: process.env.INDIGO_CHROME_HTTP1 === '1' });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker.close().catch(() => {});
  if (!worker.busy) process.exit(0);
}
process.on('message', async message => {
  if (message?.type === 'shutdown') { await shutdown(); return; }
  if (message?.type !== 'search' || closing) return;
  const taskId = message.taskId;
  try {
    const result = await worker.run(message.argv,
      record => send({ type: 'event', taskId, record }));
    await send({ type: 'done', taskId, ...result });
  } catch (error) {
    await send({ type: 'error', taskId, code: error.code || 'WORKER_FAILED', detail: error.message }).catch(() => {});
  }
  // On denial, remain unavailable until the controller has saved/verified the
  // result and requests shutdown. Exiting earlier races failure classification.
  if (closing) { await worker.close().catch(() => {}); process.exit(0); }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
process.once('disconnect', shutdown);
await send({ type: 'ready' });
