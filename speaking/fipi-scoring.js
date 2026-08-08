import { z } from 'zod';
import { boundedAcousticMetric } from './acoustic-metrics.js';

export const SPEAKING_SCORING_VERSION = 'speaking-fipi-combiner-v2';
export const SPEAKING_SEMANTIC_CONFIDENCE_THRESHOLD = 0.65;

const TASK_MAXIMA = Object.freeze({ 1: 1, 2: 4, 3: 5, 4: 10 });
const TASK_CRITERIA = Object.freeze({
  1: Object.freeze([{ name: 'Чтение вслух', max: 1 }]),
  2: Object.freeze(Array.from({ length: 4 }, (_, index) => Object.freeze({ name: `Вопрос ${index + 1}`, max: 1 }))),
  3: Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({ name: `Ответ ${index + 1}`, max: 1 }))),
  4: Object.freeze([
    Object.freeze({ name: 'Решение коммуникативной задачи', max: 4 }),
    Object.freeze({ name: 'Организация', max: 3 }),
    Object.freeze({ name: 'Языковое оформление', max: 3 }),
  ]),
});

const safeText = (max) => z.string().trim().min(1).max(max)
  .refine((value) => !/[<>]/u.test(value), { message: 'markup is not allowed' });
const eventId = z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/u);
const feedbackIssueSchema = z.object({
  id: eventId,
  owner: z.enum(['content', 'organization', 'language']),
  code: z.enum([
    'content_missing', 'content_irrelevant', 'question_not_direct', 'answer_incomplete',
    'organization_coherence', 'organization_sequence', 'organization_linking',
    'language_grammar', 'language_vocabulary', 'language_register',
  ]),
  evidence: safeText(400),
  correction: safeText(500),
}).strict();
const scoringEventSchema = z.object({
  id: eventId,
  start: z.number().int().min(0).max(20_000),
  end: z.number().int().min(1).max(20_000),
  evidence: safeText(400),
  correction: safeText(500),
}).strict().refine((event) => event.end > event.start, { message: 'event span must be positive' });
const languageEventSchema = scoringEventSchema.extend({ gross: z.boolean() }).strict();
const commonShape = {
  confidence: z.number().finite().min(0).max(1),
  verdict: safeText(600),
  evidence: z.array(safeText(400)).max(6),
  issues: z.array(feedbackIssueSchema).max(12),
};
const indexedEvidence = (extra) => z.object({
  index: z.number().int(),
  evidence: safeText(400),
  ...extra,
}).strict();
const contentAspectSchema = indexedEvidence({
  id: eventId,
  start: z.number().int().min(0).max(20_000),
  end: z.number().int().min(0).max(20_000),
  correction: safeText(500),
  status: z.enum(['full', 'partial', 'missing']),
}).superRefine((aspect, context) => {
  if (aspect.status === 'partial' && aspect.end <= aspect.start) {
    context.addIssue({ code: 'custom', message: 'partial content needs a positive transcript span' });
  }
  if (aspect.status !== 'partial' && (aspect.start !== 0 || aspect.end !== 0)) {
    context.addIssue({ code: 'custom', message: 'full or absent content uses the zero absence span' });
  }
});

const rawSemanticSchemas = Object.freeze({
  1: z.object({ ...commonShape }).strict(),
  2: z.object({
    ...commonShape,
    items: z.array(indexedEvidence({
      relevant: z.boolean(),
      directQuestion: z.boolean(),
      lexicalGrammarBlocksCommunication: z.boolean(),
    })).length(4),
  }).strict(),
  3: z.object({
    ...commonShape,
    items: z.array(indexedEvidence({
      relevant: z.boolean(),
      complete: z.boolean(),
      communicativelyAppropriate: z.boolean(),
      phraseCount: z.number().int().min(0).max(20),
      elementaryLexicalGrammarError: z.boolean(),
    })).length(5),
  }).strict(),
  4: z.object({
    ...commonShape,
    phraseCount: z.number().int().min(0).max(100),
    wordList: z.boolean(),
    introductionPresent: z.boolean(),
    conclusionPresent: z.boolean(),
    contentAspects: z.array(contentAspectSchema).length(4),
    organizationErrors: z.array(scoringEventSchema).max(20),
    lexicalGrammarErrors: z.array(languageEventSchema).max(40),
  }).strict(),
});

function semanticInvalid() {
  return Object.assign(new Error('SPEAKING_SEMANTIC_FACTS_INVALID'), {
    code: 'SPEAKING_SEMANTIC_FACTS_INVALID',
  });
}

