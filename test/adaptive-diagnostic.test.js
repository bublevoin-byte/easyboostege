import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import express from 'express';

import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { buildAdaptiveLearningProfile, EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';
import {
  createDiagnosticRegistry,
  DIAGNOSTIC_REGISTRY,
  getDiagnosticCatalog,
  getDiagnosticItem,
  getDiagnosticPolicy,
  publicDiagnosticItem,
  selectDiagnosticItem,
  SHORT_DIAGNOSTIC_CATALOG,
} from '../adaptive-learning/diagnostic-catalog.js';
import { createFileRepository } from '../storage/file-repository.js';

const STARTED_AT = new Date('2026-08-04T09:00:00.000Z');

function testAuthentication() {
  return {
    auth(req, res, next) {
      const username = String(req.headers['x-test-user'] || '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      next();
    },
  };
}

async function withDiagnosticApp(run, { enabled = true, diagnosticRegistry } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-diagnostic-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  const owner = await repository.createTelegramUser(9201, 'Diagnostic Owner');
  const stranger = await repository.createTelegramUser(9202, 'Diagnostic Stranger');
  let currentTime = new Date(STARTED_AT);
  const app = express();
  app.use(express.json());
  app.use(createAdaptiveLearningRoutes({
    authentication: testAuthentication(),
    db: repository,
    now: () => new Date(currentTime),
    enabled,
    ...(diagnosticRegistry ? { diagnosticRegistry } : {}),
  }));
  app.use((error, req, res, next) => {
    res.status(500).json({ error: { code: error.code || error.message || 'INTERNAL_ERROR' } });
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(username ? { 'X-Test-User': username } : {}),
        ...(options.headers || {}),
      },
    },
  );
  try {
    await run({
      repository, owner, stranger, request, file,
      setTime(value) { currentTime = new Date(value); },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function renderDiagnosticDom(screenSource, payload) {
  const element = (overrides = {}) => ({
    hidden: false,
    disabled: false,
    dataset: {},
    textContent: '',
    value: 0,
    max: 1,
    replaceChildren() {},
    ...overrides,
  });
  const elements = {
    adaptive_diagnostic: element(),
    adaptive_diagnostic_start: element(),
    adaptive_diagnostic_form: element({ querySelector() { return null; } }),
    adaptive_diagnostic_question: element(),
    adaptive_diagnostic_prompt: element(),
    adaptive_diagnostic_choices: element(),
    adaptive_diagnostic_audio: element(),
    adaptive_diagnostic_complete: element(),
    adaptive_diagnostic_notice: element(),
    adaptive_diagnostic_progress: element(),
    adaptive_diagnostic_progress_label: element(),
    adaptive_diagnostic_timing: element(),
  };
  const executable = screenSource
    .replace(/^import .*;\r?\n/gmu, '')
    .replace(/^registerRouteHook\(.*\);\r?$/gmu, '')
    .replace(/^export \{.*\};\r?$/gmu, '')
    .concat('\nglobalThis.__drawAdaptiveDiagnostic = drawAdaptiveDiagnostic;');
  const context = {
    document: {
      getElementById(id) { return elements[id] || null; },
      createElement() { return element({ setAttribute() {}, appendChild() {} }); },
      createTextNode(value) { return { textContent: value }; },
    },
    window: {},
    console,
  };
  vm.runInNewContext(executable, context);
  context.__drawAdaptiveDiagnostic(payload);
  return elements;
}

test('new learner starts and resumes one server-owned bounded diagnostic without answer leakage', async () => {
  await withDiagnosticApp(async ({ owner, request }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-start-owner-0001' },
      body: '{}',
    });
    assert.equal(started.status, 201);
    const payload = await started.json();
    assert.equal(payload.required, true);
    assert.equal(payload.diagnostic.status, 'in_progress');
    assert.equal(payload.diagnostic.catalogVersion, 'ege-short-diagnostic-v1');
    assert.equal(payload.diagnostic.estimatedMinutes, 15);
    assert.equal(payload.diagnostic.answeredItems, 0);
    assert.equal(payload.diagnostic.maxItems, 12);
    assert.ok(payload.item.id);
    assert.ok(payload.item.prompt);
    assert.ok(payload.item.choices.length >= 2);
    assert.equal('correctChoiceId' in payload.item, false);
    assert.equal('skillId' in payload.item, false);
    assert.equal('answer' in payload.item, false);

    const current = await request(owner, '/api/v1/adaptive-learning/diagnostics/current');
    assert.equal(current.status, 200);
    const resumed = await current.json();
    assert.equal(resumed.diagnostic.id, payload.diagnostic.id);
    assert.equal(resumed.item.id, payload.item.id);

    const replay = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-start-owner-0001' },
      body: '{}',
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).diagnostic.id, payload.diagnostic.id);
  });
});

test('accepted answers adapt the next private probe before completion without becoming profile evidence', async () => {
  await withDiagnosticApp(async ({ owner, stranger, request }) => {
    const start = async (username, key) => {
      const response = await request(username, '/api/v1/adaptive-learning/diagnostics/start', {
        method: 'POST', headers: { 'Idempotency-Key': key }, body: '{}',
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    const correctBranch = await start(owner, 'diagnostic-adaptive-correct-start-01');
    const incorrectBranch = await start(stranger, 'diagnostic-adaptive-wrong-start-001');
    assert.equal(correctBranch.item.id, 'grammar-forms-present-perfect-1');
    assert.equal(incorrectBranch.item.id, correctBranch.item.id);
    assert.equal('skillId' in correctBranch.item, false);
    assert.equal('correctChoiceId' in correctBranch.item, false);

    const answer = async (username, branch, choiceId, key) => {
      const response = await request(
        username,
        `/api/v1/adaptive-learning/diagnostics/${branch.diagnostic.id}/answers`,
        {
          method: 'POST', headers: { 'Idempotency-Key': key },
          body: JSON.stringify({ itemId: branch.item.id, choiceId }),
        },
      );
      assert.equal(response.status, 201);
      return response.json();
    };
    const afterCorrect = await answer(
      owner, correctBranch, 'a', 'diagnostic-adaptive-correct-answer-01',
    );
    const afterIncorrect = await answer(
      stranger, incorrectBranch, 'b', 'diagnostic-adaptive-wrong-answer-001',
    );

    assert.equal(afterCorrect.item.id, 'listening-detail-museum-1');
    assert.equal(afterIncorrect.item.id, 'grammar-transformations-despite-1');
    assert.notEqual(afterCorrect.item.id, afterIncorrect.item.id);
    const correctOverview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    const incorrectOverview = await (await request(stranger, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(correctOverview.profile.evidenceCount, 0);
    assert.equal(incorrectOverview.profile.evidenceCount, 0);
  });
});

test('versioned catalog covers each taxonomy skill and selection prefers uncertain high-impact gaps', () => {
  assert.equal(SHORT_DIAGNOSTIC_CATALOG.version, 'ege-short-diagnostic-v1');
  assert.equal(getDiagnosticCatalog('ege-short-diagnostic-v1'), SHORT_DIAGNOSTIC_CATALOG);
  assert.equal(getDiagnosticCatalog('unknown-diagnostic-version'), null);
  assert.equal(
    getDiagnosticItem('ege-short-diagnostic-v1', 'grammar-forms-present-perfect-1')?.skillId,
    'ege.grammar.forms',
  );
  assert.equal(getDiagnosticItem('unknown-diagnostic-version', 'grammar-forms-present-perfect-1'), null);
  assert.deepEqual(
    [...new Set(SHORT_DIAGNOSTIC_CATALOG.items.map((item) => item.skillId))].sort(),
    EGE_SKILL_TAXONOMY.skills.map((skill) => skill.id).sort(),
  );
  for (const item of SHORT_DIAGNOSTIC_CATALOG.items) {
    assert.ok(item.choices.some((choice) => choice.id === item.correctChoiceId));
    const safe = publicDiagnosticItem(item);
    assert.equal('correctChoiceId' in safe, false);
    assert.equal('skillId' in safe, false);
    assert.equal('evidenceQuality' in safe, false);
    if (item.presentation === 'audio') {
      assert.match(safe.measurementNotice, /ориентировочная/u);
      assert.match(safe.measurementNotice, /не подтверждает навык/u);
    }
  }
  const selected = selectDiagnosticItem('ege-short-diagnostic-v1', {
    skills: [
      ...EGE_SKILL_TAXONOMY.skills.map((skill) => ({ id: skill.id, uncertainty: 0 })),
      { id: 'ege.grammar.forms', uncertainty: 10 },
      { id: 'ege.vocabulary.word_formation', uncertainty: 100 },
      { id: 'ege.reading.detail', uncertainty: 100 },
    ],
  });
  assert.equal(selected.skillId, 'ege.reading.detail');
  assert.notEqual(selectDiagnosticItem('ege-short-diagnostic-v1', {}, [selected.id])?.id, selected.id);
  assert.equal(selectDiagnosticItem('unknown-diagnostic-version', {}, []), null);
});

test('diagnostic registry versions catalog and policy together instead of borrowing current limits', () => {
  assert.equal(DIAGNOSTIC_REGISTRY.currentVersion, 'ege-short-diagnostic-v1');
  assert.equal(getDiagnosticPolicy('ege-short-diagnostic-v1').maximumItems, 12);
  assert.equal(getDiagnosticPolicy('unknown-diagnostic-version'), null);

  const historicPolicy = Object.freeze({
    catalogVersion: 'diagnostic-historic-v1', estimatedMinutes: 5,
    minimumItems: 1, targetItems: 2, maximumItems: 3,
    targetSeconds: 240, maximumSeconds: 300,
  });
  const futurePolicy = Object.freeze({
    catalogVersion: 'diagnostic-future-v2', estimatedMinutes: 40,
    minimumItems: 4, targetItems: 8, maximumItems: 9,
    targetSeconds: 2_100, maximumSeconds: 2_400,
  });
  const versionedCatalog = (version) => Object.freeze({
    version,
    items: SHORT_DIAGNOSTIC_CATALOG.items,
  });
  const registry = createDiagnosticRegistry([
    { catalog: versionedCatalog(historicPolicy.catalogVersion), policy: historicPolicy },
    { catalog: versionedCatalog(futurePolicy.catalogVersion), policy: futurePolicy },
  ], { currentVersion: futurePolicy.catalogVersion });

  assert.equal(registry.currentVersion, 'diagnostic-future-v2');
  assert.equal(registry.get('diagnostic-historic-v1').policy.maximumItems, 3);
  assert.equal(registry.get('diagnostic-historic-v1').catalog.version, 'diagnostic-historic-v1');
  assert.equal(registry.get('diagnostic-future-v2').policy.maximumItems, 9);
});

test('public resume keeps the stored v1 policy when the registry current version changes', async () => {
  const futurePolicy = Object.freeze({
    catalogVersion: 'diagnostic-future-v2', estimatedMinutes: 40,
    minimumItems: 4, targetItems: 8, maximumItems: 9,
    targetSeconds: 2_100, maximumSeconds: 2_400,
  });
  const futureCatalog = Object.freeze({
    version: futurePolicy.catalogVersion,
    items: SHORT_DIAGNOSTIC_CATALOG.items,
  });
  const registry = createDiagnosticRegistry([
    DIAGNOSTIC_REGISTRY.get('ege-short-diagnostic-v1'),
    { catalog: futureCatalog, policy: futurePolicy },
  ], { currentVersion: futurePolicy.catalogVersion });

  await withDiagnosticApp(async ({ repository, owner, stranger, request }) => {
    await repository.startAdaptiveDiagnostic(owner, {
      id: crypto.randomUUID(),
      idempotencyKey: 'diagnostic-historic-policy-start-01',
      requestHash: crypto.createHash('sha256').update('{}').digest('hex'),
      catalogVersion: 'ege-short-diagnostic-v1',
      currentItemId: 'grammar-forms-present-perfect-1',
      now: STARTED_AT,
      expiresAt: new Date(STARTED_AT.getTime() + 1_200_000),
    });
    const resumed = await request(owner, '/api/v1/adaptive-learning/diagnostics/current');
    assert.equal(resumed.status, 200);
    const historic = await resumed.json();
    assert.equal(historic.diagnostic.catalogVersion, 'ege-short-diagnostic-v1');
    assert.equal(historic.diagnostic.estimatedMinutes, 15);
    assert.equal(historic.diagnostic.maxItems, 12);

    const started = await request(stranger, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-future-policy-start-001' }, body: '{}',
    });
    assert.equal(started.status, 201);
    const future = await started.json();
    assert.equal(future.diagnostic.catalogVersion, 'diagnostic-future-v2');
    assert.equal(future.diagnostic.estimatedMinutes, 40);
    assert.equal(future.diagnostic.maxItems, 9);
    assert.equal(future.diagnostic.deadlineMinutes, 40);
    assert.equal(
      new Date(future.diagnostic.expiresAt).getTime() - new Date(future.diagnostic.startedAt).getTime(),
      2_400_000,
    );
  }, { diagnosticRegistry: registry });
});

test('a completed synthetic v2 diagnostic becomes profile evidence through the injected registry', async () => {
  const v2Policy = Object.freeze({
    catalogVersion: 'diagnostic-synthetic-v2', estimatedMinutes: 40,
    minimumItems: 1, targetItems: 1, maximumItems: 9,
    targetSeconds: 2_100, maximumSeconds: 2_400,
  });
  const v2Catalog = Object.freeze({
    version: v2Policy.catalogVersion,
    items: SHORT_DIAGNOSTIC_CATALOG.items,
  });
  const registry = createDiagnosticRegistry([
    DIAGNOSTIC_REGISTRY.get('ege-short-diagnostic-v1'),
    { catalog: v2Catalog, policy: v2Policy },
  ], { currentVersion: v2Policy.catalogVersion });

  await withDiagnosticApp(async ({ owner, request }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-v2-profile-start-0001' }, body: '{}',
    });
    assert.equal(started.status, 201);
    const startPayload = await started.json();
    assert.equal(startPayload.diagnostic.catalogVersion, v2Policy.catalogVersion);
    assert.equal(startPayload.item.id, 'grammar-forms-present-perfect-1');

    const answered = await request(
      owner,
      `/api/v1/adaptive-learning/diagnostics/${startPayload.diagnostic.id}/answers`,
      {
        method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-v2-profile-answer-0001' },
        body: JSON.stringify({ itemId: startPayload.item.id, choiceId: 'a' }),
      },
    );
    assert.equal(answered.status, 201);
    assert.equal((await answered.json()).diagnostic.status, 'ready');

    const complete = () => request(
      owner,
      `/api/v1/adaptive-learning/diagnostics/${startPayload.diagnostic.id}/complete`,
      {
        method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-v2-profile-complete-01' }, body: '{}',
      },
    );
    const concurrent = await Promise.all([complete(), complete()]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 201]);
    const concurrentBodies = await Promise.all(concurrent.map((response) => response.text()));
    assert.equal(concurrentBodies[0], concurrentBodies[1]);
    const completion = JSON.parse(concurrentBodies[0]);
    assert.equal(completion.profile.evidenceCount, 1);
    assert.equal(completion.profile.needsDiagnostic, false);
    assert.equal(completion.profile.explanationCodes.includes('short_diagnostic_complete'), true);
    const grammar = completion.profile.skills.find((skill) => skill.id === 'ege.grammar.forms');
    assert.equal(grammar.evidenceCount, 1);
    assert.equal(grammar.independentEvidenceCount, 1);
    assert.equal(grammar.explanationCode, 'diagnostic_evidence');

    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(overview.profile.evidenceCount, 1);
    assert.equal(overview.profile.needsDiagnostic, false);
  }, { diagnosticRegistry: registry });
});

test('replayable browser listening probes stay assisted and cannot create independent mastery', () => {
  const profile = buildAdaptiveLearningProfile({
    diagnosticResponses: [
      {
        catalog_version: 'ege-short-diagnostic-v1',
        item_id: 'listening-detail-museum-1',
        skill_id: 'ege.listening.detail',
        module: 'listening',
        correct: true,
        answered_at: '2026-08-04T09:01:00.000Z',
      },
      {
        catalog_version: 'ege-short-diagnostic-v1',
        item_id: 'grammar-forms-present-perfect-1',
        skill_id: 'ege.grammar.forms',
        module: 'grammar',
        correct: true,
        answered_at: '2026-08-04T09:02:00.000Z',
      },
      {
        catalog_version: 'unknown-diagnostic-version',
        item_id: 'grammar-transformations-despite-1',
        skill_id: 'ege.grammar.transformations',
        module: 'grammar',
        correct: true,
        answered_at: '2026-08-04T09:02:30.000Z',
      },
    ],
    diagnosticCompletions: [{
      catalog_version: 'ege-short-diagnostic-v1',
      completed_at: '2026-08-04T09:03:00.000Z',
    }],
  });
  const listening = profile.skills.find((skill) => skill.id === 'ege.listening.detail');
  const grammar = profile.skills.find((skill) => skill.id === 'ege.grammar.forms');
  assert.equal(listening.independentEvidenceCount, 0);
  assert.equal(listening.evidenceQuality, 'assisted');
  assert.equal(listening.mastery, 49);
  assert.equal(listening.uncertainty, 100);
  assert.equal(listening.status, 'preliminary');
  assert.equal(listening.explanationCode, 'assisted_local_tts_diagnostic');
  assert.equal(grammar.independentEvidenceCount, 1);
  assert.equal(grammar.mastery, 100);
  assert.equal(profile.independentEvidenceCount, 1);
  assert.equal(profile.assistedEvidenceCount, 1);
  assert.equal(profile.evidenceCount, 2);
});

test('diagnostic endpoints require authentication, explicit rollout and bounded identifiers', async () => {
  await withDiagnosticApp(async ({ owner, request }) => {
    assert.equal((await request('', '/api/v1/adaptive-learning/diagnostics/current')).status, 401);
    const malformed = await request(owner, '/api/v1/adaptive-learning/diagnostics/not-a-uuid/answers', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-malformed-id-01' },
      body: JSON.stringify({ itemId: 'grammar-forms-present-perfect-1', choiceId: 'a' }),
    });
    assert.equal(malformed.status, 400);
  });
  await withDiagnosticApp(async ({ owner, request }) => {
    assert.equal((await request(owner, '/api/v1/adaptive-learning/diagnostics/current')).status, 404);
    assert.equal((await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-disabled-start-1' }, body: '{}',
    })).status, 404);
  }, { enabled: false });
});

