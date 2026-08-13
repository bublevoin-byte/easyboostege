import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { buildAdaptiveLearningMetrics } from '../adaptive-learning/metrics.js';
import {
  clearAdaptiveOverviewCache,
  readAdaptiveOverviewCache,
  readAdaptiveOverviewCacheSnapshot,
  writeAdaptiveOverviewCache,
} from '../public/adaptive-overview-cache.js';

const METRICS_NOW = new Date('2026-08-04T12:00:00.000Z');

globalThis.window = globalThis.window || {};
const ownerGenerations = new Map();
const deletedOwners = new Set();
globalThis.window.EasyBoostOwnerIncarnation = {
  snapshot(owner) {
    return { ownerGeneration: ownerGenerations.get(owner) || 0, deleted: deletedOwners.has(owner) };
  },
  async withOwnerLock(_owner, action) { return action(Symbol('test-owner-lock')); },
  async clearMatchingStorage(_owner, key, matcher, _token, storage) {
    const raw = storage.getItem(key); if (!raw) return true;
    if (matcher(raw) !== true) return false; storage.removeItem(key); return true;
  },
};

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('overview cache partitions same-name account incarnations by owner generation', async () => {
  ownerGenerations.clear(); deletedOwners.clear();
  const storage = memoryStorage();
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  const oldOverview = overview(); oldOverview.goal = { ...oldOverview.goal, targetScore: 70 };
  const newOverview = overview(); newOverview.goal = { ...newOverview.goal, targetScore: 90 };
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', oldOverview, now, 0), true);
  ownerGenerations.set('learner-one', 1);
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', newOverview, now + 1, 1), true);
  assert.equal(readAdaptiveOverviewCache(storage, 'learner-one', now + 2, 0)?.goal?.targetScore, 70);
  assert.equal(readAdaptiveOverviewCache(storage, 'learner-one', now + 2, 1)?.goal?.targetScore, 90);
});

function overview() {
  return {
    goal: { targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300 },
    profile: { confidence: 42, evidenceCount: 10, needsDiagnostic: false, modules: [] },
    plan: {
      revision: 2,
      forecast: { lowScore: 61, highScore: 73, confidence: 42, requiredWeeklyMinutes: 420 },
      allocation: { modules: [{ id: 'listening', percentage: 35 }] },
    },
    retention: { rediagnostic: { due: false } },
    access: { tier: 'base', capabilities: { adaptivePlan: true }, usage: {}, limits: {} },
    grammarRecommendation: {
      pointer: {
        version: 'grammar-focus-v1', catalogVersion: 'grammar-core-v3', catalogRevision: 3,
        topicId: 3, errorCode: 'word_or_verb_form', confusionPair: null,
        masteryRevision: 2, eligibleAt: null, earlyPractice: false,
        stateFingerprint: 'a'.repeat(64), ref: 'b'.repeat(64),
      },
      reasonCodes: ['recent_weakness'], observedErrorCount: 2, observedAt: 1_000,
    },
    debug: { username: 'must-not-be-cached' },
  };
}

test('offline overview cache is owner-bound, bounded and contains only the public read-only projection', async () => {
  ownerGenerations.clear(); deletedOwners.clear();
  const storage = memoryStorage();
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', overview(), now), true);

  const cached = readAdaptiveOverviewCache(storage, 'learner-one', now + 60_000);
  assert.deepEqual(Object.keys(cached).sort(), ['access', 'goal', 'grammarRecommendation', 'plan', 'profile', 'retention']);
  assert.equal(cached.plan.allocation.modules[0].percentage, 35);
  assert.equal(cached.grammarRecommendation.pointer.errorCode, 'word_or_verb_form');
  assert.equal(JSON.stringify(cached).includes('must-not-be-cached'), false);

  assert.equal(readAdaptiveOverviewCache(storage, 'learner-two', now + 60_000), null);
  assert.deepEqual(readAdaptiveOverviewCache(storage, 'learner-one', now + 60_000), cached,
    'a different tab cannot destroy the owning account cache merely by reading it');
});

