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
import { buildSpeakingLearningAttempt } from '../speaking/learning-loop.js';
import { getEgeMockForm } from '../ege-mock/catalog.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../shared/automatic-assessment-contract.js';

const TEST_PRIVACY_POLICY_VERSION = '2026-08-26-vk-id-v1';

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
  key, id, contextId, transcript, acceptable = true, processedDurationSeconds = 10,
  confidence = 96, locale = 'en-GB', mode = 'unscripted',
  metrics = {},
  words = [{
    text: 'trusted', errorType: 'none', accuracyScore: 93,
    offsetSeconds: 1, durationSeconds: 0.4,
    phonemes: [{ ipa: 't', accuracyScore: 90 }],
  }],
}) {
  const preparedWords = words?.map((word, index) => ({
    ...word,
    ...(word.errorType !== 'omission' && !Object.hasOwn(word, 'offsetSeconds')
      ? { offsetSeconds: 1 + index, durationSeconds: 0.4 } : {}),
  }));
  const reservedSeconds = Math.max(20, Math.ceil(processedDurationSeconds));
  await repository.reserveSpeakingAssessment(owner, {
    id,
    idempotencyKey: key,
    requestHash: key.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    reservedSeconds,
    locale,
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
        status: 'success', isFinal: true, available: true, transcript, confidence,
        processedDurationSeconds, locale, mode, pauseAnalysisAvailable: locale === 'en-US',
        overallScore: Object.hasOwn(metrics, 'overallScore') ? metrics.overallScore : 90,
        accuracyScore: Object.hasOwn(metrics, 'accuracyScore') ? metrics.accuracyScore : 94,
        fluencyScore: Object.hasOwn(metrics, 'fluencyScore') ? metrics.fluencyScore : 86,
        ...(Object.hasOwn(metrics, 'completenessScore')
          ? { completenessScore: metrics.completenessScore } : {}),
        words: preparedWords, quality: { acceptable, warnings: acceptable ? [] : ['low_recognition_confidence'] },
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
  await repository.setPrivacyConsent(owner, {
    text_processing: false, voice_processing: true,
    policy_version: TEST_PRIVACY_POLICY_VERSION,
  });
  await repository.setPrivacyConsent(other, {
    text_processing: false, voice_processing: true,
    policy_version: TEST_PRIVACY_POLICY_VERSION,
  });
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
  let session;
  if (options.egeMock) {
    const form = getEgeMockForm('ege-en-2026-form-1', 1);
    const started = await repository.startEgeMockAttempt(owner, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: '70000000-0000-4000-8000-000000000001', requestHash: '7'.repeat(64),
    }, { now: () => new Date('2026-08-06T06:00:00.000Z') });
    let attempt = started.attempt;
    ({ attempt } = await repository.submitEgeMockWritten(owner, attempt.id, {
      expectedRevision: attempt.revision,
      idempotencyKey: '70000000-0000-4000-8000-000000000002', requestHash: '8'.repeat(64),
    }, { now: () => new Date('2026-08-06T06:01:00.000Z') }));
    ({ attempt } = await repository.startEgeMockOral(owner, attempt.id, {
      expectedRevision: attempt.revision,
      idempotencyKey: '70000000-0000-4000-8000-000000000003', requestHash: '9'.repeat(64),
    }, { now: () => new Date('2026-08-06T06:02:00.000Z') }));
    let mutationIndex = 4;
    const counts = { 39: 1, 40: 4, 41: 5, 42: 1 };
    for (const position of [39, 40, 41, 42]) {
      for (let responseNumber = 1; responseNumber <= counts[position]; responseNumber += 1) {
        const stage = async (action, at, recording = null) => {
          const result = await repository.advanceEgeMockOralStage(owner, attempt.id, {
            expectedRevision: attempt.revision, action, position, responseNumber, recording,
            idempotencyKey: `70000000-0000-4000-8000-${String(mutationIndex).padStart(12, '0')}`,
            requestHash: String(mutationIndex % 10).repeat(64),
          }, { now: () => new Date(at) });
          mutationIndex += 1;
          attempt = result.attempt;
        };
        await stage('advance', attempt.updatedAt || '2026-08-06T06:02:00.000Z');
        if (attempt.oralProgress.phase === 'preparing') {
          await stage('advance', attempt.oralProgress.stageDeadlineAt);
        }
        await stage('complete', attempt.oralProgress.stageDeadlineAt, {
          recordingId: `71000000-0000-4000-8000-${String(position * 10 + responseNumber).padStart(12, '0')}`,
          status: 'completed',
          durationSeconds: { 39: 90, 40: 20, 41: 40, 42: 180 }[position],
          sha256: String(position % 10).repeat(64),
        });
      }
    }
    ({ attempt } = await repository.submitEgeMockOral(owner, attempt.id, {
      expectedRevision: attempt.revision,
      idempotencyKey: '70000000-0000-4000-8000-000000000099', requestHash: 'a'.repeat(64),
    }, { now: () => new Date('2026-08-06T06:16:30.000Z') }));
    session = await repository.syncEgeMockSpeakingBridge(owner, attempt.id, {
      now: () => new Date('2026-08-06T06:16:31.000Z'),
    });
  } else if (options.fullSection) {
    session = await repository.assignFullSpeakingSession(owner, {
      catalogs: [
        SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
        SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
      ],
      accentProfile: options.egeMock
        ? null : { locale: 'en-GB', revision: 1, effective_at: '2026-08-06T09:59:00.000Z' },
      ...(options.egeMock ? { selectionReason: 'ege_mock' } : {}),
      now: new Date('2026-08-06T10:00:00.000Z'),
    });
    const counts = { 1: 1, 2: 4, 3: 5, 4: 1 };
    let fullNow = new Date('2026-08-06T10:00:00.000Z');
    for (const fullTaskType of [1, 2, 3, 4]) {
      for (let responseNumber = 1; responseNumber <= counts[fullTaskType]; responseNumber += 1) {
        let active = await repository.advanceFullSpeakingSessionStage(owner, session.id, { now: fullNow });
        if (active.phase === 'preparing') {
          active = await repository.advanceFullSpeakingSessionStage(owner, session.id, { now: fullNow });
        }
        fullNow = new Date(fullNow.getTime() + 5_000);
        session = await repository.completeFullSpeakingSessionResponse(owner, session.id, {
          taskType: fullTaskType, responseNumber, responseStatus: 'completed',
          recordingDurationSeconds: 5, micCheck: 'passed', localPlayback: false,
        }, { now: fullNow });
      }
    }
    await repository.submitFullSpeakingSessionResult(
      owner, session.id, '85500000-0000-4000-8000-000000000001', { now: fullNow },
    );
    session = await repository.getFullSpeakingSession(owner, session.id);
  } else {
    session = await repository[assign](owner, {
      catalogId: catalog.id,
      catalogRevision: catalog.revision,
      tasks: catalog.tasks,
      ...(options.targetedPractice ? {
        targetedPractice: options.targetedPractice,
        selectionReason: 'targeted_focus',
      } : {}),
      now: new Date('2026-08-06T10:00:00.000Z'),
    });
  }
  if (!options.fullSection && taskType === 1) {
    await repository.completeSpeakingTask1Session(owner, session.id, {
      recordingDurationSeconds: 60, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
    }, { now: new Date('2026-08-06T10:01:00.000Z') });
  } else if (!options.fullSection && (taskType === 2 || taskType === 3)) {
    const count = taskType === 2 ? 4 : 5;
    const complete = taskType === 2
      ? repository.completeSpeakingTask2Question.bind(repository)
      : repository.completeSpeakingTask3Answer.bind(repository);
    for (let index = 1; index <= count; index += 1) {
      await complete(owner, session.id, index, {
        recordingDurationSeconds: taskType === 2 ? 12 : 20,
        localPlayback: true, selfRating: 'steady',
      }, { now: new Date(Date.UTC(2026, 7, 6, 10, index)) });
    }
  } else if (!options.fullSection) {
    await repository.completeSpeakingTask4Session(owner, session.id, {
      recordingDurationSeconds: 60, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
    }, { now: new Date('2026-08-06T10:01:00.000Z') });
  }
  const assessmentKeys = [];
  if (taskType === 2 || taskType === 3) {
    const taskRef = options.fullSection
      ? session.assignments.find((item) => Number(item.task_type) === taskType)?.task_id
      : session.task_id;
    const task = catalog.tasks.find((item) => item.id === taskRef);
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
        confidence: Object.hasOwn(options.assessmentConfidences || [], index - 1)
          ? options.assessmentConfidences[index - 1] : 96,
        processedDurationSeconds: options.itemDurations?.[index - 1] ?? 10,
        locale: options.assessmentLocale || 'en-GB',
        metrics: options.assessmentMetrics?.[index - 1] || {},
        words: options.assessmentWords?.[index - 1],
      });
      assessmentKeys.push(key);
    }
  } else if (taskType === 4) {
    const taskRef = options.fullSection
      ? session.assignments.find((item) => Number(item.task_type) === taskType)?.task_id
      : session.task_id;
    const task = catalog.tasks.find((item) => item.id === taskRef);
    const key = '83000000-0000-4000-8000-000000000001';
    await finalizeAssessment(repository, owner, {
      key,
      id: '84000000-0000-4000-8000-000000000001',
      transcript: 'People is learning in both pictures. The monologue continues with enough phrases.',
      contextId: `task4:${session.id}:${task.id}@${task.revision}`,
      processedDurationSeconds: 30,
      words: [{
        text: 'People', errorType: 'mispronunciation', accuracyScore: 70,
        offsetSeconds: 1.25, durationSeconds: 0.4,
      }],
    });
    assessmentKeys.push(key);
  }
  const providerCalls = [];
  let budgetBlocked = Boolean(options.budgetBlocked);
  let rateBlocked = Boolean(options.rateBlocked);
  const providerReplies = Array.isArray(options.providerReplies) ? [...options.providerReplies] : null;
  const providers = Array.from({ length: options.providerCount || 1 }, (_, index) => ({
    name: index === 0 ? 'grok' : `fallback-${index}`,
    model: index === 0 ? 'fake-xai-model' : `fake-fallback-model-${index}`,
  }));
  let providersConfigured = options.providersConfigured !== false;
  let accessSubscriptionActive = true;
  let accessVoiceConsent = true;
  const providerClient = {
    limitsFor: () => ({ requestsPerHour: 20 }),
    aiProviders: () => (providersConfigured ? providers : []),
    askWithFallback: async () => { throw new Error('unused'); },
    async askProvider(provider, system, user, operation, requestOptions) {
      providerCalls.push({ provider: provider.name, system, user, operation, options: requestOptions });
      const configuredReply = providerReplies?.length ? providerReplies.shift() : options.providerReply;
      if (configuredReply instanceof Error) throw configuredReply;
      return {
        text: configuredReply ?? JSON.stringify(semantic),
        promptTokens: 100,
        completionTokens: 50,
      };
    },
    async parseWithOneRepair({ provider, text, parse, system, user, operation, responseFormat }) {
      try { return { value: parse(text), repair: null }; }
      catch (error) {
        if (!options.productionRepair) throw error;
        const repaired = await providerClient.askProvider(
          provider, system, user, operation, { responseFormat },
        );
        return { value: parse(repaired.text), repair: { provider, usage: repaired, reason: error.code } };
      }
    },
  };
  const routeRepository = Object.create(repository);
  if (options.beforeSpeakingClaim) {
    routeRepository.claimSpeakingEvaluation = async (...args) => {
      await options.beforeSpeakingClaim({ repository, owner, args });
      return repository.claimSpeakingEvaluation(...args);
    };
  }
  if (options.failSuccessfulFinish) {
    routeRepository.finishSpeakingAttempt = async (attemptId, outcome, context) => {
      if (['completed', 'needs_retry'].includes(outcome?.status)) {
        throw Object.assign(new Error('speaking persistence unavailable'), { code: 'STORAGE_UNAVAILABLE' });
      }
      return repository.finishSpeakingAttempt(attemptId, outcome, context);
    };
  }
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
      privacyPolicyVersion: TEST_PRIVACY_POLICY_VERSION,
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
      requireActiveSubscription: (_req, res, next) => (
        accessSubscriptionActive
          ? next() : res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } })
      ),
      requirePrivacyConsent: () => (_req, res, next) => (
        accessVoiceConsent
          ? next() : res.status(403).json({ error: { code: 'PRIVACY_CONSENT_REQUIRED' } })
      ),
      hasAiBudget: async () => true,
    },
    db: routeRepository,
    providerClient,
  }).router);
  app.use((error, _req, res, _next) => res.status(
    ['SUBSCRIPTION_REQUIRED', 'PRIVACY_CONSENT_REQUIRED'].includes(error?.code) ? 403 : 500,
  ).json({ error: { code: error?.code || 'INTERNAL_ERROR' } }));
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
      setProvidersConfigured(value) { providersConfigured = Boolean(value); },
      setAccessSubscriptionActive(value) { accessSubscriptionActive = Boolean(value); },
      setAccessVoiceConsent(value) { accessVoiceConsent = Boolean(value); },
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('submitted full Speaking task is evaluated only from its pinned owner-bound assessment evidence', async () => {
  await withEvaluationServer(async ({ owner, other, session, request, repository, assessmentKeys, providerCalls }) => {
    const body = {
      taskType: 2,
      sessionMode: 'full_section',
      sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    };
    assert.equal((await request(other, body)).status, 404);
    const response = await request(owner, body);
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'scored');
    assert.equal(response.body.review.max, 4);
    assert.equal(providerCalls.length, 1);
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.equal(stored.source_session_id, session.id);
    assert.equal(stored.source_task_ref, session.assignments[1].task_id);
    assert.equal(stored.assistance_used, false);
  }, { taskType: 2, fullSection: true });
});

