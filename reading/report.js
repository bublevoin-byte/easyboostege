import { z } from 'zod';

import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';

export const READING_REPORT_MAX_ROWS = 120;
const REPORT_VERSION = 'reading-report-v1';
const SETS = [...READING_TASK10_SETS, ...READING_TASK11_SETS, ...READING_TASK12_18_SETS];
const SET_BY_ID = new Map(SETS.map((set) => [set.id, set]));
const SKILLS = Object.freeze({
  gist: { id: 'ege.reading.gist', label: 'Основное содержание' },
  detail: { id: 'ege.reading.detail', label: 'Детальное понимание' },
});
const EXPECTED = Object.freeze({
  task10: { activity: 'reading_headings', mode: 'reading_headings', slice: 'gist', maxScore: 7 },
  task11: { activity: 'reading_gaps', mode: 'reading_gaps', slice: 'detail', maxScore: 6 },
  task12_18: { activity: 'reading_detail', mode: 'reading_detail', slice: 'detail', maxScore: 7 },
});
const CEFR_ORDER = new Map([['B1', 0], ['B2', 1], ['B2+/C1', 2]]);
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,179}$/u;
const FULL_ATTEMPT_ID = /^reading-full-[A-Za-z0-9-]{8,160}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const confidenceSchema = z.enum(['insufficient', 'low', 'medium', 'high']);
const aggregateSchema = z.object({
  correct: z.number().int().nonnegative(), total: z.number().int().positive(),
  percent: z.number().int().min(0).max(100), sampleSize: z.number().int().positive(),
}).strict();
const trendSchema = z.object({
  state: z.enum(['up', 'down', 'steady', 'insufficient_evidence']),
  confidence: confidenceSchema, recentSampleSize: z.number().int().nonnegative(),
  previousSampleSize: z.number().int().nonnegative(), deltaPercentagePoints: z.number().nullable(),
}).strict();
const skillSchema = z.object({
  id: z.enum(['ege.reading.gist', 'ege.reading.detail']), label: z.string(),
  correct: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100).nullable(), sampleSize: z.number().int().nonnegative(),
  confidence: confidenceSchema,
}).strict();

export const readingReportResponseSchema = z.object({
  version: z.literal(REPORT_VERSION), scope: z.enum(['base', 'expanded']), generatedAt: z.iso.datetime(),
  evidence: z.object({
    source: z.literal('persisted_canonical_completed_attempts'),
    maximumRows: z.literal(READING_REPORT_MAX_ROWS), includedRows: z.number().int().nonnegative(),
    includedAttempts: z.number().int().nonnegative(), independentAttempts: z.number().int().nonnegative(),
    assistedAttempts: z.number().int().nonnegative(), excludedRows: z.number().int().nonnegative(),
  }).strict(),
  base: z.object({
    accuracy: aggregateSchema.nullable(), recentTrend: trendSchema,
    weakestSkill: skillSchema.nullable(),
    recentAttempts: z.array(z.object({
      completedAt: z.iso.datetime(), kind: z.enum(['task10', 'task11', 'task12_18', 'full']),
      label: z.string(), score: z.number().int().nonnegative(), maxScore: z.number().int().positive(),
      accuracyPercent: z.number().int().min(0).max(100), durationMinutes: z.number().nonnegative(),
      independent: z.boolean(),
    }).strict()).max(6),
    recommendation: z.object({ code: z.string(), text: z.string(), sampleSize: z.number().int().nonnegative() }).strict(),
  }).strict(),
  expanded: z.object({
    skills: z.array(skillSchema).length(2),
    topics: z.array(z.object({
      topic: z.string(), correct: z.number().int().nonnegative(), total: z.number().int().positive(),
      percent: z.number().int().min(0).max(100), sampleSize: z.number().int().positive(), confidence: confidenceSchema,
    }).strict()),
    cefr: z.array(z.object({
      cefr: z.enum(['B1', 'B2', 'B2+/C1']), correct: z.number().int().nonnegative(),
      total: z.number().int().positive(), percent: z.number().int().min(0).max(100),
      sampleSize: z.number().int().positive(), confidence: confidenceSchema,
    }).strict()),
    pace: z.object({
      state: z.enum(['available', 'insufficient_evidence']), confidence: confidenceSchema,
      sampleSize: z.number().int().nonnegative(), averageSecondsPerField: z.number().nullable(),
      fullSectionSampleSize: z.number().int().nonnegative(), fullSectionAverageMinutes: z.number().nullable(),
      fipiRecommendedMinutes: z.literal(30), forcedCutoff: z.literal(false),
    }).strict(),
    repeatErrors: z.object({
      state: z.enum(['available', 'insufficient_evidence']), confidence: confidenceSchema,
      sampleSize: z.number().int().nonnegative(),
      sets: z.array(z.object({
        setId: z.string(), title: z.string(), kind: z.enum(['task10', 'task11', 'task12_18']),
        topic: z.string(), sampleSize: z.number().int().positive(), errorAttempts: z.number().int().positive(),
        accuracyPercent: z.number().int().min(0).max(100), confidence: confidenceSchema,
      }).strict()),
    }).strict(),
    comparison: z.object({
      state: z.enum(['available', 'insufficient_evidence']), confidence: confidenceSchema,
      recentSampleSize: z.number().int().nonnegative(), previousSampleSize: z.number().int().nonnegative(),
      recentAccuracyPercent: z.number().nullable(), previousAccuracyPercent: z.number().nullable(),
      deltaPercentagePoints: z.number().nullable(),
    }).strict(),
    recommendation: z.object({
      text: z.string(), confidence: confidenceSchema, sampleSize: z.number().int().nonnegative(),
      timeAllocation: z.array(z.object({
        skillId: z.enum(['ege.reading.gist', 'ege.reading.detail']), label: z.string(),
        minutesPer30: z.number().int().min(0).max(30),
      }).strict()),
    }).strict(),
    disclosure: z.string(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.scope === 'expanded') !== Boolean(value.expanded)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['expanded'], message: 'scope and expanded payload disagree' });
  }
});

