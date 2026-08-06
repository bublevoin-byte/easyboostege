import { SPEAKING_TASK3_CATALOG } from '../../public/content/speaking/task3-v1.js';

export async function assertSpeakingTask3SessionRepositoryContract(assert, repository, owner, other) {
  let now = new Date('2026-08-06T12:00:00.000Z');
  const session = await repository.assignSpeakingTask3Session(owner, {
    catalogId: SPEAKING_TASK3_CATALOG.id,
    catalogRevision: SPEAKING_TASK3_CATALOG.revision,
    tasks: SPEAKING_TASK3_CATALOG.tasks,
    now,
  });
  assert.equal(session.current_question, 1);
  assert.equal(session.answers.length, 5);
  assert.equal(await repository.getSpeakingTask3Session(other, session.id), null);

  now = new Date(now.getTime() + 22_000);
  const first = await repository.completeSpeakingTask3Answer(owner, session.id, 1, {
    recordingDurationSeconds: 22, localPlayback: true, selfRating: 'steady',
  }, { now });
  assert.equal(first.current_question, 2);
  assert.equal(first.answers[0].status, 'completed');
  await assert.rejects(
    repository.completeSpeakingTask3Answer(owner, session.id, 3, {
      recordingDurationSeconds: 22, localPlayback: true, selfRating: 'steady',
    }, { now }),
    { code: 'SPEAKING_TASK3_ANSWER_OUT_OF_SEQUENCE' },
  );

  let completed;
  for (let questionNumber = 2; questionNumber <= 5; questionNumber += 1) {
    now = new Date(now.getTime() + 22_000);
    completed = await repository.completeSpeakingTask3Answer(owner, session.id, questionNumber, {
      recordingDurationSeconds: 22, localPlayback: questionNumber !== 2, selfRating: 'steady',
    }, { now });
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.answers.length, 5);
  assert.equal(completed.answers.every((answer) => answer.status === 'completed'), true);

  const replayed = await repository.completeSpeakingTask3Answer(owner, session.id, 5, {
    recordingDurationSeconds: 1, localPlayback: false, selfRating: 'weak',
  }, { now: new Date(now.getTime() + 1_000) });
  assert.equal(Number(replayed.answers[4].recordingDurationSeconds), 22);

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.speaking_task3_sessions.length, 1);
  assert.equal(exported.speaking_task3_sessions[0].answers.length, 5);
  assert.equal(Object.hasOwn(exported.speaking_task3_sessions[0], 'username'), false);
  assert.equal(/\b(?:audio|transcript|score)\b/iu.test(JSON.stringify(exported.speaking_task3_sessions)), false);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.getSpeakingTask3Session(owner, session.id), null);
}
