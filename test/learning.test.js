import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/learning.js';
import { subscriptionView } from '../storage/shared.js';

const { calculateProgress, reviewWord } = globalThis.EasyBoostLearning;

test('subscription status is calculated from its expiration time', () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    assert.deepEqual(subscriptionView(null), { sub_until: 0, active: false, trial_used: false });
    assert.equal(subscriptionView({ sub_until: 999_999 }).active, false);
    assert.equal(subscriptionView({ sub_until: 1_000_001, trial_used: 1 }).active, true);
    assert.equal(subscriptionView({ sub_until: 1_000_001, trial_used: 1 }).trial_used, true);
  } finally {
    Date.now = originalNow;
  }
});

test('spaced repetition advances, caps and reschedules successful reviews', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(reviewWord({ s: 0, e: 0, n: 0, due: 0 }, true, now), {
    s: 1, e: 0, n: 1, due: now + 86_400_000,
  });
  assert.deepEqual(reviewWord({ s: 5, e: 2, n: 7, due: 0 }, true, now), {
    s: 5, e: 2, n: 8, due: now + 35 * 86_400_000,
  });
});

test('spaced repetition records errors and schedules an immediate retry', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(reviewWord({ s: 4, e: 1, n: 3, due: now + 1 }, false, now), {
    s: 2, e: 2, n: 4, due: now,
  });
  assert.equal(reviewWord({ s: 0 }, false, now).s, 1);
});

test('progress calculation is rounded and bounded', () => {
  assert.equal(calculateProgress(0, 0), 0);
  assert.equal(calculateProgress(1, 3), 33);
  assert.equal(calculateProgress(3, 3), 100);
  assert.equal(calculateProgress(5, 3), 100);
  assert.equal(calculateProgress(-1, 3), 0);
});
