export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

export function summarizeLoad(results, elapsedMs) {
  const durations = results.map((result) => result.durationMs);
  const succeeded = results.filter((result) => result.ok).length;
  const statusCounts = {};
  for (const result of results) {
    const key = String(result.status || 'network_error');
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  return {
    requests: results.length,
    succeeded,
    failed: results.length - succeeded,
    errorRate: results.length ? (results.length - succeeded) / results.length : 0,
    requestsPerSecond: elapsedMs > 0 ? results.length / (elapsedMs / 1000) : 0,
    latencyMs: {
      min: durations.length ? Math.min(...durations) : 0,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.length ? Math.max(...durations) : 0,
    },
    statusCounts,
  };
}

export function evaluateLoadGate(summary, thresholds) {
  const failures = [];
  if (summary.requests < thresholds.minRequests) failures.push('MIN_REQUESTS');
  if (summary.errorRate > thresholds.maxErrorRate) failures.push('ERROR_RATE');
  if (summary.latencyMs.p95 > thresholds.maxP95Ms) failures.push('P95_LATENCY');
  return { pass: failures.length === 0, failures };
}
