import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';
import { ADAPTIVE_ACTIVITY_REGISTRY } from '../adaptive-learning/session.js';
import { ADAPTIVE_EXECUTION_CLAIM_TTL_MS } from '../adaptive-learning/session-execution.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { publicSpeakingReview, scoreSpeakingTask } from '../speaking/fipi-scoring.js';
import { completeShortAdaptiveDiagnostic } from './support/adaptive-diagnostic-public.js';
import { readingAdaptiveAttemptMetadata } from './support/reading-adaptive-attempt.js';

const START = new Date(Date.now() - 2 * 60 * 60_000);
const MODULE_ACTIVITY_REGISTRY = {
  ...ADAPTIVE_ACTIVITY_REGISTRY,
  activities: ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
    !['writing', 'speaking'].includes(activity.module)
  )),
};
const OWNER_BOUND_ACTIVITY_REGISTRY = {
  ...ADAPTIVE_ACTIVITY_REGISTRY,
  activities: ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
    activity.module !== 'speaking' || activity.activityId === 'speaking_2'
  )),
};

function adaptiveTask2Review() {
  const semanticFacts = {
    confidence: 0.95, verdict: 'Assessable.', evidence: ['Four direct questions.'], issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, relevant: index !== 1, directQuestion: true,
      lexicalGrammarBlocksCommunication: false, evidence: `Question ${index + 1}`,
    })),
  };
  const acousticFacts = {
    available: true, recognitionConfidence: 0.94, signalQuality: 'good', recordingDurationSeconds: 48,
    itemDurations: Array.from({ length: 4 }, (_, index) => ({ itemIndex: index + 1, durationSeconds: 12 })),
    wordEvents: [],
  };
  return {
    ...publicSpeakingReview(scoreSpeakingTask({ taskType: 2, semantic: semanticFacts, acoustic: acousticFacts }), semanticFacts),
    semanticFacts, acousticFacts,
  };
}

function authentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    req.user = username;
    next();
  } };
}

