import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/writing.js', import.meta.url), 'utf8');

function createWritingModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean });
  return window.EasyBoostWriting;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('writing module counts words and reports the task volume limits', () => {
  const writing = createWritingModule();

  assert.equal(writing.countWords('  Dear   Emily,\n\nThanks a lot!  '), 5);
  assert.equal(writing.countWords(''), 0);
  assert.equal(writing.countWords(null), 0);

  const short = writing.wordCountStatus(new Array(99).fill('word').join(' '), 37);
  const exact = writing.wordCountStatus(new Array(100).fill('word').join(' '), 37);
  const over = writing.wordCountStatus(new Array(251).fill('word').join(' '), 38);

  assert.deepEqual({ ...short }, { count: 99, range: '100–140', state: 'short', ok: false, hint: 'мало' });
  assert.deepEqual({ ...exact }, { count: 100, range: '100–140', state: 'ok', ok: true, hint: 'в норме' });
  assert.deepEqual({ ...over }, { count: 251, range: '200–250', state: 'over', ok: false, hint: 'превышение' });
  assert.equal(writing.limits(37).maxScore, 6);
  assert.equal(writing.limits(38).maxScore, 14);
});

test('writing module cycles the topic pool and keeps drafts per topic', () => {
  const writing = createWritingModule();
  const topics = writing.pool([{ topic: 'a' }, { topic: 'b' }], [{ topic: 'ai' }]);

  assert.equal(topics.length, 3);
  assert.equal(writing.current(topics, 3).topic, 'a');
  assert.equal(writing.current(topics, 5).topic, 'ai');
  assert.equal(writing.current([], 2), null);
  assert.equal(writing.currentIndex(-1, 3), 2);
  assert.equal(writing.draftKey(38, 5), 'd38_5');
  assert.equal(writing.draftKey(37, undefined), 'd37_0');
});

test('writing module caps history and averages the last five works', () => {
  const writing = createWritingModule();
  let works = [];
  for (let index = 0; index < 32; index += 1) {
    works = writing.appendWork(works, { attemptId: index + 1, t: 38, g: 7, m: 14, n: 220, ts: index });
  }

  assert.equal(works.length, writing.HISTORY_LIMIT);
  assert.equal(works[0].ts, 2);
  assert.deepEqual({ ...writing.summary(works) }, { count: 30, average: 50 });
  assert.deepEqual({ ...writing.summary([]) }, { count: 0, average: 0 });

  const recent = writing.appendWork(works, { attemptId: 99, t: 37, g: 6, m: 6, n: 120, ts: 99 });
  assert.equal(writing.summary(recent).average, 60);
});

test('writing summary excludes legacy client-invented scores without a server attempt', () => {
  const writing = createWritingModule();
  const history = [
    { t: 38, g: 14, m: 14, ts: 1 },
    { attemptId: 41, t: 38, g: 7, m: 14, ts: 2 },
  ];

  assert.deepEqual(plain(writing.serverWorks(history)), [history[1]]);
  assert.deepEqual({ ...writing.summary(history) }, { count: 1, average: 50 });
});

test('writing module derives review totals from criteria when overall score is absent', () => {
  const writing = createWritingModule();

  assert.deepEqual(
    { ...writing.reviewTotals({ criteria: [{ got: 2, max: 3 }, { got: 1, max: 3 }] }) },
    { got: 3, max: 6, percent: 50 },
  );
  assert.deepEqual(
    { ...writing.reviewTotals({ overall_got: 0, overall_max: 0, criteria: [] }) },
    { got: 0, max: 0, percent: 0 },
  );
});

test('writing module reports the evaluated word limit only when the server truncated the answer', () => {
  const writing = createWritingModule();

  assert.equal(writing.evaluationNotice({
    fullWords: 155, evaluatedWords: 140, truncated: true, evaluatedLimit: 140,
  }), 'Из-за превышения объёма оценён официальный фрагмент у границы 140 слов — до целого вопроса.');
  assert.equal(writing.evaluationNotice({
    fullWords: 154, evaluatedWords: 154, truncated: false, evaluatedLimit: 140,
  }), '');
  assert.equal(writing.evaluationNotice(null), '');
});

