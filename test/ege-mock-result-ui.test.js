import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimEgeMockResultLoad,
  createEgeMockResultLoadAuthority,
  egeMockResultTupleIsConsistent,
  renderEgeMockResult,
} from '../public/ege-mock-result.js';
import { egeMockForecastScore } from '../shared/ege-mock-result-contract.js';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function resultItems() {
  const maximum = [
    2, 3, 1, 1, 1, 1, 1, 1, 1,
    3, 2, 1, 1, 1, 1, 1, 1, 1,
    ...Array(18).fill(1), 6, 14, 1, 4, 5, 10,
  ];
  return maximum.map((itemMaximum, index) => {
    const position = index + 1;
    const section = position <= 9 ? 'listening' : position <= 18 ? 'reading'
      : position <= 36 ? 'grammar_lexis' : position <= 38 ? 'writing' : 'speaking';
    const exact = position <= 36;
    return {
      position, section, status: exact ? 'completed' : position <= 38 ? 'pending' : 'retryable',
      scoreKind: exact ? 'exact' : 'approximate',
      score: exact ? ([19, 20].includes(position) ? 0 : itemMaximum) : null,
      maximum: itemMaximum, learnerAnswer: null,
      responseState: exact ? 'blank' : position === 37 ? 'submitted_hidden' : 'technical',
      correctAnswer: exact ? `answer-${position}` : null,
      ...(exact ? {} : {
        criteriaRef: `criteria-${position}`,
        criteriaFingerprint: `sha256:${'b'.repeat(64)}`,
      }),
      contentRef: { catalogId: 'test-catalog', id: `task-${position}`, revision: 1 },
    };
  });
}

test('result load authority rejects a mixed tuple in both cross-tab response orders', async () => {
  for (const firstResponse of ['result', 'history']) {
    const authority = createEgeMockResultLoadAuthority();
    const result = deferred();
    const history = deferred();
    const token = authority.begin('attempt-1');
    const loaded = Promise.all([result.promise, history.promise])
      .then(() => authority.canCommit(token));
    const first = firstResponse === 'result' ? result : history;
    const second = firstResponse === 'result' ? history : result;
    first.resolve({ assessmentRevision: 0 });
    await Promise.resolve();
    authority.invalidate('attempt-1');
    second.resolve({ assessmentRevision: 1 });
    assert.equal(await loaded, false,
      `${firstResponse}-first cannot install a result/history tuple spanning one invalidation`);
    assert.equal(authority.canCommit(authority.begin('attempt-1')), true,
      'the authoritative follow-up may install its complete tuple');
  }
});

test('a same-tab settlement queues a fresh result tuple while an older load is active', () => {
  const authority = createEgeMockResultLoadAuthority();
  const first = claimEgeMockResultLoad(authority, 'attempt-1', '');
  assert.ok(first.token);
  assert.equal(first.queued, false);

  const settlement = claimEgeMockResultLoad(authority, 'attempt-1', 'attempt-1');
  assert.equal(settlement.token, null);
  assert.equal(settlement.queued, true);
  assert.equal(authority.canCommit(first.token), false,
    'the pre-settlement tuple loses commit authority even before its GETs settle');

  const retry = claimEgeMockResultLoad(authority, 'attempt-1', '');
  assert.equal(retry.queued, false);
  assert.equal(authority.canCommit(retry.token), true);
});

test('result/history tuple rejects a settlement between the two GET responses', () => {
  const result = envelope({ writingAssessment: { assessmentRevision: 7 } });
  const stableHistory = historyFor(result);
  assert.equal(egeMockResultTupleIsConsistent(result, stableHistory, 'attempt-1'), true);

  const settled = structuredClone(result);
  settled.result.canonical.score.provisionalSubjectivePrimary = 6;
  settled.result.canonical.score.range = { minimum: 46, maximum: 79 };
  settled.result.canonical.sections.find(({ id }) => id === 'writing').score = 6;
  const newerHistory = historyFor(settled);

  assert.equal(egeMockResultTupleIsConsistent(result, newerHistory, 'attempt-1'), false,
    'one load may commit only when result and current-attempt history share a canonical snapshot');
});