test('offline overview cache exposes its saved timestamp without marking the payload fresh', async () => {
  ownerGenerations.clear(); deletedOwners.clear();
  const storage = memoryStorage();
  const savedAt = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', overview(), savedAt), true);

  const snapshot = readAdaptiveOverviewCacheSnapshot(storage, 'learner-one', savedAt + 60_000);
  assert.equal(snapshot.savedAt, savedAt);
  assert.deepEqual(Object.keys(snapshot.payload).sort(), ['access', 'goal', 'grammarRecommendation', 'plan', 'profile', 'retention']);
  assert.equal(Object.hasOwn(snapshot.payload, 'fresh'), false);
});

test('offline overview cache survives stale cleanup from an older same-name incarnation', async () => {
  ownerGenerations.clear(); deletedOwners.clear(); ownerGenerations.set('learner-one', 1);
  const storage = memoryStorage();
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', overview(), now, 1), true);
  assert.equal(readAdaptiveOverviewCache(storage, 'learner-one', now + 1_000, 0), null);
  assert.equal(await clearAdaptiveOverviewCache(storage, { owner: 'learner-one', ownerGeneration: 0 }), true,
    'generation-qualified cleanup has nothing from the old incarnation to remove');
  assert.equal(readAdaptiveOverviewCache(storage, 'learner-one', now + 1_000, 1)?.goal?.targetScore, 85);
  assert.equal(await clearAdaptiveOverviewCache(storage, { owner: 'learner-one', ownerGeneration: 1 }), true);
});

test('offline overview cache expires, rejects oversized snapshots and can be cleared explicitly', async () => {
  ownerGenerations.clear(); deletedOwners.clear();
  const storage = memoryStorage();
  const now = Date.parse('2026-08-04T12:00:00.000Z');
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', overview(), now), true);
  assert.equal(readAdaptiveOverviewCache(storage, 'learner-one', now + 24 * 60 * 60 * 1000), null);
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', overview(), now), true);
  const safeSnapshot = readAdaptiveOverviewCache(storage, 'learner-one', now);

  const huge = overview();
  huge.profile.modules = [{ id: 'grammar', explanation: 'x'.repeat(130_000) }];
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', huge, now), false);
  assert.deepEqual(readAdaptiveOverviewCache(storage, 'learner-one', now), safeSnapshot);

  const partialGoalResponse = {
    goal: overview().goal,
    profile: overview().profile,
    plan: overview().plan,
  };
  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', partialGoalResponse, now), false);
  assert.deepEqual(readAdaptiveOverviewCache(storage, 'learner-one', now), safeSnapshot);

  assert.equal(await writeAdaptiveOverviewCache(storage, 'learner-one', overview(), now), true);
  await clearAdaptiveOverviewCache(storage, { owner: 'learner-one', ownerGeneration: 0 });
  assert.equal(readAdaptiveOverviewCache(storage, 'learner-one', now), null);
});

test('overview cache write removes stale private data when deletion wins before post-write validation', async () => {
  ownerGenerations.clear(); deletedOwners.clear();
  const storage = memoryStorage(); const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    originalSetItem(key, value);
    ownerGenerations.set('learner-one', 1); deletedOwners.add('learner-one');
  };

  assert.equal(await writeAdaptiveOverviewCache(
    storage, 'learner-one', overview(), Date.parse('2026-08-04T12:00:00.000Z'), 0,
  ), false);
  assert.equal(readAdaptiveOverviewCache(
    storage, 'learner-one', Date.parse('2026-08-04T12:00:01.000Z'), 0,
  ), null);
});

