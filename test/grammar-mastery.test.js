import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';
import {
  GENERATED_GRAMMAR_REVISION,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ERROR_CODES,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';

const DAY = 86_400_000;
const source = (await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gmu, '')
  .replace(/^export /gmu, '');

function grammarModule() {
  const window = {};
  vm.runInNewContext(source, {
    window, grammarActivityId, splitLearningActivityDuration,
    GENERATED_GRAMMAR_REVISION, GRAMMAR_ACTIVE_PRACTICE_TYPES, GRAMMAR_ERROR_CODES,
    parseGeneratedGrammarItemId, parseGeneratedGrammarItemReference,
    Object, String, Number, Math, Date,
  });
  return window.EasyBoostGrammar;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function historyOutcome(id, type, generated = false) {
  return {
    id, type, transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    ...(generated ? { source: 'generated', revision: 1 } : {}),
  };
}
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

test('different canonical completion material cannot replay through the known FNV-1a-32 collision', () => {
  const grammar = grammarModule();
  const id = '00000000-0000-4000-8000-000000000402';
  const outcome = {
    id: 'core.g.5.c.1', type: 'choice', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  };
  const base = {
    id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false, completedTypes: ['choice'],
    typeScores: { choice: { correct: 1, total: 1 } },
  };
  const makeEvent = (startedAt) => ({
    ...base,
    session: {
      id, scope: 'topic', mode: 'legacy_practice', source: 'builtin',
      catalog: { version: 'grammar-core-v2', revision: 2 },
      items: [outcome], startedAt, assisted: false,
    },
  });
  const eventA = makeEvent(19_181_966_713_209);
  const eventB = makeEvent(288_105_508_095_880);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: eventA }).success, true);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: eventB }).success, true);
  assert.notDeepEqual(eventA, eventB);
  assert.notEqual(grammar.masteryEventReplayFingerprint(eventA), grammar.masteryEventReplayFingerprint(eventB),
    'exact replay identity must distinguish the reproduced 32-bit collision');
  const applied = grammar.reduceMastery(grammar.migrateMasteryRecord(), eventA,
    { now: 300_000_000_000_000, clockAuthority: 'server' });
  assert.equal(grammar.masteryEventReplayMatches(applied, eventA), true);
  assert.equal(grammar.masteryEventReplayMatches(applied, eventB), false,
    'changed canonical material must conflict even when its legacy FNV digest collides');
  const legacyDigestOnly = structuredClone(applied);
  legacyDigestOnly.masteryHistory.at(-1).replayFingerprint = 'fnv1a32:34dfbaf5';
  assert.equal(grammar.masteryEventReplayMatches(grammar.migrateMasteryRecord(legacyDigestOnly), eventA), false,
    'a legacy 32-bit digest alone is never replay authority');
});

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

test('canonical mastery preserves all 32 ordered active-session outcomes across normalization', () => {
  const grammar = grammarModule();
  const items = Array.from({ length: 32 }, (_, index) => ({
    id: `core.g.1.${index % 4 === 0 ? 'c' : index % 4 === 1 ? 'f' : index % 4 === 2 ? 'correction' : 'transform'}.${index + 1}`,
    type: ['choice', 'input', 'correction', 'transform'][index % 4],
    transfer: index % 2 === 1,
    correct: index % 2 === 0,
    diagnosticId: null,
    errorCode: index % 2 === 1 ? 'word_or_verb_form' : null,
    confusionPair: null,
    transferStatus: index % 2 === 1 ? 'due_next_session' : null,
  }));
  const record = {
    masteryVersion: 2, masteryRevision: 1, stage: 'not_started', reviewStep: 0,
    highestReviewStep: 0, eligibleAt: null,
    masteryHistory: [{
      eventId: '00000000-0000-4000-8000-000000000032', type: 'session_completed',
      outcome: 'recorded', at: 2_000,
      session: {
        id: '00000000-0000-4000-8000-000000000032', scope: 'topic', mode: 'topic_practice',
        source: 'builtin', catalog: { version: 'grammar-core-v2', revision: 2 },
        items, startedAt: 1_000, endedAt: 2_000, assisted: true,
      },
    }],
  };
  const once = grammar.migrateMasteryRecord(record, { now: 3_000 });
  const twice = grammar.migrateMasteryRecord(once, { now: 4_000 });
  assert.equal(once.masteryHistory[0].session.items.length, 32);
  assert.deepEqual(plain(twice.masteryHistory[0].session.items), items,
    'reload/replay normalization cannot truncate or reorder canonical outcomes');
  assert.equal(twice.masteryHistory[0].session.items.at(-1).transferStatus, 'due_next_session');
});

