import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';

async function withPreferencesApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-learner-preferences-'));
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
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (username, pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-test-user': username,
      ...(options.headers || {}),
    },
  });
  try {
    await run({ request, repository });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('learner preferences are strictly validated and isolated by the authenticated owner', async () => {
  await withPreferencesApp(async ({ request }) => {
    const save = async (learnerPreferences) => request('owner', '/api/v1/progress/modules', {
      method: 'POST',
      body: JSON.stringify({ modules: { learnerPreferences } }),
    });

    const lowerBoundary = {
      version: 1,
      schoolGrade: 8,
      preferredSessionMinutes: 15,
    };
    assert.equal((await save(lowerBoundary)).status, 200);

    const upperBoundary = {
      version: 1,
      schoolGrade: 11,
      preferredSessionMinutes: 120,
    };
    assert.equal((await save(upperBoundary)).status, 200);
    assert.deepEqual(await (await request('owner', '/api/v1/progress')).json(), {
      learnerPreferences: upperBoundary,
    });
    assert.deepEqual(await (await request('other', '/api/v1/progress')).json(), {});

    for (const malformed of [
      { ...upperBoundary, schoolGrade: 7 },
      { ...upperBoundary, schoolGrade: 12 },
      { ...upperBoundary, schoolGrade: '11' },
      { ...upperBoundary, schoolGrade: null, preferredSessionMinutes: 10 },
      { ...upperBoundary, preferredSessionMinutes: 16 },
      { ...upperBoundary, preferredSessionMinutes: 125 },
      { ...upperBoundary, preferredSessionMinutes: '30' },
      { ...upperBoundary, targetScore: 85 },
    ]) {
      assert.equal((await save(malformed)).status, 400, JSON.stringify(malformed));
    }

    assert.equal((await save({
      version: 1,
      schoolGrade: null,
      preferredSessionMinutes: 30,
    })).status, 200);
    assert.deepEqual((await (await request('owner', '/api/v1/progress')).json()).learnerPreferences, {
      version: 1,
      schoolGrade: null,
      preferredSessionMinutes: 30,
    });
  });
});

test('public contract and ADR record preferences without claiming future integrations exist', async () => {
  const [openapi, decision] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/adr/0002-learner-auth-and-payments-direction.md', import.meta.url), 'utf8'),
  ]);

  assert.match(openapi, /LearnerPreferences:/u);
  assert.match(openapi, /schoolGrade:[^\n]*minimum: 8[^\n]*maximum: 11/u);
  assert.match(openapi, /preferredSessionMinutes:[^\n]*minimum: 15[^\n]*maximum: 120[^\n]*multipleOf: 5/u);
  assert.match(openapi, /learnerPreferences:[^\n]*LearnerPreferences/u);

  assert.match(decision, /ученики[^.]*только через VK ID/iu);
  assert.match(decision, /администратор[^.]*staging[^.]*отдельн/iu);
  assert.match(decision, /Robokassa/iu);
  assert.match(decision, /PLACEHOLDER — выбрать перед реализацией оплаты/u);
  assert.match(decision, /VK OAuth[^.]*не реализ/iu);
  assert.match(decision, /плат[её]ж[^.]*не реализ/iu);
  assert.doesNotMatch(decision, /(?:secret|token|password)\s*[=:]\s*\S+/iu);
});