/* Section 10.1: the payload names the task, it does not describe it. */
test('writing module sends the task identifier instead of the assignment', () => {
  const writing = createWritingModule();

  assert.deepEqual(
    plain(writing.buildPayload(37, { id: 'builtin:writing_37:emily-new-flat', from: 'Emily', stim: 'text?', ask: 'her flat' }, ' answer ')),
    { taskType: 'writing_37', taskId: 'builtin:writing_37:emily-new-flat', answer: ' answer ' },
  );
  assert.deepEqual(
    plain(writing.buildPayload(38, { id: '42', topic: 'Sport', rows: [['Fit', 45]] }, 'answer')),
    { taskType: 'writing_38', taskId: '42', answer: 'answer' },
  );

  /* The assignment must not travel with the answer, whatever the caller passes in. */
  const payload = plain(writing.buildPayload(37, { id: '7', from: 'Emily', stim: 'text?', ask: 'her flat' }, 'answer'));
  assert.deepEqual(Object.keys(payload).sort(), ['answer', 'taskId', 'taskType']);
  assert.equal(plain(writing.buildPayload(37, null, null)).taskId, '', 'без задания идентификатор пустой, а не выдуманный');
});

test('writing module rejects malformed AI-generated topics', () => {
  const writing = createWritingModule();

  assert.equal(writing.normalizeGenerated(37, { from: 'Ben', stim: 'One? Two?', ask: 'dog' }, '5'), null);
  assert.deepEqual(
    plain(writing.normalizeGenerated(37, { from: 'Ben', stim: 'One? Two? Three?', ask: 'dog' }, '5')),
    { id: '5', from: 'Ben', stim: 'One? Two? Three?', ask: 'dog' },
  );
  /* A task without an identifier could never be submitted for marking, so it is not kept. */
  assert.equal(writing.normalizeGenerated(37, { from: 'Ben', stim: 'One? Two? Three?', ask: 'dog' }, ''), null);
  assert.equal(writing.normalizeGenerated(38, { topic: 'T', rows: [['a', 50], ['b', 50], ['c', 0]] }, '6'), null);
  assert.equal(writing.normalizeGenerated(38, { topic: 'T', rows: [['a', 40], ['b', 30], ['c', 20], ['d', 'x']] }, '6'), null);
  assert.deepEqual(
    plain(writing.normalizeGenerated(38, { topic: 'T', rows: [['a', 40], ['b', '30'], ['c', 20], ['d', 10]] }, '6')),
    { id: '6', topic: 'T', rows: [['a', 40], ['b', 30], ['c', 20], ['d', 10]] },
  );
  assert.equal(writing.normalizeGenerated(38, null, '6'), null);
});

test('writing module restores the exact selected task type and keeps draft newlines', () => {
  const writing = createWritingModule();

  assert.equal(writing.selectedTaskType(37), 37);
  assert.equal(writing.selectedTaskType('38'), 38);
  assert.equal(writing.selectedTaskType('unknown'), 38);
  assert.equal(writing.draftText('Dear Ben,\n\nThank you.\nBest wishes,\nAnn'),
    'Dear Ben,\n\nThank you.\nBest wishes,\nAnn');
  assert.equal(writing.draftText(null), '');
});

test('writing module rejects late owner and view generations', () => {
  const writing = createWritingModule();
  const captured = { username: 'owner-a', generation: 4 };

  assert.equal(writing.requestIsCurrent(captured, 8, { username: 'owner-a', generation: 4 }, 8), true);
  assert.equal(writing.requestIsCurrent(captured, 8, { username: 'owner-b', generation: 0 }, 8), false);
  assert.equal(writing.requestIsCurrent(captured, 8, { username: 'owner-a', generation: 5 }, 8), false);
  assert.equal(writing.requestIsCurrent(captured, 8, { username: 'owner-a', generation: 4 }, 9), false);
});

test('writing module classifies failures without inventing scored evidence', () => {
  const writing = createWritingModule();
  const cases = [
    [{ code: 'NETWORK_ERROR', status: 0 }, 'offline', true],
    [{ code: 'REQUEST_TIMEOUT', status: 0 }, 'ambiguous', true],
    [{ code: 'WRITING_EVALUATION_RESPONSE_INVALID', status: 502 }, 'ambiguous', true],
    [{ code: 'AI_UNAVAILABLE', status: 503 }, 'recoverable', true],
    [{ code: 'RATE_LIMITED', status: 429 }, 'rate', true],
    [{ code: 'AI_BUDGET_EXHAUSTED', status: 503 }, 'daily-limit', false],
    [{ code: 'PRIVACY_CONSENT_REQUIRED', status: 403 }, 'consent', false],
    [{ code: 'SUBSCRIPTION_REQUIRED', status: 403 }, 'access', false],
    [{ code: 'CLIENT_UPDATE_REQUIRED', status: 428 }, 'client-update', false],
    [{ code: 'OWNER_CHANGED', status: 409 }, 'authority', false],
    [{ code: 'TASK_TYPE_MISMATCH', status: 400 }, 'task-mismatch', false],
    [{ code: 'VALIDATION_ERROR', status: 422 }, 'validation', false],
    [{ code: 'WRITING_RETRY_LOCK_UNAVAILABLE', status: 0 }, 'retry-storage', false],
    [{ code: 'WRITING_RETRY_STORAGE_FULL', status: 0 }, 'retry-storage-full', false],
    [{ code: 'WRITING_EVALUATION_REPEAT_ACK_NOT_READY', status: 409 }, 'ambiguous', true],
    [{ code: 'WRITING_EVALUATION_REPEAT_ACK_INVALID', status: 409 }, 'validation', false],
    [{ code: 'WRITING_EVALUATION_REPEAT_ACKNOWLEDGED', status: 409 }, 'superseded', false],
    [{ code: 'WRITING_PROGRESS_UNAVAILABLE', status: 503 }, 'progress-pending', true],
    [{ code: 'WRITING_REPLAY_CONTRACT_UNAVAILABLE', status: 503 }, 'progress-pending', true],
  ];

  for (const [error, kind, retryable] of cases) {
    const state = writing.classifyEvaluationFailure(error);
    assert.equal(state.kind, kind);
    assert.equal(state.retryable, retryable);
    assert.equal(Object.hasOwn(state, 'overall_got'), false);
    assert.ok(state.title);
    assert.ok(state.description);
  }
});