test('EGE speaking recovery requires explicit paid-repeat acknowledgement before a second provider call', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls }) => {
    const body = {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    };
    const uncertain = await request(owner, body);
    assert.equal(uncertain.status, 503);
    assert.equal(providerCalls.length, 1);

    const blocked = await request(owner, body);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'SPEAKING_PROVIDER_REPEAT_ACKNOWLEDGEMENT_REQUIRED');
    assert.equal(providerCalls.length, 1, 'ordinary retry never repeats an ambiguous paid EGE call');

    const acknowledged = await request(owner, {
      ...body, acknowledgePossibleProviderRepeat: true,
    });
    assert.equal(acknowledged.status, 200);
    assert.deepEqual({
      mode: acknowledged.body.assessment.mode,
      scoreKind: acknowledged.body.assessment.scoreKind,
      methodicallyValidated: acknowledged.body.assessment.methodicallyValidated,
      warning: acknowledged.body.assessment.warning,
    }, { ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT, methodicallyValidated: false });
    assert.equal(providerCalls.length, 2);
  }, {
    taskType: 2, fullSection: true, egeMock: true,
    providerReplies: [new Error('provider transport uncertain'), JSON.stringify(semanticTask2())],
  });
});

test('EGE semantic provider claim rechecks current voice consent inside the owner mutation', async () => {
  let revoked = false;
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls }) => {
    const response = await request(owner, {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PRIVACY_CONSENT_REQUIRED');
    assert.equal(providerCalls.length, 0, 'revocation after middleware still prevents a paid call');
  }, {
    taskType: 2, fullSection: true, egeMock: true,
    async beforeSpeakingClaim({ repository, owner }) {
      if (revoked) return;
      revoked = true;
      await repository.setPrivacyConsent(owner, {
        text_processing: false, voice_processing: false,
        policy_version: TEST_PRIVACY_POLICY_VERSION,
      });
    },
  });
});

