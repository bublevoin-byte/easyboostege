import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { getEgeMockForm } from '../ege-mock/catalog.js';
import {
  buildEgeMockCanonicalResult,
  buildEgeMockDashboardSummary,
  buildEgeMockHistory,
  egeMockErrorFocusEntries,
  egeMockAdaptiveEvidenceAttempts,
  EGE_MOCK_RESULT_SCHEMA_VERSION,
  selectEgeMockHistoryRows,
} from '../ege-mock/result.js';
import {
  EGE_MOCK_RESULT_HISTORY_LIMIT,
  egeMockCompositeResultMatchesCanonical,
  egeMockForecastScore,
} from '../shared/ege-mock-result-contract.js';
import { compileOpenApiSchema } from './support/openapi-schema-evaluator.js';
import { buildAdaptiveLearningProfile } from '../adaptive-learning/profile.js';
import { egeMockWritingResultPublicDto } from '../ege-mock/writing-assessment.js';

const FORM = getEgeMockForm('ege-en-2026-form-1', 1);
const AUTOMATIC_WARNING = 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';

function objectiveAnswers() {
  return Object.fromEntries(FORM.positions.filter(({ position }) => position <= 36).map((item) => [
    item.position,
    item.assessment.type === 'ordered_choice_list'
      ? [...item.assessment.accepted]
      : item.assessment.accepted[0],
  ]));
}

function pendingAttempt(overrides = {}) {
  const draft = objectiveAnswers();
  draft[19] = 'go';
  delete draft[20];
  draft[37] = 'Private learner email';
  draft[38] = 'Private learner report';
  return {
    id: '11111111-1111-4111-8111-111111111111',
    owner_generation: 'account:2026-01-01T00:00:00.000Z',
    form_id: FORM.id,
    form_revision: FORM.revision,
    catalog_fingerprint: FORM.fingerprint,
    mode: 'diagnostic',
    attempt_number: 1,
    state: 'assessment_pending',
    revision: 4,
    draft,
    written_submitted_at: '2026-01-01T03:10:00.000Z',
    oral_submitted_at: '2026-01-02T00:17:00.000Z',
    assessment_status: 'pending',
    assessment_retry_count: 0,
    writing_assessment: {
      version: 'ege-mock-writing-assessment-v1', assessment_revision: 1,
      status: 'pending', score_kind: 'provisional', retry_count: 0, items: null,
      updated_at: '2026-01-01T03:10:00.000Z',
    },
    speaking_assessment: {
      version: 'ege-mock-speaking-assessment-v1', status: 'pending', retry_count: 0,
      items: Object.fromEntries([[39, 1], [40, 4], [41, 5], [42, 10]].map(([position, maximum]) => [
        position, { position, maximum, status: 'pending', score: null,
          mode: 'experimental', score_kind: 'approximate', error_code: null },
      ])),
      updated_at: '2026-01-02T00:17:00.000Z',
    },
    result: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:17:00.000Z',
    ...overrides,
  };
}

function completedAttempt(overrides = {}) {
  const row = pendingAttempt();
  row.state = 'completed';
  row.assessment_status = 'completed';
  row.writing_assessment = {
    ...row.writing_assessment,
    status: 'completed', assessment_revision: 7,
    items: [[37, 6, 5], [38, 14, 10]].map(([position, maximum, score]) => ({
      position, maximum, status: 'completed',
      criteria_ref: FORM.positions[position - 1].assessment.criteriaRef,
      criteria_fingerprint: FORM.positions[position - 1].assessment.criteriaFingerprint,
      scope: { task: position },
      review: {
        overall_got: score, overall_max: maximum,
        criteria: (position === 37
          ? [['criterion-1', 2], ['criterion-2', 2], ['criterion-3', 2]]
          : [['criterion-1', 3], ['criterion-2', 3], ['criterion-3', 3],
            ['criterion-4', 3], ['criterion-5', 2]])
          .map(([name, max], index, criteria) => {
            const before = criteria.slice(0, index).reduce((total, entry) => total + entry[1], 0);
            return { name, got: Math.max(0, Math.min(max, score - before)), max };
          }),
        verdict: 'Needs focused practice.', sub: 'Revise the exact criterion.', errors: [],
      },
    })),
  };
  row.speaking_assessment = {
    ...row.speaking_assessment,
    status: 'completed',
    items: Object.fromEntries([[39, 1, 1], [40, 4, 3], [41, 5, 4], [42, 10, 8]].map(([
      position, maximum, score,
    ]) => [position, {
      position, maximum, status: 'completed', score,
      mode: 'experimental', score_kind: 'approximate', error_code: null,
    }])),
  };
  return Object.assign(row, overrides);
}

