import assert from 'node:assert/strict';
import test from 'node:test';

import { personalVocabularyCardsSchema } from '../validation/personal-words.js';

function validCard(overrides = {}) {
  return {
    cardVersion: 1,
    id: 'personal:volunteer',
    canonicalWord: 'volunteer',
    word: 'volunteer',
    provenance: 'personal',
    meanings: ['волонтёр'],
    pronunciation: null,
    partOfSpeech: null,
    level: null,
    contexts: [{ text: 'They volunteer in other countries.', source: 'reading' }],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

test('personal words persistence accepts only bounded canonical personal cards', () => {
  assert.equal(personalVocabularyCardsSchema.safeParse([validCard()]).success, true);
  assert.equal(personalVocabularyCardsSchema.safeParse([validCard({
    id: 'core:volunteer', provenance: 'core',
  })]).success, false);
  assert.equal(personalVocabularyCardsSchema.safeParse([validCard({
    id: 'personal:different',
  })]).success, false);
  assert.equal(personalVocabularyCardsSchema.safeParse([validCard({
    canonicalWord: 'Volunteer', word: 'Volunteer',
  })]).success, false);
  assert.equal(personalVocabularyCardsSchema.safeParse([validCard({
    contexts: Array.from({ length: 9 }, (_, index) => ({ text: `Context ${index}`, source: 'reading' })),
  })]).success, false);
  assert.equal(personalVocabularyCardsSchema.safeParse([validCard(), validCard()]).success, false);
});
