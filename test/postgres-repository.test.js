import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import pg from 'pg';
import { createPostgresRepository } from '../storage/postgres-repository.js';
import { buildGrammarLexiconCapsule, buildWritingSpeakingCapsule, createGrammarLexiconErrorAttempt, persistedVoiceTutorCapsule } from '../voice-tutor/capsule.js';
import { rebuildSourceCapsule } from '../routes/voice-tutor.js';
import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import { adaptivePlanInputFingerprint, buildAdaptiveLearningPlan } from '../adaptive-learning/plan.js';
import { adaptiveLearningProfilePublicDto } from '../adaptive-learning/repository-dto.js';
import {
  applyAdaptiveRetentionState,
  buildAdaptiveRetentionState,
} from '../adaptive-learning/retention.js';
import {
  ADAPTIVE_ACTIVITY_REGISTRY,
  buildAdaptiveSessionPreview,
  createAdaptiveLearningSessionFromPreview,
} from '../adaptive-learning/session.js';
import {
  ADAPTIVE_EXECUTION_CLAIM_TTL_MS,
  adaptiveEvidenceContext,
  adaptiveExecutionRequestHash,
  adaptiveExecutionToken,
  adaptiveExecutionTokenHash,
} from '../adaptive-learning/session-execution.js';
import {
  assertAdaptiveProfileAppendOnlyOrdering,
  assertAdaptiveProfileRejectsStale,
  assertAdaptiveProfileRepositoryContract,
} from './support/adaptive-profile-contract.js';
import { assertAdaptiveGoalRepositoryContract } from './support/adaptive-goal-contract.js';
import { assertAdaptiveDiagnosticRepositoryContract } from './support/adaptive-diagnostic-contract.js';
import { assertAdaptivePlanRepositoryContract } from './support/adaptive-plan-contract.js';
import { assertAdaptiveSessionRepositoryContract } from './support/adaptive-session-contract.js';
import { assertWordProgressRepositoryContract } from './support/word-progress-contract.js';
import { assertPersonalWordsProgressRepositoryContract } from './support/personal-words-progress-contract.js';
import { assertVocabularyAttemptRepositoryContract } from './support/vocabulary-attempt-contract.js';
import { assertReadingReportRepositoryContract } from './support/reading-report-contract.js';
import { assertSpeakingTask2SessionRepositoryContract } from './support/speaking-task2-session-contract.js';
import { assertSpeakingTask3SessionRepositoryContract } from './support/speaking-task3-session-contract.js';
import { assertSpeakingTask4SessionRepositoryContract } from './support/speaking-task4-session-contract.js';
import { assertFullSpeakingSessionRepositoryContract } from './support/speaking-full-session-contract.js';
import { assertSpeakingAssessmentQuotaContract } from './support/speaking-assessment-quota-contract.js';
import { assertSpeakingAccentCalibrationRepositoryContract } from './support/speaking-accent-calibration-contract.js';
import { assertGrammarMasteryProgressContract } from './support/grammar-mastery-progress-contract.js';
import { assertEgeMockAttemptRepositoryContract } from './support/ege-mock-attempt-contract.js';
import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { speakingCalibrationSampleMaterial } from './support/speaking-calibration-fixture.js';
import { buildSpeakingLearningReport } from '../speaking/learning-loop.js';
import { publicSpeakingReview, scoreSpeakingTask } from '../speaking/fipi-scoring.js';
import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';

const SPEAKING_CATALOGS = [
  SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
  SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
];

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL EGE mock attempts match the shared lifecycle, concurrency, export and deletion contract', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  try { await assertEgeMockAttemptRepositoryContract(assert, repository, 92_603_000); }
  finally { await repository.close(); }
});

test('PostgreSQL EGE mock persists deadline reconciliation when a late draft is rejected', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  const telegramId = 92_603_020;
  let username;
  try {
    await raw.connect();
    username = await repository.createTelegramUser(telegramId, 'EGE mock deadline authority');
    await repository.grantDays(telegramId, 45, 'EGE mock deadline authority');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: crypto.randomUUID(), requestHash: 'b'.repeat(64),
    });
    await raw.query(
      `UPDATE ege_mock_attempts
       SET written_started_at = transaction_timestamp() - INTERVAL '190 minutes',
           written_deadline_at = transaction_timestamp()
       WHERE username = $1 AND id = $2`,
      [username, started.attempt.id],
    );

    await assert.rejects(repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0, answers: { 19: 'late' },
      idempotencyKey: crypto.randomUUID(), requestHash: 'c'.repeat(64),
    }), { code: 'EGE_MOCK_WRITTEN_CLOSED' });
    const persisted = await raw.query(
      'SELECT state, revision, written_receipt FROM ege_mock_attempts WHERE id = $1',
      [started.attempt.id],
    );
    assert.equal(persisted.rows[0].state, 'oral_ready');
    assert.equal(persisted.rows[0].revision, 1);
    assert.equal(persisted.rows[0].written_receipt.automatic, true);
    assert.match(persisted.rows[0].written_receipt.payloadDigest, /^sha256:[a-f0-9]{64}$/u);

    await raw.query(
      `UPDATE ege_mock_attempts
       SET state = 'written_in_progress', revision = 0,
           written_started_at = transaction_timestamp() - INTERVAL '190 minutes',
           written_deadline_at = transaction_timestamp(), written_submitted_at = NULL,
           written_receipt = NULL, oral_available_until = NULL
       WHERE username = $1 AND id = $2`,
      [username, started.attempt.id],
    );
    const exported = await repository.exportUserData(username);
    assert.equal(exported.ege_mock_attempts[0].state, 'oral_ready');
    assert.match(exported.ege_mock_attempts[0].written_receipt.payloadDigest,
      /^sha256:[a-f0-9]{64}$/u);
  } finally {
    if (username) await repository.deleteUserData(username).catch(() => {});
    await raw.end().catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL module evidence writer shares the profile owner lock and rejects a stale snapshot', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const lockPool = new pg.Pool({ connectionString });
  const suffix = `${Date.now()}`.slice(-8);
  const username = await repository.createTelegramUser(Number(`89${suffix}`), `Module CAS ${suffix}`);
  const staleProfile = buildAdaptiveLearningProfile(
    await repository.getAdaptiveLearningEvidenceSources(username),
  );
  const locker = await lockPool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
    let settled = false;
    const writing = repository.recordModuleAttempt(username, {
      id: crypto.randomUUID(), module: 'exam', activity: 'grammar_19_24',
      score: 5, maxScore: 6, durationMs: 45_000, metadata: { source: 'builtin' },
    }, { evidenceQuality: 'server_verified_unassisted' }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(settled, false, 'the evidence writer must wait for the profile owner lock');
    await locker.query('COMMIT');
    await writing;
    await assert.rejects(repository.saveAdaptiveLearningProfile(username, staleProfile, {
      now: new Date('2026-08-07T11:00:00.000Z'), verifyCurrentEvidence: true,
    }), /ADAPTIVE_PROFILE_EVIDENCE_STALE/u);
  } finally {
    try { await locker.query('ROLLBACK'); } catch {}
    locker.release();
    await lockPool.end();
    await repository.close();
  }
});

test('PostgreSQL fingerprint CAS persists a same-time assistance downgrade and rejects stale mastery', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  const suffix = `${Date.now()}`.slice(-8);
  const username = await repository.createTelegramUser(Number(`88${suffix}`), `Fingerprint CAS ${suffix}`);
  await raw.connect();
  try {
    const attemptId = crypto.randomUUID();
    await repository.recordModuleAttempt(username, {
      id: attemptId, module: 'exam', activity: 'grammar_19_24', score: 6, maxScore: 6,
      durationMs: 45_000, metadata: { source: 'builtin' },
    }, { evidenceQuality: 'server_verified_unassisted' });
    const independent = buildAdaptiveLearningProfile(
      await repository.getAdaptiveLearningEvidenceSources(username),
    );
    const storedIndependent = await repository.saveAdaptiveLearningProfile(username, independent, {
      verifyCurrentEvidence: true,
    });
    assert.equal(storedIndependent.evidence_fingerprint, independent.evidenceFingerprint);
    assert.ok(Number(storedIndependent.independent_evidence_count) > 0);
    await raw.query(
      'UPDATE adaptive_learning_profiles SET evidence_fingerprint = NULL WHERE username = $1',
      [username],
    );
    assert.equal((await repository.getAdaptiveLearningProfile(username)).evidence_fingerprint, null,
      'migration 051 keeps legacy rows readable while their fingerprint is absent');
    const repairedLegacy = await repository.saveAdaptiveLearningProfile(username, independent, {
      verifyCurrentEvidence: true,
    });
    assert.equal(repairedLegacy.evidence_fingerprint, independent.evidenceFingerprint);

    await raw.query(
      `UPDATE module_attempts SET evidence_quality = 'server_verified_assisted'
       WHERE username = $1 AND id = $2`,
      [username, attemptId],
    );
    const assisted = buildAdaptiveLearningProfile(
      await repository.getAdaptiveLearningEvidenceSources(username),
    );
    assert.equal(assisted.evidenceSourceCount, independent.evidenceSourceCount);
    assert.equal(assisted.evidenceObservedAt, independent.evidenceObservedAt);
    assert.notEqual(assisted.evidenceFingerprint, independent.evidenceFingerprint);

    const storedAssisted = await repository.saveAdaptiveLearningProfile(username, assisted, {
      verifyCurrentEvidence: true,
    });
    assert.equal(Number(storedAssisted.independent_evidence_count), 0);
    assert.ok(Number(storedAssisted.assisted_evidence_count) > 0);
    assert.equal(storedAssisted.evidence_fingerprint, assisted.evidenceFingerprint);
    await assert.rejects(repository.saveAdaptiveLearningProfile(username, independent, {
      verifyCurrentEvidence: true,
    }), /ADAPTIVE_PROFILE_EVIDENCE_STALE/u);
    const rejectedStaleMastery = await repository.saveAdaptiveLearningProfile(username, independent);
    assert.equal(Number(rejectedStaleMastery.independent_evidence_count), 0);
    assert.equal(rejectedStaleMastery.evidence_fingerprint, assisted.evidenceFingerprint);

    const exported = await repository.exportUserData(username);
    assert.equal(exported.adaptive_learning_profile.evidence_fingerprint, assisted.evidenceFingerprint);
    await repository.deleteUserData(username);
    assert.equal((await raw.query(
      'SELECT 1 FROM adaptive_learning_profiles WHERE username = $1', [username],
    )).rowCount, 0);
  } finally {
    await raw.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL evidence reader excludes numeric-looking strings from Writing review JSON', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  const suffix = String(Date.now()).slice(-8);
  const username = await repository.createTelegramUser(
    Number(`87${suffix}`), `Corrupt evidence ${suffix}`,
  );
  await raw.connect();
  try {
    await raw.query(
      `INSERT INTO writing_attempts
       (username, task_type, assignment, answer, evaluated_answer, review,
        prompt_version, status, evaluated_at)
       VALUES ($1, 'writing_37', '{}'::jsonb, 'test', 'test', $2::jsonb,
               'test-v1', 'completed', $3)`,
      [
        username,
        JSON.stringify({ overall_got: '4', overall_max: '6' }),
        new Date('2026-08-04T08:01:00.000Z'),
      ],
    );
    const sources = await repository.getAdaptiveLearningEvidenceSources(username);
    assert.equal(sources.attempts.some((entry) => entry.module === 'writing'), false);
    const malformed = buildAdaptiveLearningProfile(sources);
    const empty = buildAdaptiveLearningProfile();
    assert.equal(malformed.evidenceSourceCount, empty.evidenceSourceCount);
    assert.equal(malformed.evidenceFingerprint, empty.evidenceFingerprint);
    assert.equal(malformed.evidenceCount, empty.evidenceCount);
  } finally {
    await raw.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

function targetedPracticeScoredReview() {
  const semanticFacts = {
    confidence: 0.96, verdict: 'Assessable.', evidence: ['Four questions.'], issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, relevant: index !== 1, directQuestion: true,
      lexicalGrammarBlocksCommunication: false, evidence: `Question ${index + 1}`,
    })),
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.95, signalQuality: 'good', recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({ itemIndex: index + 1, durationSeconds: 12 })),
    wordAccuracyScore: 96, phonemeAccuracyScore: 95, fluencyScore: 84,
    wordEvents: [{
      id: 'azure:pg-weather:1', owner: 'azure_pronunciation', type: 'mispronunciation',
      gross: false, itemIndex: 2, accuracyScore: 72, start: 10, end: 17,
      word: 'weather', phonemes: [{ label: 'ð', accuracyScore: 48 }],
    }],
  };
  return {
    ...publicSpeakingReview(
      scoreSpeakingTask({ taskType: 2, semantic: semanticFacts, acoustic: acousticFacts }),
      semanticFacts,
    ),
    semanticFacts, acousticFacts,
  };
}

async function createAdaptivePlanTask2Evidence(repository, owner, { pronunciationError = false } = {}) {
  const assignedAt = new Date('2026-08-07T07:00:00.000Z');
  await repository.setSpeakingAccentProfile(owner, {
    locale: 'en-GB', source: 'manual', now: assignedAt,
  });
  const session = await repository.assignSpeakingTask2Session(owner, {
    catalogId: SPEAKING_TASK2_CATALOG.id,
    catalogRevision: SPEAKING_TASK2_CATALOG.revision,
    tasks: SPEAKING_TASK2_CATALOG.tasks,
    now: assignedAt,
  });
  for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
    await repository.completeSpeakingTask2Question(owner, session.id, questionNumber, {
      recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
    }, { now: new Date(assignedAt.getTime() + questionNumber * 12_000) });
  }
  const semanticFacts = {
    confidence: 0.96, verdict: 'Assessable.', evidence: ['Four direct questions.'], issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, relevant: true, directQuestion: true,
      lexicalGrammarBlocksCommunication: false, evidence: `Question ${index + 1}`,
    })),
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.95, signalQuality: 'good', recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({
      itemIndex: index + 1, durationSeconds: 12,
    })),
    wordAccuracyScore: 96, phonemeAccuracyScore: 95, fluencyScore: 84,
    wordEvents: pronunciationError ? [{
      id: 'azure:pg-max-weather:1', owner: 'azure_pronunciation', type: 'mispronunciation',
      gross: false, itemIndex: 2, accuracyScore: 72, start: 10, end: 17,
      word: 'weather', phonemes: [{ label: 'w', accuracyScore: 48 }],
    }] : [],
  };
  const review = {
    ...publicSpeakingReview(
      scoreSpeakingTask({ taskType: 2, semantic: semanticFacts, acoustic: acousticFacts }),
      semanticFacts,
    ),
    semanticFacts, acousticFacts,
  };
  const task = SPEAKING_TASK2_CATALOG.tasks.find((item) => item.id === session.task_id);
  const claim = await repository.claimSpeakingEvaluation(owner, {
    taskType: 2,
    assignment: { ad: task.advertisement, points: [...task.supports] },
    transcript: 'Four complete direct questions.',
  }, 'speaking-evaluation-v1', crypto.randomBytes(32).toString('hex'), {
    now: new Date(assignedAt.getTime() + 60_000),
    source: {
      sessionId: session.id, taskRef: session.task_id, taskRevision: Number(session.task_revision),
      catalogId: session.catalog_id, catalogRevision: Number(session.catalog_revision),
      assistanceUsed: false,
    },
  });
  await repository.finishSpeakingAttempt(claim.attempt.id, {
    status: 'completed', review, provider: 'test', model: 'test', errorCode: null,
  });
  return { ...session, evidence_attempt_id: claim.attempt.id };
}

test('PostgreSQL preserves, rebuilds, exports and deletes an exact max-score pronunciation capsule', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`87${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Pronunciation capsule ${stamp}`);
  await raw.connect();
  try {
    await repository.grantDays(telegramId, 30, `Pronunciation capsule ${stamp}`);
    const source = await createAdaptivePlanTask2Evidence(repository, owner, {
      pronunciationError: true,
    });
    const attempt = await repository.getSpeakingAttempt(owner, source.evidence_attempt_id);
    const referenceTime = new Date();
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(referenceTime.getTime() - 1_000),
      endsAt: new Date(referenceTime.getTime() + 30 * 86_400_000),
    });
    const pronunciationErrorRef = `phoneme.${attempt.id}.0.0`;
    const capsule = buildWritingSpeakingCapsule({
      source: 'speaking', attempt, expectedRevision: 1,
      pronunciationErrorRef, referenceTime,
    });
    assert.equal(attempt.review.got, 4);
    assert.equal(attempt.review.max, 4);
    const idempotencyKey = crypto.randomUUID();
    const reservation = await repository.reserveVoiceTutorSession(owner, {
      id: crypto.randomUUID(), idempotencyKey,
      limits: { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 },
      now: referenceTime, allowFallbackOnly: true,
      context: { capsule: persistedVoiceTutorCapsule(capsule), nonceHash: '9'.repeat(64) },
    });
    const replay = await repository.reserveVoiceTutorSession(owner, {
      id: crypto.randomUUID(), idempotencyKey,
      limits: { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 },
      now: referenceTime, allowFallbackOnly: true,
      context: { capsule: persistedVoiceTutorCapsule(capsule), nonceHash: '8'.repeat(64) },
    });
    assert.equal(replay.created, false);
    assert.equal(replay.session.id, reservation.session.id);
    assert.equal(replay.capsule.item.reference.pronunciationError.ref, pronunciationErrorRef);
    const stored = await repository.getVoiceTutorSession(owner, reservation.session.id);
    assert.equal(stored.capsule.source.pronunciation_error_ref, pronunciationErrorRef);
    assert.equal((await rebuildSourceCapsule(
      repository, owner, stored.capsule, referenceTime,
    )).item.reference.pronunciationError.phoneme, 'w');
    const exported = await repository.exportUserData(owner);
    assert.equal(exported.voice_tutor_sessions.find((session) => (
      session.id === reservation.session.id
    )).capsule.source.pronunciation_error_ref, pronunciationErrorRef);

    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal((await raw.query(
      'SELECT 1 FROM voice_tutor_sessions WHERE username = $1', [owner],
    )).rowCount, 0);
    assert.equal((await raw.query(
      'SELECT 1 FROM speaking_attempts WHERE username = $1', [owner],
    )).rowCount, 0);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await raw.end();
    await repository.close();
  }
});

test('PostgreSQL Voice Tutor replay and recovery recheck Premium after the owner lock', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const locker = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`85${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Voice entitlement race ${stamp}`);
  await locker.connect();
  const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
  const t0 = new Date();
  const sessionId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  try {
    await repository.grantDays(telegramId, 30, `Voice entitlement race ${stamp}`);
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(t0.getTime() - 1_000),
      endsAt: new Date(t0.getTime() + 30 * 86_400_000),
    });
    await repository.reserveVoiceTutorSession(owner, {
      id: sessionId, idempotencyKey, limits, now: t0,
      context: { capsule: { id: 'voice.final18.entitlement' }, nonceHash: '1'.repeat(64) },
    });
    await repository.issueVoiceTutorProxyTicket(owner, sessionId, {
      ticketHash: '2'.repeat(64), idempotencyKey,
      expiresAt: new Date(t0.getTime() + 30_000), now: t0,
    });
    const before = await repository.getVoiceTutorSession(owner, sessionId);

    await locker.query('BEGIN');
    await locker.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    await locker.query(
      `UPDATE subscription_entitlements SET ends_at = clock_timestamp()
       WHERE username = $1 AND entitlement = 'voice_tutor'`,
      [owner],
    );
    let replaySettled = false;
    const replay = repository.reserveVoiceTutorSession(owner, {
      id: crypto.randomUUID(), idempotencyKey, limits, now: t0,
      context: { capsule: { id: 'voice.final18.entitlement' }, nonceHash: '3'.repeat(64) },
    }).finally(() => { replaySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replaySettled, false);
    await locker.query('COMMIT');
    await assert.rejects(replay, /VOICE_TUTOR_PREMIUM_REQUIRED/u);

    await assert.rejects(repository.issueVoiceTutorProxyTicket(owner, sessionId, {
      ticketHash: '4'.repeat(64), idempotencyKey,
      expiresAt: new Date(t0.getTime() + 31_000), now: t0,
      reissue: true, nextNonceHash: '5'.repeat(64),
    }), /VOICE_TUTOR_PREMIUM_REQUIRED/u);
    await assert.rejects(repository.reissueVoiceTutorFallbackNonce(owner, sessionId, {
      idempotencyKey, nextNonceHash: '6'.repeat(64), now: t0,
    }), /VOICE_TUTOR_PREMIUM_REQUIRED/u);
    await assert.rejects(repository.switchVoiceTutorSessionDelivery(owner, sessionId, {
      nonceHash: before.nonce_hash,
      nextNonceHash: '7'.repeat(64),
      mode: 'text',
      limits,
      now: t0,
      errorCode: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE',
    }), /VOICE_TUTOR_PREMIUM_REQUIRED/u);
    const after = await repository.getVoiceTutorSession(owner, sessionId);
    assert.deepEqual(after, before);
  } finally {
    try { await locker.query('ROLLBACK'); } catch {}
    await repository.deleteUserData(owner).catch(() => {});
    await locker.end();
    await repository.close();
  }
});