test('canonical result keeps pending subjective evidence null and exposes one grounded weak-area focus', () => {
  const result = buildEgeMockCanonicalResult(pendingAttempt(), FORM);

  assert.equal(result.schemaVersion, EGE_MOCK_RESULT_SCHEMA_VERSION);
  assert.deepEqual(result.score, {
    objectivePrimary: 40,
    provisionalSubjectivePrimary: null,
    primaryTotal: null,
    maximum: 82,
    range: { minimum: 40, maximum: 80 },
  });
  assert.deepEqual(result.sections.map(({ id, score, maximum, scoreKind, status }) => ({
    id, score, maximum, scoreKind, status,
  })), [
    { id: 'listening', score: 12, maximum: 12, scoreKind: 'exact', status: 'completed' },
    { id: 'reading', score: 12, maximum: 12, scoreKind: 'exact', status: 'completed' },
    { id: 'grammar_lexis', score: 16, maximum: 18, scoreKind: 'exact', status: 'completed' },
    { id: 'writing', score: null, maximum: 20, scoreKind: 'approximate', status: 'pending' },
    { id: 'speaking', score: null, maximum: 20, scoreKind: 'approximate', status: 'pending' },
  ]);
  assert.deepEqual(result.forecast, {
    policyId: 'ege-mock-forecast-2026-v1',
    label: 'Прогноз тестового балла',
    score: null,
    range: { minimum: 49, maximum: 98 },
    disclaimer: 'Ориентировочный прогноз Easy Boost, а не официальный результат ЕГЭ.',
    baselineEligible: true,
  });
  assert.deepEqual(result.recommendations.filter(({ skillId }) => skillId === 'ege.grammar.forms'), [{
    id: 'ege.grammar.forms', skillId: 'ege.grammar.forms', module: 'grammar',
    label: 'Грамматические формы', href: '#scr3', evidencePositions: [19, 20],
    evidenceKind: 'objective_error', masteryCredit: false,
  }]);
  assert.equal(JSON.stringify(result.recommendations).includes('Private learner'), false);
  assert.equal(result.items.find(({ position }) => position === 19).correctAnswer, 'went');
  assert.equal(result.items.find(({ position }) => position === 20).learnerAnswer, null);
  assert.equal(result.items.find(({ position }) => position === 37).correctAnswer, null);
  assert.equal(result.items.find(({ position }) => position === 37).learnerAnswer, null,
    'expanded learner text remains private while the safe criterion review is public');
  assert.equal(result.items.find(({ position }) => position === 37).responseState,
    'submitted_hidden', 'privacy hiding is distinct from an actually blank response');
  assert.equal(result.items.find(({ position }) => position === 37).criteriaRef,
    'writing-ege-2026-task37-v1');
});

test('partially completed composite objective answers retain credit for each correct subanswer', () => {
  const row = pendingAttempt();
  row.draft[1] = [...FORM.positions[0].assessment.accepted];
  row.draft[1][row.draft[1].length - 1] = '';

  const result = buildEgeMockCanonicalResult(row, FORM);
  const listeningMatch = result.items.find(({ position }) => position === 1);

  assert.equal(listeningMatch.score, 1,
    'five correct matches and one blank receive the authored one-point band');
  assert.equal(listeningMatch.responseState, 'blank',
    'a partial composite remains visibly incomplete even when correct subanswers earn credit');
});

