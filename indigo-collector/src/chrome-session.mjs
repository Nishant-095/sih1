import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { chromeExecutable } from './browser-path.mjs';

async function portReady(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`,
      { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

async function activePort(profile) {
  const launcherPortFile = path.join(profile, '.indigo-cdp-port');
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (const file of [launcherPortFile, portFile]) {
    let port;
    try { port = Number((await fs.readFile(file, 'utf8')).split('\n')[0]); }
    catch { continue; }
    if (await portReady(port)) return port;
  }
  return null;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timeout;
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => { timeout = setTimeout(() => resolve(false), timeoutMs); })
  ]);
  clearTimeout(timeout);
  return exited;
}

export async function openChromeSession({ profile, headless = false, proxy = null,
  forceHttp1 = false, captureNetLog = false }) {
  if (proxy) {
    const parsed = new URL(proxy);
    if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash)
      throw new Error('Chrome proxy must be an HTTP, HTTPS, or SOCKS5 server URL without credentials');
    if (process.env.INDIGO_PROXY_USERNAME || process.env.INDIGO_PROXY_PASSWORD)
      throw new Error('This Chrome session does not support authenticated proxies');
  }
  profile = path.resolve(profile);
  const chromePath = chromeExecutable();
  const portFile = path.join(profile, 'DevToolsActivePort');
  const launcherPortFile = path.join(profile, '.indigo-cdp-port');
  const chromeVersion = headless ? execFileSync(chromePath, ['--version'], { encoding: 'utf8' })
    .match(/\b(\d+)\.\d+\.\d+\.\d+\b/) : null;
  if (headless && !chromeVersion) throw new Error('Could not determine Chrome version for headless browser');
  const headlessUserAgent = headless ? process.env.INDIGO_CHROME_USER_AGENT?.trim() ||
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion[1]}.0.0.0 Safari/537.36` : null;
  await fs.mkdir(profile, { recursive: true });
  const netLogPath = captureNetLog ? path.join(profile,
    `chrome-netlog-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`) : null;
  const active = await activePort(profile);
  let chrome = null;
  if (active) throw new Error('Chrome profile is already running; stop it or choose another INDIGO_CHROME_PROFILE');
  const port = await availablePort();
  {
    await fs.rm(portFile, { force: true });
    await fs.rm(launcherPortFile, { force: true });
    if (netLogPath) fsSync.closeSync(fsSync.openSync(netLogPath, 'wx', 0o600));
    const errorLog = fsSync.openSync(path.join(profile, 'chrome-stderr.log'), 'a', 0o600);
    try {
      chrome = spawn(chromePath, [
        '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        ...(headless ? ['--headless=new', '--window-size=1440,900',
          '--force-device-scale-factor=1'] : []),
        ...(headlessUserAgent ? [`--user-agent=${headlessUserAgent}`] : []),
        ...(netLogPath ? [`--log-net-log=${netLogPath}`, '--net-log-max-size-mb=25',
          '--net-log-duration=300'] : []),
        ...(forceHttp1 ? ['--disable-http2'] : []),
        ...(proxy ? [`--proxy-server=${proxy}`] : []), 'about:blank'
      ], { stdio: ['ignore', 'ignore', errorLog] });
    } finally { fsSync.closeSync(errorLog); }
    let chromeError = null;
    chrome.once('error', error => { chromeError = error; });
    try {
      const deadline = Date.now() + 25000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        if (chromeError) throw chromeError;
        if (chrome.exitCode !== null) throw new Error(`Chrome exited before its debugging port was ready (${chrome.exitCode})`);
        await new Promise(resolve => setTimeout(resolve, 250));
        ready = await portReady(port);
      }
      if (!ready) throw new Error(`Chrome debugging port did not open; inspect ${path.join(profile, 'chrome-stderr.log')}`);
      await fs.writeFile(launcherPortFile, `${port}\n`, { mode: 0o600 });
    } catch (error) {
      if (chrome.exitCode === null) chrome.kill('SIGTERM');
      if (!await waitForExit(chrome, 5000)) chrome.kill('SIGKILL');
      throw error;
    }
  }
  let closed = false;
  return { port, pid: chrome.pid, netLogPath, async close() {
    if (closed) return;
    closed = true;
    // Chrome owns a persistent profile; only close a process this launcher started.
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      if (netLogPath) {
        // Browser.close lets Chrome stitch its NetLog; SIGTERM leaves an .inprogress file.
        try {
          const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
          const session = await browser.newBrowserCDPSession();
          await session.send('Browser.close').catch(() => {});
        } catch { /* Fall back to the owned process below. */ }
        if (!await waitForExit(chrome, 5000)) chrome.kill('SIGTERM');
        if (!await waitForExit(chrome, 5000)) chrome.kill('SIGKILL');
        await fs.chmod(netLogPath, 0o600).catch(() => {});
      } else {
        chrome.kill('SIGTERM');
        if (!await waitForExit(chrome, 5000)) chrome.kill('SIGKILL');
        await waitForExit(chrome, 5000);
      }
    }
    await fs.rm(launcherPortFile, { force: true }).catch(() => {});
  } };
}
