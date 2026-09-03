import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import express from 'express';

import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import { createProgressRoutes } from '../routes/progress.js';
import {
  buildGrammarRecommendation,
  resolveGrammarRecommendation,
} from '../services/grammar-recommendation.js';
import { compileOpenApiSchema } from './support/openapi-schema-evaluator.js';

function record(topicId, item, { at, eligibleAt, generated = false } = {}) {
  const diagnostic = item.type === 'choice' ? item.diagnostics.find(Boolean) : null;
  return {
    masteryVersion: 2, masteryRevision: topicId, stage: 'learned', reviewStep: 0,
    highestReviewStep: 0, eligibleAt,
    stats: { correct: 4, errors: 1, advancedStreak: 0, assistedAttempts: 1 },
    legacy: { st: 2, ok: 4, err: 1, sr: 0, rs: 0, due: 0 },
    recentEventIds: [], lastStageAt: at - 10_000, lastAttemptAt: at,
    lastRegressionReason: diagnostic?.errorCode || item.errorSkill,
    masteryHistory: [{
      eventId: `30000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`,
      type: 'session_completed', replayFingerprint: null, at, outcome: 'recorded',
      fromStage: 'learned', toStage: 'learned', reviewStep: 0,
      session: {
        id: `40000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`,
        scope: 'topic', mode: 'topic_practice', source: generated ? 'generated' : 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items: [{
          id: item.id, type: item.type, transfer: false, correct: false,
          diagnosticId: diagnostic?.id || null,
          errorCode: diagnostic?.errorCode || item.errorSkill,
          confusionPair: diagnostic ? (diagnostic.confusionPair || null) : (item.confusionPair || null),
          transferStatus: null,
          ...(generated ? { source: 'generated', revision: 1 } : {}),
        }],
        startedAt: at - 1_000, assisted: true, endedAt: at,
      },
    }],
  };
}

test('server recommendation chooses the freshest exact built-in weakness and records deadline acceleration without stage authority', () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const older = GRAMMAR_CATALOG.bank[18].correction[0];
  const recent = GRAMMAR_CATALOG.bank[3].c.find((item) => item.diagnostics.some((entry) => entry?.confusionPair));
  const mastery = {
    18: record(18, older, { at: now.getTime() - 3_600_000, eligibleAt: now.getTime() + 86_400_000 }),
    3: record(3, recent, { at: now.getTime() - 60_000, eligibleAt: now.getTime() + 3 * 86_400_000 }),
  };
  const expectedDiagnostic = recent.diagnostics.find(Boolean);
  const recommendation = buildGrammarRecommendation({
    mastery, catalog: GRAMMAR_CATALOG, now,
    examDate: '2026-08-20',
  });

  assert.deepEqual({
    topicId: recommendation.pointer.topicId,
    errorCode: recommendation.pointer.errorCode,
    confusionPair: recommendation.pointer.confusionPair,
  }, {
    topicId: 3,
    errorCode: expectedDiagnostic.errorCode,
    confusionPair: expectedDiagnostic.confusionPair || null,
  });
  assert.equal(recommendation.pointer.earlyPractice, true);
  assert.equal(recommendation.pointer.eligibleAt, mastery[3].eligibleAt);
  assert.match(recommendation.pointer.ref, /^[a-f0-9]{64}$/u);
  assert.ok(recommendation.reasonCodes.includes('deadline_pressure'));
});

test('generated history is quarantined from exact focus and cannot become sole recommendation evidence', () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const generatedLooking = { ...GRAMMAR_CATALOG.bank[3].f[0], id: `generated.g.q.${'a'.repeat(64)}.${'b'.repeat(16)}.f1` };
  const mastery = { 3: record(3, generatedLooking, { at: now.getTime(), generated: true }) };
  const recommendation = buildGrammarRecommendation({ mastery, catalog: GRAMMAR_CATALOG, now });

  assert.notEqual(recommendation.pointer.topicId, 3,
    'a generated-only weakness cannot select the targeted topic');
  assert.ok(recommendation.reasonCodes.includes('catalog_fallback'));
});

test('the freshest exact built-in exam gap becomes the next targeted practice focus', () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const gap = GRAMMAR_CATALOG.exams[0].gaps[0];
  const exact = record(gap.t, { ...gap, errorSkill: 'word_or_verb_form' }, { at: now.getTime() - 1_000 });
  exact.masteryHistory[0].session.scope = 'mixed';
  exact.masteryHistory[0].session.mode = 'exam_19_24';
  exact.masteryHistory[0].session.items[0].topicId = gap.t;

  const recommendation = buildGrammarRecommendation({
    mastery: { [gap.t]: exact }, catalog: GRAMMAR_CATALOG, now,
  });

  assert.deepEqual({
    topicId: recommendation.pointer.topicId,
    errorCode: recommendation.pointer.errorCode,
  }, { topicId: gap.t, errorCode: 'word_or_verb_form' });
  assert.ok(recommendation.reasonCodes.includes('recent_weakness'));
});

