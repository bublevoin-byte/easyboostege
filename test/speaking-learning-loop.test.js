import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpeakingLearningAttempt,
  buildSpeakingLearningReport,
  speakingTargetedPracticeAssignment,
  speakingAdaptiveEvidenceAttempts,
  SPEAKING_LEARNING_EVIDENCE_VERSION,
} from '../speaking/learning-loop.js';
import {
  boundedAcousticMetric,
  finiteAcousticAverage,
} from '../speaking/acoustic-metrics.js';
import {
  publicSpeakingReview,
  scoreSpeakingTask,
  SPEAKING_SCORING_VERSION,
} from '../speaking/fipi-scoring.js';
import { buildAdaptiveLearningProfile } from '../adaptive-learning/profile.js';
import { selectSpeakingTrainingAssignment } from '../speaking/training-session.js';

function task2Semantic({ confidence = 0.94, allRelevant = false } = {}) {
  return {
    confidence,
    verdict: 'Ответ можно оценить.',
    evidence: ['Четыре прямых вопроса проверены.'],
    issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      relevant: allRelevant || index !== 1,
      directQuestion: true,
      lexicalGrammarBlocksCommunication: false,
      evidence: `Question ${index + 1}`,
    })),
  };
}

function task2Acoustic({ confidence = 0.95, signalQuality = 'good', phonemeLabel = 'ð' } = {}) {
  return {
    available: true,
    recognitionConfidence: confidence,
    signalQuality,
    recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({
      itemIndex: index + 1,
      durationSeconds: 12,
    })),
    wordAccuracyScore: 94,
    phonemeAccuracyScore: 91,
    fluencyScore: 86,
    pauseAnalysisAvailable: false,
    wordEvents: [{
      id: 'azure:assessment:1', owner: 'azure_pronunciation', type: 'mispronunciation',
      gross: false, itemIndex: 2, accuracyScore: 72, start: 12, end: 19,
      offsetSeconds: 3.25, durationSeconds: 0.6,
      word: 'weather', phonemes: [{ label: phonemeLabel, accuracyScore: 48 }],
    }],
  };
}

function attempt({ assisted = false, semanticConfidence = 0.94, acousticConfidence = 0.95,
  signalQuality = 'good', status = 'completed', accentLocale = 'en-GB',
  allRelevant = false, phonemeLabel = 'ð' } = {}) {
  const semanticFacts = task2Semantic({ confidence: semanticConfidence, allRelevant });
  const acousticFacts = task2Acoustic({
    confidence: acousticConfidence, signalQuality, phonemeLabel,
  });
  acousticFacts.accentLocale = accentLocale;
  const scored = scoreSpeakingTask({ taskType: 2, semantic: semanticFacts, acoustic: acousticFacts });
  const review = publicSpeakingReview(scored, semanticFacts);
  return {
    id: 41,
    task_type: 2,
    source_session_id: '99ad4346-480f-4124-8f66-79c915cadbc5',
    source_task_ref: 'speaking-pilot-v1.task2.weekend-pottery',
    source_task_revision: 1,
    source_catalog_id: 'speaking-pilot-v1',
    source_catalog_revision: 1,
    accent_locale: accentLocale,
    assistance_used: assisted,
    transcript: 'When does the course start? What is the weather like?',
    status,
    created_at: '2026-08-07T08:00:00.000Z',
    evaluated_at: '2026-08-07T08:01:00.000Z',
    review: { ...review, semanticFacts, acousticFacts },
  };
}

test('nullable acoustic metrics stay unavailable instead of becoming false zero mastery', () => {
  for (const unavailable of [null, undefined, '', '42', Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
    assert.equal(boundedAcousticMetric(unavailable), null);
  }
  assert.equal(boundedAcousticMetric(0), 0);
  assert.equal(boundedAcousticMetric(100), 100);
  assert.equal(finiteAcousticAverage([null, undefined, '', '42', Number.NaN, -1, 101]), null);
  assert.equal(finiteAcousticAverage([null, 40, undefined, 60]), 50);

  const raw = structuredClone(attempt());
  raw.review.acousticFacts.completenessScore = null;
  raw.review.acousticFacts.fluencyScore = null;
  raw.review.acousticFacts.wordAccuracyScore = null;
  raw.review.acousticFacts.phonemeAccuracyScore = null;
  raw.review.acousticFacts.wordEvents[0].accuracyScore = null;
  raw.review.acousticFacts.wordEvents[0].phonemes[0].accuracyScore = null;
  const evidence = buildSpeakingLearningAttempt(raw);

  assert.equal(evidence.status, 'scored');
  assert.equal(evidence.masteryEligible, true);
  assert.deepEqual({
    completenessScore: evidence.signal.completenessScore,
    fluencyScore: evidence.signal.fluencyScore,
    wordAccuracyScore: evidence.signal.wordAccuracyScore,
    phonemeAccuracyScore: evidence.signal.phonemeAccuracyScore,
  }, {
    completenessScore: null,
    fluencyScore: null,
    wordAccuracyScore: null,
    phonemeAccuracyScore: null,
  });
  assert.equal(evidence.signal.pauseAnalysis.fluencyProxyAvailable, false);
  assert.equal(evidence.signal.pauseAnalysis.available, false);
  assert.equal(evidence.signal.pauseAnalysis.reason, 'locale_not_supported');
  assert.equal(evidence.wordIssues[0].accuracyScore, null);
  assert.equal(evidence.wordIssues[0].phonemes[0].accuracyScore, null);

  const adaptive = speakingAdaptiveEvidenceAttempts([evidence]);
  assert.equal(adaptive.some((row) => [
    'ege.speaking.pronunciation_words',
    'ege.speaking.pronunciation_phonemes',
    'ege.speaking.fluency',
  ].includes(row.metadata.skill_id)), false);
  assert.ok(adaptive.every((row) => row.metadata.accent_locale === 'en-GB'));

  const report = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.premium.targetedPractice?.focus, null,
    'an unavailable pronunciation score must never create a false 0% target');
  assert.equal(report.premium.wordDynamics[0].currentAccuracy, null);
  assert.equal(report.premium.phonemeDynamics[0].currentAccuracy, null);
});

test('adaptive Speaking evidence defensively keeps only the newest 120 scored attempts', () => {
  const baseEvidence = buildSpeakingLearningAttempt(attempt());
  const evidenceAttempts = Array.from({ length: 125 }, (_, index) => ({
    ...structuredClone(baseEvidence),
    attemptId: index + 1,
    observedAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    evidenceChangedAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
  })).reverse();
  evidenceAttempts.find((item) => item.attemptId === 124).evidenceChangedAt =
    evidenceAttempts.find((item) => item.attemptId === 125).evidenceChangedAt;

  const adaptive = speakingAdaptiveEvidenceAttempts(evidenceAttempts);
  const sourceAttemptIds = [...new Set(adaptive.map((row) => row.metadata.source_attempt_id))];

  assert.equal(sourceAttemptIds.length, 120);
  assert.equal(sourceAttemptIds[0], 'speaking:125');
  assert.equal(sourceAttemptIds[1], 'speaking:124');
  assert.equal(sourceAttemptIds.includes('speaking:5'), false);
  assert.equal(sourceAttemptIds.at(-1), 'speaking:6');
});