function percent(correct, total) {
  return total > 0 ? Math.round(correct / total * 100) : null;
}

function confidence(sampleSize) {
  if (sampleSize < 2) return 'insufficient';
  if (sampleSize < 5) return 'low';
  if (sampleSize < 10) return 'medium';
  return 'high';
}

function isoInstant(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function canonicalSingleRow(row, metadata) {
  const set = SET_BY_ID.get(String(metadata.readingSetId || ''));
  const expected = EXPECTED[metadata.readingKind];
  if (!set || !expected || set.kind !== metadata.readingKind || set.revision !== metadata.readingSetRevision
    || set.cefr !== metadata.readingCefr || row.activity !== expected.activity || metadata.mode !== expected.mode
    || metadata.readingSlice !== expected.slice || Number(row.max_score) !== expected.maxScore
    || metadata.readingContentRef !== `builtin:reading:${set.kind}:${set.cefr === 'B1' ? 'b1' : set.cefr === 'B2' ? 'b2' : 'b2-plus-c1'}:v1`) {
    return null;
  }
  return { type: 'single', set, skill: expected.slice, kind: set.kind };
}

function canonicalFullDetailRow(row, metadata) {
  if (row.activity !== 'reading_detail' || metadata.mode !== 'reading_detail'
    || metadata.readingKind !== 'full_detail' || metadata.readingCefr !== 'mixed'
    || metadata.readingSlice !== 'detail' || metadata.readingContentRef !== 'builtin:reading:full:detail:v1'
    || Number(row.max_score) !== 13 || !FULL_ATTEMPT_ID.test(String(metadata.readingAttemptId || ''))) return null;
  const references = String(metadata.readingSetRefs || '').split('|');
  if (references.length !== 2) return null;
  const sets = references.map((reference) => {
    const match = /^(reading-pilot-v1\.(?:task11|task12_18)\.[a-z0-9-]+)@([1-9][0-9]{0,3})$/u.exec(reference);
    const set = SET_BY_ID.get(match?.[1]);
    return set && set.revision === Number(match?.[2]) ? set : null;
  });
  if (!sets[0] || !sets[1] || sets[0].kind !== 'task11' || sets[1].kind !== 'task12_18') return null;
  return { type: 'full_detail', sets, skill: 'detail', kind: 'full_detail' };
}

function canonicalRow(row) {
  const metadata = row?.metadata;
  const createdAt = isoInstant(row?.created_at);
  const score = Number(row?.score);
  const maximum = Number(row?.max_score);
  const durationMs = Number(row?.duration_ms);
  if (!row || !UUID.test(String(row.id || '')) || row.module !== 'reading' || !createdAt
    || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || metadata.readingProvenance !== 'canonical' || metadata.source !== 'catalog'
    || !SAFE_ATTEMPT_ID.test(String(metadata.readingAttemptId || ''))
    || !Number.isInteger(score) || !Number.isInteger(maximum) || score < 0 || maximum < 1 || score > maximum
    || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 14_400_000
    || typeof metadata.readingIndependent !== 'boolean') return null;
  const detail = metadata.readingKind === 'full_detail'
    ? canonicalFullDetailRow(row, metadata) : canonicalSingleRow(row, metadata);
  if (!detail) return null;
  return {
    id: row.id, attemptId: metadata.readingAttemptId, score, maxScore: maximum,
    durationMs, createdAt, createdTime: new Date(createdAt).getTime(),
    independent: metadata.readingIndependent === true && metadata.helpUsed !== true,
    ...detail,
  };
}

function logicalAttempts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.attemptId) || [];
    group.push(row);
    groups.set(row.attemptId, group);
  }
  const attempts = [];
  for (const [attemptId, group] of groups) {
    const isFull = FULL_ATTEMPT_ID.test(attemptId) || group.some((row) => row.type === 'full_detail');
    if (isFull) {
      const gist = group.filter((row) => row.type === 'single' && row.kind === 'task10');
      const detail = group.filter((row) => row.type === 'full_detail');
      if (group.length !== 2 || gist.length !== 1 || detail.length !== 1) continue;
      const included = [gist[0], detail[0]];
      attempts.push({
        attemptId, kind: 'full', label: 'Полный раздел 10–18', rows: included,
        score: included.reduce((sum, row) => sum + row.score, 0),
        maxScore: 20, durationMs: included.reduce((sum, row) => sum + row.durationMs, 0),
        createdAt: included.map((row) => row.createdAt).sort().at(-1),
        createdTime: Math.max(...included.map((row) => row.createdTime)),
        independent: included.every((row) => row.independent),
      });
      continue;
    }
    if (group.length !== 1 || group[0].type !== 'single') continue;
    const item = group[0];
    attempts.push({
      attemptId, kind: item.kind, label: item.set.title, rows: [item],
      score: item.score, maxScore: item.maxScore, durationMs: item.durationMs,
      createdAt: item.createdAt, createdTime: item.createdTime, independent: item.independent,
    });
  }
  return attempts.sort((left, right) => right.createdTime - left.createdTime
    || left.attemptId.localeCompare(right.attemptId));
}