function validateIndexes(items) {
  return items.every((item, index) => item.index === index + 1);
}

function eventSpansOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function validateUniqueEvents(facts) {
  const feedbackIds = new Set();
  for (const issue of facts.issues) {
    if (feedbackIds.has(issue.id)) throw semanticInvalid();
    feedbackIds.add(issue.id);
  }
  const scoringEvents = [
    ...(facts.contentAspects || []).filter((aspect) => aspect.status !== 'full'),
    ...(facts.organizationErrors || []),
    ...(facts.lexicalGrammarErrors || []),
  ];
  const scoringIds = new Set();
  for (const [index, event] of scoringEvents.entries()) {
    if (scoringIds.has(event.id) || scoringEvents.slice(0, index).some((other) => eventSpansOverlap(event, other))) {
      throw semanticInvalid();
    }
    scoringIds.add(event.id);
  }
}

export function parseSpeakingSemanticFacts(taskType, input) {
  const schema = rawSemanticSchemas[taskType];
  if (!schema) throw semanticInvalid();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw semanticInvalid();
  const facts = parsed.data;
  if ((facts.items && !validateIndexes(facts.items))
    || (facts.contentAspects && !validateIndexes(facts.contentAspects))) throw semanticInvalid();
  validateUniqueEvents(facts);
  return facts;
}

const acousticEventSchema = z.object({
  id: eventId,
  owner: z.literal('azure_pronunciation'),
  type: z.enum(['mispronunciation', 'omission', 'insertion', 'unexpected_break', 'missing_break', 'monotone']),
  gross: z.boolean().nullable(),
  itemIndex: z.number().int().min(1).max(5).nullable(),
  accuracyScore: z.number().finite().min(0).max(100).nullable(),
  start: z.number().int().min(0).max(20_000).nullable(),
  end: z.number().int().min(1).max(20_000).nullable(),
  offsetSeconds: z.number().finite().min(0).max(180).nullable().optional(),
  durationSeconds: z.number().finite().positive().max(180).nullable().optional(),
  word: z.string().trim().min(1).max(120).optional(),
  phonemes: z.array(z.object({
    label: z.string().trim().min(1).max(20),
    accuracyScore: z.number().finite().min(0).max(100).nullable(),
  }).strict()).max(20).optional(),
}).strict().superRefine((event, context) => {
  if ((event.start == null) !== (event.end == null)) {
    context.addIssue({ code: 'custom', message: 'acoustic transcript span must be complete' });
  } else if (event.start != null && event.end <= event.start) {
    context.addIssue({ code: 'custom', message: 'acoustic transcript span must be positive' });
  }
  if ((event.offsetSeconds == null) !== (event.durationSeconds == null)) {
    context.addIssue({ code: 'custom', message: 'acoustic word timing must be complete' });
  } else if (event.offsetSeconds != null && event.offsetSeconds + event.durationSeconds > 180.001) {
    context.addIssue({ code: 'custom', message: 'acoustic word timing exceeds the recording limit' });
  }
});
const acousticItemDurationSchema = z.object({
  itemIndex: z.number().int().min(1).max(5),
  durationSeconds: z.number().finite().min(1).max(180),
}).strict();
const acousticTargetMeasurementSchema = z.object({
  focusRef: z.string().trim().min(1).max(120)
    .regex(/^(?:word|phoneme)\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u),
  kind: z.enum(['word', 'phoneme']),
  value: safeText(120),
  anchorWord: safeText(120),
  anchorObserved: z.boolean(),
  score: z.number().finite().min(0).max(100).nullable(),
}).strict().superRefine((measurement, context) => {
  if (!measurement.focusRef.startsWith(`${measurement.kind}.`)) {
    context.addIssue({ code: 'custom', message: 'target measurement kind must match focus reference' });
  }
  if (measurement.kind === 'phoneme' && measurement.value.length > 20) {
    context.addIssue({ code: 'custom', message: 'target phoneme is too long' });
  }
  if (!measurement.anchorObserved && measurement.score != null) {
    context.addIssue({ code: 'custom', message: 'unobserved target anchor cannot have a score' });
  }
});
const acousticSchema = z.object({
  available: z.literal(true),
  accentLocale: z.enum(['en-GB', 'en-US']).optional(),
  pauseAnalysisAvailable: z.boolean().default(false),
  recognitionConfidence: z.number().finite().min(0).max(1).nullable(),
  signalQuality: z.enum(['good', 'acceptable', 'poor']),
  recordingDurationSeconds: z.number().finite().min(1).max(900),
  itemDurations: z.array(acousticItemDurationSchema).max(5),
  completenessScore: z.number().finite().min(0).max(100).nullable().optional(),
  fluencyScore: z.number().finite().min(0).max(100).nullable().optional(),
  wordAccuracyScore: z.number().finite().min(0).max(100).nullable().optional(),
  phonemeAccuracyScore: z.number().finite().min(0).max(100).nullable().optional(),
  wordEvents: z.array(acousticEventSchema).max(300),
  targetMeasurement: acousticTargetMeasurementSchema.optional(),
}).strict().superRefine((facts, context) => {
  const ids = new Set();
  for (const event of facts.wordEvents) {
    if (ids.has(event.id)) context.addIssue({ code: 'custom', message: 'duplicate acoustic event id' });
    ids.add(event.id);
  }
  const itemIndexes = new Set();
  for (const item of facts.itemDurations) {
    if (itemIndexes.has(item.itemIndex)) context.addIssue({ code: 'custom', message: 'duplicate acoustic item duration' });
    itemIndexes.add(item.itemIndex);
  }
});

