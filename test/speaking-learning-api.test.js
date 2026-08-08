import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import { publicSpeakingReview, scoreSpeakingTask } from '../speaking/fipi-scoring.js';
import { createFileRepository } from '../storage/file-repository.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';

const NOW = new Date('2026-08-07T10:00:00.000Z');

function activePremiumWindow() {
  const wallClock = Date.now();
  return {
    startsAt: new Date(Math.min(NOW.getTime() - 1_000, wallClock - 1_000)),
    endsAt: new Date(Math.max(NOW.getTime() + 86_400_000, wallClock + 86_400_000)),
  };
}

function scoredReview({ allRelevant = false, phonemeLabel = 'ð' } = {}) {
  const semanticFacts = {
    confidence: 0.96, verdict: 'The response can be assessed.', evidence: ['Four direct questions.'], issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, relevant: allRelevant || index !== 1, directQuestion: true,
      lexicalGrammarBlocksCommunication: false, evidence: `Question ${index + 1}`,
    })),
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.95, signalQuality: 'good', recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({ itemIndex: index + 1, durationSeconds: 12 })),
    wordAccuracyScore: 96, phonemeAccuracyScore: 95, fluencyScore: 84,
    wordEvents: [{
      id: 'azure:weather:1', owner: 'azure_pronunciation', type: 'mispronunciation',
      gross: false, itemIndex: 2, accuracyScore: 72, start: 10, end: 17,
      word: 'weather', phonemes: [{ label: phonemeLabel, accuracyScore: 48 }],
    }],
  };
  return {
    ...publicSpeakingReview(scoreSpeakingTask({ taskType: 2, semantic: semanticFacts, acoustic: acousticFacts }), semanticFacts),
    semanticFacts, acousticFacts,
  };
}

