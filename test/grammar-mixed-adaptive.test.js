import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import express from 'express';

import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import { EasyBoostGrammar } from '../public/modules/grammar.js';
import { createProgressRoutes } from '../routes/progress.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';
import { compileOpenApiSchema } from './support/openapi-schema-evaluator.js';

const PRACTICE_TYPES = ['choice', 'input', 'correction', 'transform'];

function historyRecord(topicId, { item, at, eligibleAt = null } = {}) {
  const selected = item || GRAMMAR_CATALOG.bank[topicId].c[0];
  const diagnostic = selected.type === 'choice'
    ? selected.diagnostics.find(Boolean)
    : null;
  return EasyBoostGrammar.migrateMasteryRecord({
    masteryVersion: 2,
    masteryRevision: 3,
    stage: 'learned',
    reviewStep: 0,
    highestReviewStep: 0,
    eligibleAt,
    stats: { correct: 10, errors: 2, advancedStreak: 0, assistedAttempts: 1 },
    legacy: { st: 2, ok: 10, err: 2, sr: 0, rs: 0, due: 0 },
    recentEventIds: [],
    masteryHistory: [{
      eventId: `00000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`,
      type: 'session_completed',
      replayFingerprint: null,
      at,
      outcome: 'recorded',
      fromStage: 'learned',
      toStage: 'learned',
      reviewStep: 0,
      session: {
        id: `10000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`,
        scope: 'topic', mode: 'topic_practice', source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items: [{
          id: selected.id, type: selected.type, transfer: false, correct: false,
          diagnosticId: diagnostic?.id || null,
          errorCode: diagnostic?.errorCode || selected.errorSkill,
          confusionPair: diagnostic?.confusionPair || selected.confusionPair || null,
          transferStatus: null,
        }],
        startedAt: at - 1_000, assisted: true, endedAt: at,
      },
    }],
    lastStageAt: at - 10_000,
    lastAttemptAt: at,
    lastRegressionReason: diagnostic?.errorCode || selected.errorSkill,
  }, { now: at });
}

test('mixed selector balances all four types, topics, novelty and exact weaknesses without generated content', () => {
  const records = {
    3: historyRecord(3, { at: 2_000 }),
    18: historyRecord(18, { at: 3_000 }),
  };
  const first = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, records, { seed: 'mixed-public-seam' },
  );
  const replay = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, records, { seed: 'mixed-public-seam' },
  );

  assert.deepEqual(first.map((item) => item.q.id), replay.map((item) => item.q.id));
  assert.equal(first.length, 16);
  assert.deepEqual(Object.fromEntries(PRACTICE_TYPES.map((type) => [
    type, first.filter((item) => item.k === type).length,
  ])), { choice: 4, input: 4, correction: 4, transform: 4 });
  const topicCounts = new Map();
  for (const item of first) {
    topicCounts.set(item.t, (topicCounts.get(item.t) || 0) + 1);
    assert.equal(item.source, 'builtin');
    assert.equal(item.transfer, false);
  }
  assert.ok(topicCounts.size >= 8, 'mixed practice must not collapse into a few named topics');
  assert.ok(Math.max(...topicCounts.values()) <= 2, 'one topic cannot dominate the mixed set');
  assert.ok(first.some((item) => [3, 18].includes(item.t)), 'recent weaknesses affect selection');
});

