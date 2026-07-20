import { z } from 'zod';

const wordProgress = z.object({
  word: z.string().trim().min(1).max(120),
  stage: z.number().int().min(0).max(5),
  errorCount: z.number().int().min(0).max(1_000_000),
  reviewCount: z.number().int().min(0).max(1_000_000),
  dueAt: z.number().int().min(0).max(8_640_000_000_000).nullable(),
}).strict();

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
