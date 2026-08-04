import { z } from 'zod';

export const moduleAttemptSchema = z.object({
  id: z.string().uuid(),
  module: z.enum(['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking', 'exam']),
  activity: z.string().trim().min(1).max(80),
  score: z.number().int().min(0).max(1000),
  maxScore: z.number().int().min(1).max(1000),
  durationMs: z.number().int().min(0).max(14_400_000).nullable().optional(),
  metadata: z.record(z.string(), z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])).optional().default({}),
  adaptiveExecutionClaim: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/u).optional(),
}).strict().refine((value) => value.score <= value.maxScore, { message: 'score exceeds maxScore', path: ['score'] });