test('new diagnostic start keys are user-rate-limited while an existing replay stays available', async () => {
  await withDiagnosticApp(async ({ owner, request }) => {
    const firstKey = 'diagnostic-rate-start-key-001';
    const first = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': firstKey }, body: '{}',
    });
    assert.equal(first.status, 201);
    const diagnosticId = (await first.json()).diagnostic.id;
    for (let attempt = 2; attempt <= 12; attempt += 1) {
      const response = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
        method: 'POST',
        headers: { 'Idempotency-Key': `diagnostic-rate-start-key-${String(attempt).padStart(3, '0')}` },
        body: '{}',
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).diagnostic.id, diagnosticId);
    }
    const limited = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-rate-start-key-013' }, body: '{}',
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'DIAGNOSTIC_START_RATE_LIMIT');

    const replay = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': firstKey }, body: '{}',
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).diagnostic.id, diagnosticId);
  });
});

test('a stored unsupported catalog version fails closed instead of using current item mappings', async () => {
  await withDiagnosticApp(async ({ repository, owner, request }) => {
    const diagnosticId = crypto.randomUUID();
    await repository.startAdaptiveDiagnostic(owner, {
      id: diagnosticId,
      idempotencyKey: 'diagnostic-start-unknown-version-01',
      requestHash: crypto.createHash('sha256').update('{}').digest('hex'),
      catalogVersion: 'unknown-diagnostic-version',
      currentItemId: 'grammar-forms-present-perfect-1',
      now: STARTED_AT,
      expiresAt: new Date('2026-08-04T09:20:00.000Z'),
    });
    const current = await request(owner, '/api/v1/adaptive-learning/diagnostics/current');
    assert.equal(current.status, 409);
    assert.equal((await current.json()).error.code, 'DIAGNOSTIC_CATALOG_UNSUPPORTED');

    const claimedReplay = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-unknown-version-01' }, body: '{}',
    });
    assert.equal(claimedReplay.status, 409);
    assert.equal((await claimedReplay.json()).error.code, 'DIAGNOSTIC_CATALOG_UNSUPPORTED');

    await repository.answerAdaptiveDiagnostic(owner, {
      id: crypto.randomUUID(),
      diagnosticId,
      itemId: 'grammar-forms-present-perfect-1',
      skillId: 'ege.grammar.forms',
      module: 'grammar',
      evidenceQuality: 'independent',
      choiceId: 'a',
      correct: true,
      responseMs: 1_000,
      idempotencyKey: 'diagnostic-answer-unknown-version-01',
      requestHash: 'b'.repeat(64),
      nextItemId: null,
      status: 'ready',
      stopReason: 'target_coverage',
      now: new Date('2026-08-04T09:01:00.000Z'),
    });
    await repository.completeAdaptiveDiagnostic(owner, {
      diagnosticId,
      idempotencyKey: 'diagnostic-complete-unknown-version-01',
      requestHash: 'c'.repeat(64),
      now: new Date('2026-08-04T09:02:00.000Z'),
      responseSnapshot: {
        completed: true,
        diagnostic: {
          id: diagnosticId,
          catalogVersion: 'unknown-diagnostic-version',
          status: 'completed',
          estimatedMinutes: 1,
          deadlineMinutes: 20,
          answeredItems: 1,
          maxItems: 12,
          progressPercent: 10,
          canComplete: true,
          stopReason: 'target_coverage',
          startedAt: STARTED_AT,
          expiresAt: new Date('2026-08-04T09:20:00.000Z'),
          completedAt: new Date('2026-08-04T09:02:00.000Z'),
        },
        item: null,
        result: {
          preliminary: true,
          confidence: 0,
          answeredItems: 1,
          correctItems: 1,
          explanationCodes: [],
        },
        profile: buildAdaptiveLearningProfile(),
      },
    });
    const overviewResponse = await request(owner, '/api/v1/adaptive-learning/overview');
    const overview = await overviewResponse.json();
    assert.equal(overviewResponse.status, 200, JSON.stringify(overview));
    assert.equal(overview.profile.evidenceCount, 0);
    assert.equal(overview.profile.needsDiagnostic, true);
  });
});

