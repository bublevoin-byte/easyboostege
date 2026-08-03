import { z } from 'zod';

export const adaptiveGoalSchema = z.object({
  targetExam: z.literal('ege_english'),
  targetScore: z.number().int().min(0).max(100),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  weeklyMinutes: z.number().int().min(30).max(2_520).multipleOf(5),
}).strict();

export function isFutureExamDate(value, now = new Date()) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return parsed.getTime() > today.getTime();
}
