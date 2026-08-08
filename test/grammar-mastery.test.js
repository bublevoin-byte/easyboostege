import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';

const DAY = 86_400_000;
const source = (await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/mu, '')
  .replace(/^export /gmu, '');

function grammarModule() {
  const window = {};
  vm.runInNewContext(source, { window, grammarActivityId, splitLearningActivityDuration, Object, String, Number, Math, Date });
  return window.EasyBoostGrammar;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function scores(correct = 4, total = 4) {
  return Object.fromEntries(['choice', 'input', 'correction', 'transform'].map((type) => [type, { correct, total }]));
}
function session(id, expectedRevision, overrides = {}) {
  return {
    type: 'session_completed', id, expectedRevision, expectedStage: 'learning', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: scores(), ...overrides,
  };
}
function review(id, record, overrides = {}) {
  return {
    type: 'review_completed', id, expectedRevision: record.masteryRevision,
    expectedStage: record.stage, expectedReviewStep: record.reviewStep,
    source: 'builtin', assisted: false, passed: true, ...overrides,
  };
}
function serverReduce(grammar, record, event, now) {
  return grammar.reduceMastery(record, event, { now, clockAuthority: 'server' });
}

test('legacy mastery migration is idempotent, canonical and never overclaims confirmed mastery', () => {
  const grammar = grammarModule();
  const legacy = { st: 2, ok: 14, err: 3, sr: 4, rs: 2, due: 50_000 };
  const migrated = grammar.migrateMasteryRecord(legacy, { now: 10_000 });
  assert.deepEqual(plain(migrated), {
    masteryVersion: 2, masteryRevision: 0, stage: 'learned', reviewStep: 0, highestReviewStep: 0,
    eligibleAt: 50_000,
    stats: { correct: 14, errors: 3, advancedStreak: 4, assistedAttempts: 0 },
    legacy: { st: 2, ok: 14, err: 3, sr: 4, rs: 2, due: 50_000 },
    recentEventIds: [], masteryHistory: [], lastStageAt: null, lastAttemptAt: null,
    lastRegressionReason: null,
  });
  assert.deepEqual(plain(grammar.migrateMasteryRecord(migrated, { now: 99_000 })), plain(migrated));
  assert.equal(grammar.migrateMasteryRecord({ st: 2 }, { now: 77_000 }).eligibleAt, 77_000);
  const repairedStable = grammar.migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: 9, stage: 'stable', reviewStep: 0,
    highestReviewStep: 0, eligibleAt: 123,
  });
  assert.equal(repairedStable.reviewStep, 5);
  assert.equal(repairedStable.highestReviewStep, 5);
  assert.equal(repairedStable.eligibleAt, null);
});

test('the explicit legacy seam ignores canonical-only fields and detects meaningful canonical ownership', () => {
  const grammar = grammarModule();
  const forgedLegacy = grammar.migrateLegacyMasteryRecord({
    masteryVersion: 2, masteryRevision: 99, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: 123, typeScores: scores(),
    st: 1, ok: 2, err: 1, sr: 1, rs: 9, due: 456,
  }, { now: 1_000 });
  assert.equal(forgedLegacy.stage, 'learning');
  assert.equal(forgedLegacy.masteryRevision, 0);
  assert.equal(forgedLegacy.reviewStep, 0);
  assert.equal(forgedLegacy.eligibleAt, null);
  assert.deepEqual(plain(forgedLegacy.legacy), { st: 1, ok: 2, err: 1, sr: 1, rs: 9, due: 456 });
  assert.equal(grammar.hasCanonicalMasteryRecords({}), false);
  assert.equal(grammar.hasCanonicalMasteryRecords({ arbitrary: { stage: 'stable' } }), false);
  assert.equal(grammar.hasCanonicalMasteryRecords({ 1: {} }), true);
});

