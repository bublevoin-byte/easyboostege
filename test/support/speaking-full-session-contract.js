import { SPEAKING_TASK1_CATALOG } from '../../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../../public/content/speaking/task4-v1.js';
import { SPEAKING_SCORING_VERSION } from '../../speaking/fipi-scoring.js';

const catalogs = [
  SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
  SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
];

export async function assertFullSpeakingSessionRepositoryContract(assert, repository, owner, other) {
  let now = new Date('2026-08-06T10:00:00.000Z');
  const stale = await repository.assignFullSpeakingSession(other, { catalogs, now });
  const revisedCatalogs = structuredClone(catalogs);
  revisedCatalogs[0].tasks[stale.variant_index].revision += 1;
  const replacement = await repository.assignFullSpeakingSession(other, { catalogs: revisedCatalogs, now });
  assert.notEqual(replacement.id, stale.id);
  assert.equal(await repository.getFullSpeakingSession(other, stale.id), null);
  const replacementExport = await repository.exportUserData(other);
  assert.equal(
    replacementExport.speaking_full_sessions.find((item) => item.id === stale.id)?.status,
    'abandoned',
  );
  await repository.deleteUserData(other);

  const session = await repository.assignFullSpeakingSession(owner, { catalogs, now });
  assert.equal(session.maximum_score, 20);
  assert.equal(session.assignments.length, 4);
  assert.equal(await repository.getFullSpeakingSession(other, session.id), null);

  const responseCounts = { 1: 1, 2: 4, 3: 5, 4: 1 };
  for (const taskType of [1, 2, 3, 4]) {
    for (let responseNumber = 1; responseNumber <= responseCounts[taskType]; responseNumber += 1) {
      let active = await repository.advanceFullSpeakingSessionStage(owner, session.id, { now });
      if (active.phase === 'preparing') {
        active = await repository.advanceFullSpeakingSessionStage(owner, session.id, { now });
      }
      assert.equal(active.phase, 'recording');
      now = new Date(now.getTime() + 10_000);
      const completed = await repository.completeFullSpeakingSessionResponse(owner, session.id, {
        taskType, responseNumber, responseStatus: 'completed', recordingDurationSeconds: 10,
        micCheck: 'passed', localPlayback: false,
        assessmentAudioSha256: `${taskType}${responseNumber}`.repeat(32),
      }, { now });
      assert.equal(completed.responses[taskType - 1].entries[responseNumber - 1].status, 'completed');
    }
  }

  const key = '75500000-0000-4000-8000-000000000020';
  const first = await repository.submitFullSpeakingSessionResult(owner, session.id, key, { now });
  const replay = await repository.submitFullSpeakingSessionResult(
    owner, session.id, '75500000-0000-4000-8000-000000000021',
    { now: new Date(now.getTime() + 1_000) },
  );
  assert.deepEqual(replay.result, first.result);
  assert.equal(first.result.maximumScore, 20);
  assert.equal(first.result.earnedScore, null);

  const assessmentKey = '75500000-0000-4000-8000-000000000022';
  const claimed = await repository.claimFullSpeakingSessionAssessment(owner, session.id, {
    taskType: 1, responseNumber: 1, audioSha256: '11'.repeat(32),
    idempotencyKey: assessmentKey, durationSeconds: 10,
  });
  assert.equal(claimed.responses[0].entries[0].assessment_idempotency_key, assessmentKey);
  assert.equal((await repository.claimFullSpeakingSessionAssessment(owner, session.id, {
    taskType: 1, responseNumber: 1, audioSha256: '11'.repeat(32),
    idempotencyKey: assessmentKey, durationSeconds: 10,
  })).responses[0].entries[0].assessment_idempotency_key, assessmentKey);
  await assert.rejects(
    repository.claimFullSpeakingSessionAssessment(owner, session.id, {
      taskType: 1, responseNumber: 1, audioSha256: '11'.repeat(32),
      idempotencyKey: '75500000-0000-4000-8000-000000000023', durationSeconds: 10,
    }),
    { message: 'SPEAKING_FULL_RESPONSE_ASSESSMENT_CONFLICT' },
  );
  await assert.rejects(
    repository.claimFullSpeakingSessionAssessment(owner, session.id, {
      taskType: 2, responseNumber: 1, audioSha256: 'ff'.repeat(32),
      idempotencyKey: '75500000-0000-4000-8000-000000000024', durationSeconds: 10,
    }),
    { message: 'SPEAKING_FULL_RESPONSE_ASSESSMENT_MISMATCH' },
  );

  const attemptIds = [];
  for (const assignment of session.assignments) {
    const taskType = Number(assignment.task_type);
    const claim = await repository.claimSpeakingEvaluation(
      owner,
      { taskType, assignment: { serverOwned: true }, transcript: `Trusted task ${taskType}` },
      'speaking-semantic-v4',
      String(taskType).repeat(64),
      { source: {
        sessionMode: 'full_section', sessionId: session.id,
        taskRef: assignment.task_id, taskRevision: assignment.task_revision,
        catalogId: assignment.catalog_id, catalogRevision: assignment.catalog_revision,
        accentLocale: session.accent_locale, assistanceUsed: false, targetedPractice: null,
      } },
    );
    assert.equal(claim.created, true);
    await repository.finishSpeakingAttempt(claim.attempt.id, {
      status: 'completed', provider: 'test', model: 'test-model', review: {
        status: 'scored', got: assignment.max_score, max: assignment.max_score,
        verdict: `Task ${taskType}`, criteria: [], good: [], fix: [],
        scoringVersion: SPEAKING_SCORING_VERSION,
        acousticFacts: { signalQuality: 'good', accentLocale: session.accent_locale },
      },
    }, { claimGeneration: claim.attempt.evaluation_claim_generation });
    attemptIds.push(Number(claim.attempt.id));
  }
  const evaluated = await repository.completeFullSpeakingSessionEvaluation(
    owner, session.id, attemptIds, { now: new Date(now.getTime() + 2_000) },
  );
  assert.equal(evaluated.result.earnedScore, 20);
  assert.equal(evaluated.result.assessment.scoreKind, 'approximate');
  assert.deepEqual(evaluated.result.taskResults.map((item) => item.attemptId), attemptIds);
  assert.equal(await repository.completeFullSpeakingSessionEvaluation(
    other, session.id, attemptIds, { now },
  ), null);
  assert.deepEqual((await repository.completeFullSpeakingSessionEvaluation(
    owner, session.id, attemptIds, { now },
  )).result, evaluated.result);

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.speaking_full_sessions.length, 1);
  assert.equal(Object.hasOwn(exported.speaking_full_sessions[0], 'username'), false);
  assert.equal(Object.hasOwn(exported.speaking_full_sessions[0], 'submission_key'), false);
  assert.equal(/(?:audio|transcript|rubric|reference)/iu.test(JSON.stringify(exported.speaking_full_sessions)), false);
  assert.equal(exported.speaking_full_sessions[0].submission_response.earnedScore, 20);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.getFullSpeakingSession(owner, session.id), null);
}