async function withExecutionApp(run, {
  activityRegistry = MODULE_ACTIVITY_REGISTRY,
  grantPremium = true,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-execution-api-'));
  const dataPath = path.join(directory, 'data.json');
  let current = new Date(START);
  const repository = createFileRepository(dataPath, {
    adaptiveMutationNow: () => new Date(current),
  });
  const owner = await repository.createTelegramUser(9501, 'Execution Owner');
  const stranger = await repository.createTelegramUser(9502, 'Execution Stranger');
  for (const [telegramId, username] of [[9501, owner], [9502, stranger]]) {
    await repository.grantDays(telegramId, 30, username);
    if (grantPremium) {
      await repository.setEntitlement(username, 'voice_tutor', {
        startsAt: new Date(START.getTime() - 60_000),
        endsAt: new Date(START.getTime() + 24 * 60 * 60_000),
      });
    }
  }
  const mutationHooks = new Map();
  const routeRepository = new Proxy(repository, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!['getAdaptiveLearningSessionMutationReplay', 'startAdaptiveLearningSessionBlock',
        'bindAdaptiveLearningServerAttempt', 'recordModuleAttemptWithAdaptiveClaim',
        'advanceAdaptiveLearningSession'].includes(property)) {
        return value.bind(target);
      }
      return async (...args) => {
        const hook = mutationHooks.get(property);
        if (hook) {
          mutationHooks.delete(property);
          await hook(...args);
        }
        return value.apply(target, args);
      };
    },
  });
  const now = () => new Date(current);
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({ authentication: authentication(), db: routeRepository, now }));
  app.use(createAdaptiveLearningRoutes({
    authentication: authentication(), db: routeRepository, enabled: true, now,
    executionTokenSecret: 'adaptive-test-token-secret-32-characters',
    activityRegistry,
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.message } }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { ...options, headers: {
      'Content-Type': 'application/json',
      ...(username ? { 'X-Test-User': username } : {}),
      ...(options.headers || {}),
    } },
  );
  await completeShortAdaptiveDiagnostic(request, owner, 'execution-owner');
  await completeShortAdaptiveDiagnostic(request, stranger, 'execution-stranger');
  try {
    await run({
      owner, stranger, repository, request, dataPath,
      setTime(value) { current = new Date(value); },
      setMutationHook(operation, hook) { mutationHooks.set(operation, hook); },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function createSession(request, owner, durationMinutes = 15) {
  const goal = await request(owner, '/api/v1/adaptive-learning/goal', {
    method: 'PUT', headers: { 'Idempotency-Key': `execution-goal-${durationMinutes}-0001` },
    body: JSON.stringify({
      targetExam: 'ege_english', targetScore: 85,
      examDate: '2027-06-01', weeklyMinutes: 300,
    }),
  });
  assert.equal(goal.status, 201);
  const previewResponse = await request(owner, '/api/v1/adaptive-learning/sessions/preview', {
    method: 'POST', body: JSON.stringify({ durationMinutes }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = (await previewResponse.json()).preview;
  const response = await request(owner, '/api/v1/adaptive-learning/sessions', {
    method: 'POST', headers: { 'Idempotency-Key': `execution-create-${durationMinutes}-0001` },
    body: JSON.stringify({ durationMinutes, previewFingerprint: preview.previewFingerprint }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).session;
}

test('delayed start mints a fresh fixed-TTL claim only after the owner queue', async () => {
  await withExecutionApp(async ({
    owner, request, dataPath, setTime, setMutationHook,
  }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const effectiveNow = new Date(START.getTime() + ADAPTIVE_EXECUTION_CLAIM_TTL_MS + 60_000);
    setMutationHook('startAdaptiveLearningSessionBlock', async () => setTime(effectiveNow));
    const response = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-start-delayed-0001' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    });
    assert.equal(response.status, 201);
    const started = await response.json();
    assert.equal(started.claimExpiresAt,
      new Date(effectiveNow.getTime() + ADAPTIVE_EXECUTION_CLAIM_TTL_MS).toISOString());
    assert.ok(new Date(started.claimExpiresAt) > effectiveNow);
    const stored = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    const claim = stored.adaptive_learning_execution_claims.find((item) => item.session_id === session.id);
    assert.equal(new Date(claim.issued_at).toISOString(), effectiveNow.toISOString());
    assert.equal(new Date(claim.expires_at).getTime() - new Date(claim.issued_at).getTime(),
      ADAPTIVE_EXECUTION_CLAIM_TTL_MS);
  });
});

test('exact start replay never returns an expired stored claim', async () => {
  await withExecutionApp(async ({ owner, request, setTime }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const options = {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-start-expired-replay-1' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    };
    const started = await (await request(
      owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, options,
    )).json();
    setTime(new Date(new Date(started.claimExpiresAt).getTime() + 1));
    const replay = await request(
      owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, options,
    );
    assert.equal(replay.status, 410);
    assert.equal((await replay.json()).error.code, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
  });
});

test('module binding rejects a claim that expires while waiting for the owner queue', async () => {
  await withExecutionApp(async ({ owner, request, setTime, setMutationHook }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const started = await (await request(
      owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-start-module-expiry-01' },
        body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
      },
    )).json();
    const expiresAt = new Date(started.claimExpiresAt);
    setTime(new Date(expiresAt.getTime() - 1));
    setMutationHook('recordModuleAttemptWithAdaptiveClaim', async () => {
      setTime(new Date(expiresAt.getTime() + 1));
    });
    const response = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: crypto.randomUUID(), module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
      }),
    });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error.code, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
  });
});

test('server-attempt binding rejects a claim that expires while waiting for the owner queue', async () => {
  await withExecutionApp(async ({ owner, request, setTime, setMutationHook }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const started = await (await request(
      owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-start-bind-expiry-001' },
        body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
      },
    )).json();
    const expiresAt = new Date(started.claimExpiresAt);
    setTime(new Date(expiresAt.getTime() - 1));
    setMutationHook('bindAdaptiveLearningServerAttempt', async () => {
      setTime(new Date(expiresAt.getTime() + 1));
    });
    const response = await request(
      owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
        method: 'POST', body: JSON.stringify({
          executionClaim: started.executionClaim,
          attempt: { type: 'writing', id: 999_999 },
        }),
      },
    );
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error.code, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
  });
});

test('advance rejects a bound claim that expires while waiting for the owner queue', async () => {
  await withExecutionApp(async ({ owner, repository, request, setTime, setMutationHook }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const started = await (await request(
      owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-start-advance-expiry-1' },
        body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
      },
    )).json();
    const expiresAt = new Date(started.claimExpiresAt);
    setTime(new Date(expiresAt.getTime() - 2));
    const attemptId = crypto.randomUUID();
    const recorded = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: attemptId, module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
      }),
    });
    assert.equal(recorded.status, 201);
    setTime(new Date(expiresAt.getTime() - 1));
    setMutationHook('advanceAdaptiveLearningSession', async () => {
      setTime(new Date(expiresAt.getTime() + 1));
    });
    const response = await request(owner,
      `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-advance-expiry-001' },
        body: JSON.stringify({
          blockId: block.id, expectedRevision: 1, attempt: { type: 'module', id: attemptId },
        }),
      });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error.code, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
    const execution = await repository.getAdaptiveLearningSessionExecution(owner, session.id);
    assert.equal(execution.execution.revision, 1);
    assert.deepEqual(execution.execution.completedBlockIds, []);
  });
});

test('one-block execution starts with an opaque claim, binds a stored attempt, advances, then finishes explicitly', async () => {
  await withExecutionApp(async ({ owner, stranger, repository, request, setTime, dataPath }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    assert.equal(block.kind, 'learning');

    assert.equal((await request('', `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-start-auth-0001' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    })).status, 401);

    const startBody = { blockId: block.id, expectedRevision: 0 };
    const startedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-start-owner-0001' },
      body: JSON.stringify(startBody),
    });
    assert.equal(startedResponse.status, 201);
    const started = await startedResponse.json();
    assert.equal(started.execution.status, 'in_progress');
    assert.equal(started.execution.revision, 1);
    assert.equal(started.block.id, block.id);
    assert.deepEqual(started.launch, block.launch);
    assert.match(started.executionClaim, /^[A-Za-z0-9_-]{32,200}$/u);
    assert.ok(new Date(started.claimExpiresAt) > START);
    const rawStorage = await fs.readFile(dataPath, 'utf8');
    assert.equal(rawStorage.includes(started.executionClaim), false,
      'the bearer claim must be reconstructed for replay, never persisted in plaintext');

    const exactStartReplay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-start-owner-0001' },
      body: JSON.stringify(startBody),
    });
    assert.equal(exactStartReplay.status, 200);
    assert.deepEqual(await exactStartReplay.json(), started);
    assert.equal((await request(stranger, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-start-stranger-01' },
      body: JSON.stringify(startBody),
    })).status, 404);

    setTime(new Date(START.getTime() + 5 * 60_000));
    const attempt = {
      id: crypto.randomUUID(), module: block.module, activity: block.activityId,
      score: 4, maxScore: 5, durationMs: 300_000,
      metadata: block.module === 'reading' ? readingAdaptiveAttemptMetadata(block) : {
        evidenceQuality: 'server_verified_unassisted', contentRef: 'forged',
      },
      adaptiveExecutionClaim: started.executionClaim,
    };
    const attemptResponse = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify(attempt),
    });
    assert.equal(attemptResponse.status, 201);
    const recorded = await attemptResponse.json();
    assert.equal(recorded.evidenceQuality, 'client_reported');
    assert.deepEqual(recorded.adaptiveExecution, {
      sessionId: session.id, blockId: block.id, attemptType: 'module', attemptId: attempt.id,
    });
    const storedAttempt = await repository.getModuleAttempt(owner, attempt.id);
    assert.equal(storedAttempt.evidence_quality, 'client_reported');
    assert.equal(storedAttempt.metadata.evidenceQuality, undefined);
    assert.equal(storedAttempt.metadata.contentRef, undefined);
    if (block.module === 'reading') assert.equal(storedAttempt.metadata.readingContentRef, block.contentRef);

    const advanceBody = {
      blockId: block.id, expectedRevision: 1,
      attempt: { type: 'module', id: attempt.id },
    };
    const advancedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-advance-owner-01' },
      body: JSON.stringify(advanceBody),
    });
    assert.equal(advancedResponse.status, 200);
    const advanced = await advancedResponse.json();
    assert.equal(advanced.session.status, 'in_progress');
    assert.equal(advanced.execution.revision, 2);
    assert.equal(advanced.execution.readyToFinish, true);
    assert.equal(advanced.completedBlock.evidenceQuality, 'client_reported');
    assert.equal(advanced.planChange.reasonCode, 'learning_block_completed');
    assert.ok(advanced.profileAfter.evidenceSourceCount > advanced.profileBefore.evidenceSourceCount);
    assert.equal('score' in advanced.completedBlock, false);
    assert.equal('metadata' in advanced.completedBlock, false);

    const exactAdvanceReplay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-advance-owner-01' },
      body: JSON.stringify(advanceBody),
    });
    assert.equal(exactAdvanceReplay.status, 200);
    assert.deepEqual(await exactAdvanceReplay.json(), advanced);
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-advance-owner-02' },
      body: JSON.stringify(advanceBody),
    })).status, 409);

    const finishBody = { expectedRevision: 2 };
    const finishResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/finish`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-finish-owner-001' },
      body: JSON.stringify(finishBody),
    });
    assert.equal(finishResponse.status, 200);
    const finished = await finishResponse.json();
    assert.equal(finished.session.status, 'completed');
    assert.equal(finished.summary.completedBlocks, 1);
    assert.equal(finished.summary.plannedLearningMinutes, 15);
    assert.equal(finished.summary.actualLearningMinutes, 5);
    assert.deepEqual(finished.summary.evidenceByQuality, { client_reported: 1 });
    assert.ok(finished.summary.nextRecommendedAction);

    const finishReplay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/finish`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-finish-owner-001' },
      body: JSON.stringify(finishBody),
    });
    assert.deepEqual(await finishReplay.json(), finished);
    const exported = await repository.exportUserData(owner);
    assert.equal(exported.adaptive_learning_session_events.length, 2);
    assert.equal(JSON.stringify(exported).includes(started.executionClaim), false);
    assert.equal(JSON.stringify(exported).includes('request_hash'), false);
  }, { grantPremium: false });
});

