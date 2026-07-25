import { performance } from 'node:perf_hooks';
import { evaluateLoadGate, summarizeLoad } from '../performance/load.js';

function readNumber(name, fallback, { min, max }) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

const baseUrl = new URL(process.env.LOAD_TEST_URL || 'http://127.0.0.1:3001');
if (baseUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname)) {
  throw new Error('LOAD_TEST_URL must use HTTPS unless it targets loopback');
}
const concurrency = readNumber('LOAD_TEST_CONCURRENCY', 10, { min: 1, max: 50 });
const targetRequestsPerSecond = readNumber('LOAD_TEST_RPS', 50, { min: 1, max: 200 });
const durationSeconds = readNumber('LOAD_TEST_DURATION_SECONDS', 30, { min: 5, max: 300 });
const timeoutMs = readNumber('LOAD_TEST_TIMEOUT_MS', 5000, { min: 500, max: 30_000 });
const thresholds = {
  minRequests: readNumber('LOAD_TEST_MIN_REQUESTS', 100, { min: 1, max: 1_000_000 }),
  maxErrorRate: readNumber('LOAD_TEST_MAX_ERROR_RATE', 0.01, { min: 0, max: 1 }),
  maxP95Ms: readNumber('LOAD_TEST_MAX_P95_MS', 500, { min: 1, max: 60_000 }),
};
const paths = ['/health/live', '/health/ready', '/manifest.webmanifest'];
const deadline = performance.now() + durationSeconds * 1000;
const results = [];
let cursor = 0;

async function worker() {
  while (performance.now() < deadline) {
    const iterationStarted = performance.now();
    const path = paths[cursor++ % paths.length];
    const started = performance.now();
    try {
      const response = await fetch(new URL(path, baseUrl), {
        headers: { 'User-Agent': 'EasyBoost-Staging-Load-Smoke/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.arrayBuffer();
      results.push({ ok: response.ok, status: response.status, durationMs: performance.now() - started });
    } catch {
      results.push({ ok: false, status: 0, durationMs: performance.now() - started });
    }
    const workerIntervalMs = (1000 * concurrency) / targetRequestsPerSecond;
    const remainingDelayMs = workerIntervalMs - (performance.now() - iterationStarted);
    if (remainingDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingDelayMs));
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const summary = summarizeLoad(results, performance.now() - started);
const gate = evaluateLoadGate(summary, thresholds);
console.log(JSON.stringify({
  target: baseUrl.origin,
  concurrency,
  targetRequestsPerSecond,
  durationSeconds,
  summary,
  thresholds,
  gate,
}, null, 2));
if (!gate.pass) process.exitCode = 1;