test('answering is owner-bound, idempotent and cannot accept client mastery or a retry', async () => {
  await withDiagnosticApp(async ({ owner, stranger, request }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-owner-0002' }, body: '{}',
    });
    const first = await started.json();

    const tampered = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-owner-0001' },
      body: JSON.stringify({
        itemId: first.item.id, choiceId: first.item.choices[0].id, score: 100, hinted: false,
      }),
    });
    assert.equal(tampered.status, 400);

    const strangerAttempt = await request(stranger, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-stranger-001' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[0].id }),
    });
    assert.equal(strangerAttempt.status, 404);

    const accepted = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-owner-0001' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[0].id }),
    });
    assert.equal(accepted.status, 201);
    const next = await accepted.json();
    assert.equal(next.accepted, true);
    assert.equal(next.diagnostic.answeredItems, 1);
    assert.notEqual(next.item.id, first.item.id);
    assert.equal('correct' in next, false);
    assert.equal('correctChoiceId' in next.item, false);

    const replay = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-owner-0001' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[0].id }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).diagnostic.answeredItems, 1);

    const acceptedSecond = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-owner-0003' },
      body: JSON.stringify({ itemId: next.item.id, choiceId: next.item.choices[0].id }),
    });
    assert.equal(acceptedSecond.status, 201);
    assert.equal((await acceptedSecond.json()).diagnostic.answeredItems, 2);

    const lateReplay = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-owner-0001' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[0].id }),
    });
    assert.equal(lateReplay.status, 200);
    assert.deepEqual(await lateReplay.json(), next);

    const retry = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-owner-0002' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[1].id }),
    });
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).error.code, 'DIAGNOSTIC_ITEM_ALREADY_ANSWERED');
  });
});

