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

const START = new Date(Date.now() - 2 * 60 * 60_000);

function authentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    req.user = username;
    next();
  } };
}

async function withExecutionApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-execution-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9501, 'Execution Owner');
  const stranger = await repository.createTelegramUser(9502, 'Execution Stranger');
  let current = new Date(START);
  const now = () => new Date(current);
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({ authentication: authentication(), db: repository, now }));
  app.use(createAdaptiveLearningRoutes({
    authentication: authentication(), db: repository, enabled: true, now,
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
  try {
    await run({
      owner, stranger, repository, request,
      setTime(value) { current = new Date(value); },
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

test('one-block execution starts with an opaque claim, binds a stored attempt, advances, then finishes explicitly', async () => {
  await withExecutionApp(async ({ owner, stranger, repository, request, setTime }) => {
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
      metadata: { evidenceQuality: 'server_verified_unassisted', contentRef: 'forged' },
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
  });
});

test('server-owned writing or speaking completion binds to the claim without a client score', async () => {
  await withExecutionApp(async ({ owner, repository, request, setTime }) => {
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
    const session = await createSession(request, owner, 120);
    assert.ok(session.blocks.some((block) => ['writing', 'speaking'].includes(block.module)),
      'seeded non-speaking mastery must make a server-owned block deterministic');
    let executionRevision = 0;
    let serverOwnedSeen = false;
    let minute = 1;
    for (const block of session.blocks) {
      setTime(new Date(START.getTime() + minute * 60_000));
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
      setTime(new Date(START.getTime() + minute * 60_000));
      minute += 1;
      let attempt;
      if (block.module === 'writing') {
        const id = await repository.createWritingAttempt(owner, {
          taskType: block.activityId, assignment: {}, answer: 'A sufficiently long student answer for the persisted attempt.',
        }, 'test-writing-v1');
        await repository.finishWritingAttempt(id, { status: 'completed', review: { overall_got: 1, overall_max: 6 } });
        attempt = { type: 'writing', id };
        serverOwnedSeen = true;
      } else if (block.module === 'speaking') {
        const id = await repository.createSpeakingAttempt(owner, {
          taskType: Number(block.activityId.split('_')[1]), assignment: {}, transcript: 'Student transcript.',
        }, 'test-speaking-v1');
        await repository.finishSpeakingAttempt(id, { status: 'completed', review: { got: 1, max: 4 } });
        attempt = { type: 'speaking', id };
        serverOwnedSeen = true;
      } else {
        const id = crypto.randomUUID();
        const recorded = await request(owner, '/api/v1/module-attempts', {
          method: 'POST', body: JSON.stringify({
            id, module: block.module, activity: block.activityId,
            score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
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
        assert.equal(bound.status, 201, JSON.stringify(binding));
        assert.equal(binding.evidenceQuality, 'server_verified_assisted');
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
        assert.equal(result.completedBlock.evidenceQuality, 'server_verified_assisted');
        assert.equal(
          result.profileChange.evidenceSourceCountAfter,
          result.profileChange.evidenceSourceCountBefore + 1,
          'a server-owned evaluation must update the adaptive evidence profile',
        );
      }
    }
    assert.equal(serverOwnedSeen, true, 'the full registry must exercise a writing or speaking handoff');
  });
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
      }),
    })).status, 201);
    assert.equal((await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        id: crypto.randomUUID(), module: block.module, activity: block.activityId,
        score: 1, maxScore: 1, adaptiveExecutionClaim: started.executionClaim,
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
      }),
    });
    assert.equal(expired.status, 410);
    assert.equal((await request(owner, `/api/v1/adaptive-learning/sessions/${session.id}/advance`, {
      method: 'POST', headers: { 'Idempotency-Key': 'execution-expiry-advance-own-01' },
      body: JSON.stringify({
        blockId: block.id, expectedRevision: 1, attempt: { type: 'module', id: attemptId },
      }),
    })).status, 409);
  });
});