async function withServer(run, { repositoryOptions = {}, repositoryHooks = new Map() } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-learning-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'), repositoryOptions);
  const owner = await repository.createTelegramUser(8_209_001, 'Learning Owner');
  const stranger = await repository.createTelegramUser(8_209_002, 'Learning Stranger');
  await repository.grantDays(8_209_001, 30, 'Learning Owner');
  await repository.grantDays(8_209_002, 30, 'Learning Stranger');
  await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now: NOW });
  await repository.setSpeakingAccentProfile(stranger, { locale: 'en-GB', source: 'manual', now: NOW });

  const app = express();
  app.use(express.json());
  const routeRepository = new Proxy(repository, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    const original = value.bind(target);
    const hook = repositoryHooks.get(property);
    return hook ? (...args) => hook(original, ...args) : original;
  } });
  app.use(createSpeakingRoutes({
    authentication: { auth(req, res, next) {
      req.user = req.get('x-test-user');
      return req.user ? next() : res.status(401).end();
    } },
    access: { async requireActiveSubscription(req, res, next) {
      return (await repository.getSub(req.user)).active ? next() : res.status(403).end();
    } },
    db: routeRepository,
    now: () => NOW,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (username, pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-test-user': username },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  try { await run({ repository, owner, stranger, request }); } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function completeTask2(request, owner, sessionId) {
  for (let question = 1; question <= 4; question += 1) {
    const response = await request(
      owner,
      `/api/v1/speaking/task-2/sessions/${sessionId}/questions/${question}/complete`,
      { method: 'POST', body: { recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady' } },
    );
    assert.equal(response.status, 200);
  }
}

test('assistance is owner-bound, idempotent and permanently disqualifies that session from mastery', async () => {
  await withServer(async ({ repository, owner, stranger, request }) => {
    const assigned = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    assert.equal(assigned.assistanceUsed, false);
    assert.equal((await request(stranger, `/api/v1/speaking/task-2/sessions/${assigned.id}/assistance`, {
      method: 'POST', body: {},
    })).status, 404);
    for (let replay = 0; replay < 2; replay += 1) {
      const response = await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/assistance`, {
        method: 'POST', body: {},
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { assistanceUsed: true });
    }
    assert.equal((await repository.getSpeakingTask2Session(owner, assigned.id)).assistance_used, true);
  });
});

test('evaluation claim requires a completed owner session and assistance atomically taints claimed retries', async () => {
  await withServer(async ({ repository, owner, request }) => {
    const assigned = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    const input = { taskType: 2, assignment: {}, transcript: 'Four complete questions.' };
    const source = {
      sessionId: assigned.id, taskRef: assigned.task.id, taskRevision: assigned.task.revision,
      catalogId: assigned.catalog.id, catalogRevision: assigned.catalog.revision, assistanceUsed: false,
    };
    await assert.rejects(
      repository.claimSpeakingEvaluation(owner, input, 'speaking-evaluation-v1', 'b'.repeat(64), { now: NOW, source }),
      /SPEAKING_LEARNING_SESSION_INCOMPLETE/u,
    );
    await completeTask2(request, owner, assigned.id);
    const claim = await repository.claimSpeakingEvaluation(
      owner, input, 'speaking-evaluation-v1', 'b'.repeat(64), { now: NOW, source },
    );
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'failed', review: null, provider: 'xai', model: 'test', errorCode: 'AI_PROVIDER_UNAVAILABLE',
    });
    await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/assistance`, {
      method: 'POST', body: {},
    });
    assert.equal((await repository.getSpeakingAttempt(owner, claim.attempt.id)).assistance_used, true);
    const recovered = await repository.claimSpeakingEvaluation(
      owner, input, 'speaking-evaluation-v1', 'b'.repeat(64), {
        now: new Date(NOW.getTime() + 1_000), source,
      },
    );
    assert.equal(recovered.created, true);
    assert.equal(recovered.attempt.assistance_used, true);
  });
});

test('post-hoc assistance monotonically replaces an already persisted independent mastery snapshot', async () => {
  await withServer(async ({ repository, owner, request }) => {
    const assigned = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, assigned.id);
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four complete questions.',
    }, 'speaking-evaluation-v1', 'c'.repeat(64), { now: NOW, source: {
      sessionId: assigned.id, taskRef: assigned.task.id, taskRevision: assigned.task.revision,
      catalogId: assigned.catalog.id, catalogRevision: assigned.catalog.revision, assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });
    const independentSources = await repository.getAdaptiveLearningEvidenceSources(owner);
    const independent = buildAdaptiveLearningProfile(independentSources);
    const storedIndependent = await repository.saveAdaptiveLearningProfile(owner, independent, {
      now: NOW, verifyCurrentEvidence: true,
    });
    assert.ok(Number(storedIndependent.independent_evidence_count) > 0,
      'the official unassisted attempt must persist independent mastery');

    const assistanceAt = NOW;
    await repository.markSpeakingSessionAssisted(owner, 2, assigned.id, { now: assistanceAt });
    await assert.rejects(
      repository.saveAdaptiveLearningProfile(owner, independent, {
        now: assistanceAt, verifyCurrentEvidence: true,
      }),
      /ADAPTIVE_PROFILE_EVIDENCE_STALE/u,
      'a profile snapshot captured before assistance must not overwrite authoritative evidence',
    );
    const assisted = buildAdaptiveLearningProfile(
      await repository.getAdaptiveLearningEvidenceSources(owner),
    );
    assert.equal(assisted.independentEvidenceCount, 0);
    assert.ok(assisted.assistedEvidenceCount > 0);
    assert.equal(assisted.evidenceSourceCount, independent.evidenceSourceCount);
    assert.equal(assisted.evidenceObservedAt, independent.evidenceObservedAt,
      'an assistance invalidation may preserve both the event count and latest timestamp');
    assert.notEqual(assisted.evidenceFingerprint, independent.evidenceFingerprint);
    const storedAssisted = await repository.saveAdaptiveLearningProfile(owner, assisted, {
      now: assistanceAt, verifyCurrentEvidence: true,
    });
    assert.equal(Number(storedAssisted.independent_evidence_count), 0);
    assert.ok(Number(storedAssisted.assisted_evidence_count) > 0);
    assert.equal(storedAssisted.evidence_fingerprint, assisted.evidenceFingerprint);
    const rejectedStaleMastery = await repository.saveAdaptiveLearningProfile(owner, independent, {
      now: new Date('2026-08-07T10:01:00.000Z'),
    });
    assert.equal(Number(rejectedStaleMastery.independent_evidence_count), 0,
      'equal-time fingerprint CAS must retain the current assisted evidence without an opt-in flag');
    assert.equal(rejectedStaleMastery.evidence_fingerprint, assisted.evidenceFingerprint);
  });
});

test('learning report keeps Base analysis and derives Premium expansion from the fresh entitlement', async () => {
  await withServer(async ({ repository, owner, request }) => {
    const assigned = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, assigned.id);
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'When does it begin? How much is it?',
    }, 'speaking-evaluation-v1', 'a'.repeat(64), { now: NOW, source: {
      sessionId: assigned.id, taskRef: assigned.task.id, taskRevision: assigned.task.revision,
      catalogId: assigned.catalog.id, catalogRevision: assigned.catalog.revision, assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });

    const base = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    assert.equal(base.access.tier, 'base');
    assert.equal(base.access.limitSeconds, 3_600);
    assert.equal(base.currentAttempt.attemptId, claim.attempt.id);
    assert.equal(base.currentAttempt.criteria.length, 4);
    assert.equal(base.attemptTimeline.length, 1);
    assert.equal(base.attemptTimeline[0].attemptId, claim.attempt.id);
    assert.equal(base.attemptTimeline[0].masteryEligible, true);
    assert.equal(base.premium, null);

    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    const premium = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    assert.equal(premium.access.tier, 'premium');
    assert.equal(premium.access.limitSeconds, 14_400);
    assert.equal(premium.currentAttempt.attemptId, claim.attempt.id);
    assert.equal(premium.premium.targetedPractice.materialPolicy, 'different_server_owned_material');
    assert.equal(premium.premium.voiceTutor.attemptId, claim.attempt.id);
    assert.equal(premium.premium.targetedPractice.focus.kind, 'phoneme');
    assert.equal(premium.premium.targetedPractice.focus.anchorWord, 'weather');
    const targeted = await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { targetedPractice: {
        sourceAttemptId: premium.premium.targetedPractice.sourceAttemptId,
        reportRevision: premium.premium.targetedPractice.reportRevision,
        accentLocale: premium.premium.targetedPractice.accentLocale,
        skillId: premium.premium.targetedPractice.skillId,
        contentRef: premium.premium.targetedPractice.contentRef,
      } },
    });
    assert.equal(targeted.status, 201);
    const targetedSession = await targeted.json();
    assert.notEqual(targetedSession.task.id, assigned.task.id);
    assert.equal(targetedSession.selectionReason, 'targeted_focus');
    assert.deepEqual(targetedSession.targetedPractice, {
      sourceAttemptId: premium.premium.targetedPractice.sourceAttemptId,
      reportRevision: premium.premium.targetedPractice.reportRevision,
      accentLocale: premium.premium.targetedPractice.accentLocale,
      skillId: premium.premium.targetedPractice.skillId,
      label: premium.premium.targetedPractice.label,
      contentRef: premium.premium.targetedPractice.contentRef,
      focus: premium.premium.targetedPractice.focus,
    });
    assert.match(JSON.stringify(targetedSession.task), /weather/iu,
      'the server selector must choose material containing the bounded pronunciation anchor');
    const stale = await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { targetedPractice: {
        sourceAttemptId: premium.premium.targetedPractice.sourceAttemptId + 1,
        reportRevision: premium.premium.targetedPractice.reportRevision,
        accentLocale: premium.premium.targetedPractice.accentLocale,
        skillId: premium.premium.targetedPractice.skillId,
        contentRef: premium.premium.targetedPractice.contentRef,
      } },
    });
    assert.equal(stale.status, 409);

    const followup = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, followup.id);
    const followupClaim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'The weather course begins on Monday.',
    }, 'speaking-evaluation-v1', 'd'.repeat(64), { now: new Date(NOW.getTime() + 1_000), source: {
      sessionId: followup.id, taskRef: followup.task.id, taskRevision: followup.task.revision,
      catalogId: followup.catalog.id, catalogRevision: followup.catalog.revision, assistanceUsed: false,
    } });
    const finishing = repository.finishSpeakingAttempt(followupClaim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });
    const supersededAssignment = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id, catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: premium.premium.targetedPractice.sourceAttemptId,
        reportRevision: premium.premium.targetedPractice.reportRevision,
        accentLocale: premium.premium.targetedPractice.accentLocale,
        skillId: premium.premium.targetedPractice.skillId,
        contentRef: premium.premium.targetedPractice.contentRef,
      },
      now: new Date(NOW.getTime() + 2_000),
    });
    await finishing;
    await assert.rejects(supersededAssignment, /SPEAKING_TARGETED_PRACTICE_STALE/u,
      'file assignment must revalidate after a concurrently completed newer attempt');

    const refreshed = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    const refreshedTarget = refreshed.premium.targetedPractice;
    assert.equal(refreshedTarget.sourceAttemptId, followupClaim.attempt.id);
    const sessionsBeforeRevoke = (await repository.exportUserData(owner)).speaking_task2_sessions.length;
    const revoking = repository.revokeEntitlement(owner, 'voice_tutor', 8_209_099, {
      now: new Date(NOW.getTime() + 2_500),
    });
    const revokedAssignment = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id, catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: refreshedTarget.sourceAttemptId,
        reportRevision: refreshedTarget.reportRevision,
        accentLocale: refreshedTarget.accentLocale,
        skillId: refreshedTarget.skillId,
        contentRef: refreshedTarget.contentRef,
      },
      now: new Date(NOW.getTime() + 3_000),
    });
    assert.equal(await revoking, true);
    await assert.rejects(revokedAssignment, /SPEAKING_TARGETED_PRACTICE_STALE/u,
      'a targeted session cannot be created after the serialized Premium revocation');
    assert.equal((await repository.exportUserData(owner)).speaking_task2_sessions.length,
      sessionsBeforeRevoke, 'a completed revocation must leave no post-revoke session');
    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(NOW.getTime() + 3_100), endsAt: new Date(NOW.getTime() + 86_400_000),
    });
    const assistance = repository.markSpeakingSessionAssisted(owner, 2, followup.id, {
      now: new Date(NOW.getTime() + 3_200),
    });
    const racedAssignment = repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id, catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      targetedPracticeRequest: {
        sourceAttemptId: refreshedTarget.sourceAttemptId,
        reportRevision: refreshedTarget.reportRevision,
        accentLocale: refreshedTarget.accentLocale,
        skillId: refreshedTarget.skillId,
        contentRef: refreshedTarget.contentRef,
      },
      now: new Date(NOW.getTime() + 4_000),
    });
    await assistance;
    await assert.rejects(racedAssignment, /SPEAKING_TARGETED_PRACTICE_STALE/u,
      'file assignment must revalidate inside the same owner mutation queue after concurrent assistance');
  });
});

