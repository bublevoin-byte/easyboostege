import { z } from 'zod';
import {
  EGE_MOCK_ORAL_TASKS,
  EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES,
} from '../shared/ege-mock-oral-contract.js';

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

function oralRecording(maximumDurationSeconds) { return z.object({
  recordingId: z.string().uuid(),
  status: z.enum(['completed', 'technical_issue', 'skipped']),
  durationSeconds: z.number().finite().min(0).max(maximumDurationSeconds),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  technicalIssueCode: z.enum(EGE_MOCK_ORAL_TECHNICAL_ISSUE_CODES).optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === 'completed') !== Boolean(value.sha256)) {
    context.addIssue({ code: 'custom', message: 'Completed audio requires one digest.' });
  }
  if ((value.status === 'technical_issue') !== Boolean(value.technicalIssueCode)) {
    context.addIssue({ code: 'custom', message: 'Technical status requires one bounded code.' });
  }
  if ((value.status === 'completed' && value.durationSeconds < 1)
    || (value.status !== 'completed' && value.durationSeconds !== 0)) {
    context.addIssue({ code: 'custom', message: 'Recording duration does not match its status.' });
  }
}); }

export const egeMockOralStageSchema = z.union(EGE_MOCK_ORAL_TASKS.flatMap((task) => {
  const identity = {
    expectedRevision: revision,
    position: z.literal(task.position),
    responseNumber: z.number().int().min(1).max(task.responseCount),
  };
  return [
    z.object({ ...identity, action: z.literal('advance') }).strict(),
    z.object({
      ...identity,
      action: z.literal('complete'),
      recording: oralRecording(task.responseSeconds),
    }).strict(),
  ];
}));

export const egeMockAssessmentRunSchema = z.object({
  explicitRenewal: z.literal(true).optional(),
}).strict();

export const egeMockOralSubmitSchema = z.object({ expectedRevision: revision }).strict();

export const egeMockRetrySchema = z.object({
  acknowledgePossibleProviderRepeat: z.literal(true).optional(),
}).strict();

export const egeMockAttemptIdSchema = z.string().uuid();
export const egeMockIdempotencyKeySchema = z.string().uuid();
