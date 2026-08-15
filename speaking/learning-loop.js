import { parseSpeakingSemanticFacts, parseStoredSpeakingReview } from './fipi-scoring.js';
import { boundedAcousticMetric } from './acoustic-metrics.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { adaptiveSpeakingContentRef } from '../public/adaptive-speaking-tasks.js';

export const SPEAKING_LEARNING_EVIDENCE_VERSION = 'speaking-learning-evidence-v1';
export const SPEAKING_LEARNING_CONFIDENCE_THRESHOLD = 0.8;
export const SPEAKING_TARGET_MINING_LIMITS = Object.freeze({
  attempts: 120,
  pronunciationEvents: 480,
  candidates: 240,
  publicUnavailableTargets: 20,
});
export const SPEAKING_ADAPTIVE_EVIDENCE_ATTEMPT_LIMIT = 120;
export const SPEAKING_PRONUNCIATION_POINTER_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SPEAKING_PRONUNCIATION_EXPECTED_MINIMUM = 80;

const TASK_MAXIMA = Object.freeze({ 1: 1, 2: 4, 3: 5, 4: 10 });
const ADAPTIVE_ACTIVITY = Object.freeze({
  1: 'speaking_1', 2: 'speaking_2', 3: 'speaking_3', 4: 'speaking_4',
});
const CATALOGS = Object.freeze({
  1: SPEAKING_TASK1_CATALOG, 2: SPEAKING_TASK2_CATALOG,
  3: SPEAKING_TASK3_CATALOG, 4: SPEAKING_TASK4_CATALOG,
});
const CRITERION_SKILLS = Object.freeze({
  1: Object.freeze([Object.freeze(['ege.speaking.reading_aloud'])]),
  2: Object.freeze(Array.from({ length: 4 }, () => Object.freeze(['ege.speaking.direct_questions']))),
  3: Object.freeze(Array.from({ length: 5 }, () => Object.freeze(['ege.speaking.interview_completeness']))),
  4: Object.freeze([
    Object.freeze(['ege.speaking.monologue_content']),
    Object.freeze(['ege.speaking.monologue_organization']),
    Object.freeze(['ege.speaking.spoken_grammar', 'ege.speaking.spoken_lexis']),
  ]),
});

export function assertSpeakingTargetedPractice(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SPEAKING_TARGETED_PRACTICE_INVALID');
  }
  const sourceAttemptId = Number(value.sourceAttemptId);
  const reportRevision = bounded(value.reportRevision, 80);
  const accentLocale = ['en-GB', 'en-US'].includes(value.accentLocale) ? value.accentLocale : null;
  const skillId = bounded(value.skillId, 120);
  const label = bounded(value.label, 160);
  const contentRef = bounded(value.contentRef, 320);
  const focusValue = value.focus;
  let focus = null;
  if (focusValue != null) {
    const kind = focusValue?.kind;
    const targetValue = bounded(focusValue?.value, kind === 'phoneme' ? 20 : 120);
    const anchorWord = bounded(focusValue?.anchorWord, 120).toLocaleLowerCase('en');
    const ref = bounded(focusValue?.ref, 120);
    if (!['word', 'phoneme'].includes(kind) || !targetValue || !anchorWord
      || !/^(?:word|phoneme)\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(ref)) {
      throw new Error('SPEAKING_TARGETED_PRACTICE_INVALID');
    }
    focus = { kind, value: targetValue, anchorWord, ref };
  }
  if (!Number.isSafeInteger(sourceAttemptId) || sourceAttemptId < 1
    || (reportRevision && !/^attempt\.[0-9]+\.[0-9]+$/u.test(reportRevision))
    || !/^[a-z0-9._-]{3,120}$/u.test(skillId) || !label
    || !/^server:speaking:task:[1-4](?::skill:[a-z0-9._-]{3,120})?(?::focus:[a-z0-9._-]{3,120})?:new:v1$/u.test(contentRef)) {
    throw new Error('SPEAKING_TARGETED_PRACTICE_INVALID');
  }
  return { sourceAttemptId, reportRevision: reportRevision || null, accentLocale, skillId, label, contentRef, focus };
}

export function assertSpeakingLearningSource(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const sessionId = String(value.sessionId || '');
  const taskRef = String(value.taskRef || '');
  const taskRevision = Number(value.taskRevision);
  const catalogId = String(value.catalogId || '');
  const catalogRevision = Number(value.catalogRevision);
  const accentLocale = value.accentLocale == null ? null : String(value.accentLocale);
  const sessionMode = value.sessionMode == null ? 'individual' : String(value.sessionMode);
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)
    || !/^[a-zA-Z0-9._-]{1,140}$/u.test(taskRef)
    || !Number.isInteger(taskRevision) || taskRevision < 1
    || !/^[a-zA-Z0-9._-]{1,80}$/u.test(catalogId)
    || !Number.isInteger(catalogRevision) || catalogRevision < 1
    || !['individual', 'full_section'].includes(sessionMode)
    || typeof value.assistanceUsed !== 'boolean'
    || (accentLocale != null && !['en-GB', 'en-US'].includes(accentLocale))) {
    throw new Error('SPEAKING_LEARNING_SOURCE_INVALID');
  }
  const targetedPractice = value.targetedPractice == null
    ? null : assertSpeakingTargetedPractice(value.targetedPractice);
  return {
    sessionMode, sessionId, taskRef, taskRevision, catalogId, catalogRevision,
    accentLocale, assistanceUsed: value.assistanceUsed, targetedPractice,
  };
}