test('learned requires the explicit threshold independently for all four unassisted built-in types', () => {
  const grammar = grammarModule();
  const learning = grammar.migrateMasteryRecord({ st: 1 }, { now: 1_000 });
  for (const type of grammar.REQUIRED_PRACTICE_TYPES) {
    const below = scores(); below[type] = { correct: 3, total: 4 };
    const result = serverReduce(grammar, learning, session(`00000000-0000-4000-8000-0000000000${type.length}`, 0, { typeScores: below }), 2_000);
    assert.equal(result.stage, 'learning', `${type} has its own threshold`);
  }
  assert.equal(serverReduce(grammar, learning, session('00000000-0000-4000-8000-000000000021', 0, { typeScores: undefined }), 2_000).stage, 'learning');
  assert.equal(serverReduce(grammar, learning, session('00000000-0000-4000-8000-000000000022', 0, { assisted: true }), 2_000).stage, 'learning');
  assert.equal(serverReduce(grammar, learning, session('00000000-0000-4000-8000-000000000023', 0, { source: 'generated' }), 2_000).stage, 'learning');
  const learned = serverReduce(grammar, learning, session('00000000-0000-4000-8000-000000000024', 0), 2_000);
  assert.equal(learned.stage, 'learned');
  assert.equal(learned.masteryRevision, 1);
  assert.equal(learned.eligibleAt, 2_000 + DAY);
});

test('assisted and generated practice is recorded without raising an untouched mastery stage', () => {
  const grammar = grammarModule();
  const untouched = grammar.migrateMasteryRecord({}, { now: 1_000 });
  const assisted = serverReduce(grammar, untouched, session('00000000-0000-4000-8000-000000000119', 0, {
    expectedStage: 'not_started', assisted: true,
  }), 2_000);
  assert.equal(assisted.stage, 'not_started');
  assert.equal(assisted.masteryRevision, 1);
  assert.equal(assisted.stats.assistedAttempts, 1);
  assert.equal(assisted.masteryHistory.at(-1).outcome, 'recorded');

  const generated = serverReduce(grammar, untouched, session('00000000-0000-4000-8000-000000000120', 0, {
    expectedStage: 'not_started', source: 'generated',
  }), 3_000);
  assert.equal(generated.stage, 'not_started');
  assert.equal(generated.masteryRevision, 1);
  assert.equal(generated.masteryHistory.at(-1).outcome, 'recorded');

  const assistedAnswer = grammar.reduceMastery(untouched, {
    type: 'practice_answer', id: 'assisted-answer', assisted: true, correct: true,
  }, { now: 4_000 });
  assert.equal(assistedAnswer.stage, 'not_started');
  assert.equal(assistedAnswer.stats.assistedAttempts, 1);

  const stable = grammar.migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: 4, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: null,
  });
  const generatedFailure = serverReduce(grammar, stable, review(
    '00000000-0000-4000-8000-000000000121', stable,
    { source: 'generated', passed: false, reason: 'agreement' },
  ), 5_000);
  assert.equal(generatedFailure.stage, 'stable');
  assert.equal(generatedFailure.lastRegressionReason, null);
});

test('partial server-owned practice persists evidence but cannot cross the learned gate', () => {
  const grammar = grammarModule();
  const untouched = grammar.migrateMasteryRecord({}, { now: 1_000 });
  const partial = serverReduce(grammar, untouched, session('00000000-0000-4000-8000-000000000025', 0, {
    expectedStage: 'not_started',
    completedTypes: ['choice', 'input'],
    typeScores: { choice: { correct: 3, total: 4 }, input: { correct: 2, total: 3 } },
  }), 2_000);
  assert.equal(partial.stage, 'learning');
  assert.equal(partial.masteryRevision, 1);
  assert.equal(partial.stats.correct, 5);
  assert.equal(partial.stats.errors, 2);
  assert.equal(partial.eligibleAt, null);

  const assisted = serverReduce(grammar, partial, session('00000000-0000-4000-8000-000000000026', 1, {
    assisted: true, completedTypes: ['choice'], typeScores: { choice: { correct: 4, total: 4 } },
  }), 3_000);
  assert.equal(assisted.stage, 'learning');
  assert.equal(assisted.stats.assistedAttempts, 1);
  assert.equal(assisted.stats.correct, 9, 'assisted work remains visible but is not independent proof');
});

