import { z } from 'zod';

import {
  GRAMMAR_ERROR_CODES,
  GRAMMAR_RECOMMENDATION_VERSION,
  isGrammarConfusionPair,
} from '../public/grammar-domain-contract.js';

const nullableConfusionPair = z.string()
  .refine(isGrammarConfusionPair, { message: 'invalid grammar confusion pair' })
  .nullable();

export const grammarRecommendationPointerSchema = z.object({
  version: z.literal(GRAMMAR_RECOMMENDATION_VERSION),
  catalogVersion: z.string().min(1).max(80),
  catalogRevision: z.number().int().min(1).max(1_000_000),
  topicId: z.number().int().min(1).max(20),
  errorCode: z.enum(GRAMMAR_ERROR_CODES),
  confusionPair: nullableConfusionPair,
  masteryRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  eligibleAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  earlyPractice: z.boolean(),
  stateFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  ref: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const grammarRecommendationResolveSchema = z.object({
  pointer: grammarRecommendationPointerSchema,
}).strict();