test('targeted selector uses one exact server focus, stays bounded and never admits generated material', () => {
  const item = GRAMMAR_CATALOG.bank[3].c[0];
  const diagnostic = item.diagnostics.find(Boolean);
  const focus = {
    version: 'grammar-focus-v1', topicId: 3,
    errorCode: diagnostic.errorCode,
    confusionPair: diagnostic.confusionPair || null,
  };
  const queue = EasyBoostGrammar.buildTargetedPracticeQueue(
    GRAMMAR_CATALOG.bank, focus, { seed: 'targeted-public-seam' },
  );

  assert.equal(queue.length, 8);
  assert.ok(queue.every((entry) => entry.t === 3 && entry.source === 'builtin'));
  assert.equal(new Set(queue.map((entry) => entry.q.id)).size, queue.length);
  assert.ok(queue.some((entry) => entry.q.type === 'choice'
    && entry.q.diagnostics.some((candidate) => candidate?.errorCode === focus.errorCode
      && (candidate.confusionPair || null) === focus.confusionPair)));
  const supportsError = (entry) => entry.q.type === 'choice'
    ? entry.q.diagnostics.some((candidate) => candidate?.errorCode === focus.errorCode)
    : entry.q.errorSkill === focus.errorCode;
  const supportsExact = (entry) => supportsError(entry)
    && (entry.q.type === 'choice'
      ? entry.q.diagnostics.some((candidate) => candidate?.errorCode === focus.errorCode
        && (candidate.confusionPair || null) === focus.confusionPair)
      : (entry.q.confusionPair || null) === focus.confusionPair);
  assert.ok(queue.filter(supportsExact).length >= 2,
    'a usable targeted set reserves at least two original recall items for the exact weakness');
  assert.ok(queue.filter(supportsError).length >= 4,
    'at least half of a usable targeted set stays inside the exact error family');

  const sparse = EasyBoostGrammar.buildTargetedPracticeQueue(GRAMMAR_CATALOG.bank, {
    topicId: 19, errorCode: 'confusion_pair',
    confusionPair: 'clause_connector__phrase_connector',
  }, { seed: 'targeted-sparse-public-seam' });
  assert.deepEqual(sparse, [],
    'the selector fails closed instead of presenting a nominal one-of-eight exact focus');
});

test('generated-only history cannot steer the mixed selector', () => {
  const generated = historyRecord(3, { at: 9_000 });
  generated.stage = 'not_started';
  generated.eligibleAt = null;
  generated.masteryHistory[0].session.source = 'generated';
  generated.masteryHistory[0].session.items[0] = {
    ...generated.masteryHistory[0].session.items[0],
    id: `generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.c1`,
    source: 'generated', revision: 1,
  };
  const baseline = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, {}, { seed: 'generated-quarantine' },
  );
  const quarantined = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, { 3: generated }, { seed: 'generated-quarantine' },
  );
  assert.deepEqual(quarantined.map((item) => item.q.id), baseline.map((item) => item.q.id));
});

test('per-topic copies of one mixed event do not multiply local weakness weights', () => {
  const mixedRecord = historyRecord(3, { at: 2_000 });
  const mixedEntry = mixedRecord.masteryHistory[0];
  mixedEntry.eventId = '00000000-0000-4000-8000-000000000333';
  mixedEntry.session.id = mixedEntry.eventId;
  mixedEntry.session.scope = 'mixed';
  mixedEntry.session.mode = 'mixed_practice';
  mixedEntry.session.items[0].topicId = 3;
  const once = { 3: mixedRecord };
  for (const topicId of [4, 5, 6, 7]) {
    const topicRecord = historyRecord(topicId, { at: 3_000 + topicId });
    const repeated = structuredClone(topicRecord.masteryHistory[0]);
    repeated.eventId = `00000000-0000-4000-8000-${String(500 + topicId).padStart(12, '0')}`;
    repeated.session.id = repeated.eventId;
    repeated.at += 1;
    topicRecord.masteryHistory.push(repeated);
    once[topicId] = topicRecord;
  }
  const copied = structuredClone(once);
  for (const topicId of [4, 5, 6, 7]) {
    copied[topicId].masteryHistory.unshift(structuredClone(mixedEntry));
  }
  for (const topicId of [8, 9, 10]) copied[topicId] = structuredClone(mixedRecord);

  const selectedOnce = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, once, { seed: 'dedupe-0', now: 4_000 },
  );
  const selectedFromCopies = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, copied, { seed: 'dedupe-0', now: 4_000 },
  );
  assert.deepEqual(selectedFromCopies.map((entry) => entry.q.id), selectedOnce.map((entry) => entry.q.id),
    'storage fan-out must not change mixed-practice frequency ranking');
});