export function canonicalSpeakingLearningSource(source, { taskType, session }) {
  if (!source) return null;
  if (!session) throw new Error('SPEAKING_LEARNING_SESSION_NOT_FOUND');
  const normalizedTaskType = Number(taskType);
  if (!Number.isInteger(normalizedTaskType) || normalizedTaskType < 1 || normalizedTaskType > 4) {
    throw new Error('SPEAKING_LEARNING_SOURCE_INVALID');
  }
  const fullSection = source.sessionMode === 'full_section';
  const assignment = fullSection ? session.assignments?.find((item) => (
    Number(item.task_type) === normalizedTaskType
  )) : session;
  if (assignment?.task_id !== source.taskRef
    || Number(assignment?.task_revision) !== Number(source.taskRevision)
    || assignment?.catalog_id !== source.catalogId
    || Number(assignment?.catalog_revision) !== Number(source.catalogRevision)) {
    throw new Error('SPEAKING_LEARNING_SOURCE_MISMATCH');
  }
  if (session.status !== (fullSection ? 'submitted' : 'completed')) {
    throw new Error('SPEAKING_LEARNING_SESSION_INCOMPLETE');
  }
  if (session.accent_locale && source.accentLocale
    && session.accent_locale !== source.accentLocale) {
    throw new Error('SPEAKING_LEARNING_SOURCE_MISMATCH');
  }
  return {
    ...source,
    accentLocale: session.accent_locale || source.accentLocale || null,
    assistanceUsed: fullSection
      ? session.selection_reason === 'ege_mock'
      : Boolean(session.assistance_used),
    targetedPractice: fullSection ? null : session.targeted_practice || null,
  };
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function latestIso(...values) {
  return values.map(iso).filter(Boolean).sort().at(-1) || null;
}

function bounded(value, maximum) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function materialFor(attempt, taskType) {
  const catalog = CATALOGS[taskType];
  const task = catalog?.id === attempt?.source_catalog_id
    && Number(catalog.revision) === Number(attempt?.source_catalog_revision)
    ? catalog.tasks.find((candidate) => candidate.id === attempt?.source_task_ref
      && Number(candidate.revision) === Number(attempt?.source_task_revision)) : null;
  return task ? {
    catalogId: catalog.id, catalogRevision: Number(catalog.revision),
    taskRef: task.id, taskRevision: Number(task.revision),
    cefr: bounded(task.cefr, 12), topic: bounded(task.topic, 160),
  } : null;
}

function publicPhonemes(event) {
  return (Array.isArray(event?.phonemes) ? event.phonemes : [])
    .slice(0, 20)
    .flatMap((phoneme) => {
      const label = bounded(phoneme?.label, 20);
      return label ? [{
        label,
        accuracyScore: boundedAcousticMetric(phoneme?.accuracyScore),
      }] : [];
    });
}

function publicWordIssues(acousticFacts) {
  return (Array.isArray(acousticFacts?.wordEvents) ? acousticFacts.wordEvents : [])
    .filter((event) => ['mispronunciation', 'omission', 'insertion'].includes(event?.type))
    .slice(0, 120)
    .flatMap((event) => {
      const word = bounded(event?.word, 120);
      if (!word) return [];
      const offsetSeconds = Number(event?.offsetSeconds);
      const durationSeconds = Number(event?.durationSeconds);
      const hasTiming = event?.offsetSeconds != null && event?.durationSeconds != null
        && Number.isFinite(offsetSeconds) && offsetSeconds >= 0
        && Number.isFinite(durationSeconds) && durationSeconds > 0
        && offsetSeconds + durationSeconds <= 180.001;
      return [{
        id: bounded(event?.id, 160),
        word,
        errorType: event.type,
        itemIndex: Number.isInteger(event.itemIndex) ? event.itemIndex : null,
        accuracyScore: boundedAcousticMetric(event?.accuracyScore),
        gross: typeof event.gross === 'boolean' ? event.gross : null,
        ...(hasTiming ? { offsetSeconds, durationSeconds } : {}),
        phonemes: publicPhonemes(event),
      }];
    });
}

function publicPauseAnalysis(acousticFacts) {
  const available = acousticFacts?.accentLocale === 'en-US'
    && acousticFacts?.pauseAnalysisAvailable === true;
  const events = (available && Array.isArray(acousticFacts?.wordEvents) ? acousticFacts.wordEvents : [])
    .filter((event) => ['unexpected_break', 'missing_break'].includes(event?.type))
    .slice(0, 120)
    .map((event) => {
      const offsetSeconds = typeof event?.offsetSeconds === 'number'
        && Number.isFinite(event.offsetSeconds) && event.offsetSeconds >= 0
        ? event.offsetSeconds : null;
      const durationSeconds = typeof event?.durationSeconds === 'number'
        && Number.isFinite(event.durationSeconds) && event.durationSeconds > 0
        && offsetSeconds !== null && offsetSeconds + event.durationSeconds <= 180.001
        ? event.durationSeconds : null;
      return {
        id: bounded(event?.id, 160),
        type: event.type,
        itemIndex: Number.isInteger(event.itemIndex) ? event.itemIndex : null,
        word: bounded(event?.word, 120) || null,
        ...(offsetSeconds !== null && durationSeconds !== null
          ? { offsetSeconds, durationSeconds } : {}),
      };
    });
  return {
    available,
    reason: available ? null : (acousticFacts?.accentLocale === 'en-GB'
      ? 'locale_not_supported' : 'provider_pause_metric_unavailable'),
    fluencyProxyAvailable: boundedAcousticMetric(acousticFacts?.fluencyScore) !== null,
    totalCount: events.length,
    unexpectedBreakCount: events.filter((event) => event.type === 'unexpected_break').length,
    missingBreakCount: events.filter((event) => event.type === 'missing_break').length,
    events,
  };
}

function targetedPracticeForAttempt(attempt) {
  try {
    return attempt?.targeted_practice == null
      ? null : assertSpeakingTargetedPractice(attempt.targeted_practice);
  } catch {
    return null;
  }
}

function targetOutcomeForEvidence(evidence, targetedPractice, targetMeasurement = null) {
  if (!targetedPractice) return null;
  const common = {
    sourceAttemptId: targetedPractice.sourceAttemptId,
    evaluatedAttemptId: evidence.attemptId,
    reportRevision: targetedPractice.reportRevision,
    accentLocale: targetedPractice.accentLocale || evidence.accentLocale,
    skillId: targetedPractice.skillId,
    focus: targetedPractice.focus,
  };
  if (targetedPractice.accentLocale && targetedPractice.accentLocale !== evidence.accentLocale) {
    return { ...common, status: 'inconclusive', score: null, maxScore: 100 };
  }
  if (!evidence.masteryEligible) return { ...common, status: 'inconclusive', score: null, maxScore: 100 };
  if (targetedPractice.focus) {
    const focus = targetedPractice.focus;
    const exactMeasurement = targetMeasurement
      && targetMeasurement.focusRef === focus.ref
      && targetMeasurement.kind === focus.kind
      && targetMeasurement.value === focus.value
      && targetMeasurement.anchorWord === focus.anchorWord
      ? targetMeasurement : null;
    const score = exactMeasurement?.score;
    if (exactMeasurement?.anchorObserved !== true || typeof score !== 'number'
      || !Number.isFinite(score)) {
      return { ...common, status: 'inconclusive', score: null, maxScore: 100 };
    }
    return {
      ...common,
      status: score >= 80 ? 'resolved' : 'still_needs_work',
      score: Math.round(Math.max(0, Math.min(100, score))),
      maxScore: 100,
    };
  }
  const matching = skillObservations(evidence).filter((item) => item.skillId === targetedPractice.skillId);
  if (!matching.length) return { ...common, status: 'inconclusive', score: null, maxScore: 100 };
  const ratio = matching.reduce((sum, item) => sum + item.score, 0)
    / matching.reduce((sum, item) => sum + item.maxScore, 0);
  return {
    ...common,
    status: ratio >= 0.8 ? 'resolved' : 'still_needs_work',
    score: Math.round(ratio * 100),
    maxScore: 100,
  };
}

function safeTechnicalEvidence(attempt, taskType) {
  const review = attempt?.review && typeof attempt.review === 'object' ? attempt.review : {};
  const targetedPractice = targetedPracticeForAttempt(attempt);
  const evidence = {
    version: SPEAKING_LEARNING_EVIDENCE_VERSION,
    attemptId: Number(attempt?.id),
    taskType,
    taskRef: bounded(attempt?.source_task_ref, 160) || null,
    sessionId: bounded(attempt?.source_session_id, 80) || null,
    taskRevision: Number.isInteger(Number(attempt?.source_task_revision))
      ? Number(attempt.source_task_revision) : null,
    accentLocale: ['en-GB', 'en-US'].includes(attempt?.accent_locale)
      ? attempt.accent_locale
      : (['en-GB', 'en-US'].includes(review?.acousticFacts?.accentLocale)
        ? review.acousticFacts.accentLocale : null),
    material: materialFor(attempt, taskType),
    targetedPractice,
    status: 'needs_retry',
    score: null,
    maxScore: TASK_MAXIMA[taskType],
    transcript: bounded(attempt?.transcript, 8_000),
    verdict: bounded(review.verdict, 1_000) || 'Нужна новая запись: текущих данных недостаточно для надёжной оценки.',
    criteria: [],
    languageDiagnostics: [],
    wordIssues: [],
    signal: {
      quality: 'poor', semanticConfidence: null, acousticConfidence: null, highConfidence: false,
      recordingDurationSeconds: 0, itemDurations: [],
      completenessScore: null, fluencyScore: null,
      wordAccuracyScore: null, phonemeAccuracyScore: null,
      pauseAnalysis: {
        available: false, reason: 'provider_pause_metric_unavailable',
        fluencyProxyAvailable: false, totalCount: 0,
        unexpectedBreakCount: 0, missingBreakCount: 0, events: [],
      },
    },
    provenance: {
      officialSession: Boolean(attempt?.source_session_id && attempt?.source_task_ref),
      assistance: attempt?.assistance_used === false ? 'unassisted' : 'assisted',
    },
    masteryEligible: false,
    observedAt: iso(attempt?.evaluated_at ?? attempt?.created_at),
    evidenceChangedAt: latestIso(
      attempt?.evaluated_at ?? attempt?.created_at,
      attempt?.assistance_updated_at,
    ),
  };
  evidence.targetOutcome = targetOutcomeForEvidence(evidence, targetedPractice);
  return evidence;
}

function task4LanguageDiagnostics(review, storedSemanticFacts, masteryEligible) {
  if (!storedSemanticFacts || !review?.criteria?.[2]) return [];
  let semanticFacts;
  try {
    semanticFacts = parseSpeakingSemanticFacts(4, storedSemanticFacts);
  } catch {
    return [];
  }
  const official = review.criteria[2];
  const languageErrorIds = new Set(semanticFacts.lexicalGrammarErrors.map((event) => event.id));
  const languageIssues = (semanticFacts.issues || []).filter((issue) => issue.owner === 'language');
  const classificationComplete = languageIssues.every((issue) => languageErrorIds.has(issue.id))
    && semanticFacts.lexicalGrammarErrors.every((event) => languageIssues.some((issue) => issue.id === event.id));
  if (!classificationComplete) return [];
  const diagnosed = new Set(languageIssues.flatMap((issue) => {
    if (issue.owner !== 'language') return [];
    if (issue.code === 'language_grammar') return ['ege.speaking.spoken_grammar'];
    if (['language_vocabulary', 'language_register'].includes(issue.code)) {
      return ['ege.speaking.spoken_lexis'];
    }
    return [];
  }));
  if (Number(official.got) === Number(official.max)
    && semanticFacts.lexicalGrammarErrors.length === 0 && languageIssues.length === 0) {
    diagnosed.add('ege.speaking.spoken_grammar');
    diagnosed.add('ege.speaking.spoken_lexis');
  }
  const score = Math.round(Number(official.got) / Number(official.max) * 100);
  return [...diagnosed].sort().map((skillId) => ({
    skillId,
    name: skillId.endsWith('spoken_grammar') ? 'Грамматика устной речи' : 'Лексика устной речи',
    score,
    maxScore: 100,
    basis: languageIssues.length
      ? 'official_language_score_with_validated_error_kind'
      : 'full_official_language_criterion_without_validated_errors',
    masteryEligible,
  }));
}

export function buildSpeakingLearningAttempt(attempt) {
  const taskType = Number(attempt?.task_type);
  if (!Number.isInteger(taskType) || !TASK_MAXIMA[taskType] || !Number.isSafeInteger(Number(attempt?.id))) {
    return null;
  }
  if (attempt.status !== 'completed' || attempt.review?.status !== 'scored') {
    return safeTechnicalEvidence(attempt, taskType);
  }
  let review;
  try {
    review = parseStoredSpeakingReview(taskType, attempt.review);
  } catch {
    return safeTechnicalEvidence(attempt, taskType);
  }
  const acoustic = attempt.review.acousticFacts;
  const semanticConfidence = boundedAcousticMetric(review.confidence, { maximum: 1 });
  const acousticConfidence = boundedAcousticMetric(acoustic?.recognitionConfidence, { maximum: 1 });
  const quality = ['good', 'acceptable', 'poor'].includes(acoustic?.signalQuality)
    ? acoustic.signalQuality : 'poor';
  const highConfidence = Number.isFinite(semanticConfidence)
    && Number.isFinite(acousticConfidence)
    && semanticConfidence >= SPEAKING_LEARNING_CONFIDENCE_THRESHOLD
    && acousticConfidence >= SPEAKING_LEARNING_CONFIDENCE_THRESHOLD
    && quality !== 'poor';
  const officialSession = Boolean(attempt.source_session_id && attempt.source_task_ref
    && Number.isInteger(Number(attempt.source_task_revision)));
  const assistance = attempt.assistance_used === false ? 'unassisted' : 'assisted';
  const masteryEligible = officialSession && assistance === 'unassisted' && highConfidence;
  const targetedPractice = targetedPracticeForAttempt(attempt);
  const evidence = {
    version: SPEAKING_LEARNING_EVIDENCE_VERSION,
    attemptId: Number(attempt.id),
    taskType,
    taskRef: bounded(attempt.source_task_ref, 160),
    sessionId: bounded(attempt.source_session_id, 80),
    taskRevision: Number(attempt.source_task_revision),
    accentLocale: ['en-GB', 'en-US'].includes(attempt.accent_locale)
      ? attempt.accent_locale
      : (['en-GB', 'en-US'].includes(acoustic?.accentLocale) ? acoustic.accentLocale : null),
    status: 'scored',
    score: Number(review.got),
    maxScore: Number(review.max),
    transcript: bounded(attempt.transcript, 8_000),
    verdict: bounded(review.verdict, 1_000),
    criteria: review.criteria.map((criterion, index) => ({
      id: `task${taskType}.criterion.${index + 1}`,
      skillIds: [...CRITERION_SKILLS[taskType][index]],
      name: bounded(criterion.name, 160),
      score: Number(criterion.got),
      maxScore: Number(criterion.max),
      masteryEligible,
    })),
    strengths: review.good.map((item) => bounded(item, 600)),
    improvements: review.fix.map((item) => ({
      wrong: bounded(item.wrong, 300), right: bounded(item.right, 300), note: bounded(item.note, 600),
    })),
    languageDiagnostics: taskType === 4
      ? task4LanguageDiagnostics(review, attempt.review.semanticFacts, masteryEligible) : [],
    wordIssues: publicWordIssues(acoustic),
    signal: {
      quality,
      semanticConfidence,
      acousticConfidence,
      highConfidence,
      recordingDurationSeconds: Number(acoustic.recordingDurationSeconds),
      completenessScore: boundedAcousticMetric(acoustic.completenessScore),
      fluencyScore: boundedAcousticMetric(acoustic.fluencyScore),
      wordAccuracyScore: boundedAcousticMetric(acoustic.wordAccuracyScore),
      phonemeAccuracyScore: boundedAcousticMetric(acoustic.phonemeAccuracyScore),
      itemDurations: acoustic.itemDurations.map((item) => ({
        itemIndex: item.itemIndex, durationSeconds: item.durationSeconds,
      })),
      pauseAnalysis: publicPauseAnalysis(acoustic),
    },
    material: materialFor(attempt, taskType),
    targetedPractice,
    provenance: { officialSession, assistance },
    masteryEligible,
    observedAt: iso(attempt.evaluated_at ?? attempt.created_at),
    evidenceChangedAt: latestIso(
      attempt.evaluated_at ?? attempt.created_at,
      attempt.assistance_updated_at,
    ),
  };
  evidence.targetOutcome = targetOutcomeForEvidence(
    evidence, targetedPractice, acoustic?.targetMeasurement || null,
  );
  return evidence;
}

export function speakingAdaptiveEvidenceAttempts(evidenceAttempts) {
  return (Array.isArray(evidenceAttempts) ? evidenceAttempts : [])
    .filter((attempt) => attempt?.status === 'scored'
      && attempt.provenance?.officialSession
      && attempt.signal?.highConfidence
      && ADAPTIVE_ACTIVITY[attempt.taskType])
    .sort((first, second) => {
      const firstTimestamp = new Date(first.evidenceChangedAt || first.observedAt).getTime();
      const secondTimestamp = new Date(second.evidenceChangedAt || second.observedAt).getTime();
      const firstObservedAt = Number.isFinite(firstTimestamp) ? firstTimestamp : Number.NEGATIVE_INFINITY;
      const secondObservedAt = Number.isFinite(secondTimestamp) ? secondTimestamp : Number.NEGATIVE_INFINITY;
      if (firstObservedAt !== secondObservedAt) return secondObservedAt - firstObservedAt;
      const firstId = Number(first.attemptId);
      const secondId = Number(second.attemptId);
      if (Number.isSafeInteger(firstId) && Number.isSafeInteger(secondId)) return secondId - firstId;
      return String(second.attemptId).localeCompare(String(first.attemptId), 'en');
    })
    .slice(0, SPEAKING_ADAPTIVE_EVIDENCE_ATTEMPT_LIMIT)
    .flatMap((attempt) => {
      const sourceAttemptId = `speaking:${attempt.attemptId}`;
      const observations = new Map();
      const add = (skillId, score, maximum, observationType) => {
        if (!skillId || typeof score !== 'number' || !Number.isFinite(score)
          || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum <= 0) return;
        const current = observations.get(skillId) || { score: 0, maximum: 0, observationType };
        current.score += score;
        current.maximum += maximum;
        observations.set(skillId, current);
      };
      for (const criterion of attempt.criteria) {
        if (criterion.skillIds?.length === 1) {
          add(criterion.skillIds[0], criterion.score, criterion.maxScore, 'criterion');
        }
      }
      for (const diagnostic of attempt.languageDiagnostics || []) {
        add(diagnostic.skillId, diagnostic.score, diagnostic.maxScore, 'validated_language_diagnostic');
      }
      if (attempt.signal.wordAccuracyScore != null
        && Number.isFinite(Number(attempt.signal.wordAccuracyScore))) {
        add('ege.speaking.pronunciation_words', attempt.signal.wordAccuracyScore, 100, 'word_accuracy');
      }
      if (attempt.signal.phonemeAccuracyScore != null
        && Number.isFinite(Number(attempt.signal.phonemeAccuracyScore))) {
        add('ege.speaking.pronunciation_phonemes', attempt.signal.phonemeAccuracyScore, 100, 'phoneme_accuracy');
      }
      if (attempt.signal.fluencyScore != null && Number.isFinite(Number(attempt.signal.fluencyScore))) {
        add('ege.speaking.fluency', Number(attempt.signal.fluencyScore), 100, 'fluency');
      }
      add('ege.speaking.signal_quality', attempt.signal.quality === 'good' ? 100 : 70, 100, 'signal');
      return [...observations.entries()].map(([skillId, observation]) => ({
        id: `${sourceAttemptId}:${skillId}`,
        module: 'speaking',
        activity: ADAPTIVE_ACTIVITY[attempt.taskType],
        score: observation.score,
        max_score: observation.maximum,
        duration_ms: null,
        metadata: {
          evidence_version: SPEAKING_LEARNING_EVIDENCE_VERSION,
          skill_id: skillId,
          observation_type: observation.observationType,
          source_attempt_id: sourceAttemptId,
          task_ref: attempt.taskRef,
          task_revision: attempt.taskRevision,
          accent_locale: attempt.accentLocale,
          signal_quality: attempt.signal.quality,
        },
        evidence_quality: attempt.provenance.assistance === 'unassisted'
          ? 'server_verified_unassisted' : 'server_verified_assisted',
        created_at: attempt.evidenceChangedAt || attempt.observedAt,
      }));
    });
}

export function speakingAdaptiveEvidenceMatchesTarget(evidence, { skillId, focusRef = null } = {}) {
  const normalizedSkillId = bounded(skillId, 120);
  const normalizedFocusRef = bounded(focusRef, 120);
  if (!normalizedSkillId || evidence?.masteryEligible !== true) return false;
  const exactSkillObserved = speakingAdaptiveEvidenceAttempts([evidence]).some((attempt) => (
    attempt.metadata?.skill_id === normalizedSkillId
  ));
  if (!exactSkillObserved) return false;
  if (!normalizedFocusRef) return true;
  const expectedKind = normalizedSkillId === 'ege.speaking.pronunciation_words' ? 'word'
    : normalizedSkillId === 'ege.speaking.pronunciation_phonemes' ? 'phoneme' : null;
  const outcome = evidence.targetOutcome;
  return Boolean(expectedKind
    && outcome?.skillId === normalizedSkillId
    && outcome.focus?.kind === expectedKind
    && outcome.focus?.ref === normalizedFocusRef
    && ['resolved', 'still_needs_work'].includes(outcome.status));
}

function skillObservations(attempt) {
  return [
    ...(attempt.criteria || []).flatMap((criterion) => (
      criterion.skillIds?.length === 1 ? [{
        skillId: criterion.skillIds[0], name: criterion.name,
        score: criterion.score, maxScore: criterion.maxScore,
      }] : []
    )),
    ...(attempt.languageDiagnostics || []).map((diagnostic) => ({
      skillId: diagnostic.skillId, name: diagnostic.name,
      score: diagnostic.score, maxScore: diagnostic.maxScore,
    })),
  ];
}

function speakableMaterialText(taskType, task) {
  if (!task || typeof task !== 'object') return [];
  if (taskType === 1) return [task.text];
  if (taskType === 2) return [task.advertisement, ...(task.supports || [])];
  if (taskType === 3) return [...(task.questions || [])];
  if (taskType === 4) return [
    task.projectTitle,
    task.photoPair?.alt,
    ...(task.photoPair?.panels || []).map((panel) => panel?.alt),
    ...(task.plan || []),
  ];
  return [];
}

function normalizedWords(value) {
  return new Set(String(value || '').normalize('NFKC').toLocaleLowerCase('en')
    .match(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu) || []);
}

const SPEAKABLE_MATERIAL_INDEX = Object.freeze(Object.entries(CATALOGS).flatMap(([taskType, catalog]) => (
  catalog.tasks.map((task) => Object.freeze({
    taskType: Number(taskType),
    taskRef: task.id,
    cefr: task.cefr,
    words: normalizedWords(speakableMaterialText(Number(taskType), task).join(' ')),
  }))
)));

function suitableMaterialFor(focus, sourceTaskType, sourceTaskRef, cefr) {
  const anchor = bounded(focus?.anchorWord || focus?.value, 120).toLocaleLowerCase('en');
  if (!anchor) return null;
  const taskTypes = [sourceTaskType, ...[1, 2, 3, 4].filter((item) => item !== sourceTaskType)];
  for (const requireSameCefr of [true, false]) {
    for (const taskType of taskTypes) {
      const taskRefs = SPEAKABLE_MATERIAL_INDEX.filter((task) => (
        task.taskType === taskType
        && task.taskRef !== sourceTaskRef
        && (!requireSameCefr || !cefr || task.cefr === cefr)
        && task.words.has(anchor)
      )).map((task) => task.taskRef).slice(0, 20);
      if (taskRefs.length) return { taskType, taskRefs };
    }
  }
  return null;
}

function pronunciationTargetIdentity(skillId, focus, accentLocale) {
  const kind = bounded(focus?.kind, 20);
  const value = bounded(focus?.value, kind === 'phoneme' ? 20 : 120).toLocaleLowerCase('en');
  const locale = ['en-GB', 'en-US'].includes(accentLocale) ? accentLocale : 'unknown';
  return skillId && ['word', 'phoneme'].includes(kind) && value
    ? `${locale}:${skillId}:${kind}:${value}` : '';
}

function chronologicalAttempts(attempts) {
  return [...attempts].filter(Boolean).sort((left, right) => (
    String(left.observedAt || '').localeCompare(String(right.observedAt || ''))
      || left.attemptId - right.attemptId
  ));
}

function pronunciationTargets(attempts) {
  const chronological = chronologicalAttempts(attempts.filter((item) => item?.status === 'scored'));
  const attemptOrder = new Map(chronological.map((attempt, index) => [attempt.attemptId, index]));
  const groups = new Map();
  const resolvedAt = new Map();
  const add = ({ attempt, skillId, kind, value, anchorWord, score, ref, order }) => {
    const normalizedValue = bounded(value, kind === 'phoneme' ? 20 : 120);
    const normalizedAnchor = bounded(anchorWord, 120).toLocaleLowerCase('en');
    const key = pronunciationTargetIdentity(skillId, { kind, value: normalizedValue }, attempt.accentLocale);
    if (!key || !normalizedAnchor) return;
    const current = groups.get(key) || {
      skillId, kind, value: normalizedValue, anchorWord: normalizedAnchor,
      accentLocale: attempt.accentLocale,
      attempts: new Set(), latestOrder: -1, latestScores: [], source: null,
    };
    current.attempts.add(attempt.attemptId);
    const acousticScore = boundedAcousticMetric(score);
    if (acousticScore !== null) {
      if (order > current.latestOrder) {
        current.latestOrder = order;
        current.latestScores = [acousticScore];
      } else if (order === current.latestOrder) {
        current.latestScores.push(acousticScore);
      }
    }
    if (!current.source || order >= current.source.order) {
      current.anchorWord = normalizedAnchor;
      current.source = {
        attemptId: attempt.attemptId, taskType: attempt.taskType, taskRef: attempt.taskRef,
        material: attempt.material, observedAt: attempt.observedAt, ref, order,
      };
    }
    groups.set(key, current);
  };

  for (const attempt of chronological) {
    const outcome = attempt.targetOutcome;
    if (!outcome?.focus) continue;
    const order = attemptOrder.get(attempt.attemptId);
    const key = pronunciationTargetIdentity(outcome.skillId, outcome.focus, outcome.accentLocale);
    if (!key) continue;
    if (outcome.status === 'resolved') resolvedAt.set(key, Math.max(resolvedAt.get(key) ?? -1, order));
    if (outcome.status === 'still_needs_work') {
      add({
        attempt, skillId: outcome.skillId, kind: outcome.focus.kind,
        value: outcome.focus.value, anchorWord: outcome.focus.anchorWord,
        score: outcome.score, ref: outcome.focus.ref, order,
      });
    }
  }

  let remainingEvents = SPEAKING_TARGET_MINING_LIMITS.pronunciationEvents;
  const recent = [];
  for (const attempt of [...chronological].reverse()) {
    if (remainingEvents <= 0) break;
    for (const [wordIndex, issue] of (attempt.wordIssues || []).entries()) {
      if (remainingEvents <= 0) break;
      recent.push({
        attempt, skillId: 'ege.speaking.pronunciation_words', kind: 'word',
        value: issue.word, anchorWord: issue.word, score: issue.accuracyScore,
        ref: `word.${attempt.attemptId}.${wordIndex}`,
      });
      remainingEvents -= 1;
      for (const [phonemeIndex, phoneme] of (issue.phonemes || []).entries()) {
        if (remainingEvents <= 0) break;
        recent.push({
          attempt, skillId: 'ege.speaking.pronunciation_phonemes', kind: 'phoneme',
          value: phoneme.label, anchorWord: issue.word, score: phoneme.accuracyScore,
          ref: `phoneme.${attempt.attemptId}.${wordIndex}.${phonemeIndex}`,
        });
        remainingEvents -= 1;
      }
    }
  }
  for (const event of recent.reverse()) {
    add({ ...event, order: attemptOrder.get(event.attempt.attemptId) });
  }

  return [...groups.values()].flatMap((group) => {
    if (!group.source || !group.latestScores.length) return [];
    if ((resolvedAt.get(pronunciationTargetIdentity(
      group.skillId, group, group.accentLocale,
    )) ?? -1) >= group.latestOrder) return [];
    const score = group.latestScores.reduce((sum, value) => sum + value, 0) / group.latestScores.length;
    if (score >= 80) return [];
    return [{ ...group, score }];
  }).sort((left, right) => (
    left.score - right.score
      || right.attempts.size - left.attempts.size
      || left.skillId.localeCompare(right.skillId)
      || left.value.localeCompare(right.value)
  )).slice(0, SPEAKING_TARGET_MINING_LIMITS.candidates).map((group) => {
    const suitable = suitableMaterialFor(
      group, group.source.taskType, group.source.taskRef, group.source.material?.cefr,
    );
    return {
      skillId: group.skillId,
      name: bounded(group.kind === 'word'
        ? `Произношение слова «${group.value}»`
        : `Фонема /${group.value}/ в слове «${group.anchorWord}»`, 160),
      taskType: suitable?.taskType || group.source.taskType,
      score: group.score,
      maximum: 100,
      evidenceCount: group.attempts.size,
      sourceAttemptId: group.source.attemptId,
      sourceTaskRef: group.source.taskRef,
      material: group.source.material,
      observedAt: group.source.observedAt,
      accentLocale: group.accentLocale,
      focus: {
        kind: group.kind, value: group.value, anchorWord: group.anchorWord, ref: group.source.ref,
      },
      availability: suitable ? 'available' : 'unavailable',
      unavailableReason: suitable ? null : 'no_server_owned_focus_material',
      suitableTaskRefs: suitable?.taskRefs || [],
    };
  });
}

function learningTargets(attempts) {
  const groups = new Map();
  const resolvedCriterionTargets = new Set(attempts.flatMap((attempt) => (
    attempt?.targetOutcome?.status === 'resolved' && !attempt.targetOutcome.focus
      ? [`${attempt.targetOutcome.accentLocale || 'unknown'}:${attempt.targetOutcome.sourceAttemptId}:${attempt.targetOutcome.skillId}`]
      : []
  )));
  for (const attempt of attempts.filter((item) => item?.status === 'scored')) {
    const observedBySkill = new Map();
    for (const criterion of skillObservations(attempt)) {
      const observed = observedBySkill.get(criterion.skillId) || {
        skillId: criterion.skillId, name: criterion.name, score: 0, maximum: 0,
      };
      observed.score += criterion.score;
      observed.maximum += criterion.maxScore;
      observedBySkill.set(criterion.skillId, observed);
    }
    for (const observed of observedBySkill.values()) {
      const accentLocale = ['en-GB', 'en-US'].includes(attempt.accentLocale)
        ? attempt.accentLocale : null;
      const groupKey = `${accentLocale || 'unknown'}:${observed.skillId}`;
      const current = groups.get(groupKey) || {
        skillId: observed.skillId, name: observed.name, taskType: attempt.taskType,
        score: observed.score, maximum: observed.maximum, evidenceCount: 0,
        sourceAttemptId: null, sourceTaskRef: null, material: null,
        observedAt: null, focus: null, accentLocale,
      };
      current.evidenceCount += 1;
      const isLatest = !current.observedAt
        || String(attempt.observedAt || '') > String(current.observedAt)
        || (String(attempt.observedAt || '') === String(current.observedAt)
          && Number(attempt.attemptId) >= Number(current.sourceAttemptId));
      if (isLatest) {
        current.name = observed.name;
        current.taskType = attempt.taskType;
        current.score = observed.score;
        current.maximum = observed.maximum;
        current.sourceAttemptId = attempt.attemptId;
        current.sourceTaskRef = attempt.taskRef;
        current.material = attempt.material;
        current.observedAt = attempt.observedAt;
      }
      groups.set(groupKey, current);
    }
  }
  const criteria = [...groups.values()]
    .filter((target) => target.maximum > 0
      && target.score / target.maximum < 0.8
      && !resolvedCriterionTargets.has(`${target.accentLocale || 'unknown'}:${target.sourceAttemptId}:${target.skillId}`))
    .map((target) => ({
      ...target,
      availability: 'available',
      unavailableReason: null,
      suitableTaskRefs: CATALOGS[target.taskType].tasks
        .filter((task) => task.id !== target.sourceTaskRef).map((task) => task.id).slice(0, 20),
    }));
  return [...criteria, ...pronunciationTargets(attempts)]
    .filter((item) => item.maximum > 0)
    .sort((left, right) => (
      left.score / left.maximum - right.score / right.maximum
      || right.evidenceCount - left.evidenceCount
      || left.skillId.localeCompare(right.skillId)
    )).slice(0, SPEAKING_TARGET_MINING_LIMITS.candidates);
}

function timeAllocationRecommendation(targets) {
  const selected = targets.filter((target) => target.availability !== 'unavailable').map((target) => ({
    ...target, label: target.name, gap: Math.max(0, 1 - target.score / target.maximum),
  })).filter((target) => target.gap > 0).sort((left, right) => right.gap - left.gap
    || left.skillId.localeCompare(right.skillId)).slice(0, 4);
  const total = selected.reduce((sum, item) => sum + item.gap, 0);
  if (!total) return [];
  let assigned = 0;
  return selected.map((item, index) => {
    const percentage = index === selected.length - 1
      ? 100 - assigned : Math.round(item.gap / total * 100);
    assigned += percentage;
    return {
      skillId: item.skillId, label: item.label, focus: item.focus,
      accentLocale: item.accentLocale || null, percentage,
    };
  });
}

function currentAttempt(attempts) {
  return [...attempts]
    .filter(Boolean)
    .sort((left, right) => String(right.observedAt || '').localeCompare(String(left.observedAt || ''))
      || right.attemptId - left.attemptId)[0] || null;
}

export function speakingPronunciationErrorPointer(attempt, { now = new Date() } = {}) {
  if (!attempt?.masteryEligible || attempt.status !== 'scored') return null;
  const attemptId = Number(attempt.attemptId);
  const observedAt = new Date(attempt.observedAt);
  const referenceTime = now instanceof Date ? now : new Date(now);
  if (!Number.isSafeInteger(attemptId) || attemptId < 1
    || Number.isNaN(observedAt.getTime()) || Number.isNaN(referenceTime.getTime())) return null;
  const expiresAt = new Date(observedAt.getTime() + SPEAKING_PRONUNCIATION_POINTER_TTL_MS);
  if (referenceTime >= expiresAt) return null;

  const candidates = [];
  for (const [wordIndex, issue] of (attempt.wordIssues || []).entries()) {
    const word = bounded(issue?.word, 120).toLocaleLowerCase('en');
    if (!word) continue;
    const wordScore = boundedAcousticMetric(issue?.accuracyScore);
    if (wordScore !== null && wordScore < SPEAKING_PRONUNCIATION_EXPECTED_MINIMUM) {
      candidates.push({
        ref: `word.${attemptId}.${wordIndex}`, kind: 'word',
        label: bounded(`Произношение слова «${word}»`, 160),
        word, phoneme: null, accuracyScore: wordScore,
      });
    }
    for (const [phonemeIndex, phoneme] of (issue?.phonemes || []).entries()) {
      const phonemeLabel = bounded(phoneme?.label, 20);
      const phonemeScore = boundedAcousticMetric(phoneme?.accuracyScore);
      if (!phonemeLabel || phonemeScore === null
        || phonemeScore >= SPEAKING_PRONUNCIATION_EXPECTED_MINIMUM) continue;
      candidates.push({
        ref: `phoneme.${attemptId}.${wordIndex}.${phonemeIndex}`, kind: 'phoneme',
        label: bounded(`Фонема /${phonemeLabel}/ в слове «${word}»`, 160),
        word, phoneme: phonemeLabel, accuracyScore: phonemeScore,
      });
    }
  }
  const weakest = candidates.sort((left, right) => (
    left.accuracyScore - right.accuracyScore || left.ref.localeCompare(right.ref)
  ))[0];
  return weakest ? {
    ...weakest,
    expectedMinimum: SPEAKING_PRONUNCIATION_EXPECTED_MINIMUM,
    observedAt: observedAt.toISOString(),
    accentLocale: ['en-GB', 'en-US'].includes(attempt.accentLocale)
      ? attempt.accentLocale : null,
    expiresAt: expiresAt.toISOString(),
  } : null;
}

function groupIssueDynamics(attempts, selector) {
  const groups = new Map();
  for (const attempt of attempts) {
    const attemptGroups = new Map();
    for (const item of selector(attempt)) {
      const normalizedKey = bounded(item.key, 120).toLocaleLowerCase('en');
      const accentLocale = ['en-GB', 'en-US'].includes(item.accentLocale) ? item.accentLocale : null;
      if (!normalizedKey) continue;
      const key = `${accentLocale || 'unknown'}:${normalizedKey}`;
      const group = attemptGroups.get(key) || { label: item.label, accentLocale, scores: [] };
      const score = boundedAcousticMetric(item.score);
      if (score !== null) group.scores.push(score);
      attemptGroups.set(key, group);
    }
    for (const [key, item] of attemptGroups) {
      const group = groups.get(key) || {
        label: item.label, accentLocale: item.accentLocale, count: 0, scores: [], points: [],
      };
      group.count += 1;
      if (item.scores.length) {
        const score = Math.round(item.scores.reduce((sum, value) => sum + value, 0) / item.scores.length);
        group.scores.push(score);
        group.points.push({
          attemptId: attempt.attemptId,
          observedAt: attempt.observedAt,
          accuracyScore: score,
        });
      }
      groups.set(key, group);
    }
  }
  return [...groups.values()].map((group) => {
    const points = group.points.slice(-120);
    const previousAccuracy = points.length > 1 ? points.at(-2).accuracyScore : null;
    const currentAccuracy = points.length ? points.at(-1).accuracyScore : null;
    const delta = previousAccuracy == null || currentAccuracy == null
      ? null : currentAccuracy - previousAccuracy;
    return {
      label: group.label,
      accentLocale: group.accentLocale,
      count: group.count,
      averageAccuracy: group.scores.length
        ? Math.round(group.scores.reduce((sum, score) => sum + score, 0) / group.scores.length) : null,
      previousAccuracy,
      currentAccuracy,
      delta,
      direction: delta == null ? 'insufficient_data'
        : delta > 0 ? 'improved' : delta < 0 ? 'declined' : 'stable',
      points,
    };
  }).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)).slice(0, 30);
}