function aggregateRows(rows, skill) {
  const selected = skill ? rows.filter((row) => row.skill === skill) : rows;
  const correct = selected.reduce((sum, row) => sum + row.score, 0);
  const total = selected.reduce((sum, row) => sum + row.maxScore, 0);
  return { correct, total, percent: percent(correct, total), sampleSize: selected.length };
}

function skillRow(rows, skill) {
  const aggregate = aggregateRows(rows, skill);
  return { ...SKILLS[skill], ...aggregate, confidence: confidence(aggregate.sampleSize) };
}

function comparison(attempts) {
  if (attempts.length < 4) return {
    state: 'insufficient_evidence', confidence: 'insufficient', recentSampleSize: Math.min(2, attempts.length),
    previousSampleSize: 0, recentAccuracyPercent: null, previousAccuracyPercent: null, deltaPercentagePoints: null,
  };
  const windowSize = Math.min(3, Math.floor(attempts.length / 2));
  const recent = attempts.slice(0, windowSize);
  const previous = attempts.slice(windowSize, windowSize * 2);
  const accuracy = (items) => percent(
    items.reduce((sum, item) => sum + item.score, 0),
    items.reduce((sum, item) => sum + item.maxScore, 0),
  );
  const recentPercent = accuracy(recent);
  const previousPercent = accuracy(previous);
  return {
    state: 'available', confidence: confidence(recent.length + previous.length),
    recentSampleSize: recent.length, previousSampleSize: previous.length,
    recentAccuracyPercent: recentPercent, previousAccuracyPercent: previousPercent,
    deltaPercentagePoints: recentPercent - previousPercent,
  };
}

