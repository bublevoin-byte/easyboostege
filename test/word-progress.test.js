import test from 'node:test';
import assert from 'node:assert/strict';
import { wordProgressBatchSchema } from '../validation/word-progress.js';

const word = { word: 'achievement', stage: 3, errorCount: 1, reviewCount: 5, dueAt: Date.now() + 86_400_000 };

test('word progress validates SRS bounds and rejects duplicate words', () => {
  assert.equal(wordProgressBatchSchema.safeParse({ words: [word] }).success, true);
  assert.equal(wordProgressBatchSchema.safeParse({ words: [{ ...word, stage: 6 }] }).success, false);
  assert.equal(wordProgressBatchSchema.safeParse({ words: [word, { ...word, word: 'Achievement' }] }).success, false);
});