test('canonical mastery preserves generated pointer provenance across repeated normalization', () => {
  const grammar = grammarModule();
  const generatedItem = {
    id: `generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.c1`,
    type: 'choice', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    source: 'generated', revision: 1,
  };
  const generatedInputItem = {
    ...generatedItem,
    id: `generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.f1`,
    type: 'input',
  };
  const record = {
    masteryVersion: 2, masteryRevision: 1, stage: 'not_started', reviewStep: 0,
    highestReviewStep: 0, eligibleAt: null,
    masteryHistory: [{
      eventId: '00000000-0000-4000-8000-000000000076', type: 'session_completed',
      outcome: 'recorded', at: 2_000,
      session: {
        id: '00000000-0000-4000-8000-000000000076', scope: 'topic', mode: 'legacy_practice',
        source: 'generated', catalog: { version: 'grammar-core-v2', revision: 2 },
        items: [generatedItem, generatedInputItem], startedAt: 1_000, endedAt: 2_000, assisted: true,
      },
    }],
  };

  const once = grammar.migrateMasteryRecord(record, { now: 3_000 });
  const twice = grammar.migrateMasteryRecord(once, { now: 4_000 });
  assert.deepEqual(plain(twice.masteryHistory[0].session.items), [generatedItem, generatedInputItem],
    'a progress read keeps valid c/choice and f/input generated source/revision');
  assert.deepEqual(plain(twice), plain(once), 'generated provenance normalization is idempotent');
  assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(twice.masteryHistory[0].session)), false,
    'normalization persists only the pointer metadata and bounded outcome');

  const forged = structuredClone(record);
  forged.masteryHistory[0].session.items[0] = {
    ...generatedItem, id: 'core.g.5.c.1', source: 'generated', revision: 1,
  };
  const stripped = grammar.migrateMasteryRecord(forged, { now: 3_000 });
  assert.equal(stripped.masteryHistory[0].session, undefined,
    'a built-in ID cannot leave a generated-looking canonical session during migration');
});

for (const [pointerKind, itemType] of [['c', 'input'], ['f', 'choice']]) {
  test(`canonical normalization strips generated .${pointerKind} provenance from ${itemType} history`, () => {
    const grammar = grammarModule();
    const eventId = `00000000-0000-4000-8000-00000000008${pointerKind === 'c' ? '1' : '2'}`;
    const record = {
      masteryVersion: 2, masteryRevision: 1, stage: 'not_started', reviewStep: 0,
      highestReviewStep: 0, eligibleAt: null, recentEventIds: [eventId],
      masteryHistory: [{
        eventId,
        type: 'session_completed', outcome: 'recorded', at: 2_000,
        session: {
          id: `00000000-0000-4000-8000-00000000008${pointerKind === 'c' ? '1' : '2'}`,
          scope: 'topic', mode: 'legacy_practice', source: 'generated',
          catalog: { version: 'grammar-core-v2', revision: 2 },
          items: [{
            id: `generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.${pointerKind}1`,
            type: itemType, transfer: false, correct: true,
            diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
            source: 'generated', revision: 1,
          }],
          startedAt: 1_000, endedAt: 2_000, assisted: true,
        },
      }],
    };
    const invalidEvent = {
      id: eventId, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'generated', assisted: true, completedTypes: [itemType],
      typeScores: { [itemType]: { correct: 1, total: 1 } },
      session: structuredClone(record.masteryHistory[0].session),
    };
    record.masteryHistory[0].replayFingerprint = grammar.masteryEventReplayFingerprint(invalidEvent);

    const once = grammar.migrateMasteryRecord(record, { now: 3_000 });
    const twice = grammar.migrateMasteryRecord(once, { now: 4_000 });
    assert.equal(once.masteryHistory[0].session, undefined,
      'the whole contradictory session is removed from canonical history');
    assert.equal(grammar.masteryEventReplayMatches(once, invalidEvent), false,
      'a contradictory persisted pointer cannot authorize an exact generated replay');
    assert.deepEqual(plain(twice), plain(once), 'mismatch stripping stays idempotent');
  });
}