test('completed result totals exact and provisional sections without calling the forecast official', () => {
  const result = buildEgeMockCanonicalResult(completedAttempt(), FORM);

  assert.deepEqual(result.score, {
    objectivePrimary: 40,
    provisionalSubjectivePrimary: 31,
    primaryTotal: 71,
    maximum: 82,
    range: { minimum: 71, maximum: 71 },
  });
  assert.equal(result.forecast.score, 87);
  assert.deepEqual(result.forecast.range, { minimum: 87, maximum: 87 });
  assert.equal(result.assessmentWarning, AUTOMATIC_WARNING);
  assert.equal(result.items.find(({ position }) => position === 37).scoreKind, 'approximate');
  assert.equal(result.items.find(({ position }) => position === 39).scoreKind, 'approximate');
  for (const item of result.items.filter(({ position }) => position >= 39)) {
    assert.deepEqual(item.criteria?.map(({ got, max }) => ({ got, max })), [{
      got: item.score, max: item.maximum,
    }], `task ${item.position} publishes one honest aggregate rubric score`);
    assert.match(item.criteria[0].name, /[А-Яа-яЁё]/u);
    assert.match(item.feedback?.verdict || '', /Предварительная оценка/u);
    assert.ok((item.feedback?.nextStep || '').length > 0);
  }
  assert.equal(JSON.stringify(result).toLocaleLowerCase('ru').includes('официальный балл'), false);
});

test('partial subjective evidence contributes to the honest range without becoming an invented zero', () => {
  const row = completedAttempt();
  row.writing_assessment.items[1] = {
    ...row.writing_assessment.items[1], status: 'pending', review: null,
  };
  row.writing_assessment.status = 'pending';
  row.speaking_assessment.status = 'pending';
  for (const item of Object.values(row.speaking_assessment.items)) {
    item.status = 'pending';
    item.score = null;
  }

  const result = buildEgeMockCanonicalResult(row, FORM);

  assert.equal(result.sections.find(({ id }) => id === 'writing').score, 5);
  assert.equal(result.sections.find(({ id }) => id === 'writing').status, 'pending');
  assert.equal(result.score.provisionalSubjectivePrimary, 5);
  assert.equal(result.score.primaryTotal, null);
  assert.deepEqual(result.score.range, { minimum: 45, maximum: 79 });
  assert.deepEqual(result.forecast.range, {
    minimum: egeMockForecastScore(45), maximum: egeMockForecastScore(79),
  });
  const writing = egeMockWritingResultPublicDto(row);
  const speaking = { status: 'pending', items: [] };
  assert.equal(egeMockCompositeResultMatchesCanonical({
    canonical: result, writing: { ...writing, items: [] }, speaking,
  }), false, 'a pending Writing projection cannot omit an already completed canonical item');
  assert.equal(egeMockCompositeResultMatchesCanonical({
    canonical: result, writing: { ...writing, items: [writing.items[0], writing.items[0]] }, speaking,
  }), false, 'a pending Writing projection cannot duplicate one canonical position');
});

test('history pins the first diagnostic baseline and keeps repeats training-only', () => {
  const diagnostic = completedAttempt();
  const training = completedAttempt({
    id: '22222222-2222-4222-8222-222222222222', mode: 'training', attempt_number: 2,
    created_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-04T00:00:00.000Z',
  });
  training.draft = objectiveAnswers();

  const history = buildEgeMockHistory([training, diagnostic], FORM);

  assert.equal(history.baselineAttemptId, diagnostic.id);
  assert.equal(history.attempts[0].id, training.id);
  assert.equal(history.attempts[0].label, 'Тренировочный повтор');
  assert.equal(history.attempts[0].replacesBaseline, false);
  assert.equal(history.attempts[0].result.forecast.baselineEligible, false);
  assert.equal(history.attempts[0].result.forecast.score, null);
  assert.equal(history.attempts[0].result.forecast.range, null,
    'a training repeat must not manufacture an independent exam forecast');
  assert.equal(history.attempts[1].label, 'Диагностический');
  assert.equal(history.attempts[1].isBaseline, true);
});