test('PostgreSQL pronunciation reservation revalidates assistance after the owner lock', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const locker = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`84${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Pronunciation assistance race ${stamp}`);
  await locker.connect();
  let reservation;
  try {
    await repository.grantDays(telegramId, 60, `Pronunciation assistance race ${stamp}`);
    const source = await createAdaptivePlanTask2Evidence(repository, owner, {
      pronunciationError: true,
    });
    const attempt = await repository.getSpeakingAttempt(owner, source.evidence_attempt_id);
    const referenceTime = new Date();
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(referenceTime.getTime() - 1_000),
      endsAt: new Date(referenceTime.getTime() + 60 * 86_400_000),
    });
    const pronunciationErrorRef = `phoneme.${attempt.id}.0.0`;
    const capsule = buildWritingSpeakingCapsule({
      source: 'speaking', attempt, expectedRevision: 1,
      pronunciationErrorRef, referenceTime,
    });

    await locker.query('BEGIN');
    await locker.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let assistanceSettled = false;
    const assistance = repository.markSpeakingSessionAssisted(owner, 2, source.id, {
      now: new Date(referenceTime.getTime() + 1_000),
    }).finally(() => { assistanceSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(assistanceSettled, false);
    let reservationSettled = false;
    reservation = repository.reserveVoiceTutorSession(owner, {
      id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
      limits: { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 },
      now: referenceTime, allowFallbackOnly: true,
      context: { capsule: persistedVoiceTutorCapsule(capsule), nonceHash: '7'.repeat(64) },
    }).finally(() => { reservationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reservationSettled, false);
    await locker.query('COMMIT');
    await assistance;
    await assert.rejects(reservation, /VOICE_TUTOR_PRONUNCIATION_POINTER_STALE/u);
    reservation = null;
    assert.equal(Number((await locker.query(
      'SELECT COUNT(*)::integer AS count FROM voice_tutor_sessions WHERE username = $1', [owner],
    )).rows[0].count), 0);
  } finally {
    try { await locker.query('ROLLBACK'); } catch {}
    if (reservation) await reservation.catch(() => {});
    await repository.deleteUserData(owner).catch(() => {});
    await locker.end();
    await repository.close();
  }
});

test('PostgreSQL exact pronunciation replay rejects ref drift and the 30-day expiry boundary', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const locker = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-8);
  const owners = [];
  await locker.connect();
  const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };

  async function prepare(prefix, label) {
    const telegramId = Number(`${prefix}${stamp}`);
    const owner = await repository.createTelegramUser(telegramId, `${label} ${stamp}`);
    owners.push(owner);
    await repository.grantDays(telegramId, 60, `${label} ${stamp}`);
    const source = await createAdaptivePlanTask2Evidence(repository, owner, {
      pronunciationError: true,
    });
    const attempt = await repository.getSpeakingAttempt(owner, source.evidence_attempt_id);
    const referenceTime = new Date();
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(referenceTime.getTime() - 1_000),
      endsAt: new Date(referenceTime.getTime() + 60 * 86_400_000),
    });
    const pronunciationErrorRef = `phoneme.${attempt.id}.0.0`;
    const storedCapsule = persistedVoiceTutorCapsule(buildWritingSpeakingCapsule({
      source: 'speaking', attempt, expectedRevision: 1,
      pronunciationErrorRef, referenceTime,
    }));
    const idempotencyKey = crypto.randomUUID();
    const first = await repository.reserveVoiceTutorSession(owner, {
      id: crypto.randomUUID(), idempotencyKey, limits, now: referenceTime,
      context: { capsule: storedCapsule, nonceHash: '8'.repeat(64) },
    });
    return { owner, attempt, storedCapsule, idempotencyKey, first, referenceTime };
  }

  async function replayBehindMutation(prepared, mutate, expectedCode) {
    await locker.query('BEGIN');
    await locker.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [prepared.owner]);
    await mutate();
    let settled = false;
    const replay = repository.reserveVoiceTutorSession(prepared.owner, {
      id: crypto.randomUUID(), idempotencyKey: prepared.idempotencyKey, limits,
      now: prepared.referenceTime,
      context: { capsule: prepared.storedCapsule, nonceHash: '9'.repeat(64) },
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false);
    await locker.query('COMMIT');
    await assert.rejects(replay, new RegExp(expectedCode, 'u'));
    assert.equal(Number((await locker.query(
      'SELECT COUNT(*)::integer AS count FROM voice_tutor_sessions WHERE username = $1',
      [prepared.owner],
    )).rows[0].count), 1);
    const beforeFallback = await repository.getVoiceTutorSession(
      prepared.owner, prepared.first.session.id,
    );
    await assert.rejects(repository.switchVoiceTutorSessionDelivery(
      prepared.owner,
      prepared.first.session.id,
      {
        nonceHash: '8'.repeat(64),
        nextNonceHash: '7'.repeat(64),
        mode: 'text',
        limits,
        now: prepared.referenceTime,
        errorCode: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE',
      },
    ), new RegExp(expectedCode, 'u'));
    assert.deepEqual(
      await repository.getVoiceTutorSession(prepared.owner, prepared.first.session.id),
      beforeFallback,
    );
  }

  try {
    const refDrift = await prepare('83', 'Pronunciation ref replay');
    await replayBehindMutation(refDrift, () => locker.query(
      `UPDATE speaking_attempts
       SET review = jsonb_set(review, '{acousticFacts,wordEvents,0,phonemes,0,accuracyScore}', '90'::jsonb)
       WHERE username = $1 AND id = $2`,
      [refDrift.owner, refDrift.attempt.id],
    ), 'VOICE_TUTOR_PRONUNCIATION_POINTER_STALE');

    const expired = await prepare('82', 'Pronunciation expiry replay');
    await replayBehindMutation(expired, () => locker.query(
      `UPDATE speaking_attempts SET evaluated_at = clock_timestamp() - INTERVAL '30 days'
       WHERE username = $1 AND id = $2`,
      [expired.owner, expired.attempt.id],
    ), 'VOICE_TUTOR_PRONUNCIATION_POINTER_EXPIRED');
  } finally {
    try { await locker.query('ROLLBACK'); } catch {}
    await Promise.all(owners.map((owner) => repository.deleteUserData(owner).catch(() => {})));
    await locker.end();
    await repository.close();
  }
});