test('manual accent switch rejects the old pointer and scopes the next Premium report and session', async () => {
  await withServer(async ({ repository, owner, request }) => {
    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    const gbSession = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    assert.equal(gbSession.accentProfile.locale, 'en-GB');
    await completeTask2(request, owner, gbSession.id);
    const gbClaim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four British English questions.',
    }, 'speaking-evaluation-v1', 'e'.repeat(64), { now: NOW, source: {
      sessionId: gbSession.id, taskRef: gbSession.task.id, taskRevision: gbSession.task.revision,
      catalogId: gbSession.catalog.id, catalogRevision: gbSession.catalog.revision,
      accentLocale: 'en-GB', assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(gbClaim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });
    const gbReport = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    const oldGbTarget = gbReport.premium.targetedPractice;
    assert.equal(gbReport.activeAccentLocale, 'en-GB');
    assert.equal(oldGbTarget.accentLocale, 'en-GB');

    const switched = await (await request(owner, '/api/v1/speaking/accent-profile', {
      method: 'PUT', body: { locale: 'en-US' },
    })).json();
    assert.equal(switched.profile.locale, 'en-US');
    const oldPointer = await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { targetedPractice: {
        sourceAttemptId: oldGbTarget.sourceAttemptId,
        reportRevision: oldGbTarget.reportRevision,
        accentLocale: oldGbTarget.accentLocale,
        skillId: oldGbTarget.skillId,
        contentRef: oldGbTarget.contentRef,
      } },
    });
    assert.equal(oldPointer.status, 409);

    const beforeUsEvidence = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    assert.equal(beforeUsEvidence.activeAccentLocale, 'en-US');
    assert.equal(beforeUsEvidence.premium.targetedPractice, null,
      'old en-GB evidence cannot drive an en-US target');
    assert.deepEqual(beforeUsEvidence.premium.timeAllocationRecommendation, []);

    const usSession = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    assert.equal(usSession.accentProfile.locale, 'en-US');
    await completeTask2(request, owner, usSession.id);
    const usClaim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four American English questions.',
    }, 'speaking-evaluation-v1', 'f'.repeat(64), { now: new Date(NOW.getTime() + 1_000), source: {
      sessionId: usSession.id, taskRef: usSession.task.id, taskRevision: usSession.task.revision,
      catalogId: usSession.catalog.id, catalogRevision: usSession.catalog.revision,
      accentLocale: 'en-US', assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(usClaim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });

    const usReport = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    const usTarget = usReport.premium.targetedPractice;
    assert.equal(usReport.activeAccentLocale, 'en-US');
    assert.equal(usTarget.accentLocale, 'en-US');
    assert.ok(usReport.premium.trend.every((point) => point.accentLocale === 'en-US'));
    assert.ok(usReport.premium.timeAllocationRecommendation.every((item) => (
      item.accentLocale === 'en-US'
    )));
    const targeted = await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { targetedPractice: {
        sourceAttemptId: usTarget.sourceAttemptId,
        reportRevision: usTarget.reportRevision,
        accentLocale: usTarget.accentLocale,
        skillId: usTarget.skillId,
        contentRef: usTarget.contentRef,
      } },
    });
    assert.equal(targeted.status, 201);
    const targetedSession = await targeted.json();
    assert.equal(targetedSession.accentProfile.locale, usTarget.accentLocale);
    assert.equal(targetedSession.targetedPractice.accentLocale, usTarget.accentLocale);
  });
});

