import crypto from 'node:crypto';

function metadataFor(set, attemptId) {
  return {
    mode: set.kind === 'task10' ? 'reading_headings'
      : set.kind === 'task11' ? 'reading_gaps' : 'reading_detail',
    source: 'catalog', helpUsed: false, hintsUsed: 0,
    readingProvenance: 'canonical', readingSetId: set.id,
    readingSetRevision: set.revision, readingKind: set.kind, readingCefr: set.cefr,
    readingContentRef: `builtin:reading:${set.kind}:${set.cefr === 'B1' ? 'b1' : set.cefr === 'B2' ? 'b2' : 'b2-plus-c1'}:v1`,
    readingAttemptId: attemptId, readingSlice: set.kind === 'task10' ? 'gist' : 'detail',
    readingIndependent: true,
  };
}

export async function assertReadingReportRepositoryContract(assert, repository, owner, other, sets) {
  const attempts = [
    { id: crypto.randomUUID(), set: sets.task10, score: 4, maxScore: 7, durationMs: 70_000 },
    { id: crypto.randomUUID(), set: sets.task11, score: 5, maxScore: 6, durationMs: 60_000 },
    { id: crypto.randomUUID(), set: sets.task12_18, score: 6, maxScore: 7, durationMs: 80_000 },
  ];
  for (const attempt of attempts) {
    await repository.recordModuleAttempt(owner, {
      id: attempt.id, module: 'reading',
      activity: attempt.set.kind === 'task10' ? 'reading_headings'
        : attempt.set.kind === 'task11' ? 'reading_gaps' : 'reading_detail',
      score: attempt.score, maxScore: attempt.maxScore, durationMs: attempt.durationMs,
      metadata: metadataFor(attempt.set, attempt.id),
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  const otherId = crypto.randomUUID();
  await repository.recordModuleAttempt(other, {
    id: otherId, module: 'reading', activity: 'reading_headings', score: 7, maxScore: 7,
    durationMs: 70_000, metadata: metadataFor(sets.task10, otherId),
  });
  const nonReadingId = crypto.randomUUID();
  await repository.recordModuleAttempt(owner, {
    id: nonReadingId, module: 'grammar', activity: 'grammar_forms', score: 1, maxScore: 1,
    durationMs: 1_000, metadata: { source: 'builtin' },
  });

  const bounded = await repository.getReadingCompletedAttempts(owner, { limit: 2 });
  assert.equal(bounded.length, 2);
  assert.deepEqual(new Set(bounded.map((attempt) => attempt.id)), new Set(attempts.slice(1).map((attempt) => attempt.id)));
  assert.equal(bounded.every((attempt) => attempt.username === owner && attempt.module === 'reading'), true);
  assert.equal(JSON.stringify(bounded).includes(otherId), false);
  assert.equal(JSON.stringify(bounded).includes(nonReadingId), false);

  const all = await repository.getReadingCompletedAttempts(owner, { limit: 500 });
  assert.equal(all.length, 3);
  assert.deepEqual(new Set(all.map((attempt) => attempt.id)), new Set(attempts.map((attempt) => attempt.id)));
}

export { metadataFor as readingReportAttemptMetadata };