test('server-owned writing or speaking completion binds to the claim without a client score', async () => {
  await withExecutionApp(async ({ owner, repository, request, setTime }) => {
    await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now: START });
    const establishedNonSpeaking = [
      ['vocabulary', 'vocabulary_lexical_choice_topic_1'],
      ['grammar', 'grammar_forms_topic_3'], ['grammar', 'grammar_transformations_topic_18'],
      ['reading', 'reading_headings'], ['reading', 'reading_detail'],
      ['listening', 'listening_matching'], ['listening', 'listening_interview'],
      ['writing', 'writing_37'], ['writing', 'writing_38'],
    ];
    for (const [module, activity] of establishedNonSpeaking) {
      for (let index = 0; index < 3; index += 1) {
        await repository.recordModuleAttempt(owner, {
          id: crypto.randomUUID(), module, activity, score: 5, maxScore: 5,
          durationMs: 60_000, metadata: {},
        }, { evidenceQuality: 'server_verified_unassisted' });
      }
    }
    const accessOverview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(accessOverview.access.tier, 'premium');
    const session = await createSession(request, owner, 120);
    assert.ok(session.blocks.some((block) => ['writing', 'speaking'].includes(block.module)),
      'seeded non-speaking mastery must make a server-owned block deterministic');
    let executionRevision = 0;
    let serverOwnedSeen = false;
    let minute = 1;
    for (const block of session.blocks) {
      const blockNow = new Date(START.getTime() + minute * 60_000);
      setTime(blockNow);
      minute += 1;
      if (block.kind === 'break') {
        const advanced = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
          method: 'POST', headers: { 'Idempotency-Key': `execution-break-${block.position}-0001` },
          body: JSON.stringify({ blockId: block.id, expectedRevision: executionRevision, attempt: null }),
        });
        assert.equal(advanced.status, 200);
        executionRevision = (await advanced.json()).execution.revision;
        continue;
      }
      const start = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': `execution-long-start-${block.position}-001` },
        body: JSON.stringify({ blockId: block.id, expectedRevision: executionRevision }),
      });
      assert.equal(start.status, 201);
      const started = await start.json();
      executionRevision = started.execution.revision;
      const evidenceNow = new Date(START.getTime() + minute * 60_000);
      setTime(evidenceNow);
      minute += 1;
      let attempt;
      if (['writing', 'speaking'].includes(block.module)) {
        const bypass = await request(owner, '/api/v1/module-attempts', {
          method: 'POST', body: JSON.stringify({
            id: crypto.randomUUID(), module: block.module, activity: block.activityId,
            score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
          }),
        });
        assert.equal(bypass.status, 400, 'writing and speaking cannot bypass server-owned evaluation');
        assert.equal((await bypass.json()).error.code, 'SERVER_ASSESSMENT_REQUIRED');
      }
      if (block.module === 'writing') {
        const wrongId = await repository.createWritingAttempt(owner, {
          taskType: block.activityId, sourceTaskRef: 'builtin:writing_37:wrong-task', assignment: {},
          answer: 'A sufficiently long answer to the wrong writing assignment.',
        }, 'test-writing-v1');
        await repository.finishWritingAttempt(wrongId, { status: 'completed', review: { overall_got: 1, overall_max: 6 } });
        const wrongBind = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
          method: 'POST', body: JSON.stringify({
            executionClaim: started.executionClaim, attempt: { type: 'writing', id: wrongId },
          }),
        });
        assert.equal(wrongBind.status, 409, 'a completed answer to another writing task is not evidence for this block');
        const id = await repository.createWritingAttempt(owner, {
          taskType: block.activityId, sourceTaskRef: block.launch.taskId, assignment: {},
          answer: 'A sufficiently long student answer for the persisted attempt.',
        }, 'test-writing-v1');
        await repository.finishWritingAttempt(id, { status: 'completed', review: { overall_got: 1, overall_max: 6 } });
        attempt = { type: 'writing', id };
        serverOwnedSeen = true;
      } else if (block.module === 'speaking') {
        const taskNumber = Number(block.activityId.split('_')[1]);
        const wrongId = await repository.createSpeakingAttempt(owner, {
          taskType: taskNumber, assignment: { points: ['A different speaking card.'] },
          transcript: 'Student transcript for another card.',
        }, 'test-speaking-v1');
        await repository.finishSpeakingAttempt(wrongId, {
          status: 'completed', review: { status: 'scored', got: 1, max: 4 },
        });
        const wrongBind = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
          method: 'POST', body: JSON.stringify({
            executionClaim: started.executionClaim, attempt: { type: 'speaking', id: wrongId },
          }),
        });
        assert.equal(wrongBind.status, 409, 'a completed answer to another speaking card is not evidence for this block');
        const sourceSession = await repository.assignSpeakingTask2Session(owner, {
          catalogId: SPEAKING_TASK2_CATALOG.id,
          catalogRevision: SPEAKING_TASK2_CATALOG.revision,
          tasks: SPEAKING_TASK2_CATALOG.tasks,
          now: evidenceNow,
        });
        for (let question = 1; question <= 4; question += 1) {
          await repository.completeSpeakingTask2Question(owner, sourceSession.id, question, {
            recordingDurationSeconds: 12, localPlayback: true, selfRating: 'steady',
          }, { now: evidenceNow });
        }
        const claimed = await repository.claimSpeakingEvaluation(owner, {
          taskType: taskNumber, assignment: {}, transcript: 'Student transcript.',
        }, 'test-speaking-v1', crypto.randomBytes(32).toString('hex'), { now: evidenceNow, source: {
          sessionId: sourceSession.id,
          taskRef: sourceSession.task_id,
          taskRevision: sourceSession.task_revision,
          catalogId: sourceSession.catalog_id,
          catalogRevision: sourceSession.catalog_revision,
          assistanceUsed: false,
        } });
        await repository.finishSpeakingAttempt(claimed.attempt.id, {
          status: 'completed', review: adaptiveTask2Review(),
        });
        attempt = { type: 'speaking', id: claimed.attempt.id };
        serverOwnedSeen = true;
      } else {
        const id = crypto.randomUUID();
        const recorded = await request(owner, '/api/v1/module-attempts', {
          method: 'POST', body: JSON.stringify({
            id, module: block.module, activity: block.activityId,
            score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
            ...(block.module === 'reading' ? { metadata: readingAdaptiveAttemptMetadata(block) } : {}),
          }),
        });
        assert.equal(recorded.status, 201);
        attempt = { type: 'module', id };
      }
      if (attempt.type !== 'module') {
        const bound = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
          method: 'POST', body: JSON.stringify({
            executionClaim: started.executionClaim, attempt,
          }),
        });
        const binding = await bound.json();
        assert.equal(bound.status, 201, `${block.module}:${block.activityId}:${JSON.stringify(binding)}`);
        assert.equal(binding.evidenceQuality, attempt.type === 'speaking'
          ? 'server_verified_unassisted' : 'server_verified_assisted');
        assert.equal('score' in binding, false);
        const replay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
          method: 'POST', body: JSON.stringify({ executionClaim: started.executionClaim, attempt }),
        });
        assert.equal(replay.status, 200);
      }
      const advanced = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
        method: 'POST', headers: { 'Idempotency-Key': `execution-long-advance-${block.position}-01` },
        body: JSON.stringify({ blockId: block.id, expectedRevision: executionRevision, attempt }),
      });
      assert.equal(advanced.status, 200);
      const result = await advanced.json();
      executionRevision = result.execution.revision;
      if (attempt.type !== 'module') {
        assert.equal(result.completedBlock.evidenceQuality, attempt.type === 'speaking'
          ? 'server_verified_unassisted' : 'server_verified_assisted');
        assert.ok(
          result.profileChange.evidenceSourceCountAfter > result.profileChange.evidenceSourceCountBefore,
          'completed server-owned evaluations update the general evidence profile, while only the exact one binds this block',
        );
      }
    }
    assert.equal(serverOwnedSeen, true, 'the full registry must exercise a writing or speaking handoff');
  }, { activityRegistry: OWNER_BOUND_ACTIVITY_REGISTRY });
});

