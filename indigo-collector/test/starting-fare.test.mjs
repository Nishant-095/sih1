import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedStartingFare } from '../src/starting-fare.mjs';

test('reads the displayed starting fare from a flight row label', () => {
  assert.equal(displayedStartingFare('Flight Lucknow to Patna, fare starts at ₹4,901'), 4901);
  assert.equal(displayedStartingFare('Flight Delhi to Mumbai, fare starts at ₹24,260'), 24260);
  assert.equal(displayedStartingFare('Flight without a confirmed fare'), null);
});