test('bounded adaptive run stops, completes idempotently and yields an explicitly preliminary profile', async () => {
  await withDiagnosticApp(async ({ repository, owner, request }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-owner-0003' }, body: '{}',
    });
    let state = await started.json();
    const observedAtResume = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-owner-resume-0001' }, body: '{}',
    });
    const observedSnapshot = await observedAtResume.json();
    assert.equal(observedSnapshot.diagnostic.id, state.diagnostic.id);
    assert.equal(observedSnapshot.diagnostic.answeredItems, 0);
    assert.equal(observedSnapshot.item.id, state.item.id);
    const seen = new Set();
    while (state.diagnostic.status === 'in_progress') {
      assert.ok(state.item, 'an in-progress session has a current item');
      assert.equal(seen.has(state.item.id), false, 'accepted items are never retried');
      seen.add(state.item.id);
      const response = await request(owner, `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/answers`, {
        method: 'POST',
        headers: { 'Idempotency-Key': `diagnostic-answer-loop-${String(seen.size).padStart(4, '0')}` },
        body: JSON.stringify({ itemId: state.item.id, choiceId: state.item.choices[0].id }),
      });
      assert.equal(response.status, 201);
      state = await response.json();
      assert.ok(state.diagnostic.answeredItems <= 12);
    }

    assert.equal(state.diagnostic.status, 'ready');
    assert.equal(state.diagnostic.answeredItems, 10);
    assert.equal(state.diagnostic.stopReason, 'target_coverage');
    assert.equal(state.item, null);
    assert.equal(state.diagnostic.canComplete, true);
    const beforeCompletion = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(beforeCompletion.profile.needsDiagnostic, true);

    const completed = await request(owner, `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/complete`, {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-complete-owner-01' }, body: '{}',
    });
    assert.equal(completed.status, 201);
    const originalCompletionBody = await completed.text();
    const result = JSON.parse(originalCompletionBody);
    assert.equal(result.completed, true);
    assert.equal(result.diagnostic.status, 'completed');
    assert.equal(result.result.preliminary, true);
    assert.equal(result.result.answeredItems, 10);
    assert.ok(result.result.confidence > 0);
    assert.equal(result.profile.needsDiagnostic, false);
    assert.equal(result.profile.preliminary, true);
    assert.ok(result.profile.independentEvidenceCount >= 8);
    assert.ok(result.profile.assistedEvidenceCount >= 1);

    await repository.recordModuleAttempt(owner, {
      id: crypto.randomUUID(),
      module: 'vocabulary',
      activity: 'lexical_choice',
      score: 0,
      maxScore: 10,
      durationMs: 60_000,
      metadata: { source: 'builtin' },
    }, { evidenceQuality: 'server_verified_unassisted' });

    const replay = await request(owner, `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/complete`, {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-complete-owner-01' }, body: '{}',
    });
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), originalCompletionBody);

    const differentKeyReplay = await request(
      owner,
      `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/complete`,
      {
        method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-complete-owner-02' }, body: '{}',
      },
    );
    assert.equal(differentKeyReplay.status, 200);
    assert.equal(await differentKeyReplay.text(), originalCompletionBody);

    assert.deepEqual(await (await request(owner, '/api/v1/adaptive-learning/diagnostics/current')).json(), {
      diagnostic: null, item: null,
    });
    const resumedReplay = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-owner-resume-0001' }, body: '{}',
    });
    assert.equal(resumedReplay.status, 200);
    const replayedSnapshot = await resumedReplay.json();
    assert.equal(replayedSnapshot.required, true);
    assert.equal(replayedSnapshot.diagnostic.id, observedSnapshot.diagnostic.id);
    assert.equal(replayedSnapshot.diagnostic.status, 'in_progress');
    assert.equal(replayedSnapshot.diagnostic.answeredItems, 0);
    assert.equal(replayedSnapshot.item.id, observedSnapshot.item.id);

    const notRequired = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-owner-0004' }, body: '{}',
    });
    assert.equal(notRequired.status, 200);
    assert.equal((await notRequired.json()).required, false);
  });
});

