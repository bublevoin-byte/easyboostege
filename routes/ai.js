import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';

import { config } from '../config.js';
import {
  parseAndValidateWritingReview, prepareWritingPrompt, WRITING_PROMPT_VERSION, writingRequestSchema,
} from '../ai/writing.js';
import { buildContentPrompt, CONTENT_PROMPT_VERSION, contentRequestSchema, parseContentResponse } from '../ai/content.js';
import {
  buildSpeakingPrompt,
  buildSpeakingSamplePrompt,
  parseSpeakingSample,
  parseSpeakingSemanticReview,
  SPEAKING_PROMPT_VERSION,
  speakingRequestSchema,
  speakingSampleRequestSchema,
  speakingTrustedInputSchema,
} from '../ai/speaking.js';
import { assignmentFor, OPERATION_FOR_TASK_TYPE } from '../ai/task-bank.js';
import { estimateCostMicrousd, TtlCache } from '../ai/provider-control.js';
import { createProviderClient } from '../ai/provider-client.js';
import { providersFor } from '../ai/operations.js';
import { recordDependencyEvent } from '../observability/metrics.js';
import { decorateGeneratedVoiceTutorContent } from '../voice-tutor/generated-items.js';
import { reviewVoiceTutorCriterionChoices } from '../voice-tutor/capsule.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import {
  publicSpeakingAcousticRetry,
  publicSpeakingReview,
  scoreSpeakingTask,
  SPEAKING_SCORING_VERSION,
} from '../speaking/fipi-scoring.js';
import { boundedAcousticMetric, finiteAcousticAverage } from '../speaking/acoustic-metrics.js';
import {
  speakingEvaluationClaimRecoverable,
  speakingEvaluationProviderRepeatPossible,
} from '../speaking/evaluation-claim.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../shared/automatic-assessment-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEAKING_TIMING_TOLERANCE_SECONDS = 0.05;

const EXPERIMENTAL_ASSESSMENT = Object.freeze({
  ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
});
const EXPERIMENTAL_SPEAKING_ASSESSMENT = Object.freeze({
  ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
  methodicallyValidated: false,
});

const AUTOMATIC_TRAINING_ASSESSMENT = Object.freeze({
  mode: 'automatic_training',
  scoreKind: 'approximate',
  methodicallyValidated: false,
  warning: 'Автоматическая тренировочная оценка. Балл примерный и не является экспертным заключением или точным баллом ЕГЭ.',
});

