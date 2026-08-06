import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileRepository } from '../storage/file-repository.js';
import { assertSpeakingTask4SessionRepositoryContract } from './support/speaking-task4-session-contract.js';

test('file task 4 sessions match owner isolation, replay, export and deletion contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-task4-storage-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_420_001, 'Task Four Storage Owner');
  const other = await repository.createTelegramUser(8_420_002, 'Task Four Storage Other');
  try {
    await assertSpeakingTask4SessionRepositoryContract(assert, repository, owner, other);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
