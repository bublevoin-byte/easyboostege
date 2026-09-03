import { EGE_SKILL_TAXONOMY } from './profile.js';

export const ADAPTIVE_METRICS_VERSION = 'adaptive-metrics-v1';
export const ADAPTIVE_METRICS_WINDOW_DAYS = 90;

const DURATION_BUCKETS = Object.freeze([
  ['15_30', 15, 30],
  ['35_60', 35, 60],
  ['65_90', 65, 90],
  ['95_120', 95, 120],
]);
const COMMERCIAL_SCOPES = Object.freeze(['free_demo', 'base', 'premium']);
const ADJUSTMENT_REASONS = Object.freeze([
  'too_difficult', 'too_easy', 'not_relevant', 'accessibility', 'excluded',
]);
const EVIDENCE_QUALITIES = Object.freeze([
  'client_reported', 'server_verified_assisted', 'server_verified_unassisted',
]);
const EVIDENCE_CONTEXTS = Object.freeze([
  'exam_practice', 'planned_practice', 'scheduled_review', 'ai_assisted_review',
]);
export const ADAPTIVE_METRICS_HIGH_IMPACT_SKILLS = Object.freeze(EGE_SKILL_TAXONOMY.skills
  .filter((skill) => Number(skill.egeWeight) >= 1)
  .map((skill) => skill.id));
const HIGH_IMPACT_SKILLS = new Set(ADAPTIVE_METRICS_HIGH_IMPACT_SKILLS);