function pronunciationDynamicsItems(attempt, kind) {
  const items = kind === 'word'
    ? (attempt.wordIssues || []).map((issue) => ({
      key: issue.word, label: issue.word, score: issue.accuracyScore,
      accentLocale: attempt.accentLocale,
    }))
    : (attempt.wordIssues || []).flatMap((issue) => (
      (issue.phonemes || []).map((phoneme) => ({
        key: phoneme.label, label: phoneme.label, score: phoneme.accuracyScore,
        accentLocale: attempt.accentLocale,
      }))
    ));
  const byKey = new Map(items.map((item) => [
    bounded(item.key, 120).toLocaleLowerCase('en'), item,
  ]));
  const outcome = attempt.targetOutcome;
  if (outcome?.focus?.kind === kind
    && ['resolved', 'still_needs_work'].includes(outcome.status)
    && typeof outcome.score === 'number' && Number.isFinite(outcome.score)) {
    const label = outcome.focus.value;
    byKey.set(bounded(label, 120).toLocaleLowerCase('en'), {
      key: label, label, score: outcome.score, accentLocale: outcome.accentLocale,
    });
  }
  return [...byKey.values()];
}

function safeNextStepWithoutTarget(current) {
  if (!current || current.provenance?.officialSession !== true) return {
    skillId: null,
    label: 'Начните с официальной тренировки без подсказок.',
    taskType: 1,
    focus: null,
    reason: 'start_official_attempt',
  };
  if (current.status !== 'scored') return {
    skillId: null,
    label: 'Перезапишите ответ, чтобы получить надёжную автоматическую оценку.',
    taskType: current.taskType,
    focus: null,
    reason: 'retry_technical_assessment',
  };
  if (current.provenance?.assistance !== 'unassisted') return {
    skillId: null,
    label: 'Повторите это задание самостоятельно, без подсказок.',
    taskType: current.taskType,
    focus: null,
    reason: 'retry_without_assistance',
  };
  if (current.masteryEligible) return {
    skillId: null,
    label: 'Продолжите официальную тренировку, чтобы закрепить результат на другом материале.',
    taskType: current.taskType,
    focus: null,
    reason: 'continue_official_practice',
  };
  return {
    skillId: null,
    label: 'Сделайте новую запись в тихом месте и держите микрофон на стабильном расстоянии.',
    taskType: current.taskType,
    focus: null,
    reason: 'retry_for_signal_quality',
  };
}