const storedReviewSchema = z.object({
  status: z.literal('scored'),
  got: z.number().int().min(0).max(10),
  max: z.number().int().min(1).max(10),
  verdict: safeText(600),
  criteria: z.array(z.object({
    name: safeText(160), got: z.number().int().min(0).max(10), max: z.number().int().min(1).max(10),
  }).strict()).min(1).max(5),
  good: z.array(safeText(400)).max(3),
  fix: z.array(z.object({
    wrong: safeText(400), right: safeText(500), note: safeText(80),
  }).strict()).max(4),
  confidence: z.number().finite().min(0).max(1),
  needsRetryReason: z.null(),
  scoringVersion: z.literal(SPEAKING_SCORING_VERSION),
  semanticFacts: z.unknown(),
  acousticFacts: z.unknown(),
}).strict();

function retryResult(taskType, reason) {
  return Object.freeze({
    status: 'needs_retry', taskType, score: null, maxScore: TASK_MAXIMA[taskType], criteria: [],
    reason, scoringVersion: SPEAKING_SCORING_VERSION,
  });
}

function scoredResult(taskType, score, criteria) {
  return Object.freeze({
    status: 'scored', taskType, score, maxScore: TASK_MAXIMA[taskType],
    criteria: Object.freeze(criteria.map((criterion) => Object.freeze(criterion))),
    reason: null, scoringVersion: SPEAKING_SCORING_VERSION,
  });
}

function parseAcoustic(taskType, acoustic) {
  const checked = acousticSchema.safeParse(acoustic);
  if (!checked.success) return { retry: retryResult(taskType, 'acoustic_evidence_unavailable') };
  const facts = checked.data;
  const minimumDuration = { 1: 5, 2: 4, 3: 10, 4: 20 }[taskType];
  if (!minimumDuration || facts.recordingDurationSeconds < minimumDuration) {
    return { retry: retryResult(taskType, 'acoustic_recording_too_short') };
  }
  const itemRule = {
    2: { count: 4, minimumSeconds: 1 },
    3: { count: 5, minimumSeconds: 2 },
  }[taskType];
  if (itemRule) {
    const exactIndexes = facts.itemDurations.length === itemRule.count
      && facts.itemDurations.every((item, index) => item.itemIndex === index + 1);
    const totalDuration = facts.itemDurations.reduce((sum, item) => sum + item.durationSeconds, 0);
    if (!exactIndexes || Math.abs(totalDuration - facts.recordingDurationSeconds) > 0.01
      || facts.itemDurations.some((item) => item.durationSeconds < itemRule.minimumSeconds)) {
      return { retry: retryResult(taskType, 'acoustic_recording_too_short') };
    }
  } else if (facts.itemDurations.length !== 0) {
    return { retry: retryResult(taskType, 'acoustic_evidence_unavailable') };
  }
  if (facts.recognitionConfidence == null
    || facts.recognitionConfidence < SPEAKING_SEMANTIC_CONFIDENCE_THRESHOLD
    || facts.signalQuality === 'poor') {
    return { retry: retryResult(taskType, 'acoustic_evidence_uncertain') };
  }
  return { facts };
}

export function speakingAcousticRetryReason(taskType, acoustic) {
  return parseAcoustic(taskType, acoustic).retry?.reason || null;
}