test('hard time limit expires the run and a fresh diagnostic can start without accepting a late answer', async () => {
  await withDiagnosticApp(async ({ owner, request, setTime }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-expiry-001' }, body: '{}',
    });
    const first = await started.json();
    setTime('2026-08-04T09:21:00.000Z');

    const expiredReplay = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-expiry-001' }, body: '{}',
    });
    assert.equal(expiredReplay.status, 200);
    assert.equal((await expiredReplay.json()).diagnostic.status, 'in_progress');

    const late = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-expired-01' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[0].id }),
    });
    assert.equal(late.status, 409);
    assert.equal((await late.json()).error.code, 'DIAGNOSTIC_TIME_EXPIRED');

    const expired = await (await request(owner, '/api/v1/adaptive-learning/diagnostics/current')).json();
    assert.equal(expired.diagnostic.status, 'expired');
    assert.equal(expired.diagnostic.canComplete, false);
    assert.equal(expired.item, null);

    const restarted = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-expiry-002' }, body: '{}',
    });
    assert.equal(restarted.status, 201);
    assert.notEqual((await restarted.json()).diagnostic.id, first.diagnostic.id);
  });
});

test('ready diagnostic expires at the same 20-minute deadline and cannot complete into evidence', async () => {
  await withDiagnosticApp(async ({ repository, owner, request, setTime }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-ready-expiry-start-01' }, body: '{}',
    });
    const first = await started.json();
    await repository.answerAdaptiveDiagnostic(owner, {
      id: crypto.randomUUID(),
      diagnosticId: first.diagnostic.id,
      itemId: first.item.id,
      skillId: 'ege.grammar.forms',
      module: 'grammar',
      evidenceQuality: 'independent',
      choiceId: 'a',
      correct: true,
      responseMs: 60_000,
      idempotencyKey: 'diagnostic-ready-expiry-answer-01',
      requestHash: 'a'.repeat(64),
      nextItemId: null,
      status: 'ready',
      stopReason: 'target_coverage',
      now: new Date('2026-08-04T09:01:00.000Z'),
    });

    setTime('2026-08-04T09:20:00.000Z');
    const current = await request(owner, '/api/v1/adaptive-learning/diagnostics/current');
    assert.equal(current.status, 200);
    const expired = await current.json();
    assert.equal(expired.diagnostic.status, 'expired');
    assert.equal(expired.diagnostic.canComplete, false);

    const lateCompletion = await request(
      owner,
      `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/complete`,
      {
        method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-ready-expiry-complete-01' }, body: '{}',
      },
    );
    assert.equal(lateCompletion.status, 409);
    assert.equal((await lateCompletion.json()).error.code, 'DIAGNOSTIC_TIME_EXPIRED');

    const lateAnswer = await request(
      owner,
      `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`,
      {
        method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-ready-expiry-late-answer-01' },
        body: JSON.stringify({ itemId: first.item.id, choiceId: 'a' }),
      },
    );
    assert.equal(lateAnswer.status, 409);
    assert.equal((await lateAnswer.json()).error.code, 'DIAGNOSTIC_TIME_EXPIRED');

    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(overview.profile.evidenceCount, 0);
    assert.equal(overview.profile.needsDiagnostic, true);
  });
});

