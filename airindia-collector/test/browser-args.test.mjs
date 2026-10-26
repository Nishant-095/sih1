import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/collect.mjs';

const search = ['--search', 'DEL:BOM:2026-10-03'];

test('Firefox uses a separate browser engine and cannot enter Chrome CDP mode', () => {
  assert.equal(parseArgs(search).browser, 'chrome');
  assert.equal(parseArgs([...search, '--browser', 'firefox', '--headed']).browser, 'firefox');
  assert.throws(() => parseArgs([...search, '--browser', 'firefox', '--headed', '--external-chrome']),
    /requires --headed --browser chrome/);
  assert.throws(() => parseArgs([...search, '--browser', 'unknown']), /--browser must be/);
  assert.throws(() => parseArgs([...search, '--local-captcha-solver']),
    /requires --external-chrome/);
  assert.equal(parseArgs([...search, '--headed', '--external-chrome', '--local-captcha-solver'])
    .localCaptchaSolver, true);
  assert.equal(parseArgs([...search, '--headed', '--external-chrome', '--audio-captcha-solver'])
    .audioCaptchaSolver, true);
  assert.throws(() => parseArgs([...search, '--headed', '--external-chrome',
    '--audio-captcha-solver', '--local-captcha-solver']), /cannot combine/);
});
