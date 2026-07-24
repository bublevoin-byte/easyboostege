import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAlerts } from '../observability/alerts.js';

test('alerts detect unavailable app and suppress unrelated recovery checks', () => {
  assert.deepEqual(evaluateAlerts({ healthOk: false }), {
    application_unavailable: '🔴 Easy Boost недоступен: readiness не отвечает.',
  });
});

test('alerts detect operational thresholds without personal data', () => {
  const alerts = evaluateAlerts({
    healthOk: true,
    metrics: {
      http: { requests: 100, serverErrors: 20, serverErrorRate: 0.2, p95DurationMs: 5000 },
      dependencies: { database: { lastOutcome: 'error' }, ai: { consecutiveErrors: 2 } },
      aiUsage: { requests: 1000 },
      system: {
        disk: { usedPercent: 85 },
        backup: { fresh: false, file: null },
        restoreCheck: { fresh: false, status: 'failed' },
      },
    },
  });
  assert.deepEqual(Object.keys(alerts).sort(), [
    'ai_budget', 'ai_unavailable', 'api_latency', 'backup_stale',
    'dependency_database', 'disk_full', 'http_5xx', 'restore_check_failed',
  ]);
});

test('healthy metrics produce no alerts', () => {
  assert.deepEqual(evaluateAlerts({
    healthOk: true,
    metrics: {
      http: { requests: 100, serverErrors: 0, serverErrorRate: 0, p95DurationMs: 100 },
      dependencies: {},
      aiUsage: { requests: 5 },
      system: {
        disk: { usedPercent: 20 },
        backup: { fresh: true },
        restoreCheck: { fresh: true, status: 'success' },
      },
    },
  }), {});
});