test('writing module preserves one exact evaluation identity and deduplicates server evidence', () => {
  const writing = createWritingModule();
  const exact = { taskType: 'writing_37', taskId: 'task-37', answer: 'Dear Ben,\n\nExact newlines.' };

  assert.equal(writing.sameEvaluationPayload(exact, { ...exact }), true);
  assert.equal(writing.sameEvaluationPayload(exact, { ...exact, answer: 'Dear Ben,\nExact newlines.' }), false);
  for (const code of [
    'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TIMEOUT',
    'WRITING_EVALUATION_IN_PROGRESS', 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN',
    'WRITING_EVALUATION_RESPONSE_INVALID', 'WRITING_PROGRESS_UNAVAILABLE',
    'WRITING_REPLAY_CONTRACT_UNAVAILABLE',
  ]) assert.equal(writing.evaluationMayBeInFlight({ code }), true, code);
  assert.equal(writing.evaluationMayBeInFlight({ code: 'AI_UNAVAILABLE', status: 502 }), false);

  const first = writing.appendServerWork([], { attemptId: 17, t: 37, g: 4, m: 6 });
  assert.equal(first.added, true);
  const replay = writing.appendServerWork(first.works, { attemptId: 17, t: 37, g: 4, m: 6 });
  assert.equal(replay.added, false);
  assert.equal(replay.works.length, 1);
  assert.equal(writing.appendServerWork(first.works, { attemptId: 0 }).added, false);

  const migrated = writing.appendServerWork(
    [{ t: 37, g: 1, m: 1 }, { attemptId: 22, t: 37, g: 5, m: 6 }],
    { attemptId: 23, t: 37, g: 6, m: 6 },
  );
  assert.deepEqual(Array.from(migrated.works, (work) => work.attemptId), [22, 23],
    'legacy fabricated rows never occupy authoritative history');

  const warning = 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.';
  const response = {
    contractVersion: 'writing-evaluation-response-v1',
    attemptId: 17,
    provider: 'test',
    review: {
      words: 110, in_range: true, overall_got: 4, overall_max: 6,
      verdict: 'Готово', sub: 'Продолжайте.',
      criteria: [
        { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
        { name: 'Организация текста', got: 1, max: 2 },
        { name: 'Языковое оформление', got: 1, max: 2 },
      ],
      errors: [],
    },
    evaluationScope: { fullWords: 110, evaluatedWords: 110, truncated: false, evaluatedLimit: 140 },
    assessment: { mode: 'experimental', scoreKind: 'approximate', warning },
    voiceTutor: { source: 'writing', attemptId: 17, revision: 1, criterionChoices: [
      { index: 1, label: 'Организация текста' },
      { index: 2, label: 'Языковое оформление' },
    ] },
    writingProgress: {
      version: 'writing-progress-v1', attemptCount: 1, average: 67,
      works: [{ attemptId: 17, t: 37, taskId: 'task-37', g: 4, m: 6, n: 110, ts: 1 }],
      confirmedAttempt: { attemptId: 17, t: 37, taskId: 'task-37', g: 4, m: 6, n: 110, ts: 1 },
    },
  };
  assert.equal(writing.validEvaluationResponse(response, 37, warning, 'task-37'), true);
  const oldReplay = {
    ...response,
    writingProgress: {
      version: 'writing-progress-v1', attemptCount: 31, average: 67,
      works: Array.from({ length: 30 }, (_, index) => ({
        attemptId: 100 + index, t: 37, taskId: `later-${index}`, g: 4, m: 6, n: 110, ts: index + 2,
      })),
      confirmedAttempt: response.writingProgress.confirmedAttempt,
    },
  };
  assert.equal(writing.validEvaluationResponse(oldReplay, 37, warning, 'task-37'), true,
    'an exact replay remains valid after its attempt leaves the bounded recent-work list');
  assert.equal(writing.validEvaluationResponse({ ...response, writingProgress: {
    ...response.writingProgress,
    confirmedAttempt: { ...response.writingProgress.confirmedAttempt, attemptId: 18 },
  } }, 37, warning, 'task-37'), false, 'the authoritative confirmation must match the exact replayed attempt');
  assert.equal(writing.validEvaluationResponse({ ...response, writingProgress: {
    ...response.writingProgress,
    confirmedAttempt: { ...response.writingProgress.confirmedAttempt, g: 3 },
  } }, 37, warning, 'task-37'), false, 'the authoritative confirmation must match the returned review');
  assert.equal(writing.validEvaluationResponse({ ...response, contractVersion: 'writing-evaluation-response-v2' }, 37, warning, 'task-37'), false,
    'an unknown future replay contract fails closed without creating evidence');
  assert.equal(writing.validEvaluationResponse({ ...response, review: {
    ...response.review, overall_got: 99, overall_max: 1, criteria: [], errors: {},
  } }, 37, warning, 'task-37'), false, 'partially-shaped impossible scores never become local evidence');
  assert.equal(writing.validEvaluationResponse({ ...response, writingProgress: null }, 37, warning, 'task-37'), false,
    'local progress is never invented when the authoritative summary is unavailable');

  const invalidResponses = [
    [{ ...response, attemptId: '17' }, 'attemptId is a strict integer'],
    [{ ...response, writingProgress: {
      ...response.writingProgress,
      works: [{ ...response.writingProgress.works[0], t: '37' }],
    } }, 'history task type is not coerced'],
    [{ ...response, writingProgress: {
      ...response.writingProgress,
      works: [{ ...response.writingProgress.works[0], ts: '1' }],
    } }, 'history timestamp is not coerced'],
    [{ ...response, evaluationScope: {
      fullWords: 110, evaluatedWords: 0, truncated: true, evaluatedLimit: 140,
    } }, 'an in-threshold answer cannot claim a truncated arbitrary fragment'],
    [{ ...response, review: { ...response.review, words: 89, in_range: false }, evaluationScope: {
      fullWords: 89, evaluatedWords: 89, truncated: false, evaluatedLimit: 140,
    }, writingProgress: {
      ...response.writingProgress,
      works: [{ ...response.writingProgress.works[0], n: 89 }],
      confirmedAttempt: { ...response.writingProgress.confirmedAttempt, n: 89 },
    } }, 'below 90 percent of the minimum every criterion and the total must be zero'],
    [{ ...response, evaluationScope: {
      fullWords: 155, evaluatedWords: 140, truncated: false, evaluatedLimit: 140,
    }, review: { ...response.review, words: 155, in_range: false }, writingProgress: {
      ...response.writingProgress,
      works: [{ ...response.writingProgress.works[0], n: 155 }],
      confirmedAttempt: { ...response.writingProgress.confirmedAttempt, n: 155 },
    } }, 'an over-threshold answer must carry the official truncated scope'],
    [{ ...response, voiceTutor: {
      ...response.voiceTutor,
      criterionChoices: [{ index: 1, label: 'Организация текста' }, { index: 1, label: 'Организация текста' }],
    } }, 'Voice Tutor criterion pointers are exact, ordered and unique'],
    [{ ...response, voiceTutor: {
      ...response.voiceTutor,
      criterionChoices: [{ index: 2, label: 'Языковое оформление' }, { index: 1, label: 'Организация текста' }],
    } }, 'Voice Tutor criterion pointers use canonical criterion order'],
    [{ ...response, writingProgress: {
      ...response.writingProgress,
      confirmedAttempt: { ...response.writingProgress.confirmedAttempt, taskId: '' },
    } }, 'the exact confirmation cannot carry an empty task identifier'],
    [{ ...response, writingProgress: {
      ...response.writingProgress,
      works: [
        { attemptId: 18, t: 37, taskId: 'later', g: 3, m: 6, n: 110, ts: 2 },
        response.writingProgress.works[0],
      ], attemptCount: 2, average: 58,
    } }, 'recent history is chronological'],
    [{ ...response, writingProgress: { ...response.writingProgress, average: 66 } },
      'recent average is recomputed from the authoritative last five'],
  ];
  for (const [candidate, reason] of invalidResponses) {
    assert.equal(writing.validEvaluationResponse(candidate, 37, warning, 'task-37'), false, reason);
  }
  assert.equal(writing.validEvaluationResponse(response, 37, warning, 'another-task'), false,
    'the confirmed attempt is bound to the exact task being displayed');
});
