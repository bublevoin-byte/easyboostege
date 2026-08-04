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

export function isFutureExamDate(value, now = new Date()) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return parsed.getTime() > today.getTime();
}