test('adaptive metrics are fixed-cardinality, PII-free and preserve honest denominators', () => {
  const metrics = buildAdaptiveLearningMetrics({
    sessions: [
      {
        id: 'session-private-1', username: 'learner-private', status: 'completed',
        duration_minutes: 15, learning_minutes: 15, completed_learning_minutes: 15,
        commercial_scope: 'free_demo', started_at: '2026-08-04T10:00:00.000Z',
        created_at: '2026-08-04T09:59:00.000Z',
        replacement: { reason: 'too_easy' },
        blocks: [{ id: 'block-private-1', launch: { kind: 'voice_tutor_recovery', stage: 'day_1' } }],
      },
      {
        id: 'session-private-2', username: 'other-private', status: 'in_progress',
        duration_minutes: 45, learning_minutes: 45, completed_learning_minutes: 15,
        commercial_scope: 'base', started_at: '2026-08-04T11:00:00.000Z', replacement: null,
        created_at: '2026-08-04T10:59:00.000Z',
        blocks: [],
      },
      {
        id: 'session-private-3', username: 'third-private', status: 'created',
        duration_minutes: 90, learning_minutes: 80, completed_learning_minutes: 0,
        commercial_scope: 'premium', started_at: null,
        created_at: '2026-08-04T11:30:00.000Z',
        replacement: { reason: 'not_relevant' }, blocks: [],
      },
    ],
    events: [
      {
        session_id: 'session-private-1', block_id: 'block-private-1', block_kind: 'learning',
        source_type: 'voice_tutor_repeat', source_ref: 'repeat-attempt-private-1',
        evidence_quality: 'server_verified_unassisted', evidence_context: 'scheduled_review',
        created_at: '2026-08-04T10:06:00.000Z',
      },
      {
        session_id: 'session-private-2', block_id: 'block-private-2', block_kind: 'learning',
        source_type: 'module', source_ref: 'module-attempt-private-1',
        evidence_quality: 'client_reported', evidence_context: 'planned_practice',
        created_at: '2026-08-04T11:16:00.000Z',
      },
    ],
    diagnosticSessions: [
      { catalog_version: 'ege-short-diagnostic-v1', status: 'completed', completed_at: '2026-08-03T12:00:00.000Z' },
      { catalog_version: 'ege-deep-diagnostic-v1', status: 'in_progress', completed_at: null },
    ],
    skillEstimates: [
      { skill_id: 'ege.grammar.forms', uncertainty: 75, status: 'preliminary', updated_at: '2026-08-04T11:00:00.000Z' },
      { skill_id: 'ege.reading.detail', uncertainty: 35, status: 'established', updated_at: '2026-08-04T11:00:00.000Z' },
    ],
    repeatAttempts: [
      { id: 'repeat-attempt-private-1', stage: 'day_1', passed: true },
    ],
  }, { now: METRICS_NOW });

  assert.equal(metrics.version, 'adaptive-metrics-v1');
  assert.deepEqual(metrics.window, {
    days: 90,
    from: '2026-05-06T12:00:00.000Z',
    to: '2026-08-04T12:00:00.000Z',
  });
  assert.deepEqual(metrics.sessions, {
    created: 3,
    started: 2,
    completed: 1,
    startRate: 0.6667,
    completionRate: 0.5,
    plannedLearningMinutes: 140,
    completedPlannedMinutes: 30,
    plannedMinutesCompletionRate: 0.2143,
    byDuration: {
      '15_30': { created: 1, started: 1, completed: 1 },
      '35_60': { created: 1, started: 1, completed: 0 },
      '65_90': { created: 1, started: 0, completed: 0 },
      '95_120': { created: 0, started: 0, completed: 0 },
    },
  });
  assert.equal(metrics.adjustments.rate, 0.6667);
  assert.equal(metrics.adjustments.reasons.too_easy, 1);
  assert.equal(metrics.adjustments.reasons.not_relevant, 1);
  assert.deepEqual(metrics.retention.day_1, { observed: 1, passed: 1, rate: 1 });
  assert.deepEqual(metrics.retention.day_7, { observed: 0, passed: 0, rate: 0 });
  assert.equal(metrics.profile.highImpactHighUncertaintySkills, 1);
  assert.equal(metrics.profile.establishedSkills, 1);
  assert.deepEqual(metrics.commercialScopes, { free_demo: 1, base: 1, premium: 1 });
  assert.deepEqual(metrics.diagnostics, { shortCompleted: 1, deepCompleted: 0 });
  const serialized = JSON.stringify(metrics);
  for (const privateValue of [
    'learner-private', 'session-private-1', 'block-private-1',
    'repeat-attempt-private-1', 'ege.grammar.forms',
  ]) assert.equal(serialized.includes(privateValue), false);
});