test('deep execution atomically rechecks Premium after route precheck for start, bind, and advance', async () => {
  const writingRegistry = {
    ...ADAPTIVE_ACTIVITY_REGISTRY,
    activities: ADAPTIVE_ACTIVITY_REGISTRY.activities.filter((activity) => (
      activity.module === 'writing' && activity.launch.kind === 'writing_task'
    )),
  };
  await withExecutionApp(async ({ owner, repository, request, setTime, setMutationHook }) => {
    const session = await createSession(request, owner, 30);
    const block = session.blocks[0];
    assert.equal(block.module, 'writing');
    assert.equal(block.launch.kind, 'writing_task');

    const startBody = { blockId: block.id, expectedRevision: 0 };
    const revokeAtMutation = async (...args) => {
      const requestInstant = new Date(args[1].now);
      const instant = new Date(requestInstant.getTime() + 1_000);
      setTime(instant);
      assert.equal(await repository.revokeEntitlement(
        owner, 'voice_tutor', 9501, { now: instant },
      ), true);
    };
    const restorePremium = async (instant) => repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date(instant.getTime() - 1_000),
      endsAt: new Date(instant.getTime() + 60 * 60_000),
    });

    setMutationHook('startAdaptiveLearningSessionBlock', revokeAtMutation);
    const deniedFreshStart = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-premium-start-0001' },
      body: JSON.stringify(startBody),
    });
    assert.equal(deniedFreshStart.status, 403);
    assert.equal((await repository.getAdaptiveLearningSessionExecution(owner, session.id)).execution.revision, 0);

    await restorePremium(START);
    const startedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-premium-start-0001' },
      body: JSON.stringify(startBody),
    });
    assert.equal(startedResponse.status, 201);
    const started = await startedResponse.json();
    const attemptId = await repository.createWritingAttempt(owner, {
      taskType: block.activityId, sourceTaskRef: block.launch.taskId, assignment: {},
      answer: 'A sufficiently long student answer for the persisted attempt.',
    }, 'test-writing-v1');
    await repository.finishWritingAttempt(attemptId, {
      status: 'completed', review: { overall_got: 1, overall_max: 6 },
    });
    const attempt = { type: 'writing', id: attemptId };

    const revokedAt = new Date(START.getTime() + 60_000);
    setTime(revokedAt);
    await restorePremium(revokedAt);
    setMutationHook('startAdaptiveLearningSessionBlock', revokeAtMutation);
    const deniedReplay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-premium-start-0001' },
      body: JSON.stringify(startBody),
    });
    assert.equal(deniedReplay.status, 403);

    await restorePremium(revokedAt);
    setMutationHook('bindAdaptiveLearningServerAttempt', revokeAtMutation);
    const deniedBind = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
      method: 'POST', body: JSON.stringify({ executionClaim: started.executionClaim, attempt }),
    });
    assert.equal(deniedBind.status, 403);

    await restorePremium(revokedAt);
    const bound = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/bind-attempt`, {
      method: 'POST', body: JSON.stringify({ executionClaim: started.executionClaim, attempt }),
    });
    assert.equal(bound.status, 201);

    const secondRevocation = new Date(revokedAt.getTime() + 60_000);
    setTime(secondRevocation);
    await restorePremium(secondRevocation);
    setMutationHook('advanceAdaptiveLearningSession', revokeAtMutation);
    const deniedAdvance = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-premium-advance-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1, attempt }),
    });
    assert.equal(deniedAdvance.status, 403);

    await restorePremium(secondRevocation);
    const advanced = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-premium-advance-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1, attempt }),
    });
    assert.equal(advanced.status, 200);

    const advanceReplayRevocation = new Date(secondRevocation.getTime() + 60_000);
    setTime(advanceReplayRevocation);
    await restorePremium(advanceReplayRevocation);
    setMutationHook('getAdaptiveLearningSessionMutationReplay', revokeAtMutation);
    const deniedAdvanceReplay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-premium-advance-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1, attempt }),
    });
    assert.equal(deniedAdvanceReplay.status, 403);
  }, { activityRegistry: writingRegistry });
});

test('start rejects a stale launch when replacement wins before the owner mutation lock', async () => {
  await withExecutionApp(async ({ owner, repository, request, setMutationHook }) => {
    const session = await createSession(request, owner, 90);
    const block = session.blocks.find((item) => item.id === session.currentBlockId);
    assert.equal(block?.kind, 'learning');
    let replacement = null;
    setMutationHook('startAdaptiveLearningSessionBlock', async () => {
      const response = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/replace`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-race-replace-owner-01' },
        body: JSON.stringify({ blockId: block.id, reason: 'excluded' }),
      });
      assert.equal(response.status, 200);
      replacement = (await response.json()).session;
    });

    const response = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-race-start-replaced-owner-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    });
    assert.equal(response.status, 409);
    assert.ok(replacement);
    assert.notDeepEqual(replacement.blocks.find((item) => item.id === block.id).launch, block.launch);
    const current = await repository.getAdaptiveLearningSessionExecution(owner, session.id);
    assert.equal(current.execution.revision, 0);
    assert.deepEqual(current.session.blocks, replacement.blocks);
  }, { grantPremium: false });
});

