import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAiRoutes } from '../routes/ai.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { createFileRepository } from '../storage/file-repository.js';

function semanticTask2({ confidence = 0.95 } = {}) {
  return {
    confidence,
    verdict: 'Четыре прямых вопроса соответствуют опорам.',
    evidence: ['Все четыре опоры проверены по расшифровке.'],
    issues: [],
    items: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      relevant: true,
      directQuestion: true,
      lexicalGrammarBlocksCommunication: false,
      evidence: `Question ${index + 1}`,
    })),
  };
}

function semanticTask1() {
  return {
    confidence: 0.95,
    verdict: 'Текст прочитан достаточно полно.',
    evidence: ['Расшифровка сопоставлена с серверным текстом.'],
    issues: [],
  };
}

function semanticTask3() {
  return {
    confidence: 0.95,
    verdict: 'Пять ответов соответствуют вопросам интервью.',
    evidence: ['Каждый ответ проверен отдельно.'],
    issues: [],
    items: Array.from({ length: 5 }, (_, index) => ({
      index: index + 1,
      relevant: true,
      complete: true,
      communicativelyAppropriate: true,
      phraseCount: 2,
      elementaryLexicalGrammarError: false,
      evidence: `Answer ${index + 1}`,
    })),
  };
}

function semanticTask4() {
  return {
    confidence: 0.95,
    verdict: 'Монолог соответствует плану.',
    evidence: ['Все четыре пункта раскрыты.'],
    issues: [],
    phraseCount: 13,
    wordList: false,
    introductionPresent: true,
    conclusionPresent: true,
    contentAspects: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1, id: `content-${index + 1}`, start: 0, end: 0,
      status: 'full', evidence: `Plan point ${index + 1}`, correction: 'No deduction.',
    })),
    organizationErrors: [],
    lexicalGrammarErrors: [{
      id: 'language-people', start: 0, end: 6,
      evidence: 'People is', correction: 'People are', gross: false,
    }],
  };
}

async function finalizeAssessment(repository, owner, {
  key, id, contextId, transcript, acceptable = true, processedDurationSeconds = 10, words = [],
}) {
  const reservedSeconds = Math.max(20, Math.ceil(processedDurationSeconds));
  await repository.reserveSpeakingAssessment(owner, {
    id,
    idempotencyKey: key,
    requestHash: key.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    reservedSeconds,
    locale: 'en-GB',
    contextId,
    now: new Date('2026-08-06T10:01:00.000Z'),
  });
  await repository.dispatchSpeakingAssessment(owner, key, { now: new Date('2026-08-06T10:01:01.000Z') });
  await repository.startSpeakingAssessment(owner, key, { now: new Date('2026-08-06T10:01:02.000Z') });
  await repository.finalizeSpeakingAssessment(owner, key, {
    billableSeconds: processedDurationSeconds,
    now: new Date('2026-08-06T10:01:10.000Z'),
    result: {
      assessment: {
        status: 'success', isFinal: true, available: true, transcript, confidence: 96,
        processedDurationSeconds,
        words, quality: { acceptable, warnings: acceptable ? [] : ['low_recognition_confidence'] },
      },
      billing: {
        assessmentId: id, reservedSeconds,
        billableSeconds: processedDurationSeconds, conservative: false,
      },
    },
  });
}