test('targeted practice reuses its sole suitable latest task instead of failing with an empty assignment', () => {
  const tasks = [{ id: 'speaking-task-2-weather', revision: 1 }];
  const sessions = [{
    task_id: 'speaking-task-2-weather', status: 'completed', self_rating: 'strong',
    assigned_at: '2026-08-07T09:00:00.000Z', due_at: '2026-08-09T09:00:00.000Z',
  }];
  const selected = selectSpeakingTrainingAssignment(tasks, sessions, new Date('2026-08-07T10:00:00.000Z'), {
    preferredTaskIds: ['speaking-task-2-weather'],
    selectionReason: 'targeted_pronunciation',
  });
  assert.equal(selected.task.id, 'speaking-task-2-weather');
  assert.equal(selected.reason, 'targeted_pronunciation');
});

test('scored high-confidence official unassisted attempts publish bounded task, criterion, word and phoneme evidence', () => {
  const evidence = buildSpeakingLearningAttempt(attempt());
  assert.equal(evidence.version, SPEAKING_LEARNING_EVIDENCE_VERSION);
  assert.equal(evidence.status, 'scored');
  assert.equal(evidence.provenance.officialSession, true);
  assert.equal(evidence.provenance.assistance, 'unassisted');
  assert.equal(evidence.signal.highConfidence, true);
  assert.equal(evidence.masteryEligible, true);
  assert.equal(evidence.accentLocale, 'en-GB');
  assert.equal(evidence.criteria.length, 4);
  assert.deepEqual(evidence.criteria.map((criterion) => criterion.skillIds), [
    ['ege.speaking.direct_questions'], ['ege.speaking.direct_questions'],
    ['ege.speaking.direct_questions'], ['ege.speaking.direct_questions'],
  ]);
  assert.deepEqual(evidence.wordIssues, [{
    id: 'azure:assessment:1', word: 'weather', errorType: 'mispronunciation',
    itemIndex: 2, accuracyScore: 72, gross: false,
    offsetSeconds: 3.25, durationSeconds: 0.6,
    phonemes: [{ label: 'ð', accuracyScore: 48 }],
  }]);
  assert.equal(Object.hasOwn(evidence, 'semanticFacts'), false);
  assert.equal(Object.hasOwn(evidence, 'acousticFacts'), false);
});

