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
