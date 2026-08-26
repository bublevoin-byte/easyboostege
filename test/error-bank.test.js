import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import express from 'express';
import { createProgressRoutes } from '../routes/progress.js';
import { errorBankBatchSchema } from '../validation/error-bank.js';

test('error bank accepts bounded flat diagnostic entries', () => {
  const parsed = errorBankBatchSchema.safeParse({ errors: [{ module: 'grammar', itemKey: 'grammar_19_24:go', errorType: 'incorrect_form', details: { expected: 'went' } }] });
  assert.equal(parsed.success, true);
  assert.equal(errorBankBatchSchema.safeParse({ errors: [{ module: 'grammar', itemKey: 'x', errorType: 'Bad Type', details: {} }] }).success, false);
  assert.equal(errorBankBatchSchema.safeParse({ errors: [{ module: 'grammar', itemKey: 'x', errorType: 'incorrect', details: { nested: { raw: 'answer' } } }] }).success, false);
});

test('error-bank mutation requires and returns the exact cookie owner', async () => {
  const writes = [];
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({
    authentication: {
      auth(req, res, next) {
        const owner = req.get('x-test-user');
        if (!owner) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = owner;
        return next();
      },
    },
    db: {
      async upsertErrorBank(owner, errors) {
        writes.push({ owner, errors });
        return { updated: errors.length };
      },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ errors: [{
    module: 'grammar', itemKey: 'grammar_19_24:go', errorType: 'incorrect_form', details: { expected: 'went' },
  }] });
  const request = (headers) => fetch(`${baseUrl}/api/v1/error-bank`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  });
  try {
    const missing = await request({ 'x-test-user': 'owner' });
    assert.equal(missing.status, 400);
    const mismatch = await request({ 'x-test-user': 'owner-b', 'x-easyboost-expected-owner': 'owner' });
    assert.equal(mismatch.status, 409);
    assert.equal(writes.length, 0);

    const accepted = await request({ 'x-test-user': 'owner', 'x-easyboost-expected-owner': 'owner' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('x-easyboost-response-owner'), 'owner');
    assert.deepEqual(writes.map(({ owner }) => owner), ['owner']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('error-bank OpenAPI documents strict owner request and response binding', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const contract = openapi.match(/  \/api\/v1\/error-bank:[\s\S]*?(?=\n  \/api\/v1\/ai\/evaluate-writing:)/u)?.[0] || '';
  assert.equal((contract.match(/#\/components\/parameters\/ExpectedOwner/gu) || []).length, 1);
  assert.equal((contract.match(/X-EasyBoost-Response-Owner/gu) || []).length, 2);
  assert.equal((contract.match(/OWNER_CHANGED/gu) || []).length, 1);
});