test('PostgreSQL HTTP overview replaces a same-time post-hoc assistance plan atomically', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`86${stamp}`), `Plan fingerprint ${stamp}`);
  let armed = false;
  let injected = false;
  let sourceSession = null;
  const routeRepository = new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
      return async (username, candidate) => {
        if (armed && !injected) {
          injected = true;
          await target.markSpeakingSessionAssisted(username, 2, sourceSession.id, {
            now: new Date(candidate.profileEvidenceObservedAt),
          });
        }
        return target.saveAdaptiveLearningPlan(username, candidate);
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: { auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      next();
    } },
    db: routeRepository,
    enabled: true,
    now: () => new Date('2026-08-07T09:00:00.000Z'),
    executionTokenSecret: 'adaptive-pg-test-token-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  await raw.connect();
  try {
    sourceSession = await createAdaptivePlanTask2Evidence(repository, owner);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const request = (pathname, options = {}) => fetch(
      `http://127.0.0.1:${server.address().port}${pathname}`,
      { ...options, headers: {
        'Content-Type': 'application/json', 'X-Test-User': owner,
        'X-EasyBoost-Expected-Owner': owner, ...(options.headers || {}),
      } },
    );
    const createdResponse = await request('/api/v1/adaptive-learning/goal', {
      method: 'PUT', headers: { 'Idempotency-Key': `adaptive-plan-pg-${stamp}` },
      body: JSON.stringify({
        targetExam: 'ege_english', targetScore: 85,
        examDate: '2027-06-01', weeklyMinutes: 300,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const before = await createdResponse.json();
    assert.ok(before.profile.independentEvidenceCount > 0);
    assert.equal(before.plan.profileEvidenceFingerprint, before.profile.evidenceFingerprint);

    armed = true;
    const response = await request('/api/v1/adaptive-learning/overview');
    assert.equal(response.status, 200);
    const after = await response.json();
    assert.equal(injected, true);
    assert.equal(after.profile.evidenceSourceCount, before.profile.evidenceSourceCount);
    assert.equal(after.profile.evidenceObservedAt, before.profile.evidenceObservedAt);
    assert.notEqual(after.profile.evidenceFingerprint, before.profile.evidenceFingerprint);
    assert.equal(after.profile.independentEvidenceCount, 0);
    assert.ok(after.profile.assistedEvidenceCount > 0);
    assert.equal(after.plan.revision, before.plan.revision + 1);
    assert.notEqual(after.plan.id, before.plan.id);
    assert.equal(after.plan.profileEvidenceFingerprint, after.profile.evidenceFingerprint);
    assert.notDeepEqual(after.plan.allocation, before.plan.allocation);
    const revisions = (await repository.exportUserData(owner)).adaptive_learning_plan_revisions;
    assert.deepEqual(revisions.map((entry) => entry.revision), [1, 2]);
    assert.deepEqual(revisions.map((entry) => entry.profile_evidence_fingerprint), [
      before.profile.evidenceFingerprint, after.profile.evidenceFingerprint,
    ]);

    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal((await raw.query(
      'SELECT 1 FROM adaptive_learning_plan_revisions WHERE username = $1', [owner],
    )).rowCount, 0);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await raw.end();
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL overview exhausts profile CAS retries as a retryable 409', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`85${stamp}`), `Profile retry ${stamp}`);
  let saves = 0;
  const routeRepository = new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningProfile') return Reflect.get(target, property);
      return async () => {
        saves += 1;
        throw new Error('ADAPTIVE_PROFILE_EVIDENCE_STALE');
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: { auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      return next();
    } },
    db: routeRepository,
    enabled: false,
    now: () => new Date('2026-08-07T09:00:00.000Z'),
    executionTokenSecret: 'adaptive-pg-test-token-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/adaptive-learning/overview`,
      { headers: { 'X-Test-User': owner, 'X-EasyBoost-Expected-Owner': owner } },
    );
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), {
      error: { code: 'ADAPTIVE_PROFILE_RETRY_REQUIRED', retryable: true },
    });
    assert.equal(saves, 3);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL overview exhausts plan races as the same retryable bounded 409', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`84${stamp}`), `Plan retry ${stamp}`);
  const instant = new Date('2026-08-07T09:00:00.000Z');
  await repository.saveAdaptiveLearningGoal(owner, {
    id: crypto.randomUUID(), idempotencyKey: `adaptive-plan-retry-pg-${stamp}`,
    requestHash: '8'.repeat(64), targetExam: 'ege_english', targetScore: 85,
    examDate: '2027-06-01', weeklyMinutes: 300, now: instant,
  });
  let saves = 0;
  const routeRepository = new Proxy(repository, {
    get(target, property) {
      if (property !== 'saveAdaptiveLearningPlan') return Reflect.get(target, property);
      return async () => {
        saves += 1;
        throw new Error('ADAPTIVE_PLAN_PROFILE_STALE');
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: { auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      return next();
    } },
    db: routeRepository,
    enabled: true,
    now: () => instant,
    executionTokenSecret: 'adaptive-pg-test-token-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/adaptive-learning/overview`,
      { headers: { 'X-Test-User': owner, 'X-EasyBoost-Expected-Owner': owner } },
    );
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), {
      error: { code: 'ADAPTIVE_PROFILE_RETRY_REQUIRED', retryable: true },
    });
    assert.equal(saves, 3);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL deep mutations recheck Premium inside the locked owner transaction', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`83${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Premium mutation ${stamp}`);
  let current = new Date(Date.now() - 10_000);
  const writingRegistry = {
    ...ADAPTIVE_ACTIVITY_REGISTRY,
    activities: ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
      activity.module === 'writing' && activity.launch.kind === 'writing_task'
    )),
  };
  const mutationHooks = new Map();
  const routeRepository = new Proxy(repository, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!['getAdaptiveLearningSessionMutationReplay', 'startAdaptiveLearningSessionBlock',
        'bindAdaptiveLearningServerAttempt', 'advanceAdaptiveLearningSession'].includes(property)) {
        return value.bind(target);
      }
      return async (...args) => {
        const hook = mutationHooks.get(property);
        if (hook) {
          mutationHooks.delete(property);
          await hook(...args);
        }
        return value.apply(target, args);
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: { auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      return next();
    } },
    db: routeRepository,
    enabled: true,
    now: () => new Date(current),
    activityRegistry: writingRegistry,
    executionTokenSecret: 'adaptive-pg-test-token-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  const entitle = (instant) => repository.setEntitlement(owner, 'voice_tutor', {
    startsAt: new Date(instant.getTime() - 1_000),
    endsAt: new Date(instant.getTime() + 60 * 60_000),
  });
  try {
    await client.connect();
    await repository.grantDays(telegramId, 30, owner);
    await entitle(current);
    const goal = (await repository.saveAdaptiveLearningGoal(owner, {
      id: crypto.randomUUID(), idempotencyKey: `premium-mutation-goal-${stamp}`,
      requestHash: '3'.repeat(64), targetExam: 'ege_english', targetScore: 85,
      examDate: '2027-06-01', weeklyMinutes: 300, now: current,
    })).goal;
    const storedProfile = await repository.saveAdaptiveLearningProfile(
      owner,
      buildAdaptiveLearningProfile(await repository.getAdaptiveLearningEvidenceSources(owner)),
      { now: current, verifyCurrentEvidence: true },
    );
    const profile = adaptiveLearningProfilePublicDto(storedProfile);
    const calculated = buildAdaptiveLearningPlan({ goal, profile, now: current });
    const storedPlan = (await repository.saveAdaptiveLearningPlan(owner, {
      id: crypto.randomUUID(),
      inputFingerprint: adaptivePlanInputFingerprint({
        goal, profile, basePlanRevision: null, now: current,
      }),
      basePlanRevision: null, goalId: goal.id, goalRevision: goal.revision,
      taxonomyVersion: profile.taxonomyVersion,
      profileCalculationRevision: profile.profileCalculationRevision,
      profileEvidenceWatermarkVersion: profile.evidenceWatermarkVersion,
      profileEvidenceObservedAt: profile.evidenceObservedAt,
      profileEvidenceSourceCount: profile.evidenceSourceCount,
      profileEvidenceFingerprint: profile.evidenceFingerprint,
      recalculationBucket: calculated.recalculationBucket, plan: calculated, now: current,
    })).plan;
    const publicPlan = {
      id: storedPlan.id, revision: storedPlan.revision, version: storedPlan.plan_version,
      taxonomyVersion: storedPlan.taxonomy_version, allocation: storedPlan.allocation,
    };
    const preview = buildAdaptiveSessionPreview({
      plan: publicPlan, goal, profile, weekUsage: [], durationMinutes: 30, now: current,
      registry: writingRegistry,
      access: { tier: 'premium', capabilities: { premiumDepth: true } },
    });
    const session = createAdaptiveLearningSessionFromPreview(preview, {
      id: crypto.randomUUID(), now: current,
    });
    const created = await repository.createAdaptiveLearningSession(owner, {
      idempotencyKey: `premium-mutation-create-${stamp}`,
      requestHash: crypto.createHash('sha256')
        .update(JSON.stringify([30, preview.previewFingerprint])).digest('hex'),
      planId: publicPlan.id, planRevision: publicPlan.revision,
      previewFingerprint: preview.previewFingerprint, session, commercialScope: 'premium', now: current,
    });
    let block = created.session.blocks[0];
    assert.equal(block.module, 'writing');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const request = (pathname, options = {}) => fetch(
      `http://127.0.0.1:${server.address().port}${pathname}`,
      { ...options, headers: {
        'Content-Type': 'application/json', 'X-Test-User': owner,
        'X-EasyBoost-Expected-Owner': owner, ...(options.headers || {}),
      } },
    );
    const startBody = { blockId: block.id, expectedRevision: 0 };
    const replacementBody = JSON.stringify({ blockId: block.id, reason: 'excluded' });
    let replacement = null;
    mutationHooks.set('startAdaptiveLearningSessionBlock', async () => {
      const replacementResponse = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/replace`, {
        method: 'POST', headers: { 'Idempotency-Key': `premium-race-replace-${stamp}` },
        body: replacementBody,
      });
      assert.equal(replacementResponse.status, 200);
      replacement = (await replacementResponse.json()).session;
    });
    let response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-race-start-${stamp}` },
      body: JSON.stringify(startBody),
    });
    assert.equal(response.status, 409, 'replacement-wins-before-start cannot bind a stale launch');
    assert.ok(replacement);
    assert.notDeepEqual(replacement.blocks.find((item) => item.id === block.id).launch, block.launch);
    block = replacement.blocks.find((item) => item.id === block.id);

    const revokeAtMutation = async (...args) => {
      const requestInstant = new Date(args[1].now);
      const instant = new Date(requestInstant.getTime() + 1_000);
      current = instant;
      assert.equal(await repository.revokeEntitlement(
        owner, 'voice_tutor', telegramId, { now: instant },
      ), true);
    };
    mutationHooks.set('startAdaptiveLearningSessionBlock', revokeAtMutation);
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-start-${stamp}` },
      body: JSON.stringify(startBody),
    });
    assert.equal(response.status, 403);

    await entitle(current);
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-start-${stamp}` },
      body: JSON.stringify(startBody),
    });
    assert.equal(response.status, 201);
    const started = await response.json();
    const storedClaim = (await client.query(
      `SELECT issued_at, expires_at FROM adaptive_learning_execution_claims
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    )).rows[0];
    assert.equal(
      new Date(storedClaim.expires_at).getTime() - new Date(storedClaim.issued_at).getTime(),
      ADAPTIVE_EXECUTION_CLAIM_TTL_MS,
    );
    assert.equal(started.claimExpiresAt, new Date(storedClaim.expires_at).toISOString());
    assert.equal(started.session.updatedAt, new Date(storedClaim.issued_at).toISOString());
    assert.ok(new Date(started.claimExpiresAt).getTime() > Date.now());
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/replace`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-race-replace-${stamp}` },
      body: replacementBody,
    });
    assert.equal(response.status, 409, 'an exact replacement replay closes after a claim exists');
    assert.equal((await response.json()).error.code, 'ADAPTIVE_SESSION_REPLACEMENT_LOCKED');
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/replace`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-replace-after-start-${stamp}` },
      body: JSON.stringify({ blockId: block.id, reason: 'not_relevant' }),
    });
    assert.equal(response.status, 409, 'a new replacement closes after a claim exists');
    assert.equal((await response.json()).error.code, 'ADAPTIVE_SESSION_REPLACEMENT_LOCKED');
    const attemptId = await repository.createWritingAttempt(owner, {
      taskType: block.activityId, sourceTaskRef: block.launch.taskId, assignment: {},
      answer: 'A sufficiently long student answer for the persisted attempt.',
    }, 'test-writing-v1');
    await repository.finishWritingAttempt(attemptId, {
      status: 'completed', review: { overall_got: 1, overall_max: 6 },
    });
    const attempt = { type: 'writing', id: attemptId };

    current = new Date(current.getTime() + 100);
    await entitle(current);
    mutationHooks.set('startAdaptiveLearningSessionBlock', revokeAtMutation);
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-start-${stamp}` },
      body: JSON.stringify(startBody),
    });
    assert.equal(response.status, 403, 'a committed revoke wins before exact replay');

    await entitle(current);
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() - interval '1 millisecond'
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    );
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-start-${stamp}` },
      body: JSON.stringify(startBody),
    });
    assert.equal(response.status, 410, 'an exact replay must recheck stored claim expiry after the lock');
    const expiredModuleAttemptId = crypto.randomUUID();
    await assert.rejects(repository.recordModuleAttemptWithAdaptiveClaim(owner, {
      id: expiredModuleAttemptId, module: block.module, activity: block.activityId,
      score: 1, maxScore: 1, durationMs: 1_000, metadata: {},
    }, { executionClaim: started.executionClaim }), /ADAPTIVE_EXECUTION_CLAIM_EXPIRED/u);
    assert.equal((await client.query(
      'SELECT id FROM module_attempts WHERE username = $1 AND id = $2',
      [owner, expiredModuleAttemptId],
    )).rowCount, 0);
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() + interval '2 hours'
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    );
    mutationHooks.set('bindAdaptiveLearningServerAttempt', revokeAtMutation);
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/bind-attempt`, {
      method: 'POST', body: JSON.stringify({ executionClaim: started.executionClaim, attempt }),
    });
    assert.equal(response.status, 403);

    await entitle(current);
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() - interval '1 millisecond'
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    );
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/bind-attempt`, {
      method: 'POST', body: JSON.stringify({ executionClaim: started.executionClaim, attempt }),
    });
    assert.equal(response.status, 410, 'server attempt binding must use post-lock claim time');
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() + interval '2 hours'
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    );
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/bind-attempt`, {
      method: 'POST', body: JSON.stringify({ executionClaim: started.executionClaim, attempt }),
    });
    assert.equal(response.status, 201);

    current = new Date(current.getTime() + 100);
    await entitle(current);
    mutationHooks.set('advanceAdaptiveLearningSession', revokeAtMutation);
    const advanceBody = { blockId: block.id, expectedRevision: 1, attempt };
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-advance-${stamp}` },
      body: JSON.stringify(advanceBody),
    });
    assert.equal(response.status, 403);

    await entitle(current);
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() - interval '1 millisecond'
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    );
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-advance-${stamp}` },
      body: JSON.stringify(advanceBody),
    });
    assert.equal(response.status, 410, 'advance must reject a claim expired after route precheck');
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() + interval '2 hours'
       WHERE session_id = $1 AND block_id = $2 AND username = $3`,
      [created.session.id, block.id, owner],
    );
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-advance-${stamp}` },
      body: JSON.stringify(advanceBody),
    });
    assert.equal(response.status, 200);

    current = new Date(current.getTime() + 100);
    await entitle(current);
    mutationHooks.set('getAdaptiveLearningSessionMutationReplay', revokeAtMutation);
    response = await request(`/api/v1/adaptive-learning/sessions/${created.session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': `premium-advance-${stamp}` },
      body: JSON.stringify(advanceBody),
    });
    assert.equal(response.status, 403, 'a committed revoke wins before exact advance replay');
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await client.end().catch(() => {});
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL Speaking accent/calibration matches file privacy and retention contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const suffix = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`95${suffix}`), `Accent owner ${suffix}`);
  const expertAName = `Accent expert A ${suffix}`;
  const expertA = await repository.createTelegramUser(Number(`94${suffix}`), expertAName);
  const expertB = await repository.createTelegramUser(Number(`93${suffix}`), `Accent expert B ${suffix}`);
  const manualOwner = await repository.createTelegramUser(Number(`91${suffix}`), `Accent manual ${suffix}`);
  const pendingOwner = await repository.createTelegramUser(Number(`90${suffix}`), `Accent pending ${suffix}`);
  try {
    const { sampleId } = await assertSpeakingAccentCalibrationRepositoryContract(
      assert, repository, {
        owner, expertA, expertB,
        recreateExpertA: () => repository.createTelegramUser(Number(`92${suffix}`), expertAName),
      },
    );
    const staleProfile = {
      locale: 'en-US', revision: 1, source: 'calibration',
      effective_at: '2026-08-06T10:00:00.000Z', calibration_used: true,
    };
    const ordinary = await repository.assignSpeakingTask1Session(owner, {
      catalogId: 'accent-stale-catalog', catalogRevision: 1,
      tasks: [{ id: 'accent-stale-task', revision: 1 }], accentProfile: staleProfile,
      now: new Date('2026-08-06T13:00:00.000Z'),
    });
    assert.deepEqual([ordinary.accent_locale, ordinary.accent_profile_revision], ['en-GB', 2]);
    const full = await repository.assignFullSpeakingSession(owner, {
      catalogs: SPEAKING_CATALOGS, accentProfile: staleProfile,
      now: new Date('2026-08-06T13:01:00.000Z'),
    });
    assert.deepEqual([full.accent_locale, full.accent_profile_revision], ['en-GB', 2]);

    await repository.setSpeakingAccentProfile(manualOwner, {
      locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T14:00:00.000Z'),
    });
    await assert.rejects(
      repository.startSpeakingAccentCalibration(manualOwner),
      (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_ALREADY_USED',
    );
    const pending = await repository.startSpeakingAccentCalibration(pendingOwner, {
      now: new Date('2026-08-06T14:00:00.000Z'),
    });
    await repository.setSpeakingAccentProfile(pendingOwner, {
      locale: 'en-US', source: 'manual', now: new Date('2026-08-06T14:01:00.000Z'),
    });
    const cancelled = await repository.getSpeakingAccentCalibration(pendingOwner, pending.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.evidence_keys, null);
    await assert.rejects(repository.completeSpeakingAccentCalibration(pendingOwner, {
      setupId: pending.id, locale: 'en-GB', suggestionConfidence: 'clear',
      evidenceKeys: [crypto.randomUUID(), crypto.randomUUID()],
      policyVersion: 'speaking-accent-suggestion-v1', now: new Date('2026-08-06T14:02:00.000Z'),
    }), (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');

    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.exportUserData(owner), null);
    const labels = await repository.listAnonymousSpeakingCalibrationLabels();
    assert.equal(labels.some((entry) => entry.sampleId === sampleId), true);
    assert.equal(JSON.stringify(labels).includes(expertA), false);
    assert.equal(JSON.stringify(labels).includes(expertB), false);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(expertA).catch(() => {});
    await repository.deleteUserData(expertB).catch(() => {});
    await repository.deleteUserData(manualOwner).catch(() => {});
    await repository.deleteUserData(pendingOwner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL calibration mutations lock owner before child rows and finish privacy races', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const suffix = String(Date.now()).slice(-7);
  const uploadOwner = await repository.createTelegramUser(Number(`81${suffix}`), `Accent upload lock ${suffix}`);
  const completeOwner = await repository.createTelegramUser(Number(`82${suffix}`), `Accent complete lock ${suffix}`);
  const assignmentOwner = await repository.createTelegramUser(Number(`84${suffix}`), `Accent assignment lock ${suffix}`);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  const startedAt = new Date('2026-08-06T10:00:00.000Z');

  async function assertOwnerFirst(username, mutation, childLockSql) {
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
    let settled = false;
    const pending = mutation().finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(settled, false, 'the mutation waits at the owner lock');
    await raw.query(childLockSql, [username]);
    await raw.query('ROLLBACK');
    return pending;
  }

  try {
    await repository.setSpeakingCalibrationConsent(uploadOwner, {
      granted: true, ageGroup: 'adult', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    });
    const createSample = () => repository.createSpeakingCalibrationSample(uploadOwner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
      taskRef: `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
      ...speakingCalibrationSampleMaterial(
        1, `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
      ),
      locale: 'en-GB', maximumScore: 1, audio: Buffer.from('owner-first-upload'), now: startedAt,
    });
    await assertOwnerFirst(
      uploadOwner,
      createSample,
      'SELECT username FROM speaking_calibration_consents WHERE username = $1 FOR UPDATE NOWAIT',
    );

    const setup = await repository.startSpeakingAccentCalibration(completeOwner, { now: startedAt });
    const complete = () => repository.completeSpeakingAccentCalibration(completeOwner, {
      setupId: setup.id, locale: 'en-US', suggestionConfidence: 'clear',
      evidenceKeys: [crypto.randomUUID(), crypto.randomUUID()],
      policyVersion: 'speaking-accent-suggestion-v1', now: startedAt,
    });
    await assertOwnerFirst(
      completeOwner,
      complete,
      'SELECT id FROM speaking_accent_calibrations WHERE username = $1 FOR UPDATE NOWAIT',
    );

    await repository.setSpeakingCalibrationConsent(uploadOwner, {
      granted: true, ageGroup: 'adult', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    });
    const uploadRevokeRace = await Promise.allSettled([
      createSample(),
      repository.setSpeakingCalibrationConsent(uploadOwner, {
        granted: false, ageGroup: 'adult', guardianConfirmed: false,
        policyVersion: 'speaking-calibration-consent-v1', now: new Date(startedAt.getTime() + 1_000),
      }),
    ]);
    assert.equal(uploadRevokeRace.some((entry) => entry.status === 'rejected'
      && entry.reason?.code === '40P01'), false, 'upload/revoke must not deadlock');
    assert.equal((await repository.listSpeakingCalibrationSamplesForOwner(uploadOwner))
      .some((sample) => sample.audio_retained), false, 'revocation wins without retained raw audio');

    const deleteSetup = await repository.startSpeakingAccentCalibration(
      await repository.createTelegramUser(Number(`83${suffix}`), `Accent delete lock ${suffix}`),
      { now: startedAt },
    );
    const deleteOwner = `Accent delete lock ${suffix}`;
    const completeDeleteRace = await Promise.allSettled([
      repository.completeSpeakingAccentCalibration(deleteOwner, {
        setupId: deleteSetup.id, locale: 'en-GB', suggestionConfidence: 'clear',
        evidenceKeys: [crypto.randomUUID(), crypto.randomUUID()],
        policyVersion: 'speaking-accent-suggestion-v1', now: startedAt,
      }),
      repository.deleteUserData(deleteOwner),
    ]);
    assert.equal(completeDeleteRace.some((entry) => entry.status === 'rejected'
      && entry.reason?.code === '40P01'), false, 'completion/delete must not deadlock');
    assert.equal(completeDeleteRace[1].status, 'fulfilled');
    assert.equal(await repository.exportUserData(deleteOwner), null);

    const firstProfile = (await repository.setSpeakingAccentProfile(assignmentOwner, {
      locale: 'en-GB', source: 'manual', now: startedAt,
    })).profile;
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [assignmentOwner]);
    let ordinarySettled = false;
    const ordinaryPending = repository.assignSpeakingTask1Session(assignmentOwner, {
      catalogId: 'pg-concurrent-accent', catalogRevision: 1,
      tasks: [{ id: 'pg-concurrent-task', revision: 1 }], accentProfile: firstProfile,
      now: new Date('2026-08-06T15:00:00.000Z'),
    }).finally(() => { ordinarySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(ordinarySettled, false, 'ordinary assignment waits for the owner profile transaction');
    await raw.query(
      `UPDATE speaking_accent_profiles
       SET locale = 'en-US', revision = 2, source = 'manual', effective_at = $2
       WHERE username = $1`,
      [assignmentOwner, new Date('2026-08-06T14:59:00.000Z')],
    );
    await raw.query('COMMIT');
    const ordinary = await ordinaryPending;
    assert.deepEqual([ordinary.accent_locale, ordinary.accent_profile_revision], ['en-US', 2]);

    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [assignmentOwner]);
    let fullSettled = false;
    const fullPending = repository.assignFullSpeakingSession(assignmentOwner, {
      catalogs: SPEAKING_CATALOGS,
      accentProfile: { ...firstProfile, locale: 'en-US', revision: 2 },
      now: new Date('2026-08-06T15:01:00.000Z'),
    }).finally(() => { fullSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(fullSettled, false, 'full assignment waits for the owner profile transaction');
    await raw.query(
      `UPDATE speaking_accent_profiles
       SET locale = 'en-GB', revision = 3, source = 'manual', effective_at = $2
       WHERE username = $1`,
      [assignmentOwner, new Date('2026-08-06T15:00:30.000Z')],
    );
    await raw.query('COMMIT');
    const full = await fullPending;
    assert.deepEqual([full.accent_locale, full.accent_profile_revision], ['en-GB', 3]);

    const queueStartedAt = new Date('2026-09-01T10:00:00.000Z');
    await repository.setSpeakingCalibrationConsent(uploadOwner, {
      granted: true, ageGroup: 'adult', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: queueStartedAt,
    });
    const queueIds = [];
    for (let index = 0; index < 26; index += 1) {
      const taskRef = `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`;
      const queued = await repository.createSpeakingCalibrationSample(uploadOwner, {
        id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
        taskRef, ...speakingCalibrationSampleMaterial(1, taskRef),
        locale: 'en-GB', maximumScore: 1, audio: Buffer.from(`queue-audio-${index}`),
        now: new Date(queueStartedAt.getTime() + index * 1_000),
      });
      queueIds.push(queued.id);
    }
    const queueClaimAt = new Date(queueStartedAt.getTime() + 30_000);
    await raw.query(
      `UPDATE speaking_calibration_samples
       SET access_audit = jsonb_build_array(jsonb_build_object(
         'reviewer', 'busy-reviewer', 'review_round', 1, 'accessed_at', $2::text
       ))
       WHERE id = ANY($1::uuid[])`,
      [queueIds.slice(0, 25), queueClaimAt.toISOString()],
    );
    const twentySixth = await repository.claimSpeakingCalibrationSample(completeOwner, {
      now: queueClaimAt,
    });
    assert.equal(twentySixth.sampleId, queueIds[25],
      'ineligible first page must not hide a later available calibration sample');
  } finally {
    await raw.query('ROLLBACK').catch(() => {});
    await raw.end();
    await repository.deleteUserData(uploadOwner).catch(() => {});
    await repository.deleteUserData(completeOwner).catch(() => {});
    await repository.deleteUserData(assignmentOwner).catch(() => {});
    await repository.deleteUserData(`Accent delete lock ${suffix}`).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL Speaking assessment quota matches atomic replay, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`96${stamp}`), `Speaking quota owner ${stamp}`);
  try {
    await assertSpeakingAssessmentQuotaContract(assert, repository, owner);
    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.exportUserData(owner), null);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL full Speaking sessions match owner isolation, replay, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`88${stamp}`), `Full Speaking owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`89${stamp}`), `Full Speaking other ${stamp}`);
  try {
    await assertFullSpeakingSessionRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL task 2 sessions match owner isolation, replay, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`82${stamp}`), `Task two owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`83${stamp}`), `Task two other ${stamp}`);
  try {
    await assertSpeakingTask2SessionRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL speaking evaluation claim locks the owner before its source session', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`79${stamp}`), `Speaking claim lock ${stamp}`);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  let pending = null;
  try {
    let now = new Date(new Date((await raw.query(
      'SELECT clock_timestamp() AS now',
    )).rows[0].now).getTime() - 60_000);
    const session = await repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      now,
    });
    for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
      now = new Date(now.getTime() + 12_000);
      await repository.completeSpeakingTask2Question(owner, session.id, questionNumber, {
        recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
      }, { now });
    }
    const source = {
      sessionId: session.id,
      taskRef: session.task_id,
      taskRevision: Number(session.task_revision),
      catalogId: session.catalog_id,
      catalogRevision: Number(session.catalog_revision),
      assistanceUsed: false,
    };
    const fingerprint = crypto.createHash('sha256').update(`${owner}:owner-first-claim`).digest('hex');
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let settled = false;
    pending = repository.claimSpeakingEvaluation(owner, {
      taskType: 2,
      assignment: { ad: 'Owner-first lock test', points: ['a', 'b', 'c', 'd'] },
      transcript: 'Four owner-bound questions.',
    }, 'speaking-semantic-v4', fingerprint, { now, source }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(settled, false, 'the evaluation claim must wait at the owner lock');
    await raw.query(
      'SELECT id FROM speaking_task2_sessions WHERE username = $1 AND id = $2 FOR UPDATE NOWAIT',
      [owner, session.id],
    );
    await raw.query('ROLLBACK');
    const claim = await pending;
    pending = null;
    assert.equal(claim.created, true);
  } finally {
    await raw.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    await raw.end();
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL assistance invalidation locks owner before session and attempt rows', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`78${stamp}`), `Speaking assistance lock ${stamp}`);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  let pending = null;
  try {
    let now = new Date('2026-08-06T10:00:00.000Z');
    const session = await repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      now,
    });
    for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
      now = new Date(now.getTime() + 12_000);
      await repository.completeSpeakingTask2Question(owner, session.id, questionNumber, {
        recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
      }, { now });
    }
    const source = {
      sessionId: session.id,
      taskRef: session.task_id,
      taskRevision: Number(session.task_revision),
      catalogId: session.catalog_id,
      catalogRevision: Number(session.catalog_revision),
      assistanceUsed: false,
    };
    const fingerprint = crypto.createHash('sha256').update(`${owner}:assistance-lock`).digest('hex');
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2,
      assignment: { ad: 'Assistance lock test', points: ['a', 'b', 'c', 'd'] },
      transcript: 'Four owner-bound questions.',
    }, 'speaking-semantic-v4', fingerprint, { now, source });

    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let settled = false;
    pending = repository.markSpeakingSessionAssisted(owner, 2, session.id, {
      now: new Date(now.getTime() + 1_000),
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(settled, false, 'assistance invalidation must wait at the owner lock');
    await raw.query(
      'SELECT id FROM speaking_task2_sessions WHERE username = $1 AND id = $2 FOR UPDATE NOWAIT',
      [owner, session.id],
    );
    await raw.query(
      'SELECT id FROM speaking_attempts WHERE username = $1 AND id = $2 FOR UPDATE NOWAIT',
      [owner, claim.attempt.id],
    );
    await raw.query('ROLLBACK');
    assert.ok(await pending);
    pending = null;
    const attempt = await repository.getSpeakingAttempt(owner, claim.attempt.id);
    assert.equal(attempt.assistance_used, true);
  } finally {
    await raw.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    await raw.end();
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL targeted assignment revalidates after a concurrent owner-locked assistance update', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`77${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Speaking targeted race ${stamp}`);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  let pending = null;
  let pendingFinish = null;
  let pendingSnapshot = null;
  try {
    let now = new Date('2026-08-06T10:00:00.000Z');
    await repository.grantDays(telegramId, 30, `Speaking targeted race ${stamp}`);
    await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now });
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(now.getTime() - 1_000), endsAt: new Date(now.getTime() + 86_400_000),
    });
    const session = await repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      now,
    });
    for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
      now = new Date(now.getTime() + 12_000);
      await repository.completeSpeakingTask2Question(owner, session.id, questionNumber, {
        recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
      }, { now });
    }
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: { ad: 'Weather course', points: ['a', 'b', 'c', 'd'] },
      transcript: 'When does it start? What is the weather like?',
    }, 'speaking-semantic-v4', crypto.createHash('sha256').update(`${owner}:target-race`).digest('hex'), {
      now,
      source: {
        sessionId: session.id, taskRef: session.task_id, taskRevision: Number(session.task_revision),
        catalogId: session.catalog_id, catalogRevision: Number(session.catalog_revision),
        assistanceUsed: false,
      },
    });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: targetedPracticeScoredReview(), provider: 'test', model: 'test', errorCode: null,
    });
    const report = buildSpeakingLearningReport(await repository.getSpeakingLearningAttempts(owner), {
      quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
    });
    const target = report.premium.targetedPractice;
    assert.ok(target);

    const effectiveRequestTime = new Date((await raw.query(
      'SELECT clock_timestamp() AS now',
    )).rows[0].now);
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let reportSettled = false;
    pendingSnapshot = repository.getSpeakingLearningReportSnapshot(owner, {
      now: effectiveRequestTime,
    }).finally(() => { reportSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(reportSettled, false, 'learning report must wait for the owner lock');
    await raw.query(
      `UPDATE subscription_entitlements SET ends_at = clock_timestamp()
       WHERE username = $1 AND entitlement = 'voice_tutor'`,
      [owner],
    );
    await raw.query('COMMIT');
    const revokedSnapshot = await pendingSnapshot;
    pendingSnapshot = null;
    assert.equal(revokedSnapshot.quota.tier, 'base',
      'report must evaluate entitlement after the owner lock, not at request time');

    const restoredAt = new Date((await raw.query(
      'SELECT clock_timestamp() AS now',
    )).rows[0].now);
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(restoredAt.getTime() - 1_000),
      endsAt: new Date(restoredAt.getTime() + 86_400_000),
    });
    const sessionsBeforeEffectiveRevoke = Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count);
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let effectiveAssignmentSettled = false;
    pending = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: target.sourceAttemptId,
        reportRevision: target.reportRevision,
        accentLocale: target.accentLocale,
        skillId: target.skillId,
        contentRef: target.contentRef,
      },
      now: restoredAt,
    }).finally(() => { effectiveAssignmentSettled = true; });
    const effectiveAssignmentRejection = assert.rejects(
      pending, /SPEAKING_TARGETED_PRACTICE_STALE/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(effectiveAssignmentSettled, false, 'targeted assignment must wait for the owner lock');
    await raw.query(
      `UPDATE subscription_entitlements SET ends_at = clock_timestamp()
       WHERE username = $1 AND entitlement = 'voice_tutor'`,
      [owner],
    );
    await raw.query('COMMIT');
    await effectiveAssignmentRejection;
    pending = null;
    assert.equal(Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count), sessionsBeforeEffectiveRevoke);
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(now.getTime() - 1_000),
      endsAt: new Date(now.getTime() + 86_400_000),
    });

    const followup = await repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      now: new Date(now.getTime() + 1_000),
    });
    for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
      now = new Date(now.getTime() + 12_000);
      await repository.completeSpeakingTask2Question(owner, followup.id, questionNumber, {
        recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
      }, { now });
    }
    const followupClaim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: { ad: 'Weather course', points: ['a', 'b', 'c', 'd'] },
      transcript: 'The weather course begins on Monday.',
    }, 'speaking-semantic-v4', crypto.createHash('sha256').update(`${owner}:target-race-followup`).digest('hex'), {
      now,
      source: {
        sessionId: followup.id, taskRef: followup.task_id, taskRevision: Number(followup.task_revision),
        catalogId: followup.catalog_id, catalogRevision: Number(followup.catalog_revision),
        assistanceUsed: false,
      },
    });

    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let finishSettled = false;
    pendingFinish = repository.finishSpeakingAttempt(followupClaim.attempt.id, {
      status: 'completed', review: targetedPracticeScoredReview(), provider: 'test', model: 'test', errorCode: null,
    }).finally(() => { finishSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(finishSettled, false, 'attempt completion must wait for the owner-scoped mutation transaction');
    let supersededSettled = false;
    pending = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: target.sourceAttemptId,
        reportRevision: target.reportRevision,
        accentLocale: target.accentLocale,
        skillId: target.skillId,
        contentRef: target.contentRef,
      },
      now: new Date(now.getTime() + 1_000),
    }).finally(() => { supersededSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(finishSettled, false, 'attempt completion must remain owner-locked before commit');
    assert.equal(supersededSettled, false, 'targeted assignment must wait behind the queued attempt completion');
    await raw.query('COMMIT');
    await pendingFinish;
    pendingFinish = null;
    await assert.rejects(pending, /SPEAKING_TARGETED_PRACTICE_STALE/u,
      'assignment must revalidate after the concurrently completed newer attempt');
    pending = null;

    const refreshedReport = buildSpeakingLearningReport(await repository.getSpeakingLearningAttempts(owner), {
      quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
    });
    const refreshedTarget = refreshedReport.premium.targetedPractice;
    assert.equal(refreshedTarget.sourceAttemptId, followupClaim.attempt.id);
    const sessionsBeforeAccentSwitch = Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count);
    await repository.setSpeakingAccentProfile(owner, {
      locale: 'en-US', source: 'manual', now: new Date(now.getTime() + 1_250),
    });
    await assert.rejects(repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: refreshedTarget.sourceAttemptId,
        reportRevision: refreshedTarget.reportRevision,
        accentLocale: refreshedTarget.accentLocale,
        skillId: refreshedTarget.skillId,
        contentRef: refreshedTarget.contentRef,
      },
      now: new Date(now.getTime() + 1_300),
    }), /SPEAKING_TARGETED_PRACTICE_STALE/u,
    'PostgreSQL must reject an en-GB pointer after the canonical profile moves to en-US');
    assert.equal(Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count), sessionsBeforeAccentSwitch);
    const usScopedReport = buildSpeakingLearningReport(
      await repository.getSpeakingLearningAttempts(owner),
      {
        quota: { tier: 'premium', limitSeconds: 14_400, remainingSeconds: 14_400 },
        activeAccentLocale: 'en-US',
      },
    );
    assert.equal(usScopedReport.activeAccentLocale, 'en-US');
    assert.equal(usScopedReport.premium.targetedPractice, null);
    assert.deepEqual(usScopedReport.premium.timeAllocationRecommendation, []);
    await repository.setSpeakingAccentProfile(owner, {
      locale: 'en-GB', source: 'manual', now: new Date(now.getTime() + 1_400),
    });
    const sessionsBeforeRevoke = Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count);
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let revokeSettled = false;
    const revoking = repository.revokeEntitlement(owner, 'voice_tutor', 7_700_099, {
      now: new Date(now.getTime() + 1_500),
    }).finally(() => { revokeSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(revokeSettled, false, 'Premium revocation must wait for the owner lock');
    let revokedAssignmentSettled = false;
    pending = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: refreshedTarget.sourceAttemptId,
        reportRevision: refreshedTarget.reportRevision,
        accentLocale: refreshedTarget.accentLocale,
        skillId: refreshedTarget.skillId,
        contentRef: refreshedTarget.contentRef,
      },
      now: new Date(now.getTime() + 2_000),
    }).finally(() => { revokedAssignmentSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(revokeSettled, false);
    assert.equal(revokedAssignmentSettled, false);
    await raw.query('COMMIT');
    assert.equal(await revoking, true);
    await assert.rejects(pending, /SPEAKING_TARGETED_PRACTICE_STALE/u,
      'assignment queued after revocation must revalidate entitlement and fail closed');
    pending = null;
    assert.equal(Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count), sessionsBeforeRevoke,
    'there must be no targeted session after completed revocation');
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(now.getTime() + 2_100), endsAt: new Date(now.getTime() + 86_400_000),
    });
    const profileBeforeAssistance = buildAdaptiveLearningProfile(
      await repository.getAdaptiveLearningEvidenceSources(owner),
    );

    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    await raw.query(
      `UPDATE speaking_accent_profiles
       SET locale = 'en-US', revision = revision + 1, effective_at = $2
       WHERE username = $1`,
      [owner, new Date(now.getTime() + 2_500)],
    );
    await raw.query(
      `UPDATE subscription_entitlements SET ends_at = $2
       WHERE username = $1 AND entitlement = 'voice_tutor'`,
      [owner, new Date(now.getTime() + 2_500)],
    );
    await raw.query(
      'UPDATE speaking_task2_sessions SET assistance_used = TRUE WHERE username = $1 AND id = $2',
      [owner, followup.id],
    );
    await raw.query(
      `UPDATE speaking_attempts SET assistance_used = TRUE, assistance_updated_at = $3
       WHERE username = $1 AND source_session_id = $2`,
      [owner, followup.id, new Date(now.getTime() + 2_000)],
    );
    let snapshotSettled = false;
    pendingSnapshot = repository.getSpeakingLearningReportSnapshot(owner, {
      now: new Date(now.getTime() + 3_000),
    }).finally(() => { snapshotSettled = true; });
    let settled = false;
    pending = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: refreshedTarget.sourceAttemptId,
        reportRevision: refreshedTarget.reportRevision,
        accentLocale: refreshedTarget.accentLocale,
        skillId: refreshedTarget.skillId,
        contentRef: refreshedTarget.contentRef,
      },
      now: new Date(now.getTime() + 3_000),
    }).finally(() => { settled = true; });
    const pendingAssignmentRejection = assert.rejects(
      pending, /SPEAKING_TARGETED_PRACTICE_STALE/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(snapshotSettled, false, 'the report snapshot must wait for the owner transaction');
    assert.equal(settled, false, 'assignment must wait for the owner-scoped mutation transaction');
    await raw.query('COMMIT');
    const coherentSnapshot = await pendingSnapshot;
    pendingSnapshot = null;
    assert.equal(coherentSnapshot.accentProfile.locale, 'en-US');
    assert.equal(coherentSnapshot.quota.tier, 'base');
    const invalidated = coherentSnapshot.attempts.find((item) => item.attemptId === followupClaim.attempt.id);
    assert.equal(invalidated.provenance.assistance, 'assisted');
    assert.equal(invalidated.masteryEligible, false);
    await pendingAssignmentRejection;
    pending = null;
    await assert.rejects(
      repository.saveAdaptiveLearningProfile(owner, profileBeforeAssistance, {
        now: new Date(now.getTime() + 4_000), verifyCurrentEvidence: true,
      }),
      /ADAPTIVE_PROFILE_EVIDENCE_STALE/u,
      'PostgreSQL must reject a profile snapshot captured before the owner-locked assistance update',
    );
  } finally {
    await raw.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    await pendingFinish?.catch(() => {});
    await pendingSnapshot?.catch(() => {});
    await raw.end();
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL Speaking learning snapshot rejects Base expiry committed before its owner lock', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`76${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Speaking report expiry ${stamp}`);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  let pending = null;
  try {
    await repository.grantDays(telegramId, 30, `Speaking report expiry ${stamp}`);
    const capturedRequestT0 = new Date((await raw.query('SELECT clock_timestamp() AS now')).rows[0].now);
    const expiresAt = new Date(capturedRequestT0.getTime() + 100);
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let settled = false;
    pending = repository.getSpeakingLearningReportSnapshot(owner, {
      now: capturedRequestT0,
    }).finally(() => { settled = true; });
    const rejection = assert.rejects(
      pending,
      (error) => error?.code === 'SUBSCRIPTION_REQUIRED',
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false, 'learning snapshot must wait for the owner lock');
    await raw.query(
      'UPDATE users SET subscription_until = $2 WHERE username = $1',
      [owner, expiresAt],
    );
    await raw.query('SELECT pg_sleep(0.15)');
    await raw.query('COMMIT');
    await rejection;
    pending = null;
  } finally {
    await raw.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    await raw.end();
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL targeted Speaking assignment rejects Base expiry before mutation', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const telegramId = Number(`75${stamp}`);
  const owner = await repository.createTelegramUser(telegramId, `Speaking targeted expiry ${stamp}`);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  let pending = null;
  try {
    let now = new Date();
    await repository.grantDays(telegramId, 30, `Speaking targeted expiry ${stamp}`);
    await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now });
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(now.getTime() - 1_000), endsAt: new Date(now.getTime() + 86_400_000),
    });
    const source = await repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      now,
    });
    for (let questionNumber = 1; questionNumber <= 4; questionNumber += 1) {
      now = new Date(now.getTime() + 12_000);
      await repository.completeSpeakingTask2Question(owner, source.id, questionNumber, {
        recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
      }, { now });
    }
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: { ad: 'Expiry', points: ['a', 'b', 'c', 'd'] },
      transcript: 'Four expiry race questions.',
    }, 'speaking-semantic-v4', crypto.createHash('sha256').update(`${owner}:base-expiry`).digest('hex'), {
      now,
      source: {
        sessionId: source.id, taskRef: source.task_id, taskRevision: Number(source.task_revision),
        catalogId: source.catalog_id, catalogRevision: Number(source.catalog_revision),
        assistanceUsed: false,
      },
    });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: targetedPracticeScoredReview(), provider: 'test', model: 'test', errorCode: null,
    });
    const snapshot = await repository.getSpeakingLearningReportSnapshot(owner);
    const target = buildSpeakingLearningReport(snapshot.attempts, {
      quota: snapshot.quota,
      activeAccentLocale: snapshot.accentProfile.locale,
    }).premium.targetedPractice;
    assert.ok(target);
    const sessionsBefore = Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count);
    const capturedRequestT0 = new Date((await raw.query('SELECT clock_timestamp() AS now')).rows[0].now);
    const expiresAt = new Date(capturedRequestT0.getTime() + 100);
    await raw.query('BEGIN');
    await raw.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [owner]);
    let settled = false;
    pending = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: target.sourceAttemptId,
        reportRevision: target.reportRevision,
        accentLocale: target.accentLocale,
        skillId: target.skillId,
        contentRef: target.contentRef,
      },
      now: capturedRequestT0,
    }).finally(() => { settled = true; });
    const rejection = assert.rejects(
      pending,
      (error) => error?.code === 'SUBSCRIPTION_REQUIRED',
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false, 'targeted assignment must wait for the owner lock');
    await raw.query(
      'UPDATE users SET subscription_until = $2 WHERE username = $1',
      [owner, expiresAt],
    );
    await raw.query('SELECT pg_sleep(0.15)');
    await raw.query('COMMIT');
    await rejection;
    pending = null;
    assert.equal(Number((await raw.query(
      'SELECT COUNT(*)::integer AS count FROM speaking_task2_sessions WHERE username = $1', [owner],
    )).rows[0].count), sessionsBefore);
  } finally {
    await raw.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    await raw.end();
    await repository.deleteUserData(owner).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL task 3 sessions match owner isolation, replay, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`84${stamp}`), `Task three owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`85${stamp}`), `Task three other ${stamp}`);
  try {
    await assertSpeakingTask3SessionRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL task 4 sessions match owner isolation, replay, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-8);
  const owner = await repository.createTelegramUser(Number(`86${stamp}`), `Task four owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`87${stamp}`), `Task four other ${stamp}`);
  try {
    await assertSpeakingTask4SessionRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL Reading report rows match the shared bounded ownership contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-9);
  const owner = await repository.createTelegramUser(Number(`2${stamp}`), `Reading report owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`3${stamp}`), `Reading report other ${stamp}`);
  try {
    await assertReadingReportRepositoryContract(assert, repository, owner, other, {
      task10: READING_TASK10_SETS[0], task11: READING_TASK11_SETS[0],
      task12_18: READING_TASK12_18_SETS[0],
    });
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL progress matches the Grammar mastery persistence contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  const stamp = String(Date.now()).slice(-9);
  const owner = await repository.createTelegramUser(Number(`4${stamp}`), `Grammar owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`5${stamp}`), `Grammar other ${stamp}`);
  const emptyCanonical = await repository.createTelegramUser(Number(`6${stamp}`), `Grammar empty ${stamp}`);
  try {
    await raw.connect();
    await raw.query(
      `INSERT INTO user_progress (username, data, updated_at)
       VALUES ($1, $2::jsonb, clock_timestamp())
       ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
      [emptyCanonical, JSON.stringify({
        grammarMastery: {},
        gram: { 1: { st: 2, ok: 8, err: 1, sr: 4, rs: 2, due: 12_345 } },
      })],
    );
    const restored = await repository.getProgress(emptyCanonical);
    assert.equal(restored.grammarMastery['1'].stage, 'learned');
    assert.equal(restored.grammarMastery['1'].stats.correct, 8);
    await assertGrammarMasteryProgressContract(repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.deleteUserData(emptyCanonical).catch(() => {});
    await raw.end().catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL word mastery matches the shared persistence, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-9);
  const owner = await repository.createTelegramUser(Number(`6${stamp}`), `Mastery owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`7${stamp}`), `Mastery other ${stamp}`);
  try {
    await assertWordProgressRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL personal words match the shared persistence, export and deletion contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-9);
  const owner = await repository.createTelegramUser(Number(`8${stamp}`), `Personal words owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`9${stamp}`), `Personal words other ${stamp}`);
  try {
    await assertPersonalWordsProgressRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL vocabulary summaries match the shared idempotency and ownership contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = String(Date.now()).slice(-9);
  const owner = await repository.createTelegramUser(Number(`4${stamp}`), `Vocabulary owner ${stamp}`);
  const other = await repository.createTelegramUser(Number(`5${stamp}`), `Vocabulary other ${stamp}`);
  try {
    await assertVocabularyAttemptRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL adaptive sessions match the shared replay, race, export and deletion contract', { skip: !connectionString }, async () => {
  let raceEnabled = false;
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const repository = createPostgresRepository(connectionString, {
    onAdaptiveSessionSnapshot: async ({ operation }) => {
      if (raceEnabled && operation === 'current') {
        reportSnapshotReached();
        await snapshotRelease;
      }
    },
  });
  const client = new pg.Client({ connectionString });
  const stamp = Date.now() + 5;
  const username = await repository.createTelegramUser(Number(`3${String(stamp).slice(-9)}`), `Session ${stamp}`);
  let speakingBindRaceChecked = false;
  await client.connect();
  try {
    await assertAdaptiveSessionRepositoryContract(assert, repository, username, {
      beforeSpeakingBind: async ({ sessionId, executionClaim, attempt, now }) => {
        if (speakingBindRaceChecked) return;
        const source = await repository.getSpeakingAttempt(username, attempt.id);
        const taskType = Number(source.task_type);
        assert.ok([1, 2, 3, 4].includes(taskType));
        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE speaking_task${taskType}_sessions SET assistance_used = TRUE
             WHERE username = $1 AND id = $2`,
            [username, source.source_session_id],
          );
          const binding = repository.bindAdaptiveLearningServerAttempt(username, {
            sessionId, executionClaim, attempt, now,
          });
          const early = await Promise.race([
            binding.then(() => 'fulfilled', () => 'rejected'),
            new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
          ]);
          assert.equal(early, 'pending', 'bind must wait for the canonical task-session lock');
          await client.query('COMMIT');
          await assert.rejects(binding, /ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH/u);
          const claim = await client.query(
            `SELECT consumed_at FROM adaptive_learning_execution_claims
             WHERE username = $1 AND token_hash = $2`,
            [username, adaptiveExecutionTokenHash(executionClaim)],
          );
          assert.equal(claim.rows[0]?.consumed_at, null);
          await client.query(
            `UPDATE speaking_task${taskType}_sessions SET assistance_used = FALSE
             WHERE username = $1 AND id = $2`,
            [username, source.source_session_id],
          );
          speakingBindRaceChecked = true;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      },
    });
    assert.equal(speakingBindRaceChecked, true, 'fixture must exercise a Speaking bind race');
    const recoveryReplayCount = Number((await client.query(
      `SELECT COUNT(*)::int AS count FROM adaptive_learning_session_mutations
       WHERE username = $1 AND operation = 'start' AND response_snapshot ? 'recoveryAttempt'`,
      [username],
    )).rows[0].count);
    assert.ok(recoveryReplayCount > 0);
    const legacyClaim = (await client.query(
      `SELECT claim.id, claim.session_id, mutation.idempotency_key
       FROM adaptive_learning_execution_claims claim
       JOIN adaptive_learning_session_mutations mutation
         ON mutation.username = claim.username
        AND mutation.session_id = claim.session_id
        AND mutation.operation = 'start'
        AND mutation.response_snapshot->>'executionClaimId' = claim.id::text
       WHERE claim.username = $1 ORDER BY claim.issued_at LIMIT 1`,
      [username],
    )).rows[0];
    assert.ok(legacyClaim);
    const legacyBearer = 'legacy-postgres-plaintext-execution-bearer';
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET consumed_at = NOW(), attempt_type = 'speaking', attempt_ref = '999999', revoked_at = NULL
       WHERE id = $1`,
      [legacyClaim.id],
    );
    await client.query(
      `UPDATE adaptive_learning_session_mutations
       SET response_snapshot = (response_snapshot - 'executionClaimId')
         || jsonb_build_object('executionClaim', $2::text)
       WHERE username = $1 AND idempotency_key = $3 AND operation = 'start'`,
      [username, legacyBearer, legacyClaim.idempotency_key],
    );
    const hardeningMigration = await fs.readFile(
      new URL('../migrations/036_adaptive_execution_hardening.sql', import.meta.url), 'utf8',
    );
    await client.query(hardeningMigration);
    const migratedClaim = (await client.query(
      'SELECT revoked_at FROM adaptive_learning_execution_claims WHERE id = $1', [legacyClaim.id],
    )).rows[0];
    assert.ok(migratedClaim.revoked_at, 'legacy consumed Speaking claim must be revoked during upgrade');
    assert.equal((await client.query(
      "SELECT 1 FROM adaptive_learning_session_mutations WHERE username = $1 AND idempotency_key = $2 AND operation = 'start'",
      [username, legacyClaim.idempotency_key],
    )).rowCount, 0);
    assert.ok((await client.query(
      `SELECT 1 FROM adaptive_learning_session_mutations
       WHERE username = $1 AND operation = 'start' AND response_snapshot ? 'executionClaimId'`,
      [username],
    )).rowCount > 0, 'post-upgrade HMAC starts survive an idempotent migration rerun');
    assert.equal(Number((await client.query(
      `SELECT COUNT(*)::int AS count FROM adaptive_learning_session_mutations
       WHERE username = $1 AND operation = 'start' AND response_snapshot ? 'recoveryAttempt'`,
      [username],
    )).rows[0].count), recoveryReplayCount, 'durable recovery starts survive a migration rerun');
    assert.equal((await client.query(
      'SELECT 1 FROM adaptive_learning_session_mutations WHERE response_snapshot::text LIKE $1',
      [`%${legacyBearer}%`],
    )).rowCount, 0);
    const before = (await client.query(
      `SELECT session.id, session.completion_summary,
              (SELECT COUNT(*)::int FROM adaptive_learning_session_events event
               WHERE event.session_id = session.id) AS event_count
       FROM adaptive_learning_sessions session WHERE session.username = $1`,
      [username],
    )).rows[0];
    raceEnabled = true;
    const reading = repository.getAdaptiveLearningSessionExecution(username, before.id);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SESSION_READ_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO adaptive_learning_session_events
       (id, username, session_id, sequence, event_type, planned_minutes, created_at)
       VALUES ($1, $2, $3, $4, 'session_finished', 0, NOW())`,
      [crypto.randomUUID(), username, before.id, before.event_count + 1],
    );
    await client.query(
      `UPDATE adaptive_learning_sessions SET completion_summary = '{"race":true}'::jsonb WHERE id = $1`,
      [before.id],
    );
    await client.query('COMMIT');
    releaseSnapshot();
    const consistent = await reading;
    assert.deepEqual(consistent.summary, before.completion_summary);
    assert.equal(consistent.events.length, before.event_count,
      'session and events must come from the same MVCC snapshot');
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getCurrentAdaptiveLearningSession(username), null);
    assert.equal((await repository.getAdaptiveLearningMetrics()).sessions.created, 0);
  } finally {
    releaseSnapshot?.();
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL adaptive plan revisions match the shared persistence and export contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = Date.now() + 4;
  const username = await repository.createTelegramUser(Number(`4${String(stamp).slice(-9)}`), `Plan ${stamp}`);
  try {
    await assertAdaptivePlanRepositoryContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getCurrentAdaptiveLearningPlan(username), null);
  } finally {
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL upgrades a realistically persisted v1 plan to the v2 taxonomy atomically', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  const stamp = Date.now() + 14;
  const username = await repository.createTelegramUser(Number(`3${String(stamp).slice(-9)}`), `Plan upgrade ${stamp}`);
  try {
    const goal = (await repository.saveAdaptiveLearningGoal(username, {
      id: crypto.randomUUID(), idempotencyKey: `plan-upgrade-${stamp}`, requestHash: 'f'.repeat(64),
      targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
      now: new Date('2026-08-04T08:00:00.000Z'),
    })).goal;
    const profile = buildAdaptiveLearningProfile();
    await repository.saveAdaptiveLearningProfile(username, profile, {
      now: new Date('2026-08-04T08:30:00.000Z'),
    });
    const firstNow = new Date('2026-08-04T09:00:00.000Z');
    const firstPlan = buildAdaptiveLearningPlan({ goal, profile, now: firstNow });
    await repository.saveAdaptiveLearningPlan(username, {
      id: crypto.randomUUID(),
      inputFingerprint: adaptivePlanInputFingerprint({ goal, profile, basePlanRevision: null, now: firstNow }),
      basePlanRevision: null, goalId: goal.id, goalRevision: goal.revision,
      taxonomyVersion: profile.taxonomyVersion,
      profileCalculationRevision: profile.profileCalculationRevision,
      profileEvidenceWatermarkVersion: profile.evidenceWatermarkVersion,
      profileEvidenceObservedAt: profile.evidenceObservedAt,
      profileEvidenceSourceCount: profile.evidenceSourceCount,
      profileEvidenceFingerprint: profile.evidenceFingerprint,
      recalculationBucket: firstPlan.recalculationBucket, plan: firstPlan, now: firstNow,
    });
    const legacyAllocation = structuredClone(firstPlan.allocation);
    const speakingPercentage = legacyAllocation.modules.find((item) => item.id === 'speaking').percentage;
    legacyAllocation.skills = legacyAllocation.skills.filter((item) => item.module !== 'speaking').concat([
      { id: 'ege.speaking.interaction', label: 'Interaction', module: 'speaking', percentage: Math.floor(speakingPercentage / 2), activityType: 'practice', reasonCodes: [] },
      { id: 'ege.speaking.monologue', label: 'Monologue', module: 'speaking', percentage: Math.ceil(speakingPercentage / 2), activityType: 'practice', reasonCodes: [] },
    ]);
    await raw.query(
      `UPDATE adaptive_learning_plan_revisions
       SET taxonomy_version = 'ege-en-v1', allocation = $2::jsonb,
           profile_evidence_fingerprint = NULL
       WHERE username = $1 AND current`,
      [username, JSON.stringify(legacyAllocation)],
    );

    const previousPlan = await repository.getCurrentAdaptiveLearningPlan(username);
    assert.equal(previousPlan.profile_evidence_fingerprint, null,
      'migration 052 keeps legacy PostgreSQL plans readable without a fingerprint');
    const nextNow = new Date('2026-08-05T09:00:00.000Z');
    const nextPlan = buildAdaptiveLearningPlan({ goal, profile, previousPlan, now: nextNow });
    const saved = await repository.saveAdaptiveLearningPlan(username, {
      id: crypto.randomUUID(),
      inputFingerprint: adaptivePlanInputFingerprint({ goal, profile, basePlanRevision: 1, now: nextNow }),
      basePlanRevision: 1, goalId: goal.id, goalRevision: goal.revision,
      taxonomyVersion: profile.taxonomyVersion,
      profileCalculationRevision: profile.profileCalculationRevision,
      profileEvidenceWatermarkVersion: profile.evidenceWatermarkVersion,
      profileEvidenceObservedAt: profile.evidenceObservedAt,
      profileEvidenceSourceCount: profile.evidenceSourceCount,
      profileEvidenceFingerprint: profile.evidenceFingerprint,
      recalculationBucket: nextPlan.recalculationBucket, plan: nextPlan, now: nextNow,
    });
    assert.equal(saved.created, true);
    assert.equal(saved.plan.taxonomy_version, 'ege-en-v2');
    assert.equal(saved.plan.profile_evidence_fingerprint, profile.evidenceFingerprint);
    assert.equal(saved.plan.stability.bypassReason, 'taxonomy_changed');
    assert.equal(saved.plan.allocation.skills.every((item) => Number.isFinite(item.percentage)), true);
  } finally {
    await repository.deleteUserData(username).catch(() => {});
    await raw.end();
    await repository.close();
  }
});

test('PostgreSQL adaptive diagnostic matches the shared persistence and export contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = Date.now() + 3;
  const username = await repository.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Diagnostic ${stamp}`);
  try {
    await assertAdaptiveDiagnosticRepositoryContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.exportUserData(username), null);
    assert.equal(await repository.getCurrentAdaptiveDiagnostic(username), null);
  } finally {
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL adaptive profile save does not exhaust the primary pool before reading its result', { skip: !connectionString }, () => {
  const script = `
    const { createPostgresRepository } = await import('./storage/postgres-repository.js');
    const { buildAdaptiveLearningProfile } = await import('./adaptive-learning/profile.js');
    const repository = createPostgresRepository(process.env.TEST_DATABASE_URL);
    const stamp = Date.now();
    const users = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      repository.createTelegramUser(Number('7' + String(stamp + index).slice(-9)), 'Pool ' + stamp + ' ' + index)));
    const profile = buildAdaptiveLearningProfile();
    await Promise.all(users.map((username) => repository.saveAdaptiveLearningProfile(username, profile)));
    await repository.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DATABASE_URL: connectionString },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.error?.code || null, null, result.error?.message || result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test('PostgreSQL adaptive save returns one transaction snapshot and blocks a newer writer until capture', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  let paused = false;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const repository = createPostgresRepository(connectionString, {
    onAdaptiveProfileSnapshot: async ({ profile }) => {
      if (!paused && Number(profile.evidence_source_count) === 1) {
        paused = true;
        reportSnapshotReached();
        await snapshotRelease;
      }
    },
  });
  const stamp = Date.now();
  const username = await repository.createTelegramUser(Number(`6${String(stamp).slice(-9)}`), `Atomic ${stamp}`);
  const attempt = (id, createdAt, score) => ({
    id, module: 'grammar', activity: 'grammar_19_24', score, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  });
  const first = attempt(crypto.randomUUID(), '2026-08-04T05:00:00.000Z', 2);
  const second = attempt(crypto.randomUUID(), '2026-08-04T06:00:00.000Z', 10);

  try {
    const olderSave = repository.saveAdaptiveLearningProfile(
      username,
      buildAdaptiveLearningProfile({ attempts: [first] }),
      { now: new Date('2026-08-04T07:00:00.000Z') },
    );
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ATOMIC_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    let newerFinished = false;
    const newerSave = repository.saveAdaptiveLearningProfile(
      username,
      buildAdaptiveLearningProfile({ attempts: [first, second] }),
      { now: new Date('2026-08-04T07:01:00.000Z') },
    ).then((result) => { newerFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(newerFinished, false, 'newer writer waits while the older transaction captures its DTO');
    releaseSnapshot();
    const [olderResult, newerResult] = await Promise.all([olderSave, newerSave]);
    assert.equal(olderResult.evidence_source_count, 1);
    assert.equal(newerResult.evidence_source_count, 2);
    for (const result of [olderResult, newerResult]) {
      assert.ok(result.estimates.every((estimate) => estimate.updated_at === result.updated_at));
    }
  } finally {
    releaseSnapshot?.();
    await repository.close();
  }
});

test('PostgreSQL adaptive get returns profile and estimates from one MVCC snapshot', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const writer = createPostgresRepository(connectionString);
  const reader = createPostgresRepository(connectionString, {
    onAdaptiveProfileSnapshot: async () => {
      reportSnapshotReached();
      await snapshotRelease;
    },
  });
  const stamp = Date.now();
  const username = await writer.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Profile read ${stamp}`);
  const attempt = (createdAt) => ({
    id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  });
  const first = attempt('2026-08-04T05:00:00.000Z');
  const second = attempt('2026-08-04T06:00:00.000Z');

  try {
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first] }), {
      now: new Date('2026-08-04T07:00:00.000Z'),
    });
    const reading = reader.getAdaptiveLearningProfile(username);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('PROFILE_READ_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first, second] }), {
      now: new Date('2026-08-04T07:01:00.000Z'),
    });
    releaseSnapshot();
    const result = await reading;
    assert.equal(result.evidence_source_count, 1);
    assert.ok(result.estimates.every((estimate) => estimate.updated_at === result.updated_at));
  } finally {
    releaseSnapshot?.();
    await Promise.all([reader.close(), writer.close()]);
  }
});