test('bounded history retains the immutable diagnostic baseline alongside the newest repeats', () => {
  const diagnostic = completedAttempt({ created_at: '2026-01-01T00:00:00.000Z' });
  const rows = [diagnostic];
  for (let index = 1; index <= EGE_MOCK_RESULT_HISTORY_LIMIT + 4; index += 1) {
    rows.push(completedAttempt({
      id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
      mode: 'training', attempt_number: index + 1,
      created_at: `2026-02-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    }));
  }

  const history = buildEgeMockHistory(rows, FORM);

  assert.equal(history.attempts.length, EGE_MOCK_RESULT_HISTORY_LIMIT);
  assert.equal(history.attempts.some(({ id }) => id === diagnostic.id), true);
  assert.equal(history.attempts.filter(({ isBaseline }) => isBaseline).length, 1);

  const restored = rows[1];
  const targetedRows = selectEgeMockHistoryRows(rows, { includeAttemptId: restored.id });
  const targeted = buildEgeMockHistory(targetedRows, FORM, {
    includeAttemptId: restored.id,
  });
  assert.equal(targeted.attempts.length, EGE_MOCK_RESULT_HISTORY_LIMIT);
  assert.equal(targeted.attempts.some(({ id }) => id === restored.id), true,
    'an exact restored terminal attempt is pinned into its bounded history snapshot');
  assert.equal(targeted.attempts.some(({ id }) => id === diagnostic.id), true,
    'attempt targeting cannot evict the immutable diagnostic baseline');
  assert.equal(targeted.attempts.some(({ id }) => id === rows.at(-1).id), true,
    'attempt targeting retains the newest completed result beside both pinned rows');

  const expiredDistractors = Array.from({ length: EGE_MOCK_RESULT_HISTORY_LIMIT + 5 }, (_, index) => ({
    ...completedAttempt({
      id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      mode: 'training', attempt_number: 100 + index,
      created_at: `2026-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }),
    state: 'expired', oral_submitted_at: null,
  }));
  const selected = selectEgeMockHistoryRows([...rows, ...expiredDistractors]);
  assert.equal(buildEgeMockHistory(selected, FORM).attempts.length,
    EGE_MOCK_RESULT_HISTORY_LIMIT,
    'newer terminal distractors cannot evict retained completed history');
});

test('bounded history orders PostgreSQL Date timestamps chronologically and retains the newest attempt', () => {
  const newestAt = new Date('2026-01-02T12:00:00.000Z');
  const newest = completedAttempt({
    id: '44444444-4444-4444-8444-000000000000',
    mode: 'training', attempt_number: 100, created_at: newestAt,
  });
  const diagnostic = completedAttempt({
    created_at: new Date('2025-01-01T00:00:00.000Z'),
  });
  const older = Array.from({ length: 50 }, (_, index) => completedAttempt({
    id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
    mode: 'training', attempt_number: index + 2,
    created_at: new Date(newestAt.getTime() - (index + 1) * 86_400_000),
  }));
  const rows = [diagnostic, ...older, newest];

  assert.equal(buildEgeMockHistory(rows, FORM).attempts.some(({ id }) => id === newest.id), true,
    'the latest PostgreSQL-backed terminal attempt stays in the bounded result history');
  assert.equal(selectEgeMockHistoryRows(rows).some(({ id }) => id === newest.id), true,
    'the storage selection seam must retain the same latest attempt before hydration');
});

test('diagnostic result projects one idempotent error-bank focus and one dashboard baseline', () => {
  const diagnostic = pendingAttempt();
  const canonical = buildEgeMockCanonicalResult(diagnostic, FORM);
  const history = buildEgeMockHistory([diagnostic], FORM);

  assert.deepEqual(egeMockErrorFocusEntries(diagnostic, FORM), [{
    module: 'grammar',
    itemKey: `ege-mock:${diagnostic.id}:ege.grammar.forms`,
    errorType: 'ege_mock_diagnostic_weak_skill',
    details: {
      skill_id: 'ege.grammar.forms', source_attempt_id: diagnostic.id,
      evidence_positions: '19,20', evidence_kind: 'objective_error',
      evidence_context: 'diagnostic_full_mock', mastery_credit: false,
    },
  }]);
  assert.deepEqual(buildEgeMockDashboardSummary(history), {
    baselineAttemptId: diagnostic.id,
    displayedAttempts: 1,
    baseline: {
      attemptId: diagnostic.id, primaryTotal: null, maximum: 82,
      range: { minimum: 40, maximum: 80 },
      forecast: canonical.forecast,
    },
  });
});