test('canonical normalization preserves exact valid builtin, generated and mixed composition', () => {
  const grammar = grammarModule();
  const generatedChoice = historyOutcome(
    `generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.c1`, 'choice', true,
  );
  const builtinChoice = historyOutcome('core.g.5.c.1', 'choice');
  const sessions = [
    { source: 'builtin', assisted: false, items: [builtinChoice] },
    { source: 'builtin', assisted: true, items: [builtinChoice] },
    { source: 'generated', assisted: true, items: [generatedChoice] },
    { source: 'mixed', assisted: true, items: [builtinChoice, generatedChoice] },
  ];
  const record = {
    masteryVersion: 2, masteryRevision: 1, stage: 'not_started', reviewStep: 0,
    highestReviewStep: 0, eligibleAt: null,
    masteryHistory: sessions.map((session, index) => ({
      eventId: `00000000-0000-4000-8000-${String(91 + index).padStart(12, '0')}`,
      type: 'session_completed', outcome: 'recorded', at: 2_000 + index,
      session: {
        id: `00000000-0000-4000-8000-${String(91 + index).padStart(12, '0')}`,
        scope: 'topic', mode: 'legacy_practice',
        catalog: { version: 'grammar-core-v2', revision: 2 },
        startedAt: 1_000, endedAt: 2_000 + index, ...session,
      },
    })),
  };

  const once = grammar.migrateMasteryRecord(record, { now: 3_000 });
  const twice = grammar.migrateMasteryRecord(once, { now: 4_000 });
  assert.deepEqual(once.masteryHistory.map((entry) => (
    [entry.session.source, entry.session.assisted, entry.session.items.length]
  )), [['builtin', false, 1], ['builtin', true, 1], ['generated', true, 1], ['mixed', true, 2]]);
  assert.deepEqual(plain(twice), plain(once), 'every valid source composition stays idempotent');
});

for (const [label, session] of [
  ['builtin source with generated participation', {
    source: 'builtin', assisted: false,
    items: [historyOutcome(`generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.c1`, 'choice', true)],
  }],
  ['generated source with only built-in items', {
    source: 'generated', assisted: true, items: [historyOutcome('core.g.5.c.1', 'choice')],
  }],
  ['mixed source without both provenance families', {
    source: 'mixed', assisted: true,
    items: [historyOutcome(`generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.c1`, 'choice', true)],
  }],
  ['unassisted generated participation', {
    source: 'generated', assisted: false,
    items: [historyOutcome(`generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.c1`, 'choice', true)],
  }],
]) {
  test(`canonical normalization rejects ${label}`, () => {
    const grammar = grammarModule();
    const eventId = `00000000-0000-4000-8000-0000000001${String(label.length).padStart(2, '0')}`;
    const canonicalSession = {
      id: eventId, scope: 'topic', mode: 'legacy_practice',
      catalog: { version: 'grammar-core-v2', revision: 2 },
      startedAt: 1_000, endedAt: 2_000, ...session,
    };
    const typeScores = Object.fromEntries([...new Set(session.items.map((item) => item.type))].map((type) => {
      const total = session.items.filter((item) => item.type === type).length;
      return [type, { correct: total, total }];
    }));
    const invalidEvent = {
      id: eventId, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: session.source, assisted: session.assisted,
      completedTypes: Object.keys(typeScores), typeScores, session: canonicalSession,
    };
    const record = {
      masteryVersion: 2, masteryRevision: 1, stage: 'not_started', reviewStep: 0,
      highestReviewStep: 0, eligibleAt: null, recentEventIds: [eventId],
      masteryHistory: [{
        eventId, type: 'session_completed', outcome: 'recorded', at: 2_000,
        replayFingerprint: grammar.masteryEventReplayFingerprint(invalidEvent),
        session: canonicalSession,
      }],
    };

    const once = grammar.migrateMasteryRecord(record, { now: 3_000 });
    const twice = grammar.migrateMasteryRecord(once, { now: 4_000 });
    assert.equal(once.masteryHistory[0].session, undefined);
    assert.equal(grammar.masteryEventReplayMatches(once, invalidEvent), false,
      'contradictory session provenance cannot authorize replay');
    assert.deepEqual(plain(twice), plain(once), 'rejection stays idempotent');
  });
}

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

