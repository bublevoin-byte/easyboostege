import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLoadGate, percentile, summarizeLoad } from '../performance/load.js';

test('load percentiles use a nearest-rank calculation', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.equal(percentile([], 0.95), 0);
});

test('load summary and gate expose errors, throughput and latency', () => {
  const summary = summarizeLoad([
    { ok: true, status: 200, durationMs: 10 },
    { ok: true, status: 200, durationMs: 20 },
    { ok: false, status: 503, durationMs: 30 },
  ], 1000);
  assert.equal(summary.requests, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.requestsPerSecond, 3);
  assert.equal(summary.latencyMs.p95, 30);
  assert.deepEqual(summary.statusCounts, { 200: 2, 503: 1 });
  assert.deepEqual(evaluateLoadGate(summary, {
    minRequests: 3, maxErrorRate: 0.5, maxP95Ms: 50,
  }), { pass: true, failures: [] });
  assert.deepEqual(evaluateLoadGate(summary, {
    minRequests: 4, maxErrorRate: 0.1, maxP95Ms: 25,
  }), { pass: false, failures: ['MIN_REQUESTS', 'ERROR_RATE', 'P95_LATENCY'] });
});