test('Premium learning-report API exposes an exact pronunciation pointer at a 4/4 official score', async () => {
  await withServer(async ({ repository, owner, request }) => {
    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    const assigned = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, assigned.id);
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four complete direct questions.',
    }, 'speaking-evaluation-v1', '7'.repeat(64), { now: NOW, source: {
      sessionId: assigned.id, taskRef: assigned.task.id, taskRevision: assigned.task.revision,
      catalogId: assigned.catalog.id, catalogRevision: assigned.catalog.revision,
      accentLocale: 'en-GB', assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: scoredReview({ allRelevant: true, phonemeLabel: 'w' }),
      provider: 'xai', model: 'test', errorCode: null,
    });

    const response = await request(owner, '/api/v1/speaking/learning-report');
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.currentAttempt.score, 4);
    assert.equal(report.currentAttempt.maxScore, 4);
    assert.equal(report.currentAttempt.masteryEligible, true);
    assert.equal(report.premium.voiceTutor.criterion, undefined);
    assert.deepEqual(report.premium.voiceTutor.pronunciationError, {
      ref: `phoneme.${claim.attempt.id}.0.0`, kind: 'phoneme',
      label: 'Фонема /w/ в слове «weather»', word: 'weather', phoneme: 'w',
      accuracyScore: 48, expectedMinimum: 80,
      observedAt: report.currentAttempt.observedAt, accentLocale: 'en-GB',
      expiresAt: new Date(new Date(report.currentAttempt.observedAt).getTime()
        + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    });
  });
});