function task1Score(acoustic) {
  const parsed = parseAcoustic(1, acoustic);
  if (parsed.retry) return parsed.retry;
  const facts = parsed.facts;
  if (!Number.isFinite(facts.completenessScore) || !Number.isFinite(facts.fluencyScore)) {
    return retryResult(1, 'acoustic_evidence_uncertain');
  }
  const scoringEvents = facts.wordEvents.filter((event) => (
    ['mispronunciation', 'omission', 'insertion'].includes(event.type)
  ));
  const errors = scoringEvents.length;
  const decisiveFailure = facts.completenessScore < 85 || facts.fluencyScore < 60 || errors > 5;
  if (decisiveFailure) return scoredResult(1, 0, [{
    name: 'Чтение вслух', score: 0, maxScore: 1, evidenceOwner: 'azure_acoustic_and_server_combiner',
  }]);
  if (scoringEvents.some((event) => event.gross == null)) {
    return retryResult(1, 'critical_error_evidence_unknown');
  }
  const grossErrors = scoringEvents.filter((event) => event.gross).length;
  const score = grossErrors <= 2 ? 1 : 0;
  return scoredResult(1, score, [{
    name: 'Чтение вслух', score, maxScore: 1, evidenceOwner: 'azure_acoustic_and_server_combiner',
  }]);
}

function acousticEventsForItem(facts, itemIndex) {
  return facts.wordEvents.filter((event) => event.itemIndex === itemIndex
    && ['mispronunciation', 'omission', 'insertion'].includes(event.type));
}

function task2Score(semantic, acoustic) {
  const parsed = parseAcoustic(2, acoustic);
  if (parsed.retry) return parsed.retry;
  const criteria = semantic.items.map((item) => {
    const semanticallyCorrect = item.relevant && item.directQuestion
      && !item.lexicalGrammarBlocksCommunication;
    if (!semanticallyCorrect) {
      return { name: `Вопрос ${item.index}`, score: 0, maxScore: 1, evidenceOwner: 'bounded_semantic_facts' };
    }
    const acousticEvents = acousticEventsForItem(parsed.facts, item.index);
    if (acousticEvents.some((event) => event.gross == null)) return null;
    const score = Number(!acousticEvents.some((event) => event.gross));
    return { name: `Вопрос ${item.index}`, score, maxScore: 1, evidenceOwner: 'bounded_semantic_and_azure_facts' };
  });
  if (criteria.some((criterion) => criterion == null)) return retryResult(2, 'critical_error_evidence_unknown');
  return scoredResult(2, criteria.reduce((sum, item) => sum + item.score, 0), criteria);
}

function task3Score(semantic, acoustic) {
  const parsed = parseAcoustic(3, acoustic);
  if (parsed.retry) return parsed.retry;
  const criteria = semantic.items.map((item) => {
    const score = Number(item.relevant && item.complete && item.communicativelyAppropriate
      && item.phraseCount >= 2 && item.phraseCount <= 3
      && !item.elementaryLexicalGrammarError
      && acousticEventsForItem(parsed.facts, item.index).length === 0);
    return { name: `Ответ ${item.index}`, score, maxScore: 1, evidenceOwner: 'bounded_semantic_and_azure_facts' };
  });
  return scoredResult(3, criteria.reduce((sum, item) => sum + item.score, 0), criteria);
}

function task4ContentScore(semantic) {
  const missing = semantic.contentAspects.filter((aspect) => aspect.status === 'missing').length;
  const partial = semantic.contentAspects.filter((aspect) => aspect.status === 'partial').length;
  let aspectBand = 0;
  if (missing === 0 && partial === 0) aspectBand = 4;
  else if ((missing === 1 && partial === 0) || (missing === 0 && partial <= 2)) aspectBand = 3;
  else if ((missing === 1 && partial === 1) || (missing === 0 && partial === 3)) aspectBand = 2;
  else if ((missing === 1 && partial === 2) || (missing === 2 && partial === 0)
    || (missing === 0 && partial === 4)) aspectBand = 1;
  const phraseBand = semantic.phraseCount <= 7 ? 0 : semantic.phraseCount <= 9 ? 1
    : semantic.phraseCount <= 11 ? 2 : 4;
  return Math.min(aspectBand, phraseBand);
}

function task4OrganizationScore(semantic) {
  const errors = semantic.organizationErrors.length;
  if ((!semantic.introductionPresent && !semantic.conclusionPresent) || errors >= 6) return 0;
  if (!semantic.introductionPresent || !semantic.conclusionPresent || errors >= 4) return 1;
  if (errors >= 2) return 2;
  return 3;
}