function envelope(overrides = {}) {
  return {
    available: true, state: 'assessment_pending', keysRevealed: true,
    writingAssessment: {
      status: 'pending', assessmentRevision: 7, retryAllowed: false, retryCount: 0,
    },
    speakingAssessment: { status: 'retryable' },
    assessment: { status: 'pending', retryAllowed: false, retryCount: 0 },
    result: {
      canonical: {
        schemaVersion: 'ege-mock-result-v1', attemptId: 'attempt-1',
        formId: 'ege-en-2026-form-1', formRevision: 1,
        catalogFingerprint: `sha256:${'a'.repeat(64)}`,
        mode: 'diagnostic', attemptNumber: 1, label: 'Диагностический',
        score: {
          objectivePrimary: 40, provisionalSubjectivePrimary: 5,
          primaryTotal: null, maximum: 82, range: { minimum: 45, maximum: 79 },
        },
        sections: [
          ['listening', 12, 12, 'exact', 'completed'],
          ['reading', 12, 12, 'exact', 'completed'],
          ['grammar_lexis', 16, 18, 'exact', 'completed'],
          ['writing', 5, 20, 'approximate', 'pending'],
          ['speaking', null, 20, 'approximate', 'retryable'],
        ].map(([id, score, maximum, scoreKind, status]) => ({ id, score, maximum, scoreKind, status })),
        forecast: {
          policyId: 'ege-mock-forecast-2026-v1', label: 'Прогноз тестового балла',
          score: null, range: { minimum: 55, maximum: 96 },
          disclaimer: 'Ориентировочный прогноз Easy Boost, а не официальный результат ЕГЭ.',
          baselineEligible: true,
        },
        assessmentWarning: 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.',
        items: resultItems().map((item) => item.position === 19 ? {
          ...item, learnerAnswer: '<script>alert(1)</script>', correctAnswer: 'went',
          contentRef: { catalogId: 'grammar-core-v3', id: 'core.g.exam.1.1', revision: 3 },
        } : item.position === 37 ? {
          ...item, learnerAnswer: null, criteriaRef: 'writing-ege-2026-task37-v1',
          score: 5, status: 'completed',
          criteria: [
            { name: '<criterion>', got: 2, max: 2 },
            { name: 'Организация', got: 2, max: 2 },
            { name: 'Язык', got: 1, max: 2 },
          ],
          feedback: { verdict: '<needs work>', nextStep: 'Revise & retry.' },
          evidence: [{
            title: '<evidence>', wrong: 'bad <tag>', right: 'safe & exact', kind: 'warn', note: 'note',
          }],
          contentRef: { catalogId: 'writing-task-bank-v1', id: 'task37', revision: 1 },
        } : item),
        recommendations: [{
          id: 'ege.grammar.forms', skillId: 'ege.grammar.forms', module: 'grammar',
          label: 'Грамматические формы', href: '#scr3', evidencePositions: [19, 20],
          evidenceKind: 'objective_error', masteryCredit: false,
        }, {
          id: 'ege.writing.email', skillId: 'ege.writing.email', module: 'writing',
          label: 'Электронное письмо', href: '#scr8', evidencePositions: [37],
          evidenceKind: 'provisional_low_score', masteryCredit: false,
        }],
        masteryCredit: false,
      },
      writing: {
        status: 'pending', assessmentRevision: 7,
        items: [{
          position: 37, status: 'completed', score: 5,
          criteria: [
            { name: '<criterion>', got: 2, max: 2 },
            { name: 'Организация', got: 2, max: 2 },
            { name: 'Язык', got: 1, max: 2 },
          ],
          feedback: { verdict: '<needs work>', nextStep: 'Revise & retry.' },
          evidence: [{
            title: '<evidence>', wrong: 'bad <tag>', right: 'safe & exact', kind: 'warn', note: 'note',
          }],
        }],
      },
      speaking: { status: 'retryable' },
    },
    ...overrides,
  };
}