test('learning report uses one owner-serialized attempts, entitlement and accent snapshot', async () => {
  await withServer(async ({ repository, owner, request }) => {
    assert.equal(typeof repository.getSpeakingLearningReportSnapshot, 'function');
    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    const session = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, session.id);
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four snapshot questions.',
    }, 'speaking-evaluation-v1', '9'.repeat(64), { now: NOW, source: {
      sessionId: session.id, taskRef: session.task.id, taskRevision: session.task.revision,
      catalogId: session.catalog.id, catalogRevision: session.catalog.revision,
      accentLocale: 'en-GB', assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });

    const switching = repository.setSpeakingAccentProfile(owner, {
      locale: 'en-US', source: 'manual', now: new Date(NOW.getTime() + 1_000),
    });
    const afterSwitchRequest = request(owner, '/api/v1/speaking/learning-report');
    await switching;
    const afterSwitch = await (await afterSwitchRequest).json();
    assert.equal(afterSwitch.activeAccentLocale, 'en-US');
    assert.equal(afterSwitch.premium.targetedPractice, null);

    const assisting = repository.markSpeakingSessionAssisted(owner, 2, session.id, {
      now: new Date(NOW.getTime() + 2_000),
    });
    const afterAssistanceRequest = request(owner, '/api/v1/speaking/learning-report');
    await assisting;
    const afterAssistance = await (await afterAssistanceRequest).json();
    assert.equal(afterAssistance.currentAttempt.masteryEligible, false);
    assert.deepEqual(afterAssistance.premium.trend, []);

    const revoking = repository.revokeEntitlement(owner, 'voice_tutor', 8_209_099, {
      now: NOW,
    });
    const afterRevokeRequest = request(owner, '/api/v1/speaking/learning-report');
    await revoking;
    const afterRevoke = await (await afterRevokeRequest).json();
    assert.equal(afterRevoke.access.tier, 'base');
    assert.equal(afterRevoke.premium, null);
  });
});