function languageBand(total, gross) {
  if (total >= 8 || gross >= 4) return 0;
  if (total >= 6 || gross >= 3) return 1;
  if (total >= 4 || gross >= 1) return 2;
  return 3;
}

function task4LanguageScore(semantic, acoustic) {
  if (semantic.wordList) return 0;
  const scoringEvents = acoustic.wordEvents.filter((event) => (
    ['mispronunciation', 'omission', 'insertion'].includes(event.type)
  ));
  if (scoringEvents.some((event) => event.gross == null)) return null;
  const total = semantic.lexicalGrammarErrors.length + scoringEvents.length;
  const gross = semantic.lexicalGrammarErrors.filter((event) => event.gross).length
    + scoringEvents.filter((event) => event.gross).length;
  return languageBand(total, gross);
}

function task4HasCrossSourceOwnershipConflict(semantic, acoustic) {
  const semanticEvents = [
    ...semantic.contentAspects.filter((aspect) => aspect.status === 'partial'),
    ...semantic.organizationErrors,
    ...semantic.lexicalGrammarErrors,
  ];
  return acoustic.wordEvents.filter((event) => (
    ['mispronunciation', 'omission', 'insertion'].includes(event.type)
  )).some((event) => event.start == null || event.end == null
    || semanticEvents.some((semanticEvent) => eventSpansOverlap(event, semanticEvent)));
}

function task4Score(semantic, acoustic) {
  const parsed = parseAcoustic(4, acoustic);
  if (parsed.retry) return parsed.retry;
  const content = task4ContentScore(semantic);
  if (content === 0) return scoredResult(4, 0, [
    { name: 'Решение коммуникативной задачи', score: 0, maxScore: 4, evidenceOwner: 'bounded_semantic_facts' },
    { name: 'Организация', score: 0, maxScore: 3, evidenceOwner: 'fipi_zero_content_rule' },
    { name: 'Языковое оформление', score: 0, maxScore: 3, evidenceOwner: 'fipi_zero_content_rule' },
  ]);
  if (task4HasCrossSourceOwnershipConflict(semantic, parsed.facts)) {
    return retryResult(4, 'scoring_event_ownership_conflict');
  }
  const organization = task4OrganizationScore(semantic);
  const language = task4LanguageScore(semantic, parsed.facts);
  if (language == null) return retryResult(4, 'critical_error_evidence_unknown');
  return scoredResult(4, content + organization + language, [
    { name: 'Решение коммуникативной задачи', score: content, maxScore: 4, evidenceOwner: 'bounded_semantic_facts' },
    { name: 'Организация', score: organization, maxScore: 3, evidenceOwner: 'bounded_semantic_events' },
    { name: 'Языковое оформление', score: language, maxScore: 3, evidenceOwner: 'bounded_semantic_and_azure_events' },
  ]);
}

export function scoreSpeakingTask({ taskType, semantic: input, acoustic = null }) {
  const semantic = parseSpeakingSemanticFacts(taskType, input);
  if (taskType !== 1 && semantic.confidence < SPEAKING_SEMANTIC_CONFIDENCE_THRESHOLD) {
    return retryResult(taskType, 'semantic_evidence_uncertain');
  }
  if (taskType === 1) return task1Score(acoustic);
  if (taskType === 2) return task2Score(semantic, acoustic);
  if (taskType === 3) return task3Score(semantic, acoustic);
  if (taskType === 4) return task4Score(semantic, acoustic);
  throw semanticInvalid();
}

export function combineFullSpeakingScore(results) {
  const values = Array.isArray(results) ? results : [];
  if (values.some((result) => result?.status === 'needs_retry')) {
    return Object.freeze({ status: 'needs_retry', score: null, maxScore: 20, scoringVersion: SPEAKING_SCORING_VERSION });
  }
  const byTask = new Map(values.map((result) => [result?.taskType, result]));
  if ([1, 2, 3, 4].some((taskType) => {
    const result = byTask.get(taskType);
    return result?.status !== 'scored' || result.maxScore !== TASK_MAXIMA[taskType]
      || !Number.isInteger(result.score) || result.score < 0 || result.score > result.maxScore;
  })) throw Object.assign(new Error('SPEAKING_FULL_SCORE_INVALID'), { code: 'SPEAKING_FULL_SCORE_INVALID' });
  return Object.freeze({
    status: 'scored',
    score: [1, 2, 3, 4].reduce((sum, taskType) => sum + byTask.get(taskType).score, 0),
    maxScore: 20,
    scoringVersion: SPEAKING_SCORING_VERSION,
  });
}