test('client time is ignored and early/same-day reviews cannot skip the 1/3/7/16/35 schedule', () => {
  const grammar = grammarModule();
  const learning = grammar.migrateMasteryRecord({ st: 1 }, { now: 1_000 });
  const forged = grammar.reduceMastery(learning, { ...session('00000000-0000-4000-8000-000000000031', 0), at: 9e12 });
  assert.equal(forged.stage, 'learning');
  assert.equal(forged.masteryRevision, 0);

  let state = serverReduce(grammar, learning, session('00000000-0000-4000-8000-000000000032', 0), 1_000);
  state = serverReduce(grammar, state, review('00000000-0000-4000-8000-000000000033', state), state.eligibleAt - 1);
  assert.equal(state.stage, 'learned'); assert.equal(state.reviewStep, 0);
  state = serverReduce(grammar, state, review('00000000-0000-4000-8000-000000000034', state), state.eligibleAt);
  assert.equal(state.stage, 'confirmed'); assert.equal(state.reviewStep, 1);
  for (const interval of [7, 16, 35]) {
    const due = state.eligibleAt;
    state = serverReduce(grammar, state, review(cryptoId(state.masteryRevision), state), due);
    assert.equal(state.eligibleAt, due + interval * DAY);
  }
  state = serverReduce(grammar, state, review(cryptoId(state.masteryRevision), state), state.eligibleAt);
  assert.equal(state.stage, 'stable'); assert.equal(state.reviewStep, 5); assert.equal(state.eligibleAt, null);
});

function cryptoId(number) { return `00000000-0000-4000-8000-${String(100_000_000_000 + number).slice(-12)}`; }

test('revision CAS survives bounded ID rotation and serializes same-time races', () => {
  const grammar = grammarModule();
  const base = grammar.migrateMasteryRecord({ masteryVersion: 2, masteryRevision: 0, stage: 'learned', reviewStep: 0, eligibleAt: 100_000 });
  const firstEvent = review('00000000-0000-4000-8000-000000000041', base);
  let state = serverReduce(grammar, base, firstEvent, 99_999);
  for (let index = 0; index < 70; index += 1) state = serverReduce(grammar, state, review(cryptoId(index + 100), state), 99_999);
  assert.equal(state.recentEventIds.includes(firstEvent.id), false, 'recent IDs remain bounded');
  const replay = serverReduce(grammar, state, firstEvent, 100_000);
  assert.equal(replay.masteryRevision, state.masteryRevision, 'old expectedRevision rejects replay forever');
  assert.equal(replay.reviewStep, 0);

  const eventA = review('00000000-0000-4000-8000-000000000042', state);
  const eventB = review('00000000-0000-4000-8000-000000000043', state);
  const winner = serverReduce(grammar, state, eventA, 100_000);
  const loser = serverReduce(grammar, winner, eventB, 100_000);
  assert.equal(winner.reviewStep, 1);
  assert.equal(loser.masteryRevision, winner.masteryRevision);
  assert.equal(loser.reviewStep, 1);
});

test('assisted review never advances and late error regresses one stage without erasing proof', () => {
  const grammar = grammarModule();
  const confirmed = grammar.migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: 7, stage: 'confirmed', reviewStep: 3,
    highestReviewStep: 3, eligibleAt: 10_000,
    stats: { correct: 20, errors: 2, advancedStreak: 4, assistedAttempts: 0 },
  });
  const assisted = serverReduce(grammar, confirmed, review('00000000-0000-4000-8000-000000000051', confirmed, { assisted: true }), 10_000);
  assert.equal(assisted.stage, 'confirmed'); assert.equal(assisted.reviewStep, 3);
  const assistedFailure = serverReduce(grammar, confirmed, review('00000000-0000-4000-8000-000000000055', confirmed, {
    assisted: true, passed: false, reason: 'confusion_pair',
  }), 10_000);
  assert.equal(assistedFailure.stage, 'confirmed');
  assert.equal(assistedFailure.reviewStep, 3);
  assert.equal(assistedFailure.eligibleAt, 10_000);
  assert.equal(assistedFailure.lastRegressionReason, null);
  const regressed = serverReduce(grammar, assisted, review('00000000-0000-4000-8000-000000000052', assisted, { passed: false, reason: 'confusion_pair' }), 11_000);
  assert.equal(regressed.stage, 'learned');
  assert.equal(regressed.reviewStep, 3, 'prior review proof is retained');
  assert.equal(regressed.highestReviewStep, 3);
  assert.equal(regressed.eligibleAt, 11_000);
  assert.equal(regressed.lastRegressionReason, 'confusion_pair');
  assert.equal(regressed.masteryHistory.length, 2);
});