test('a targeted pronunciation resolution is locale-bound and a later regression reactivates the segment', () => {
  const original = buildSpeakingLearningAttempt(attempt({ accentLocale: 'en-GB' }));
  const initial = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const target = initial.premium.targetedPractice;
  assert.equal(target.accentLocale, 'en-GB');
  assert.match(target.reportRevision, /^attempt\.[0-9]+\.[0-9]+$/u);

  const crossLocaleRaw = structuredClone(attempt({ accentLocale: 'en-US' }));
  crossLocaleRaw.id = 42;
  crossLocaleRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  crossLocaleRaw.review.acousticFacts.wordEvents[0].accuracyScore = 96;
  crossLocaleRaw.review.acousticFacts.wordEvents[0].phonemes = [{
    label: target.focus.value, accuracyScore: 92,
  }];
  crossLocaleRaw.review.acousticFacts.targetMeasurement = {
    focusRef: target.focus.ref, kind: target.focus.kind, value: target.focus.value,
    anchorWord: target.focus.anchorWord, anchorObserved: true, score: 92,
  };
  crossLocaleRaw.targeted_practice = target;
  const crossLocale = buildSpeakingLearningAttempt(crossLocaleRaw);
  assert.equal(crossLocale.targetOutcome.status, 'inconclusive');
  assert.equal(buildSpeakingLearningReport([original, crossLocale], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice.accentLocale, 'en-GB');

  const resolvedRaw = structuredClone(attempt({ accentLocale: 'en-GB' }));
  resolvedRaw.id = 43;
  resolvedRaw.evaluated_at = '2026-08-09T08:01:00.000Z';
  resolvedRaw.review.acousticFacts.wordEvents = [];
  resolvedRaw.review.acousticFacts.targetMeasurement = {
    focusRef: target.focus.ref, kind: target.focus.kind, value: target.focus.value,
    anchorWord: target.focus.anchorWord, anchorObserved: true, score: 93,
  };
  resolvedRaw.targeted_practice = target;
  const resolved = buildSpeakingLearningAttempt(resolvedRaw);
  assert.equal(resolved.targetOutcome.status, 'resolved');

  const retired = buildSpeakingLearningReport([original, resolved], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(retired.premium.targetedPractice?.focus?.value === target.focus.value
    && retired.premium.targetedPractice?.accentLocale === 'en-GB', false);

  const regressionRaw = structuredClone(attempt({ accentLocale: 'en-GB' }));
  regressionRaw.id = 44;
  regressionRaw.evaluated_at = '2026-08-10T08:01:00.000Z';
  regressionRaw.review.acousticFacts.wordEvents[0].accuracyScore = 55;
  regressionRaw.review.acousticFacts.wordEvents[0].phonemes = [{
    label: target.focus.value, accuracyScore: 35,
  }];
  const regressed = buildSpeakingLearningAttempt(regressionRaw);
  const reactivated = buildSpeakingLearningReport([original, crossLocale, resolved, regressed], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(reactivated.premium.targetedPractice.focus.value, target.focus.value);
  assert.equal(reactivated.premium.targetedPractice.accentLocale, 'en-GB');
  assert.ok(reactivated.premium.phonemeDynamics.some((item) => (
    item.label === target.focus.value && item.accentLocale === 'en-GB' && item.currentAccuracy === 35
  )));
  assert.ok(reactivated.premium.phonemeDynamics.some((item) => item.accentLocale === 'en-US'));
});

test('assisted, low-confidence, technical and unbound attempts remain visible but cannot raise mastery', () => {
  const assisted = buildSpeakingLearningAttempt({
    ...attempt({ assisted: true }), assistance_updated_at: '2026-08-07T09:00:00.000Z',
  });
  const uncertain = buildSpeakingLearningAttempt(attempt({ acousticConfidence: 0.72 }));
  const technical = buildSpeakingLearningAttempt({ ...attempt(), status: 'needs_retry', review: {
    status: 'needs_retry', got: null, max: 4, verdict: 'Перезапишите ответ.', criteria: [],
    good: [], fix: [], confidence: 0.95, needsRetryReason: 'acoustic_evidence_uncertain',
    scoringVersion: SPEAKING_SCORING_VERSION,
  } });
  const unbound = buildSpeakingLearningAttempt({ ...attempt(), source_session_id: null });
  assert.equal(assisted.masteryEligible, false);
  assert.equal(assisted.provenance.assistance, 'assisted');
  assert.equal(uncertain.masteryEligible, false);
  assert.equal(technical.masteryEligible, false);
  assert.equal(technical.status, 'needs_retry');
  assert.equal(unbound.masteryEligible, false);
  const assistedRows = speakingAdaptiveEvidenceAttempts([assisted, uncertain, technical, unbound]);
  assert.ok(assistedRows.length > 0, 'assistance remains an append-only invalidation source');
  assert.ok(assistedRows.every((row) => row.evidence_quality === 'server_verified_assisted'));
  assert.ok(assistedRows.every((row) => row.created_at === '2026-08-07T09:00:00.000Z'));
  const assistedProfile = buildAdaptiveLearningProfile({ attempts: assistedRows });
  assert.equal(assistedProfile.independentEvidenceCount, 0);
  assert.ok(assistedProfile.assistedEvidenceCount > 0);
});

test('Base always gives a safe next action when no reliable mastery evidence exists', () => {
  const technicalRaw = attempt();
  technicalRaw.status = 'needs_retry';
  technicalRaw.review = {
    status: 'needs_retry', got: null, max: 4, verdict: 'Перезапишите ответ.', criteria: [],
    good: [], fix: [], confidence: 0.95, needsRetryReason: 'acoustic_evidence_uncertain',
    scoringVersion: SPEAKING_SCORING_VERSION,
  };
  const cases = [
    [[], 'start_official_attempt'],
    [[buildSpeakingLearningAttempt(attempt({ assisted: true }))], 'retry_without_assistance'],
    [[buildSpeakingLearningAttempt(attempt({ acousticConfidence: 0.72 }))], 'retry_for_signal_quality'],
    [[buildSpeakingLearningAttempt(technicalRaw)], 'retry_technical_assessment'],
  ];
  for (const [history, reason] of cases) {
    const report = buildSpeakingLearningReport(history, {
      quota: { tier: 'base', limitSeconds: 3_600, remainingSeconds: 3_600 },
    });
    assert.ok(report.nextStep, `Base nextStep is required for ${reason}`);
    assert.equal(report.nextStep.reason, reason);
    assert.equal(report.nextStep.focus, null);
  }
});

test('adaptive profile receives distinct Speaking skill evidence but counts one source attempt once', () => {
  const evidence = buildSpeakingLearningAttempt(attempt());
  const adaptive = speakingAdaptiveEvidenceAttempts([evidence]);
  assert.equal(adaptive.length, 5);
  assert.ok(adaptive.every((row) => row.evidence_quality === 'server_verified_unassisted'));
  assert.ok(adaptive.every((row) => row.module === 'speaking' && row.activity === 'speaking_2'));
  assert.deepEqual(adaptive.map((row) => row.metadata.skill_id), [
    'ege.speaking.direct_questions',
    'ege.speaking.pronunciation_words',
    'ege.speaking.pronunciation_phonemes',
    'ege.speaking.fluency',
    'ege.speaking.signal_quality',
  ]);
  assert.deepEqual(adaptive.map((row) => row.metadata.observation_type), [
    'criterion', 'word_accuracy', 'phoneme_accuracy', 'fluency', 'signal',
  ]);
  assert.equal(adaptive.find((row) => row.metadata.skill_id === 'ege.speaking.pronunciation_words').score, 94);
  assert.equal(adaptive.find((row) => row.metadata.skill_id === 'ege.speaking.pronunciation_phonemes').score, 91);
  assert.equal(adaptive.find((row) => row.metadata.skill_id === 'ege.speaking.fluency').score, 86);
  assert.ok(adaptive.every((row) => row.metadata.source_attempt_id === 'speaking:41'));
  const profile = buildAdaptiveLearningProfile({ attempts: adaptive });
  const questions = profile.skills.find((skill) => skill.id === 'ege.speaking.direct_questions');
  assert.equal(questions.evidenceCount, 1);
  assert.equal(questions.independentEvidenceCount, 1);
  assert.equal(profile.independentEvidenceCount, 1);
  assert.equal(profile.modules.find((module) => module.id === 'speaking').independentEvidenceCount, 1);
});

test('Base keeps the complete current analysis and 60-minute allowance while Premium adds longitudinal tools', () => {
  const current = buildSpeakingLearningAttempt(attempt());
  const older = buildSpeakingLearningAttempt({
    ...attempt(), id: 40, source_task_ref: 'speaking-pilot-v1.task2.indoor-climbing',
    evaluated_at: '2026-08-01T08:01:00.000Z',
  });
  const quotaBase = { tier: 'base', limitSeconds: 3_600, usedSeconds: 120, remainingSeconds: 3_480 };
  const base = buildSpeakingLearningReport([older, current], { quota: quotaBase });
  assert.equal(base.access.tier, 'base');
  assert.equal(base.access.limitSeconds, 3_600);
  assert.equal(base.currentAttempt.attemptId, 41);
  assert.equal(base.currentAttempt.transcript.includes('course'), true);
  assert.equal(base.currentAttempt.criteria.length, 4);
  assert.equal(base.premium, null);

  const premium = buildSpeakingLearningReport([older, current], {
    quota: { ...quotaBase, tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_280 },
  });
  assert.equal(premium.access.limitSeconds, 14_400);
  assert.equal(premium.currentAttempt.attemptId, 41, 'Premium cannot replace the official current result');
  assert.ok(premium.premium.trend.length >= 2);
  assert.equal(premium.premium.criterionDynamics.length, 1);
  assert.equal(premium.premium.wordDynamics[0].label, 'weather');
  assert.equal(premium.premium.phonemeDynamics[0].count, 2);
  assert.equal(premium.premium.fluencyDynamics.length, 2);
  assert.equal(premium.premium.comparison.currentAttemptId, 41);
  assert.equal(premium.premium.comparison.basis, 'same_accent_locale_task_type_and_cefr');
  assert.equal(premium.premium.targetedPractice.taskType, 2);
  assert.equal(premium.premium.targetedPractice.excludeTaskRef, current.taskRef);
  assert.equal(premium.premium.targetedPractice.sourceAttemptId, current.attemptId);
  assert.deepEqual(premium.premium.targetedPractice.focus, {
    kind: 'phoneme', value: 'ð', anchorWord: 'weather', ref: 'phoneme.41.0.0',
  });
  assert.match(premium.premium.targetedPractice.contentRef,
    /:skill:ege\.speaking\.pronunciation_phonemes:focus:phoneme\.41\.0\.0:new:v1$/u);
  assert.ok(premium.premium.targetedPractice.suitableTaskRefs.length > 0);
  assert.ok(premium.premium.timeAllocationRecommendation.some((item) => (
    item.skillId === 'ege.speaking.pronunciation_phonemes'
      && item.focus?.value === 'ð'
  )));
  assert.ok(premium.premium.timeAllocationRecommendation.length > 0);
  assert.deepEqual(premium.premium.voiceTutor, {
    source: 'speaking', attemptId: 41, revision: 1,
    criterion: {
      index: 1, ref: 'task2.criterion.2', label: 'Вопрос 2', score: 0, maxScore: 1,
    },
    attemptSummary: {
      attemptId: 41, taskType: 2, score: 3, maxScore: 4,
      observedAt: '2026-08-07T08:01:00.000Z', accentLocale: 'en-GB',
    },
  });
});

test('Premium exposes the weakest exact pronunciation error even when every FIPI criterion is maxed', () => {
  const evidence = buildSpeakingLearningAttempt(attempt({ allRelevant: true, phonemeLabel: 'w' }));
  assert.equal(evidence.score, 4);
  assert.equal(evidence.maxScore, 4);
  assert.equal(evidence.criteria.every((criterion) => criterion.score === criterion.maxScore), true);

  const report = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
    now: new Date('2026-08-08T08:00:00.000Z'),
  });

  assert.equal(report.currentAttempt.score, 4, 'pronunciation coaching cannot lower the official score');
  assert.equal(report.currentAttempt.masteryEligible, true);
  assert.deepEqual(report.premium.voiceTutor, {
    source: 'speaking', attemptId: 41, revision: 1,
    pronunciationError: {
      ref: 'phoneme.41.0.0', kind: 'phoneme', label: 'Фонема /w/ в слове «weather»',
      word: 'weather', phoneme: 'w', accuracyScore: 48, expectedMinimum: 80,
      observedAt: '2026-08-07T08:01:00.000Z', accentLocale: 'en-GB',
      expiresAt: '2026-09-06T08:01:00.000Z',
    },
    attemptSummary: {
      attemptId: 41, taskType: 2, score: 4, maxScore: 4,
      observedAt: '2026-08-07T08:01:00.000Z', accentLocale: 'en-GB',
    },
  });
});

test('a persisted pronunciation target records a successful re-check and retires the exact old focus', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const initial = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const target = initial.premium.targetedPractice;
  const successfulRaw = structuredClone(attempt());
  successfulRaw.id = 42;
  successfulRaw.source_task_ref = target.suitableTaskRefs[0];
  successfulRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  successfulRaw.targeted_practice = {
    sourceAttemptId: target.sourceAttemptId, skillId: target.skillId, label: target.label,
    contentRef: target.contentRef, focus: target.focus,
  };
  successfulRaw.review.acousticFacts.wordEvents = [];
  successfulRaw.review.acousticFacts.targetMeasurement = {
    focusRef: target.focus.ref,
    kind: target.focus.kind,
    value: target.focus.value,
    anchorWord: target.focus.anchorWord,
    anchorObserved: true,
    score: 91,
  };
  const successful = buildSpeakingLearningAttempt(successfulRaw);
  assert.equal(successful.targetOutcome.status, 'resolved');
  assert.equal(successful.targetOutcome.sourceAttemptId, original.attemptId);
  assert.deepEqual(successful.targetOutcome.focus, target.focus);

  const report = buildSpeakingLearningReport([original, successful], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.ok(report.premium.targetOutcomes.some((outcome) => (
    outcome.status === 'resolved' && outcome.focus.ref === target.focus.ref
  )));
  assert.notEqual(report.premium.targetedPractice?.contentRef, target.contentRef,
    'a successful exact re-check must not keep assigning the retired pronunciation focus');
  const phoneme = report.premium.phonemeDynamics.find((item) => item.label === target.focus.value);
  assert.deepEqual({
    previousAccuracy: phoneme.previousAccuracy,
    currentAccuracy: phoneme.currentAccuracy,
    delta: phoneme.delta,
    direction: phoneme.direction,
  }, { previousAccuracy: 48, currentAccuracy: 91, delta: 43, direction: 'improved' });
});

test('a resolved criterion target is retired instead of receiving artificial 100 percent allocation', () => {
  const originalRaw = structuredClone(attempt());
  originalRaw.review.acousticFacts.wordEvents = [];
  const original = buildSpeakingLearningAttempt(originalRaw);
  const initial = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const target = initial.premium.targetedPractice;
  assert.equal(target.skillId, 'ege.speaking.direct_questions');
  assert.equal(target.focus, null);

  const resolvedRaw = structuredClone(attempt());
  resolvedRaw.id = 62;
  resolvedRaw.source_task_ref = target.suitableTaskRefs[0];
  resolvedRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  resolvedRaw.review.semanticFacts.items.forEach((item) => { item.relevant = true; });
  resolvedRaw.review.acousticFacts.wordEvents = [];
  const rescored = scoreSpeakingTask({
    taskType: 2,
    semantic: resolvedRaw.review.semanticFacts,
    acoustic: resolvedRaw.review.acousticFacts,
  });
  resolvedRaw.review = {
    ...publicSpeakingReview(rescored, resolvedRaw.review.semanticFacts),
    semanticFacts: resolvedRaw.review.semanticFacts,
    acousticFacts: resolvedRaw.review.acousticFacts,
  };
  resolvedRaw.targeted_practice = {
    sourceAttemptId: target.sourceAttemptId,
    skillId: target.skillId,
    label: target.label,
    contentRef: target.contentRef,
    focus: null,
  };
  const resolved = buildSpeakingLearningAttempt(resolvedRaw);
  assert.equal(resolved.targetOutcome.status, 'resolved');
  const report = buildSpeakingLearningReport([original, resolved], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.notEqual(report.premium.targetedPractice?.skillId, target.skillId);
  assert.equal(report.nextStep.reason, 'continue_official_practice');
  assert.equal(report.nextStep.skillId, null);
  assert.equal(report.nextStep.focus, null,
    'a mastered reliable history must not receive a false weakness or signal-quality fallback');
  assert.equal(report.premium.timeAllocationRecommendation.some((item) => (
    item.skillId === target.skillId
  )), false);
  assert.equal(report.premium.timeAllocationRecommendation.length, 0);
});

test('exact target measurements use the 80-point threshold for words and phonemes', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const cases = [
    {
      skillId: 'ege.speaking.pronunciation_words',
      focus: { kind: 'word', value: 'weather', anchorWord: 'weather', ref: 'word.41.0' },
      score: 79,
    },
    {
      skillId: 'ege.speaking.pronunciation_phonemes',
      focus: { kind: 'phoneme', value: 'ð', anchorWord: 'weather', ref: 'phoneme.41.0.0' },
      score: 48,
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const raw = structuredClone(attempt());
    raw.id = 50 + index;
    raw.review.acousticFacts.wordEvents = [];
    raw.review.acousticFacts.targetMeasurement = {
      focusRef: scenario.focus.ref,
      kind: scenario.focus.kind,
      value: scenario.focus.value,
      anchorWord: scenario.focus.anchorWord,
      anchorObserved: true,
      score: scenario.score,
    };
    raw.targeted_practice = {
      sourceAttemptId: original.attemptId,
      skillId: scenario.skillId,
      label: 'Точная проверка произношения',
      contentRef: `server:speaking:task:2:skill:${scenario.skillId}:focus:${scenario.focus.ref}:new:v1`,
      focus: scenario.focus,
    };
    const result = buildSpeakingLearningAttempt(raw);
    assert.equal(result.targetOutcome.status, 'still_needs_work');
    assert.equal(result.targetOutcome.score, scenario.score);
  }
});

test('a pronunciation target without an exact trusted measurement is inconclusive even when transcript contains it', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const target = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice;
  const raw = structuredClone(attempt());
  raw.id = 60;
  raw.review.acousticFacts.wordEvents = [];
  raw.targeted_practice = {
    sourceAttemptId: target.sourceAttemptId, skillId: target.skillId, label: target.label,
    contentRef: target.contentRef, focus: target.focus,
  };
  const result = buildSpeakingLearningAttempt(raw);
  assert.match(result.transcript, /weather/iu);
  assert.equal(result.targetOutcome.status, 'inconclusive');
  assert.equal(result.targetOutcome.score, null);
});

test('an observed anchor without the exact target phoneme score remains inconclusive', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const focus = { kind: 'phoneme', value: 'ð', anchorWord: 'weather', ref: 'phoneme.41.0.0' };
  const raw = structuredClone(attempt());
  raw.id = 61;
  raw.review.acousticFacts.wordEvents = [];
  raw.review.acousticFacts.targetMeasurement = {
    focusRef: focus.ref, kind: focus.kind, value: focus.value, anchorWord: focus.anchorWord,
    anchorObserved: true, score: null,
  };
  raw.targeted_practice = {
    sourceAttemptId: original.attemptId,
    skillId: 'ege.speaking.pronunciation_phonemes',
    label: 'Точная проверка фонемы',
    contentRef: 'server:speaking:task:2:skill:ege.speaking.pronunciation_phonemes:focus:phoneme.41.0.0:new:v1',
    focus,
  };
  const result = buildSpeakingLearningAttempt(raw);
  assert.equal(result.targetOutcome.status, 'inconclusive');
  assert.equal(result.targetOutcome.score, null);
});