test('a frozen EGE semantic result replays after access revocation without another provider call', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, repository,
    setAccessSubscriptionActive, setAccessVoiceConsent,
  }) => {
    const body = {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    };
    const completed = await request(owner, body);
    assert.equal(completed.status, 200);
    assert.equal(providerCalls.length, 1);
    await repository.setPrivacyConsent(owner, {
      text_processing: false, voice_processing: false,
      policy_version: TEST_PRIVACY_POLICY_VERSION,
    });
    setAccessSubscriptionActive(false);
    setAccessVoiceConsent(false);

    const replay = await request(owner, body);
    assert.equal(replay.status, 200,
      'route access middleware cannot strand an exact already-paid result replay');
    assert.equal(replay.body.attemptId, completed.body.attemptId);
    assert.deepEqual(replay.body.review, completed.body.review);
    assert.equal(providerCalls.length, 1);
  }, { taskType: 2, fullSection: true, egeMock: true });
});

test('invalid EGE provider output is recoverable only after explicit paid-repeat acknowledgement', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, repository,
  }) => {
    const body = {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    };
    const invalid = await request(owner, body);
    assert.equal(invalid.status, 502);
    assert.equal(invalid.body.error.code, 'AI_RESPONSE_INVALID');
    const failedAttempt = (await repository.exportUserData(owner)).speaking_attempts[0];
    assert.equal(providerCalls.length, 1);

    const blocked = await request(owner, body);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'SPEAKING_PROVIDER_REPEAT_ACKNOWLEDGEMENT_REQUIRED');
    assert.equal(providerCalls.length, 1);

    const recovered = await request(owner, {
      ...body, acknowledgePossibleProviderRepeat: true,
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.attemptId, Number(failedAttempt.id));
    assert.equal(providerCalls.length, 2);
    assert.equal((await repository.exportUserData(owner)).speaking_attempts.length, 1);
  }, {
    taskType: 2, fullSection: true, egeMock: true,
    providerReplies: ['not valid json', JSON.stringify(semanticTask2())],
  });
});

