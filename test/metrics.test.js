import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { metricsSnapshot, recordHttpRequest, resetMetricsForTest } from '../observability/metrics.js';

test('HTTP metrics calculate errors and bounded latency summaries', () => {
  resetMetricsForTest();
  recordHttpRequest({ route: '/api/me', status: 200, durationMs: 10 });
  recordHttpRequest({ route: '/api/me', status: 503, durationMs: 30 });
  const metrics = metricsSnapshot();
  assert.equal(metrics.http.requests, 2);
  assert.equal(metrics.http.serverErrors, 1);
  assert.equal(metrics.http.serverErrorRate, 0.5);
  assert.equal(metrics.http.averageDurationMs, 20);
  assert.equal(metrics.http.p95DurationMs, 30);
  assert.equal(metrics.http.routes['/api/me'], 2);
});

test('HTTP metrics keep at most 1000 latency samples and normalize UUIDs', () => {
  resetMetricsForTest();
  for (let index = 0; index < 1100; index++) {
    recordHttpRequest({ route: `/jobs/${crypto.randomUUID()}`, status: 200, durationMs: index });
  }
  const metrics = metricsSnapshot();
  assert.equal(metrics.http.requests, 1100);
  assert.equal(metrics.http.latencySampleSize, 1000);
  assert.equal(Object.keys(metrics.http.routes).length, 1);
});
