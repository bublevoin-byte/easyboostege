import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAlerts } from '../observability/alerts.js';
import { buildAdaptiveLearningMetrics } from '../adaptive-learning/metrics.js';

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
      adaptiveLearning: {
        sessions: {
          created: 30, started: 10, completed: 3,
          startRate: 0.3333, completionRate: 0.3, plannedMinutesCompletionRate: 0.2,
        },
        retention: { day_7: { observed: 10, passed: 3, rate: 0.3 } },
      },
      system: {
        disk: { usedPercent: 85 },
        backup: { fresh: false, file: null },
        restoreCheck: { fresh: false, status: 'failed' },
      },
    },
  });
  assert.deepEqual(Object.keys(alerts).sort(), [
    'adaptive_completion', 'adaptive_day_7_retention', 'adaptive_planned_minutes',
    'adaptive_start', 'ai_budget', 'ai_unavailable', 'api_latency', 'backup_stale',
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
      adaptiveLearning: {
        sessions: {
          created: 30, started: 25, completed: 20,
          startRate: 0.8333, completionRate: 0.8, plannedMinutesCompletionRate: 0.75,
        },
        retention: { day_7: { observed: 10, passed: 8, rate: 0.8 } },
      },
      system: {
        disk: { usedPercent: 20 },
        backup: { fresh: true },
        restoreCheck: { fresh: true, status: 'success' },
      },
    },
  }), {});
});

test('adaptive alerts see a recent regression instead of lifetime success dilution', () => {
  const now = new Date('2026-08-04T12:00:00.000Z');
  const sessions = [
    ...Array.from({ length: 100 }, () => ({
      status: 'completed', duration_minutes: 15, learning_minutes: 15,
      completed_learning_minutes: 15, commercial_scope: 'base',
      created_at: '2026-04-01T10:00:00.000Z', started_at: '2026-04-01T10:01:00.000Z',
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      status: 'in_progress', duration_minutes: 15, learning_minutes: 15,
      completed_learning_minutes: 0, commercial_scope: 'base',
      created_at: `2026-08-04T10:${String(index).padStart(2, '0')}:00.000Z`,
      started_at: `2026-08-04T10:${String(index).padStart(2, '0')}:30.000Z`,
    })),
  ];
  const adaptiveLearning = buildAdaptiveLearningMetrics({ sessions }, { now });
  const alerts = evaluateAlerts({
    healthOk: true,
    metrics: {
      http: {}, dependencies: {}, aiUsage: {}, adaptiveLearning,
      system: {
        disk: { usedPercent: 1 }, backup: { fresh: true },
        restoreCheck: { fresh: true, status: 'success' },
      },
    },
  });
  assert.equal(adaptiveLearning.sessions.created, 20);
  assert.equal(adaptiveLearning.sessions.completionRate, 0);
  assert.match(alerts.adaptive_completion, /0\.0%/u);
  assert.match(alerts.adaptive_planned_minutes, /0\.0%/u);
});