test('dashboard labels the bounded history window without claiming a lifetime completion count', () => {
  const rows = [completedAttempt()];
  for (let index = 1; index <= EGE_MOCK_RESULT_HISTORY_LIMIT + 3; index += 1) {
    rows.push(completedAttempt({
      id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
      mode: 'training', attempt_number: index + 1,
      created_at: `2026-04-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    }));
  }
  const summary = buildEgeMockDashboardSummary(buildEgeMockHistory(rows, FORM));
  assert.equal(summary.displayedAttempts, EGE_MOCK_RESULT_HISTORY_LIMIT);
  assert.equal(Object.hasOwn(summary, 'completedAttempts'), false,
    'a capped window must not be presented as the owner lifetime total');
});

test('dashboard summary OpenAPI binds the immutable baseline pointer and displayed window', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const schema = compileOpenApiSchema(specification, 'EgeMockDashboardSummary');
  const summary = buildEgeMockDashboardSummary(buildEgeMockHistory([completedAttempt()], FORM));

  assert.equal(schema(summary), true, JSON.stringify(schema.errors));
  assert.equal(schema({ ...summary, baselineAttemptId: '22222222-2222-4222-8222-222222222222' }), false,
    'the dashboard baseline object cannot point at another attempt');
  assert.equal(schema({ ...summary, displayedAttempts: 0 }), false,
    'a displayed immutable baseline requires at least one retained attempt');
  assert.equal(schema({
    ...summary,
    baseline: { ...summary.baseline, range: { minimum: 82, maximum: 0 } },
  }), false, 'the dashboard primary range cannot be reversed');
  assert.equal(schema({
    ...summary,
    baseline: {
      ...summary.baseline,
      forecast: { ...summary.baseline.forecast, range: { minimum: 100, maximum: 0 } },
    },
  }), false, 'the dashboard forecast range cannot be reversed');
  assert.equal(schema({
    ...summary,
    baseline: {
      ...summary.baseline,
      primaryTotal: 82,
      range: { minimum: 0, maximum: 82 },
      forecast: { ...summary.baseline.forecast, score: 0, range: { minimum: 100, maximum: 100 } },
    },
  }), false, 'dashboard totals and forecasts must follow the versioned conversion policy');
  assert.equal(schema({
    ...summary,
    baseline: {
      ...summary.baseline,
      primaryTotal: null,
      forecast: { ...summary.baseline.forecast, score: null },
    },
  }), false, 'a pending dashboard total must retain a genuinely non-degenerate score range');
  assert.equal(schema({ baselineAttemptId: null, displayedAttempts: 0, baseline: null }), true,
    JSON.stringify(schema.errors));
  assert.equal(schema({ baselineAttemptId: null, displayedAttempts: 1, baseline: null }), false,
    'an empty dashboard cannot claim a retained result row');
});

test('adaptive projection uses one assisted diagnostic observation per weak skill and excludes repeats', () => {
  const diagnostic = pendingAttempt();
  const training = pendingAttempt({
    id: '22222222-2222-4222-8222-222222222222', mode: 'training', attempt_number: 2,
    created_at: '2026-01-03T00:00:00.000Z', oral_submitted_at: '2026-01-03T00:17:00.000Z',
  });

  const first = egeMockAdaptiveEvidenceAttempts([diagnostic, training], FORM);
  const restored = egeMockAdaptiveEvidenceAttempts([diagnostic, training], FORM);

  assert.deepEqual(first, restored, 'reload cannot multiply the same diagnostic evidence');
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    id: `ege-mock:${diagnostic.id}:ege.grammar.forms`,
    module: 'grammar', activity: 'ege.grammar.forms', score: 0, max_score: 2,
    duration_ms: null,
    metadata: {
      skill_id: 'ege.grammar.forms', source_attempt_id: diagnostic.id,
      ege_mock_attempt_id: diagnostic.id, evidence_positions: [19, 20],
      evidence_context: 'diagnostic_full_mock', mastery_credit: false,
    },
    evidence_quality: 'server_verified_assisted',
    created_at: diagnostic.oral_submitted_at,
  });
  assert.equal(first.some(({ id }) => id.includes(training.id)), false,
    'a training repeat is not a second adaptive observation');
  const profile = buildAdaptiveLearningProfile({ attempts: first });
  const grammar = profile.skills.find(({ id }) => id === 'ege.grammar.forms');
  const lexicalChoice = profile.skills.find(({ id }) => id === 'ege.vocabulary.lexical_choice');
  assert.equal(grammar.evidenceCount, 1);
  assert.equal(grammar.independentEvidenceCount, 0);
  assert.equal(grammar.evidenceQuality, 'assisted');
  assert.equal(grammar.mastery, 0, 'exam errors may guide focus but never grant mastery');
  assert.equal(lexicalChoice.evidenceCount, 0, 'grammar errors cannot be attributed to another topic');
});

test('canonical result and history have executable OpenAPI parity', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const resultSchema = compileOpenApiSchema(specification, 'EgeMockCanonicalResult');
  const historyAttemptSchema = compileOpenApiSchema(specification, 'EgeMockHistoryAttempt');
  const historySchema = compileOpenApiSchema(specification, 'EgeMockHistory');
  const diagnostic = pendingAttempt();
  const canonical = buildEgeMockCanonicalResult(diagnostic, FORM);
  const history = buildEgeMockHistory([diagnostic], FORM);

  assert.equal(resultSchema(canonical), true, JSON.stringify(resultSchema.errors));
  assert.equal(historyAttemptSchema(history.attempts[0]), true,
    JSON.stringify(historyAttemptSchema.errors));
  assert.equal(historySchema(history), true, JSON.stringify(historySchema.errors));
  assert.equal(resultSchema({ ...canonical, score: { ...canonical.score, primaryTotal: 82 } }), false,
    'schema rejects contradictory total while subjective assessment is pending');
  assert.equal(resultSchema({
    ...canonical,
    sections: canonical.sections.map((section) => section.id === 'listening'
      ? { ...section, status: 'pending' } : section),
  }), false, 'an exact objective section cannot contradict its completed items');
  assert.equal(resultSchema({ ...canonical, items: canonical.items.slice(1) }), false,
    'schema requires the exact 42-item review');
  assert.equal(resultSchema({
    ...canonical,
    items: canonical.items.map((item) => (item.position === 39
      ? { ...item, status: 'completed' } : item)),
  }), false, 'a completed Speaking item cannot omit its score and safe review');
  assert.equal(resultSchema({
    ...canonical,
    items: canonical.items.map((item) => (item.position === 37
      ? { ...item, status: 'completed' } : item)),
  }), false, 'a completed Writing item cannot omit its score and safe review');
  assert.equal(historySchema({ ...history, baselineAttemptId: 'foreign-attempt' }), false,
    'schema binds the baseline pointer to one diagnostic history entry');

  const allWeak = completedAttempt();
  allWeak.draft = {};
  for (const item of allWeak.writing_assessment.items) item.review.overall_got = 0;
  for (const item of Object.values(allWeak.speaking_assessment.items)) item.score = 0;
  const allWeakCanonical = buildEgeMockCanonicalResult(allWeak, FORM);
  assert.equal(allWeakCanonical.recommendations.length, 13);
  assert.equal(resultSchema(allWeakCanonical), true, JSON.stringify(resultSchema.errors));
  assert.equal(resultSchema({
    ...allWeakCanonical,
    items: allWeakCanonical.items.map((item) => (item.position === 39
      ? { ...item, status: 'pending' } : item)),
  }), false, 'a scored Speaking item must be completed');
  assert.equal(resultSchema({
    ...allWeakCanonical,
    items: allWeakCanonical.items.map((item) => (item.position === 37
      ? { ...item, status: 'retryable' } : item)),
  }), false, 'a scored Writing item must be completed');
  const scoredSpeaking = allWeakCanonical.items.find(({ position }) => position === 39);
  const withoutSpeakingCriteria = {
    ...allWeakCanonical,
    items: allWeakCanonical.items.map((item) => (item.position === 39
      ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'criteria')) : item)),
  };
  assert.equal(resultSchema(withoutSpeakingCriteria), false,
    'a scored Speaking item requires its bounded human-readable rubric');
  const withoutSpeakingFeedback = {
    ...allWeakCanonical,
    items: allWeakCanonical.items.map((item) => (item.position === 39
      ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'feedback')) : item)),
  };
  assert.equal(resultSchema(withoutSpeakingFeedback), false,
    'a scored Speaking item requires safe authored feedback');
  assert.equal(scoredSpeaking.criteria.length, 1);

  const itemSchema = compileOpenApiSchema(specification, 'EgeMockCanonicalResultItem');
  const widestAcceptedDraftAnswer = Array(20).fill('x'.repeat(500));
  assert.equal(itemSchema({
    ...canonical.items[0],
    learnerAnswer: widestAcceptedDraftAnswer,
    correctAnswer: widestAcceptedDraftAnswer,
  }), true, JSON.stringify(itemSchema.errors));
});
