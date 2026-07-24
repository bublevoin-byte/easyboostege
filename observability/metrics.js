const MAX_LATENCY_SAMPLES = 1000;
const startedAt = Date.now();
let requestCount = 0;
let serverErrorCount = 0;
let totalDurationMs = 0;
const latencySamples = [];
const statusCounts = new Map();
const routeCounts = new Map();
const dependencyCounts = new Map();
const allowedDependencies = new Set(['database', 'telegram', 'ai', 'stt', 'tts']);
const allowedOutcomes = new Set(['success', 'error', 'fallback']);

function boundedRoute(route) {
  const value = String(route || 'unknown').slice(0, 160);
  return value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ':id');
}

export function recordHttpRequest({ route, status, durationMs }) {
  const safeStatus = Number.isInteger(status) ? status : 0;
  const safeDuration = Math.max(0, Math.min(Number(durationMs) || 0, 3_600_000));
  requestCount += 1;
  if (safeStatus >= 500) serverErrorCount += 1;
  totalDurationMs += safeDuration;
  latencySamples.push(safeDuration);
  if (latencySamples.length > MAX_LATENCY_SAMPLES) latencySamples.shift();
  statusCounts.set(String(safeStatus), (statusCounts.get(String(safeStatus)) || 0) + 1);
  const key = boundedRoute(route);
  routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
}

export function recordDependencyEvent(dependency, outcome) {
  if (!allowedDependencies.has(dependency) || !allowedOutcomes.has(outcome)) return false;
  const current = dependencyCounts.get(dependency) || {
    success: 0, error: 0, fallback: 0, consecutiveErrors: 0, lastOutcome: null, lastEventAt: null,
  };
  current[outcome] += 1;
  if (outcome === 'error') current.consecutiveErrors += 1;
  if (outcome === 'success') current.consecutiveErrors = 0;
  current.lastOutcome = outcome;
  current.lastEventAt = new Date().toISOString();
  dependencyCounts.set(dependency, current);
  return true;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function metricsSnapshot(now = Date.now()) {
  return {
    generatedAt: new Date(now).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
    http: {
      requests: requestCount,
      serverErrors: serverErrorCount,
      serverErrorRate: requestCount ? serverErrorCount / requestCount : 0,
      averageDurationMs: requestCount ? Math.round((totalDurationMs / requestCount) * 100) / 100 : 0,
      p95DurationMs: percentile(latencySamples, 0.95),
      latencySampleSize: latencySamples.length,
      statuses: Object.fromEntries(statusCounts),
      routes: Object.fromEntries(routeCounts),
    },
    dependencies: Object.fromEntries(dependencyCounts),
  };
}

export function resetMetricsForTest() {
  requestCount = 0;
  serverErrorCount = 0;
  totalDurationMs = 0;
  latencySamples.length = 0;
  statusCounts.clear();
  routeCounts.clear();
  dependencyCounts.clear();
}