function fixedCounters(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function nonNegative(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function field(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

function durationBucket(minutes) {
  return DURATION_BUCKETS.find(([, minimum, maximum]) => (
    minutes >= minimum && minutes <= maximum
  ))?.[0] || null;
}

function retentionCounter() {
  return { observed: 0, passed: 0 };
}

function date(value) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('ADAPTIVE_METRICS_TIME_INVALID');
  return parsed;
}

export function adaptiveMetricsWindow(now = new Date()) {
  const to = date(now);
  const from = new Date(to.getTime() - ADAPTIVE_METRICS_WINDOW_DAYS * 24 * 60 * 60_000);
  return {
    days: ADAPTIVE_METRICS_WINDOW_DAYS,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function insideWindow(row, camel, snake, window) {
  const value = field(row, camel, snake);
  if (value == null) return false;
  const instant = new Date(value).getTime();
  return Number.isFinite(instant)
    && instant >= Date.parse(window.from)
    && instant <= Date.parse(window.to);
}

export function emptyAdaptiveLearningMetricCounters() {
  return {
    sessions: {
      created: 0,
      started: 0,
      completed: 0,
      plannedLearningMinutes: 0,
      completedPlannedMinutes: 0,
      byDuration: Object.fromEntries(DURATION_BUCKETS.map(([name]) => [name, {
        created: 0, started: 0, completed: 0,
      }])),
    },
    adjustments: { sessions: 0, reasons: fixedCounters(ADJUSTMENT_REASONS) },
    evidence: {
      learningBlockCompletions: 0,
      byQuality: fixedCounters(EVIDENCE_QUALITIES),
      byContext: fixedCounters(EVIDENCE_CONTEXTS),
    },
    retention: { observed: 0, passed: 0, day_1: retentionCounter(), day_7: retentionCounter() },
    diagnostics: { shortCompleted: 0, deepCompleted: 0 },
    commercialScopes: fixedCounters(COMMERCIAL_SCOPES),
    profile: { skillEstimates: 0, highImpactHighUncertaintySkills: 0, establishedSkills: 0 },
  };
}

export function finalizeAdaptiveLearningMetrics(counters, { window = adaptiveMetricsWindow() } = {}) {
  const sessions = counters.sessions;
  const retention = counters.retention;
  return {
    version: ADAPTIVE_METRICS_VERSION,
    window: { ...window },
    sessions: {
      ...sessions,
      startRate: rate(sessions.started, sessions.created),
      completionRate: rate(sessions.completed, sessions.started),
      plannedMinutesCompletionRate: rate(
        sessions.completedPlannedMinutes,
        sessions.plannedLearningMinutes,
      ),
    },
    adjustments: {
      ...counters.adjustments,
      rate: rate(counters.adjustments.sessions, sessions.created),
    },
    evidence: counters.evidence,
    retention: {
      observed: retention.observed,
      passed: retention.passed,
      rate: rate(retention.passed, retention.observed),
      day_1: {
        ...retention.day_1,
        rate: rate(retention.day_1.passed, retention.day_1.observed),
      },
      day_7: {
        ...retention.day_7,
        rate: rate(retention.day_7.passed, retention.day_7.observed),
      },
    },
    diagnostics: counters.diagnostics,
    commercialScopes: counters.commercialScopes,
    profile: counters.profile,
  };
}

export function buildAdaptiveLearningMetrics({
  sessions = [],
  events = [],
  diagnosticSessions = [],
  skillEstimates = [],
  repeatAttempts = [],
} = {}, { now = new Date() } = {}) {
  const window = adaptiveMetricsWindow(now);
  const counters = emptyAdaptiveLearningMetricCounters();

  for (const session of (Array.isArray(sessions) ? sessions : [])
    .filter((row) => insideWindow(row, 'createdAt', 'created_at', window))) {
    const status = String(field(session, 'status', 'status') || '');
    const hasStarted = field(session, 'startedAt', 'started_at') != null
      || ['in_progress', 'completed', 'abandoned'].includes(status);
    const isCompleted = status === 'completed';
    const duration = nonNegative(field(session, 'durationMinutes', 'duration_minutes'));
    const bucket = durationBucket(duration);
    counters.sessions.created += 1;
    if (hasStarted) counters.sessions.started += 1;
    if (isCompleted) counters.sessions.completed += 1;
    if (bucket) {
      counters.sessions.byDuration[bucket].created += 1;
      if (hasStarted) counters.sessions.byDuration[bucket].started += 1;
      if (isCompleted) counters.sessions.byDuration[bucket].completed += 1;
    }
    const planned = nonNegative(field(session, 'learningMinutes', 'learning_minutes'));
    counters.sessions.plannedLearningMinutes += planned;
    counters.sessions.completedPlannedMinutes += Math.min(
      planned,
      nonNegative(field(session, 'completedLearningMinutes', 'completed_learning_minutes')),
    );
    const rawScope = String(field(session, 'commercialScope', 'commercial_scope') || 'base');
    counters.commercialScopes[COMMERCIAL_SCOPES.includes(rawScope) ? rawScope : 'base'] += 1;
    const reason = String(session?.replacement?.reason || '');
    if (ADJUSTMENT_REASONS.includes(reason)) {
      counters.adjustments.sessions += 1;
      counters.adjustments.reasons[reason] += 1;
    }
  }

  const attempts = new Map((Array.isArray(repeatAttempts) ? repeatAttempts : []).map((attempt) => [
    String(attempt?.id || ''),
    { stage: String(attempt?.stage || ''), passed: attempt?.passed === true },
  ]));
  for (const event of (Array.isArray(events) ? events : [])
    .filter((row) => insideWindow(row, 'createdAt', 'created_at', window))) {
    if (field(event, 'blockKind', 'block_kind') !== 'learning') continue;
    counters.evidence.learningBlockCompletions += 1;
    const quality = String(field(event, 'evidenceQuality', 'evidence_quality') || '');
    const context = String(field(event, 'evidenceContext', 'evidence_context') || '');
    if (EVIDENCE_QUALITIES.includes(quality)) counters.evidence.byQuality[quality] += 1;
    if (EVIDENCE_CONTEXTS.includes(context)) counters.evidence.byContext[context] += 1;
    if (field(event, 'sourceType', 'source_type') !== 'voice_tutor_repeat') continue;
    const attempt = attempts.get(String(field(event, 'sourceRef', 'source_ref') || ''));
    if (!attempt || !['day_1', 'day_7'].includes(attempt.stage)) continue;
    counters.retention.observed += 1;
    counters.retention[attempt.stage].observed += 1;
    if (attempt.passed) {
      counters.retention.passed += 1;
      counters.retention[attempt.stage].passed += 1;
    }
  }

  for (const estimate of (Array.isArray(skillEstimates) ? skillEstimates : [])
    .filter((row) => insideWindow(row, 'updatedAt', 'updated_at', window))) {
    counters.profile.skillEstimates += 1;
    const skillId = String(field(estimate, 'skillId', 'skill_id') || '');
    const uncertainty = nonNegative(field(estimate, 'uncertainty', 'uncertainty'));
    if (HIGH_IMPACT_SKILLS.has(skillId) && uncertainty >= 70) {
      counters.profile.highImpactHighUncertaintySkills += 1;
    }
    if (field(estimate, 'status', 'status') === 'established') counters.profile.establishedSkills += 1;
  }

  for (const diagnostic of (Array.isArray(diagnosticSessions) ? diagnosticSessions : [])
    .filter((row) => insideWindow(row, 'completedAt', 'completed_at', window))) {
    if (field(diagnostic, 'status', 'status') !== 'completed') continue;
    const version = String(field(diagnostic, 'catalogVersion', 'catalog_version') || '');
    if (['ege-short-diagnostic-v1', 'ege-short-diagnostic-v2'].includes(version)) {
      counters.diagnostics.shortCompleted += 1;
    }
    if (['ege-deep-diagnostic-v1', 'ege-deep-diagnostic-v2'].includes(version)) {
      counters.diagnostics.deepCompleted += 1;
    }
  }

  return finalizeAdaptiveLearningMetrics(counters, { window });
}