test('mixed and targeted recall changes only eligible later-stage mastery, never early learning', () => {
  const now = 10_000;
  const record = historyRecord(3, { at: 2_000 });
  record.stage = 'learning';
  record.eligibleAt = null;
  const records = [EasyBoostGrammar.migrateMasteryRecord(null, { now }), record];
  for (const [recordIndex, current] of records.entries()) {
    for (const mode of ['mixed_practice', 'targeted_practice']) {
      const id = mode === 'mixed_practice'
        ? `20000000-0000-4000-8000-00000000000${recordIndex * 2 + 1}`
        : `20000000-0000-4000-8000-00000000000${recordIndex * 2 + 2}`;
      const event = {
        id, type: 'session_completed', expectedRevision: current.masteryRevision,
        expectedStage: current.stage, expectedReviewStep: current.reviewStep,
        source: 'builtin', assisted: false,
        completedTypes: PRACTICE_TYPES,
        typeScores: Object.fromEntries(PRACTICE_TYPES.map((type) => [type, { correct: 4, total: 4 }])),
        session: {
          id, scope: mode === 'mixed_practice' ? 'mixed' : 'topic', mode, source: 'builtin',
          catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
          items: [], startedAt: now - 1_000, assisted: false,
        },
      };
      const next = EasyBoostGrammar.reduceMastery(current, event, {
        now, clockAuthority: 'server', topicId: 3,
      });
      assert.equal(next.stage, current.stage);
      assert.equal(next.reviewStep, 0);
      assert.equal(next.eligibleAt, current.eligibleAt);
    }
  }

  const due = historyRecord(3, { at: 2_000, eligibleAt: now });
  const targetedQueue = EasyBoostGrammar.buildTargetedPracticeQueue(GRAMMAR_CATALOG.bank, {
    topicId: 3, errorCode: 'word_or_verb_form', confusionPair: null,
  }, { seed: 'targeted-due-recall' });
  const targeted = completionEvent(targetedQueue, {
    id: '20000000-0000-4000-8000-000000000009',
    mode: 'targeted_practice', topicId: 3,
  }).event;
  Object.assign(targeted, {
    expectedRevision: due.masteryRevision,
    expectedStage: due.stage,
    expectedReviewStep: due.reviewStep,
  });
  const reviewed = EasyBoostGrammar.reduceMastery(due, targeted, {
    now, clockAuthority: 'server', topicId: 3,
  });
  assert.equal(reviewed.stage, 'confirmed');
  assert.equal(reviewed.reviewStep, 1);
  assert.equal(reviewed.eligibleAt, now + 3 * 86_400_000);

  const mixedQueue = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, {}, { seed: 'mixed-due-recall', now },
  );
  const mixedTopic = mixedQueue[0].t;
  const mixedDue = historyRecord(mixedTopic, { at: 2_000, eligibleAt: now });
  const mixed = completionEvent(mixedQueue, {
    id: '20000000-0000-4000-8000-000000000010',
    mode: 'mixed_practice', topicId: mixedTopic,
  }).event;
  Object.assign(mixed, {
    expectedRevision: mixedDue.masteryRevision,
    expectedStage: mixedDue.stage,
    expectedReviewStep: mixedDue.reviewStep,
  });
  const mixedReviewed = EasyBoostGrammar.reduceMastery(mixedDue, mixed, {
    now, clockAuthority: 'server', topicId: mixedTopic,
  });
  assert.equal(mixedReviewed.stage, 'confirmed');
  assert.equal(mixedReviewed.reviewStep, 1);
});

function targetedBinding(focus, queue) {
  return {
    pointer: {
      version: 'grammar-focus-v1',
      catalogVersion: GRAMMAR_CATALOG.version,
      catalogRevision: GRAMMAR_CATALOG.revision,
      topicId: focus.topicId,
      errorCode: focus.errorCode,
      confusionPair: focus.confusionPair || null,
      masteryRevision: 0,
      eligibleAt: null,
      earlyPractice: false,
      stateFingerprint: 'a'.repeat(64),
      ref: 'b'.repeat(64),
    },
    itemIds: queue.map((entry) => entry.q.id),
    completionToken: 'c'.repeat(43),
  };
}