function trendFromComparison(value) {
  if (value.state !== 'available') return {
    state: 'insufficient_evidence', confidence: 'insufficient',
    recentSampleSize: value.recentSampleSize, previousSampleSize: value.previousSampleSize,
    deltaPercentagePoints: null,
  };
  return {
    state: value.deltaPercentagePoints > 5 ? 'up' : value.deltaPercentagePoints < -5 ? 'down' : 'steady',
    confidence: value.confidence, recentSampleSize: value.recentSampleSize,
    previousSampleSize: value.previousSampleSize, deltaPercentagePoints: value.deltaPercentagePoints,
  };
}

function groupedPerformance(rows, property) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.type === 'single')) {
    const key = row.set[property];
    const group = groups.get(key) || { correct: 0, total: 0, sampleSize: 0 };
    group.correct += row.score;
    group.total += row.maxScore;
    group.sampleSize += 1;
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, value]) => ({
    [property]: key, ...value, percent: percent(value.correct, value.total),
    confidence: confidence(value.sampleSize),
  }));
}

function pace(attempts) {
  const timed = attempts.filter((attempt) => attempt.durationMs > 0);
  const full = timed.filter((attempt) => attempt.kind === 'full');
  const available = timed.length >= 2;
  return {
    state: available ? 'available' : 'insufficient_evidence', confidence: confidence(timed.length),
    sampleSize: timed.length,
    averageSecondsPerField: available ? Math.round(timed.reduce((sum, item) => sum + item.durationMs, 0)
      / timed.reduce((sum, item) => sum + item.maxScore, 0) / 100) / 10 : null,
    fullSectionSampleSize: full.length,
    fullSectionAverageMinutes: full.length ? Math.round(full.reduce((sum, item) => sum + item.durationMs, 0)
      / full.length / 60_000 * 10) / 10 : null,
    fipiRecommendedMinutes: 30, forcedCutoff: false,
  };
}

function repeatErrors(rows) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.type === 'single')) {
    const group = groups.get(row.set.id) || { set: row.set, rows: [] };
    group.rows.push(row);
    groups.set(row.set.id, group);
  }
  const sets = [...groups.values()].flatMap(({ set, rows: observations }) => {
    const errorAttempts = observations.filter((row) => row.score < row.maxScore).length;
    if (observations.length < 2 || errorAttempts < 2) return [];
    const aggregate = aggregateRows(observations);
    return [{
      setId: set.id, title: set.title, kind: set.kind, topic: set.topic,
      sampleSize: observations.length, errorAttempts, accuracyPercent: aggregate.percent,
      confidence: confidence(observations.length),
    }];
  }).sort((left, right) => right.errorAttempts - left.errorAttempts
    || left.accuracyPercent - right.accuracyPercent || left.setId.localeCompare(right.setId));
  const sampleSize = [...groups.values()].reduce((sum, group) => sum + group.rows.length, 0);
  return {
    state: sets.length ? 'available' : 'insufficient_evidence', confidence: confidence(sampleSize),
    sampleSize, sets,
  };
}

function recommendation(skills, sampleSize) {
  const observed = skills.filter((skill) => skill.total > 0)
    .sort((left, right) => left.percent - right.percent || left.id.localeCompare(right.id));
  if (sampleSize < 3 || observed.length < 2) return {
    text: 'Пока недостаточно данных для персонального распределения времени: завершите тренировки на основное содержание и детальное понимание.',
    confidence: 'insufficient', sampleSize, timeAllocation: [],
  };
  const weakest = observed[0];
  const other = observed[1];
  return {
    text: `В следующих занятиях уделите больше времени навыку «${weakest.label}»: это рекомендация по ${sampleSize} завершённым попыткам, а не вывод об освоении темы.`,
    confidence: confidence(sampleSize), sampleSize,
    timeAllocation: [
      { skillId: weakest.id, label: weakest.label, minutesPer30: 18 },
      { skillId: other.id, label: other.label, minutesPer30: 12 },
    ],
  };
}