test('learning report rechecks Premium at effective time after the owner queue', async () => {
  let authorityNow = NOW;
  const hooks = new Map();
  await withServer(async ({ repository, owner, request }) => {
    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    hooks.set('getSpeakingLearningReportSnapshot', async (original, ...args) => {
      const revokedAt = new Date(NOW.getTime() + 1_000);
      authorityNow = revokedAt;
      assert.equal(await repository.revokeEntitlement(
        owner, 'voice_tutor', 8_209_099, { now: revokedAt },
      ), true);
      return original(...args);
    });

    const response = await request(owner, '/api/v1/speaking/learning-report');
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.access.tier, 'base');
    assert.equal(report.premium, null);
  }, {
    repositoryOptions: { speakingLearningNow: () => authorityNow },
    repositoryHooks: hooks,
  });
});

test('learning report rejects an expired Base subscription after the route precheck', async () => {
  let authorityNow = NOW;
  const hooks = new Map();
  await withServer(async ({ repository, owner, request }) => {
    const capturedRequestT0 = Date.now();
    hooks.set('getSpeakingLearningReportSnapshot', async (original, ...args) => {
      const current = await repository.getUser(owner);
      const expiresAt = new Date(capturedRequestT0 + 1_000);
      await repository.grantDays(
        Number(current.telegram_id),
        (expiresAt.getTime() - Number(current.sub_until)) / 86_400_000,
      );
      authorityNow = new Date(expiresAt.getTime() + 1);
      return original(...args);
    });

    const response = await request(owner, '/api/v1/speaking/learning-report');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'SUBSCRIPTION_REQUIRED');
  }, {
    repositoryOptions: { speakingLearningNow: () => authorityNow },
    repositoryHooks: hooks,
  });
});