test('responses from an abandoned diagnostic do not become learning evidence', async () => {
  await withDiagnosticApp(async ({ owner, request, setTime }) => {
    const started = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-abandoned-01' }, body: '{}',
    });
    const first = await started.json();
    const answered = await request(owner, `/api/v1/adaptive-learning/diagnostics/${first.diagnostic.id}/answers`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'diagnostic-answer-abandoned-01' },
      body: JSON.stringify({ itemId: first.item.id, choiceId: first.item.choices[0].id }),
    });
    assert.equal(answered.status, 201);

    setTime('2026-08-04T09:21:00.000Z');
    const immutableReplay = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-start-abandoned-01' }, body: '{}',
    });
    assert.equal((await immutableReplay.json()).diagnostic.status, 'in_progress');
    const expired = await request(owner, '/api/v1/adaptive-learning/diagnostics/current');
    assert.equal((await expired.json()).diagnostic.status, 'expired');

    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(overview.profile.independentEvidenceCount, 0);
    assert.equal(overview.profile.needsDiagnostic, true);
  });
});

test('learner with adequate independent evidence is not forced through the short diagnostic', async () => {
  await withDiagnosticApp(async ({ repository, owner, request }) => {
    for (const skill of EGE_SKILL_TAXONOMY.skills) {
      for (let sample = 0; sample < 4; sample += 1) {
        await repository.recordModuleAttempt(owner, {
          id: crypto.randomUUID(),
          module: skill.module,
          activity: skill.id,
          score: 8,
          maxScore: 10,
          durationMs: 60_000,
          metadata: { source: 'builtin' },
        }, { evidenceQuality: 'server_verified_unassisted' });
      }
    }
    const response = await request(owner, '/api/v1/adaptive-learning/diagnostics/start', {
      method: 'POST', headers: { 'Idempotency-Key': 'diagnostic-not-required-01' }, body: '{}',
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.required, false);
    assert.equal(result.diagnostic, null);
    assert.equal(result.profile.needsDiagnostic, false);
    assert.equal(result.profile.preliminary, false);
  });
});

test('browser renders progress and timing from the stored diagnostic policy projection', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  const elements = renderDiagnosticDom(screen, {
    diagnostic: {
      id: '51000000-0000-4000-8000-000000000099',
      catalogVersion: 'diagnostic-synthetic-v2',
      status: 'in_progress',
      estimatedMinutes: 40,
      deadlineMinutes: 40,
      answeredItems: 4,
      maxItems: 9,
      canComplete: false,
      expiresAt: '2026-08-04T09:40:00.000Z',
    },
    item: null,
  });

  assert.equal(elements.adaptive_diagnostic_progress.max, 9);
  assert.equal(elements.adaptive_diagnostic_progress.value, 4);
  assert.equal(elements.adaptive_diagnostic_progress_label.textContent, '4 из 9');
  assert.match(elements.adaptive_diagnostic_timing.textContent, /40 минут/u);
  assert.match(elements.adaptive_diagnostic_timing.textContent, /40 минут после старта/u);
  assert.match(elements.adaptive_diagnostic_start.textContent, /около 40 минут/u);
});

