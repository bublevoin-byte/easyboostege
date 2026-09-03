import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileRepository } from '../storage/file-repository.js';
import { assertSpeakingAccentCalibrationRepositoryContract } from './support/speaking-accent-calibration-contract.js';

test('file and PostgreSQL adapters share the Speaking accent/calibration contract (file side)', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-accent-repository-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9_682_001, 'Accent repository owner');
  const expertAName = 'Accent repository expert A';
  const expertA = await repository.createTelegramUser(9_682_002, expertAName);
  const expertB = await repository.createTelegramUser(9_682_003, 'Accent repository expert B');
  try {
    const { sampleId } = await assertSpeakingAccentCalibrationRepositoryContract(
      assert, repository, {
        owner, expertA, expertB,
        recreateExpertA: () => repository.createTelegramUser(9_682_004, expertAName),
      },
    );
    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.exportUserData(owner), null);
    assert.equal((await repository.listAnonymousSpeakingCalibrationLabels())
      .some((entry) => entry.sampleId === sampleId), true);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
