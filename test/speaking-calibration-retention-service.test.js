import assert from 'node:assert/strict';
import test from 'node:test';

import { createSpeakingCalibrationRetentionService } from '../speaking/calibration-retention-service.js';

const HOUR_MS = 60 * 60 * 1000;

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('calibration retention service owns its hourly lifecycle and immediate purge', async () => {
  const instant = new Date('2026-08-08T08:00:00.000Z');
  const purges = [];
  const info = [];
  const scheduled = [];
  const cleared = [];
  const timer = {
    unrefCalls: 0,
    unref() { this.unrefCalls += 1; },
  };
  const service = createSpeakingCalibrationRetentionService({
    purgeExpiredSamples: async (input) => {
      purges.push(input);
      return { deletedAudio: purges.length === 1 ? 2 : 0 };
    },
    now: () => instant,
    logger: {
      info: (entry) => info.push(entry),
      error: () => assert.fail('successful retention must not log an error'),
    },
    setIntervalFn: (callback, intervalMs) => {
      scheduled.push({ callback, intervalMs });
      return timer;
    },
    clearIntervalFn: (value) => cleared.push(value),
  });

  service.start();
  service.start();
  await flushMicrotasks();

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].intervalMs, HOUR_MS);
  assert.equal(timer.unrefCalls, 1);
  assert.deepEqual(purges, [{ now: instant }]);
  assert.deepEqual(info, [{
    timestamp: instant.toISOString(),
    level: 'info',
    type: 'speaking_calibration_retention',
    deletedAudio: 2,
  }]);

  scheduled[0].callback();
  await flushMicrotasks();
  assert.equal(purges.length, 2);
  assert.equal(info.length, 1, 'a zero-deletion pass stays quiet');

  service.stop();
  service.stop();
  assert.deepEqual(cleared, [timer]);
});

test('calibration retention service contains failures and emits only a bounded error code', async () => {
  const instant = new Date('2026-08-08T09:00:00.000Z');
  const errors = [];
  const service = createSpeakingCalibrationRetentionService({
    purgeExpiredSamples: async () => {
      const error = new Error('do not leak connection details');
      error.code = 'PG_UNAVAILABLE';
      throw error;
    },
    now: () => instant,
    logger: {
      info: () => assert.fail('failed retention must not log success'),
      error: (entry) => errors.push(entry),
    },
  });

  assert.equal(await service.runOnce(), null);
  assert.deepEqual(errors, [{
    timestamp: instant.toISOString(),
    level: 'error',
    type: 'speaking_calibration_retention_failed',
    errorCode: 'PG_UNAVAILABLE',
  }]);
  assert.doesNotMatch(JSON.stringify(errors), /connection details/iu);
});