test('adaptive metrics exclude old rows and rebuild honestly after deletion or reset', () => {
  const currentFailure = {
    status: 'in_progress', duration_minutes: 15, learning_minutes: 15,
    completed_learning_minutes: 0, commercial_scope: 'base',
    started_at: '2026-08-04T11:00:00.000Z', created_at: '2026-08-04T10:59:00.000Z',
  };
  const oldSuccesses = Array.from({ length: 100 }, (_, index) => ({
    status: 'completed', duration_minutes: 15, learning_minutes: 15,
    completed_learning_minutes: 15, commercial_scope: 'base',
    started_at: '2026-04-01T11:00:00.000Z', created_at: `2026-04-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }));
  const rolling = buildAdaptiveLearningMetrics({ sessions: [...oldSuccesses, currentFailure] }, { now: METRICS_NOW });
  assert.equal(rolling.sessions.created, 1);
  assert.equal(rolling.sessions.started, 1);
  assert.equal(rolling.sessions.completed, 0);
  assert.equal(rolling.sessions.completionRate, 0);

  const afterDeletion = buildAdaptiveLearningMetrics({ sessions: [] }, { now: METRICS_NOW });
  assert.equal(afterDeletion.sessions.created, 0);
  assert.equal(afterDeletion.sessions.startRate, 0);
  assert.equal(afterDeletion.sessions.completionRate, 0);
  assert.equal(afterDeletion.sessions.plannedMinutesCompletionRate, 0);
});

test('PostgreSQL adaptive metrics use bounded fixed-shape aggregates instead of lifetime raw rows', async () => {
  const repository = await fs.readFile(new URL('../storage/postgres-repository.js', import.meta.url), 'utf8');
  const start = repository.indexOf('async function getAdaptiveLearningMetrics');
  const end = repository.indexOf('async function readAdaptiveDiagnostic', start);
  const source = repository.slice(start, end);
  assert.match(source, /COUNT\(\*\) FILTER/iu);
  assert.match(source, /created_at >= \$1 AND .*created_at <= \$2/su);
  assert.match(source, /completed_at >= \$1 AND .*completed_at <= \$2/su);
  assert.match(source, /updated_at >= \$1 AND .*updated_at <= \$2/su);
  assert.doesNotMatch(source, /SELECT id,/iu);
  assert.doesNotMatch(source, /\bblocks\b/iu);
});

test('adaptive operations contract documents rollout, metrics, offline retention and local proof boundaries', async () => {
  const [runbook, monitoring, performance, schema, retention, openapi, evidence, progressEvidence, packageSource] = await Promise.all([
    fs.readFile(new URL('../docs/ADAPTIVE_LEARNING_OPERATIONS.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/MONITORING.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/PERFORMANCE_BASELINE.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATABASE_SCHEMA.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../.scratch/adaptive-learning-plan/evidence/ticket-08-local-release-evidence.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../.scratch/learning-evidence-foundation/evidence/ticket-05-local-release-evidence.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);

  assert.match(runbook, /ADAPTIVE_LEARNING_ENABLED=false/u);
  assert.match(runbook, /031_adaptive_learning_goal_profile\.sql.*039_adaptive_metrics_window_indexes\.sql/su);
  assert.match(runbook, /startRate=started\/created/u);
  assert.match(runbook, /completionRate=completed\/started/u);
  assert.match(runbook, /не более 24 часов и 120 000 символов/u);
  assert.match(runbook, /overview.*остаётся доступен.*сводк/isu);
  assert.match(runbook, /Сохранённая копия.*timestamp/isu);
  assert.match(runbook, /push, merge, миграции.*владельца/su);
  assert.match(monitoring, /adaptive-metrics-v1/u);
  assert.match(performance, /Отрисовка персонального плана.*1500 мс/su);
  assert.match(schema, /REPEATABLE READ/u);
  assert.match(retention, /offline snapshot персонального плана/iu);
  assert.match(retention, /сводк.*timestamp/isu);
  assert.match(openapi, /AdaptiveLearningMetrics:/u);
  assert.match(openapi, /overview remains available when the plan rollout is disabled/iu);
  assert.match(openapi, /required: \[version, window, sessions/u);
  assert.match(openapi, /never contains username, owner\/session\/attempt\/skill identifiers/iu);
  assert.match(evidence, /без push, merge, deploy/u);
  assert.match(evidence, /migrations 001–039/u);
  assert.match(evidence, /не разрешает production/u);
  assert.match(progressEvidence, /ordinary completion.*owner-bound.*overview.*summary/isu);
  assert.match(progressEvidence, /без push, deploy|no push or deploy/iu);
  assert.match(packageSource, /"test:e2e:progress"/u);
});