test('a targeted pronunciation retry stays inconclusive when the anchor was not uttered', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const target = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice;
  const omittedRaw = structuredClone(attempt());
  omittedRaw.id = 42;
  omittedRaw.source_task_ref = target.suitableTaskRefs[0];
  omittedRaw.transcript = 'When does the course begin? How much does it cost?';
  omittedRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  omittedRaw.targeted_practice = {
    sourceAttemptId: target.sourceAttemptId, skillId: target.skillId, label: target.label,
    contentRef: target.contentRef, focus: target.focus,
  };
  omittedRaw.review.acousticFacts.wordEvents = [];

  const omitted = buildSpeakingLearningAttempt(omittedRaw);
  assert.equal(omitted.masteryEligible, true);
  assert.equal(omitted.targetOutcome.status, 'inconclusive');
  assert.equal(omitted.targetOutcome.score, null);

  const report = buildSpeakingLearningReport([original, omitted], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.premium.targetedPractice.contentRef, target.contentRef,
    'an unuttered anchor must remain available for another exact check');
});

test('an arbitrary pronunciation focus is reported as unavailable instead of silently disappearing', () => {
  const raw = structuredClone(attempt());
  raw.id = 43;
  raw.review.acousticFacts.wordEvents = [{
    id: 'azure:rare:1', owner: 'azure_pronunciation', type: 'mispronunciation', gross: false,
    itemIndex: 2, accuracyScore: 8, start: 10, end: 20, word: 'quasarxyz',
    phonemes: [{ label: 'ʒ', accuracyScore: 5 }],
  }];
  const evidence = buildSpeakingLearningAttempt(raw);
  const report = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.nextStep.reason, 'focus_material_unavailable');
  assert.ok(report.premium.unavailableTargets.some((target) => (
    target.focus.anchorWord === 'quasarxyz' && target.reason === 'no_server_owned_focus_material'
  )));
  assert.ok(report.premium.personalSummary.unavailableTargetCount > 0);
});

