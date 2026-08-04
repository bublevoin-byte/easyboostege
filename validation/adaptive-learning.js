import { z } from 'zod';

export const adaptiveGoalSchema = z.object({
  targetExam: z.literal('ege_english'),
  targetScore: z.number().int().min(0).max(100),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  weeklyMinutes: z.number().int().min(30).max(2_520).multipleOf(5),
}).strict();

export const adaptiveDiagnosticStartSchema = z.object({}).strict();

export const adaptiveDiagnosticAnswerSchema = z.object({
  itemId: z.string().min(1).max(100),
  choiceId: z.string().min(1).max(20),
}).strict();

export const adaptiveSessionPreviewSchema = z.object({
  durationMinutes: z.number().int().min(15).max(120).multipleOf(5),
}).strict();

export const adaptiveSessionCreateSchema = z.object({
  durationMinutes: z.number().int().min(15).max(120).multipleOf(5),
  previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export const adaptiveSessionReplacementSchema = z.object({
  blockId: z.string().regex(/^asb_[0-9a-f]{16}_[0-9]{2}$/u),
  reason: z.enum(['too_difficult', 'too_easy', 'not_relevant', 'accessibility']),
}).strict();

export const adaptiveSessionStartSchema = z.object({
  blockId: z.string().regex(/^asb_[0-9a-f]{16}_[0-9]{2}$/u),
  expectedRevision: z.number().int().min(0).max(10_000),
}).strict();

export const adaptiveAttemptReferenceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('module'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('voice_tutor_repeat'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('writing'), id: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('speaking'), id: z.number().int().positive() }).strict(),
]);

export const adaptiveSessionAdvanceSchema = z.object({
  blockId: z.string().regex(/^asb_[0-9a-f]{16}_[0-9]{2}$/u),
  expectedRevision: z.number().int().min(0).max(10_000),
  attempt: adaptiveAttemptReferenceSchema.nullable(),
}).strict();

export const adaptiveSessionFinishSchema = z.object({
  expectedRevision: z.number().int().min(0).max(10_000),
}).strict();

export const adaptiveSessionAttemptBindSchema = z.object({
  executionClaim: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/u),
  attempt: z.discriminatedUnion('type', [
    z.object({ type: z.literal('voice_tutor_repeat'), id: z.string().uuid() }).strict(),
    z.object({ type: z.literal('writing'), id: z.number().int().positive() }).strict(),
    z.object({ type: z.literal('speaking'), id: z.number().int().positive() }).strict(),
  ]),
}).strict();

export function isFutureExamDate(value, now = new Date()) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return parsed.getTime() > today.getTime();
}