test('a later unassisted topic error regresses at most one stage and preserves prior proof', () => {
  const grammar = grammarModule();
  const stable = grammar.migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: 9, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: null,
    stats: { correct: 30, errors: 1, advancedStreak: 4, assistedAttempts: 0 },
  });
  const error = session('00000000-0000-4000-8000-000000000053', 9, {
    expectedStage: 'stable', expectedReviewStep: 5,
    completedTypes: ['choice'], typeScores: { choice: { correct: 0, total: 4 } },
    reason: 'auxiliary',
  });
  const regressed = serverReduce(grammar, stable, error, 12_000);
  assert.equal(regressed.stage, 'confirmed');
  assert.equal(regressed.reviewStep, 4);
  assert.equal(regressed.highestReviewStep, 5);
  assert.equal(regressed.eligibleAt, 12_000);
  assert.equal(regressed.lastRegressionReason, 'auxiliary');
  assert.equal(regressed.stats.errors, 5);

  const missingReason = serverReduce(grammar, stable, {
    ...error, id: '00000000-0000-4000-8000-000000000056', reason: undefined,
  }, 12_000);
  assert.equal(missingReason.stage, 'stable', 'missing evidence cannot invent a specific weakness reason');
  assert.equal(missingReason.lastRegressionReason, null);

  const assisted = serverReduce(grammar, stable, { ...error,
    id: '00000000-0000-4000-8000-000000000054', assisted: true,
  }, 12_000);
  assert.equal(assisted.stage, 'stable', 'assisted mistakes are not independent regression proof');
});

test('an unchanged learned-stage practice session is recorded without a false advancement', () => {
  const grammar = grammarModule();
  const learned = grammar.migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: 2, stage: 'learned', reviewStep: 0,
    eligibleAt: 50_000, stats: { correct: 16, errors: 0, advancedStreak: 4, assistedAttempts: 0 },
  });
  const practiced = serverReduce(grammar, learned, session(
    '00000000-0000-4000-8000-000000000057', 2,
    { expectedStage: 'learned', completedTypes: ['choice'], typeScores: { choice: { correct: 1, total: 1 } } },
  ), 10_000);
  assert.equal(practiced.stage, 'learned');
  assert.equal(practiced.masteryHistory.at(-1).outcome, 'recorded');
});

test('mastery view exposes due, next action, regression reason and counts only stable topics', () => {
  const grammar = grammarModule();
  const records = {
    1: { masteryVersion: 2, stage: 'learned', eligibleAt: 100, lastRegressionReason: 'agreement' },
    2: { masteryVersion: 2, stage: 'confirmed', eligibleAt: 900 },
    3: { masteryVersion: 2, stage: 'stable', eligibleAt: null },
  };
  assert.deepEqual(Array.from(grammar.dueTopics(records, { now: 500, topicCount: 3 })), [1]);
  assert.equal(grammar.countStable(records, 3), 1);
  const view = plain(grammar.masteryView(records[1], { now: 500 }));
  assert.equal(view.stage, 'learned'); assert.equal(view.due, true); assert.equal(view.eligibleAt, 100);
  assert.equal(view.regressionReason, 'agreement'); assert.ok(view.label); assert.ok(view.nextLabel);
});

test('all seven regression taxonomy codes have concrete Russian labels and unknown values stay safe', () => {
  const grammar = grammarModule();
  const codes = [
    'construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
    'word_order', 'negation_or_question', 'confusion_pair',
  ];
  for (const code of codes) {
    const label = grammar.regressionReasonLabel(code);
    assert.equal(typeof label, 'string');
    assert.ok(label.length > 5, code);
    assert.notEqual(label, 'нужно подтвердить навык', code);
  }
  assert.equal(grammar.regressionReasonLabel('unrecognized'), 'нужно подтвердить навык');
  assert.equal(grammar.migrateMasteryRecord({
    masteryVersion: 2, stage: 'learned', lastRegressionReason: 'review_error',
  }).lastRegressionReason, null, 'legacy generic reasons cannot mint a specific taxonomy code');
});
