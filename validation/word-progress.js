import { z } from 'zod';
import {
  migrateVocabularyProgress,
  VOCABULARY_EVIDENCE_LEVELS,
  VOCABULARY_MODES,
  VOCABULARY_OUTCOMES,
} from '../public/vocabulary-domain.js';

const legacyWordProgress = z.object({
  word: z.string().trim().min(1).max(120),
  stage: z.number().int().min(0).max(5),
  errorCount: z.number().int().min(0).max(1_000_000),
  reviewCount: z.number().int().min(0).max(1_000_000),
  dueAt: z.number().int().min(0).max(8_640_000_000_000).nullable(),
}).strict();

const masteryDimension = z.object({
  score: z.number().int().min(0).max(100),
  attempts: z.number().int().min(0).max(1_000_000),
  independentSuccesses: z.number().int().min(0).max(1_000_000),
  evidence: z.enum(VOCABULARY_EVIDENCE_LEVELS),
  lastPracticedAt: z.number().int().min(0).max(8_640_000_000_000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.independentSuccesses > value.attempts) {
    context.addIssue({ code: 'custom', message: 'independent successes exceed attempts', path: ['independentSuccesses'] });
  }
  if (value.independentSuccesses > 0 && value.evidence !== 'objective') {
    context.addIssue({ code: 'custom', message: 'independent successes require objective evidence', path: ['evidence'] });
  }
});

const masteryWordProgress = legacyWordProgress.extend({
  masteryVersion: z.literal(1),
  dimensions: z.object({
    meaning: masteryDimension,
    spelling: masteryDimension,
    context: masteryDimension,
    listening: masteryDimension,
  }).strict(),
  lastMode: z.enum(VOCABULARY_MODES).nullable(),
  lastOutcome: z.enum(VOCABULARY_OUTCOMES).nullable(),
}).strict();

const wordProgress = z.union([
  masteryWordProgress.transform(migrateVocabularyProgress),
  legacyWordProgress.transform((value) => ({ ...migrateVocabularyProgress(value), legacyInput: true })),
]);

export const wordProgressBatchSchema = z.object({
  words: z.array(wordProgress).min(1).max(500),
}).strict().superRefine((value, context) => {
  const seen = new Set();
  value.words.forEach((item, index) => {
    const key = item.word.toLocaleLowerCase('en');
    if (seen.has(key)) context.addIssue({ code: 'custom', message: 'duplicate word', path: ['words', index, 'word'] });
    seen.add(key);
  });
});