test('one mixed error copied into per-topic history remains one recommendation observation', () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const item = GRAMMAR_CATALOG.bank[3].c[0];
  const actualTopic = record(3, item, { at: now.getTime() - 1_000 });
  const mixedEntry = actualTopic.masteryHistory[0];
  mixedEntry.eventId = '30000000-0000-4000-8000-000000000333';
  mixedEntry.session.id = mixedEntry.eventId;
  mixedEntry.session.scope = 'mixed';
  mixedEntry.session.mode = 'mixed_practice';
  mixedEntry.session.items[0].topicId = 3;
  const copiedTopic = record(4, GRAMMAR_CATALOG.bank[4].c[0], { at: now.getTime() - 2_000 });
  copiedTopic.masteryHistory = [structuredClone(mixedEntry)];

  const recommendation = buildGrammarRecommendation({
    mastery: { 3: actualTopic, 4: copiedTopic }, catalog: GRAMMAR_CATALOG, now,
  });
  assert.equal(recommendation.pointer.topicId, 3);
  assert.equal(recommendation.observedErrorCount, 1,
    'per-topic persistence copies cannot multiply one physical mixed outcome');
});

test('resolver accepts only the current exact server-owned pointer and rejects client substitution', () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const item = GRAMMAR_CATALOG.bank[5].c[0];
  const mastery = { 5: record(5, item, { at: now.getTime() - 1_000 }) };
  const recommendation = buildGrammarRecommendation({ mastery, catalog: GRAMMAR_CATALOG, now });

  assert.deepEqual(resolveGrammarRecommendation(recommendation.pointer, {
    mastery, catalog: GRAMMAR_CATALOG, now,
  }), recommendation);
  assert.equal(resolveGrammarRecommendation({ ...recommendation.pointer, topicId: 6 }, {
    mastery, catalog: GRAMMAR_CATALOG, now,
  }), null);
  assert.equal(resolveGrammarRecommendation({ ...recommendation.pointer, errorCode: 'agreement' }, {
    mastery, catalog: GRAMMAR_CATALOG, now,
  }), null);
});

test('OpenAPI executes the recommendation pointer, resolver response and adaptive overview contract', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const recommendation = buildGrammarRecommendation({
    mastery: {}, catalog: GRAMMAR_CATALOG, now: new Date('2026-08-13T08:00:00.000Z'),
    examDate: '2026-08-20',
  });
  const pointerSchema = compileOpenApiSchema(openapi, 'GrammarRecommendationPointer');
  const responseSchema = compileOpenApiSchema(openapi, 'GrammarRecommendationResolveResponse');
  assert.equal(pointerSchema(recommendation.pointer), true, JSON.stringify(pointerSchema.errors));
  const queue = (await import('../public/modules/grammar.js')).EasyBoostGrammar
    .buildTargetedPracticeQueue(GRAMMAR_CATALOG.bank, recommendation.pointer, {
      seed: recommendation.pointer.ref,
    });
  assert.equal(responseSchema({
    recommendation,
    catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
    itemIds: queue.map((item) => item.q.id),
    completionToken: 'c'.repeat(43),
  }), true, JSON.stringify(responseSchema.errors));
  const recommendationPath = openapi.match(/  \/api\/v1\/grammar\/recommendation:[\s\S]*?(?=\n  \/api\/v1\/)/u)?.[0] || '';
  const resolverPath = openapi.match(/  \/api\/v1\/grammar\/recommendation\/resolve:[\s\S]*?(?=\n  \/api\/v1\/)/u)?.[0] || '';
  assert.match(recommendationPath, /ExpectedOwner/u);
  assert.match(recommendationPath, /GrammarRecommendationResponse/u);
  assert.match(resolverPath, /GrammarRecommendationResolveRequest/u);
  assert.match(resolverPath, /GRAMMAR_RECOMMENDATION_STALE/u);
  assert.match(openapi, /AdaptiveOverview:[\s\S]*grammarRecommendation:[\s\S]*GrammarRecommendation/u);
});