function completionEvent(queue, { id, mode, topicId, recommendation = null }) {
  const items = queue.map((entry) => ({
    id: entry.q.id,
    ...(mode === 'mixed_practice' ? { topicId: entry.t } : {}),
    type: entry.k, transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  }));
  const completedTypes = [...new Set(items.map((item) => item.type))];
  const typeScores = Object.fromEntries(completedTypes.map((type) => {
    const total = items.filter((item) => item.type === type).length;
    return [type, { correct: total, total }];
  }));
  return {
    topicId,
    event: {
      id, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes, typeScores,
      session: {
        id, scope: mode === 'mixed_practice' ? 'mixed' : 'topic', mode,
        source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items, startedAt: 1_000, assisted: false,
        ...(mode === 'mixed_practice' ? {
          topicExpectations: [...new Set(items.filter((item) => !item.transfer)
            .map((item) => item.topicId))].map((selectedTopicId) => ({
            topicId: selectedTopicId,
            expectedRevision: 0,
            expectedStage: 'not_started',
            expectedReviewStep: 0,
          })),
        } : {}),
        ...(mode === 'targeted_practice' && recommendation ? { recommendation } : {}),
      },
    },
  };
}

function withOneSuccessfulTransfer(payload, queue) {
  const changed = structuredClone(payload);
  const selected = queue[0];
  const outcome = changed.event.session.items[0];
  const diagnostic = selected.q.type === 'choice'
    ? selected.q.diagnostics.find(Boolean) : null;
  outcome.correct = false;
  outcome.diagnosticId = diagnostic?.id || null;
  outcome.errorCode = diagnostic?.errorCode || selected.q.errorSkill;
  outcome.confusionPair = diagnostic?.confusionPair || selected.q.confusionPair || null;
  const levelKey = {
    choice: 'c', input: 'f', correction: 'correction', transform: 'transform',
  }[selected.q.type];
  const transfer = GRAMMAR_CATALOG.bank[selected.t][levelKey]
    .find((item) => item.id !== selected.q.id && item.transferPair === selected.q.transferPair);
  changed.event.session.items.splice(1, 0, {
    id: transfer.id,
    ...(changed.event.session.scope === 'mixed' ? { topicId: selected.t } : {}),
    type: transfer.type, transfer: true, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  });
  changed.event.typeScores[selected.q.type].total += 1;
  changed.event.assisted = true;
  changed.event.session.assisted = true;
  const independent = {
    itemId: outcome.id,
    diagnosticId: outcome.diagnosticId,
    reason: outcome.errorCode,
    confusionPair: outcome.confusionPair,
  };
  if (changed.event.session.scope === 'mixed') {
    changed.event.independentErrors = [{ topicId: selected.t, ...independent }];
  } else {
    changed.event.independentError = independent;
  }
  return changed;
}

test('server schema stores balanced mixed and bounded targeted history without granting topic-proof semantics', () => {
  const mixed = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, {}, { seed: 'mixed-schema' },
  );
  const mixedPayload = completionEvent(mixed, {
    id: '50000000-0000-4000-8000-000000000001',
    mode: 'mixed_practice', topicId: mixed[0].t,
  });
  assert.equal(grammarMasteryEventSchema.safeParse(mixedPayload).success, true);

  const withoutOwner = structuredClone(mixedPayload);
  delete withoutOwner.event.session.items[0].topicId;
  assert.equal(grammarMasteryEventSchema.safeParse(withoutOwner).success, false,
    'every mixed outcome is bound to its catalog topic');

  const targetedFocus = {
    topicId: 3, errorCode: 'word_or_verb_form', confusionPair: null,
  };
  const targeted = EasyBoostGrammar.buildTargetedPracticeQueue(GRAMMAR_CATALOG.bank,
    targetedFocus, { seed: 'targeted-schema' });
  const targetedPayload = completionEvent(targeted, {
    id: '50000000-0000-4000-8000-000000000002',
    mode: 'targeted_practice', topicId: 3,
    recommendation: targetedBinding(targetedFocus, targeted),
  });
  assert.equal(grammarMasteryEventSchema.safeParse(targetedPayload).success, true);

  const missingRecommendation = structuredClone(targetedPayload);
  delete missingRecommendation.event.session.recommendation;
  assert.equal(grammarMasteryEventSchema.safeParse(missingRecommendation).success, false,
    'targeted completion is not accepted without its exact server-issued binding');

  const substitutedRecommendation = structuredClone(targetedPayload);
  substitutedRecommendation.event.session.recommendation.itemIds[0] = targeted[1].q.id;
  assert.equal(grammarMasteryEventSchema.safeParse(substitutedRecommendation).success, false,
    'the recommendation item whitelist and submitted originals are the same exact sequence');

  const generatedSubstitution = structuredClone(targetedPayload);
  generatedSubstitution.event.source = 'generated';
  generatedSubstitution.event.session.source = 'generated';
  assert.equal(grammarMasteryEventSchema.safeParse(generatedSubstitution).success, false,
    'generated content is quarantined from mixed and targeted evidence');
});