test('pronunciation material search ignores hidden provenance such as the Easy Boost author', () => {
  const raw = structuredClone(attempt());
  raw.review.acousticFacts.wordEvents[0] = {
    ...raw.review.acousticFacts.wordEvents[0],
    word: 'Boost', accuracyScore: 25, phonemes: [],
  };
  const evidence = buildSpeakingLearningAttempt(raw);
  const report = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const hiddenMetadataTarget = report.premium.unavailableTargets.find((item) => (
    item.focus?.kind === 'word' && item.focus.value.toLocaleLowerCase('en') === 'boost'
  ));
  assert.ok(hiddenMetadataTarget);
  assert.equal(hiddenMetadataTarget.reason, 'no_server_owned_focus_material');
  assert.notEqual(report.premium.targetedPractice?.focus?.value.toLocaleLowerCase('en'), 'boost');
});

test('a resolved pronunciation target stays retired across attempt-specific provider references', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const target = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice;
  const resolvedRaw = structuredClone(attempt());
  resolvedRaw.id = 42;
  resolvedRaw.source_task_ref = target.suitableTaskRefs[0];
  resolvedRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  resolvedRaw.review.acousticFacts.targetMeasurement = {
    focusRef: target.focus.ref, kind: target.focus.kind, value: target.focus.value,
    anchorWord: target.focus.anchorWord, anchorObserved: true, score: 85,
  };
  resolvedRaw.targeted_practice = {
    sourceAttemptId: target.sourceAttemptId, skillId: target.skillId, label: target.label,
    contentRef: target.contentRef, focus: target.focus,
  };
  const resolved = buildSpeakingLearningAttempt(resolvedRaw);
  assert.equal(resolved.targetOutcome.status, 'resolved');

  const laterRaw = structuredClone(attempt());
  laterRaw.id = 43;
  laterRaw.evaluated_at = '2026-08-09T08:01:00.000Z';
  laterRaw.review.acousticFacts.wordEvents[0] = {
    ...laterRaw.review.acousticFacts.wordEvents[0],
    id: 'azure:later:technology', word: target.focus.anchorWord, accuracyScore: 85,
    phonemes: [{ label: target.focus.value, accuracyScore: 85 }],
  };
  const later = buildSpeakingLearningAttempt(laterRaw);
  const report = buildSpeakingLearningReport([original, resolved, later], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const sameIdentity = (item) => item.focus?.kind === target.focus.kind
    && item.focus?.value === target.focus.value
    && item.focus?.anchorWord === target.focus.anchorWord;
  assert.equal(sameIdentity(report.premium.targetedPractice || {}), false);
  assert.equal(report.premium.unavailableTargets.some(sameIdentity), false);
});