test('targeted assignment rechecks Premium at effective time after the owner queue', async () => {
  let authorityNow = NOW;
  const hooks = new Map();
  await withServer(async ({ repository, owner, request }) => {
    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    const sourceSession = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, sourceSession.id);
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four targeted questions.',
    }, 'speaking-evaluation-v1', '8'.repeat(64), { now: NOW, source: {
      sessionId: sourceSession.id, taskRef: sourceSession.task.id,
      taskRevision: sourceSession.task.revision, catalogId: sourceSession.catalog.id,
      catalogRevision: sourceSession.catalog.revision, accentLocale: 'en-GB', assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });
    const report = await (await request(owner, '/api/v1/speaking/learning-report')).json();
    const target = report.premium.targetedPractice;
    assert.ok(target);

    hooks.set('assignSpeakingTask2Session', async (original, ...args) => {
      const revokedAt = new Date(NOW.getTime() + 2_000);
      authorityNow = revokedAt;
      assert.equal(await repository.revokeEntitlement(
        owner, 'voice_tutor', 8_209_099, { now: revokedAt },
      ), true);
      return original(...args);
    });
    const response = await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { targetedPractice: {
        sourceAttemptId: target.sourceAttemptId,
        reportRevision: target.reportRevision,
        accentLocale: target.accentLocale,
        skillId: target.skillId,
        contentRef: target.contentRef,
      } },
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'SPEAKING_TARGETED_PRACTICE_STALE');
  }, {
    repositoryOptions: { speakingLearningNow: () => authorityNow },
    repositoryHooks: hooks,
  });
});

test('targeted assignment rejects an expired Base subscription after the route precheck', async () => {
  let authorityNow = NOW;
  const hooks = new Map();
  await withServer(async ({ repository, owner, request }) => {
    await repository.setEntitlement(owner, 'voice_tutor', activePremiumWindow());
    const sourceSession = await (await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: {},
    })).json();
    await completeTask2(request, owner, sourceSession.id);
    const claim = await repository.claimSpeakingEvaluation(owner, {
      taskType: 2, assignment: {}, transcript: 'Four subscription race questions.',
    }, 'speaking-evaluation-v1', '7'.repeat(64), { now: NOW, source: {
      sessionId: sourceSession.id, taskRef: sourceSession.task.id,
      taskRevision: sourceSession.task.revision, catalogId: sourceSession.catalog.id,
      catalogRevision: sourceSession.catalog.revision, accentLocale: 'en-GB', assistanceUsed: false,
    } });
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', review: scoredReview(), provider: 'xai', model: 'test', errorCode: null,
    });
    const target = (await (await request(owner, '/api/v1/speaking/learning-report')).json())
      .premium.targetedPractice;
    assert.ok(target);
    const sessionsBefore = (await repository.exportUserData(owner)).speaking_task2_sessions.length;
    const capturedRequestT0 = Date.now();
    hooks.set('assignSpeakingTask2Session', async (original, ...args) => {
      const current = await repository.getUser(owner);
      const expiresAt = new Date(capturedRequestT0 + 1_000);
      await repository.grantDays(
        Number(current.telegram_id),
        (expiresAt.getTime() - Number(current.sub_until)) / 86_400_000,
      );
      authorityNow = new Date(expiresAt.getTime() + 1);
      return original(...args);
    });

    const response = await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { targetedPractice: {
        sourceAttemptId: target.sourceAttemptId,
        reportRevision: target.reportRevision,
        accentLocale: target.accentLocale,
        skillId: target.skillId,
        contentRef: target.contentRef,
      } },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'SUBSCRIPTION_REQUIRED');
    assert.equal((await repository.exportUserData(owner)).speaking_task2_sessions.length, sessionsBefore);
  }, {
    repositoryOptions: { speakingLearningNow: () => authorityNow },
    repositoryHooks: hooks,
  });
});