test('invalid EGE output never triggers an automatic paid JSON repair', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls }) => {
    const invalid = await request(owner, {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(invalid.status, 502);
    assert.equal(invalid.body.error.code, 'AI_RESPONSE_INVALID');
    assert.equal(providerCalls.length, 1,
      'malformed EGE output freezes the claim before any same-provider repair call');
  }, {
    taskType: 2, fullSection: true, egeMock: true, productionRepair: true,
    providerReplies: ['not valid json', JSON.stringify(semanticTask2())],
  });
});

test('successful EGE provider response with ambiguous persistence never calls a fallback provider', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls }) => {
    const response = await request(owner, {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'SPEAKING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.deepEqual(providerCalls.map((call) => call.provider), ['grok']);
  }, {
    taskType: 2, fullSection: true, egeMock: true,
    providerCount: 2, failSuccessfulFinish: true,
  });
});

test('EGE speaking retries an unconfigured claim without a paid-repeat acknowledgement', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, setProvidersConfigured,
  }) => {
    const body = {
      taskType: 2, sessionMode: 'full_section', sessionId: session.id,
      pronunciationAssessmentKeys: assessmentKeys,
    };
    const unconfigured = await request(owner, body);
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.body.error.code, 'AI_NOT_CONFIGURED');
    assert.equal(providerCalls.length, 0);

    setProvidersConfigured(true);
    const recovered = await request(owner, body);
    assert.equal(recovered.status, 200);
    assert.equal(providerCalls.length, 1);
  }, {
    taskType: 2, fullSection: true, egeMock: true, providersConfigured: false,
  });
});