function baseRecommendation(skills, sampleSize) {
  const observed = skills.filter((skill) => skill.total > 0)
    .sort((left, right) => left.percent - right.percent || left.id.localeCompare(right.id));
  if (!observed.length) return {
    code: 'start_both_skills', text: 'Завершите по одной тренировке на основное содержание и детальное понимание.', sampleSize: 0,
  };
  if (observed.length < 2) return {
    code: 'complete_skill_coverage',
    text: 'Завершите тренировку второго навыка: только после этого можно честно сравнить основное содержание и детальное понимание.',
    sampleSize,
  };
  const weakest = observed[0];
  return {
    code: weakest.id === SKILLS.gist.id ? 'practice_gist' : 'practice_detail',
    text: `Следующая базовая рекомендация — потренировать ${weakest.label.toLocaleLowerCase('ru-RU')}; вывод основан на ${sampleSize} завершённых попытках.`,
    sampleSize,
  };
}

export function buildReadingReport({ rows, scope = 'base', generatedAt = new Date() } = {}) {
  if (!['base', 'expanded'].includes(scope)) throw new TypeError('READING_REPORT_SCOPE_INVALID');
  const input = Array.isArray(rows) ? rows.slice(0, READING_REPORT_MAX_ROWS) : [];
  const seenIds = new Set();
  const normalized = [];
  for (const row of input) {
    if (seenIds.has(row?.id)) continue;
    seenIds.add(row?.id);
    const item = canonicalRow(row);
    if (item) normalized.push(item);
  }
  const attempts = logicalAttempts(normalized);
  const includedRows = attempts.reduce((sum, attempt) => sum + attempt.rows.length, 0);
  const independentAttempts = attempts.filter((attempt) => attempt.independent).length;
  const included = attempts.flatMap((attempt) => attempt.rows);
  const skills = [skillRow(included, 'gist'), skillRow(included, 'detail')];
  const total = aggregateRows(included);
  const compared = comparison(attempts);
  const observedSkills = skills.filter((skill) => skill.total > 0)
    .sort((left, right) => left.percent - right.percent || left.id.localeCompare(right.id));
  const weakest = observedSkills.length === 2 ? observedSkills[0] : null;
  const report = {
    version: REPORT_VERSION, scope, generatedAt: new Date(generatedAt).toISOString(),
    evidence: {
      source: 'persisted_canonical_completed_attempts', maximumRows: READING_REPORT_MAX_ROWS,
      includedRows, includedAttempts: attempts.length, independentAttempts,
      assistedAttempts: attempts.length - independentAttempts, excludedRows: input.length - includedRows,
    },
    base: {
      accuracy: total.total ? { ...total, sampleSize: attempts.length } : null,
      recentTrend: trendFromComparison(compared), weakestSkill: weakest,
      recentAttempts: attempts.slice(0, 6).map((attempt) => ({
        completedAt: attempt.createdAt, kind: attempt.kind, label: attempt.label,
        score: attempt.score, maxScore: attempt.maxScore,
        accuracyPercent: percent(attempt.score, attempt.maxScore),
        durationMinutes: Math.round(attempt.durationMs / 60_000 * 10) / 10,
        independent: attempt.independent,
      })),
      recommendation: baseRecommendation(skills, attempts.length),
    },
  };
  if (scope === 'expanded') {
    report.expanded = {
      skills,
      topics: groupedPerformance(included, 'topic').sort((left, right) => left.percent - right.percent
        || left.topic.localeCompare(right.topic, 'ru')),
      cefr: groupedPerformance(included, 'cefr').sort((left, right) => CEFR_ORDER.get(left.cefr) - CEFR_ORDER.get(right.cefr)),
      pace: pace(attempts), repeatErrors: repeatErrors(included), comparison: compared,
      recommendation: recommendation(skills, attempts.length),
      disclosure: 'Отчёт описывает только сохранённые завершённые попытки Reading; попытки с поддержкой учитываются и помечаются отдельно. Малые выборки и совместные срезы полного раздела ограничивают выводы; совпадение точности с темой или уровнем не доказывает освоение и не является причинной связью.',
    };
  }
  return report;
}
