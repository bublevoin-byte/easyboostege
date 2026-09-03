import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileRepository } from '../storage/file-repository.js';
import { assertVkIdRepositoryContract } from './support/vk-id-repository-contract.js';

test('file repository implements one-time VK flow and provider identity parity contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-vk-id-file-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try { await assertVkIdRepositoryContract(assert, repository, '8101'); }
  finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