test('assistance never advances while a pre-disclosure late review error regresses one stage', () => {
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
  const regressed = serverReduce(grammar, assisted, review('00000000-0000-4000-8000-000000000052', assisted, {
    assisted: true, passed: false,
    independentError: {
      itemId: 'core.g.1.c.1', diagnosticId: 'core.g.1.c.1.diagnostic.1',
      reason: 'confusion_pair', confusionPair: 'present_perfect__past_simple',
    },
  }), 11_000);
  assert.equal(regressed.stage, 'learned');
  assert.equal(regressed.reviewStep, 3, 'prior review proof is retained');
  assert.equal(regressed.highestReviewStep, 3);
  assert.equal(regressed.eligibleAt, 11_000);
  assert.equal(regressed.lastRegressionReason, 'confusion_pair');
  assert.equal(regressed.masteryHistory.length, 2);
});

test('a later independently committed topic error regresses despite subsequent disclosure', () => {
  const grammar = grammarModule();
  const stable = grammar.migrateMasteryRecord({
    masteryVersion: 2, masteryRevision: 9, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: null,
    stats: { correct: 30, errors: 1, advancedStreak: 4, assistedAttempts: 0 },
  });
  const error = session('00000000-0000-4000-8000-000000000053', 9, {
    expectedStage: 'stable', expectedReviewStep: 5,
    completedTypes: ['choice'], typeScores: { choice: { correct: 0, total: 4 } },
    assisted: true,
    independentError: {
      itemId: 'core.g.1.f.1', diagnosticId: null,
      reason: 'auxiliary', confusionPair: null,
    },
    session: {
      items: [{
        id: 'core.g.1.f.1', type: 'input', transfer: false, correct: false,
        diagnosticId: null, errorCode: 'auxiliary', confusionPair: null, transferStatus: null,
      }],
    },
  });
  const regressed = serverReduce(grammar, stable, error, 12_000);
  assert.equal(regressed.stage, 'confirmed');
  assert.equal(regressed.reviewStep, 4);
  assert.equal(regressed.highestReviewStep, 5);
  assert.equal(regressed.eligibleAt, 12_000);
  assert.equal(regressed.lastRegressionReason, 'auxiliary');
  assert.equal(regressed.stats.errors, 5);

  const missingReason = structuredClone(error);
  missingReason.id = '00000000-0000-4000-8000-000000000056';
  delete missingReason.independentError;
  const missingEvidence = serverReduce(grammar, stable, missingReason, 12_000);
  assert.equal(missingEvidence.stage, 'stable', 'missing evidence cannot invent a specific weakness reason');
  assert.equal(missingEvidence.lastRegressionReason, null);

  const preAssisted = structuredClone(error);
  preAssisted.id = '00000000-0000-4000-8000-000000000054';
  delete preAssisted.independentError;
  const assisted = serverReduce(grammar, stable, preAssisted, 12_000);
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
