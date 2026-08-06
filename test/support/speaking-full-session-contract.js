import { SPEAKING_TASK1_CATALOG } from '../../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../../public/content/speaking/task4-v1.js';

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

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.speaking_full_sessions.length, 1);
  assert.equal(Object.hasOwn(exported.speaking_full_sessions[0], 'username'), false);
  assert.equal(Object.hasOwn(exported.speaking_full_sessions[0], 'submission_key'), false);
  assert.equal(/(?:audio|transcript|rubric|reference)/iu.test(JSON.stringify(exported.speaking_full_sessions)), false);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.getFullSpeakingSession(owner, session.id), null);
}
