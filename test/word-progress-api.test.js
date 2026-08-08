import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';

async function withServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-word-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  await repository.createUser('owner', 'hash');
  await repository.createUser('other', 'hash');
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({
    authentication: {
      auth(req, res, next) {
        const username = req.get('x-test-user');
        if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = username;
        return next();
      },
    },
    db: repository,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, repository);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('authenticated word-progress API migrates legacy payloads and isolates richer mastery by owner', async () => {
  await withServer(async (baseUrl) => {
    const now = Date.parse('2026-08-04T10:00:00.000Z');
    const legacyResponse = await fetch(`${baseUrl}/api/v1/word-progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
      body: JSON.stringify({ words: [{
        word: ' To Achieve ', stage: 3, errorCount: 1, reviewCount: 4, dueAt: now,
      }] }),
    });
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(await legacyResponse.json(), { updated: 1 });

    const otherResponse = await fetch(`${baseUrl}/api/v1/word-progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'other', 'x-easyboost-expected-owner': 'other' },
      body: JSON.stringify({ words: [{
        word: 'private', stage: 5, errorCount: 0, reviewCount: 10, dueAt: now,
      }] }),
    });
    assert.equal(otherResponse.status, 200);

    const response = await fetch(`${baseUrl}/api/v1/word-progress`, {
      headers: { 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-easyboost-response-owner'), 'owner');
    const body = await response.json();
    assert.equal(body.words.length, 1);
    assert.equal(body.words[0].word, 'achieve');
    assert.equal(body.words[0].masteryVersion, 1);
    assert.equal(body.words[0].dimensions.context.evidence, 'preliminary');
    assert.equal(body.words.some((item) => item.word === 'private'), false);

    const richer = structuredClone(body.words[0]);
    richer.stage = 4;
    richer.reviewCount += 1;
    richer.dimensions.spelling = {
      score: 80, attempts: 5, independentSuccesses: 1,
      evidence: 'objective', lastPracticedAt: now + 1_000,
    };
    richer.lastMode = 'english_production';
    richer.lastOutcome = 'correct';
    const richerResponse = await fetch(`${baseUrl}/api/v1/word-progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
      body: JSON.stringify({ words: [richer] }),
    });
    assert.equal(richerResponse.status, 200);
    const reloaded = await fetch(`${baseUrl}/api/v1/word-progress`, {
      headers: { 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
    });
    assert.deepEqual((await reloaded.json()).words, [richer]);

    const legacyAgain = await fetch(`${baseUrl}/api/v1/word-progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
      body: JSON.stringify({ words: [{
        word: 'to achieve', stage: 3, errorCount: 2, reviewCount: 6, dueAt: now + 2_000,
      }] }),
    });
    assert.equal(legacyAgain.status, 200);
    const afterLegacy = await fetch(`${baseUrl}/api/v1/word-progress`, {
      headers: { 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
    });
    const preserved = (await afterLegacy.json()).words[0];
    assert.equal(preserved.dimensions.spelling.independentSuccesses, 1);
    assert.equal(preserved.dimensions.spelling.evidence, 'objective');

    assert.equal((await fetch(`${baseUrl}/api/v1/word-progress`)).status, 401);
    const invalid = await fetch(`${baseUrl}/api/v1/word-progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' },
      body: JSON.stringify({ words: [{
        word: 'unsafe', stage: 1, errorCount: 0, reviewCount: 1, dueAt: now,
        owner: 'other',
      }] }),
    });
    assert.equal(invalid.status, 400);
  });
});

test('word progress rejects a shared-cookie owner switch before read or mutation', async () => {
  await withServer(async (baseUrl, repository) => {
    const missingOwner = await fetch(`${baseUrl}/api/v1/word-progress`, {
      headers: { 'x-test-user': 'owner' },
    });
    assert.equal(missingOwner.status, 400);
    const wrongWrite = await fetch(`${baseUrl}/api/v1/word-progress`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json', 'x-test-user': 'other',
        'x-easyboost-expected-owner': 'owner',
      },
      body: JSON.stringify({ words: [{
        word: 'private', stage: 1, errorCount: 0, reviewCount: 1, dueAt: 0,
      }] }),
    });
    assert.equal(wrongWrite.status, 409);
    assert.deepEqual(await repository.getWordProgress('other'), []);
    const wrongRead = await fetch(`${baseUrl}/api/v1/word-progress`, {
      headers: { 'x-test-user': 'other', 'x-easyboost-expected-owner': 'owner' },
    });
    assert.equal(wrongRead.status, 409);
  });
});

test('word progress OpenAPI documents required and authoritative owner headers', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const contract = openapi.match(/  \/api\/v1\/word-progress:[\s\S]*?(?=\n  \/api\/v1\/error-bank:)/u)?.[0] || '';
  assert.equal((contract.match(/#\/components\/parameters\/ExpectedOwner/gu) || []).length, 2);
  assert.equal((contract.match(/X-EasyBoost-Response-Owner/gu) || []).length, 4);
  assert.equal((contract.match(/OWNER_CHANGED/gu) || []).length, 2);
});

test('personal cards use bounded progress persistence with owner, export and deletion parity', async () => {
  await withServer(async (baseUrl, repository) => {
    const card = {
      cardVersion: 1, id: 'personal:volunteer', canonicalWord: 'volunteer', word: 'volunteer',
      provenance: 'personal', meanings: ['волонтёр'], pronunciation: null,
      partOfSpeech: null, level: null,
      contexts: [{ text: 'They volunteer in other countries.', source: 'reading' }],
      createdAt: 1_000, updatedAt: 2_000,
    };
    const requestCard = { ...card, contexts: [{
      text: '  They volunteer in other countries.  ', source: 'reading',
    }] };
    const stored = await fetch(`${baseUrl}/api/v1/progress/modules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
      body: JSON.stringify({ owner: 'owner', modules: {
        personalWords: [requestCard], personalWordTombstones: ['personal:volunteer'],
      } }),
    });
    assert.equal(stored.status, 200);
    assert.deepEqual((await stored.json()).progress.personalWords, [card]);

    const other = await fetch(`${baseUrl}/api/v1/progress`, {
      headers: { 'x-test-user': 'other', 'x-easyboost-expected-owner': 'other' },
    });
    assert.deepEqual(await other.json(), {});
    assert.deepEqual((await repository.exportUserData('owner')).progress.personalWords, [card]);
    assert.deepEqual((await repository.getProgress('owner')).personalWordTombstones, ['personal:volunteer']);

    const malformed = await fetch(`${baseUrl}/api/v1/progress/modules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
      body: JSON.stringify({ owner: 'owner', modules: { personalWords: [{ ...card, provenance: 'core' }] } }),
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual((await repository.getProgress('owner')).personalWords, [card]);

    const malformedTombstone = await fetch(`${baseUrl}/api/v1/progress/modules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
      body: JSON.stringify({ owner: 'owner', modules: { personalWordTombstones: ['core:volunteer'] } }),
    });
    assert.equal(malformedTombstone.status, 400);
    assert.deepEqual((await repository.getProgress('owner')).personalWordTombstones, ['personal:volunteer']);

    assert.equal(await repository.deleteUserData('owner'), true);
    assert.equal(await repository.exportUserData('owner'), null);
  });
});
