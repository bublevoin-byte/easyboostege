import { z } from 'zod';

const summaryCount = z.number().int().min(0).max(1000);

export const vocabularySessionSummaryMetadataSchema = z.object({
  summaryVersion: z.literal('vocabulary-session-summary-v1'),
  objectiveEvidence: z.literal('objective'),
  objectiveAttempts: summaryCount,
  objectiveCorrect: summaryCount,
  guidedEvidence: z.literal('guided'),
  guidedAttempts: summaryCount,
  guidedCorrect: summaryCount,
  selfReportedEvidence: z.literal('self_reported'),
  selfReportedAttempts: summaryCount,
  selfReportedKnown: summaryCount,
  receptiveAttempts: summaryCount,
  receptiveCorrect: summaryCount,
  productionAttempts: summaryCount,
  productionCorrect: summaryCount,
  contextAttempts: summaryCount,
  contextCorrect: summaryCount,
  listeningAttempts: summaryCount,
  listeningCorrect: summaryCount,
  errors: summaryCount,
}).strict().superRefine((value, context) => {
  const comparisons = [
    ['objectiveCorrect', value.objectiveCorrect, value.objectiveAttempts],
    ['guidedCorrect', value.guidedCorrect, value.guidedAttempts],
    ['selfReportedKnown', value.selfReportedKnown, value.selfReportedAttempts],
    ['receptiveCorrect', value.receptiveCorrect, value.receptiveAttempts],
    ['productionCorrect', value.productionCorrect, value.productionAttempts],
    ['contextCorrect', value.contextCorrect, value.contextAttempts],
    ['listeningCorrect', value.listeningCorrect, value.listeningAttempts],
  ];
  for (const [field, correct, attempts] of comparisons) {
    if (correct > attempts) context.addIssue({
      code: z.ZodIssueCode.custom, path: [field], message: 'correct count exceeds attempts',
    });
  }
  if (value.objectiveAttempts !== value.productionAttempts + value.contextAttempts + value.listeningAttempts
    || value.objectiveCorrect !== value.productionCorrect + value.contextCorrect + value.listeningCorrect
    || value.guidedAttempts !== value.receptiveAttempts
    || value.guidedCorrect !== value.receptiveCorrect
    || value.errors > value.objectiveAttempts + value.guidedAttempts + value.selfReportedAttempts) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'vocabulary summary counters do not reconcile' });
  }
});

export const moduleAttemptSchema = z.object({
  id: z.string().uuid(),
  module: z.enum(['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking', 'exam']),
  activity: z.string().trim().min(1).max(80),
  score: z.number().int().min(0).max(1000),
  maxScore: z.number().int().min(1).max(1000),
  durationMs: z.number().int().min(0).max(14_400_000).nullable().optional(),
  metadata: z.record(z.string(), z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])).optional().default({}),
  adaptiveExecutionClaim: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/u).optional(),
}).strict().refine((value) => value.score <= value.maxScore, {
  message: 'score exceeds maxScore', path: ['score'],
}).superRefine((value, context) => {
  if (value.activity !== 'vocabulary_active_recall_session') return;
  const parsed = vocabularySessionSummaryMetadataSchema.safeParse(value.metadata);
  if (value.module !== 'vocabulary' || !parsed.success
    || value.score !== parsed.data?.objectiveCorrect
    || value.maxScore !== Math.max(1, parsed.data?.objectiveAttempts ?? 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['metadata'],
      message: 'invalid vocabulary session summary',
    });
  }
});
