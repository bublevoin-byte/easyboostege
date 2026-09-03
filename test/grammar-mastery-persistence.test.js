import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileRepository } from '../storage/file-repository.js';
import { assertGrammarMasteryProgressContract } from './support/grammar-mastery-progress-contract.js';

test('file progress keeps Grammar mastery durable, owner-bound, exportable and deletable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-grammar-mastery-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const owner = await repository.createTelegramUser(8_800_001, 'Grammar Owner');
    const stranger = await repository.createTelegramUser(8_800_002, 'Grammar Stranger');
    await assertGrammarMasteryProgressContract(repository, owner, stranger);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an empty canonical map does not suppress one-time legacy migration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-grammar-empty-canonical-'));
  const dataFile = path.join(directory, 'data.json');
  let repository = createFileRepository(dataFile);
  try {
    const owner = await repository.createTelegramUser(8_800_003, 'Empty Canonical');
    await repository.close();
    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    stored.progress[owner] = {
      grammarMastery: {},
      gram: { 1: { st: 2, ok: 8, err: 1, sr: 4, rs: 2, due: 12_345 } },
    };
    await fs.writeFile(dataFile, JSON.stringify(stored));
    repository = createFileRepository(dataFile);
    const restored = await repository.getProgress(owner);
    assert.equal(restored.grammarMastery['1'].stage, 'learned');
    assert.equal(restored.grammarMastery['1'].stats.correct, 8);

    await repository.mergeProgress(owner, { gram: { 2: { st: 2, ok: 99 } } });
    const canonicalOwnsTruth = await repository.getProgress(owner);
    assert.equal(canonicalOwnsTruth.grammarMastery['2'], undefined,
      'once a canonical topic exists, later legacy keys cannot merge into canonical truth');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