function historyFor(payload) {
  const baseline = payload.result.canonical;
  const training = {
    ...structuredClone(baseline), attemptId: 'attempt-2', mode: 'training', attemptNumber: 2,
    label: 'Тренировочный повтор',
    forecast: { ...baseline.forecast, score: null, range: null, baselineEligible: false },
  };
  return {
    baselineAttemptId: baseline.attemptId,
    attempts: [
      {
        id: training.attemptId, formId: training.formId, formRevision: training.formRevision,
        mode: training.mode, attemptNumber: training.attemptNumber, label: training.label,
        state: 'assessment_pending', completedAt: '2026-01-03T00:17:00.000Z',
        isBaseline: false, replacesBaseline: false, result: training,
      },
      {
        id: baseline.attemptId, formId: baseline.formId, formRevision: baseline.formRevision,
        mode: baseline.mode, attemptNumber: baseline.attemptNumber, label: baseline.label,
        state: 'assessment_pending', completedAt: '2026-01-01T00:17:00.000Z',
        isBaseline: true, replacesBaseline: false, result: baseline,
      },
    ],
  };
}

test('result UI renders an honest pending range, escaped review and existing-module recommendation', () => {
  const payload = envelope();
  const html = renderEgeMockResult(payload, historyFor(payload));

  assert.match(html, /Диагностический/u);
  assert.match(html, /45–79 из 82/u);
  assert.match(html, /55–96/u);
  assert.match(html, /не официальный результат ЕГЭ/u);
  assert.match(html, /Оценка ещё не готова/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /Правильный ответ: went/u);
  assert.match(html, /Критерии предварительной оценки/u);
  assert.match(html, /Точный балл: 0 из 1/u);
  assert.match(html, /Предварительная оценка: 5 из 6/u);
  assert.match(html, /Ответ сохранён; содержимое скрыто/u);
  assert.doesNotMatch(html, /Задание 37[\s\S]*?Ваш ответ: нет ответа[\s\S]*?Критерии: writing-ege-2026-task37-v1/u,
    'privacy-hidden writing must not look like an omitted answer');
  assert.match(html, /&lt;criterion&gt;: 2 из 2/u);
  assert.match(html, /&lt;needs work&gt;/u);
  assert.match(html, /Revise &amp; retry/u);
  assert.match(html, /bad &lt;tag&gt;/u);
  assert.doesNotMatch(html, /<criterion>|<needs work>|<evidence>/u);
  assert.match(html, /data-ege-result-screen="scr3"/u);
  assert.match(html, /не засчитываются как освоение/u);
  assert.match(html, /История пробников/u);
  assert.match(html, /Тренировочный повтор/u);
  assert.match(html, /Исходная диагностика/u);
  assert.match(html, /data-ege-action="result-repeat"/u);
});

test('result UI reserves no-answer wording for a genuinely blank subjective response', () => {
  const payload = envelope();
  payload.result.canonical.items[36].responseState = 'blank';
  const html = renderEgeMockResult(payload, null);
  const task37 = html.slice(html.indexOf('Задание 37'), html.indexOf('Задание 38'));
  assert.match(task37, /Ваш ответ: нет ответа/u);
  assert.doesNotMatch(task37, /Ответ сохранён; содержимое скрыто/u);
});

test('result UI announces a partially filled composite exact response', () => {
  const payload = envelope();
  payload.result.canonical.items[0].learnerAnswer = ['A', '   ', 'C'];
  payload.result.canonical.items[0].responseState = 'blank';
  const html = renderEgeMockResult(payload, null);
  const task1 = html.slice(html.indexOf('Задание 1'), html.indexOf('Задание 2'));
  assert.match(task1, /Ответ заполнен частично/u);
  assert.match(task1, /A · нет ответа · C/u);
});