async function withEvaluationServer(run, options = {}) {
  const taskType = options.taskType || 2;
  const semantic = options.semantic || ({
    1: semanticTask1,
    2: semanticTask2,
    3: semanticTask3,
    4: semanticTask4,
  }[taskType]?.() || semanticTask2());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-evaluation-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9_100_001, 'Evaluation Owner');
  const other = await repository.createTelegramUser(9_100_002, 'Evaluation Other');
  await repository.grantDays(9_100_001, 30, 'Evaluation Owner');
  await repository.grantDays(9_100_002, 30, 'Evaluation Other');
  const catalog = ({
    1: SPEAKING_TASK1_CATALOG,
    2: SPEAKING_TASK2_CATALOG,
    3: SPEAKING_TASK3_CATALOG,
    4: SPEAKING_TASK4_CATALOG,
  })[taskType];
  const assign = ({
    1: 'assignSpeakingTask1Session',
    2: 'assignSpeakingTask2Session',
    3: 'assignSpeakingTask3Session',
    4: 'assignSpeakingTask4Session',
  })[taskType];
  const session = await repository[assign](owner, {
    catalogId: catalog.id,
    catalogRevision: catalog.revision,
    tasks: catalog.tasks,
    now: new Date('2026-08-06T10:00:00.000Z'),
  });
  const assessmentKeys = [];
  if (taskType === 2 || taskType === 3) {
    const task = catalog.tasks.find((item) => item.id === session.task_id);
    const transcripts = taskType === 2
      ? ['How much does it cost?', 'Where is it?', 'When is it open?', 'What equipment is available?']
      : Array.from({ length: 5 }, (_, index) => `This is interview answer ${index + 1}. It has two phrases.`);
    const itemCount = taskType === 2 ? 4 : 5;
    for (let index = 1; index <= itemCount; index += 1) {
      const key = `81000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const id = `82000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await finalizeAssessment(repository, owner, {
        key, id, transcript: transcripts[index - 1],
        contextId: `task${taskType}:${session.id}:${task.id}@${task.revision}:item${index}`,
        acceptable: options.acousticAcceptable !== false,
        processedDurationSeconds: options.itemDurations?.[index - 1] ?? 10,
      });
      assessmentKeys.push(key);
    }
  } else if (taskType === 4) {
    const task = catalog.tasks.find((item) => item.id === session.task_id);
    const key = '83000000-0000-4000-8000-000000000001';
    await finalizeAssessment(repository, owner, {
      key,
      id: '84000000-0000-4000-8000-000000000001',
      transcript: 'People is learning in both pictures. The monologue continues with enough phrases.',
      contextId: `task4:${session.id}:${task.id}@${task.revision}`,
      processedDurationSeconds: 30,
      words: [{ text: 'People', errorType: 'mispronunciation', accuracyScore: 70 }],
    });
    assessmentKeys.push(key);
  }
  const providerCalls = [];
  let budgetBlocked = Boolean(options.budgetBlocked);
  let rateBlocked = Boolean(options.rateBlocked);
  const providerReplies = Array.isArray(options.providerReplies) ? [...options.providerReplies] : null;
  const provider = { name: 'grok', model: 'fake-xai-model' };
  const providerClient = {
    limitsFor: () => ({ requestsPerHour: 20 }),
    aiProviders: () => [provider],
    askWithFallback: async () => { throw new Error('unused'); },
    async askProvider(_provider, system, user, operation, requestOptions) {
      providerCalls.push({ system, user, operation, options: requestOptions });
      const configuredReply = providerReplies?.length ? providerReplies.shift() : options.providerReply;
      if (configuredReply instanceof Error) throw configuredReply;
      return {
        text: configuredReply ?? JSON.stringify(semantic),
        promptTokens: 100,
        completionTokens: 50,
      };
    },
    async parseWithOneRepair({ text, parse }) {
      return { value: parse(text), repair: null };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createAiRoutes({
    authentication: {
      auth(req, res, next) {
        const username = req.get('x-test-user');
        if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = username;
        return next();
      },
    },
    access: {
      createOperationLimiter: () => (_req, res, next) => (
        rateBlocked
          ? res.status(429).json({ error: { code: 'RATE_LIMITED' } })
          : next()
      ),
      requireAiBudget: (_req, res, next) => (
        budgetBlocked
          ? res.status(503).json({ error: { code: 'AI_BUDGET_EXHAUSTED' } })
          : next()
      ),
      requireActiveSubscription: (_req, _res, next) => next(),
      requirePrivacyConsent: () => (_req, _res, next) => next(),
      hasAiBudget: async () => true,
    },
    db: repository,
    providerClient,
  }).router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (username, body) => {
    const response = await fetch(`${baseUrl}/api/v1/ai/evaluate-speaking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': username, connection: 'close' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({
      owner, other, session, request, providerCalls, repository, assessmentKeys,
      setBudgetBlocked(value) { budgetBlocked = Boolean(value); },
      setRateBlocked(value) { rateBlocked = Boolean(value); },
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('speaking evaluation resolves the owner-bound session and deterministically scores model facts', async () => {
  await withEvaluationServer(async ({
    owner, session, request, providerCalls, repository, assessmentKeys,
    setBudgetBlocked, setRateBlocked,
  }) => {
    const transcript = 'How much does it cost? Where is it? When is it open? What equipment is available?';
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.got, 4);
    assert.equal(response.body.review.max, 4);
    assert.equal(response.body.review.scoringVersion, 'speaking-fipi-combiner-v2');
    assert.equal(response.body.assessment.mode, 'automatic_training');
    assert.equal(response.body.assessment.methodicallyValidated, false);
    assert.equal('semanticFacts' in response.body.review, false);
    assert.equal('acousticFacts' in response.body.review, false);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].operation, 'evaluate_speaking');
    assert.equal(providerCalls[0].options.responseFormat.type, 'json_schema');
    const sent = JSON.parse(providerCalls[0].user);
    assert.equal(sent.trustedServerAssignment.points.length, 4);
    assert.equal(sent.untrustedStudentTranscript, transcript.replaceAll('? ', '?\n'));

    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.equal(stored.assignment_fingerprint.length, 64);
    assert.equal(stored.review.got, 4);
    assert.equal(stored.review.semanticFacts.items.length, 4);
    assert.equal(stored.review.acousticFacts.available, true);
    assert.deepEqual(stored.review.acousticFacts.itemDurations.map((item) => item.itemIndex), [1, 2, 3, 4]);
    assert.deepEqual(stored.review.acousticFacts.itemDurations.map((item) => item.durationSeconds), [10, 10, 10, 10]);
    assert.equal(stored.review.scoringVersion, 'speaking-fipi-combiner-v2');

    setBudgetBlocked(true);
    setRateBlocked(true);
    const replay = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.attemptId, response.body.attemptId);
    assert.deepEqual(replay.body.review, response.body.review);
    assert.equal(providerCalls.length, 1, 'an identical evaluation replays without another paid call');
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 1);
  });
});

test('client assignment injection and another owner session are rejected before provider call', async () => {
  await withEvaluationServer(async ({ owner, other, session, request, providerCalls, assessmentKeys }) => {
    const injected = await request(owner, {
      taskType: 2,
      sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
      assignment: { ad: 'forged', points: ['a', 'b', 'c', 'd'] },
    });
    assert.equal(injected.status, 400);

    const isolated = await request(other, {
      taskType: 2,
      sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(isolated.status, 404);
    assert.equal(providerCalls.length, 0);
  });
});

test('low semantic confidence returns needs_retry, never a false zero', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys }) => {
    const response = await request(owner, {
      taskType: 2,
      sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.got, null);
    assert.equal(response.body.review.max, 4);
    assert.doesNotMatch(response.body.review.verdict, /четыре прямых вопроса/iu);
    assert.deepEqual(response.body.review.good, []);
    assert.deepEqual(response.body.review.fix, []);
    assert.equal('voiceTutor' in response.body, false);
  }, { semantic: semanticTask2({ confidence: 0.2 }) });
});

test('unusable acoustic evidence returns retry before any xAI call', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls }) => {
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.needsRetryReason, 'acoustic_evidence_uncertain');
    assert.equal(providerCalls.length, 0, 'deterministically unusable audio must not spend xAI tokens');
  }, { acousticAcceptable: false, budgetBlocked: true, rateBlocked: true });
});

test('budget and rate rejection do not create a pending speaking claim', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, repository,
    setBudgetBlocked, setRateBlocked,
  }) => {
    const body = {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    };
    const budgetRejected = await request(owner, body);
    assert.equal(budgetRejected.status, 503);
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 0);
    setBudgetBlocked(false);
    setRateBlocked(true);
    const rateRejected = await request(owner, body);
    assert.equal(rateRejected.status, 429);
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 0);
    setRateBlocked(false);
    const accepted = await request(owner, body);
    assert.equal(accepted.status, 200);
    assert.equal(providerCalls.length, 1);
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 1);
  }, { budgetBlocked: true });
});

test('task 3 rejects one truncated answer before xAI even when aggregate audio is long enough', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls }) => {
    const response = await request(owner, {
      taskType: 3, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.needsRetryReason, 'acoustic_recording_too_short');
    assert.equal(providerCalls.length, 0);
  }, {
    taskType: 3,
    itemDurations: [1, 3, 3, 3, 3],
    budgetBlocked: true,
    rateBlocked: true,
  });
});

test('task 4 rejects a score event claimed by both semantic and Azure evidence owners', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls, repository }) => {
    const response = await request(owner, {
      taskType: 4,
      sessionId: session.id,
      pronunciationAssessmentKey: assessmentKeys[0],
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.needsRetryReason, 'scoring_event_ownership_conflict');
    assert.equal('voiceTutor' in response.body, false);
    assert.equal(providerCalls.length, 1);
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.deepEqual(
      { start: stored.review.acousticFacts.wordEvents[0].start, end: stored.review.acousticFacts.wordEvents[0].end },
      { start: 0, end: 6 },
    );
  }, { taskType: 4 });
});

test('failed speaking evaluation preserves provider provenance and replays without another call', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, repository,
  }) => {
    const body = {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    };
    const failed = await request(owner, body);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'AI_RESPONSE_INVALID');
    const attempts = (await repository.exportUserData(owner)).speaking_attempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 'failed');
    assert.equal(attempts[0].provider, 'grok');
    assert.equal(attempts[0].model, 'fake-xai-model');
    assert.equal(attempts[0].prompt_version, 'speaking-semantic-v4');

    const replay = await request(owner, body);
    assert.equal(replay.status, 502);
    assert.equal(replay.body.error.code, 'AI_RESPONSE_INVALID');
    assert.equal(providerCalls.length, 1);
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 1);
  }, { providerReply: 'not valid json' });
});

test('a transient xAI failure resumes the same attempt without another Azure assessment', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, repository,
  }) => {
    const body = {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    };
    const unavailable = await request(owner, body);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, 'AI_PROVIDER_UNAVAILABLE');
    const failedAttempt = (await repository.exportUserData(owner)).speaking_attempts[0];
    assert.equal(failedAttempt.status, 'failed');

    const resumed = await request(owner, body);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.review.status, 'scored');
    assert.equal(resumed.body.attemptId, Number(failedAttempt.id));
    assert.equal(providerCalls.length, 2);
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 1);
  }, {
    providerReplies: [new Error('temporary provider outage'), JSON.stringify(semanticTask2())],
  });
});

test('task 1 combines the exact owner-bound Azure assessment and rejects a mismatched context before xAI', async () => {
  await withEvaluationServer(async ({ owner, session, request, providerCalls, repository }) => {
    const task = SPEAKING_TASK1_CATALOG.tasks.find((item) => item.id === session.task_id);
    const assessmentKey = '71111111-1111-4111-8111-111111111111';
    const assessmentId = '72222222-2222-4222-8222-222222222222';
    const contextId = `task1:${session.id}:${task.id}@${task.revision}`;
    await repository.reserveSpeakingAssessment(owner, {
      id: assessmentId,
      idempotencyKey: assessmentKey,
      requestHash: 'a'.repeat(64),
      reservedSeconds: 60,
      locale: 'en-GB',
      contextId,
      now: new Date('2026-08-06T10:05:00.000Z'),
    });
    await repository.dispatchSpeakingAssessment(owner, assessmentKey, { now: new Date('2026-08-06T10:05:01.000Z') });
    await repository.startSpeakingAssessment(owner, assessmentKey, { now: new Date('2026-08-06T10:05:02.000Z') });
    await repository.finalizeSpeakingAssessment(owner, assessmentKey, {
      billableSeconds: 58,
      now: new Date('2026-08-06T10:06:00.000Z'),
      result: {
        assessment: {
          status: 'success', isFinal: true, available: true, transcript: task.text, confidence: 94,
          processedDurationSeconds: 58,
          completenessScore: 96, fluencyScore: 82,
          words: [{ text: task.text.match(/[A-Za-z]+/u)[0], errorType: 'mispronunciation', accuracyScore: 70 }],
          quality: { acceptable: true, warnings: [] },
        },
        billing: { assessmentId, reservedSeconds: 60, billableSeconds: 58, conservative: false },
      },
    });

    const scored = await request(owner, {
      taskType: 1,
      sessionId: session.id,
      pronunciationAssessmentKey: assessmentKey,
    });
    assert.equal(scored.status, 200);
    assert.equal(scored.body.review.got, 1);
    assert.equal(scored.body.review.max, 1);
    assert.equal('semanticFacts' in scored.body.review, false);
    assert.equal('acousticFacts' in scored.body.review, false);
    assert.equal(providerCalls.length, 1);
    assert.equal(JSON.parse(providerCalls[0].user).untrustedStudentTranscript, task.text);
    const storedScored = await repository.getSpeakingAttempt(owner, scored.body.attemptId);
    assert.deepEqual(
      Object.keys(storedScored.review.semanticFacts).sort(),
      ['confidence', 'evidence', 'issues', 'verdict'],
    );
    assert.equal(storedScored.review.acousticFacts.available, true);
    assert.deepEqual(storedScored.review.acousticFacts.itemDurations, []);
    assert.equal(storedScored.review.acousticFacts.wordEvents[0].owner, 'azure_pronunciation');
    assert.ok(storedScored.review.acousticFacts.wordEvents[0].start >= 0);
    assert.ok(storedScored.review.acousticFacts.wordEvents[0].end
      > storedScored.review.acousticFacts.wordEvents[0].start);

    const mismatchedKey = '73333333-3333-4333-8333-333333333333';
    await repository.reserveSpeakingAssessment(owner, {
      id: '74444444-4444-4444-8444-444444444444',
      idempotencyKey: mismatchedKey,
      requestHash: 'b'.repeat(64),
      reservedSeconds: 10,
      locale: 'en-GB',
      contextId: 'task1:another-session:another-task@1',
      now: new Date('2026-08-06T10:07:00.000Z'),
    });
    const rejected = await request(owner, {
      taskType: 1,
      sessionId: session.id,
      pronunciationAssessmentKey: mismatchedKey,
    });
    assert.equal(rejected.status, 409);
    assert.equal(providerCalls.length, 1, 'mismatched evidence is rejected before another xAI call');

    const partialKey = '75555555-5555-4555-8555-555555555555';
    const partialId = '76666666-6666-4666-8666-666666666666';
    await repository.reserveSpeakingAssessment(owner, {
      id: partialId,
      idempotencyKey: partialKey,
      requestHash: 'c'.repeat(64),
      reservedSeconds: 30,
      locale: 'en-GB',
      contextId,
      now: new Date('2026-08-06T10:08:00.000Z'),
    });
    await repository.dispatchSpeakingAssessment(owner, partialKey, { now: new Date('2026-08-06T10:08:01.000Z') });
    await repository.startSpeakingAssessment(owner, partialKey, { now: new Date('2026-08-06T10:08:02.000Z') });
    await repository.finalizeSpeakingAssessment(owner, partialKey, {
      billableSeconds: 30,
      now: new Date('2026-08-06T10:08:30.000Z'),
      result: {
        assessment: {
          status: 'partial', isFinal: false, available: true, transcript: task.text, confidence: 94,
          processedDurationSeconds: 30,
          completenessScore: 96, fluencyScore: 82, words: [],
          quality: { acceptable: true, warnings: [] },
        },
        billing: { assessmentId: partialId, reservedSeconds: 30, billableSeconds: 30, conservative: false },
      },
    });
    const incomplete = await request(owner, {
      taskType: 1,
      sessionId: session.id,
      pronunciationAssessmentKey: partialKey,
    });
    assert.equal(incomplete.status, 409);
    assert.equal(incomplete.body.error.code, 'SPEAKING_ASSESSMENT_NOT_READY');
    assert.match(incomplete.body.error.message, /не готова|неполна/iu);
    assert.equal(providerCalls.length, 1, 'partial Azure evidence is rejected before another xAI call');
  }, { taskType: 1 });
});

test('OpenAPI exposes only server-owned speaking evaluation references and the automatic gate', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const start = specification.indexOf('  /api/v1/ai/evaluate-speaking:');
  const end = specification.indexOf('  /api/v1/ai/generate-speaking-sample:', start);
  const operation = specification.slice(start, end);
  assert.match(operation, /required: \[taskType, sessionId, pronunciationAssessmentKey\]/u);
  assert.match(operation, /required: \[taskType, sessionId, pronunciationAssessmentKeys\]/u);
  assert.doesNotMatch(operation, /contentRef/u);
  assert.doesNotMatch(operation, /required:[^\n]*assignment|assignment:\s*\{/u);
  assert.match(operation, /needs_retry with a null score and no Voice Tutor pointer/u);
  assert.match(operation, /provider:\s*\{ type: string, nullable: true \}/u);
  assert.match(operation, /409[^\n]*same evaluation is already in progress/u);
  assert.match(specification, /SpeakingAutomaticAssessment:[\s\S]*methodicallyValidated:[^\n]*enum: \[false\]/u);
});

test('AI operation inventory documents owner-bound pronunciation evidence, not the removed contentRef flow', async () => {
  const inventory = await fs.readFile(new URL('../docs/AI_OPERATIONS.md', import.meta.url), 'utf8');
  const speakingRow = inventory.split('\n').find((line) => line.includes('/api/v1/ai/evaluate-speaking')) || '';
  assert.match(speakingRow, /owner-bound session\/pronunciation assessment keys/u);
  assert.doesNotMatch(speakingRow, /content ref/iu);
});
