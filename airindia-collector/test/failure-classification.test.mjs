import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/collect.mjs';

test('saved CAPTCHA cause keeps the local solver outcome', () => {
  const error = Object.assign(new Error('Access check remained open after local helper: audio_unrecognized (Audio challenge could not be transcribed)'),
    { code: 'CAPTCHA' });
  assert.deepEqual(classifyFailure(error, [], 'Please check the box below'), {
    code: 'CAPTCHA', detail: error.message
  });
});

test('a different visible access denial takes priority over an older solver error', () => {
  const error = Object.assign(new Error('Audio challenge could not be transcribed'),
    { code: 'CAPTCHA' });
  assert.equal(classifyFailure(error, [], 'Access Denied').code, 'ACCESS_DENIED');
});
