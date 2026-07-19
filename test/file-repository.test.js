import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileRepository } from '../storage/file-repository.js';

async function withRepository(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-db-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  try {
    await run(repository, file);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('file repository persists progress atomically', async () => {
  await withRepository(async (repository, file) => {
    const username = await repository.createTelegramUser(1001, 'Test User');
    await Promise.all([
      repository.saveProgress(username, { value: 1 }),
      repository.saveProgress(username, { value: 2 }),
    ]);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(parsed.progress[username].value, 2);
  });
});

test('trial and subscription status are persisted', async () => {
  await withRepository(async (repository) => {
    const result = await repository.grantDays(1002, 30, 'Student');
    await repository.markTrialUsed(1002, 'Student');
    const subscription = await repository.getSub(result.username);
    assert.equal(subscription.active, true);
    assert.equal(subscription.trial_used, true);
  });
});

test('telegram user creation is idempotent', async () => {
  await withRepository(async (repository) => {
    const first = await repository.createTelegramUser(1003, 'Same User');
    const second = await repository.createTelegramUser(1003, 'Changed Name');
    assert.equal(second, first);
  });
});

