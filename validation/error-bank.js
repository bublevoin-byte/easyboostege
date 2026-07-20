import { z } from 'zod';

const detailValue = z.union([z.string().max(300), z.number().finite(), z.boolean(), z.null()]);
const errorEntry = z.object({
  module: z.enum(['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking', 'exam']),
  itemKey: z.string().trim().min(1).max(160),
  errorType: z.string().trim().min(1).max(60).regex(/^[a-z0-9_-]+$/u),
  details: z.record(z.string().max(60), detailValue).optional().default({}),
}).strict();

export const errorBankBatchSchema = z.object({ errors: z.array(errorEntry).min(1).max(100) }).strict();