test('result UI uses one trimmed blank label for scalar and all-empty composite answers', () => {
  const payload = envelope();
  payload.result.canonical.items[0].learnerAnswer = ['', '   ', ''];
  payload.result.canonical.items[0].responseState = 'blank';
  payload.result.canonical.items[18].learnerAnswer = '   ';
  payload.result.canonical.items[18].responseState = 'blank';
  const html = renderEgeMockResult(payload, null);
  const task1 = html.slice(html.indexOf('Задание 1'), html.indexOf('Задание 2'));
  const task19 = html.slice(html.indexOf('Задание 19'), html.indexOf('Задание 20'));
  assert.match(task1, /Ваш ответ: нет ответа/u);
  assert.doesNotMatch(task1, /Ваш ответ: [^<]*·/u);
  assert.match(task19, /Ваш ответ: нет ответа/u);
});

test('completed speaking review renders a human rubric instead of an internal criteria id', () => {
  const payload = envelope();
  payload.result.canonical.items[38] = {
    ...payload.result.canonical.items[38], status: 'completed', score: 1,
    criteria: [{ name: 'Чтение вслух: произношение и интонация', got: 1, max: 1 }],
    feedback: {
      verdict: 'Предварительная оценка: 1 из 1.',
      nextStep: 'Сохраняйте естественный темп, ударение и интонацию.',
    },
  };
  const speakingItem = {
    position: 39, maximum: 1, status: 'completed', score: 1,
    mode: 'experimental', scoreKind: 'approximate',
  };
  payload.result.speaking.items = { 39: speakingItem };
  payload.speakingAssessment.items = { 39: speakingItem };
  payload.result.canonical.sections.find(({ id }) => id === 'speaking').score = 1;
  payload.result.canonical.score.provisionalSubjectivePrimary = 6;
  payload.result.canonical.score.range = { minimum: 46, maximum: 79 };
  payload.result.canonical.forecast.range = {
    minimum: egeMockForecastScore(46), maximum: egeMockForecastScore(79),
  };
  const html = renderEgeMockResult(payload, null);
  const task39 = html.slice(html.indexOf('Задание 39'), html.indexOf('Задание 40'));
  assert.match(task39, /Чтение вслух: произношение и интонация/u);
  assert.match(task39, /Предварительная оценка: 1 из 1/u);
  assert.doesNotMatch(task39, /speaking-ege-2026-task1-v1/u);
});

test('result UI binds a Speaking score and safe review to completed status', () => {
  const completedWithoutScore = envelope();
  completedWithoutScore.result.canonical.items[38].status = 'completed';
  assert.throws(() => renderEgeMockResult(completedWithoutScore, null), /EGE_MOCK_RESULT_INVALID/u);

  const scoredPending = envelope();
  scoredPending.result.canonical.items[38] = {
    ...scoredPending.result.canonical.items[38], status: 'pending', score: 1,
    criteria: [{ name: 'Чтение вслух: произношение и интонация', got: 1, max: 1 }],
    feedback: {
      verdict: 'Предварительная оценка: 1 из 1.',
      nextStep: 'Сохраняйте естественный темп, ударение и интонацию.',
    },
  };
  scoredPending.result.canonical.sections.find(({ id }) => id === 'speaking').score = 1;
  scoredPending.result.canonical.score.provisionalSubjectivePrimary = 6;
  scoredPending.result.canonical.score.range = { minimum: 46, maximum: 79 };
  scoredPending.result.canonical.forecast.range = {
    minimum: egeMockForecastScore(46), maximum: egeMockForecastScore(79),
  };
  assert.throws(() => renderEgeMockResult(scoredPending, null), /EGE_MOCK_RESULT_INVALID/u);
});

