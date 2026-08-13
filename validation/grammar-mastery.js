import { z } from 'zod';
import {
  GRAMMAR_CATALOG,
  GRAMMAR_CATALOG_REGISTRY,
  GRAMMAR_CATALOG_RUNTIMES,
  getGrammarCatalogRuntime,
} from '../public/grammar-catalog.js';
import {
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
  GRAMMAR_ERROR_CODES,
  GRAMMAR_PRACTICE_MODES,
  GENERATED_GRAMMAR_REVISION,
  isGrammarConfusionPair,
  isBuiltinGrammarDiagnosticId,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';
import { grammarRecommendationPointerSchema } from './grammar-recommendation.js';

const stages = ['not_started', 'learning', 'learned', 'confirmed', 'stable'];
const practiceTypes = GRAMMAR_ACTIVE_PRACTICE_TYPES;
const activeTopicIds = GRAMMAR_ACTIVE_TOPIC_IDS;
const preActivationLegacyTopicIds = GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS;
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
const currentCatalogRuntime = getGrammarCatalogRuntime(GRAMMAR_CATALOG.version, GRAMMAR_CATALOG.revision);

function runtimeTopicItem(runtime, topicId, itemId) {
  const entry = runtime?.getItem(itemId);
  return entry?.topicId === topicId ? entry.item : null;
}

export function hasExactActiveTransferPairCoverage(items, resolveItem, types = practiceTypes) {
  if (!Array.isArray(items) || typeof resolveItem !== 'function' || !Array.isArray(types)) return false;
  return types.every((type) => {
    const originals = items.filter((outcome) => !outcome.transfer && outcome.type === type);
    const pairIds = originals.map((outcome) => resolveItem(outcome.id)?.transferPair).filter(Boolean);
    return originals.length === 4 && pairIds.length === 4 && new Set(pairIds).size === 4;
  });
}

const confusionPair = z.string().refine(isGrammarConfusionPair, { message: 'invalid grammar confusion pair' });
const independentError = z.object({
  itemId: z.string().min(1).max(128),
  diagnosticId: z.string().refine(isBuiltinGrammarDiagnosticId, { message: 'invalid built-in grammar diagnostic' }).nullable(),
  reason: regressionReason,
  confusionPair: confusionPair.nullable(),
}).strict();

function catalogMatchesIndependentError(item, evidence, legacy = false) {
  if (!item || !evidence) return false;
  const diagnostic = item.diagnostics?.find((candidate) => candidate?.id === evidence.diagnosticId);
  if (diagnostic) {
    return diagnostic.errorCode === evidence.reason
      && (diagnostic.confusionPair || null) === (evidence.confusionPair || null);
  }
  if (!legacy && item.type === 'choice' && item.diagnostics?.some(Boolean)) return false;
  const expectedReason = legacy
    ? (item.type === 'input' ? 'word_or_verb_form' : 'construction_choice')
    : item.errorSkill || (item.type === 'input' ? 'word_or_verb_form' : 'construction_choice');
  return evidence.diagnosticId == null && evidence.reason === expectedReason
    && (legacy ? null : (item.confusionPair || null)) === (evidence.confusionPair || null);
}

const practiceSessionItem = z.object({
  id: z.string().min(1).max(128),
  topicId: z.number().int().min(1).max(20).optional(),
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
const masteryExpectation = z.object({
  topicId: z.number().int().min(1).max(20),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStage: z.enum(stages),
  expectedReviewStep: z.number().int().min(0).max(5),
}).strict();
const targetedRecommendation = z.object({
  pointer: grammarRecommendationPointerSchema,
  itemIds: z.array(z.string().min(1).max(128)).length(8)
    .refine((values) => new Set(values).size === values.length, { message: 'duplicate targeted item id' }),
  completionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();
const mixedIndependentError = z.object({
  topicId: z.number().int().min(1).max(20),
  itemId: z.string().min(1).max(128),
  diagnosticId: z.string().refine(isBuiltinGrammarDiagnosticId, { message: 'invalid built-in grammar diagnostic' }).nullable(),
  reason: regressionReason,
  confusionPair: confusionPair.nullable(),
}).strict();
const practiceSession = z.object({
  id: z.string().uuid(),
  scope: z.enum(['topic', 'mixed']),
  mode: z.enum(GRAMMAR_PRACTICE_MODES),
  source,
  catalog: z.discriminatedUnion('version', Object.values(GRAMMAR_CATALOG_REGISTRY).map((catalog) => (
    z.object({
      version: z.literal(catalog.version),
      revision: z.literal(catalog.revision),
    }).strict()
  ))),
  items: z.array(practiceSessionItem).min(1).max(32),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  assisted: z.boolean(),
  topicExpectations: z.array(masteryExpectation).min(1).max(16).optional(),
  recommendation: targetedRecommendation.optional(),
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
  independentErrors: z.array(mixedIndependentError).min(1).max(16)
    .refine((values) => new Set(values.map((value) => value.topicId)).size === values.length,
      { message: 'duplicate mixed independent-error topic' }).optional(),
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
  if (value.event.type === 'review_completed') {
    const evidence = value.event.independentError;
    const evidenceItem = evidence
      ? runtimeTopicItem(currentCatalogRuntime, value.topicId, evidence.itemId) : null;
    const historicalEvidenceItem = evidence && preActivationLegacyTopicIds.includes(value.topicId)
      ? GRAMMAR_CATALOG_RUNTIMES
        .filter((runtime) => runtime !== currentCatalogRuntime && !runtime.hasActivePractice(value.topicId))
        .map((runtime) => runtimeTopicItem(runtime, value.topicId, evidence.itemId))
        .find(Boolean) : null;
    const preActivationLegacyReview = historicalEvidenceItem && evidence.diagnosticId == null;
    const currentReview = evidence && catalogMatchesIndependentError(evidenceItem, evidence);
    const historicalReview = preActivationLegacyReview
      && catalogMatchesIndependentError(historicalEvidenceItem, evidence, true);
    if (evidence && (value.event.passed || !value.event.assisted || value.event.source === 'generated'
      || !(currentReview || historicalReview))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'independentError'],
        message: 'independent review error must match one exact built-in catalog pointer before disclosure',
      });
    }
    return;
  }
  const activeTopic = activeTopicIds.includes(value.topicId);
  const builtinSession = value.event.source === 'builtin';
  const topicPractice = value.event.session.mode === 'topic_practice';
  const mixedPractice = value.event.session.mode === 'mixed_practice';
  const targetedPractice = value.event.session.mode === 'targeted_practice';
  const examPractice = value.event.session.mode === 'exam_19_24';
  const sessionRuntime = getGrammarCatalogRuntime(
    value.event.session.catalog.version, value.event.session.catalog.revision,
  );
  const sessionTopicId = (outcome) => mixedPractice || examPractice ? Number(outcome?.topicId) : value.topicId;
  const sessionItem = (itemId, topicId = value.topicId) => runtimeTopicItem(sessionRuntime, topicId, itemId);
  const immutableLegacyCatalog = sessionRuntime !== currentCatalogRuntime;
  const sessionCatalogHasActiveTopic = sessionRuntime?.hasActivePractice(value.topicId) === true;
  const preActivationLegacy = preActivationLegacyTopicIds.includes(value.topicId) && builtinSession && !topicPractice
    && !mixedPractice && !targetedPractice && value.event.session.scope === 'topic'
    && immutableLegacyCatalog && !sessionCatalogHasActiveTopic
    && value.event.session.items.every((outcome) => sessionItem(outcome.id));
  const activeSession = builtinSession && topicPractice && value.event.session.scope === 'topic'
    && sessionCatalogHasActiveTopic;
  const mixedSession = builtinSession && mixedPractice && value.event.session.scope === 'mixed'
    && sessionRuntime === currentCatalogRuntime
    && value.event.session.items.length >= 16
    && value.event.session.items.every((outcome) => Number.isInteger(outcome.topicId)
      && sessionRuntime.hasActivePractice(outcome.topicId)
      && sessionItem(outcome.id, outcome.topicId));
  const targetedSession = builtinSession && targetedPractice && value.event.session.scope === 'topic'
    && sessionRuntime === currentCatalogRuntime && sessionCatalogHasActiveTopic
    && value.event.session.items.every((outcome) => outcome.topicId == null
      && sessionItem(outcome.id));
  const exactBuiltinExamForm = currentCatalogRuntime.catalog.exams.some((form) => (
    form.gaps.length === value.event.session.items.length
    && form.gaps.every((gap, index) => gap.id === value.event.session.items[index]?.id
      && Number(gap.t) === value.event.session.items[index]?.topicId)
  ));
  const builtinExamSession = builtinSession && examPractice && value.event.session.scope === 'mixed'
    && sessionRuntime === currentCatalogRuntime && value.event.session.items.length === 6
    && exactBuiltinExamForm
    && value.event.session.items.every((outcome) => Number.isInteger(outcome.topicId)
      && outcome.type === 'input' && outcome.transfer === false
      && /^core\.g\.exam\.[1-3]\.[1-6]$/u.test(outcome.id)
      && sessionItem(outcome.id, outcome.topicId));
  const generatedExamPointers = value.event.session.items.map((outcome) => parseGeneratedGrammarItemId(outcome.id));
  const generatedExamSession = value.event.source === 'generated' && examPractice
    && value.event.session.scope === 'mixed' && sessionRuntime === currentCatalogRuntime
    && value.event.session.items.length === 6
    && generatedExamPointers.every((pointer, index) => pointer?.operation === 'grammar_exam_19_24'
      && pointer.type === 'input' && pointer.groupId === generatedExamPointers[0]?.groupId
      && pointer.index === index + 1)
    && value.event.session.items.every((outcome) => Number.isInteger(outcome.topicId)
      && outcome.transfer === false);
  const examSession = builtinExamSession || generatedExamSession;
  const structuredSession = activeSession || mixedSession || targetedSession;
  const catalogBoundSession = structuredSession || examSession;
  const multiTopicSession = mixedSession || examSession;
  const validMode = catalogBoundSession || preActivationLegacy
    || (!activeTopic || !builtinSession) && !topicPractice && !mixedPractice && !targetedPractice && !examPractice
      && value.event.session.scope === 'topic';
  if (!validMode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'mode'], message: 'topic and content generation require their canonical practice mode' });
  }
  if (multiTopicSession && value.event.session.items[0]?.topicId !== value.topicId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['topicId'], message: 'mixed history owner must match its first exact catalog outcome' });
  }
  const originalItems = value.event.session.items.filter((item) => !item.transfer);
  if (multiTopicSession) {
    const exactTopics = [...new Set(originalItems.map((item) => item.topicId))];
    const expectations = value.event.session.topicExpectations || [];
    if (expectations.length !== exactTopics.length
      || expectations.some((expectation, index) => expectation.topicId !== exactTopics[index])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'session', 'topicExpectations'],
        message: 'mixed sessions bind one ordered mastery expectation to every exact original topic',
      });
    }
    const ownerExpectation = expectations.find((expectation) => expectation.topicId === value.topicId);
    if (!ownerExpectation || ownerExpectation.expectedRevision !== value.event.expectedRevision
      || ownerExpectation.expectedStage !== value.event.expectedStage
      || ownerExpectation.expectedReviewStep !== value.event.expectedReviewStep) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'session', 'topicExpectations'],
        message: 'mixed history owner expectation must match the event envelope',
      });
    }
    if (value.event.independentError || value.event.session.recommendation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event'],
        message: 'multi-topic sessions use per-topic errors and cannot claim a targeted recommendation',
      });
    }
  } else if (targetedSession) {
    const binding = value.event.session.recommendation;
    const originalIds = originalItems.map((item) => item.id);
    if (!binding || binding.pointer.topicId !== value.topicId
      || binding.pointer.catalogVersion !== value.event.session.catalog.version
      || binding.pointer.catalogRevision !== value.event.session.catalog.revision
      || JSON.stringify(binding.itemIds) !== JSON.stringify(originalIds)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'session', 'recommendation'],
        message: 'targeted completion requires its exact server-issued pointer and original item sequence',
      });
    }
    if (value.event.independentErrors || value.event.session.topicExpectations) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event'],
        message: 'targeted sessions cannot claim mixed per-topic state',
      });
    }
  } else if (value.event.independentErrors || value.event.session.topicExpectations
    || value.event.session.recommendation) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['event', 'session'],
      message: 'mixed and targeted state is mode-bound',
    });
  }
  if (!mixedPractice && !examPractice && value.event.session.items.some((outcome) => outcome.topicId != null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'topic sessions cannot substitute item topic ownership' });
  }
  if (immutableLegacyCatalog && value.event.session.items.some((outcome) => (
    !parseGeneratedGrammarItemId(outcome.id) && !sessionItem(outcome.id)
  ))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['event', 'session', 'catalog'],
      message: 'immutable historical identity accepts only its exact built-in membership',
    });
  }
  if ((activeSession || mixedSession) && (!practiceTypes.every((type) => value.event.completedTypes.includes(type))
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
  if (!catalogBoundSession && value.event.session.items.length > 16) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'legacy sessions are bounded to eight originals and one retry each' });
  }
  if ((activeSession || mixedSession)
    && !practiceTypes.every((type) => value.event.session.items.filter((item) => !item.transfer && item.type === type).length === 4)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'active sessions require exactly four original items per practice type' });
  }
  if (catalogBoundSession
    && new Set(value.event.session.items.map((item) => item.id)).size !== value.event.session.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'active sessions cannot repeat a practice item' });
  }
  if (activeSession && !hasExactActiveTransferPairCoverage(
    value.event.session.items, sessionItem, practiceTypes,
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'active sessions require one original item per authored transfer pair' });
  }
  if (mixedSession) {
    const originals = value.event.session.items.filter((item) => !item.transfer);
    const topicCounts = new Map();
    for (const outcome of originals) topicCounts.set(outcome.topicId, (topicCounts.get(outcome.topicId) || 0) + 1);
    if (topicCounts.size < 8 || Math.max(...topicCounts.values()) > 2) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'mixed sessions balance at least eight topics with at most two originals each' });
    }
  }
  if (targetedSession && value.event.session.items.filter((item) => !item.transfer).length !== 8) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items'], message: 'targeted sessions require exactly eight bounded original items' });
  }
  if (!value.event.assisted
    && value.event.session.items.some((item) => !item.correct)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'assisted'], message: 'automatic answer disclosure makes a failed active session assisted' });
  }
  if (value.event.independentError) {
    const evidence = value.event.independentError;
    const matchingOutcome = value.event.session.items.find((outcome) => !outcome.correct
      && outcome.id === evidence.itemId
      && outcome.diagnosticId === evidence.diagnosticId
      && outcome.errorCode === evidence.reason
      && (outcome.confusionPair || null) === (evidence.confusionPair || null));
    if (!value.event.assisted || value.event.source === 'generated' || !matchingOutcome
      || !catalogMatchesIndependentError(
        sessionItem(evidence.itemId, sessionTopicId(matchingOutcome)), evidence, !catalogBoundSession,
      )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'independentError'],
        message: 'independent session error must match one exact built-in catalog outcome before disclosure',
      });
    }
  }
  if (value.event.independentErrors) {
    for (const [index, evidence] of value.event.independentErrors.entries()) {
      const matchingOutcome = value.event.session.items.find((outcome) => !outcome.correct
        && outcome.topicId === evidence.topicId
        && outcome.id === evidence.itemId
        && outcome.diagnosticId === evidence.diagnosticId
        && outcome.errorCode === evidence.reason
        && (outcome.confusionPair || null) === (evidence.confusionPair || null));
      if (!multiTopicSession || !value.event.assisted || value.event.source !== 'builtin'
        || !matchingOutcome || !catalogMatchesIndependentError(
          sessionItem(evidence.itemId, evidence.topicId), evidence,
        )) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['event', 'independentErrors', index],
          message: 'mixed independent error must match one exact built-in catalog outcome and topic',
        });
      }
    }
  }
  if (builtinExamSession) {
    const expectedErrors = [];
    for (const outcome of value.event.session.items) {
      if (outcome.correct || expectedErrors.some((error) => error.topicId === outcome.topicId)) continue;
      expectedErrors.push({
        topicId: outcome.topicId,
        itemId: outcome.id,
        diagnosticId: null,
        reason: outcome.errorCode,
        confusionPair: outcome.confusionPair || null,
      });
    }
    if (JSON.stringify(value.event.independentErrors || []) !== JSON.stringify(expectedErrors)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event', 'independentErrors'],
        message: 'built-in exam errors must equal the first wrong exact catalog outcome for every physical topic',
      });
    }
  }
  const legacyOccurrences = new Map();
  const legacyTotals = new Map(value.event.session.items.map((outcome) => [
    outcome.id, value.event.session.items.filter((candidate) => candidate.id === outcome.id).length,
  ]));
  value.event.session.items.forEach((outcome, index, outcomes) => {
    const generatedPointer = parseGeneratedGrammarItemId(outcome.id);
    const outcomeTopicId = sessionTopicId(outcome);
    const item = sessionItem(outcome.id, outcomeTopicId) || (generatedPointer ? {
      id: outcome.id, type: generatedPointer.type, generated: true,
      errorSkill: 'word_or_verb_form', confusionPair: null,
    } : null);
    const expectedType = item?.type;
    const supportsWeakness = (candidate, errorCode, pair) => candidate?.type === 'choice'
      ? candidate.diagnostics?.some((diagnostic) => diagnostic?.errorCode === errorCode
        && (diagnostic.confusionPair || null) === (pair || null))
      : (candidate?.errorSkill || (candidate?.type === 'input' ? 'word_or_verb_form' : null)) === errorCode
        && (candidate.confusionPair || null) === (pair || null);
    const selectedDiagnostic = item?.type === 'choice'
      ? item.diagnostics?.find((diagnostic) => diagnostic?.id === outcome.diagnosticId)
      : null;
    const legacyErrorCode = expectedType === 'input' ? 'word_or_verb_form' : 'construction_choice';
    const expectedWeakness = outcome.correct
      ? outcome.diagnosticId == null && outcome.errorCode == null && outcome.confusionPair == null
      : !catalogBoundSession
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
    if (!catalogBoundSession && (outcome.transfer || outcome.diagnosticId != null || outcome.confusionPair != null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'legacy sessions accept catalog outcomes without active transfer diagnostics' });
    }
    if (outcome.transfer) {
      const failed = outcomes[index - 1];
      const failedItem = sessionItem(failed?.id, sessionTopicId(failed));
      if (!failed || failed.correct || failed.id === outcome.id
        || sessionTopicId(failed) !== outcomeTopicId
        || !failedItem || failedItem.transferPair !== item?.transferPair
        || !supportsWeakness(failedItem, failed.errorCode, failed.confusionPair)
        || !supportsWeakness(item, failed.errorCode, failed.confusionPair)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'transfer must immediately follow the same exact weakness' });
      }
    }
    if (structuredSession && !outcome.transfer && !outcome.correct
      && outcomes[index + 1]?.transfer !== true) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['event', 'session', 'items', index], message: 'each failed original requires one adjacent authored transfer outcome' });
    }
    let expectedTransferStatus = outcome.transfer && !outcome.correct ? 'due_next_session' : null;
    if (!catalogBoundSession) {
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
      && structuredSession && (index < 1 || outcomes[index - 1]?.correct !== false))) {
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
