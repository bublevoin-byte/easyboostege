export async function assertVkIdRepositoryContract(assert, repository, seed = '1') {
  const now = new Date('2026-08-26T08:00:00.000Z');
  const activeStateHash = String(seed).padStart(64, 'a').slice(-64);
  const expiredStateHash = String(seed).padStart(64, 'b').slice(-64);
  const missingStateHash = String(seed).padStart(64, 'c').slice(-64);
  const redirectUri = 'https://aisy.example/api/v1/auth/vk/callback';

  await repository.createOAuthTransaction({
    provider: 'vk', stateHash: activeStateHash, verifierSealed: 'sealed-verifier-active',
    redirectUri, expiresAt: new Date(now.getTime() + 600_000), now,
  });
  const concurrent = await Promise.all([
    repository.consumeOAuthTransaction(activeStateHash, { now }),
    repository.consumeOAuthTransaction(activeStateHash, { now }),
  ]);
  const ready = concurrent.find((result) => result.status === 'ready');
  assert.ok(ready, 'one concurrent consumer must win');
  assert.equal(concurrent.filter((result) => result.status === 'ready').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'replayed').length, 1);
  assert.deepEqual(ready, {
    status: 'ready',
    transaction: {
      provider: 'vk', verifierSealed: 'sealed-verifier-active', redirectUri,
      expiresAt: '2026-08-26T08:10:00.000Z',
    },
  });
  assert.deepEqual(await repository.consumeOAuthTransaction(activeStateHash, { now }), { status: 'replayed' });

  await repository.createOAuthTransaction({
    provider: 'vk', stateHash: expiredStateHash, verifierSealed: 'sealed-verifier-expired',
    redirectUri, expiresAt: new Date(now.getTime() - 1), now: new Date(now.getTime() - 700_000),
  });
  assert.deepEqual(await repository.consumeOAuthTransaction(expiredStateHash, { now }), { status: 'expired' });
  assert.equal(await repository.purgeOAuthTransactions({ now }), 1);
  assert.deepEqual(await repository.consumeOAuthTransaction(expiredStateHash, { now }), { status: 'missing' });
  assert.deepEqual(await repository.consumeOAuthTransaction(missingStateHash, { now }), { status: 'missing' });

  const telegramUsername = await repository.createTelegramUser(Number(`71${seed}`), 'Одинаковое имя');
  const first = await repository.findOrCreateProviderUser({
    provider: 'vk', subject: `vk-${seed}-one`, displayName: 'Одинаковое имя', now,
  });
  assert.notEqual(first.username, telegramUsername, 'provider identity must never auto-link by display name');
  assert.equal(first.display_name, 'Одинаковое имя');
  assert.equal((await repository.getSub(first.username)).active, false, 'identity creation must not grant access');

  const replay = await repository.findOrCreateProviderUser({
    provider: 'vk', subject: `vk-${seed}-one`, displayName: 'Обновлённое имя', now,
  });
  assert.equal(replay.username, first.username);
  assert.equal(replay.display_name, 'Обновлённое имя');

  const second = await repository.findOrCreateProviderUser({
    provider: 'vk', subject: `vk-${seed}-two`, displayName: 'Одинаковое имя', now,
  });
  assert.notEqual(second.username, first.username);

  const exported = await repository.exportUserData(first.username);
  assert.equal(exported.account.identity_provider, 'vk');
  assert.equal(exported.account.identity_subject, `vk-${seed}-one`);
  assert.equal(exported.account.display_name, 'Обновлённое имя');
  assert.equal('oauth_auth_transactions' in exported, false);

  assert.equal(await repository.deleteUserData(first.username), true);
  assert.equal(await repository.exportUserData(first.username), null);
  const recreated = await repository.findOrCreateProviderUser({
    provider: 'vk', subject: `vk-${seed}-one`, displayName: 'После удаления', now,
  });
  assert.notEqual(recreated.username, first.username, 'deleted identity must receive a fresh opaque username');
  assert.match(recreated.username, /^learner_[A-Za-z0-9_-]{16}$/u);
}