test('result UI binds a Writing score and safe review to completed status', () => {
  const completedWithoutScore = envelope();
  completedWithoutScore.result.canonical.items[36].score = null;
  completedWithoutScore.result.canonical.sections.find(({ id }) => id === 'writing').score = null;
  completedWithoutScore.result.canonical.score.provisionalSubjectivePrimary = null;
  completedWithoutScore.result.canonical.score.range = { minimum: 40, maximum: 80 };
  completedWithoutScore.result.canonical.forecast.range = {
    minimum: egeMockForecastScore(40), maximum: egeMockForecastScore(80),
  };
  assert.throws(() => renderEgeMockResult(completedWithoutScore, null), /EGE_MOCK_RESULT_INVALID/u);

  const scoredPending = envelope();
  scoredPending.result.canonical.items[36].status = 'pending';
  assert.throws(() => renderEgeMockResult(scoredPending, null), /EGE_MOCK_RESULT_INVALID/u);
});

test('result UI rejects top-level assessment controls that contradict canonical sections', () => {
  const invalid = envelope({ writingAssessment: { status: 'completed' } });
  assert.throws(() => renderEgeMockResult(invalid, null), /EGE_MOCK_RESULT_INVALID/u);

  const staleRevision = envelope({ writingAssessment: { status: 'pending', assessmentRevision: 8 } });
  assert.throws(() => renderEgeMockResult(staleRevision, null), /EGE_MOCK_RESULT_INVALID/u,
    'same-status controls still belong to the exact nested assessment revision');

  const speakingItem = {
    position: 39, maximum: 1, status: 'retryable', score: null,
    mode: 'experimental', scoreKind: 'approximate', errorCode: 'provider_timeout',
  };
  const mismatchedFailure = envelope({
    speakingAssessment: {
      status: 'retryable', items: { 39: { ...speakingItem, errorCode: 'provider_unavailable' } },
    },
  });
  mismatchedFailure.result.speaking.items = { 39: speakingItem };
  assert.throws(() => renderEgeMockResult(mismatchedFailure, null), /EGE_MOCK_RESULT_INVALID/u,
    'same-status Speaking controls still belong to the exact nested failure reason');
});

test('result UI fails closed on a mislabeled total instead of displaying contradictory points', () => {
  const invalid = envelope();
  invalid.result.canonical.score.primaryTotal = 82;
  assert.throws(() => renderEgeMockResult(invalid, null), /EGE_MOCK_RESULT_INVALID/u);

  const invalidSection = envelope();
  invalidSection.result.canonical.sections[0].status = 'pending';
  assert.throws(() => renderEgeMockResult(invalidSection, null), /EGE_MOCK_RESULT_INVALID/u,
    'an objective section cannot look pending beside its completed exact items');
});

test('result UI rejects expanded learner text from a subjective result', () => {
  const invalid = envelope();
  invalid.result.canonical.items[36].learnerAnswer = 'Private learner email';
  assert.throws(() => renderEgeMockResult(invalid, null), /EGE_MOCK_RESULT_INVALID/u);
});

test('result UI rejects a completed writing score without its safe rubric review', () => {
  const invalid = envelope();
  delete invalid.result.canonical.items[36].criteria;
  delete invalid.result.canonical.items[36].feedback;
  delete invalid.result.canonical.items[36].evidence;
  assert.throws(() => renderEgeMockResult(invalid, null), /EGE_MOCK_RESULT_INVALID/u);
});

test('result UI rejects a result label that contradicts its immutable mode', () => {
  const invalid = envelope();
  invalid.result.canonical.label = 'Тренировочный повтор';
  assert.throws(() => renderEgeMockResult(invalid, null), /EGE_MOCK_RESULT_INVALID/u);
});

test('training result UI explicitly retains the diagnostic forecast instead of rendering a new one', () => {
  const payload = envelope();
  payload.result.canonical.mode = 'training';
  payload.result.canonical.label = 'Тренировочный повтор';
  payload.result.canonical.forecast = {
    ...payload.result.canonical.forecast,
    score: null, range: null, baselineEligible: false,
  };

  const html = renderEgeMockResult(payload, null);

  assert.match(html, /Прогноз не пересчитывается/u);
  assert.doesNotMatch(html, /49–98/u);
});
