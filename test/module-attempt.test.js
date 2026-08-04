import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAttemptSchema } from '../validation/module-attempt.js';

const valid = { id: 'af674efd-8a65-4bf8-80c2-f9f8367d4835', module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 90_000, metadata: { source: 'builtin' } };

test('module attempt accepts bounded scores and flat metadata', () => {
  assert.equal(moduleAttemptSchema.safeParse(valid).success, true);
  assert.equal(moduleAttemptSchema.safeParse({ ...valid, score: 7 }).success, false);
  assert.equal(moduleAttemptSchema.safeParse({ ...valid, module: 'admin' }).success, false);
  assert.equal(moduleAttemptSchema.safeParse({ ...valid, metadata: { nested: { unsafe: true } } }).success, false);
});

const vocabularySummary = {
  id: '10000000-0000-4000-8000-000000000005',
  module: 'vocabulary', activity: 'vocabulary_active_recall_session',
  score: 2, maxScore: 3, durationMs: 93_000,
  metadata: {
    summaryVersion: 'vocabulary-session-summary-v1',
    objectiveEvidence: 'objective', objectiveAttempts: 3, objectiveCorrect: 2,
    guidedEvidence: 'guided', guidedAttempts: 1, guidedCorrect: 1,
    selfReportedEvidence: 'self_reported', selfReportedAttempts: 1, selfReportedKnown: 1,
    receptiveAttempts: 1, receptiveCorrect: 1,
    productionAttempts: 1, productionCorrect: 1,
    contextAttempts: 1, contextCorrect: 0,
    listeningAttempts: 1, listeningCorrect: 1,
    errors: 1,
  },
};

test('vocabulary summary accepts only reconciled bounded per-mode evidence', () => {
  assert.equal(moduleAttemptSchema.safeParse(vocabularySummary).success, true);
  for (const candidate of [
    { ...vocabularySummary, score: 3 },
    { ...vocabularySummary, maxScore: 4 },
    { ...vocabularySummary, metadata: { ...vocabularySummary.metadata, objectiveCorrect: 4 } },
    { ...vocabularySummary, metadata: { ...vocabularySummary.metadata, guidedCorrect: 2 } },
    { ...vocabularySummary, metadata: { ...vocabularySummary.metadata, selfReportedKnown: 2 } },
    { ...vocabularySummary, metadata: { ...vocabularySummary.metadata, objectiveEvidence: 'server_verified_unassisted' } },
    { ...vocabularySummary, metadata: { ...vocabularySummary.metadata, extra: 1 } },
  ]) assert.equal(moduleAttemptSchema.safeParse(candidate).success, false);
});
