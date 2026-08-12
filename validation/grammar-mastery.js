import { z } from 'zod';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import {
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_ERROR_CODES,
  GENERATED_GRAMMAR_REVISION,
  isGrammarConfusionPair,
  isBuiltinGrammarDiagnosticId,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';

const stages = ['not_started', 'learning', 'learned', 'confirmed', 'stable'];
const practiceTypes = GRAMMAR_ACTIVE_PRACTICE_TYPES;
const activeTopicIds = GRAMMAR_ACTIVE_TOPIC_IDS;
const source = z.enum(['builtin', 'mixed', 'generated']);
const regressionReason = z.enum(GRAMMAR_ERROR_CODES);
const common = {
  id: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStage: z.enum(stages),
  expectedReviewStep: z.number().int().min(0).max(5),
  assisted: z.boolean(),
  source,
};
const typeScore = z.object({
  correct: z.number().int().min(0).max(1000),
  total: z.number().int().min(1).max(1000),
}).strict().refine((value) => value.correct <= value.total, { message: 'correct exceeds total' });

const confusionPair = z.string().refine(isGrammarConfusionPair, { message: 'invalid grammar confusion pair' });
const independentError = z.object({
  itemId: z.string().min(1).max(128),
  diagnosticId: z.string().refine(isBuiltinGrammarDiagnosticId, { message: 'invalid built-in grammar diagnostic' }).nullable(),
  reason: regressionReason,
  confusionPair: confusionPair.nullable(),
}).strict();

function catalogMatchesIndependentError(item, evidence) {
  if (!item || !evidence) return false;
  const diagnostic = item.diagnostics?.find((candidate) => candidate?.id === evidence.diagnosticId);
  if (diagnostic) {
    return diagnostic.errorCode === evidence.reason
      && (diagnostic.confusionPair || null) === (evidence.confusionPair || null);
  }
  const expectedReason = item.errorSkill
    || (item.type === 'input' ? 'word_or_verb_form' : 'construction_choice');
  return evidence.diagnosticId == null && evidence.reason === expectedReason
    && (item.confusionPair || null) === (evidence.confusionPair || null);
}

const practiceSessionItem = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(practiceTypes),
  transfer: z.boolean(),
  correct: z.boolean(),
  diagnosticId: z.string().refine(isBuiltinGrammarDiagnosticId, { message: 'invalid built-in grammar diagnostic' }).nullable(),
  errorCode: regressionReason.nullable(),
  confusionPair: confusionPair.nullable(),
  transferStatus: z.enum(['due_next_session']).nullable(),
  source: z.literal('generated').optional(),
  revision: z.literal(GENERATED_GRAMMAR_REVISION).optional(),
}).strict().refine(
  (value) => value.correct ? value.errorCode == null && value.confusionPair == null : value.errorCode != null,
  { message: 'wrong outcomes require an error code; correct outcomes cannot claim a weakness' },
);
const practiceSession = z.object({
  id: z.string().uuid(),
  scope: z.literal('topic'),
  mode: z.enum(['topic_practice', 'legacy_practice']),
  source,
  catalog: z.object({
    version: z.literal(GRAMMAR_CATALOG.version),
    revision: z.literal(GRAMMAR_CATALOG.revision),
  }).strict(),
  items: z.array(practiceSessionItem).min(1).max(32),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  assisted: z.boolean(),
}).strict();

const sessionCompleted = z.object({
  ...common,
  type: z.literal('session_completed'),
  completedTypes: z.array(z.enum(practiceTypes)).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, { message: 'duplicate practice type' }),
  typeScores: z.object({
    choice: typeScore.optional(),
    input: typeScore.optional(),
    correction: typeScore.optional(),
    transform: typeScore.optional(),
  }).strict(),
  session: practiceSession,
  independentError: independentError.optional(),
}).strict().refine(
  (value) => value.completedTypes.every((type) => value.typeScores[type] != null)
    && Object.keys(value.typeScores).every((type) => value.completedTypes.includes(type)),
  { message: 'completedTypes and typeScores mismatch' },
).refine(
  (value) => value.id === value.session.id && value.assisted === value.session.assisted && value.source === value.session.source,
  { message: 'session identity and assistance must match the mastery event', path: ['session'] },
).refine(
  (value) => value.completedTypes.every((type) => {
    const items = value.session.items.filter((item) => item.type === type);
    return items.length === value.typeScores[type].total
      && items.filter((item) => item.correct).length === value.typeScores[type].correct;
  }),
  { message: 'session outcomes and typeScores mismatch', path: ['session', 'items'] },
);