test('missing provider scoring facts fail closed before public learning mastery', async () => {
  const nullableWords = Array.from({ length: 4 }, () => [{
    text: 'weather', errorType: 'mispronunciation', accuracyScore: null,
    phonemes: [{ ipa: 'w', accuracyScore: null }],
  }]);
  await withEvaluationServer(async ({ owner, session, request, repository, assessmentKeys }) => {
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.needsRetryReason, 'acoustic_evidence_uncertain');
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.deepEqual({
      completenessScore: stored.review.acousticFacts.completenessScore,
      fluencyScore: stored.review.acousticFacts.fluencyScore,
      wordAccuracyScore: stored.review.acousticFacts.wordAccuracyScore,
      phonemeAccuracyScore: stored.review.acousticFacts.phonemeAccuracyScore,
    }, {
      completenessScore: null,
      fluencyScore: null,
      wordAccuracyScore: null,
      phonemeAccuracyScore: null,
    });
    const learning = buildSpeakingLearningAttempt(stored);
    assert.equal(learning.status, 'needs_retry');
    assert.equal(learning.masteryEligible, false);
    assert.equal(learning.signal.fluencyScore, null);
  }, {
    taskType: 2,
    budgetBlocked: true,
    rateBlocked: true,
    assessmentMetrics: Array.from({ length: 4 }, () => ({
      accuracyScore: null, fluencyScore: null, completenessScore: null,
    })),
    assessmentWords: nullableWords,
  });
});

test('Azure pause and monotone annotations survive evaluation without becoming pronunciation errors', async () => {
  await withEvaluationServer(async ({ owner, session, request, repository, assessmentKeys }) => {
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'scored');
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.deepEqual(stored.review.acousticFacts.wordEvents.map((event) => event.type), [
      'unexpected_break', 'missing_break', 'monotone',
    ]);
    const learning = buildSpeakingLearningAttempt(stored);
    assert.equal(learning.masteryEligible, true);
    assert.deepEqual(learning.wordIssues, []);
    assert.equal(learning.signal.pauseAnalysis.available, true);
    assert.equal(learning.signal.pauseAnalysis.totalCount, 2);
  }, {
    taskType: 2,
    assessmentLocale: 'en-US',
    assessmentWords: [
      [{ text: 'weather', errorType: 'unexpected_break', accuracyScore: 93,
        offsetSeconds: 1.2, durationSeconds: 0.8, phonemes: [] }],
      [{ text: 'today', errorType: 'missing_break', accuracyScore: 93,
        offsetSeconds: 2.4, durationSeconds: 0.3, phonemes: [] }],
      [{ text: 'open', errorType: 'none', accuracyScore: 93,
        offsetSeconds: 1, durationSeconds: 0.4, phonemes: [] }],
      [{ text: 'equipment', errorType: 'monotone', accuracyScore: 93,
        offsetSeconds: 1, durationSeconds: 0.4, phonemes: [] }],
    ],
  });
});

