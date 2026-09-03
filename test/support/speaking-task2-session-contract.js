import { SPEAKING_TASK2_CATALOG } from '../../public/content/speaking/task2-v1.js';

export async function assertSpeakingTask2SessionRepositoryContract(assert, repository, owner, other) {
  let now = new Date('2026-08-06T10:00:00.000Z');
  const targetedPractice = {
    sourceAttemptId: 42,
    reportRevision: 'attempt.42.1786093200000',
    accentLocale: 'en-GB',
    skillId: 'ege.speaking.pronunciation_phonemes',
    label: 'Звук /w/ в слове weather',
    contentRef: 'server:speaking:task:2:skill:ege.speaking.pronunciation_phonemes:focus:phoneme.1.2.1:new:v1',
    focus: {
      kind: 'phoneme', value: 'w', anchorWord: 'weather', ref: 'phoneme.1.2.1',
    },
  };
  const targetedTask = SPEAKING_TASK2_CATALOG.tasks.find((task) => /weather/iu.test(JSON.stringify(task)));
  assert.ok(targetedTask);
  const session = await repository.assignSpeakingTask2Session(owner, {
    catalogId: SPEAKING_TASK2_CATALOG.id,
    catalogRevision: SPEAKING_TASK2_CATALOG.revision,
    tasks: SPEAKING_TASK2_CATALOG.tasks,
    preferredTaskIds: [targetedTask.id],
    selectionReason: 'targeted_focus',
    targetedPractice,
    now,
  });
  assert.equal(session.current_question, 1);
  assert.equal(session.questions.length, 4);
  assert.equal(session.selection_reason, 'targeted_focus');
  assert.deepEqual(session.targeted_practice, targetedPractice);
  assert.equal(await repository.getSpeakingTask2Session(other, session.id), null);

  now = new Date(now.getTime() + 12_000);
  const first = await repository.completeSpeakingTask2Question(owner, session.id, 1, {
    recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
  }, { now });
  assert.equal(first.current_question, 2);
  assert.equal(first.questions[0].status, 'completed');
  await assert.rejects(
    repository.completeSpeakingTask2Question(owner, session.id, 3, {
      recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
    }, { now }),
    { code: 'SPEAKING_TASK2_QUESTION_OUT_OF_SEQUENCE' },
  );

  let completed;
  for (let questionNumber = 2; questionNumber <= 4; questionNumber += 1) {
    now = new Date(now.getTime() + 12_000);
    completed = await repository.completeSpeakingTask2Question(owner, session.id, questionNumber, {
      recordingDurationSeconds: 12, localPlayback: questionNumber !== 2, selfRating: 'steady',
    }, { now });
  }
  assert.equal(completed.status, 'completed');
  assert.equal(completed.questions.length, 4);
  assert.equal(completed.questions.every((question) => question.status === 'completed'), true);

  const replayed = await repository.completeSpeakingTask2Question(owner, session.id, 4, {
    recordingDurationSeconds: 1, localPlayback: false, selfRating: 'weak',
  }, { now: new Date(now.getTime() + 1_000) });
  assert.equal(Number(replayed.questions[3].recordingDurationSeconds), 12);

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.speaking_task2_sessions.length, 1);
  assert.equal(exported.speaking_task2_sessions[0].questions.length, 4);
  assert.deepEqual(exported.speaking_task2_sessions[0].targeted_practice, targetedPractice);
  assert.equal(Object.hasOwn(exported.speaking_task2_sessions[0], 'username'), false);
  assert.equal(/\b(?:audio|transcript|score)\b/iu.test(JSON.stringify(exported.speaking_task2_sessions)), false);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.getSpeakingTask2Session(owner, session.id), null);
}
