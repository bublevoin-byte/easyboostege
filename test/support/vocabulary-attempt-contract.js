import { buildVocabularyModuleAttempt } from '../../public/vocabulary-domain.js';

export async function assertVocabularyAttemptRepositoryContract(assert, repository, owner, other) {
  const attempt = buildVocabularyModuleAttempt([
    { mode: 'english_production', outcome: 'correct' },
    { mode: 'contextual_production', outcome: 'incorrect' },
    { mode: 'listening', outcome: 'correct' },
    { mode: 'receptive_meaning', outcome: 'correct' },
    { mode: 'russian_reveal', outcome: 'knew' },
  ], {
    id: 'dc910c13-beb6-4dbb-9f61-85ffc3368556',
    durationMs: 72_000,
  });
  assert.equal((await repository.recordModuleAttempt(owner, attempt)).created, true);
  assert.equal((await repository.recordModuleAttempt(owner, {
    ...attempt,
    score: 3,
    metadata: { ...attempt.metadata, objectiveCorrect: 3 },
  })).created, false, 'a replay cannot replace the canonical evidence row');

  const stored = await repository.getModuleAttempt(owner, attempt.id);
  assert.equal(stored.score, 2);
  assert.equal(stored.max_score, 3);
  assert.equal(stored.evidence_quality, 'client_reported');
  assert.deepEqual(stored.metadata, attempt.metadata);
  assert.equal(await repository.getModuleAttempt(other, attempt.id), null);

  const ownerEvidence = await repository.getAdaptiveLearningEvidenceSources(owner);
  assert.equal(ownerEvidence.attempts.filter((entry) => entry.id === attempt.id).length, 1);
  const otherEvidence = await repository.getAdaptiveLearningEvidenceSources(other);
  assert.equal(otherEvidence.attempts.some((entry) => entry.id === attempt.id), false);

  const exported = await repository.exportUserData(owner);
  const exportedAttempt = exported.module_attempts.find((entry) => entry.id === attempt.id);
  assert.equal(exportedAttempt.evidence_quality, 'client_reported');
  assert.deepEqual(exportedAttempt.metadata, attempt.metadata);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.getModuleAttempt(owner, attempt.id), null);
  assert.equal((await repository.getAdaptiveLearningEvidenceSources(owner))
    .attempts.some((entry) => entry.id === attempt.id), false);
  assert.notEqual(await repository.exportUserData(other), null);
}