test('owner-bound API resolves only its current recommendation into exact built-in item pointers', async () => {
  const now = new Date('2026-08-13T08:00:00.000Z');
  const item = GRAMMAR_CATALOG.bank[5].c[0];
  const mastery = { 5: record(5, item, { at: now.getTime() - 1_000 }) };
  const owner = 'grammar-focus-owner';
  const applied = [];
  const db = {
    async migrateGrammarMastery(username) {
      assert.equal(username, owner);
      return structuredClone(mastery);
    },
    async getAdaptiveLearningGoal(username) {
      assert.equal(username, owner);
      return { exam_date: '2026-08-20' };
    },
    async applyGrammarMasteryEvent(username, topicId, event) {
      assert.equal(username, owner);
      applied.push(structuredClone({ topicId, event }));
      return {
        eventId: event.id, applied: true, conflict: false, replay: false,
        record: { ...mastery[topicId], masteryRevision: mastery[topicId].masteryRevision + 1,
          recentEventIds: [event.id] },
      };
    },
  };
  const authentication = {
    auth(req, _res, next) { req.user = req.headers['x-test-user']; next(); },
  };
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({
    authentication, db, now: () => now,
    recommendationSecret: 'test-recommendation-secret',
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': owner,
        'x-easyboost-expected-owner': owner,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const issued = await call('/api/v1/grammar/recommendation');
    assert.equal(issued.status, 200);
    assert.equal(issued.body.recommendation.pointer.topicId, 5);

    const resolved = await call('/api/v1/grammar/recommendation/resolve', {
      pointer: issued.body.recommendation.pointer,
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.itemIds.length, 8);
    assert.match(resolved.body.completionToken, /^[A-Za-z0-9_-]{43}$/u);
    assert.ok(resolved.body.itemIds.every((id) => GRAMMAR_CATALOG.bank[5]
      && Object.values(GRAMMAR_CATALOG.bank[5]).flat().some((entry) => entry.id === id)));

    const substituted = await call('/api/v1/grammar/recommendation/resolve', {
      pointer: { ...issued.body.recommendation.pointer, topicId: 6 },
    });
    assert.equal(substituted.status, 409);
    assert.equal(substituted.body.error.code, 'GRAMMAR_RECOMMENDATION_STALE');

    const queue = (await import('../public/modules/grammar.js')).EasyBoostGrammar
      .buildTargetedPracticeQueue(GRAMMAR_CATALOG.bank, resolved.body.recommendation.pointer, {
        seed: resolved.body.recommendation.pointer.ref,
      });
    const eventId = '60000000-0000-4000-8000-000000000001';
    const items = queue.map((entry) => ({
      id: entry.q.id, type: entry.k, transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    }));
    const typeScores = Object.fromEntries([...new Set(items.map((entry) => entry.type))]
      .map((type) => {
        const total = items.filter((entry) => entry.type === type).length;
        return [type, { correct: total, total }];
      }));
    const exactCompletion = {
      topicId: resolved.body.recommendation.pointer.topicId,
      event: {
        id: eventId, type: 'session_completed',
        expectedRevision: mastery[5].masteryRevision,
        expectedStage: mastery[5].stage,
        expectedReviewStep: mastery[5].reviewStep,
        source: 'builtin', assisted: false,
        completedTypes: Object.keys(typeScores), typeScores,
        session: {
          id: eventId, scope: 'topic', mode: 'targeted_practice', source: 'builtin',
          catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
          items, startedAt: now.getTime(), assisted: false,
          recommendation: {
            pointer: resolved.body.recommendation.pointer,
            itemIds: resolved.body.itemIds,
            completionToken: resolved.body.completionToken,
          },
        },
      },
    };
    const accepted = await call('/api/v1/grammar/mastery-events', exactCompletion);
    assert.equal(accepted.status, 201);
    assert.equal(applied.length, 1);

    const reusedAtNewRevision = structuredClone(exactCompletion);
    reusedAtNewRevision.event.id = '60000000-0000-4000-8000-000000000004';
    reusedAtNewRevision.event.session.id = reusedAtNewRevision.event.id;
    reusedAtNewRevision.event.expectedRevision += 1;
    const rejectedReuse = await call('/api/v1/grammar/mastery-events', reusedAtNewRevision);
    assert.equal(rejectedReuse.status, 409);
    assert.equal(rejectedReuse.body.error.code, 'GRAMMAR_RECOMMENDATION_COMPLETION_INVALID');
    assert.equal(applied.length, 1, 'one signed focus cannot authorize a future mastery revision');

    const forgedIds = structuredClone(exactCompletion);
    forgedIds.event.id = '60000000-0000-4000-8000-000000000002';
    forgedIds.event.session.id = forgedIds.event.id;
    forgedIds.event.session.items[0].id = queue[1].q.id;
    const rejectedIds = await call('/api/v1/grammar/mastery-events', forgedIds);
    assert.equal(rejectedIds.status, 400);
    assert.equal(applied.length, 1, 'substituted completion never reaches persistence');

    const forgedReceipt = structuredClone(exactCompletion);
    forgedReceipt.event.id = '60000000-0000-4000-8000-000000000003';
    forgedReceipt.event.session.id = forgedReceipt.event.id;
    forgedReceipt.event.session.recommendation.completionToken = 'd'.repeat(43);
    const rejectedReceipt = await call('/api/v1/grammar/mastery-events', forgedReceipt);
    assert.equal(rejectedReceipt.status, 409);
    assert.equal(rejectedReceipt.body.error.code, 'GRAMMAR_RECOMMENDATION_COMPLETION_INVALID');
    assert.equal(applied.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