test('one mixed late error regresses its exact topic rather than the history anchor topic', () => {
  const now = 20_000;
  const queue = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, {}, { seed: 'mixed-exact-topic-regression', now },
  );
  const payload = withOneSuccessfulTransfer(completionEvent(queue, {
    id: '50000000-0000-4000-8000-000000000003',
    mode: 'mixed_practice', topicId: queue[0].t,
  }), queue);
  const affectedTopic = payload.event.independentErrors[0].topicId;
  const stable = historyRecord(affectedTopic, { at: 2_000, eligibleAt: null });
  stable.stage = 'stable';
  stable.reviewStep = 5;
  stable.highestReviewStep = 5;
  const expectation = payload.event.session.topicExpectations
    .find((entry) => entry.topicId === affectedTopic);
  Object.assign(expectation, {
    expectedRevision: stable.masteryRevision,
    expectedStage: stable.stage,
    expectedReviewStep: stable.reviewStep,
  });
  Object.assign(payload.event, {
    expectedRevision: expectation.expectedRevision,
    expectedStage: expectation.expectedStage,
    expectedReviewStep: expectation.expectedReviewStep,
  });

  const regressed = EasyBoostGrammar.reduceMastery(stable, payload.event, {
    now, clockAuthority: 'server', topicId: affectedTopic,
  });
  assert.equal(regressed.stage, 'confirmed');
  assert.equal(regressed.reviewStep, 4);
  assert.equal(regressed.eligibleAt, now);
  assert.equal(regressed.lastRegressionReason, payload.event.independentErrors[0].reason);
});