test('replacement fails closed as soon as a start claim exists', async () => {
  await withExecutionApp(async ({ owner, request }) => {
    const session = await createSession(request, owner, 90);
    const block = session.blocks.find((item) => item.id === session.currentBlockId);
    const started = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-lock-replacement-start-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    });
    assert.equal(started.status, 201);
    const replacement = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/replace`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-lock-replacement-new-01' },
      body: JSON.stringify({ blockId: block.id, reason: 'excluded' }),
    });
    assert.equal(replacement.status, 409);
    assert.equal((await replacement.json()).error.code, 'ADAPTIVE_SESSION_REPLACEMENT_LOCKED');
  }, { grantPremium: false });
});

test('lost replacement response cannot be replayed after execution starts', async () => {
  await withExecutionApp(async ({ owner, request }) => {
    const session = await createSession(request, owner, 90);
    const block = session.blocks.find((item) => item.id === session.currentBlockId);
    const replacementBody = JSON.stringify({ blockId: block.id, reason: 'excluded' });
    const replacementPath = `/api/v1/adaptive-learning/sessions/${session.id}/replace`;
    const replacementKey = 'execution-lock-replacement-replay-01';
    const replaced = await request(owner, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': replacementKey }, body: replacementBody,
    });
    assert.equal(replaced.status, 200);
    const current = (await replaced.json()).session;
    const currentBlock = current.blocks.find((item) => item.id === current.currentBlockId);
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-lock-replacement-replay-start-01' },
      body: JSON.stringify({ blockId: currentBlock.id, expectedRevision: 0 }),
    })).status, 201);
    const replay = await request(owner, replacementPath, {
      method: 'POST', headers: { 'Idempotency-Key': replacementKey }, body: replacementBody,
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, 'ADAPTIVE_SESSION_REPLACEMENT_LOCKED');
  }, { grantPremium: false });
});

test('claim ownership and compare-and-set prevent forged or concurrent completion', async () => {
  await withExecutionApp(async ({ owner, stranger, request, setTime }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const startBody = JSON.stringify({ blockId: block.id, expectedRevision: 0 });
    const starts = await Promise.all([
      request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-race-start-owner-01' }, body: startBody,
      }),
      request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-race-start-owner-02' }, body: startBody,
      }),
    ]);
    assert.deepEqual(starts.map((response) => response.status).sort(), [201, 409]);
    const started = await starts.find((response) => response.status === 201).json();
    const wrongOwner = await request(stranger, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: crypto.randomUUID(), module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
      }),
    });
    assert.equal(wrongOwner.status, 409);
    const mismatched = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: crypto.randomUUID(), module: block.module === 'grammar' ? 'reading' : 'grammar', activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
      }),
    });
    assert.equal(mismatched.status, 409);
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-no-attempt-owner-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1, attempt: null }),
    })).status, 409);
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/finish`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-early-finish-owner-1' },
      body: JSON.stringify({ expectedRevision: 1 }),
    })).status, 409);

    const attemptId = crypto.randomUUID();
    assert.equal((await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: attemptId, module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
        ...(block.module === 'reading' ? { metadata: readingAdaptiveAttemptMetadata(block) } : {}),
      }),
    })).status, 201);
    assert.equal((await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: crypto.randomUUID(), module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
        ...(block.module === 'reading' ? { metadata: readingAdaptiveAttemptMetadata(block) } : {}),
      }),
    })).status, 409);
    const advanceBody = JSON.stringify({
      blockId: block.id, expectedRevision: 1, attempt: { type: 'module', id: attemptId },
    });
    const advances = await Promise.all([
      request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-race-advance-own-01' }, body: advanceBody,
      }),
      request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
        method: 'POST', headers: { 'Idempotency-Key': 'execution-race-advance-own-02' }, body: advanceBody,
      }),
    ]);
    assert.deepEqual(advances.map((response) => response.status).sort(), [200, 409]);

    const expiredSession = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/finish`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-race-finish-owner-01' },
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    assert.equal(expiredSession.status, 200);
    setTime(new Date(START.getTime() + 4 * 60 * 60_000));
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/finish`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-race-start-owner-01' },
      body: JSON.stringify({ expectedRevision: 2 }),
    })).status, 409, 'one owner-level key cannot be reused across operations');
  });
});

