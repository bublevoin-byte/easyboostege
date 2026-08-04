export function personalWordsProgressCard() {
  return {
    cardVersion: 1,
    id: 'personal:volunteer',
    canonicalWord: 'volunteer',
    word: 'volunteer',
    provenance: 'personal',
    meanings: ['волонтёр'],
    pronunciation: null,
    partOfSpeech: null,
    level: null,
    contexts: [{ text: 'They volunteer in other countries.', source: 'reading' }],
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

export async function assertPersonalWordsProgressRepositoryContract(
  assert, repository, owner, other,
) {
  const card = personalWordsProgressCard();
  await repository.mergeProgress(owner, {
    personalWords: [card], personalWordTombstones: ['personal:removed'],
  });
  assert.deepEqual((await repository.getProgress(owner)).personalWords, [card]);
  assert.deepEqual(await repository.getProgress(other), {});
  const exported = await repository.exportUserData(owner);
  assert.deepEqual(exported.progress.personalWords, [card]);
  assert.deepEqual(exported.progress.personalWordTombstones, ['personal:removed']);
  assert.equal(await repository.deleteUserData(owner), true);
  assert.deepEqual(await repository.getProgress(owner), {});
  assert.equal(await repository.exportUserData(owner), null);
}