function baseNextStep(current) {
  if (current?.status === 'scored' && current.masteryEligible
    && current.provenance?.officialSession === true
    && current.provenance?.assistance === 'unassisted') {
    const weakest = skillObservations(current).filter((item) => item.maxScore > 0)
      .sort((left, right) => left.score / left.maxScore - right.score / right.maxScore
        || left.skillId.localeCompare(right.skillId))[0];
    if (weakest && weakest.score / weakest.maxScore < 0.8) return {
      skillId: weakest.skillId,
      label: weakest.name,
      taskType: current.taskType,
      focus: null,
      reason: 'weakest_observed_criterion',
    };
  }
  return safeNextStepWithoutTarget(current);
}

function speakingReportRevision(attempts) {
  const latest = currentAttempt(attempts);
  if (!latest) return 'empty.0';
  const observed = new Date(latest.observedAt).getTime();
  return `attempt.${latest.attemptId}.${Number.isFinite(observed) ? observed : 0}`;
}

export function buildSpeakingLearningReport(evidenceAttempts, {
  quota, activeAccentLocale = null, now = new Date(),
} = {}) {
  const normalizedActiveAccentLocale = ['en-GB', 'en-US'].includes(activeAccentLocale)
    ? activeAccentLocale : null;
  const attempts = (Array.isArray(evidenceAttempts) ? evidenceAttempts : []).filter(Boolean)
    .slice(-SPEAKING_TARGET_MINING_LIMITS.attempts)
    .map((attempt) => {
      const { evidenceChangedAt: _internalEvidenceChangedAt, ...publicAttempt } = attempt;
      return publicAttempt;
    });
  const current = currentAttempt(attempts);
  const tier = quota?.tier === 'premium' ? 'premium' : 'base';
  const activeAccentAttempts = attempts.filter((attempt) => (
    !normalizedActiveAccentLocale || attempt.accentLocale === normalizedActiveAccentLocale
  ));
  const reliableAttempts = activeAccentAttempts.filter((attempt) => attempt.masteryEligible);
  const reportRevision = speakingReportRevision(attempts);
  const attemptTimeline = [...attempts].sort((left, right) => (
    String(left.observedAt || '').localeCompare(String(right.observedAt || ''))
      || left.attemptId - right.attemptId
  )).map((item) => ({
    attemptId: item.attemptId, taskType: item.taskType, status: item.status,
    score: item.score, maxScore: item.maxScore, masteryEligible: item.masteryEligible,
    observedAt: item.observedAt,
  }));
  const report = {
    version: 'speaking-learning-report-v1',
    reportRevision,
    activeAccentLocale: normalizedActiveAccentLocale,
    assessment: { mode: 'automatic_training', approximate: true, methodicallyValidated: false },
    access: {
      tier,
      limitSeconds: tier === 'premium' ? 14_400 : 3_600,
      usedSeconds: Math.max(0, Number(quota?.usedSeconds) || 0),
      remainingSeconds: Math.max(0, Number(quota?.remainingSeconds) || 0),
    },
    currentAttempt: current,
    attemptTimeline,
    nextStep: baseNextStep(current),
    premium: null,
  };
  if (tier !== 'premium') return report;
  const targets = learningTargets(reliableAttempts);
  const target = targets[0] || null;
  const availableTarget = targets.find((item) => item.availability !== 'unavailable') || null;
  const unavailableTargets = targets.filter((item) => item.availability === 'unavailable');
  report.nextStep = target ? {
    skillId: target.skillId, label: target.name, taskType: target.taskType,
    focus: target.focus,
    reason: target.availability === 'unavailable' ? 'focus_material_unavailable'
      : (target.focus ? 'weakest_pronunciation_target' : 'weakest_observed_criterion'),
  } : safeNextStepWithoutTarget(current);
  const chronological = [...reliableAttempts].sort((left, right) => (
    String(left.observedAt || '').localeCompare(String(right.observedAt || ''))
      || left.attemptId - right.attemptId
  ));
  const reliableCurrent = currentAttempt(reliableAttempts);
  const comparable = reliableCurrent
    ? chronological.filter((item) => item.taskType === reliableCurrent.taskType
      && item.accentLocale === reliableCurrent.accentLocale
      && item.material?.cefr && item.material.cefr === reliableCurrent.material?.cefr)
    : [];
  const previous = comparable.length > 1 ? comparable.at(-2) : null;
  const weakestIndex = reliableCurrent?.status === 'scored' && reliableCurrent.criteria.length
    ? reliableCurrent.criteria.map((criterion, index) => ({
      index, ratio: criterion.score / criterion.maxScore,
    })).sort((left, right) => left.ratio - right.ratio || left.index - right.index)[0].index : -1;
  const weakestCriterion = weakestIndex >= 0 ? reliableCurrent.criteria[weakestIndex] : null;
  const pronunciationError = weakestCriterion?.score < weakestCriterion?.maxScore
    ? null : speakingPronunciationErrorPointer(reliableCurrent, { now });
  report.premium = {
    trend: chronological.map((item) => ({
      attemptId: item.attemptId, taskType: item.taskType, score: item.score,
      maxScore: item.maxScore, observedAt: item.observedAt,
      accentLocale: item.accentLocale, basis: 'accent_locale',
    })),
    comparison: reliableCurrent ? {
      currentAttemptId: reliableCurrent.attemptId,
      previousAttemptId: previous?.attemptId || null,
      scoreDelta: previous ? Math.round((reliableCurrent.score / reliableCurrent.maxScore
        - previous.score / previous.maxScore) * 100) : null,
      accentLocale: reliableCurrent.accentLocale,
      basis: 'same_accent_locale_task_type_and_cefr',
    } : null,
    criterionDynamics: [...new Map(chronological.flatMap((item) => (
      skillObservations(item).map((criterion) => {
        const accentLocale = ['en-GB', 'en-US'].includes(item.accentLocale)
          ? item.accentLocale : null;
        return [`${accentLocale || 'unknown'}:${criterion.skillId}`, {
          skillId: criterion.skillId, accentLocale,
        }];
      })
    ))).values()]
      .map(({ skillId, accentLocale }) => ({
        skillId, accentLocale, basis: 'same_accent_locale',
        points: chronological.flatMap((item) => {
          if (item.accentLocale !== accentLocale) return [];
          const matching = skillObservations(item).filter((criterion) => criterion.skillId === skillId);
          if (!matching.length) return [];
          return [{
            attemptId: item.attemptId,
            score: matching.reduce((sum, criterion) => sum + criterion.score, 0),
            maxScore: matching.reduce((sum, criterion) => sum + criterion.maxScore, 0),
            observedAt: item.observedAt, accentLocale,
          }];
        }),
      })),
    wordDynamics: groupIssueDynamics(chronological, (item) => pronunciationDynamicsItems(item, 'word')),
    phonemeDynamics: groupIssueDynamics(chronological, (item) => pronunciationDynamicsItems(item, 'phoneme')),
    fluencyDynamics: chronological.map((item) => ({
      attemptId: item.attemptId, observedAt: item.observedAt,
      fluencyScore: item.signal.fluencyScore,
      completenessScore: item.signal.completenessScore,
      signalQuality: item.signal.quality,
      accentLocale: item.accentLocale, basis: 'accent_locale',
    })),
    pauseDynamics: chronological.map((item) => ({
      attemptId: item.attemptId, observedAt: item.observedAt,
      available: item.signal.pauseAnalysis?.available === true,
      reason: item.signal.pauseAnalysis?.reason || null,
      fluencyScore: item.signal.fluencyScore,
      totalCount: item.signal.pauseAnalysis?.totalCount || 0,
      unexpectedBreakCount: item.signal.pauseAnalysis?.unexpectedBreakCount || 0,
      missingBreakCount: item.signal.pauseAnalysis?.missingBreakCount || 0,
      accentLocale: item.accentLocale, basis: 'accent_locale',
    })),
    targetedPractice: availableTarget ? {
      skillId: availableTarget.skillId, label: availableTarget.name, taskType: availableTarget.taskType,
      materialPolicy: 'different_server_owned_material',
      sourceAttemptId: availableTarget.sourceAttemptId,
      reportRevision,
      accentLocale: availableTarget.accentLocale || null,
      excludeTaskRef: availableTarget.sourceTaskRef,
      cefr: availableTarget.material?.cefr || null,
      focus: availableTarget.focus,
      contentRef: adaptiveSpeakingContentRef(
        availableTarget.taskType, availableTarget.skillId, availableTarget.focus?.ref,
      ),
      suitableTaskRefs: availableTarget.suitableTaskRefs,
    } : null,
    unavailableTargets: unavailableTargets.slice(0, SPEAKING_TARGET_MINING_LIMITS.publicUnavailableTargets).map((item) => ({
      skillId: item.skillId, label: item.name, taskType: item.taskType,
      sourceAttemptId: item.sourceAttemptId, accentLocale: item.accentLocale || null,
      focus: item.focus, reason: item.unavailableReason,
    })),
    targetOutcomes: chronologicalAttempts(activeAccentAttempts)
      .flatMap((item) => item.targetOutcome ? [item.targetOutcome] : []).slice(-30),
    voiceTutor: reliableCurrent && ((weakestCriterion
      && weakestCriterion.score < weakestCriterion.maxScore) || pronunciationError)
      ? {
        source: 'speaking', attemptId: reliableCurrent.attemptId, revision: 1,
        ...(pronunciationError ? { pronunciationError } : { criterion: {
          index: weakestIndex,
          ref: bounded(weakestCriterion.id, 120),
          label: bounded(weakestCriterion.name, 160),
          score: weakestCriterion.score,
          maxScore: weakestCriterion.maxScore,
        } }),
        attemptSummary: {
          attemptId: reliableCurrent.attemptId,
          taskType: reliableCurrent.taskType,
          score: reliableCurrent.score,
          maxScore: reliableCurrent.maxScore,
          observedAt: reliableCurrent.observedAt,
          accentLocale: reliableCurrent.accentLocale,
        },
      }
      : null,
    timeAllocationRecommendation: timeAllocationRecommendation(targets),
    personalSummary: {
      reliableAttemptCount: reliableAttempts.length,
      currentReliableAttemptId: reliableCurrent?.attemptId || null,
      currentReliableAccentLocale: reliableCurrent?.accentLocale || null,
      priorityCount: timeAllocationRecommendation(targets).length,
      unavailableTargetCount: Math.min(240, unavailableTargets.length),
    },
  };
  return report;
}

