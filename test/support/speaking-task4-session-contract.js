import { SPEAKING_TASK4_CATALOG } from '../../public/content/speaking/task4-v1.js';

export async function assertSpeakingTask4SessionRepositoryContract(assert, repository, owner, other) {
  const now = new Date('2026-08-06T14:00:00.000Z');
  const session = await repository.assignSpeakingTask4Session(owner, {
    catalogId: SPEAKING_TASK4_CATALOG.id,
    catalogRevision: SPEAKING_TASK4_CATALOG.revision,
    tasks: SPEAKING_TASK4_CATALOG.tasks,
    now,
  });
  assert.equal(session.status, 'assigned');
  assert.equal(await repository.getSpeakingTask4Session(other, session.id), null);

  const restored = await repository.getSpeakingTask4Session(owner, session.id);
  assert.equal(restored.task_id, session.task_id);
  const completed = await repository.completeSpeakingTask4Session(owner, session.id, {
    recordingDurationSeconds: 171, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
  }, { now: new Date(now.getTime() + 171_000) });
  assert.equal(completed.status, 'completed');
  assert.equal(Number(completed.recording_duration_seconds), 171);

  const replayed = await repository.completeSpeakingTask4Session(owner, session.id, {
    recordingDurationSeconds: 1, micCheck: 'skipped', localPlayback: false, selfRating: 'weak',
  }, { now: new Date(now.getTime() + 172_000) });
  assert.equal(Number(replayed.recording_duration_seconds), 171);

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.speaking_task4_sessions.length, 1);
  assert.equal(Object.hasOwn(exported.speaking_task4_sessions[0], 'username'), false);
  assert.equal(/\b(?:audio|transcript|score)\b/iu.test(JSON.stringify(exported.speaking_task4_sessions)), false);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.getSpeakingTask4Session(owner, session.id), null);
}