test('targeted evaluation persists only the exact bounded Azure target measurement', async () => {
  const target = {
    sourceAttemptId: 77,
    reportRevision: 'attempt.77.1786093200000',
    accentLocale: 'en-GB',
    skillId: 'ege.speaking.pronunciation_words',
    label: 'Произношение слова «cost»',
    contentRef: 'server:speaking:task:2:skill:ege.speaking.pronunciation_words:focus:word.77.0:new:v1',
    focus: { kind: 'word', value: 'cost', anchorWord: 'cost', ref: 'word.77.0' },
  };
  await withEvaluationServer(async ({ owner, session, request, repository, assessmentKeys }) => {
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.deepEqual(stored.targeted_practice, target);
    assert.deepEqual(stored.review.acousticFacts.targetMeasurement, {
      focusRef: 'word.77.0', kind: 'word', value: 'cost', anchorWord: 'cost',
      anchorObserved: true, score: 74,
    });
    const exported = await repository.exportUserData(owner);
    assert.deepEqual(exported.speaking_attempts[0].review.acousticFacts.targetMeasurement,
      stored.review.acousticFacts.targetMeasurement);
    assert.equal(JSON.stringify(stored.review.acousticFacts.targetMeasurement).includes('trusted'), false,
      'the target measurement must not retain unrelated recognized words');
  }, {
    targetedPractice: target,
    assessmentWords: [
      [{ text: 'cost', errorType: 'none', accuracyScore: 74, phonemes: [] }],
      [{ text: 'trusted', errorType: 'none', accuracyScore: 99, phonemes: [] }],
      [{ text: 'trusted', errorType: 'none', accuracyScore: 99, phonemes: [] }],
      [{ text: 'trusted', errorType: 'none', accuracyScore: 99, phonemes: [] }],
    ],
  });
});

test('target measurement treats scripted omissions and invalid raw scores as inconclusive', async () => {
  const target = {
    sourceAttemptId: 77,
    reportRevision: 'attempt.77.1786093200000',
    accentLocale: 'en-GB',
    skillId: 'ege.speaking.pronunciation_words',
    label: 'Произношение слова «cost»',
    contentRef: 'server:speaking:task:2:skill:ege.speaking.pronunciation_words:focus:word.77.0:new:v1',
    focus: { kind: 'word', value: 'cost', anchorWord: 'cost', ref: 'word.77.0' },
  };
  const scenarios = [
    {
      words: [{ text: 'cost', errorType: 'omission', accuracyScore: 95, phonemes: [] }],
      expected: { anchorObserved: false, score: null },
    },
    {
      words: [
        { text: 'cost', errorType: 'none', accuracyScore: null, phonemes: [] },
        { text: 'cost', errorType: 'none', accuracyScore: 101, phonemes: [] },
      ],
      expected: null,
    },
  ];
  for (const scenario of scenarios) {
    await withEvaluationServer(async ({ owner, session, request, repository, assessmentKeys }) => {
      const response = await request(owner, {
        taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
      });
      assert.equal(response.status, 200);
      const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
      assert.deepEqual(stored.review.acousticFacts.targetMeasurement, scenario.expected === null
        ? undefined : {
          focusRef: target.focus.ref,
          kind: target.focus.kind,
          value: target.focus.value,
          anchorWord: target.focus.anchorWord,
          ...scenario.expected,
        });
      const learning = buildSpeakingLearningAttempt(stored);
      assert.equal(learning.targetOutcome.status, 'inconclusive');
      assert.equal(learning.targetOutcome.score, null);
    }, {
      targetedPractice: target,
      assessmentWords: [
        scenario.words,
        [{ text: 'trusted', errorType: 'none', accuracyScore: 99, phonemes: [] }],
        [{ text: 'trusted', errorType: 'none', accuracyScore: 99, phonemes: [] }],
        [{ text: 'trusted', errorType: 'none', accuracyScore: 99, phonemes: [] }],
      ],
    });
  }
});

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
    assert.equal(stored.review.acousticFacts.wordAccuracyScore, 94);
    assert.equal(stored.review.acousticFacts.phonemeAccuracyScore, 90);
    assert.equal(stored.review.acousticFacts.fluencyScore, 86);
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

