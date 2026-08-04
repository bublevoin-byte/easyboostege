import crypto from 'node:crypto';

const GOAL_KEYS = Object.freeze([
  'created_at',
  'exam_date',
  'id',
  'revision',
  'target_exam',
  'target_score',
  'updated_at',
  'weekly_minutes',
]);

export async function assertAdaptiveGoalRepositoryContract(assert, repository, username, goal) {
  const saved = await repository.saveAdaptiveLearningGoal(username, goal);
  const duplicate = await repository.saveAdaptiveLearningGoal(username, { ...goal, id: crypto.randomUUID() });
  const loaded = await repository.getAdaptiveLearningGoal(username);
  const exported = await repository.exportUserData(username);

  assert.equal(saved.created, true);
  assert.equal(duplicate.created, false);
  assert.deepEqual(saved.goal, duplicate.goal);
  assert.deepEqual(saved.goal, loaded);
  assert.deepEqual(Object.keys(loaded).sort(), [...GOAL_KEYS]);
  assert.equal(loaded.exam_date, goal.examDate, 'file and PostgreSQL preserve the same calendar exam date');
  assert.equal(loaded.created_at, goal.now.toISOString());
  assert.equal(loaded.updated_at, goal.now.toISOString());
  assert.deepEqual(exported.adaptive_learning_goals, [loaded]);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), loaded, 'goal DTO is already backend-independent JSON');
  return loaded;
}