function speakingEvaluationFingerprint(request) {
  const canonical = {
    contractVersion: 'speaking-evaluation-v1',
    promptVersion: SPEAKING_PROMPT_VERSION,
    scoringVersion: SPEAKING_SCORING_VERSION,
    taskType: request.taskType,
    sessionMode: request.sessionMode || 'individual',
    sessionId: request.sessionId,
    pronunciationAssessmentKey: request.pronunciationAssessmentKey || null,
    pronunciationAssessmentKeys: request.pronunciationAssessmentKeys || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function speakingAssessmentContract(review, egeMock = false) {
  return {
    ...(egeMock ? EXPERIMENTAL_SPEAKING_ASSESSMENT : AUTOMATIC_TRAINING_ASSESSMENT),
    scoringVersion: review.scoringVersion,
  };
}

function speakingReplayPayload(attempt, egeMock = false) {
  if (!attempt?.review || !['completed', 'needs_retry'].includes(attempt.status)) return null;
  const { semanticFacts: _semanticFacts, acousticFacts: _acousticFacts, ...review } = attempt.review;
  const payload = {
    review,
    provider: attempt.provider || null,
    promptVersion: attempt.prompt_version,
    attemptId: Number(attempt.id),
    assessment: speakingAssessmentContract(review, egeMock),
  };
  if (review.status === 'scored') {
    payload.voiceTutor = {
      source: 'speaking', attemptId: Number(attempt.id), revision: 1,
      criterionChoices: reviewVoiceTutorCriterionChoices(review),
    };
  }
  return payload;
}

const SPEAKING_RESOLUTION_MESSAGES = Object.freeze({
  SPEAKING_CATALOG_REVISION_MISMATCH: 'Версия задания больше не поддерживается. Начните новую тренировку.',
  SPEAKING_ASSESSMENT_CONTEXT_MISMATCH: 'Оценка произношения относится к другой тренировке. Запишите ответ заново.',
  SPEAKING_ASSESSMENT_NOT_READY: 'Оценка произношения ещё не готова или запись неполна. Запишите ответ заново.',
});

// A single line an operator can grep: which provider gave up, on what, and whether a spare was left.
function describeFallback(provider, code, error, index, total) {
  const reason = error?.message && error.message !== code ? `${code}: ${String(error.message).slice(0, 120)}` : code;
  return `${provider.name} → ${index + 1 < total ? 'switched to next provider' : 'no provider left'} (${reason})`;
}


// The web server takes the standard chain: both providers, fallback allowed. Pinning exists for
// the quality runner of section 11.2 and has no business in a student's request.
const defaultProviderClient = createProviderClient();

const speakingCatalogs = Object.freeze({
  1: { catalog: SPEAKING_TASK1_CATALOG, get: 'getSpeakingTask1Session' },
  2: { catalog: SPEAKING_TASK2_CATALOG, get: 'getSpeakingTask2Session' },
  3: { catalog: SPEAKING_TASK3_CATALOG, get: 'getSpeakingTask3Session' },
  4: { catalog: SPEAKING_TASK4_CATALOG, get: 'getSpeakingTask4Session' },
});

function evaluationAssignment(taskType, task) {
  if (taskType === 1) return { tx: task.text };
  if (taskType === 2) return { ad: task.advertisement, points: [...task.supports] };
  if (taskType === 3) return { topic: task.topic, qs: [...task.questions] };
  if (taskType === 4) return {
    topic: task.projectTitle,
    plan: [...task.plan],
    ph: task.photoPair.panels.map((panel) => panel.alt),
  };
  return null;
}

// Server-side AI operations. The client never sends a system prompt: each operation has its own contract.
export function createAiRoutes({
  authentication,
  access,
  db,
  providerClient = defaultProviderClient,
}) {
  const router = express.Router();
  const { auth } = authentication;
  const {
    privacyPolicyVersion, createOperationLimiter, requireAiBudget,
    requireActiveSubscription, requirePrivacyConsent, hasAiBudget,
  } = access;
  const perOperation = (resolve) => createOperationLimiter(resolve, (operation) => limitsFor(operation).requestsPerHour);
  // Each endpoint is rationed by the operation actually requested, not by a shared category quota.
  const writingLimiter = perOperation((req) => (typeof req.body?.taskType === 'string' ? req.body.taskType : 'writing_37'));
  const contentLimiter = perOperation((req) => (typeof req.body?.operation === 'string' ? req.body.operation : 'grammar_quiz'));
  const speakingEvalLimiter = perOperation(() => 'evaluate_speaking');
  const speakingSampleLimiter = perOperation(() => 'speaking_sample');
  const {
    createWritingAttempt, finishWritingAttempt, claimSpeakingEvaluation, getSpeakingEvaluationClaim,
    finishSpeakingAttempt,
    getGeneratedTask, getSharedGeneratedTask, saveGeneratedTask, logAiRequest,
    getBankTask, getBankTaskByExternalId,
  } = db;
  const { askProvider, aiProviders, askWithFallback, limitsFor, parseWithOneRepair } = providerClient;

  function expectedSpeakingAssessmentContext(taskType, session, task, itemIndex = null) {
    const base = `task${taskType}:${session.id}:${task.id}@${task.revision}`;
    return itemIndex == null ? base : `${base}:item${itemIndex}`;
  }

  function grossPronunciationError(word) {
    if (word?.errorType === 'omission' || word?.errorType === 'insertion') return true;
    const accuracy = boundedAcousticMetric(word?.accuracyScore);
    if (word?.errorType !== 'mispronunciation') return null;
    // A provider-labelled mispronunciation is not a proven gross error without a bounded score.
    // Keep the missing score nullable while allowing the semantic criterion to remain assessable.
    if (accuracy === null) return false;
    // Versioned conservative proxy: a very low Azure word-accuracy event is treated as gross.
    // The calibration gate must validate this threshold before any "validated" product label.
    return accuracy < 50;
  }

  function acousticWordToken(value) {
    return String(value || '').toLocaleLowerCase('en-US')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  function alignedAcousticWordSpans(transcript, words) {
    const transcriptTokens = [...String(transcript || '').matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
      .map((match) => ({
        token: acousticWordToken(match[0]),
        start: match.index,
        end: match.index + match[0].length,
      }));
    let transcriptCursor = 0;
    return words.map((word) => {
      const token = acousticWordToken(word?.text);
      const found = token ? transcriptTokens.findIndex((candidate, index) => (
        index >= transcriptCursor && candidate.token === token
      )) : -1;
      if (found < 0) return null;
      transcriptCursor = found + 1;
      return transcriptTokens[found];
    });
  }

  function assessmentDuration(assessment) {
    const value = assessment?.processedDurationSeconds;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 180
      ? value : null;
  }

  function acousticWordTiming(word, processedDurationSeconds) {
    const offsetSeconds = word?.offsetSeconds;
    const durationSeconds = word?.durationSeconds;
    if (typeof offsetSeconds !== 'number' || !Number.isFinite(offsetSeconds) || offsetSeconds < 0
      || typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)
      || durationSeconds <= 0) return null;
    const maximum = processedDurationSeconds + SPEAKING_TIMING_TOLERANCE_SECONDS;
    if (offsetSeconds > maximum || durationSeconds > maximum
      || offsetSeconds + durationSeconds > maximum) return null;
    return { offsetSeconds, durationSeconds };
  }

  function assessmentCoverageComplete(assessment, expectedMode, expectedLocale) {
    const processedDurationSeconds = assessmentDuration(assessment);
    const words = Array.isArray(assessment?.words) ? assessment.words : [];
    const confidence = assessment?.confidence;
    const baseScores = [assessment?.overallScore, assessment?.accuracyScore, assessment?.fluencyScore];
    if (processedDurationSeconds === null || typeof assessment?.transcript !== 'string'
      || !assessment.transcript.trim() || words.length === 0 || words.length > 500
      || assessment?.mode !== expectedMode || assessment?.locale !== expectedLocale
      || assessment?.quality?.acceptable !== true || typeof assessment?.pauseAnalysisAvailable !== 'boolean'
      || typeof confidence !== 'number' || !Number.isFinite(confidence)
      || confidence < 0 || confidence > 100
      || baseScores.some((score) => typeof score !== 'number' || !Number.isFinite(score)
        || score < 0 || score > 100)
      || (assessment?.mode === 'scripted'
        && (typeof assessment?.completenessScore !== 'number'
          || !Number.isFinite(assessment.completenessScore)
          || assessment.completenessScore < 0 || assessment.completenessScore > 100))) return false;
    const supportedTypes = new Set([
      'none', 'omission', 'insertion', 'mispronunciation',
      'unexpected_break', 'missing_break', 'monotone',
    ]);
    return words.every((word) => {
      const accuracyScore = word?.accuracyScore;
      if (!acousticWordToken(word?.text) || !supportedTypes.has(word?.errorType)
        || typeof accuracyScore !== 'number' || !Number.isFinite(accuracyScore)
        || accuracyScore < 0 || accuracyScore > 100) return false;
      if (word.errorType === 'omission') {
        return word.offsetSeconds == null && word.durationSeconds == null;
      }
      return acousticWordTiming(word, processedDurationSeconds) !== null;
    });
  }

  function finalizedSpeakingAssessment(reservation, expectedContext) {
    const assessment = reservation?.result?.assessment;
    if (!reservation) return null;
    if (reservation.context_id !== expectedContext) {
      throw Object.assign(new Error('SPEAKING_ASSESSMENT_CONTEXT_MISMATCH'), {
        status: 409, code: 'SPEAKING_ASSESSMENT_CONTEXT_MISMATCH',
      });
    }
    if (reservation.status !== 'finalized' || !assessment || assessment.available === false
      || assessment.status !== 'success' || assessment.isFinal !== true) {
      throw Object.assign(new Error('SPEAKING_ASSESSMENT_NOT_READY'), {
        status: 409, code: 'SPEAKING_ASSESSMENT_NOT_READY',
      });
    }
    return assessment;
  }

  async function resolveSpeakingAssessments(username, request, session, task) {
    const keys = request.taskType === 2 || request.taskType === 3
      ? request.pronunciationAssessmentKeys
      : [request.pronunciationAssessmentKey];
    if (!Array.isArray(keys) || !keys.length) return null;
    const resolved = [];
    for (const [index, key] of keys.entries()) {
      const stored = await db.getSpeakingAssessmentReservation(username, key);
      const reservation = stored?.reservation;
      if (!reservation) return null;
      const itemIndex = request.taskType === 2 || request.taskType === 3 ? index + 1 : null;
      const assessment = finalizedSpeakingAssessment(
        reservation,
        expectedSpeakingAssessmentContext(request.taskType, session, task, itemIndex),
      );
      resolved.push({ assessment, reservation, itemIndex });
    }
    const confidences = resolved.map(({ assessment }) => boundedAcousticMetric(
      assessment.confidence, { minimum: 0, maximum: 100 },
    ));
    const warnings = resolved.flatMap(({ assessment }) => (
      Array.isArray(assessment.quality?.warnings) ? assessment.quality.warnings : []
    ));
    const accentLocales = [...new Set(resolved.map(({ reservation }) => reservation.locale))];
    if (accentLocales.length !== 1 || !['en-GB', 'en-US'].includes(accentLocales[0])) {
      throw Object.assign(new Error('SPEAKING_ASSESSMENT_CONTEXT_MISMATCH'), {
        status: 409, code: 'SPEAKING_ASSESSMENT_CONTEXT_MISMATCH',
      });
    }
    const expectedMode = request.taskType === 1 ? 'scripted' : 'unscripted';
    const coverageIncomplete = resolved.some(({ assessment, reservation }) => (
      !assessmentCoverageComplete(assessment, expectedMode, reservation.locale)
    ));
    const poor = coverageIncomplete
      || resolved.some(({ assessment }) => assessment.quality?.acceptable !== true);
    const pauseAnalysisAvailable = accentLocales[0] === 'en-US'
      && resolved.every(({ assessment }) => assessment.pauseAnalysisAvailable === true);
    const assessedWords = resolved.flatMap(({ assessment }) => (
      Array.isArray(assessment.words) ? assessment.words : []
    ));
    const targetMeasurement = (() => {
      if (coverageIncomplete) return undefined;
      const focus = session?.targeted_practice?.focus;
      if (!focus || !['word', 'phoneme'].includes(focus.kind)) return undefined;
      const focusRef = String(focus.ref || '').trim().slice(0, 120);
      const value = String(focus.value || '').normalize('NFKC').trim()
        .slice(0, focus.kind === 'phoneme' ? 20 : 120);
      const anchorWord = String(focus.anchorWord || '').normalize('NFKC')
        .toLocaleLowerCase('en').trim().slice(0, 120);
      if (!focusRef || !value || !anchorWord) return undefined;
      const normalizeWord = (candidate) => {
        const words = String(candidate || '').normalize('NFKC').toLocaleLowerCase('en')
          .match(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu) || [];
        return words.length === 1 ? words[0] : '';
      };
      const anchorWords = assessedWords.filter((word) => (
        normalizeWord(word?.text) === anchorWord && word?.errorType !== 'omission'
      ));
      const scores = focus.kind === 'word'
        ? anchorWords.map((word) => word?.accuracyScore)
        : anchorWords.flatMap((word) => (
          (Array.isArray(word?.phonemes) ? word.phonemes : []).flatMap((phoneme) => {
            const label = String(phoneme?.ipa || phoneme?.name || '').normalize('NFKC').trim();
            return label === value ? [phoneme?.accuracyScore] : [];
          })
        ));
      const boundedScores = scores.filter((score) => (
        typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100
      ));
      return {
        focusRef,
        kind: focus.kind,
        value,
        anchorWord,
        anchorObserved: anchorWords.length > 0,
        score: boundedScores.length
          ? Math.round(boundedScores.reduce((sum, score) => sum + score, 0) / boundedScores.length)
          : null,
      };
    })();
    const wordAccuracyScore = coverageIncomplete ? null : finiteAcousticAverage([
      ...resolved.map(({ assessment }) => assessment.accuracyScore),
      ...(resolved.some(({ assessment }) => boundedAcousticMetric(assessment.accuracyScore) !== null)
        ? [] : assessedWords.map((word) => word.accuracyScore)),
    ]);
    const phonemeAccuracyScore = coverageIncomplete ? null : finiteAcousticAverage(assessedWords.flatMap((word) => (
      Array.isArray(word?.phonemes) ? word.phonemes.map((phoneme) => phoneme?.accuracyScore) : []
    )));
    let transcriptOffset = 0;
    const wordEvents = resolved.flatMap(({ assessment, reservation, itemIndex }) => {
      const words = Array.isArray(assessment.words) ? assessment.words : [];
      const processedDurationSeconds = assessmentDuration(assessment);
      const spans = alignedAcousticWordSpans(assessment.transcript, words);
      const currentOffset = transcriptOffset;
      transcriptOffset += String(assessment.transcript || '').length + 1;
      return words.flatMap((word, wordIndex) => {
        if (![
          'mispronunciation', 'omission', 'insertion', 'unexpected_break', 'missing_break', 'monotone',
        ].includes(word?.errorType)) return [];
        const timing = processedDurationSeconds === null
          ? null : acousticWordTiming(word, processedDurationSeconds);
        return [{
            id: `azure:${reservation.id}:${wordIndex + 1}`,
            owner: 'azure_pronunciation',
            type: word.errorType,
            gross: grossPronunciationError(word),
            itemIndex,
            accuracyScore: boundedAcousticMetric(word.accuracyScore),
            start: spans[wordIndex] ? currentOffset + spans[wordIndex].start : null,
            end: spans[wordIndex] ? currentOffset + spans[wordIndex].end : null,
            offsetSeconds: timing?.offsetSeconds ?? null,
            durationSeconds: timing?.durationSeconds ?? null,
            word: String(word.text || '').slice(0, 120),
            phonemes: (Array.isArray(word.phonemes) ? word.phonemes : []).slice(0, 20).flatMap((phoneme) => {
              const label = String(phoneme?.ipa || phoneme?.name || '').trim().slice(0, 20);
              if (!label) return [];
              return [{ label, accuracyScore: boundedAcousticMetric(phoneme?.accuracyScore) }];
            }),
          }];
      });
    });
    const durationFor = (assessment) => {
      const value = assessmentDuration(assessment);
      return value === null ? 0 : value;
    };
    const itemDurations = request.taskType === 2 || request.taskType === 3
      ? resolved.map(({ assessment, itemIndex }) => ({
        itemIndex,
        durationSeconds: durationFor(assessment),
      }))
      : [];
    return {
      transcript: resolved.map(({ assessment }) => assessment.transcript).join('\n'),
      acoustic: {
        available: true,
        accentLocale: accentLocales[0],
        pauseAnalysisAvailable,
        recognitionConfidence: confidences.every((confidence) => confidence !== null)
          ? Math.min(...confidences) / 100 : null,
        signalQuality: poor ? 'poor' : (warnings.length ? 'acceptable' : 'good'),
        recordingDurationSeconds: resolved.reduce((sum, { assessment }) => (
          sum + durationFor(assessment)
        ), 0),
        itemDurations,
        completenessScore: request.taskType === 1 && !coverageIncomplete
          ? boundedAcousticMetric(resolved[0].assessment.completenessScore) : null,
        fluencyScore: coverageIncomplete ? null
          : finiteAcousticAverage(resolved.map(({ assessment }) => assessment.fluencyScore)),
        wordAccuracyScore,
        phonemeAccuracyScore,
        wordEvents,
        ...(targetMeasurement ? { targetMeasurement } : {}),
      },
    };
  }

  async function resolveSpeakingEvaluation(username, request) {
    const entry = speakingCatalogs[request.taskType];
    const fullSection = request.sessionMode === 'full_section';
    const session = fullSection
      ? await db.getFullSpeakingSession(username, request.sessionId)
      : await db[entry.get](username, request.sessionId);
    if (!session) return null;
    const assignment = fullSection ? session.assignments?.find((item) => (
      Number(item.task_type) === Number(request.taskType)
    )) : session;
    if (fullSection && session.status !== 'submitted') {
      throw Object.assign(new Error('SPEAKING_FULL_NOT_SUBMITTED'), {
        status: 409, code: 'SPEAKING_FULL_NOT_SUBMITTED',
      });
    }
    if (assignment?.catalog_id !== entry.catalog.id
      || Number(assignment?.catalog_revision) !== entry.catalog.revision) {
      throw Object.assign(new Error('SPEAKING_CATALOG_REVISION_MISMATCH'), {
        status: 409,
        code: 'SPEAKING_CATALOG_REVISION_MISMATCH',
      });
    }
    const task = entry.catalog.tasks.find((candidate) => candidate.id === assignment?.task_id
      && candidate.revision === Number(assignment?.task_revision));
    if (!task) {
      throw Object.assign(new Error('SPEAKING_CATALOG_REVISION_MISMATCH'), {
        status: 409,
        code: 'SPEAKING_CATALOG_REVISION_MISMATCH',
      });
    }
    const assessment = await resolveSpeakingAssessments(username, request, session, task);
    if (!assessment) return null;
    return { input: speakingTrustedInputSchema.parse({
      taskType: request.taskType,
      transcript: assessment.transcript,
      assignment: evaluationAssignment(request.taskType, task),
    }), acoustic: assessment.acoustic,
    providerRepeatAcknowledgementRequired: fullSection && session.selection_reason === 'ege_mock',
    source: {
      sessionMode: fullSection ? 'full_section' : 'individual',
      sessionId: session.id,
      taskRef: task.id,
      taskRevision: Number(task.revision),
      catalogId: entry.catalog.id,
      catalogRevision: Number(entry.catalog.revision),
      accentLocale: assessment.acoustic.accentLocale,
      assistanceUsed: fullSection
        ? session.selection_reason === 'ege_mock'
        : Boolean(session.assistance_used),
      targetedPractice: fullSection ? null : session.targeted_practice || null,
    } };
  }

  function aiUsage(provider, response) {
    return { promptTokens: response.promptTokens, completionTokens: response.completionTokens, estimatedCostMicrousd: estimateCostMicrousd(response, provider) };
  }

  /* The rejected first call is a real event: it consumed tokens and it explains the latency. */
  function logRepairedAttempt({ username, operation, promptVersion, repair, model }) {
    return logAiRequest({
      username,
      operation,
      provider: repair.provider.name,
      model,
      promptVersion,
      status: 'failed',
      durationMs: repair.durationMs,
      errorCode: repair.reason,
      fallbackReason: `${repair.provider.name} → format repair requested (${repair.reason})`,
      ...aiUsage(repair.provider, repair.usage),
    });
  }

  const dictionaryCache = new TtlCache(config.ai.dictionaryCacheTtlMs, 5000);
  function serveCachedDictionary(req, res, next) {
    if (req.body?.operation !== 'dictionary_lookup') return next();
    const parsed = contentRequestSchema.safeParse(req.body);
    if (!parsed.success) return next();
    const cached = dictionaryCache.get(parsed.data.word.toLocaleLowerCase('en'));
    if (!cached) return next();
    return res.json({ data: cached, provider: 'cache', promptVersion: CONTENT_PROMPT_VERSION, cached: true });
  }

  /*
   * Turn the identifier the client sent into the assignment the server holds. A built-in task may
   * be named by its stable external id, a generated one by its numeric bank id; anything that does
   * not resolve to a task of the right type is refused before a paid call is made.
   */
  async function resolveWritingTask({ taskType, taskId, answer }) {
    const operation = OPERATION_FOR_TASK_TYPE[taskType];
    const record = /^\d+$/u.test(taskId)
      ? await getBankTask(taskId)
      : await getBankTaskByExternalId(taskId);

    if (!record) {
      throw Object.assign(new Error('Задание не найдено.'), { status: 404, code: 'UNKNOWN_TASK' });
    }
    if (record.operation !== operation) {
      throw Object.assign(new Error('Идентификатор задания не соответствует типу работы.'), { status: 400, code: 'TASK_TYPE_MISMATCH' });
    }
    return {
      taskType,
      answer,
      taskId: String(record.id),
      sourceTaskRef: record.externalId || String(record.id),
      assignment: assignmentFor(operation, record.content),
    };
  }

  router.post('/api/v1/ai/evaluate-writing', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), requireAiBudget, writingLimiter, async (req, res, next) => {
    const parsed = writingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Некорректные данные письменного задания.',
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      });
    }

    /* Section 10.1: the assignment comes from the bank, never from the request body. */
    let input;
    try {
      input = await resolveWritingTask(parsed.data);
    } catch (error) {
      return res.status(error.status || 400).json({
        error: { code: error.code || 'UNKNOWN_TASK', message: error.message, requestId: req.requestId },
      });
    }

    const startedAt = Date.now();
    let attemptId;
    let provider = null;
    let model = null;
    let promptTokens = null;
    let completionTokens = null;
    try {
      const evaluation = prepareWritingPrompt(input);
      attemptId = await createWritingAttempt(req.user, {
        ...input,
        evaluatedAnswer: evaluation.evaluatedAnswer,
      }, WRITING_PROMPT_VERSION);
      const { prompt } = evaluation;
      const result = await askWithFallback(prompt.system, prompt.user, input.taskType);
      recordDependencyEvent('ai', 'success');
      if (result.attempts > 1) recordDependencyEvent('ai', 'fallback');
      provider = result.provider;
      model = result.model;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      const outcome = await parseWithOneRepair({
        provider: aiProviders().find((item) => item.name === result.provider),
        text: result.text,
        parse: (text) => parseAndValidateWritingReview(text, input),
        system: prompt.system,
        user: prompt.user,
        operation: input.taskType,
      });
      const review = outcome.value;
      if (outcome.repair) {
        /* The rejected call is logged separately; the accepted answer came from the repair. */
        await logRepairedAttempt({
          username: req.user, operation: input.taskType, promptVersion: WRITING_PROMPT_VERSION, repair: outcome.repair, model,
        });
        promptTokens = outcome.repair.usage.promptTokens;
        completionTokens = outcome.repair.usage.completionTokens;
      }
      const accepted = outcome.repair ? outcome.repair.usage : result;
      await finishWritingAttempt(attemptId, { status: 'completed', review, provider, model });
      await logAiRequest({
        username: req.user,
        operation: input.taskType,
        provider,
        model,
        promptVersion: WRITING_PROMPT_VERSION,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        fallbackReason: result.fallbackReason,
        promptTokens: accepted.promptTokens,
        completionTokens: accepted.completionTokens,
        estimatedCostMicrousd: estimateCostMicrousd(accepted, aiProviders().find((item) => item.name === provider)),
      });
      res.json({
        review,
        provider,
        attemptId,
        voiceTutor: { source: 'writing', attemptId, revision: 1, criterionChoices: reviewVoiceTutorCriterionChoices(review) },
        assessment: EXPERIMENTAL_ASSESSMENT,
        evaluationScope: evaluation.scope,
      });
    } catch (error) {
      recordDependencyEvent('ai', 'error');
      if (!attemptId) return next(error);
      provider ||= error.provider || error.cause?.provider || null;
      model ||= error.model || error.cause?.model || null;
      const invalidResponse = String(error.message).startsWith('AI_RESPONSE_');
      const code = invalidResponse
        ? 'AI_RESPONSE_INVALID'
        : error.message === 'AI_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE';
      const status = invalidResponse ? 502 : (error.status || 502);
      const writes = [logAiRequest({
        username: req.user,
        operation: input.taskType,
        provider,
        model,
        promptVersion: WRITING_PROMPT_VERSION,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: code,
        fallbackReason: error.fallbackReason || error.cause?.fallbackReason || null,
        promptTokens,
        completionTokens,
        estimatedCostMicrousd: estimateCostMicrousd({ promptTokens, completionTokens }, aiProviders().find((item) => item.name === provider)),
      })];
      if (attemptId) writes.push(finishWritingAttempt(attemptId, {
        status: 'failed', provider, model, errorCode: code,
      }));
      await Promise.allSettled(writes);
      const message = code === 'AI_NOT_CONFIGURED'
        ? 'ИИ не настроен на сервере.'
        : code === 'AI_RESPONSE_INVALID'
          ? 'ИИ вернул некорректный разбор. Попробуйте ещё раз.'
          : 'ИИ временно недоступен.';
      res.status(status).json({ error: { code, message } });
    }
  });

  /*
   * The generation core, separate from the endpoint, because the task bank of section 10.1 needs
   * the same work without an HTTP request in front of it. Failures come back as errors carrying a
   * status and a public code, so both callers can answer without re-deriving them.
   */
  function invalidContentResponse() {
    return Object.assign(new Error('AI_RESPONSE_INVALID'), { code: 'AI_RESPONSE_INVALID' });
  }

  function validatedContentData(input, raw) {
    const data = parseContentResponse(input.operation, typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (input.operation === 'vocabulary_cards' && data.length !== input.count) throw invalidContentResponse();
    return data;
  }

  function decoratedContentData(input, requestHash, data) {
    const decorated = decorateGeneratedVoiceTutorContent(input.operation, requestHash, data);
    if (input.operation === 'vocabulary_cards'
      && (!Array.isArray(decorated) || decorated.some((card) => !card.voice_tutor))) {
      throw invalidContentResponse();
    }
    return decorated;
  }

  async function runContentGeneration({ username, input }) {
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ promptVersion: CONTENT_PROMPT_VERSION, input })).digest('hex');
    // Own copy first, then anyone's: the same input always produces the same exercise, so a
    // second student must not cost a second paid call.
    const stored = await getGeneratedTask(username, requestHash);
    let shared = stored ? null : await getSharedGeneratedTask(requestHash);
    let sharedData = null;
    if (shared) {
      try {
        sharedData = validatedContentData(input, shared.result);
        decoratedContentData(input, requestHash, sharedData);
      } catch (error) {
        if (error.code !== 'AI_RESPONSE_INVALID') throw error;
        shared = null;
      }
    }
    if (shared) {
      await saveGeneratedTask(username, {
        operation: input.operation,
        requestHash,
        request: input,
        result: sharedData,
        provider: shared.provider,
        promptVersion: shared.prompt_version,
      });
    }
    const reusable = stored || (shared ? await getGeneratedTask(username, requestHash) : null);
    if (reusable) {
      try {
        const reusableData = validatedContentData(input, reusable.result);
        return { data: decoratedContentData(input, requestHash, reusableData), provider: 'cache', sourceProvider: reusable.provider, promptVersion: reusable.prompt_version, cached: true };
      } catch (error) {
        if (error.code !== 'AI_RESPONSE_INVALID') throw error;
        throw Object.assign(error, { status: 502 });
      }
    }
    if (!await hasAiBudget()) throw Object.assign(new Error('Дневной лимит ИИ исчерпан. Попробуйте завтра.'), { status: 503, code: 'AI_BUDGET_EXHAUSTED' });
    const prompt = buildContentPrompt(input);
    const startedAt = Date.now();
    const providers = providersFor(input.operation, aiProviders());
    if (!providers.length) throw Object.assign(new Error('ИИ не настроен на сервере.'), { status: 503, code: 'AI_NOT_CONFIGURED' });
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user, input.operation);
        usage = response;
        const outcome = await parseWithOneRepair({
          provider,
          text: response.text,
          parse: (text) => {
            return validatedContentData(input, text);
          },
          system: prompt.system,
          user: prompt.user,
          operation: input.operation,
        });
        const data = outcome.value;
        if (outcome.repair) {
          usage = outcome.repair.usage;
          await logRepairedAttempt({
            username, operation: input.operation, promptVersion: CONTENT_PROMPT_VERSION, repair: outcome.repair, model: provider.model,
          });
        }
        decoratedContentData(input, requestHash, data);
        if (input.operation === 'dictionary_lookup') dictionaryCache.set(input.word.toLocaleLowerCase('en'), data);
        await Promise.all([
          logAiRequest({ username, operation: input.operation, provider: provider.name, model: provider.model, promptVersion: CONTENT_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) }),
          saveGeneratedTask(username, { operation: input.operation, requestHash, request: input, result: data, provider: provider.name, promptVersion: CONTENT_PROMPT_VERSION }),
        ]);
        // Concurrent identical calls can both reach a provider, but the repository keeps only one
        // canonical row. Always issue Voice Tutor pointers for that stored winner, never for a
        // valid-but-losing provider result that cannot be rebuilt later.
        const canonicalStored = await getGeneratedTask(username, requestHash);
        if (!canonicalStored) throw Object.assign(new Error('AI_RESPONSE_INVALID'), { code: 'AI_RESPONSE_INVALID' });
        const canonicalData = validatedContentData(input, canonicalStored.result);
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        return { data: decoratedContentData(input, requestHash, canonicalData), provider: canonicalStored.provider, promptVersion: canonicalStored.prompt_version, cached: false };
      } catch (error) {
        if (error.status && error.code) throw error;
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username, operation: input.operation, provider: provider.name, model: provider.model, promptVersion: CONTENT_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    throw Object.assign(new Error('Не удалось подготовить корректный учебный материал.'), {
      status: lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503,
      code: lastCode,
    });
  }

  router.post('/api/v1/ai/generate-content', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), contentLimiter, serveCachedDictionary, async (req, res) => {
    const parsed = contentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры генерации.' } });
    try {
      const result = await runContentGeneration({ username: req.user, input: parsed.data });
      return res.json(result);
    } catch (error) {
      if (!error.status || !error.code) throw error;
      return res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
    }
  });

  function respondToExistingSpeakingClaim(req, res, attempt, egeMock = false) {
    const replay = speakingReplayPayload(attempt, egeMock);
    if (replay) return res.json(replay);
    if (attempt?.status === 'failed') {
      const errorCode = attempt.error_code || 'AI_PROVIDER_UNAVAILABLE';
      return res.status(errorCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: {
        code: errorCode,
        message: 'Не удалось корректно оценить устный ответ.',
        requestId: req.requestId,
      } });
    }
    return res.status(409).json({ error: {
      code: 'SPEAKING_EVALUATION_IN_PROGRESS',
      message: 'Эта запись уже оценивается.',
      requestId: req.requestId,
    } });
  }

  function respondToSpeakingAuthorizationError(req, res, error) {
    if (!['SUBSCRIPTION_REQUIRED', 'PRIVACY_CONSENT_REQUIRED'].includes(error?.code)) {
      return false;
    }
    res.status(403).json({ error: {
      code: error.code,
      message: error.code === 'SUBSCRIPTION_REQUIRED'
        ? 'Для этой функции требуется активный доступ.'
        : 'Перед отправкой записи подтвердите согласие в профиле.',
      requestId: req.requestId,
    } });
    return true;
  }

  async function prepareSpeakingEvaluation(req, res, next) {
    const parsed = speakingRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные устного ответа.' } });
    let input;
    let acousticEvidence = null;
    let source = null;
    let providerRepeatAcknowledgementRequired = false;
    try {
      const resolved = await resolveSpeakingEvaluation(req.user, parsed.data);
      input = resolved?.input || null;
      acousticEvidence = resolved?.acoustic || null;
      source = resolved?.source || null;
      providerRepeatAcknowledgementRequired = resolved?.providerRepeatAcknowledgementRequired === true;
    } catch (error) {
      if (error?.status && error?.code) {
        return res.status(error.status).json({ error: {
          code: error.code,
          message: SPEAKING_RESOLUTION_MESSAGES[error.code] || 'Тренировку не удалось подготовить к оценке.',
          requestId: req.requestId,
        } });
      }
      throw error;
    }
    if (!input) return res.status(404).json({ error: {
      code: 'SPEAKING_SESSION_NOT_FOUND',
      message: 'Тренировка не найдена.',
      requestId: req.requestId,
    } });
    const evaluationFingerprint = speakingEvaluationFingerprint(parsed.data);
    const existing = await getSpeakingEvaluationClaim(req.user, evaluationFingerprint);
    const invalidEgeProviderResponse = providerRepeatAcknowledgementRequired
      && existing?.status === 'failed' && existing?.error_code === 'AI_RESPONSE_INVALID';
    const recoveryOptions = {
      allowInvalidProviderResponse: invalidEgeProviderResponse,
    };
    if (existing && !speakingEvaluationClaimRecoverable(existing, new Date(), recoveryOptions)) {
      return respondToExistingSpeakingClaim(
        req, res, existing, providerRepeatAcknowledgementRequired,
      );
    }
    const providerRepeatPossible = providerRepeatAcknowledgementRequired
      && speakingEvaluationProviderRepeatPossible(existing, new Date(), recoveryOptions);
    const allowRecovery = !providerRepeatPossible
      || parsed.data.acknowledgePossibleProviderRepeat === true;
    const allowInvalidRecovery = invalidEgeProviderResponse && allowRecovery;
    if (existing && !allowRecovery) {
      return res.status(409).json({ error: {
        code: 'SPEAKING_PROVIDER_REPEAT_ACKNOWLEDGEMENT_REQUIRED',
        message: 'Предыдущий вызов провайдера мог состояться. Повтор требует явного подтверждения риска повторной оплаты.',
        requestId: req.requestId,
      } });
    }
    const acousticRetry = publicSpeakingAcousticRetry(input.taskType, acousticEvidence);
    res.locals.speakingEvaluation = {
      input, acousticEvidence, evaluationFingerprint, source, allowRecovery,
      allowInvalidRecovery, acousticRetry,
      egeMock: providerRepeatAcknowledgementRequired,
    };
    return next();
  }

  async function settlePreparedSpeakingAcousticRetry(req, res, next) {
    const {
      input, acousticEvidence, evaluationFingerprint, source, allowRecovery,
      allowInvalidRecovery, acousticRetry, egeMock,
    } = res.locals.speakingEvaluation;
    if (!acousticRetry) return next();
    let claim;
    try {
      claim = await claimSpeakingEvaluation(
        req.user,
        input,
        SPEAKING_PROMPT_VERSION,
        evaluationFingerprint,
        {
          source, allowRecovery, allowInvalidRecovery,
          voiceConsentPolicyVersion: privacyPolicyVersion,
        },
      );
    } catch (error) {
      if (respondToSpeakingAuthorizationError(req, res, error)) return undefined;
      throw error;
    }
    if (!claim.created) {
      const replay = speakingReplayPayload(claim.attempt, egeMock);
      if (replay) return res.json(replay);
      if (claim.attempt?.status === 'failed') {
        const errorCode = claim.attempt.error_code || 'AI_PROVIDER_UNAVAILABLE';
        return res.status(errorCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: {
          code: errorCode,
          message: 'Не удалось корректно оценить устный ответ.',
          requestId: req.requestId,
        } });
      }
      return res.status(409).json({ error: {
        code: 'SPEAKING_EVALUATION_IN_PROGRESS',
        message: 'Эта запись уже оценивается.',
        requestId: req.requestId,
      } });
    }
    const attemptId = Number(claim.attempt.id);
    if (acousticRetry) {
      await finishSpeakingAttempt(attemptId, {
        status: 'needs_retry', review: { ...acousticRetry, acousticFacts: acousticEvidence },
      }, { claimGeneration: claim.attempt.evaluation_claim_generation });
      return res.json({
        review: acousticRetry,
        provider: null,
        promptVersion: SPEAKING_PROMPT_VERSION,
        attemptId,
        assessment: speakingAssessmentContract(acousticRetry, egeMock),
      });
    }
    return undefined;
  }

  router.post(
    '/api/v1/ai/evaluate-speaking',
    auth,
    prepareSpeakingEvaluation,
    requireActiveSubscription,
    requirePrivacyConsent('voice_processing'),
    settlePreparedSpeakingAcousticRetry,
    requireAiBudget,
    speakingEvalLimiter,
    async (req, res) => {
    const {
      input, acousticEvidence, evaluationFingerprint, source, allowRecovery,
      allowInvalidRecovery, egeMock,
    } = res.locals.speakingEvaluation;
    let claim;
    try {
      claim = await claimSpeakingEvaluation(
        req.user, input, SPEAKING_PROMPT_VERSION, evaluationFingerprint,
        {
          source, allowRecovery, allowInvalidRecovery,
          voiceConsentPolicyVersion: privacyPolicyVersion,
        },
      );
    } catch (error) {
      if (respondToSpeakingAuthorizationError(req, res, error)) return undefined;
      throw error;
    }
    if (!claim.created) return respondToExistingSpeakingClaim(req, res, claim.attempt, egeMock);
    const attemptId = Number(claim.attempt.id);
    const claimGeneration = Number(claim.attempt.evaluation_claim_generation);
    const prompt = buildSpeakingPrompt(input);
    const startedAt = Date.now();
    const providers = providersFor('evaluate_speaking', aiProviders());
    if (!providers.length) {
      await finishSpeakingAttempt(
        attemptId,
        { status: 'failed', errorCode: 'AI_NOT_CONFIGURED' },
        { claimGeneration },
      );
      return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'ИИ не настроен на сервере.' } });
    }
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      let review;
      let storedReview;
      let repair = null;
      try {
        const response = await askProvider(
          provider,
          prompt.system,
          prompt.user,
          'evaluate_speaking',
          { responseFormat: prompt.responseFormat },
        );
        usage = response;
        const outcome = egeMock
          ? { value: parseSpeakingSemanticReview(input.taskType, response.text), repair: null }
          : await parseWithOneRepair({
            provider,
            text: response.text,
            parse: (text) => parseSpeakingSemanticReview(input.taskType, text),
            system: prompt.system,
            user: prompt.user,
            operation: 'evaluate_speaking',
            responseFormat: prompt.responseFormat,
          });
        const semanticFacts = outcome.value;
        const scored = scoreSpeakingTask({
          taskType: input.taskType,
          semantic: semanticFacts,
          acoustic: acousticEvidence,
        });
        review = publicSpeakingReview(scored, semanticFacts);
        storedReview = { ...review, semanticFacts, acousticFacts: acousticEvidence };
        repair = outcome.repair;
        if (repair) {
          usage = outcome.repair.usage;
        }
      } catch (error) {
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username: req.user, operation: `evaluate_speaking_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
        continue;
      }
      try {
        await finishSpeakingAttempt(attemptId, {
          status: review.status === 'scored' ? 'completed' : 'needs_retry',
          review: storedReview, provider: provider.name, model: provider.model,
        }, { claimGeneration });
      } catch (_) {
        recordDependencyEvent('ai', 'error');
        await Promise.allSettled([
          logAiRequest({
            username: req.user, operation: `evaluate_speaking_${input.taskType}`,
            provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION,
            status: 'failed', durationMs: Date.now() - startedAt,
            errorCode: 'SPEAKING_EVALUATION_SETTLEMENT_UNKNOWN',
            fallbackReason: `${provider.name} → provider result received; durable settlement unknown`,
            ...aiUsage(provider, usage),
          }),
        ]);
        return res.status(503).json({ error: {
          code: 'SPEAKING_EVALUATION_SETTLEMENT_UNKNOWN',
          message: 'Ответ провайдера получен, но сохранение результата не подтверждено. Автоматический повтор отключён.',
          requestId: req.requestId,
        } });
      }
      await Promise.allSettled([
        ...(repair ? [logRepairedAttempt({
          username: req.user, operation: `evaluate_speaking_${input.taskType}`,
          promptVersion: SPEAKING_PROMPT_VERSION, repair, model: provider.model,
        })] : []),
        logAiRequest({ username: req.user, operation: `evaluate_speaking_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) }),
      ]);
      recordDependencyEvent('ai', 'success');
      if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
      const payload = {
        review,
        provider: provider.name,
        promptVersion: SPEAKING_PROMPT_VERSION,
        attemptId,
      };
      if (review.status === 'scored') {
        payload.voiceTutor = {
          source: 'speaking', attemptId, revision: 1,
          criterionChoices: reviewVoiceTutorCriterionChoices(review),
        };
      }
      payload.assessment = speakingAssessmentContract(review, egeMock);
      return res.json(payload);
    }
    const lastProvider = providers.at(-1);
    await finishSpeakingAttempt(attemptId, {
      status: 'failed',
      provider: lastProvider?.name,
      model: lastProvider?.model,
      errorCode: lastCode,
    }, { claimGeneration });
    res.status(lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: { code: lastCode, message: 'Не удалось корректно оценить устный ответ.' } });
  });

  router.post('/api/v1/ai/generate-speaking-sample', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), requireAiBudget, speakingSampleLimiter, async (req, res) => {
    const parsed = speakingSampleRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры образцового ответа.' } });
    const input = parsed.data;
    const prompt = buildSpeakingSamplePrompt(input);
    const startedAt = Date.now();
    // A sample answer is a convenience: its registry entry forbids a second provider.
    const providers = providersFor('speaking_sample', aiProviders());
    if (!providers.length) return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'ИИ не настроен на сервере.' } });
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user, 'speaking_sample');
        usage = response;
        const data = parseSpeakingSample(input.taskType, response.text);
        await logAiRequest({ username: req.user, operation: `speaking_sample_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) });
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        return res.json({ data, provider: provider.name, promptVersion: SPEAKING_PROMPT_VERSION });
      } catch (error) {
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username: req.user, operation: `speaking_sample_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    res.status(lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: { code: lastCode, message: 'Не удалось подготовить образцовый ответ.' } });
  });

  // ---- нейро-озвучка: Grok TTS (основной) + Edge TTS (запасной и для медленного) ----

  return { router, runContentGeneration };
}
