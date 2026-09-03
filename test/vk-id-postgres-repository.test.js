import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { createPostgresRepository } from '../storage/postgres-repository.js';
import { assertVkIdRepositoryContract } from './support/vk-id-repository-contract.js';

const connectionString = process.env.TEST_DATABASE_URL;

test('VK ID migration keeps provider identities generic and encrypted flows separate', async () => {
  const [migration, repository] = await Promise.all([
    fs.readFile(new URL('../migrations/056_vk_id_identity.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../storage/postgres-repository.js', import.meta.url), 'utf8'),
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS learner_identities/u);
  assert.match(migration, /PRIMARY KEY\s*\(provider,\s*subject\)/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS oauth_auth_transactions/u);
  assert.match(migration, /verifier_sealed/u);
  assert.match(repository, /SET consumed_at = \$2, verifier_sealed = NULL/u);
  assert.doesNotMatch(migration, /access_token|refresh_token|client_secret/iu);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS users_identity_check/u);
  assert.match(migration, /identity_managed/u);
});

test('PostgreSQL repository implements one-time VK flow and provider identity parity contract', {
  skip: !connectionString,
}, async () => {
  const repository = createPostgresRepository(connectionString);
  try { await assertVkIdRepositoryContract(assert, repository, String(Date.now()).slice(-6)); }
  finally { await repository.close(); }
});