test('plan card exposes an accessible start, progress, audio and resumable diagnostic workflow', async () => {
  const [markup, screen, appSource] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(markup, /id="adaptive_diagnostic_start"[^>]*aria-controls="adaptive_diagnostic"/u);
  assert.match(markup, /id="adaptive_diagnostic"[^>]*aria-labelledby="adaptive_diagnostic_title"/u);
  assert.match(markup, /<progress[^>]*id="adaptive_diagnostic_progress"[^>]*max="1"/u);
  assert.match(markup, /id="adaptive_diagnostic_timing"/u);
  assert.match(markup, /<fieldset[^>]*id="adaptive_diagnostic_question"/u);
  assert.match(markup, /id="adaptive_diagnostic_audio"[^>]*type="button"/u);
  assert.match(markup, /id="adaptive_diagnostic_notice"[^>]*role="status"/u);
  assert.doesNotMatch(markup, /можно продолжить позже/u);
  assert.match(markup, /Точное время и предел заданий появятся после старта/u);
  assert.doesNotMatch(markup, /(?:около 15|После 20|0 из 12)/u);
  assert.match(screen, /apiGet\('\/api\/v1\/adaptive-learning\/diagnostics\/current'\)/u);
  assert.match(screen, /apiPostIdempotent\('\/api\/v1\/adaptive-learning\/diagnostics\/start'/u);
  assert.match(screen, /\/answers'/u);
  assert.match(screen, /\/complete'/u);
  assert.match(screen, /speechSynthesis/u);
  assert.match(screen, /progress\.max=maxItems/u);
  assert.match(screen, /diagnostic\.estimatedMinutes/u);
  assert.match(screen, /diagnostic\.deadlineMinutes/u);
  assert.match(screen, /measurementNotice/u);
  assert.match(screen, /textContent/u);
  assert.doesNotMatch(screen, /innerHTML/u);
  assert.match(appSource, /apiPostIdempotent/u);
});

test('public contract documents bounded diagnostic data, retention and server-owned answer mapping', async () => {
  const [openapi, schema, retention] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATABASE_SCHEMA.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
  ]);
  assert.match(openapi, /\/adaptive-learning\/diagnostics\/start:/u);
  assert.match(openapi, /\/adaptive-learning\/diagnostics\/current:/u);
  assert.match(openapi, /\/adaptive-learning\/diagnostics\/\{diagnosticId\}\/answers:/u);
  assert.match(openapi, /\/adaptive-learning\/diagnostics\/\{diagnosticId\}\/complete:/u);
  assert.match(openapi, /ege-short-diagnostic-v1/u);
  assert.match(openapi, /never exposes the answer key or skill mapping/iu);
  assert.match(openapi, /measurementNotice/u);
  assert.match(openapi, /replayable local browser speech.*assisted/iu);
  assert.match(openapi, /DIAGNOSTIC_START_RATE_LIMIT/u);
  assert.match(openapi, /24-hour start-claim retention/iu);
  assert.match(openapi, /ready.*20-minute deadline/iu);
  assert.match(openapi, /stored catalog version's policy/iu);
  assert.match(openapi, /exact originally observed answer snapshot/iu);
  assert.match(openapi, /deadlineMinutes/u);
  assert.match(openapi, /immutable completion response snapshot/iu);
  assert.match(openapi, /different completion key.*canonical snapshot/iu);
  assert.match(schema, /adaptive_diagnostic_sessions/u);
  assert.match(schema, /adaptive_diagnostic_start_claims/u);
  assert.match(schema, /claim_expires_at/u);
  assert.match(schema, /adaptive_diagnostic_responses/u);
  assert.match(schema, /replay_status/u);
  assert.match(schema, /completion_response_snapshot/u);
  assert.match(schema, /evidence_quality/u);
  assert.match(schema, /immutable start claim/iu);
  assert.match(schema, /server-owned catalog/iu);
  assert.match(retention, /start claims/iu);
  assert.match(retention, /24 (?:hours|час)/iu);
  assert.match(retention, /answer replay snapshot/iu);
  assert.match(retention, /completion replay snapshot/iu);
  assert.match(retention, /Короткая адаптивная диагностика/u);
  assert.match(retention, /не сохраняются/u);
});
