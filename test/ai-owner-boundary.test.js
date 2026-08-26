import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { createAiRoutes } from '../routes/ai.js';

test('AI content owner mismatch short-circuits before subscription and privacy gates', async () => {
  let subscriptionChecks = 0;
  let consentChecks = 0;
  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use(createAiRoutes({
    authentication: {
      auth(req, res, next) {
        const owner = req.get('x-test-user');
        if (!owner) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = owner;
        return next();
      },
    },
    access: {
      privacyPolicyVersion: 'owner-boundary-test-v1',
      createOperationLimiter: () => pass,
      requireAiBudget: pass,
      requireActiveSubscription(_req, res) {
        subscriptionChecks += 1;
        return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
      },
      requirePrivacyConsent: () => (_req, res) => {
        consentChecks += 1;
        return res.status(403).json({ error: { code: 'PRIVACY_CONSENT_REQUIRED' } });
      },
      hasAiBudget: async () => true,
    },
    db: {},
    providerClient: {
      limitsFor: () => ({ requestsPerHour: 1 }),
    },
  }).router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ai/generate-content`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'owner-b',
        'x-easyboost-expected-owner': 'owner-a',
      },
      body: JSON.stringify({ operation: 'grammar_quiz' }),
    });

    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'OWNER_CHANGED');
    assert.equal(subscriptionChecks, 0);
    assert.equal(consentChecks, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