test('PostgreSQL adaptive export captures profile and estimates atomically', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const writer = createPostgresRepository(connectionString);
  const reader = createPostgresRepository(connectionString, {
    onAdaptiveProfileSnapshot: async () => {
      reportSnapshotReached();
      await snapshotRelease;
    },
  });
  const stamp = Date.now() + 1;
  const username = await writer.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Profile export ${stamp}`);
  const attempt = (createdAt) => ({
    id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  });
  const first = attempt('2026-08-04T05:00:00.000Z');
  const second = attempt('2026-08-04T06:00:00.000Z');

  try {
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first] }), {
      now: new Date('2026-08-04T07:00:00.000Z'),
    });
    const exporting = reader.exportUserData(username);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('PROFILE_EXPORT_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first, second] }), {
      now: new Date('2026-08-04T07:01:00.000Z'),
    });
    releaseSnapshot();
    const result = await exporting;
    assert.equal(result.adaptive_learning_profile.evidence_source_count, 1);
    assert.ok(result.adaptive_learning_skill_estimates.every((estimate) => (
      estimate.updated_at === result.adaptive_learning_profile.updated_at
    )));
  } finally {
    releaseSnapshot?.();
    await Promise.all([reader.close(), writer.close()]);
  }
});

test('PostgreSQL adaptive evidence sources come from one MVCC snapshot without orphan repeats', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const repository = createPostgresRepository(connectionString, {
    onAdaptiveEvidenceSnapshot: async () => {
      reportSnapshotReached();
      await snapshotRelease;
    },
  });
  const client = new pg.Client({ connectionString });
  const stamp = Date.now() + 2;
  const username = await repository.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Evidence read ${stamp}`);
  const sessionId = crypto.randomUUID();
  const recoveryId = crypto.randomUUID();
  const repeatId = crypto.randomUUID();
  const repeatAttemptId = crypto.randomUUID();
  await client.connect();

  try {
    const reading = repository.getAdaptiveLearningEvidenceSources(username);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('EVIDENCE_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO voice_tutor_sessions
       (id, username, idempotency_key, status, reserved_seconds, billable_seconds, started_at, expires_at, ended_at)
       VALUES ($1, $2, $3, 'completed', 1, 0, $4, $5, $5)`,
      [sessionId, username, crypto.randomUUID(), new Date('2026-08-04T08:00:00.000Z'), new Date('2026-08-04T08:05:00.000Z')],
    );
    await client.query(
      `INSERT INTO voice_tutor_recoveries
       (id, username, session_id, skill_id, skill_label, module, rule_id, origin_item_id,
        origin_transfer_task_id, initial_micro_check_passed, initial_transfer_passed,
        terminal_outcome, potential_ege_points, observed_at)
       VALUES ($1, $2, $3, 'ege.grammar.forms', 'Forms', 'grammar', 'rule', 'item',
               'transfer', TRUE, TRUE, 'resolved', 1, $4)`,
      [recoveryId, username, sessionId, new Date('2026-08-04T08:04:00.000Z')],
    );
    await client.query(
      `INSERT INTO voice_tutor_repeats
       (id, recovery_id, stage, task_id, due_at, window_ends_at)
       VALUES ($1, $2, 'day_1', 'task', $3, $4)`,
      [repeatId, recoveryId, new Date('2026-08-05T08:00:00.000Z'), new Date('2026-08-06T08:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO voice_tutor_repeat_attempts (id, repeat_id, task_id, passed, fingerprint, observed_at)
       VALUES ($1, $2, 'task', TRUE, $3, $4)`,
      [repeatAttemptId, repeatId, 'b'.repeat(64), new Date('2026-08-05T09:00:00.000Z')],
    );
    await client.query('COMMIT');
    releaseSnapshot();
    const result = await reading;
    assert.deepEqual(result.recoveries, []);
    assert.deepEqual(result.repeatAttempts, []);
  } finally {
    releaseSnapshot?.();
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL adaptive evidence bounds Speaking rows before JSON hydration', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const stamp = Date.now() + 3;
  const username = await repository.createTelegramUser(
    Number(`5${String(stamp).slice(-9)}`), `Speaking evidence bound ${stamp}`,
  );
  const semanticFacts = {
    confidence: 0.95, verdict: 'Scored.', evidence: ['Read aloud.'], issues: [],
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.96, signalQuality: 'good',
    recordingDurationSeconds: 30, itemDurations: [], completenessScore: 95,
    fluencyScore: 90, wordAccuracyScore: 94, phonemeAccuracyScore: 93, wordEvents: [],
  };
  const review = {
    ...publicSpeakingReview(
      scoreSpeakingTask({ taskType: 1, semantic: semanticFacts, acoustic: acousticFacts }),
      semanticFacts,
    ),
    semanticFacts, acousticFacts,
  };
  await client.connect();
  try {
    await client.query(
      `INSERT INTO speaking_attempts
       (username, task_type, assignment, transcript, review, provider, prompt_version, status,
        source_session_id, source_task_ref, source_task_revision, source_catalog_id,
        source_catalog_revision, assistance_used, accent_locale, created_at, evaluated_at)
       SELECT $1, 1, '{}'::jsonb, 'Attempt ' || series.id, $2::jsonb, 'test',
              'speaking-semantic-v4', 'completed', $4::uuid, 'task-' || series.id, 1,
              'speaking-pilot-v1', 1, FALSE, 'en-GB',
              $3::timestamptz + series.id * interval '1 second',
              $3::timestamptz + (CASE WHEN series.id = 124 THEN 125 ELSE series.id END) * interval '1 second'
       FROM generate_series(1, 125) AS series(id)`,
      [username, JSON.stringify(review), new Date('2026-08-01T00:00:00.000Z'), crypto.randomUUID()],
    );

    const sources = await repository.getAdaptiveLearningEvidenceSources(username);
    const speakingSourceIds = [...new Set(sources.attempts
      .filter((entry) => entry.module === 'speaking')
      .map((entry) => entry.metadata.source_attempt_id))];
    assert.equal(speakingSourceIds.length, 120);
    const storedIds = (await client.query(
      `SELECT id::text FROM speaking_attempts WHERE username = $1
       ORDER BY COALESCE(evaluated_at, created_at) DESC, id DESC`,
      [username],
    )).rows.map((row) => `speaking:${row.id}`);
    assert.deepEqual(speakingSourceIds.slice(0, 2), storedIds.slice(0, 2));
    assert.deepEqual(speakingSourceIds, storedIds.slice(0, 120));
  } finally {
    await client.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL binds an exact Voice Tutor repeat to an adaptive retention claim without copied content', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const stamp = Date.now() + 8;
  const username = await repository.createTelegramUser(Number(`6${String(stamp).slice(-9)}`), `Retention ${stamp}`);
  const instant = new Date();
  const relative = (milliseconds) => new Date(instant.getTime() + milliseconds);
  const voiceSessionId = crypto.randomUUID();
  const olderVoiceSessionId = crypto.randomUUID();
  const recoveryId = crypto.randomUUID();
  const olderRecoveryId = crypto.randomUUID();
  const repeatId = crypto.randomUUID();
  const olderRepeatId = crypto.randomUUID();
  const daySevenId = crypto.randomUUID();
  const repeatTaskId = `voice-repeat.${recoveryId}.day_1.v1`;
  const olderRepeatTaskId = `voice-repeat.${olderRecoveryId}.day_1.v1`;
  await client.connect();
  try {
    await client.query(
      `INSERT INTO voice_tutor_sessions
       (id, username, idempotency_key, status, reserved_seconds, billable_seconds, started_at, expires_at, ended_at)
       VALUES ($1, $2, $3, 'completed', 1, 0, $4, $5, $5),
              ($6, $2, $7, 'completed', 1, 0, $8, $9, $9)`,
      [voiceSessionId, username, crypto.randomUUID(), relative(-24 * 60 * 60_000),
        relative(-24 * 60 * 60_000 + 5 * 60_000), olderVoiceSessionId, crypto.randomUUID(),
        relative(-48 * 60 * 60_000), relative(-48 * 60 * 60_000 + 5 * 60_000)],
    );
    await client.query(
      `INSERT INTO voice_tutor_recoveries
       (id, username, session_id, skill_id, skill_label, module, rule_id, origin_item_id,
        origin_transfer_task_id, initial_micro_check_passed, initial_transfer_passed,
        terminal_outcome, potential_ege_points, repeat_tasks, observed_at)
       VALUES ($1, $2, $3, 'ege.grammar.forms', 'Forms', 'grammar', 'rule', 'item',
               'transfer', TRUE, TRUE, 'resolved', 1, $4::jsonb, $5),
              ($6, $2, $7, 'ege.grammar.forms', 'Forms', 'grammar', 'rule', 'item',
               'transfer', TRUE, TRUE, 'resolved', 1, $4::jsonb, $8)`,
      [recoveryId, username, voiceSessionId, JSON.stringify({
        day_1: { prompt: 'This prompt must stay in Voice Tutor.', answers: ['was built'] },
        day_7: { prompt: 'Another private prompt.', answers: ['were built'] },
      }), relative(-24 * 60 * 60_000 + 4 * 60_000), olderRecoveryId, olderVoiceSessionId,
        relative(-48 * 60 * 60_000 + 4 * 60_000)],
    );
    await client.query(
      `INSERT INTO voice_tutor_repeats
       (id, recovery_id, stage, task_id, due_at, window_ends_at)
       VALUES ($1, $2, 'day_1', $3, $4, $5),
              ($6, $2, 'day_7', $7, $8, $9),
              ($10, $11, 'day_1', $12, $13, $14)`,
      [repeatId, recoveryId, repeatTaskId, relative(-60 * 60_000),
        relative(4 * 60 * 60_000), daySevenId,
        `voice-repeat.${recoveryId}.day_7.v1`, relative(6 * 24 * 60 * 60_000),
        relative(7 * 24 * 60 * 60_000), olderRepeatId, olderRecoveryId,
        olderRepeatTaskId, relative(-2 * 60 * 60_000),
        relative(5 * 60 * 60_000)],
    );

    const goal = (await repository.saveAdaptiveLearningGoal(username, {
      id: crypto.randomUUID(), idempotencyKey: 'postgres-retention-goal-01', requestHash: '6'.repeat(64),
      targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
      now: instant,
    })).goal;
    const sources = await repository.getAdaptiveLearningEvidenceSources(username);
    const baseProfile = buildAdaptiveLearningProfile(sources);
    const recoveryMap = await repository.getVoiceTutorRecoveryMap(username, { now: instant });
    const retention = buildAdaptiveRetentionState({
      profile: baseProfile, recoveryMap, diagnosticCompletions: [], now: instant,
    });
    const calculatedProfile = applyAdaptiveRetentionState(baseProfile, retention);
    const storedProfile = await repository.saveAdaptiveLearningProfile(username, calculatedProfile, { now: instant });
    const profile = adaptiveLearningProfilePublicDto(storedProfile);
    const calculatedPlan = buildAdaptiveLearningPlan({ goal, profile, now: instant });
    const storedPlan = (await repository.saveAdaptiveLearningPlan(username, {
      id: crypto.randomUUID(),
      inputFingerprint: adaptivePlanInputFingerprint({ goal, profile, basePlanRevision: null, now: instant }),
      basePlanRevision: null, goalId: goal.id, goalRevision: goal.revision,
      taxonomyVersion: profile.taxonomyVersion,
      profileCalculationRevision: profile.profileCalculationRevision,
      profileEvidenceWatermarkVersion: profile.evidenceWatermarkVersion,
      profileEvidenceObservedAt: profile.evidenceObservedAt,
      profileEvidenceSourceCount: profile.evidenceSourceCount,
      profileEvidenceFingerprint: profile.evidenceFingerprint,
      recalculationBucket: calculatedPlan.recalculationBucket, plan: calculatedPlan, now: instant,
    })).plan;
    const publicPlan = {
      id: storedPlan.id, revision: storedPlan.revision, version: storedPlan.plan_version,
      taxonomyVersion: storedPlan.taxonomy_version, allocation: storedPlan.allocation,
    };
    const preview = buildAdaptiveSessionPreview({
      plan: publicPlan, goal, profile, retention, weekUsage: [], durationMinutes: 15, now: instant,
      access: { tier: 'base', capabilities: { premiumDepth: false } },
    });
    assert.equal(preview.blocks[0].activityId, 'voice_tutor_recovery');
    assert.equal(preview.blocks[0].launch.repeatId, repeatId);
    assert.equal(preview.blocks[0].launch.taskId, repeatTaskId);
    assert.equal(JSON.stringify(preview).includes('This prompt must stay'), false);
    const session = createAdaptiveLearningSessionFromPreview(preview, { id: crypto.randomUUID(), now: instant });
    const created = await repository.createAdaptiveLearningSession(username, {
      idempotencyKey: 'postgres-retention-create-1',
      requestHash: crypto.createHash('sha256').update(JSON.stringify([15, preview.previewFingerprint])).digest('hex'),
      planId: publicPlan.id, planRevision: publicPlan.revision,
      previewFingerprint: preview.previewFingerprint, session, now: instant,
    });
    const block = created.session.blocks[0];
    const claimId = crypto.randomUUID();
    const token = adaptiveExecutionToken(claimId, 'postgres-retention-secret-32-characters');
    const startBody = { blockId: block.id, expectedRevision: 0 };
    const started = await repository.startAdaptiveLearningSessionBlock(username, {
      operation: 'start', sessionId: created.session.id, ...startBody,
      idempotencyKey: 'postgres-retention-start-01', requestHash: adaptiveExecutionRequestHash(startBody),
      claimId, token, tokenHash: adaptiveExecutionTokenHash(token),
      expiresAt: relative(2 * 60 * 60_000), now: relative(60_000),
      evidenceContext: adaptiveEvidenceContext(block),
      responseSnapshot: {
        session: { ...created.session, status: 'in_progress', updatedAt: relative(60_000).toISOString() },
        execution: {
          version: 'adaptive-execution-v1', revision: 1, status: 'in_progress', currentBlockId: block.id,
          completedBlockIds: [], readyToFinish: false, startedAt: relative(60_000).toISOString(), completedAt: null,
        },
        block, launch: block.launch, executionClaimId: claimId,
        claimExpiresAt: relative(2 * 60 * 60_000).toISOString(), evidenceContext: adaptiveEvidenceContext(block),
      },
    });
    const storedClaim = (await client.query(
      `SELECT issued_at, expires_at FROM adaptive_learning_execution_claims
       WHERE id = $1 AND username = $2`,
      [claimId, username],
    )).rows[0];
    assert.equal(
      new Date(storedClaim.expires_at).getTime() - new Date(storedClaim.issued_at).getTime(),
      ADAPTIVE_EXECUTION_CLAIM_TTL_MS,
    );
    assert.equal(started.responseSnapshot.claimExpiresAt, new Date(storedClaim.expires_at).toISOString());
    const mismatchedAttemptId = crypto.randomUUID();
    await assert.rejects(repository.submitVoiceTutorRepeat(username, olderRepeatId, {
      attemptId: mismatchedAttemptId, taskId: olderRepeatTaskId, answer: 'was built',
      adaptiveExecutionClaim: token, adaptiveSessionId: created.session.id,
      now: relative(90_000),
    }), /ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH/u);
    const mismatchedStored = await client.query(
      'SELECT id FROM voice_tutor_repeat_attempts WHERE id = $1', [mismatchedAttemptId],
    );
    assert.equal(mismatchedStored.rowCount, 0,
      'PostgreSQL must roll back repeat persistence when exact adaptive binding fails');
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() - interval '1 millisecond'
       WHERE id = $1 AND username = $2`,
      [claimId, username],
    );
    const expiredAttemptId = crypto.randomUUID();
    await assert.rejects(repository.submitVoiceTutorRepeat(username, repeatId, {
      attemptId: expiredAttemptId, taskId: repeatTaskId, answer: 'was built',
      adaptiveExecutionClaim: token, adaptiveSessionId: created.session.id,
      now: relative(120_000),
    }), /ADAPTIVE_EXECUTION_CLAIM_EXPIRED/u);
    assert.equal((await client.query(
      'SELECT id FROM voice_tutor_repeat_attempts WHERE id = $1', [expiredAttemptId],
    )).rowCount, 0);
    await client.query(
      `UPDATE adaptive_learning_execution_claims
       SET expires_at = clock_timestamp() + interval '2 hours'
       WHERE id = $1 AND username = $2`,
      [claimId, username],
    );
    const attempt = await repository.submitVoiceTutorRepeat(username, repeatId, {
      attemptId: crypto.randomUUID(), taskId: repeatTaskId, answer: 'was built',
      adaptiveExecutionClaim: token, adaptiveSessionId: created.session.id,
      now: relative(120_000),
    });
    assert.equal(attempt.adaptiveExecution.evidenceQuality, 'server_verified_unassisted');
    const context = await repository.getAdaptiveLearningSessionAdvanceContext(username, {
      sessionId: created.session.id, blockId: block.id, expectedRevision: 1,
      attempt: { type: 'voice_tutor_repeat', id: attempt.attempt.id },
      now: relative(180_000),
    });
    assert.equal(context.source.source_type, 'voice_tutor_repeat');
    assert.equal(context.source.evidence_quality, 'server_verified_unassisted');
    assert.equal(context.source.evidence_context, 'scheduled_review');
  } finally {
    await client.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL repository persists the production data flow', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const telegramId = Number(`8${Date.now().toString().slice(-9)}`);
  const independentActorTelegramId = telegramId + 1;
  await client.connect();

  try {
    const migrations = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(migrations.rows.map((row) => row.version), [
      '001_initial.sql', '002_telegram_auth_codes.sql', '003_writing_attempt_error_code.sql',
      '004_privacy_consents.sql', '005_ai_token_usage.sql', '006_ai_estimated_cost.sql', '007_sessions.sql',
      '008_user_roles.sql',
      '009_subscriptions_and_payments.sql',
      '010_speaking_attempts.sql',
      '011_generated_tasks.sql',
      '012_module_attempts.sql',
      '013_word_progress.sql',
      '014_error_bank.sql',
      '015_audit_log.sql',
      '016_progress_summary.sql',
      '017_ai_fallback_reason.sql',
      '018_task_bank.sql',
      '019_attempt_models.sql',
      '020_writing_evaluated_answer.sql',
      '021_voice_tutor_entitlements_and_quotas.sql',
      '022_voice_tutor_tracer.sql',
      '023_trusted_rule_cards.sql',
      '024_voice_tutor_recovery_map.sql',
      '025_voice_tutor_hardening.sql',
      '026_premium_voice_commerce.sql',
      '027_voice_tutor_pedagogical_loop.sql',
      '028_voice_tutor_discovery_claims.sql',
      '029_voice_tutor_realtime_proxy.sql',
      '030_voice_tutor_fallback_and_recovery_tasks.sql',
      '031_adaptive_learning_goal_profile.sql',
      '032_adaptive_short_diagnostic.sql',
      '033_adaptive_learning_plan.sql',
      '034_adaptive_learning_sessions.sql',
      '035_adaptive_session_execution.sql',
      '036_adaptive_execution_hardening.sql',
      '037_adaptive_retention_premium.sql',
      '038_adaptive_commercial_scope.sql',
      '039_adaptive_metrics_window_indexes.sql',
      '040_word_mastery.sql',
      '041_speaking_task1_sessions.sql',
      '042_speaking_task2_sessions.sql',
      '043_speaking_task3_sessions.sql',
      '044_speaking_task4_sessions.sql',
      '045_speaking_full_sessions.sql',
      '046_speaking_pronunciation_assessments.sql',
      '047_speaking_assessment_context.sql',
      '048_speaking_evaluation_idempotency.sql',
      '049_speaking_accent_calibration.sql',
      '050_speaking_learning_loop.sql',
      '051_adaptive_profile_evidence_fingerprint.sql',
      '052_adaptive_plan_evidence_fingerprint.sql',
      '053_ege_mock_attempts.sql',
    ]);

    const username = await repository.createTelegramUser(telegramId, `Integration ${suffix}`);
    assert.equal((await repository.getUser(username)).telegram_id, telegramId);
    assert.equal(await repository.setUserRole(username, 'admin'), 'admin');
    assert.equal((await repository.getUser(username)).role, 'admin');
    const ruleCardId = crypto.randomUUID();
    await repository.createRuleCard({
      id: ruleCardId, createdForUsername: username, status: 'pending_review',
      skill: { id: `ege.grammar.integration.${suffix}`, title: 'Integration rule' }, examYear: 2026,
      rule: { title: 'Integration rule', explanation: 'A bounded explanation.', examples: ['It works.'] },
      agreementHash: 'a'.repeat(64),
      sources: [
        { authority: 'one', url: 'https://one.example/rule', retrieved_at: new Date().toISOString(), content_hash: 'b'.repeat(64) },
        { authority: 'two', url: 'https://two.example/rule', retrieved_at: new Date().toISOString(), content_hash: 'c'.repeat(64) },
      ],
      discrepancies: [], createdAt: new Date(),
    });
    assert.equal((await repository.getApprovedRuleCard(`ege.grammar.integration.${suffix}`, 2026)), null);
    assert.equal((await repository.reviewRuleCard(ruleCardId, { decision: 'approved', reviewer: username, reviewedAt: new Date() })).applied, true);
    assert.equal((await repository.reviewRuleCard(ruleCardId, { decision: 'approved', reviewer: username, reviewedAt: new Date() })).applied, false);
    assert.equal((await repository.getApprovedRuleCard(`ege.grammar.integration.${suffix}`, 2026)).status, 'approved');
    const ruleReportId = crypto.randomUUID();
    await repository.createRuleCard({
      id: ruleReportId, createdForUsername: username, status: 'pending_review',
      skill: { id: `ege.grammar.report.${suffix}`, title: 'Integration report' }, examYear: 2026,
      rule: { title: 'Integration report', explanation: 'Pending bounded evidence.', examples: ['It may work.'] },
      agreementHash: 'd'.repeat(64),
      sources: [
        { authority: 'one', url: 'https://one.example/report', retrieved_at: new Date().toISOString(), content_hash: 'e'.repeat(64) },
        { authority: 'two', url: 'https://two.example/report', retrieved_at: new Date().toISOString(), content_hash: 'f'.repeat(64) },
      ],
      discrepancies: [], createdAt: new Date(),
    });

    const trial = await repository.activateTrial(telegramId, 30, 'Integration User');
    assert.equal(trial.applied, true);
    assert.equal((await repository.activateTrial(telegramId, 30, 'Integration User')).applied, false);

    const paymentRequest = await repository.createPaymentRequest(crypto.randomUUID(), telegramId, 'Integration User');
    const approvedPayment = await repository.resolvePaymentRequest(paymentRequest.id, 'approved', independentActorTelegramId, 30);
    assert.equal(approvedPayment.applied, true);
    assert.equal(approvedPayment.product, 'base');
    assert.equal((await repository.resolvePaymentRequest(paymentRequest.id, 'approved', independentActorTelegramId, 30)).applied, false);

    const premiumRequest = await repository.createPaymentRequestForUser(crypto.randomUUID(), username, 'premium_voice');
    assert.equal((await repository.listPaymentRequests({ product: 'premium_voice', status: 'new' })).some((request) => request.id === premiumRequest.id), true);
    await assert.rejects(
      repository.resolvePaymentRequest(premiumRequest.id, 'approved', telegramId, 30),
      /PAYMENT_SELF_APPROVAL_FORBIDDEN/u,
    );
    const premiumNow = new Date();
    const premiumApproval = await repository.resolvePaymentRequest(premiumRequest.id, 'approved', independentActorTelegramId, 30, { now: premiumNow });
    assert.equal(premiumApproval.product, 'premium_voice');
    assert.equal((await repository.getVoiceTutorAccess(username, { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 }, premiumNow)).entitlements.voice_tutor, true);
    assert.equal(await repository.revokeEntitlement(username, 'voice_tutor', independentActorTelegramId, { now: premiumNow }), false);
    assert.equal(await repository.revokeEntitlement(username, 'voice_tutor', independentActorTelegramId, { now: new Date(premiumNow.getTime() + 1) }), true);
    assert.equal(await repository.revokeEntitlement(username, 'voice_tutor', independentActorTelegramId, { now: new Date(premiumNow.getTime() + 1) }), false);

    const sessionId = crypto.randomUUID();
    await repository.createSession(sessionId, username, Date.now() + 60_000);
    assert.equal(await repository.isSessionActive(sessionId, username), true);
    assert.equal(await repository.revokeSession(sessionId, username), true);
    assert.equal(await repository.isSessionActive(sessionId, username), false);

    const voiceNow = new Date();
    const voiceLimits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
    assert.equal((await repository.getVoiceTutorAccess(username, voiceLimits, voiceNow)).entitlements.voice_tutor, false);
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: voiceNow,
      endsAt: new Date(voiceNow.getTime() + 30 * 86_400_000),
    });
    const voiceKey = crypto.randomUUID();
    const [firstVoiceReservation, repeatedVoiceReservation] = await Promise.all([
      repository.reserveVoiceTutorSession(username, { id: crypto.randomUUID(), idempotencyKey: voiceKey, limits: voiceLimits, now: voiceNow }),
      repository.reserveVoiceTutorSession(username, { id: crypto.randomUUID(), idempotencyKey: voiceKey, limits: voiceLimits, now: voiceNow }),
    ]);
    assert.deepEqual([firstVoiceReservation.created, repeatedVoiceReservation.created].sort(), [false, true]);
    assert.equal(firstVoiceReservation.session.id, repeatedVoiceReservation.session.id);
    await assert.rejects(
      repository.reserveVoiceTutorSession(username, { id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), limits: voiceLimits, now: voiceNow }),
      /VOICE_TUTOR_SESSION_ACTIVE/u,
    );
    const voiceFinishedAt = new Date(voiceNow.getTime() + 120_000);
    assert.equal((await repository.finishVoiceTutorSession(username, firstVoiceReservation.session.id, { limits: voiceLimits, now: voiceFinishedAt })).finished, true);
    assert.equal((await repository.finishVoiceTutorSession(username, firstVoiceReservation.session.id, { limits: voiceLimits, now: voiceFinishedAt })).finished, false);

    const unactivatedFinishId = crypto.randomUUID();
    await repository.reserveVoiceTutorSession(username, {
      id: unactivatedFinishId, idempotencyKey: crypto.randomUUID(), limits: voiceLimits, now: voiceFinishedAt,
      context: { capsule: { id: 'integration.unactivated.finish' }, nonceHash: '7'.repeat(64) },
    });
    await repository.finishVoiceTutorSession(username, unactivatedFinishId, {
      limits: voiceLimits, now: new Date(voiceFinishedAt.getTime() + 10_000),
    });
    assert.equal((await repository.getVoiceTutorSession(username, unactivatedFinishId)).billable_seconds, 0);
    await client.query('DELETE FROM voice_tutor_sessions WHERE id = $1', [unactivatedFinishId]);

    const unactivatedExpiryId = crypto.randomUUID();
    const unactivatedExpiryStart = new Date(voiceFinishedAt.getTime() + 20_000);
    await repository.reserveVoiceTutorSession(username, {
      id: unactivatedExpiryId, idempotencyKey: crypto.randomUUID(), limits: voiceLimits, now: unactivatedExpiryStart,
      context: { capsule: { id: 'integration.unactivated.expiry' }, nonceHash: '8'.repeat(64) },
    });
    const expired = await repository.finishVoiceTutorSession(username, unactivatedExpiryId, {
      limits: voiceLimits, now: new Date(unactivatedExpiryStart.getTime() + 310_000),
    });
    assert.equal(expired.finished, false);
    const expiredStored = await repository.getVoiceTutorSession(username, unactivatedExpiryId);
    assert.equal(expiredStored.status, 'expired');
    assert.equal(expiredStored.billable_seconds, 0);
    await client.query('DELETE FROM voice_tutor_sessions WHERE id = $1', [unactivatedExpiryId]);

    const progress = { learned: 12, prog: { words: 33 }, marker: suffix };
    await repository.saveProgress(username, progress);
    assert.deepEqual(await repository.getProgress(username), progress);
    await repository.mergeProgress(username, { prog: { words: 44 }, extra: true });
    assert.deepEqual(await repository.getProgress(username), { learned: 12, prog: { words: 44 }, marker: suffix, extra: true });

    const code = crypto.randomBytes(24).toString('base64url');
    await repository.createTelegramAuthCode(code, Date.now() + 60_000);
    assert.equal(await repository.confirmTelegramAuthCode(code, telegramId, 'Integration User'), true);
    assert.equal((await repository.consumeTelegramAuthCode(code)).telegram_id, telegramId);
    assert.equal(await repository.consumeTelegramAuthCode(code), null);

    const attemptId = await repository.createWritingAttempt(username, {
      taskType: 'writing_37', assignment: { prompt: 'Integration' }, answer: 'Test full answer',
      evaluatedAnswer: 'Test evaluated answer',
    }, 'integration-v1');
    await repository.finishWritingAttempt(attemptId, {
      status: 'failed', provider: 'test', model: 'integration-writing-model', errorCode: 'EXPECTED_TEST_ERROR',
    });
    const speakingAttemptId = await repository.createSpeakingAttempt(username, {
      taskType: 2, assignment: { ad: 'Integration', points: ['a', 'b', 'c', 'd'] }, transcript: 'Four questions.',
    }, 'integration-speaking-v1');
    await repository.finishSpeakingAttempt(speakingAttemptId, {
      status: 'failed', provider: 'test', model: 'integration-speaking-model', errorCode: 'EXPECTED_TEST_ERROR',
    });
    const speakingClaimInput = {
      taskType: 2,
      assignment: { ad: 'Integration claim', points: ['a', 'b', 'c', 'd'] },
      transcript: 'Four owner-bound questions.',
    };
    const speakingFingerprint = crypto.createHash('sha256').update(`${suffix}:speaking`).digest('hex');
    const [speakingFirstClaim, speakingReplayClaim] = await Promise.all([
      repository.claimSpeakingEvaluation(
        username, speakingClaimInput, 'speaking-semantic-v4', speakingFingerprint,
      ),
      repository.claimSpeakingEvaluation(
        username, speakingClaimInput, 'speaking-semantic-v4', speakingFingerprint,
      ),
    ]);
    assert.equal([speakingFirstClaim, speakingReplayClaim].filter((claim) => claim.created).length, 1);
    assert.equal(speakingFirstClaim.attempt.id, speakingReplayClaim.attempt.id);
    await repository.finishSpeakingAttempt(speakingFirstClaim.attempt.id, {
      status: 'failed', provider: 'grok', model: 'temporary-model', errorCode: 'AI_PROVIDER_UNAVAILABLE',
    });
    const speakingRecoveryNow = new Date('2026-08-06T11:00:00.000Z');
    const [speakingRecoveredClaim, speakingRecoveryRace] = await Promise.all([
      repository.claimSpeakingEvaluation(
        username, speakingClaimInput, 'speaking-semantic-v4', speakingFingerprint,
        { now: speakingRecoveryNow },
      ),
      repository.claimSpeakingEvaluation(
        username, speakingClaimInput, 'speaking-semantic-v4', speakingFingerprint,
        { now: speakingRecoveryNow },
      ),
    ]);
    assert.equal(
      [speakingRecoveredClaim, speakingRecoveryRace].filter((claim) => claim.created).length,
      1,
      'only one PostgreSQL caller may recover a transient failed claim',
    );
    assert.equal(speakingRecoveredClaim.attempt.id, speakingRecoveryRace.attempt.id);

    const speakingStaleFingerprint = crypto.createHash('sha256')
      .update(`${suffix}:speaking-stale`).digest('hex');
    const speakingStaleClaim = await repository.claimSpeakingEvaluation(
      username, speakingClaimInput, 'speaking-semantic-v4', speakingStaleFingerprint,
      { now: new Date('2026-08-06T11:10:00.000Z') },
    );
    const speakingEarlyReplay = await repository.claimSpeakingEvaluation(
      username, speakingClaimInput, 'speaking-semantic-v4', speakingStaleFingerprint,
      { now: new Date('2026-08-06T11:14:59.999Z') },
    );
    const speakingStaleRecovery = await repository.claimSpeakingEvaluation(
      username, speakingClaimInput, 'speaking-semantic-v4', speakingStaleFingerprint,
      { now: new Date('2026-08-06T11:15:00.001Z') },
    );
    assert.equal(speakingEarlyReplay.created, false);
    assert.equal(speakingStaleRecovery.created, true);
    assert.equal(speakingStaleRecovery.attempt.id, speakingStaleClaim.attempt.id);
    assert.ok(speakingStaleRecovery.attempt.evaluation_claim_generation
      > speakingStaleClaim.attempt.evaluation_claim_generation);
    await assert.rejects(
      repository.finishSpeakingAttempt(speakingStaleClaim.attempt.id, {
        status: 'completed', review: { stale: true }, provider: 'grok', model: 'stale-model',
      }, { claimGeneration: speakingStaleClaim.attempt.evaluation_claim_generation }),
      /SPEAKING_EVALUATION_CLAIM_LOST/u,
    );
    await repository.finishSpeakingAttempt(speakingStaleRecovery.attempt.id, {
      status: 'completed', review: { current: true }, provider: 'grok', model: 'current-model',
    }, { claimGeneration: speakingStaleRecovery.attempt.evaluation_claim_generation });
    const speakingOther = await repository.createTelegramUser(
      independentActorTelegramId, `Speaking Other ${suffix}`,
    );
    const speakingIsolatedClaim = await repository.claimSpeakingEvaluation(
      speakingOther, speakingClaimInput, 'speaking-semantic-v4', speakingFingerprint,
    );
    assert.equal(speakingIsolatedClaim.created, true);
    assert.notEqual(speakingIsolatedClaim.attempt.id, speakingFirstClaim.attempt.id);
    await repository.deleteUserData(speakingOther);
    const taskHash = crypto.createHash('sha256').update(suffix).digest('hex');
    await repository.saveGeneratedTask(username, { operation: 'grammar_quiz', requestHash: taskHash, request: { operation: 'grammar_quiz' }, result: [{ q: suffix }], provider: 'test', promptVersion: 'content-v1' });
    assert.equal((await repository.getGeneratedTask(username, taskHash)).result[0].q, suffix);
    const concurrentHash = crypto.createHash('sha256').update(`${suffix}:concurrent`).digest('hex');
    const generatedBase = { operation: 'vocabulary_cards', requestHash: concurrentHash, request: { operation: 'vocabulary_cards', count: 1, exclude: [] }, promptVersion: 'content-v1' };
    const [generatedFirstId, generatedSecondId] = await Promise.all([
      repository.saveGeneratedTask(username, { ...generatedBase, result: [{ w: 'first' }], provider: 'first' }),
      repository.saveGeneratedTask(username, { ...generatedBase, result: [{ w: 'second' }], provider: 'second' }),
    ]);
    assert.equal(generatedFirstId, generatedSecondId);
    const concurrentStored = await repository.getGeneratedTask(username, concurrentHash);
    assert.ok(['first', 'second'].includes(concurrentStored.result[0].w));
    assert.equal(concurrentStored.provider, concurrentStored.result[0].w);
    const moduleAttemptId = crypto.randomUUID();
    assert.equal((await repository.recordModuleAttempt(username, { id: moduleAttemptId, module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 50_000, metadata: {} })).created, true);
    assert.equal((await repository.recordModuleAttempt(username, { id: moduleAttemptId, module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 50_000, metadata: {} })).created, false);
    assert.equal((await repository.getModuleAttempt(username, moduleAttemptId)).evidence_quality, 'client_reported');
    const tracerAttemptId = crypto.randomUUID();
    const tracerAttempt = createGrammarLexiconErrorAttempt({
      id: tracerAttemptId, module: 'grammar', itemId: 'grammar.past-simple.last-summer', revision: 1, learnerAnswer: 'goed',
    });
    assert.equal((await repository.recordModuleAttempt(username, tracerAttempt, {
      evidenceQuality: 'server_verified_assisted',
    })).created, true);
    const storedTracerAttempt = await repository.getModuleAttempt(username, tracerAttemptId);
    assert.equal(storedTracerAttempt.metadata.learner_answer, 'goed');
    assert.equal(storedTracerAttempt.evidence_quality, 'server_verified_assisted');
    const tracerCapsule = buildGrammarLexiconCapsule({ attempt: storedTracerAttempt, expectedRevision: 1 });
    const tracerSessionId = crypto.randomUUID();
    const tracerReservation = await repository.reserveVoiceTutorSession(username, {
      id: tracerSessionId,
      idempotencyKey: crypto.randomUUID(),
      limits: voiceLimits,
      now: voiceFinishedAt,
      context: { capsule: persistedVoiceTutorCapsule(tracerCapsule), nonceHash: 'a'.repeat(64) },
    });
    assert.equal(tracerReservation.created, true);
    assert.equal(tracerReservation.session.state, 'diagnose');
    await assert.rejects(
      repository.activateVoiceTutorSession(username, tracerSessionId, {
        nonceHash: '9'.repeat(64), now: voiceFinishedAt,
      }),
      /VOICE_TUTOR_NONCE_REPLAYED/u,
    );
    const firstActivation = await repository.activateVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'a'.repeat(64), now: voiceFinishedAt,
    });
    const replayedActivation = await repository.activateVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'a'.repeat(64), now: new Date(voiceFinishedAt.getTime() + 1_000),
    });
    assert.equal(firstActivation.session.id, tracerSessionId);
    assert.equal(replayedActivation.session.id, tracerSessionId);
    await repository.setVoiceTutorSessionDelivery(username, tracerSessionId, {
      mode: 'voice', provider: 'xai', model: 'grok-voice-integration-v1', promptVersion: 'voice-tutor-error-v2',
    });
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'a'.repeat(64), nextNonceHash: 'b'.repeat(64), event: { type: 'diagnosis_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'explain');
    await assert.rejects(
      repository.advanceVoiceTutorSession(username, tracerSessionId, {
        nonceHash: 'a'.repeat(64), nextNonceHash: 'c'.repeat(64), event: { type: 'explanation_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
      }),
      /VOICE_TUTOR_NONCE_REPLAYED/u,
    );
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'b'.repeat(64), nextNonceHash: 'c'.repeat(64), event: { type: 'explanation_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'micro_check');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'c'.repeat(64), nextNonceHash: 'd'.repeat(64), event: { type: 'check_answer', answer: 'wrong' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'explain');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'd'.repeat(64), nextNonceHash: 'e'.repeat(64), event: { type: 'explanation_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'micro_check');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'e'.repeat(64), nextNonceHash: 'f'.repeat(64), event: { type: 'check_answer', answer: 'went' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'transfer_task');
    const tracerFallback = await repository.switchVoiceTutorSessionDelivery(username, tracerSessionId, {
      nonceHash: 'f'.repeat(64), nextNonceHash: 'g'.repeat(64), mode: 'text', limits: voiceLimits, now: voiceFinishedAt,
    });
    assert.equal(tracerFallback.session.status, 'completed');
    assert.equal(tracerFallback.voice_tutor.daily_remaining_seconds, 480);
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'g'.repeat(64), nextNonceHash: 'h'.repeat(64), event: { type: 'transfer_answer', answer: 'bought' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'resolved');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'h'.repeat(64), nextNonceHash: 'i'.repeat(64), event: { type: 'check_answer', answer: 'wrong' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'resolved');
    const storedTracerSession = await repository.getVoiceTutorSession(username, tracerSessionId);
    assert.equal(storedTracerSession.micro_check_attempts, 2);
    assert.equal(storedTracerSession.micro_check_passes, 1);
    let recoveryMap = await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: voiceFinishedAt });
    assert.equal(recoveryMap.skills[0].state, 'open');
    const dayOneRepeat = recoveryMap.skills[0].repeats[0];
    assert.equal((await repository.submitVoiceTutorRepeat(username, dayOneRepeat.id, {
      attemptId: crypto.randomUUID(), taskId: dayOneRepeat.task_id, answer: 'came', now: new Date(voiceFinishedAt.getTime() + 86_400_000),
    })).attempt.passed, true);
    recoveryMap = await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: new Date(voiceFinishedAt.getTime() + 7 * 86_400_000) });
    const daySevenRepeat = recoveryMap.skills[0].repeats[1];
    assert.equal((await repository.submitVoiceTutorRepeat(username, daySevenRepeat.id, {
      attemptId: crypto.randomUUID(), taskId: daySevenRepeat.task_id, answer: 'met', now: new Date(voiceFinishedAt.getTime() + 7 * 86_400_000),
    })).attempt.passed, true);
    const recoveredAt = new Date(voiceFinishedAt.getTime() + 7 * 86_400_000);
    assert.equal((await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: recoveredAt })).skills[0].state, 'recovered');
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: voiceNow,
      endsAt: new Date(voiceFinishedAt.getTime() + 86_400_000),
    });
    const inactiveRecoveryMap = await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: recoveredAt });
    assert.equal(inactiveRecoveryMap.voice_minutes.used_monthly, 2);
    assert.equal(inactiveRecoveryMap.voice_minutes.remaining_monthly, 0);
    assert.deepEqual(await repository.getVoiceTutorRecoveryMetrics(recoveredAt, { costMicrousdPerMinute: 50_000 }), {
      open: 0, recovered: 1, relapsed: 0, numerator: 1, denominator: 1, error_recovery_rate: 1,
      due_repeats: 0, overdue_repeats: 0, sessions: 2, voice_minutes: 0,
      micro_check: { passed: 1, observed: 2, rate: 0.5 },
      initial_transfer: { passed: 1, observed: 1, rate: 1 },
      repeat_passes: {
        day_1: { passed: 1, observed: 1, rate: 1 },
        day_7: { passed: 1, observed: 1, rate: 1 },
      },
      delivery: { voice: 0, text: 1, local: 0 },
      fallback_rate: 1,
      provider_errors: 0,
      estimated_cost_microusd: 0,
    });
    await repository.upsertWordProgress(username, [{ word: 'Achievement', stage: 2, errorCount: 1, reviewCount: 3, dueAt: Date.now() + 60_000 }]);
    const learningError = { module: 'grammar', itemKey: `grammar_19_24:${suffix}`, errorType: 'incorrect_form', details: { expected: 'went' } };
    await repository.upsertErrorBank(username, [learningError]);
    await repository.upsertErrorBank(username, [learningError]);
    await repository.logAiRequest({
      username, operation: 'integration', provider: 'test', model: 'test',
      promptVersion: 'integration-v1', status: 'completed', durationMs: 1,
    });
    await repository.healthCheck();

    const attempt = await client.query('SELECT answer, evaluated_answer, status, provider, model, prompt_version, error_code FROM writing_attempts WHERE id = $1', [attemptId]);
    assert.deepEqual(attempt.rows[0], {
      answer: 'Test full answer',
      evaluated_answer: 'Test evaluated answer',
      status: 'failed',
      provider: 'test',
      model: 'integration-writing-model',
      prompt_version: 'integration-v1',
      error_code: 'EXPECTED_TEST_ERROR',
    });
    const aiLog = await client.query('SELECT operation, status FROM ai_requests WHERE username = $1', [username]);
    assert.deepEqual(aiLog.rows[0], { operation: 'integration', status: 'completed' });
    const aiUsage = await repository.getAiUsageMetrics(24);
    assert.ok(aiUsage.requests >= 1);
    assert.equal(typeof aiUsage.estimatedCostMicrousd, 'number');

    const reportId = crypto.randomUUID();
    const report = await repository.createVoiceTutorReport(username, {
      id: reportId, sessionId: tracerSessionId, reason: 'technical_issue', createdAt: voiceFinishedAt,
    });
    assert.equal(report.created, true);
    assert.equal((await repository.listVoiceTutorReports({ status: 'pending' })).some((entry) => entry.id === reportId), true);
    assert.equal((await repository.reviewVoiceTutorReport(reportId, {
      decision: 'confirmed', reviewer: username, reviewedAt: voiceFinishedAt,
    })).applied, true);

    const adaptiveGoalKey = crypto.randomUUID();
    const adaptiveGoalHash = crypto.createHash('sha256').update(`${suffix}:adaptive-goal`).digest('hex');
    const adaptiveGoal = {
      id: crypto.randomUUID(), idempotencyKey: adaptiveGoalKey, requestHash: adaptiveGoalHash,
      targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
      now: voiceFinishedAt,
    };
    await assertAdaptiveGoalRepositoryContract(assert, repository, username, adaptiveGoal);
    await assert.rejects(
      repository.saveAdaptiveLearningGoal(username, { ...adaptiveGoal, requestHash: '0'.repeat(64) }),
      /ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT/u,
    );
    assert.equal((await repository.getAdaptiveLearningGoal(username)).revision, 1);
    const adaptiveSources = await repository.getAdaptiveLearningEvidenceSources(username);
    assert.equal(adaptiveSources.attempts.some((entry) => entry.id === tracerAttemptId), true);
    const adaptiveProfile = buildAdaptiveLearningProfile(adaptiveSources);
    await assertAdaptiveProfileRepositoryContract(
      assert, repository, username, adaptiveProfile, voiceFinishedAt,
    );
    const raceAttempt = (createdAt) => ({
      id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
      evidence_quality: 'server_verified_unassisted', created_at: createdAt,
    });
    const raceFirst = raceAttempt('2026-08-04T05:00:00.000Z');
    const raceLatest = raceAttempt('2026-08-04T06:00:00.000Z');
    const raceBackfill = raceAttempt('2026-08-04T04:00:00.000Z');
    const raceUsername = await repository.createTelegramUser(telegramId + 2, `Adaptive race ${suffix}`);
    await assertAdaptiveProfileRejectsStale(assert, repository, raceUsername, {
      older: buildAdaptiveLearningProfile({ attempts: [raceFirst] }),
      newer: buildAdaptiveLearningProfile({ attempts: [raceFirst, raceLatest] }),
      backfilled: buildAdaptiveLearningProfile({ attempts: [raceBackfill, raceFirst, raceLatest] }),
    });
    const orderingUsername = await repository.createTelegramUser(telegramId + 3, `Adaptive ordering ${suffix}`);
    await assertAdaptiveProfileAppendOnlyOrdering(
      assert, repository, orderingUsername, buildAdaptiveLearningProfile,
    );

    const exported = await repository.exportUserData(username);
    assert.equal(exported.account.username, username);
    assert.deepEqual(exported.progress, { learned: 12, prog: { words: 44 }, marker: suffix, extra: true });
    assert.equal(exported.writing_attempts.length, 1);
    assert.equal(exported.speaking_attempts.length, 3);
    assert.equal(exported.writing_attempts[0].model, 'integration-writing-model');
    assert.equal(exported.writing_attempts[0].error_code, 'EXPECTED_TEST_ERROR');
    assert.equal(exported.writing_attempts[0].answer, 'Test full answer');
    assert.equal(exported.writing_attempts[0].evaluated_answer, 'Test evaluated answer');
    assert.equal(
      exported.speaking_attempts.find((attempt) => Number(attempt.id) === speakingAttemptId).model,
      'integration-speaking-model',
    );
    assert.equal(JSON.stringify(exported.speaking_attempts).includes('evaluation_fingerprint'), false);
    assert.equal(JSON.stringify(exported.speaking_attempts).includes('evaluation_claim_generation'), false);
    assert.ok(exported.speaking_attempts.every((attempt) => (
      Object.hasOwn(attempt, 'assistance_updated_at')
    )), 'PostgreSQL export keeps assistance invalidation timestamp parity');
    assert.equal(exported.generated_tasks.length, 2);
    assert.equal(exported.module_attempts.length, 2);
    assert.equal(exported.voice_tutor_sessions.find((session) => session.id === tracerSessionId).delivery_mode, 'text');
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes('nonce_hash'), false);
    assert.equal(exported.progress_summary[0].attempt_count, 1);
    assert.equal(exported.progress_summary[0].best_score, 5);
    assert.equal(exported.word_progress[0].word, 'achievement');
    assert.equal(exported.error_bank.length, 1);
    assert.equal(exported.error_bank[0].occurrence_count, 2);
    assert.equal(exported.audit_log[0].action, 'payment.resolve');
    assert.equal(exported.ai_requests.length, 1);
    assert.equal(exported.subscription_entitlements[0].entitlement, 'voice_tutor');
    assert.equal(exported.voice_tutor_sessions.length, 2);
    assert.equal(exported.voice_tutor_recoveries.length, 1);
    assert.equal(exported.voice_tutor_repeats.length, 2);
    assert.equal(exported.voice_tutor_repeat_attempts.length, 2);
    assert.equal(exported.voice_tutor_reports[0].reason, 'technical_issue');
    assert.equal(exported.rule_cards.length, 2);
    assert.equal(exported.adaptive_learning_goals[0].target_score, 85);
    assert.equal(exported.adaptive_learning_profile.taxonomy_version, 'ege-en-v2');
    assert.equal(Number(exported.adaptive_learning_profile.independent_evidence_count), adaptiveProfile.independentEvidenceCount);
    assert.equal(exported.adaptive_learning_skill_estimates.length, EGE_SKILL_TAXONOMY.skills.length);
    const originalVoiceSession = exported.voice_tutor_sessions.find((session) => session.id === firstVoiceReservation.session.id);
    assert.equal(originalVoiceSession.billable_seconds, 120);
    const exportedTracerSession = exported.voice_tutor_sessions.find((session) => session.id === tracerSessionId);
    assert.equal(exportedTracerSession.delivery_mode, 'text');
    assert.equal(exportedTracerSession.billable_seconds, 0);
    assert.equal(exportedTracerSession.micro_check_attempts, 2);
    assert.equal(exportedTracerSession.micro_check_passes, 1);
    assert.equal(exportedTracerSession.provider, 'xai');
    assert.equal(exportedTracerSession.model, 'grok-voice-integration-v1');
    assert.equal(exportedTracerSession.prompt_version, 'voice-tutor-error-v2');
    assert.equal(new Date(exportedTracerSession.voice_activated_at).getTime(), voiceFinishedAt.getTime());

    for (let index = 0; index < 8; index += 1) {
      const raceUsername = await repository.createTelegramUser(telegramId + index + 1, `Delete race ${suffix} ${index}`);
      const raceCardId = crypto.randomUUID();
      const [deleted, created] = await Promise.allSettled([
        repository.deleteUserData(raceUsername),
        repository.createRuleCard({
          id: raceCardId, createdForUsername: raceUsername, status: 'pending_review',
          skill: { id: `ege.grammar.delete_race.${suffix}.${index}`, title: 'Delete race' }, examYear: 2026,
          rule: { title: 'Delete race', explanation: 'Concurrent owner deletion must not leave this card.', examples: ['Safe.'] },
          agreementHash: '1'.repeat(64),
          sources: [
            { authority: 'one', url: 'https://one.example/delete-race', retrieved_at: new Date().toISOString(), content_hash: '2'.repeat(64) },
            { authority: 'two', url: 'https://two.example/delete-race', retrieved_at: new Date().toISOString(), content_hash: '3'.repeat(64) },
          ],
          discrepancies: [], createdAt: new Date(),
        }),
      ]);
      assert.equal(deleted.status, 'fulfilled');
      assert.equal(deleted.value, true);
      if (created.status === 'rejected') assert.match(String(created.reason?.message), /USER_NOT_FOUND/u);
      assert.equal(await repository.getUser(raceUsername), null);
      assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [raceCardId])).rowCount, 0);
      assert.equal((await client.query(
        "SELECT 1 FROM trusted_rule_cards WHERE created_for_username = $1 AND status <> 'approved'",
        [raceUsername],
      )).rowCount, 0);
    }

    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getUser(username), null);
    assert.equal((await client.query('SELECT 1 FROM writing_attempts WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM speaking_attempts WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM ai_requests WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM subscription_entitlements WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM voice_tutor_sessions WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM voice_tutor_recoveries WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM adaptive_learning_goals WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM adaptive_learning_profiles WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM adaptive_learning_skill_estimates WHERE username = $1', [username])).rowCount, 0);
    const retainedRuleCard = await client.query('SELECT created_for_username, review_audit FROM trusted_rule_cards WHERE id = $1', [ruleCardId]);
    assert.equal(retainedRuleCard.rows[0].created_for_username, null);
    assert.equal(retainedRuleCard.rows[0].review_audit[0].reviewer, null);
    assert.equal(retainedRuleCard.rows[0].review_audit[0].account_deleted, true);
    assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [ruleReportId])).rowCount, 0);
    const retainedAudit = await client.query('SELECT metadata FROM audit_log WHERE target_id = $1', [paymentRequest.id]);
    assert.equal(retainedAudit.rows[0].metadata.username, undefined);
    assert.equal(retainedAudit.rows[0].metadata.account_deleted, true);
  } finally {
    await repository.close();
    await client.end();
  }
});

test('PostgreSQL discovery and paid-operation claims are atomic across finish/delete races', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const baseTelegramId = Number(`7${Date.now().toString().slice(-9)}`);
  const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
  const now = new Date();

  function pointer(id, skillId) {
    return {
      schema: 'voice-tutor-reference-v1', id, version: 'grammar-lexicon-v1',
      source: { attempt_id: crypto.randomUUID(), item_revision: 1 }, module: 'grammar', skill_id: skillId,
    };
  }

  function card(id, skillId) {
    return {
      id, skill: { id: skillId, title: 'Race-safe rule' }, examYear: 2026,
      rule: { title: 'Rule', explanation: 'A bounded race-safe explanation.', examples: ['It works.'] },
      agreementHash: 'a'.repeat(64), sources: [], discrepancies: [], createdAt: now,
    };
  }

  await client.connect();
  try {
    const finishUser = await repository.createTelegramUser(baseTelegramId, `Discovery finish ${suffix}`);
    await repository.grantDays(baseTelegramId, 30, `Discovery finish ${suffix}`);
    await repository.setEntitlement(finishUser, 'voice_tutor', { startsAt: now, endsAt: new Date(now.getTime() + 86_400_000) });
    const finishSessionId = crypto.randomUUID();
    const finishCapsule = pointer(`voice-capsule:finish:${suffix}`, `ege.grammar.finish.${suffix}`);
    await repository.reserveVoiceTutorSession(finishUser, {
      id: finishSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      context: { capsule: finishCapsule, nonceHash: '1'.repeat(64) },
    });
    const finishClaimId = crypto.randomUUID();
    await repository.claimVoiceTutorRuleDiscovery(finishUser, finishSessionId, {
      claimId: finishClaimId, nonceHash: '1'.repeat(64), now,
    });
    await repository.finishVoiceTutorSession(finishUser, finishSessionId, { limits, now });
    const finishCardId = crypto.randomUUID();
    await assert.rejects(
      repository.createRuleCardForVoiceTutorSession(
        finishUser, finishSessionId, finishCapsule.id, card(finishCardId, finishCapsule.skill_id),
        { claimId: finishClaimId, expectedNonceHash: '1'.repeat(64), nextNonceHash: '2'.repeat(64) },
      ),
      /TRUSTED_RULE_DISCOVERY_NOT_REQUIRED/u,
    );
    assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [finishCardId])).rowCount, 0);
    await repository.deleteUserData(finishUser);

    const deleteUser = await repository.createTelegramUser(baseTelegramId + 1, `Discovery delete ${suffix}`);
    await repository.grantDays(baseTelegramId + 1, 30, `Discovery delete ${suffix}`);
    await repository.setEntitlement(deleteUser, 'voice_tutor', { startsAt: now, endsAt: new Date(now.getTime() + 86_400_000) });
    const deleteSessionId = crypto.randomUUID();
    const deleteCapsule = pointer(`voice-capsule:delete:${suffix}`, `ege.grammar.delete.${suffix}`);
    await repository.reserveVoiceTutorSession(deleteUser, {
      id: deleteSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      context: { capsule: deleteCapsule, nonceHash: '3'.repeat(64) },
    });
    const deleteClaimId = crypto.randomUUID();
    await repository.claimVoiceTutorRuleDiscovery(deleteUser, deleteSessionId, {
      claimId: deleteClaimId, nonceHash: '3'.repeat(64), now,
    });
    const deleteCardId = crypto.randomUUID();
    const raced = await Promise.allSettled([
      repository.deleteUserData(deleteUser),
      repository.createRuleCardForVoiceTutorSession(
        deleteUser, deleteSessionId, deleteCapsule.id, card(deleteCardId, deleteCapsule.skill_id),
        { claimId: deleteClaimId, expectedNonceHash: '3'.repeat(64), nextNonceHash: '4'.repeat(64) },
      ),
    ]);
    assert.equal(raced[0].status, 'fulfilled');
    assert.equal(await repository.getUser(deleteUser), null);
    assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [deleteCardId])).rowCount, 0);

    const slotUser = await repository.createTelegramUser(baseTelegramId + 2, `AI slot ${suffix}`);
    const slotClaims = await Promise.allSettled([
      repository.claimAiOperationSlot(slotUser, {
        claimId: crypto.randomUUID(), operation: 'voice_tutor_rule_search', promptVersion: 'voice-tutor-rule-search-v1',
        requestsPerHour: 1, dailyLimit: 1_000_000, now,
      }),
      repository.claimAiOperationSlot(slotUser, {
        claimId: crypto.randomUUID(), operation: 'voice_tutor_rule_search', promptVersion: 'voice-tutor-rule-search-v1',
        requestsPerHour: 1, dailyLimit: 1_000_000, now,
      }),
    ]);
    assert.equal(slotClaims.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(slotClaims.filter((result) => result.status === 'rejected').length, 1);
    const slot = slotClaims.find((result) => result.status === 'fulfilled').value;
    assert.equal((await repository.settleAiOperationSlot(slotUser, slot.claim_id, {
      status: 'failed', provider: 'xai', model: 'fixture-v1', errorCode: 'TRUSTED_RULE_SEARCH_FAILED', now,
    })).applied, true);
    assert.equal((await repository.settleAiOperationSlot(slotUser, slot.claim_id, {
      status: 'failed', errorCode: 'TRUSTED_RULE_SEARCH_FAILED', now,
    })).applied, false);
    const storedSlot = await client.query('SELECT status, error_code, settled_at FROM ai_requests WHERE claim_key = $1', [slot.claim_id]);
    assert.equal(storedSlot.rows[0].status, 'failed');
    assert.equal(storedSlot.rows[0].error_code, 'TRUSTED_RULE_SEARCH_FAILED');
    assert.ok(storedSlot.rows[0].settled_at);
    await repository.deleteUserData(slotUser);

    const fallbackTelegramId = baseTelegramId + 3;
    const fallbackUser = await repository.createTelegramUser(fallbackTelegramId, `Quota fallback ${suffix}`);
    await repository.grantDays(fallbackTelegramId, 30, `Quota fallback ${suffix}`);
    await repository.setEntitlement(fallbackUser, 'voice_tutor', {
      startsAt: now, endsAt: new Date(now.getTime() + 86_400_000),
    });
    for (let index = 0; index < 2; index += 1) {
      const spentSessionId = crypto.randomUUID();
      await repository.reserveVoiceTutorSession(fallbackUser, {
        id: spentSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      });
      await repository.finishVoiceTutorSession(fallbackUser, spentSessionId, {
        limits, now: new Date(now.getTime() + 300_000), confirmedBillableSeconds: 300,
      });
    }
    const fallbackSessionId = crypto.randomUUID();
    const fallbackReservation = await repository.reserveVoiceTutorSession(fallbackUser, {
      id: fallbackSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      context: { capsule: pointer(`voice-capsule:fallback:${suffix}`, `ege.grammar.fallback.${suffix}`), nonceHash: '5'.repeat(64) },
      allowFallbackOnly: true,
    });
    assert.equal(fallbackReservation.fallback_only, true);
    const fallbackStored = await repository.getVoiceTutorSession(fallbackUser, fallbackSessionId);
    assert.equal(fallbackStored.reserved_seconds, 0);
    assert.equal(fallbackStored.delivery_mode, 'local');
    assert.equal((await repository.getVoiceTutorAccess(fallbackUser, limits, now)).voice_tutor.daily_remaining_seconds, 0);
    await repository.finishVoiceTutorSession(fallbackUser, fallbackSessionId, {
      limits, now, confirmedBillableSeconds: 0,
    });
    await repository.deleteUserData(fallbackUser);
  } finally {
    await repository.close();
    await client.end();
  }
});

test('PostgreSQL proxy tickets, usage settlement and canonical review are atomic', { skip: !connectionString }, async () => {
  const operationalErrors = [];
  const repository = createPostgresRepository(connectionString, {
    onOperationalError: (event) => operationalErrors.push(event),
  });
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const telegramId = Number(`6${Date.now().toString().slice(-9)}`);
  const now = new Date();
  const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
  await client.connect();

  async function prepareSession(idOffset) {
    const id = telegramId + idOffset;
    const username = await repository.createTelegramUser(id, `Proxy ${suffix} ${idOffset}`);
    await repository.grantDays(id, 30, `Proxy ${suffix} ${idOffset}`);
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: now, endsAt: new Date(now.getTime() + 86_400_000),
    });
    const sessionId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    await repository.reserveVoiceTutorSession(username, {
      id: sessionId, idempotencyKey, limits, now,
      context: {
        capsule: {
          schema: 'voice-tutor-reference-v1', id: `voice-capsule:${sessionId}`, version: 'grammar-lexicon-v1',
          source: { attempt_id: crypto.randomUUID(), item_revision: 1 }, module: 'grammar', skill_id: `ege.grammar.proxy.${suffix}`,
        },
        nonceHash: '1'.repeat(64),
      },
    });
    return { username, sessionId, idempotencyKey };
  }

  function card(username, skillId) {
    return {
      id: crypto.randomUUID(), createdForUsername: username,
      skill: { id: skillId, title: 'Atomic canonical' }, examYear: 2026,
      rule: { title: 'Atomic canonical', explanation: 'Only one approved rule may exist.', examples: ['It works.'] },
      agreementHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      sources: [], discrepancies: [], createdAt: now,
    };
  }

  try {
    const exact = await prepareSession(0);
    const ticketExpiresAt = new Date(now.getTime() + 60_000);
    const firstHash = 'a'.repeat(64);
    const replacementHash = 'b'.repeat(64);
    assert.equal((await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: firstHash, idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
    })).issued, true);
    assert.equal((await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: firstHash, idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
    })).issued, false);
    assert.equal((await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: replacementHash, idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
      reissue: true, nextNonceHash: '2'.repeat(64),
    })).reissued, true);
    await assert.rejects(
      repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
        ticketHash: '9'.repeat(64), idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
        reissue: true, nextNonceHash: '3'.repeat(64),
      }),
      (error) => error.code === 'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT',
    );
    assert.equal((await repository.getVoiceTutorSession(exact.username, exact.sessionId)).proxy_ticket_reissue_count, 1);
    const consumed = await Promise.allSettled([
      repository.consumeVoiceTutorProxyTicket(exact.username, { ticketHash: replacementHash }, {
        now: new Date(now.getTime() + 1_000),
        provider: 'xai', model: 'grok-voice-v1', promptVersion: 'voice-tutor-error-v4',
      }),
      repository.consumeVoiceTutorProxyTicket(exact.username, { ticketHash: replacementHash }, {
        now: new Date(now.getTime() + 1_000),
        provider: 'xai', model: 'grok-voice-v1', promptVersion: 'voice-tutor-error-v4',
      }),
    ]);
    assert.equal(consumed.filter((result) => result.status === 'fulfilled').length, 1,
      consumed.map((result) => result.status === 'rejected' ? result.reason?.code : 'fulfilled').join(','));
    assert.match(consumed.find((result) => result.status === 'rejected').reason.message, /VOICE_TUTOR_PROXY_TICKET_REPLAYED/u);
    assert.equal((await repository.activateVoiceTutorProxySession(exact.username, exact.sessionId, {
      now: new Date(now.getTime() + 1_000),
    })).activated, true);
    assert.equal((await repository.activateVoiceTutorProxySession(exact.username, exact.sessionId, {
      now: new Date(now.getTime() + 1_000),
    })).activated, false);
    const exactFinalization = await repository.finalizeVoiceTutorProxySession(exact.username, exact.sessionId, {
      inputAudioBytes: 48_000, outputAudioBytes: 1, confirmed: true, reason: 'completed',
      now: new Date(now.getTime() + 20_000), limits,
    });
    assert.equal(exactFinalization.usage.billable_seconds, 2);
    assert.equal(exactFinalization.usage.exact, true);
    const idempotentFinalization = await repository.finalizeVoiceTutorProxySession(exact.username, exact.sessionId, {
      inputAudioBytes: 999_999, outputAudioBytes: 999_999, confirmed: false, reason: 'provider_error',
      now: new Date(now.getTime() + 30_000), limits,
    });
    assert.equal(idempotentFinalization.finalized, false);
    assert.deepEqual(idempotentFinalization.usage, exactFinalization.usage);
    const storedExact = await client.query(
      `SELECT billable_seconds, proxy_input_audio_bytes, proxy_output_audio_bytes,
              proxy_usage_confirmed, proxy_finalization_reason
       FROM voice_tutor_sessions WHERE id = $1`,
      [exact.sessionId],
    );
    assert.deepEqual(storedExact.rows[0], {
      billable_seconds: 2,
      proxy_input_audio_bytes: '48000',
      proxy_output_audio_bytes: '1',
      proxy_usage_confirmed: true,
      proxy_finalization_reason: 'completed',
    });

    const bounded = await prepareSession(10);
    await repository.issueVoiceTutorProxyTicket(bounded.username, bounded.sessionId, {
      ticketHash: '6'.repeat(64), idempotencyKey: bounded.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(bounded.username, { ticketHash: '6'.repeat(64) }, {
      now: new Date(Date.now() + 1_000),
    });
    await client.query('BEGIN');
    await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [bounded.username]);
    const timeoutStartedAt = Date.now();
    await assert.rejects(
      repository.finalizeVoiceTutorProxySession(bounded.username, bounded.sessionId, {
        inputAudioBytes: 1, outputAudioBytes: 1, confirmed: true, reason: 'completed',
        now: new Date(now.getTime() + 10_000), limits, attemptTimeoutMs: 50,
      }),
      /finalization attempt timeout/iu,
    );
    assert.ok(Date.now() - timeoutStartedAt < 500);
    await client.query('ROLLBACK');
    assert.equal((await repository.finalizeVoiceTutorProxySession(bounded.username, bounded.sessionId, {
      inputAudioBytes: 1, outputAudioBytes: 1, confirmed: true, reason: 'completed',
      now: new Date(now.getTime() + 10_000), limits, attemptTimeoutMs: 500,
    })).finalized, true);

    const partialTicket = await prepareSession(11);
    assert.equal((await repository.issueVoiceTutorProxyTicket(partialTicket.username, partialTicket.sessionId, {
      ticketHash: '5'.repeat(64), idempotencyKey: partialTicket.idempotencyKey,
      expiresAt: ticketExpiresAt, now, nextNonceHash: '4'.repeat(64),
    })).issued, true);
    const partialTicketStored = await repository.getVoiceTutorSession(partialTicket.username, partialTicket.sessionId);
    assert.equal(partialTicketStored.nonce_hash, '4'.repeat(64));
    assert.equal(partialTicketStored.proxy_ticket_reissue_count, 1);

    const partialLocal = await prepareSession(12);
    const partialLocalRecovered = await repository.reissueVoiceTutorFallbackNonce(
      partialLocal.username,
      partialLocal.sessionId,
      { idempotencyKey: partialLocal.idempotencyKey, nextNonceHash: '3'.repeat(64), now },
    );
    assert.equal(partialLocalRecovered.session.status, 'completed');
    const partialLocalStored = await repository.getVoiceTutorSession(partialLocal.username, partialLocal.sessionId);
    assert.equal(partialLocalStored.delivery_mode, 'local');
    assert.equal(partialLocalStored.billable_seconds, 0);

    const lostRealtime = await prepareSession(13);
    await repository.setVoiceTutorSessionDelivery(lostRealtime.username, lostRealtime.sessionId, { mode: 'voice' });
    await repository.issueVoiceTutorProxyTicket(lostRealtime.username, lostRealtime.sessionId, {
      ticketHash: '0'.repeat(64), idempotencyKey: lostRealtime.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.issueVoiceTutorProxyTicket(lostRealtime.username, lostRealtime.sessionId, {
      ticketHash: '1'.repeat(64), idempotencyKey: lostRealtime.idempotencyKey, expiresAt: ticketExpiresAt, now,
      reissue: true, nextNonceHash: '5'.repeat(64),
    });
    await repository.reissueVoiceTutorFallbackNonce(lostRealtime.username, lostRealtime.sessionId, {
      idempotencyKey: lostRealtime.idempotencyKey, nextNonceHash: '6'.repeat(64), now,
      recoverLostRealtime: true,
    });
    const lostRealtimeStored = await repository.getVoiceTutorSession(lostRealtime.username, lostRealtime.sessionId);
    assert.equal(lostRealtimeStored.delivery_mode, 'local');
    assert.equal(lostRealtimeStored.status, 'completed');
    assert.equal(lostRealtimeStored.billable_seconds, 0);
    assert.equal(lostRealtimeStored.proxy_ticket_hash, null);
    assert.equal(lostRealtimeStored.proxy_ticket_issued_at, null);
    assert.equal(lostRealtimeStored.proxy_ticket_expires_at, null);
    assert.equal(lostRealtimeStored.proxy_ticket_consumed_at, null);
    const exported = await repository.exportUserData(exact.username);
    assert.equal(JSON.stringify(exported).includes(replacementHash), false);
    assert.equal(Number(exported.voice_tutor_sessions[0].proxy_input_audio_bytes), 48_000);

    const conservative = await prepareSession(1);
    await repository.issueVoiceTutorProxyTicket(conservative.username, conservative.sessionId, {
      ticketHash: 'c'.repeat(64), idempotencyKey: conservative.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(conservative.username, { ticketHash: 'c'.repeat(64) }, {
      now: new Date(Date.now() + 1_000),
    });
    const conservativeFinalization = await repository.finalizeVoiceTutorProxySession(conservative.username, conservative.sessionId, {
      inputAudioBytes: 0, outputAudioBytes: 0, confirmed: false, reason: 'provider_error',
      now: new Date(now.getTime() + 1_000), limits,
    });
    assert.equal(conservativeFinalization.usage.exact, false);
    assert.equal(conservativeFinalization.usage.billable_seconds, 300);

    const lostFallback = await prepareSession(8);
    await client.query('UPDATE voice_tutor_sessions SET delivery_mode = NULL WHERE id = $1', [lostFallback.sessionId]);
    const recoveredNonces = await Promise.allSettled([
      repository.reissueVoiceTutorFallbackNonce(lostFallback.username, lostFallback.sessionId, {
        idempotencyKey: lostFallback.idempotencyKey, nextNonceHash: '8'.repeat(64), now,
      }),
      repository.reissueVoiceTutorFallbackNonce(lostFallback.username, lostFallback.sessionId, {
        idempotencyKey: lostFallback.idempotencyKey, nextNonceHash: '9'.repeat(64), now,
      }),
    ]);
    assert.equal(recoveredNonces.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(recoveredNonces.find((result) => result.status === 'rejected').reason.code,
      'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
    const recoveredFallback = await repository.getVoiceTutorSession(lostFallback.username, lostFallback.sessionId);
    assert.equal(recoveredFallback.proxy_ticket_reissue_count, 1);
    assert.equal(recoveredFallback.delivery_mode, 'local');
    assert.equal(recoveredFallback.status, 'completed');
    assert.equal(recoveredFallback.billable_seconds, 0);

    const legacyFinish = await prepareSession(4);
    await repository.issueVoiceTutorProxyTicket(legacyFinish.username, legacyFinish.sessionId, {
      ticketHash: 'd'.repeat(64), idempotencyKey: legacyFinish.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(legacyFinish.username, { ticketHash: 'd'.repeat(64) }, {
      now: new Date(Date.now() + 1_000),
    });
    await repository.activateVoiceTutorProxySession(legacyFinish.username, legacyFinish.sessionId, {
      now: new Date(Date.now() + 1_000),
    });
    await repository.finishVoiceTutorSession(legacyFinish.username, legacyFinish.sessionId, {
      confirmedBillableSeconds: 0, now: new Date(now.getTime() + 1_000), limits,
    });
    const legacyStored = await repository.getVoiceTutorSession(legacyFinish.username, legacyFinish.sessionId);
    assert.equal(legacyStored.billable_seconds, 300);
    assert.equal(legacyStored.proxy_usage_confirmed, false);
    assert.equal(legacyStored.proxy_finalization_reason, 'server_finish');

    const fallback = await prepareSession(7);
    await repository.issueVoiceTutorProxyTicket(fallback.username, fallback.sessionId, {
      ticketHash: '7'.repeat(64), idempotencyKey: fallback.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(fallback.username, { ticketHash: '7'.repeat(64) }, {
      now: new Date(Date.now() + 1_000),
    });
    await repository.switchVoiceTutorSessionDelivery(fallback.username, fallback.sessionId, {
      nonceHash: '1'.repeat(64), nextNonceHash: '2'.repeat(64), mode: 'local',
      errorCode: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE', limits, now: new Date(now.getTime() + 1_000),
    });
    const fallbackStored = await repository.getVoiceTutorSession(fallback.username, fallback.sessionId);
    assert.equal(fallbackStored.billable_seconds, 300);
    assert.equal(fallbackStored.proxy_usage_confirmed, false);
    assert.equal(fallbackStored.proxy_finalization_reason, 'runtime_fallback');
    assert.equal((await repository.finalizeVoiceTutorProxySession(fallback.username, fallback.sessionId, {
      inputAudioBytes: 48_000, outputAudioBytes: 48_000, confirmed: true, reason: 'completed',
      now: new Date(now.getTime() + 2_000), limits,
    })).finalized, false);

    const timeout = await prepareSession(5);
    await repository.issueVoiceTutorProxyTicket(timeout.username, timeout.sessionId, {
      ticketHash: 'e'.repeat(64), idempotencyKey: timeout.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(timeout.username, { ticketHash: 'e'.repeat(64) }, {
      now: new Date(Date.now() + 1_000),
    });
    await repository.activateVoiceTutorProxySession(timeout.username, timeout.sessionId, {
      now: new Date(Date.now() + 1_000),
    });
    await repository.finishVoiceTutorSession(timeout.username, timeout.sessionId, {
      now: new Date(now.getTime() + 301_000), limits,
    });
    const timeoutStored = await repository.getVoiceTutorSession(timeout.username, timeout.sessionId);
    assert.equal(timeoutStored.status, 'expired');
    assert.equal(timeoutStored.billable_seconds, 300);
    assert.equal(timeoutStored.proxy_finalization_reason, 'timeout');

    const finalizationBackends = await client.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name = 'easyboost_voice_finalization' AND state = 'idle'",
    );
    assert.ok(finalizationBackends.rowCount >= 1);
    await client.query('SELECT pg_terminate_backend($1)', [finalizationBackends.rows[0].pid]);
    for (let attempt = 0; attempt < 50 && operationalErrors.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(operationalErrors, [{ code: 'POSTGRES_IDLE_CLIENT_ERROR', pool: 'voice_finalization' }]);

    const canonicalSkill = `ege.grammar.canonical.${suffix}`;
    const firstCard = card(exact.username, canonicalSkill);
    const secondCard = card(exact.username, canonicalSkill);
    await repository.createRuleCard(firstCard);
    await repository.createRuleCard(secondCard);
    const canonicalRace = await Promise.allSettled([
      repository.reviewRuleCard(firstCard.id, { decision: 'approved', reviewer: exact.username, reviewedAt: now }),
      repository.reviewRuleCard(secondCard.id, { decision: 'approved', reviewer: exact.username, reviewedAt: now }),
    ]);
    assert.equal(canonicalRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(canonicalRace.find((result) => result.status === 'rejected').reason.code, 'RULE_CARD_CANONICAL_EXISTS');
    assert.equal((await client.query(
      "SELECT id FROM trusted_rule_cards WHERE skill_id = $1 AND exam_year = 2026 AND status = 'approved'",
      [canonicalSkill],
    )).rowCount, 1);

    const owner = await repository.createTelegramUser(telegramId + 2, `Review owner ${suffix}`);
    const reviewer = await repository.createTelegramUser(telegramId + 3, `Review actor ${suffix}`);
    const racedCard = card(owner, `ege.grammar.review_delete.${suffix}`);
    await repository.createRuleCard(racedCard);
    const reviewDeleteRace = await Promise.allSettled([
      repository.deleteUserData(reviewer),
      repository.reviewRuleCard(racedCard.id, { decision: 'approved', reviewer, reviewedAt: now }),
    ]);
    assert.equal(reviewDeleteRace[0].status, 'fulfilled');
    assert.equal(await repository.getUser(reviewer), null);
    if (reviewDeleteRace[1].status === 'fulfilled') {
      assert.equal((await repository.getRuleCard(racedCard.id)).review_audit[0].reviewer, null);
    } else {
      assert.match(reviewDeleteRace[1].reason.message, /USER_NOT_FOUND/u);
    }

    const privacyUser = await repository.createTelegramUser(telegramId + 6, `Privacy race ${suffix}`);
    const privacyDeleteRace = await Promise.allSettled([
      repository.deleteUserData(privacyUser),
      repository.setPrivacyConsent(privacyUser, {
        text_processing: true, voice_processing: true, policy_version: 'ticket-10-v1',
      }),
    ]);
    assert.equal(privacyDeleteRace[0].status, 'fulfilled');
    assert.equal(await repository.getUser(privacyUser), null);
    if (privacyDeleteRace[1].status === 'rejected') assert.match(privacyDeleteRace[1].reason.message, /USER_NOT_FOUND/u);
  } finally {
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 1))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 2))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 4))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 5))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 7))?.username).catch(() => {});
    await repository.close();
    await client.end();
  }
});