function publicFixes(facts) {
  const scoring = [...(facts.organizationErrors || []), ...(facts.lexicalGrammarErrors || [])]
    .map((issue) => ({ wrong: issue.evidence, right: issue.correction, note: issue.id }));
  return [...facts.issues.map((issue) => ({
    wrong: issue.evidence, right: issue.correction, note: issue.code,
  })), ...scoring].slice(0, 4);
}

const retryVerdicts = Object.freeze({
  scoring_event_ownership_conflict: 'Одну и ту же ошибку нельзя надёжно разделить между содержанием и произношением. Запишите ответ ещё раз.',
  semantic_evidence_uncertain: 'Запись или ответ не удалось оценить достаточно уверенно. Попробуйте ещё раз.',
  acoustic_evidence_unavailable: 'Нет достаточных данных о произношении. Запишите ответ ещё раз.',
  acoustic_evidence_uncertain: 'Качество записи недостаточно для надёжной оценки. Запишите ответ ещё раз.',
  acoustic_recording_too_short: 'Запись слишком короткая для надёжной оценки этого задания. Запишите полный ответ ещё раз.',
  critical_error_evidence_unknown: 'Нельзя надёжно определить тяжесть ошибки произношения. Запишите ответ ещё раз.',
});

export function publicSpeakingAcousticRetry(taskType, acoustic) {
  const reason = speakingAcousticRetryReason(taskType, acoustic);
  if (!reason) return null;
  return {
    status: 'needs_retry', got: null, max: TASK_MAXIMA[taskType],
    verdict: retryVerdicts[reason], criteria: [], good: [], fix: [],
    confidence: boundedAcousticMetric(acoustic?.recognitionConfidence, { maximum: 1 }),
    needsRetryReason: reason, scoringVersion: SPEAKING_SCORING_VERSION,
  };
}

export function publicSpeakingReview(scored, semantic) {
  const facts = parseSpeakingSemanticFacts(scored.taskType, semantic);
  if (scored.status === 'needs_retry') {
    return {
      status: scored.status, got: null, max: scored.maxScore,
      verdict: retryVerdicts[scored.reason] || 'Ответ не удалось оценить надёжно. Попробуйте ещё раз.',
      criteria: [], good: [], fix: [], confidence: facts.confidence,
      needsRetryReason: scored.reason, scoringVersion: scored.scoringVersion,
    };
  }
  return {
    status: scored.status, got: scored.score, max: scored.maxScore, verdict: facts.verdict,
    criteria: scored.criteria.map((criterion) => ({
      name: criterion.name, got: criterion.score, max: criterion.maxScore,
    })),
    good: facts.evidence.slice(0, 3), fix: publicFixes(facts), confidence: facts.confidence,
    needsRetryReason: scored.reason, scoringVersion: scored.scoringVersion,
  };
}

export function parseStoredSpeakingReview(taskType, input) {
  const checked = storedReviewSchema.safeParse(input);
  if (!checked.success || checked.data.max !== TASK_MAXIMA[taskType]) throw semanticInvalid();
  const review = checked.data;
  const expectedCriteria = TASK_CRITERIA[taskType];
  if (!expectedCriteria || review.criteria.length !== expectedCriteria.length
    || review.criteria.some((criterion, index) => (
      criterion.name !== expectedCriteria[index].name || criterion.max !== expectedCriteria[index].max
    ))) throw semanticInvalid();
  const criteriaGot = review.criteria.reduce((sum, criterion) => sum + criterion.got, 0);
  const criteriaMax = review.criteria.reduce((sum, criterion) => sum + criterion.max, 0);
  if (criteriaGot !== review.got || criteriaMax !== review.max
    || review.criteria.some((criterion) => criterion.got > criterion.max)) throw semanticInvalid();
  parseSpeakingSemanticFacts(taskType, review.semanticFacts);
  const recomputed = scoreSpeakingTask({
    taskType, semantic: review.semanticFacts, acoustic: review.acousticFacts,
  });
  if (recomputed.status !== 'scored' || recomputed.score !== review.got
    || recomputed.criteria.length !== review.criteria.length
    || recomputed.criteria.some((criterion, index) => (
      criterion.name !== review.criteria[index].name
      || criterion.score !== review.criteria[index].got
      || criterion.maxScore !== review.criteria[index].max
    ))) throw semanticInvalid();
  return review;
}
