import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function redactUrl(raw) {
  try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
  catch { return '[invalid-url]'; }
}

export async function capturePageEvidence(page, dir, label) {
  const errors = [];
  let html = null, screenshot = null, htmlSha256 = null, screenshotSha256 = null;
  try {
    const content = await page.content();
    html = `${label}.html`;
    await fs.writeFile(path.join(dir, html), content, { mode: 0o600 });
    htmlSha256 = sha256(content);
  } catch (error) {
    errors.push({ part: 'html', error: `${error.name}: ${error.message.split('\n')[0]}`.slice(0, 300) });
  }
  try {
    screenshot = `${label}.png`;
    const image = await page.screenshot({ path: path.join(dir, screenshot),
      fullPage: label.startsWith('results-attempt-'), timeout: 15000 });
    screenshotSha256 = sha256(image);
  } catch (error) {
    screenshot = null;
    errors.push({ part: 'screenshot', error: `${error.name}: ${error.message.split('\n')[0]}`.slice(0, 300) });
  }
  let captureErrorFile = null, captureErrorSha256 = null;
  if (errors.length) {
    captureErrorFile = `${label}-capture-error.json`;
    const content = JSON.stringify(errors, null, 2) + '\n';
    await fs.writeFile(path.join(dir, captureErrorFile), content, { mode: 0o600 });
    captureErrorSha256 = sha256(content);
  }
  return { url: redactUrl(page.url()), html, screenshot, htmlSha256, screenshotSha256,
    captureErrorFile, captureErrorSha256, capturedAt: new Date().toISOString() };
}