test('mixed completion expands into one owner-bound atomic persistence batch for its exact topics', async () => {
  const queue = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, {}, { seed: 'mixed-atomic-route' },
  );
  const payload = completionEvent(queue, {
    id: '50000000-0000-4000-8000-000000000004',
    mode: 'mixed_practice', topicId: queue[0].t,
  });
  let persisted = null;
  const db = {
    async applyGrammarMasteryEvents(owner, entries) {
      assert.equal(owner, 'mixed-owner');
      persisted = structuredClone(entries);
      return entries.map(({ topicId, event }) => ({
        eventId: event.id, applied: true, conflict: false, replay: false,
        record: EasyBoostGrammar.migrateMasteryRecord({
          masteryRevision: event.expectedRevision + 1,
          stage: event.expectedStage,
          reviewStep: event.expectedReviewStep,
          recentEventIds: [event.id],
        }),
        topicId,
      }));
    },
  };
  const authentication = {
    auth(req, _res, next) { req.user = req.headers['x-test-user']; next(); },
  };
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({ authentication, db }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/grammar/mastery-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'mixed-owner',
        'x-easyboost-expected-owner': 'mixed-owner',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    const topics = [...new Set(queue.map((entry) => entry.t))];
    assert.deepEqual(persisted.map((entry) => entry.topicId), topics);
    assert.equal(new Set(persisted.map((entry) => entry.event.id)).size, 1,
      'one mixed session retains one stable replay identity across topic records');
    assert.deepEqual(persisted.map(({ topicId, event }) => ({
      topicId,
      expectedRevision: event.expectedRevision,
      expectedStage: event.expectedStage,
      expectedReviewStep: event.expectedReviewStep,
    })), payload.event.session.topicExpectations);
    assert.deepEqual(body.results.map((entry) => entry.topicId), topics);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OpenAPI executes the same mixed and targeted mastery envelopes as runtime validation', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const batchOperation = openapi.match(
    /  \/api\/v1\/grammar\/mastery-events\/batch:[\s\S]*?(?=\n  \/api\/v1\/reading\/report:)/u,
  )?.[0] || '';
  const batchCreated = batchOperation.match(/        '201':[\s\S]*?(?=\n        '200':)/u)?.[0] || '';
  const batchReplay = batchOperation.match(/        '200':[\s\S]*?(?=\n        '400':)/u)?.[0] || '';
  for (const response of [batchCreated, batchReplay]) {
    assert.match(response, /headers:\s*\n\s*X-EasyBoost-Response-Owner:/u,
      'each successful batch response documents the runtime owner-binding header');
  }
  const validate = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const mixed = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, {}, { seed: 'mixed-openapi' },
  );
  const mixedPayload = completionEvent(mixed, {
    id: '50000000-0000-4000-8000-000000000011',
    mode: 'mixed_practice', topicId: mixed[0].t,
  });
  assert.equal(validate(mixedPayload), true, JSON.stringify(validate.errors));
  const failedMixedPayload = withOneSuccessfulTransfer(mixedPayload, mixed);
  assert.equal(grammarMasteryEventSchema.safeParse(failedMixedPayload).success, true);
  assert.equal(validate(failedMixedPayload), true, JSON.stringify(validate.errors));

  const targetedFocus = {
    topicId: 3, errorCode: 'word_or_verb_form', confusionPair: null,
  };
  const targeted = EasyBoostGrammar.buildTargetedPracticeQueue(GRAMMAR_CATALOG.bank,
    targetedFocus, { seed: 'targeted-openapi' });
  const targetedPayload = completionEvent(targeted, {
    id: '50000000-0000-4000-8000-000000000012',
    mode: 'targeted_practice', topicId: 3,
    recommendation: targetedBinding(targetedFocus, targeted),
  });
  assert.equal(validate(targetedPayload), true, JSON.stringify(validate.errors));
  const staleTargetedPayload = structuredClone(targetedPayload);
  staleTargetedPayload.event.expectedRevision += 1;
  assert.equal(validate(staleTargetedPayload), false,
    'OpenAPI binds a signed targeted focus to its exact mastery revision');
  const failedTargetedPayload = withOneSuccessfulTransfer(targetedPayload, targeted);
  assert.equal(grammarMasteryEventSchema.safeParse(failedTargetedPayload).success, true);
  assert.equal(validate(failedTargetedPayload), true, JSON.stringify(validate.errors));

  const crossTopicTargeted = structuredClone(targetedPayload);
  const firstTargeted = crossTopicTargeted.event.session.items[0];
  const bankKey = {
    choice: 'c', input: 'f', correction: 'correction', transform: 'transform',
  }[firstTargeted.type];
  firstTargeted.id = GRAMMAR_CATALOG.bank[4][bankKey][0].id;
  assert.equal(grammarMasteryEventSchema.safeParse(crossTopicTargeted).success, false);
  assert.equal(validate(crossTopicTargeted), false,
    'OpenAPI must bind every targeted item to the requested focus topic');

  const unbalancedMixed = structuredClone(mixedPayload);
  const topicCounts = new Map();
  for (const item of unbalancedMixed.event.session.items) {
    topicCounts.set(item.topicId, (topicCounts.get(item.topicId) || 0) + 1);
  }
  const crowdedTopic = [...topicCounts.entries()].find(([, count]) => count === 2)?.[0];
  const victim = unbalancedMixed.event.session.items.find((item) => item.topicId !== crowdedTopic);
  const victimKey = {
    choice: 'c', input: 'f', correction: 'correction', transform: 'transform',
  }[victim.type];
  const used = new Set(unbalancedMixed.event.session.items.map((item) => item.id));
  const replacement = GRAMMAR_CATALOG.bank[crowdedTopic][victimKey]
    .find((item) => !used.has(item.id));
  victim.id = replacement.id;
  victim.topicId = crowdedTopic;
  assert.equal(grammarMasteryEventSchema.safeParse(unbalancedMixed).success, false);
  assert.equal(validate(unbalancedMixed), false,
    'OpenAPI must execute the mixed four-types/eight-topics balance contract');

  const missingTopic = structuredClone(mixedPayload);
  delete missingTopic.event.session.items[0].topicId;
  assert.equal(validate(missingTopic), false);
});
