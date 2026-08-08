import { z } from 'zod';

const stages = ['not_started', 'learning', 'learned', 'confirmed', 'stable'];
const practiceTypes = ['choice', 'input', 'correction', 'transform'];
const source = z.enum(['builtin', 'mixed', 'generated']);
const regressionReason = z.enum([
  'construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
  'word_order', 'negation_or_question', 'confusion_pair',
]);
const common = {
  id: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStage: z.enum(stages),
  expectedReviewStep: z.number().int().min(0).max(5),
  assisted: z.boolean(),
  source,
};
const typeScore = z.object({
  correct: z.number().int().min(0).max(1000),
  total: z.number().int().min(1).max(1000),
}).strict().refine((value) => value.correct <= value.total, { message: 'correct exceeds total' });

const sessionCompleted = z.object({
  ...common,
  type: z.literal('session_completed'),
  completedTypes: z.array(z.enum(practiceTypes)).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, { message: 'duplicate practice type' }),
  typeScores: z.object({
    choice: typeScore.optional(),
    input: typeScore.optional(),
    correction: typeScore.optional(),
    transform: typeScore.optional(),
  }).strict(),
  reason: regressionReason.optional(),
}).strict().refine(
  (value) => value.completedTypes.every((type) => value.typeScores[type] != null)
    && Object.keys(value.typeScores).every((type) => value.completedTypes.includes(type)),
  { message: 'completedTypes and typeScores mismatch' },
).refine(
  (value) => {
    const independentlyWrong = !value.assisted && value.completedTypes.some((type) => {
      const score = value.typeScores[type];
      return score != null && score.correct < score.total;
    });
    return independentlyWrong === (value.reason != null);
  },
  { message: 'reason must exist exactly for an unassisted wrong session', path: ['reason'] },
);

const reviewCompleted = z.object({
  ...common,
  type: z.literal('review_completed'),
  passed: z.boolean(),
  reason: regressionReason.optional(),
}).strict().refine(
  (value) => (!value.assisted && !value.passed) === (value.reason != null),
  { message: 'reason must exist exactly for an unassisted failed review', path: ['reason'] },
);

export const grammarMasteryEventSchema = z.object({
  topicId: z.number().int().min(1).max(20),
  event: z.discriminatedUnion('type', [sessionCompleted, reviewCompleted]),
}).strict();

export const grammarMasteryBatchSchema = z.object({
  owner: z.string().trim().min(1).max(128),
  batchId: z.string().uuid(),
  events: z.array(grammarMasteryEventSchema).min(1).max(20),
}).strict().refine(
  (value) => new Set(value.events.map((entry) => entry.event.id)).size === value.events.length,
  { message: 'duplicate event id' },
);