test('phoneme observations at or above 80 stay in dynamics but never become targeted practice', () => {
  const raw = structuredClone(attempt());
  raw.review.acousticFacts.wordEvents[0].accuracyScore = 95;
  raw.review.acousticFacts.wordEvents[0].phonemes = [{ label: 'w', accuracyScore: 85 }];
  const report = buildSpeakingLearningReport([buildSpeakingLearningAttempt(raw)], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.ok(report.premium.phonemeDynamics.some((item) => item.label === 'w' && item.currentAccuracy === 85));
  assert.notEqual(report.premium.targetedPractice?.focus?.value, 'w');
  assert.equal(report.premium.unavailableTargets.some((item) => item.focus?.value === 'w'), false);
  assert.equal(report.premium.timeAllocationRecommendation.some((item) => (
    item.focus?.kind === 'phoneme' && item.focus?.value === 'w'
  )), false);
});

test('Base exposes a bounded attempt timeline and an empty history still has a next step', () => {
  const empty = buildSpeakingLearningReport([], {
    quota: { tier: 'base', limitSeconds: 3_600, remainingSeconds: 3_600 },
  });
  assert.equal(empty.currentAttempt, null);
  assert.equal(empty.nextStep.reason, 'start_official_attempt');
  assert.deepEqual(empty.attemptTimeline, []);

  const attempts = Array.from({ length: 140 }, (_, index) => buildSpeakingLearningAttempt({
    ...attempt(), id: index + 1,
    evaluated_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const report = buildSpeakingLearningReport(attempts, {
    quota: { tier: 'base', limitSeconds: 3_600, remainingSeconds: 3_600 },
  });
  assert.equal(report.attemptTimeline.length, 120);
  assert.deepEqual(Object.keys(report.attemptTimeline[0]).sort(), [
    'attemptId', 'masteryEligible', 'maxScore', 'observedAt', 'score', 'status', 'taskType',
  ]);
  assert.equal(report.premium, null);
});

test('a valid Premium target pointer cannot unlock targeted practice for Base', () => {
  const evidence = buildSpeakingLearningAttempt(attempt());
  const target = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice;
  assert.throws(() => speakingTargetedPracticeAssignment([evidence], target, target.taskType, {
    tier: 'base',
  }), /SPEAKING_TARGETED_PRACTICE_STALE/u);
  assert.equal(speakingTargetedPracticeAssignment([evidence], target, target.taskType, {
    tier: 'premium',
  }).selectionReason, 'targeted_focus');
});

test('any newer evaluated attempt invalidates an older Premium targeted-practice report revision', () => {
  const evidence = buildSpeakingLearningAttempt(attempt());
  const target = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice;
  assert.ok(target.reportRevision);
  const technical = buildSpeakingLearningAttempt({
    ...attempt({ status: 'needs_retry' }), id: 42,
    evaluated_at: '2026-08-08T08:01:00.000Z',
  });
  assert.throws(() => speakingTargetedPracticeAssignment(
    [evidence, technical], target, target.taskType, { tier: 'premium' },
  ), /SPEAKING_TARGETED_PRACTICE_STALE/u);
});

test('Premium target outcomes include bounded inconclusive assisted and technical re-checks', () => {
  const original = buildSpeakingLearningAttempt(attempt());
  const target = buildSpeakingLearningReport([original], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  }).premium.targetedPractice;
  const assistedRaw = structuredClone(attempt({ assisted: true }));
  assistedRaw.id = 42;
  assistedRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  assistedRaw.targeted_practice = target;
  const technicalRaw = structuredClone(attempt({ status: 'needs_retry' }));
  technicalRaw.id = 43;
  technicalRaw.evaluated_at = '2026-08-09T08:01:00.000Z';
  technicalRaw.targeted_practice = target;
  const report = buildSpeakingLearningReport([
    original,
    buildSpeakingLearningAttempt(assistedRaw),
    buildSpeakingLearningAttempt(technicalRaw),
  ], { quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 } });
  assert.deepEqual(report.premium.targetOutcomes.map((item) => [item.evaluatedAttemptId, item.status]), [
    [42, 'inconclusive'], [43, 'inconclusive'],
  ]);
  assert.equal(report.premium.trend.some((item) => item.attemptId === 42 || item.attemptId === 43), false);
});

test('Base report stays bounded when pronunciation evidence contains thousands of unique candidates', () => {
  const attempts = Array.from({ length: 40 }, (_, index) => {
    const evidence = buildSpeakingLearningAttempt({
      ...attempt(), id: index + 1,
      evaluated_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
    evidence.wordIssues = Array.from({ length: 100 }, (_, issueIndex) => ({
      id: `base-rare-${index}-${issueIndex}`, word: `basequasar${index}x${issueIndex}`,
      errorType: 'mispronunciation', itemIndex: 1, accuracyScore: 10, gross: false,
      phonemes: [{ label: `q${issueIndex}`, accuracyScore: 10 }],
    }));
    return evidence;
  });
  const startedAt = performance.now();
  const report = buildSpeakingLearningReport(attempts, {
    quota: { tier: 'base', limitSeconds: 3_600, remainingSeconds: 3_600 },
  });
  assert.ok(performance.now() - startedAt < 250,
    'Base must not perform Premium catalog target mining');
  assert.equal(report.premium, null);
  assert.equal(report.nextStep.focus, null);
});

test('unavailable target count is capped to the documented public maximum', () => {
  const attempts = Array.from({ length: 120 }, (_, index) => {
    const evidence = buildSpeakingLearningAttempt({
      ...attempt(), id: index + 1,
      evaluated_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
    evidence.wordIssues = Array.from({ length: 3 }, (_, issueIndex) => ({
      id: `rare-${index}-${issueIndex}`, word: `quasarxyz${index}x${issueIndex}`,
      errorType: 'mispronunciation', itemIndex: 1, accuracyScore: 10, gross: false,
      phonemes: [],
    }));
    return evidence;
  });
  const report = buildSpeakingLearningReport(attempts, {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.premium.personalSummary.unavailableTargetCount, 240);
  assert.equal(report.premium.unavailableTargets.length, 20);
});

test('Premium dynamics use only reliable scored attempts while the latest technical result stays visible', () => {
  const older = buildSpeakingLearningAttempt({
    ...attempt(), id: 39, source_task_ref: 'speaking-pilot-v1.task2.indoor-climbing',
    evaluated_at: '2026-08-01T08:01:00.000Z',
  });
  const reliable = buildSpeakingLearningAttempt({
    ...attempt(), id: 40, source_task_ref: 'speaking-pilot-v1.task2.weekend-pottery',
    evaluated_at: '2026-08-02T08:01:00.000Z',
  });
  const assisted = buildSpeakingLearningAttempt({
    ...attempt({ assisted: true }), id: 41, source_task_ref: 'speaking-pilot-v1.task2.young-film-camp',
    evaluated_at: '2026-08-03T08:01:00.000Z',
  });
  const technical = buildSpeakingLearningAttempt({
    ...attempt({ status: 'needs_retry' }), id: 42,
    source_task_ref: 'speaking-pilot-v1.task2.world-cooking-studio',
    evaluated_at: '2026-08-04T08:01:00.000Z',
  });
  const report = buildSpeakingLearningReport([older, reliable, assisted, technical], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.currentAttempt.attemptId, 42);
  assert.equal(report.currentAttempt.status, 'needs_retry');
  assert.deepEqual(report.premium.trend.map((item) => item.attemptId), [39, 40]);
  assert.equal(report.premium.comparison.currentAttemptId, 40);
  assert.equal(report.premium.comparison.previousAttemptId, 39);
  assert.equal(report.premium.criterionDynamics.every((series) => (
    series.points.every((point) => point.attemptId === 39 || point.attemptId === 40)
  )), true);
  assert.equal(report.premium.voiceTutor.attemptId, 40);
  assert.equal(report.premium.voiceTutor.attemptSummary.attemptId, 40);
  assert.equal(report.premium.voiceTutor.criterion.ref, 'task2.criterion.2');
  assert.equal(report.premium.voiceTutor.criterion.label, reliable.criteria[1].name);
  assert.notEqual(report.premium.voiceTutor.attemptId, report.currentAttempt.attemptId,
    'a newer technical attempt cannot hide or relabel the latest reliable error');
});

test('pause events stay separate from pronunciation mastery and form bounded Base/Premium dynamics', () => {
  const raw = structuredClone(attempt({ accentLocale: 'en-US' }));
  raw.review.acousticFacts.pauseAnalysisAvailable = true;
  raw.review.acousticFacts.wordEvents = [
    {
      id: 'azure:pause:1', owner: 'azure_pronunciation', type: 'unexpected_break', gross: null,
      itemIndex: 1, accuracyScore: null, start: 0, end: 7, word: 'weather', phonemes: [],
      offsetSeconds: 1.2, durationSeconds: 0.8,
    },
    {
      id: 'azure:pause:2', owner: 'azure_pronunciation', type: 'missing_break', gross: null,
      itemIndex: 2, accuracyScore: null, start: 8, end: 12, word: 'today', phonemes: [],
      offsetSeconds: 2.4, durationSeconds: 0.3,
    },
  ];
  const evidence = buildSpeakingLearningAttempt(raw);
  assert.equal(evidence.status, 'scored');
  assert.deepEqual(evidence.wordIssues, []);
  assert.deepEqual(evidence.signal.pauseAnalysis, {
    available: true,
    reason: null,
    fluencyProxyAvailable: true,
    totalCount: 2,
    unexpectedBreakCount: 1,
    missingBreakCount: 1,
    events: [
      {
        id: 'azure:pause:1', type: 'unexpected_break', itemIndex: 1, word: 'weather',
        offsetSeconds: 1.2, durationSeconds: 0.8,
      },
      {
        id: 'azure:pause:2', type: 'missing_break', itemIndex: 2, word: 'today',
        offsetSeconds: 2.4, durationSeconds: 0.3,
      },
    ],
  });
  const report = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.deepEqual(report.premium.pauseDynamics, [{
    attemptId: 41, observedAt: '2026-08-07T08:01:00.000Z', available: true,
    reason: null, fluencyScore: 86, totalCount: 2, unexpectedBreakCount: 1,
    missingBreakCount: 1, accentLocale: 'en-US', basis: 'accent_locale',
  }]);

  const zeroRaw = structuredClone(raw);
  zeroRaw.id = 42;
  zeroRaw.evaluated_at = '2026-08-08T08:01:00.000Z';
  zeroRaw.review.acousticFacts.wordEvents = [];
  const zero = buildSpeakingLearningAttempt(zeroRaw);
  assert.deepEqual(zero.signal.pauseAnalysis, {
    available: true,
    reason: null,
    fluencyProxyAvailable: true,
    totalCount: 0,
    unexpectedBreakCount: 0,
    missingBreakCount: 0,
    events: [],
  });
  const improving = buildSpeakingLearningReport([evidence, zero], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
    activeAccentLocale: 'en-US',
  });
  assert.deepEqual(
    improving.premium.pauseDynamics.map((point) => ({ available: point.available, total: point.totalCount })),
    [{ available: true, total: 2 }, { available: true, total: 0 }],
  );
});

test('Premium criterion targets and longitudinal dynamics never cross accent locales', () => {
  const raw = ({ id, locale, observedAt }) => {
    const value = structuredClone(attempt({ accentLocale: locale }));
    value.id = id;
    value.evaluated_at = observedAt;
    value.review.acousticFacts.wordEvents = [];
    value.review.acousticFacts.wordAccuracyScore = 100;
    value.review.acousticFacts.phonemeAccuracyScore = 100;
    return value;
  };
  const gbOlder = buildSpeakingLearningAttempt(raw({
    id: 51, locale: 'en-GB', observedAt: '2026-08-01T08:01:00.000Z',
  }));
  const initial = buildSpeakingLearningReport([gbOlder], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const target = initial.premium.targetedPractice;
  assert.equal(target.skillId, 'ege.speaking.direct_questions');
  assert.equal(target.accentLocale, 'en-GB');

  const usResolutionRaw = raw({
    id: 52, locale: 'en-US', observedAt: '2026-08-02T08:01:00.000Z',
  });
  usResolutionRaw.targeted_practice = target;
  const usResolution = buildSpeakingLearningAttempt(usResolutionRaw);
  assert.equal(usResolution.targetOutcome.status, 'inconclusive');

  const gbCurrent = buildSpeakingLearningAttempt(raw({
    id: 53, locale: 'en-GB', observedAt: '2026-08-03T08:01:00.000Z',
  }));
  const report = buildSpeakingLearningReport([gbOlder, usResolution, gbCurrent], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.premium.targetedPractice.accentLocale, 'en-GB',
    'an en-US outcome cannot retire an en-GB criterion target');
  assert.equal(report.premium.comparison.previousAttemptId, 51,
    'the en-GB current attempt must skip the newer en-US attempt');
  assert.equal(report.premium.comparison.accentLocale, 'en-GB');
  assert.equal(report.premium.comparison.basis, 'same_accent_locale_task_type_and_cefr');
  const criterionSeries = report.premium.criterionDynamics.filter((series) => (
    series.skillId === 'ege.speaking.direct_questions'
  ));
  assert.deepEqual(criterionSeries.map((series) => series.accentLocale).sort(), ['en-GB', 'en-US']);
  assert.ok(criterionSeries.every((series) => (
    series.basis === 'same_accent_locale'
      && series.points.every((point) => point.accentLocale === series.accentLocale)
  )));
  assert.deepEqual(report.premium.trend.map((point) => point.accentLocale), ['en-GB', 'en-US', 'en-GB']);
  assert.ok(report.premium.trend.every((point) => point.basis === 'accent_locale'));
  assert.ok(report.premium.fluencyDynamics.every((point) => (
    point.basis === 'accent_locale' && ['en-GB', 'en-US'].includes(point.accentLocale)
  )));
  assert.ok(report.premium.pauseDynamics.every((point) => (
    point.basis === 'accent_locale' && ['en-GB', 'en-US'].includes(point.accentLocale)
  )));
  assert.equal(report.premium.personalSummary.currentReliableAccentLocale, 'en-GB');

  const usScoped = buildSpeakingLearningReport([gbOlder, usResolution, gbCurrent], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
    activeAccentLocale: 'en-US',
  });
  assert.equal(usScoped.activeAccentLocale, 'en-US');
  assert.equal(usScoped.premium.targetedPractice.accentLocale, 'en-US');
  assert.ok(usScoped.premium.timeAllocationRecommendation.every((item) => (
    item.accentLocale === 'en-US'
  )));
  assert.deepEqual(usScoped.premium.trend.map((point) => point.accentLocale), ['en-US']);
  assert.ok(usScoped.premium.criterionDynamics.every((series) => series.accentLocale === 'en-US'));
  assert.equal(usScoped.premium.comparison.accentLocale, 'en-US');
});

test('Premium criterion dynamics aggregate one point per skill and source attempt', () => {
  const attempts = Array.from({ length: 120 }, (_, index) => buildSpeakingLearningAttempt({
    ...attempt(),
    id: index + 1,
    evaluated_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  const report = buildSpeakingLearningReport(attempts, {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  const directQuestions = report.premium.criterionDynamics.find((series) => (
    series.skillId === 'ege.speaking.direct_questions'
  ));
  assert.equal(directQuestions.points.length, 120);
  assert.equal(new Set(directQuestions.points.map((point) => point.attemptId)).size, 120);
  assert.ok(directQuestions.points.every((point) => point.maxScore === 4));
});

test('Premium word and phoneme issue counts measure affected attempts, not duplicate events', () => {
  const attempts = [1, 2].map((id) => ({
    ...buildSpeakingLearningAttempt({
      ...attempt(), id, evaluated_at: `2026-08-0${id}T08:01:00.000Z`,
    }),
    wordIssues: Array.from({ length: 120 }, (_, wordIndex) => ({
      id: `word-${id}-${wordIndex}`,
      word: 'weather',
      errorType: 'mispronunciation',
      itemIndex: 1,
      accuracyScore: id === 1 ? 20 : 80,
      gross: false,
      phonemes: Array.from({ length: 20 }, () => ({
        label: 'ð', accuracyScore: id === 1 ? 80 : 20,
      })),
    })),
  }));
  const report = buildSpeakingLearningReport(attempts, {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.deepEqual(report.premium.wordDynamics[0], {
    label: 'weather', accentLocale: 'en-GB', count: 2, averageAccuracy: 50,
    previousAccuracy: 20, currentAccuracy: 80, delta: 60, direction: 'improved',
    points: [
      { attemptId: 1, observedAt: '2026-08-01T08:01:00.000Z', accuracyScore: 20 },
      { attemptId: 2, observedAt: '2026-08-02T08:01:00.000Z', accuracyScore: 80 },
    ],
  });
  assert.deepEqual(report.premium.phonemeDynamics[0], {
    label: 'ð', accentLocale: 'en-GB', count: 2, averageAccuracy: 50,
    previousAccuracy: 80, currentAccuracy: 20, delta: -60, direction: 'declined',
    points: [
      { attemptId: 1, observedAt: '2026-08-01T08:01:00.000Z', accuracyScore: 80 },
      { attemptId: 2, observedAt: '2026-08-02T08:01:00.000Z', accuracyScore: 20 },
    ],
  });
  assert.ok([...report.premium.wordDynamics, ...report.premium.phonemeDynamics]
    .every((item) => item.count <= 120));
});

test('Task 4 validated vocabulary errors can independently target spoken lexis', () => {
  const semanticFacts = {
    confidence: 0.95,
    verdict: 'Ответ можно оценить.',
    evidence: ['Все пункты плана раскрыты.'],
    issues: Array.from({ length: 4 }, (_, index) => ({
      id: `lexis-choice-${index + 1}`, owner: 'language', code: 'language_vocabulary',
      evidence: `awkward phrase ${index + 1}`, correction: `natural phrase ${index + 1}`,
    })),
    phraseCount: 13,
    wordList: false,
    introductionPresent: true,
    conclusionPresent: true,
    contentAspects: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, id: `content-${index + 1}`, start: 0, end: 0,
      status: 'full', evidence: `Point ${index + 1}`, correction: 'No correction.',
    })),
    organizationErrors: [],
    lexicalGrammarErrors: Array.from({ length: 4 }, (_, index) => ({
      id: `lexis-choice-${index + 1}`, start: 5 + index * 10, end: 13 + index * 10,
      evidence: `awkward phrase ${index + 1}`, correction: `natural phrase ${index + 1}`, gross: false,
    })),
  };
  const acousticFacts = {
    available: true,
    recognitionConfidence: 0.96,
    signalQuality: 'good',
    recordingDurationSeconds: 80,
    itemDurations: [],
    wordAccuracyScore: 95,
    phonemeAccuracyScore: 94,
    fluencyScore: 88,
    wordEvents: [],
  };
  const review = publicSpeakingReview(
    scoreSpeakingTask({ taskType: 4, semantic: semanticFacts, acoustic: acousticFacts }),
    semanticFacts,
  );
  const evidence = buildSpeakingLearningAttempt({
    ...attempt(),
    id: 77,
    task_type: 4,
    source_task_ref: 'speaking-pilot-v1.task4.city-transport',
    transcript: 'I do sport and compare the photographs.',
    review: { ...review, semanticFacts, acousticFacts },
  });
  assert.deepEqual(evidence.languageDiagnostics.map((item) => item.skillId), [
    'ege.speaking.spoken_lexis',
  ]);
  const adaptive = speakingAdaptiveEvidenceAttempts([evidence]);
  assert.ok(adaptive.some((row) => row.metadata.skill_id === 'ege.speaking.spoken_lexis'));
  assert.equal(adaptive.some((row) => row.metadata.skill_id === 'ege.speaking.spoken_grammar'), false);
  const report = buildSpeakingLearningReport([evidence], {
    quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
  });
  assert.equal(report.nextStep.skillId, 'ege.speaking.spoken_lexis');
  assert.equal(report.premium.targetedPractice.skillId, 'ege.speaking.spoken_lexis');
});

test('Task 4 unlinked language feedback cannot publish false grammar or lexis mastery', () => {
  const semanticFacts = {
    confidence: 0.95,
    verdict: 'Ответ можно оценить.',
    evidence: ['Все пункты плана раскрыты.'],
    issues: [{
      id: 'unlinked-grammar', owner: 'language', code: 'language_grammar',
      evidence: 'has went', correction: 'has gone',
    }],
    phraseCount: 13,
    wordList: false,
    introductionPresent: true,
    conclusionPresent: true,
    contentAspects: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, id: `content-full-${index + 1}`, start: 0, end: 0,
      status: 'full', evidence: `Point ${index + 1}`, correction: 'No correction.',
    })),
    organizationErrors: [],
    lexicalGrammarErrors: [],
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.96, signalQuality: 'good',
    recordingDurationSeconds: 80, itemDurations: [], wordAccuracyScore: 96,
    phonemeAccuracyScore: 95, fluencyScore: 90, wordEvents: [],
  };
  const review = publicSpeakingReview(
    scoreSpeakingTask({ taskType: 4, semantic: semanticFacts, acoustic: acousticFacts }),
    semanticFacts,
  );
  const evidence = buildSpeakingLearningAttempt({
    ...attempt(), id: 78, task_type: 4,
    source_task_ref: 'speaking-pilot-v1.task4.weather-day-plans',
    review: { ...review, semanticFacts, acousticFacts },
  });
  assert.deepEqual(evidence.languageDiagnostics, []);
  const adaptive = speakingAdaptiveEvidenceAttempts([evidence]);
  assert.equal(adaptive.some((row) => [
    'ege.speaking.spoken_grammar', 'ege.speaking.spoken_lexis',
  ].includes(row.metadata.skill_id)), false);
});
