import { z } from 'zod';

export const learnerPreferencesSchema = z.object({
  version: z.literal(1),
  schoolGrade: z.number().int().min(8).max(11).nullable(),
  preferredSessionMinutes: z.number().int().min(15).max(120).multipleOf(5),
}).strict();
