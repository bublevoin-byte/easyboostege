import { z } from 'zod';

const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const revision = z.number().int().min(0).max(1_000_000);
const answer = z.union([
  z.string().max(20_000),
  z.array(z.string().max(500)).max(20),
  z.null(),
]);

export const egeMockStartSchema = z.object({
  formId: z.string().regex(/^ege-en-[0-9]{4}-form-[0-9]+$/u),
  formRevision: z.number().int().positive().max(1_000_000),
  catalogFingerprint: fingerprint,
}).strict();

export const egeMockDraftSchema = z.object({
  expectedRevision: revision,
  answers: z.record(z.string().regex(/^(?:[1-9]|[12][0-9]|3[0-8])$/u), answer),
}).strict();

export const egeMockMutationSchema = z.object({ expectedRevision: revision }).strict();

export const egeMockOralSubmitSchema = z.object({
  expectedRevision: revision,
  recordings: z.partialRecord(z.enum(['39', '40', '41', '42']), z.object({
    recordingId: z.string().min(1).max(120),
    durationSeconds: z.number().min(0).max(1_020),
  }).strict()),
}).strict();

export const egeMockRetrySchema = z.object({}).strict();

export const egeMockAttemptIdSchema = z.string().uuid();
export const egeMockIdempotencyKeySchema = z.string().uuid();