test('missing recognition confidence stays unavailable through stored retry evidence', async () => {
  await withEvaluationServer(async ({
    owner, session, request, assessmentKeys, providerCalls, repository,
  }) => {
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.needsRetryReason, 'acoustic_evidence_uncertain');
    assert.equal(response.body.review.confidence, null);
    assert.equal(providerCalls.length, 0);
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.equal(stored.review.acousticFacts.recognitionConfidence, null);
    assert.equal(stored.review.acousticFacts.fluencyScore, null);
  }, { assessmentConfidences: [null, 96, 96, 96], budgetBlocked: true, rateBlocked: true });
});

test('word timing beyond the trusted processed WAV duration fails closed before FIPI', async () => {
  await withEvaluationServer(async ({ owner, session, request, assessmentKeys, providerCalls, repository }) => {
    const response = await request(owner, {
      taskType: 2, sessionId: session.id, pronunciationAssessmentKeys: assessmentKeys,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.review.status, 'needs_retry');
    assert.equal(response.body.review.needsRetryReason, 'acoustic_evidence_uncertain');
    assert.equal(providerCalls.length, 0);
    const stored = await repository.getSpeakingAttempt(owner, response.body.attemptId);
    assert.equal(stored.review.acousticFacts.signalQuality, 'poor');
    assert.equal(stored.review.acousticFacts.fluencyScore, null);
    assert.equal(stored.review.acousticFacts.wordAccuracyScore, null);
    assert.equal(stored.review.acousticFacts.wordEvents[0].offsetSeconds, null);
    assert.equal(stored.review.acousticFacts.wordEvents[0].durationSeconds, null);
    assert.equal(buildSpeakingLearningAttempt(stored).masteryEligible, false);
  }, {
    taskType: 2, budgetBlocked: true, rateBlocked: true,
    assessmentWords: [
      [{ text: 'weather', errorType: 'mispronunciation', accuracyScore: 70,
        offsetSeconds: 9.9, durationSeconds: 0.2, phonemes: [] }],
      undefined, undefined, undefined,
    ],
  });
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
      {
        start: stored.review.acousticFacts.wordEvents[0].start,
        end: stored.review.acousticFacts.wordEvents[0].end,
        offsetSeconds: stored.review.acousticFacts.wordEvents[0].offsetSeconds,
        durationSeconds: stored.review.acousticFacts.wordEvents[0].durationSeconds,
      },
      { start: 0, end: 6, offsetSeconds: 1.25, durationSeconds: 0.4 },
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
          processedDurationSeconds: 58, locale: 'en-GB', mode: 'scripted',
          pauseAnalysisAvailable: false,
          overallScore: 84, accuracyScore: 88, completenessScore: 96, fluencyScore: 82,
          words: [{
            text: task.text.match(/[A-Za-z]+/u)[0], errorType: 'mispronunciation', accuracyScore: 70,
            offsetSeconds: 1.25, durationSeconds: 0.4,
          }],
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
  assert.match(operation, /EGE mock result is experimental, approximate and not an expert conclusion/u);
  assert.match(operation, /503[^\n]*SPEAKING_EVALUATION_SETTLEMENT_UNKNOWN/u);
  assert.match(specification, /SpeakingAutomaticAssessment:[\s\S]*methodicallyValidated:[^\n]*enum: \[false\]/u);
});

test('AI operation inventory documents owner-bound pronunciation evidence, not the removed contentRef flow', async () => {
  const inventory = await fs.readFile(new URL('../docs/AI_OPERATIONS.md', import.meta.url), 'utf8');
  const speakingRow = inventory.split('\n').find((line) => line.includes('/api/v1/ai/evaluate-speaking')) || '';
  assert.match(speakingRow, /owner-bound session\/pronunciation assessment keys/u);
  assert.doesNotMatch(speakingRow, /content ref/iu);
});