test('public contract, migration and owner export declare Speaking learning provenance', async () => {
  const [openapi, migration, fileRepository, postgresRepository, speakingRoutes, databaseSchema, retention] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../migrations/050_speaking_learning_loop.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../storage/file-repository.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../storage/postgres-repository.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../routes/speaking.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATABASE_SCHEMA.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
  ]);
  assert.match(openapi, /\/api\/v1\/speaking\/learning-report:/u);
  assert.match(openapi, /\/api\/v1\/speaking\/task-\{taskType\}\/sessions\/\{sessionId\}\/assistance:/u);
  assert.match(openapi, /SpeakingLearningReport:/u);
  assert.match(openapi, /attemptTimeline:/u);
  assert.match(openapi, /reportRevision:/u);
  assert.match(openapi, /activeAccentLocale:/u);
  assert.match(openapi, /accentLocale:/u);
  assert.match(openapi, /same_accent_locale_task_type_and_cefr/u);
  assert.match(openapi, /same_accent_locale/u);
  assert.match(openapi, /currentReliableAccentLocale/u);
  assert.match(openapi, /required: \[source, attemptId, revision, attemptSummary\]/u);
  assert.match(openapi, /required: \[pronunciationError\]/u);
  assert.match(openapi, /required: \[source, attemptId, revision, pronunciationErrorRef\]/u);
  assert.match(openapi, /expectedMinimum: \{ type: integer, enum: \[80\] \}/u);
  assert.match(openapi, /unexpectedBreakCount/u);
  assert.match(openapi, /missingBreakCount/u);
  assert.doesNotMatch(openapi, /enum: \[same_task_type_and_cefr\]/u);
  assert.equal((openapi.match(/assistanceUsed: \{ type: boolean \}/gu) || []).length, 4);
  assert.match(migration, /speaking_attempts_source_contract_check/u);
  assert.match(migration, /speaking_attempts_accent_locale_check/u);
  assert.equal((migration.match(/SET assistance_used = TRUE WHERE assistance_used IS NULL/gu) || []).length, 4);
  assert.equal((migration.match(/ALTER COLUMN assistance_used SET DEFAULT FALSE/gu) || []).length, 4);
  assert.match(postgresRepository,
    /source_catalog_id, source_catalog_revision, assistance_used, assistance_updated_at,[\s\S]{0,80}targeted_practice,[\s\S]{0,80}created_at/u);
  assert.match(fileRepository, /async function getSpeakingLearningReportSnapshot/u);
  assert.match(postgresRepository, /async function getSpeakingLearningReportSnapshot/u);
  assert.match(speakingRoutes, /db\.getSpeakingLearningReportSnapshot\(req\.user/u);
  assert.doesNotMatch(speakingRoutes,
    /Promise\.all\(\[[\s\S]{0,240}getSpeakingLearningAttempts\(req\.user/u);
  assert.match(databaseSchema, /Speaking learning evidence and adaptive transfer \(migration 050\)/u);
  assert.match(retention, /Speaking learning report and assistance provenance/u);
  const taxonomySize = EGE_SKILL_TAXONOMY.skills.length;
  assert.equal(taxonomySize, 21);
  assert.doesNotMatch(openapi, /establishedSkillCount:[\s\S]{0,180}maximum: 12/u);
  assert.match(openapi, new RegExp(`skills: \\{ type: array, minItems: ${taxonomySize}, maxItems: ${taxonomySize},`, 'u'));
  assert.match(migration, /assistance_updated_at TIMESTAMPTZ/u);
  assert.match(migration, /targeted_practice JSONB/u);
  assert.equal((migration.match(/jsonb_typeof\(targeted_practice\) = 'object'/gu) || []).length, 5,
    'the attempt and every task session table must reject malformed targeted-practice JSON');
  assert.match(postgresRepository, /targeted_practice/u);
  assert.match(postgresRepository, /speakingAdaptiveEvidenceMatchesTarget\(evidence/u);
  const bindStart = postgresRepository.indexOf('async function bindAdaptiveLearningServerAttempt');
  const bindEnd = postgresRepository.indexOf('async function getModuleAttempt', bindStart);
  const bindSource = postgresRepository.slice(bindStart, bindEnd);
  assert.match(bindSource, /FROM speaking_attempts[\s\S]{0,160}FOR UPDATE/u);
  assert.match(postgresRepository, /speaking_task\$\{taskType\}_sessions[\s\S]{0,160}FOR UPDATE/u);
  assert.match(openapi,
    /recordingDurationSeconds: \{ type: number, minimum: 0, maximum: 200 \}/u);
  assert.match(openapi,
    /score: \{ type: number, minimum: 0, maximum: 100 \}[\s\S]{0,100}maxScore: \{ type: number, minimum: 1, maximum: 100 \}/u);
});