export function speakingTargetedPracticeAssignment(evidenceAttempts, request, taskType, {
  tier, activeAccentLocale = null,
} = {}) {
  if (tier !== 'premium') {
    throw Object.assign(new Error('SPEAKING_TARGETED_PRACTICE_STALE'), {
      code: 'SPEAKING_TARGETED_PRACTICE_STALE',
    });
  }
  const normalizedActiveAccentLocale = ['en-GB', 'en-US'].includes(activeAccentLocale)
    ? activeAccentLocale : null;
  if (normalizedActiveAccentLocale && request?.accentLocale !== normalizedActiveAccentLocale) {
    throw Object.assign(new Error('SPEAKING_TARGETED_PRACTICE_STALE'), {
      code: 'SPEAKING_TARGETED_PRACTICE_STALE',
    });
  }
  const targeted = buildSpeakingLearningReport(evidenceAttempts, {
    quota: { tier, usedSeconds: 0, remainingSeconds: 0 },
    activeAccentLocale: normalizedActiveAccentLocale,
  }).premium?.targetedPractice;
  if (!targeted || Number(targeted.taskType) !== Number(taskType)
    || Number(targeted.sourceAttemptId) !== Number(request?.sourceAttemptId)
    || targeted.reportRevision !== request?.reportRevision
    || targeted.accentLocale !== (request?.accentLocale || null)
    || targeted.skillId !== request?.skillId
    || targeted.contentRef !== request?.contentRef
    || !targeted.excludeTaskRef || !targeted.suitableTaskRefs?.length) {
    throw Object.assign(new Error('SPEAKING_TARGETED_PRACTICE_STALE'), {
      code: 'SPEAKING_TARGETED_PRACTICE_STALE',
    });
  }
  return {
    excludeTaskIds: [targeted.excludeTaskRef],
    preferredTaskIds: targeted.suitableTaskRefs,
    selectionReason: 'targeted_focus',
    targetedPractice: {
      sourceAttemptId: targeted.sourceAttemptId,
      reportRevision: targeted.reportRevision,
      accentLocale: targeted.accentLocale,
      skillId: targeted.skillId,
      label: targeted.label,
      contentRef: targeted.contentRef,
      focus: targeted.focus,
    },
  };
}