const reviewCompleted = z.object({
  ...common,
  type: z.literal('review_completed'),
  passed: z.boolean(),
  independentError: independentError.optional(),
}).strict().refine(
  (value) => value.passed ? value.independentError == null : value.assisted,
  { message: 'a failed review is disclosed and assisted; passed reviews cannot claim an error', path: ['independentError'] },
);

export const grammarMasteryEventSchema = z.object({
  topicId: z.number().int().min(1).max(20),
  event: z.discriminatedUnion('type', [sessionCompleted, reviewCompleted]),
}).strict().superRefine((value, context) => {
  const levels = GRAMMAR_CATALOG.bank[value.topicId];
  const catalogItems = new Map(['c', 'c2', 'f', 'correction', 'transform'].flatMap((kind) => (
    (levels?.[kind] || []).map((item) => [item.id, item])
  )));
  if (value.event.type === 'review_completed') {
    const evidence = value.event.independentError;
    if (evidence && (value.event.passed || !value.event.assisted || value.event.source === 'generated'
      || !catalogMatchesIndependentError(catalogItems.get(evidence.itemId), evidence))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'independentError'],
        message: 'independent review error must match one exact built-in catalog pointer before disclosure',
      });
    }
    return;
  }
  const activeTopic = activeTopicIds.includes(value.topicId);
  const activeSession = activeTopic && value.event.source === 'builtin';
  const expectedMode = activeSession ? 'topic_practice' : 'legacy_practice';
  if (value.event.session.mode !== expectedMode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'mode'], message: `topic requires ${expectedMode}` });
  }
  if (activeSession && (!practiceTypes.every((type) => value.event.completedTypes.includes(type))
    || value.event.completedTypes.length !== practiceTypes.length
    || !practiceTypes.every((type) => value.event.typeScores[type] != null)
    || Object.keys(value.event.typeScores).length !== practiceTypes.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['event', 'completedTypes'],
      message: 'active sessions require exact scores for all four practice types',
    });
  }
  const outcomeTypes = new Set(value.event.session.items.map((item) => item.type));
  if (value.event.completedTypes.length !== outcomeTypes.size
    || !value.event.completedTypes.every((type) => outcomeTypes.has(type))
    || Object.keys(value.event.typeScores).length !== outcomeTypes.size
    || !Object.keys(value.event.typeScores).every((type) => outcomeTypes.has(type))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['event', 'completedTypes'],
      message: 'completedTypes and typeScores must match the exact session outcome type set',
    });
  }
  const generatedOutcomes = value.event.session.items.filter((item) => parseGeneratedGrammarItemId(item.id));
  const expectedSource = generatedOutcomes.length === 0 ? 'builtin'
    : generatedOutcomes.length === value.event.session.items.length ? 'generated' : 'mixed';
  if (value.event.source !== expectedSource || (generatedOutcomes.length > 0 && !value.event.assisted)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'source'], message: 'generated participation requires exact assisted provenance' });
  }
  if (!activeSession && value.event.session.items.length > 16) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'legacy sessions are bounded to eight originals and one retry each' });
  }
  if (activeSession
    && !practiceTypes.every((type) => value.event.session.items.filter((item) => !item.transfer && item.type === type).length === 4)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'active sessions require exactly four original items per practice type' });
  }
  if (activeSession
    && new Set(value.event.session.items.map((item) => item.id)).size !== value.event.session.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'active sessions cannot repeat a practice item' });
  }
  if (activeSession) {
    for (const type of practiceTypes) {
      const originals = value.event.session.items.filter((outcome) => !outcome.transfer && outcome.type === type);
      const pairIds = originals.map((outcome) => catalogItems.get(outcome.id)?.transferPair).filter(Boolean);
      if (pairIds.length !== 4 || new Set(pairIds).size !== pairIds.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'active sessions require one original item per authored transfer pair' });
        break;
      }
    }
  }
  if (!value.event.assisted
    && value.event.session.items.some((item) => !item.correct)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'assisted'], message: 'automatic answer disclosure makes a failed active session assisted' });
  }
  if (value.event.independentError) {
    const evidence = value.event.independentError;
    const matchingOutcome = value.event.session.items.some((outcome) => !outcome.correct
      && outcome.id === evidence.itemId
      && outcome.diagnosticId === evidence.diagnosticId
      && outcome.errorCode === evidence.reason
      && (outcome.confusionPair || null) === (evidence.confusionPair || null));
    if (!value.event.assisted || value.event.source === 'generated' || !matchingOutcome
      || !catalogMatchesIndependentError(catalogItems.get(evidence.itemId), evidence)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'independentError'],
        message: 'independent session error must match one exact built-in catalog outcome before disclosure',
      });
    }
  }
  const legacyOccurrences = new Map();
  const legacyTotals = new Map(value.event.session.items.map((outcome) => [
    outcome.id, value.event.session.items.filter((candidate) => candidate.id === outcome.id).length,
  ]));
  value.event.session.items.forEach((outcome, index, outcomes) => {
    const generatedPointer = parseGeneratedGrammarItemId(outcome.id);
    const item = catalogItems.get(outcome.id) || (generatedPointer ? {
      id: outcome.id, type: generatedPointer.type, generated: true,
    } : null);
    const expectedType = item?.type;
    const supportsWeakness = (candidate, errorCode, pair) => candidate?.type === 'choice'
      ? candidate.diagnostics?.some((diagnostic) => diagnostic?.errorCode === errorCode
        && (diagnostic.confusionPair || null) === (pair || null))
      : candidate?.errorSkill === errorCode && (candidate.confusionPair || null) === (pair || null);
    const selectedDiagnostic = item?.type === 'choice'
      ? item.diagnostics?.find((diagnostic) => diagnostic?.id === outcome.diagnosticId)
      : null;
    const legacyErrorCode = item?.errorSkill || (expectedType === 'input' ? 'word_or_verb_form' : 'construction_choice');
    const expectedWeakness = outcome.correct
      ? outcome.diagnosticId == null && outcome.errorCode == null && outcome.confusionPair == null
      : !activeSession
        ? outcome.diagnosticId == null && outcome.confusionPair == null && outcome.errorCode === legacyErrorCode
        : item?.type === 'choice'
        ? selectedDiagnostic?.errorCode === outcome.errorCode
          && (selectedDiagnostic?.confusionPair || null) === (outcome.confusionPair || null)
        : outcome.diagnosticId == null && supportsWeakness(item, outcome.errorCode, outcome.confusionPair);
    if (!item || expectedType !== outcome.type || !expectedWeakness) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'session item does not match the server catalog' });
    }
    if (item?.generated ? (outcome.source !== 'generated' || !parseGeneratedGrammarItemReference(outcome))
      : (outcome.source != null || outcome.revision != null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'generated session items require exact revision provenance' });
    }
    if (!activeSession && (outcome.transfer || outcome.diagnosticId != null || outcome.confusionPair != null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'legacy sessions accept catalog outcomes without active transfer diagnostics' });
    }
    if (outcome.transfer) {
      const failed = outcomes[index - 1];
      const failedItem = catalogItems.get(failed?.id);
      if (!failed || failed.correct || failed.id === outcome.id
        || !failedItem || failedItem.transferPair !== item?.transferPair
        || !supportsWeakness(failedItem, failed.errorCode, failed.confusionPair)
        || !supportsWeakness(item, failed.errorCode, failed.confusionPair)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'transfer must immediately follow the same exact weakness' });
      }
    }
    if (activeSession && !outcome.transfer && !outcome.correct
      && outcomes[index + 1]?.transfer !== true) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'each failed original requires one adjacent authored transfer outcome' });
    }
    let expectedTransferStatus = outcome.transfer && !outcome.correct ? 'due_next_session' : null;
    if (!activeSession) {
      const occurrence = (legacyOccurrences.get(outcome.id) || 0) + 1;
      legacyOccurrences.set(outcome.id, occurrence);
      const total = legacyTotals.get(outcome.id);
      const first = outcomes.find((candidate) => candidate.id === outcome.id);
      if (total > 2 || (total === 2 && (first?.correct || occurrence === 1 && outcome.correct))
        || (total === 1 && !outcome.correct)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'legacy practice allows exactly one retry after an initial error' });
      }
      expectedTransferStatus = occurrence === 2 && !outcome.correct ? 'due_next_session' : null;
    }
    if ((outcome.transferStatus || null) !== expectedTransferStatus || (outcome.transferStatus != null
      && activeSession && (index < 1 || outcomes[index - 1]?.correct !== false))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index, 'transferStatus'], message: 'due-next-session requires one failed bounded transfer' });
    }
  });
});

export const grammarMasteryBatchSchema = z.object({
  owner: z.string().trim().min(1).max(128),
  batchId: z.string().uuid(),
  events: z.array(grammarMasteryEventSchema).min(1).max(20),
}).strict().refine(
  (value) => new Set(value.events.map((entry) => entry.event.id)).size === value.events.length,
  { message: 'duplicate event id' },
);