test('an expired claim cannot create evidence or advance the session', async () => {
  await withExecutionApp(async ({ owner, request, setTime }) => {
    const session = await createSession(request, owner);
    const block = session.blocks[0];
    const start = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-expiry-start-owner-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    });
    const started = await start.json();
    setTime(new Date(START.getTime() + 3 * 60 * 60_000));
    const attemptId = crypto.randomUUID();
    const expired = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: attemptId, module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
        ...(block.module === 'reading' ? { metadata: readingAdaptiveAttemptMetadata(block) } : {}),
      }),
    });
    assert.equal(expired.status, 410);
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-expiry-advance-own-01' },
      body: JSON.stringify({
        blockId: block.id, expectedRevision: 1, attempt: { type: 'module', id: attemptId },
      }),
    })).status, 409);
    const restarted = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-expiry-restart-owner-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1 }),
    });
    assert.equal(restarted.status, 201, 'an expired unconsumed claim can be replaced safely');
    assert.notEqual((await restarted.json()).executionClaim, started.executionClaim);
  });
});

test('a consumed claim recovers its exact attempt instead of issuing a replacement claim', async () => {
  await withExecutionApp(async ({ owner, request, setTime }) => {
    const session = await createSession(request, owner, 45);
    const block = session.blocks[0];
    const startedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-consumed-start-owner-01' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 0 }),
    });
    const started = await startedResponse.json();
    setTime(new Date(START.getTime() + 60_000));
    const attemptId = crypto.randomUUID();
    assert.equal((await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: attemptId, module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
        ...(block.module === 'reading' ? { metadata: readingAdaptiveAttemptMetadata(block) } : {}),
      }),
    })).status, 201);

    const recoveryResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-consumed-start-owner-02' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1 }),
    });
    assert.equal(recoveryResponse.status, 200);
    const recovery = await recoveryResponse.json();
    assert.deepEqual(recovery.recoveryAttempt, { type: 'module', id: attemptId });
    assert.equal(recovery.execution.revision, 1);
    assert.equal(Object.hasOwn(recovery, 'executionClaim'), false);
    assert.equal(Object.hasOwn(recovery, 'claimExpiresAt'), false);
    const recoveryReplay = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-consumed-start-owner-02' },
      body: JSON.stringify({ blockId: block.id, expectedRevision: 1 }),
    });
    assert.equal(recoveryReplay.status, 200);
    assert.deepEqual(await recoveryReplay.json(), recovery);

    const advancedResponse = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-consumed-advance-owner-01' },
      body: JSON.stringify({
        blockId: block.id, expectedRevision: 1, attempt: recovery.recoveryAttempt,
      }),
    });
    assert.equal(advancedResponse.status, 200);
    const advanced = await advancedResponse.json();
    const next = advanced.session.blocks.find((item) => item.id === advanced.execution.currentBlockId);
    assert.equal(next?.kind, 'learning');
    const nextStart = await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/start`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-next-start-owner-01' },
      body: JSON.stringify({ blockId: next.id, expectedRevision: 2 }),
    });
    assert.equal(nextStart.status, 201, 'the next block can start after the consumed claim advances');
  });
});
