import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockPublicForm,
} from '../ege-mock/catalog.js';
import { createEgeMockOralRunner } from '../public/ege-mock-oral-runner.js';

const OWNER = Object.freeze({ username: 'oral-owner', generation: 'account:2026-08-15T00:00:00.000Z' });
const ATTEMPT_ID = '1b3101dc-1811-40c0-a7b4-1328a4a8b7dd';
const publicForm = () => getEgeMockPublicForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function serialLockManager() {
  let queue = Promise.resolve();
  return {
    request(_name, _options, task) {
      const result = queue.then(task, task);
      queue = result.catch(() => {});
      return result;
    },
  };
}

function oralAttempt(overrides = {}) {
  return {
    id: ATTEMPT_ID,
    ownerGeneration: OWNER.generation,
    policyId: 'ege-mock-attempt-policy-v1',
    formId: 'ege-en-2026-form-1',
    formRevision: 1,
    catalogFingerprint: publicForm().fingerprint,
    state: 'oral_ready',
    revision: 4,
    oralStartedAt: null,
    oralDeadlineAt: null,
    oralProgress: null,
    ...overrides,
  };
}

test('oral runner starts the exact 17-minute authority only after microphone and asset preflight', async () => {
  const calls = [];
  const storage = memoryStorage();
  const form = publicForm();
  const media = {
    async preflight({ form: exactForm, tasks, assets }) {
      calls.push(['preflight', exactForm.identity, tasks.map(({ position }) => position), assets]);
    },
    async put() { throw new Error('not used'); },
    async has() { return true; },
  };
  const transport = {
    async attempt() { return { attempt: oralAttempt() }; },
    async start(attemptId, body) {
      calls.push(['start', attemptId, body.expectedRevision]);
      return { attempt: oralAttempt({
        state: 'oral_in_progress', revision: 5,
        oralStartedAt: '2026-08-15T06:00:00.000Z',
        oralDeadlineAt: '2026-08-15T06:17:00.000Z',
        oralProgress: {
          schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
          phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
        },
      }), serverTimeMs: Date.parse('2026-08-15T06:00:00.000Z') };
    },
  };
  const runner = createEgeMockOralRunner({ owner: OWNER, storage, media, transport });

  assert.equal((await runner.dispatch({ type: 'restore', form })).phase, 'ready');
  assert.equal(calls.length, 0, 'safe restore does not start media or the server timer');
  assert.equal((await runner.dispatch({ type: 'preflight' })).phase, 'prepared');
  assert.deepEqual(calls, [['preflight', form.identity, [39, 40, 41, 42], form.assets]]);
  const started = await runner.dispatch({ type: 'start' });
  assert.equal(started.phase, 'oral');
  assert.equal(started.remainingMs, 17 * 60_000);
  assert.deepEqual(calls[1], ['start', ATTEMPT_ID, 4]);
});

test('reload after readiness requires a fresh microphone and immutable-asset preflight', async () => {
  const storage = memoryStorage();
  const form = publicForm();
  let preflights = 0;
  const options = {
    owner: OWNER, attemptId: ATTEMPT_ID, storage,
    media: {
      async preflight() { preflights += 1; },
      async put() {}, async has() { return false; },
    },
    transport: {
      async attempt() { return { attempt: oralAttempt() }; },
      async start() { throw new Error('start must remain blocked after reload'); },
    },
  };
  const first = createEgeMockOralRunner(options);
  await first.dispatch({ type: 'restore', form });
  assert.equal((await first.dispatch({ type: 'preflight' })).phase, 'prepared');

  const reloaded = createEgeMockOralRunner(options);
  assert.equal((await reloaded.dispatch({ type: 'restore', form })).phase, 'ready');
  await assert.rejects(reloaded.dispatch({ type: 'start' }), {
    message: 'EGE_MOCK_ORAL_PREFLIGHT_REQUIRED',
  });
  assert.equal((await reloaded.dispatch({ type: 'preflight' })).phase, 'prepared');
  assert.equal(preflights, 2, 'the new media instance proves microphone and assets again');
});

test('oral runner binds immutable local audio to exact owner, attempt, form, task and response across reload', async () => {
  const storage = memoryStorage();
  const form = publicForm();
  const stored = [];
  let attempt = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:01:30.000Z',
      stageDeadlineAt: '2026-08-15T06:03:00.000Z', recordings: {},
    },
  });
  const media = {
    async preflight() {},
    async put(binding, blob) { stored.push({ binding, blob }); },
    async has(binding) { return stored.some((entry) => entry.binding.recordingId === binding.recordingId); },
  };
  const transport = {
    async attempt() { return { attempt }; },
    async stage(attemptId, body) {
      assert.equal(attemptId, ATTEMPT_ID);
      assert.equal(body.action, 'complete');
      assert.equal(body.position, 39);
      assert.equal(body.responseNumber, 1);
      attempt = oralAttempt({
        state: 'oral_in_progress', revision: 6,
        oralStartedAt: attempt.oralStartedAt, oralDeadlineAt: attempt.oralDeadlineAt,
        oralProgress: {
          schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 1,
          phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
          recordings: { '39:1': body.recording },
        },
      });
      return { applied: true, replayed: false, attempt };
    },
  };
  const first = createEgeMockOralRunner({ owner: OWNER, storage, media, transport });
  await first.dispatch({ type: 'restore', form });
  const completed = await first.dispatch({
    type: 'completeResponse', blob: new Blob(['audio']),
    recording: {
      recordingId: '19f0b263-6d8d-4af6-8f24-323d2a985a45', durationSeconds: 64,
      sha256: 'a'.repeat(64), status: 'completed',
    },
  });
  assert.equal(completed.current.position, 40);
  assert.deepEqual(stored[0].binding, {
    username: OWNER.username, ownerGeneration: OWNER.generation, attemptId: ATTEMPT_ID,
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    position: 39, taskType: 1, responseNumber: 1,
    recordingId: '1b3101dc-1811-40c0-87b4-1328a400f3d1', sha256: 'a'.repeat(64),
  });

  const restored = createEgeMockOralRunner({ owner: OWNER, storage, media, transport });
  const snapshot = await restored.dispatch({ type: 'restore', form });
  assert.equal(snapshot.current.position, 40);
  assert.equal(snapshot.recordings['39:1'].availableLocally, true);
  assert.equal(JSON.stringify(storage).includes('audio'), false, 'audio bytes never enter localStorage');
});

test('runner submit sends no candidate recordings that could bypass durable stage progress', async () => {
  const form = publicForm();
  let submittedBody = null;
  const attempt = oralAttempt({
    state: 'oral_in_progress', revision: 15,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(),
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() { return { attempt }; },
      async submit(_attemptId, body) {
        submittedBody = body;
        return { attempt: oralAttempt({ state: 'assessment_pending', revision: 16 }) };
      },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  await runner.dispatch({ type: 'submit' });
  assert.equal(Object.hasOwn(submittedBody, 'recordings'), false);
});

test('runner acknowledges automatic seventeen-minute submit through the mutating bridge route', async () => {
  const form = publicForm();
  let current = Date.parse('2026-08-15T06:16:59.000Z');
  let submitCalls = 0;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:14:00.000Z',
      stageDeadlineAt: '2026-08-15T06:17:00.000Z', recordings: {},
    },
  });
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(), now: () => current,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() { return { attempt: running }; },
      async submit(_attemptId, body) {
        submitCalls += 1;
        assert.equal(Object.hasOwn(body, 'recordings'), false);
        return { attempt: oralAttempt({
          state: 'assessment_pending', revision: 6,
          oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
          speakingAssessment: { status: 'pending', items: {} },
          oralProgress: running.oralProgress,
        }) };
      },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  current = Date.parse('2026-08-15T06:17:00.000Z');
  const submitted = await runner.dispatch({ type: 'tick' });
  assert.equal(submitCalls, 1);
  assert.equal(submitted.phase, 'submitted');
  assert.equal(submitted.speakingAssessment.status, 'pending');
});

test('oral runner derives every deadline from the sampled server clock despite client skew', async () => {
  const form = publicForm();
  const serverNow = Date.parse('2026-08-15T06:16:59.000Z');
  let clientNow = serverNow + 18 * 60_000;
  let submitCalls = 0;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:14:00.000Z',
      stageDeadlineAt: '2026-08-15T06:17:00.000Z', recordings: {},
    },
  });
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(), now: () => clientNow, monotonicNow: () => clientNow,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() { return { attempt: running, serverTimeMs: serverNow }; },
      async submit() { submitCalls += 1; throw new Error('must not submit early'); },
    },
  });
  const restored = await runner.dispatch({ type: 'restore', form });
  assert.equal(restored.remainingMs, 1_000);
  assert.equal(restored.authorityNowMs, serverNow);
  await runner.dispatch({ type: 'tick' });
  assert.equal(submitCalls, 0);
});

test('oral deadline never overwrites a durable final stage command with submit', async () => {
  const form = publicForm();
  let current = Date.parse('2026-08-15T06:16:59.000Z');
  let online = true;
  let submitCalls = 0;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 15,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:14:00.000Z',
      stageDeadlineAt: '2026-08-15T06:17:00.000Z', recordings: {},
    },
  });
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(), now: () => current, online: () => online,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() { return { attempt: running, serverTimeMs: current }; },
      async stage() { throw new Error('must remain queued while offline'); },
      async submit() { submitCalls += 1; throw new Error('must not replace stage'); },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  online = false;
  const queued = await runner.dispatch({
    type: 'completeResponse',
    recording: {
      recordingId: crypto.randomUUID(), status: 'technical_issue', durationSeconds: 0,
      technicalIssueCode: 'response_timeout',
    },
  });
  const stableStageKey = queued.pendingCommand.payload.idempotencyKey;
  current = Date.parse('2026-08-15T06:17:00.000Z');
  const expired = await runner.dispatch({ type: 'tick' });
  assert.equal(expired.pendingCommand.kind, 'stage');
  assert.equal(expired.pendingCommand.payload.idempotencyKey, stableStageKey);
  assert.equal(submitCalls, 0);
});

test('cross-tab completion derives one deterministic recording and mutation identity per exact stage', async () => {
  const form = publicForm();
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 15,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:14:00.000Z',
      stageDeadlineAt: '2026-08-15T06:17:00.000Z', recordings: {},
    },
  });
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  async function tab(recordingId) {
    let connected = true;
    const runner = createEgeMockOralRunner({
      owner: OWNER, storage: memoryStorage(), online: () => connected, media,
      transport: {
        async attempt() { return { attempt: running }; },
        async stage() { throw new Error('must remain queued while offline'); },
      },
    });
    await runner.dispatch({ type: 'restore', form });
    connected = false;
    return runner.dispatch({
      type: 'completeResponse',
      recording: {
        recordingId, status: 'technical_issue', durationSeconds: 0,
        technicalIssueCode: 'response_timeout',
      },
    });
  }
  const [left, right] = await Promise.all([tab(crypto.randomUUID()), tab(crypto.randomUUID())]);
  assert.equal(left.pendingCommand.payload.recording.recordingId,
    right.pendingCommand.payload.recording.recordingId);
  assert.match(left.pendingCommand.payload.recording.recordingId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(left.pendingCommand.payload.idempotencyKey,
    right.pendingCommand.payload.idempotencyKey);
});

test('ready and preparation advances use distinct repository-safe identities', async () => {
  const form = publicForm();
  let current = Date.parse('2026-08-15T06:00:00.000Z');
  let attempt = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const requests = new Map();
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(), now: () => current,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() { return { attempt, serverTimeMs: current }; },
      async stage(_attemptId, body) {
        const material = JSON.stringify({ ...body, idempotencyKey: undefined });
        if (requests.has(body.idempotencyKey) && requests.get(body.idempotencyKey) !== material) {
          throw Object.assign(new Error('EGE_MOCK_IDEMPOTENCY_CONFLICT'), {
            code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT',
          });
        }
        requests.set(body.idempotencyKey, material);
        const preparing = attempt.oralProgress.phase === 'ready';
        attempt = oralAttempt({
          state: 'oral_in_progress', revision: attempt.revision + 1,
          oralStartedAt: attempt.oralStartedAt, oralDeadlineAt: attempt.oralDeadlineAt,
          oralProgress: {
            ...attempt.oralProgress, phase: preparing ? 'preparing' : 'recording',
            stageStartedAt: preparing ? '2026-08-15T06:00:00.000Z' : '2026-08-15T06:01:30.000Z',
            stageDeadlineAt: preparing ? '2026-08-15T06:01:30.000Z' : '2026-08-15T06:03:00.000Z',
          },
        });
        return { attempt, serverTimeMs: current };
      },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  assert.equal((await runner.dispatch({ type: 'advance' })).current.phase, 'preparing');
  current = Date.parse('2026-08-15T06:01:30.000Z');
  assert.equal((await runner.dispatch({ type: 'advance' })).current.phase, 'recording');
  assert.equal(requests.size, 2);
});

test('offline oral stages advance locally and replay one ordered journal on reconnect', async () => {
  const form = publicForm();
  let current = Date.parse('2026-08-15T06:00:00.000Z');
  let connected = true;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const authoritative = [
    oralAttempt({
      state: 'oral_in_progress', revision: 6,
      oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
      oralProgress: {
        ...running.oralProgress, phase: 'preparing',
        stageStartedAt: '2026-08-15T06:00:00.000Z', stageDeadlineAt: '2026-08-15T06:01:30.000Z',
      },
    }),
    oralAttempt({
      state: 'oral_in_progress', revision: 7,
      oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
      oralProgress: {
        ...running.oralProgress, phase: 'recording',
        stageStartedAt: '2026-08-15T06:01:30.000Z', stageDeadlineAt: '2026-08-15T06:03:00.000Z',
      },
    }),
    oralAttempt({
      state: 'oral_in_progress', revision: 8,
      oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
      oralProgress: {
        schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 1,
        phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
        recordings: {
          '39:1': {
            schemaVersion: 'ege-mock-oral-recording-v1', recordingId: '1b3101dc-1811-40c0-87b4-1328a400f3d1',
            ownerGeneration: OWNER.generation, attemptId: ATTEMPT_ID, formId: form.id,
            formRevision: form.revision, catalogFingerprint: form.fingerprint,
            position: 39, taskType: 1, responseNumber: 1, status: 'technical_issue',
            durationSeconds: 0, sha256: null, technicalIssueCode: 'response_timeout',
            stageStartedAt: '2026-08-15T06:01:30.000Z', stageDeadlineAt: '2026-08-15T06:03:00.000Z',
            completedAt: '2026-08-15T06:03:00.000Z',
          },
        },
      },
    }),
  ];
  const sent = [];
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(), now: () => current, online: () => connected,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() { return { attempt: running, serverTimeMs: current }; },
      async stage(_attemptId, body) {
        sent.push(body);
        return { attempt: authoritative[sent.length - 1], serverTimeMs: current };
      },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  connected = false;
  let offline = await runner.dispatch({ type: 'advance' });
  assert.equal(offline.current.phase, 'preparing');
  current = Date.parse('2026-08-15T06:01:30.000Z');
  offline = await runner.dispatch({ type: 'advance' });
  assert.equal(offline.current.phase, 'recording');
  current = Date.parse('2026-08-15T06:03:00.000Z');
  offline = await runner.dispatch({
    type: 'completeResponse',
    recording: {
      recordingId: crypto.randomUUID(), status: 'technical_issue', durationSeconds: 0,
      technicalIssueCode: 'response_timeout',
    },
  });
  assert.equal(offline.current.position, 40);
  assert.equal(offline.pendingCommands.length, 3);
  assert.deepEqual(offline.pendingCommands.map(({ observedAt }) => observedAt), [
    '2026-08-15T06:00:00.000Z',
    '2026-08-15T06:01:30.000Z',
    '2026-08-15T06:03:00.000Z',
  ], 'device-local stage observations drive only the optimistic projection');
  connected = true;
  const synced = await runner.dispatch({ type: 'sync' });
  assert.equal(synced.current.position, 40);
  assert.equal(synced.pendingCommands.length, 0);
  assert.deepEqual(sent.map(({ action, expectedRevision }) => [action, expectedRevision]), [
    ['advance', 5], ['advance', 6], ['complete', 7],
  ]);
  assert.equal(sent.every((candidate) => !Object.hasOwn(candidate, 'observedAt')), true,
    'untrusted local time never crosses the server mutation boundary');
});

test('terminal reconciliation clears the whole stale offline journal after one rejected replay', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  let current = Date.parse('2026-08-15T06:00:00.000Z');
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const storedRecordings = [];
  const removedRecordings = [];
  const media = {
    async preflight() {},
    async put(binding) { storedRecordings.push(binding); },
    async has() { return false; },
    async remove(binding) { removedRecordings.push(binding); },
  };
  let connected = true;
  const offline = createEgeMockOralRunner({
    owner: OWNER, storage, media, now: () => current, online: () => connected,
    transport: { async attempt() { return { attempt: running, serverTimeMs: current }; }, async stage() {} },
  });
  await offline.dispatch({ type: 'restore', form });
  connected = false;
  await offline.dispatch({ type: 'advance' });
  current = Date.parse('2026-08-15T06:01:30.000Z');
  await offline.dispatch({ type: 'advance' });
  current = Date.parse('2026-08-15T06:03:00.000Z');
  await offline.dispatch({
    type: 'completeResponse', blob: new Blob(['first offline response']),
    recording: {
      recordingId: crypto.randomUUID(), status: 'completed', durationSeconds: 45,
      sha256: 'a'.repeat(64),
    },
  });
  current = Date.parse('2026-08-15T06:03:10.000Z');
  await offline.dispatch({ type: 'advance' });
  current = Date.parse('2026-08-15T06:04:10.000Z');
  await offline.dispatch({ type: 'advance' });
  current = Date.parse('2026-08-15T06:04:30.000Z');
  const queued = await offline.dispatch({
    type: 'completeResponse', blob: new Blob(['second offline response']),
    recording: {
      recordingId: crypto.randomUUID(), status: 'completed', durationSeconds: 20,
      sha256: 'b'.repeat(64),
    },
  });
  assert.equal(queued.pendingCommands.length, 6);
  assert.equal(storedRecordings.length, 2);

  let stageCalls = 0;
  let getCalls = 0;
  const terminal = oralAttempt({
    state: 'assessment_pending', revision: 7,
    oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
  });
  const restored = createEgeMockOralRunner({
    owner: OWNER, storage, media, now: () => current, online: () => true,
    transport: {
      async stage() {
        stageCalls += 1;
        throw Object.assign(new Error('closed'), { code: 'EGE_MOCK_ORAL_CLOSED' });
      },
      async attempt() { getCalls += 1; return { attempt: terminal, serverTimeMs: current }; },
    },
  });
  const reconciled = await restored.dispatch({ type: 'restore', form });
  assert.equal(reconciled.phase, 'submitted');
  assert.equal(reconciled.pendingCommands.length, 0);
  assert.equal(reconciled.saveStatus, 'saved');
  assert.equal(stageCalls, 1, 'terminal authority prevents replaying the rest of the stale journal');
  assert.equal(getCalls, 1);
  assert.deepEqual(
    removedRecordings.map(({ recordingId }) => recordingId).sort(),
    storedRecordings.map(({ recordingId }) => recordingId).sort(),
    'terminal reconciliation removes every later queued WAV absent from the authoritative ledger',
  );
});

test('an immutable lost-ack replay adopts the current attempt instead of its historical snapshot', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  let connected = true;
  const recordingId = '1b3101dc-1811-40c0-87b4-1328a400f3d1';
  const historical = oralAttempt({
    state: 'oral_in_progress', revision: 6,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:01:30.000Z',
      stageDeadlineAt: '2026-08-15T06:03:00.000Z', recordings: {},
    },
  });
  const current = oralAttempt({
    state: 'oral_in_progress', revision: 8,
    oralStartedAt: historical.oralStartedAt, oralDeadlineAt: historical.oralDeadlineAt,
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
      recordings: { '39:1': {
        recordingId, position: 39, taskType: 1, responseNumber: 1,
        status: 'completed', durationSeconds: 45, sha256: 'a'.repeat(64),
      } },
    },
  });
  const media = { async preflight() {}, async put() {}, async has() { return true; } };
  const first = createEgeMockOralRunner({
    owner: OWNER, storage, media, online: () => connected,
    transport: { async attempt() { return { attempt: historical }; }, async stage() {} },
  });
  await first.dispatch({ type: 'restore', form });
  connected = false;
  await first.dispatch({
    type: 'completeResponse', blob: new Blob(['audio']),
    recording: { recordingId: crypto.randomUUID(), status: 'completed', durationSeconds: 45, sha256: 'a'.repeat(64) },
  });

  let currentGets = 0;
  const restored = createEgeMockOralRunner({
    owner: OWNER, storage, media, online: () => true,
    transport: {
      async stage() { return { replayed: true, attempt: historical }; },
      async attempt() { currentGets += 1; return { attempt: current }; },
    },
  });
  const reconciled = await restored.dispatch({ type: 'restore', form });
  assert.equal(reconciled.current.position, 40);
  assert.equal(reconciled.revision, 8);
  assert.equal(reconciled.pendingCommands.length, 0);
  assert.equal(currentGets, 1, 'immutable mutation replay is followed by one safe current-state read');
});

test('a superseded late completion removes only its unaccepted local WAV', async () => {
  const form = publicForm();
  const removed = [];
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 7,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:01:30.000Z',
      stageDeadlineAt: '2026-08-15T06:03:00.000Z', recordings: {},
    },
  });
  const technical = oralAttempt({
    state: 'oral_in_progress', revision: 8,
    oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
      recordings: { '39:1': {
        recordingId: '1b3101dc-1811-40c0-87b4-1328a400f3d9',
        position: 39, taskType: 1, responseNumber: 1, status: 'technical_issue',
        durationSeconds: 0, sha256: null, technicalIssueCode: 'response_timeout',
      } },
    },
  });
  let getCalls = 0;
  const late = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(),
    media: {
      async preflight() {}, async put() {}, async has() { return true; },
      async remove(binding) { removed.push(binding); },
    },
    transport: {
      async attempt() { getCalls += 1; return { attempt: getCalls === 1 ? running : technical }; },
      async stage() { throw Object.assign(new Error('expired'), { code: 'EGE_MOCK_ORAL_STAGE_EXPIRED' }); },
    },
  });
  await late.dispatch({ type: 'restore', form });
  const result = await late.dispatch({
    type: 'completeResponse', blob: new Blob(['late audio']),
    recording: { recordingId: crypto.randomUUID(), status: 'completed', durationSeconds: 45, sha256: 'b'.repeat(64) },
  });
  assert.equal(result.current.position, 40);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].recordingId, '1b3101dc-1811-40c0-87b4-1328a400f3d1');
});

test('reload keeps the offline oral projection when connectivity reports online before transport recovers', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  const current = Date.parse('2026-08-15T06:00:00.000Z');
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  let connected = true;
  const offline = createEgeMockOralRunner({
    owner: OWNER, storage, media, now: () => current, online: () => connected,
    transport: {
      async attempt() { return { attempt: running, serverTimeMs: current }; },
      async stage() { throw new Error('must remain queued while offline'); },
    },
  });
  await offline.dispatch({ type: 'restore', form });
  connected = false;
  await offline.dispatch({ type: 'advance' });

  let stageCalls = 0;
  let getCalls = 0;
  const reloaded = createEgeMockOralRunner({
    owner: OWNER, storage, media, now: () => current, online: () => true,
    transport: {
      async stage() {
        stageCalls += 1;
        throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 });
      },
      async attempt() { getCalls += 1; throw new Error('must replay before observational GET'); },
    },
  });
  const restored = await reloaded.dispatch({ type: 'restore', form });
  assert.equal(restored.phase, 'oral');
  assert.equal(restored.current.phase, 'preparing');
  assert.equal(restored.pendingCommands.length, 1);
  assert.equal(restored.saveStatus, 'queued');
  assert.equal(stageCalls, 1);
  assert.equal(getCalls, 0);
});

test('submitted oral assessment remains actionable with honest technical or skipped evidence', async () => {
  const form = publicForm();
  const recordings = {};
  for (const [position, count] of [[39, 1], [40, 4], [41, 5], [42, 1]]) {
    for (let responseNumber = 1; responseNumber <= count; responseNumber += 1) {
      const completed = position !== 42;
      recordings[`${position}:${responseNumber}`] = {
        recordingId: crypto.randomUUID(), position, taskType: position - 38, responseNumber,
        status: completed ? 'completed' : 'technical_issue',
        durationSeconds: completed ? 10 : 0, sha256: completed ? 'a'.repeat(64) : null,
      };
    }
  }
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(),
    media: {
      async preflight() {}, async put() {},
      async has(binding) { return recordings[`${binding.position}:${binding.responseNumber}`].status === 'completed'; },
    },
    transport: { async attempt() {
      return { attempt: oralAttempt({
        state: 'assessment_pending', revision: 20,
        oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
        oralProgress: {
          schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
          phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null, recordings,
        },
      }) };
    } },
  });
  const restored = await runner.dispatch({ type: 'restore', form });
  assert.equal(restored.assessmentEvidenceReady, true);
});

test('safe oral restore projects the durable provisional speaking status without dispatch', async () => {
  let calls = 0;
  const speakingAssessment = {
    status: 'retryable', mode: 'experimental', scoreKind: 'approximate', items: {},
  };
  const runner = createEgeMockOralRunner({
    owner: OWNER, storage: memoryStorage(),
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: {
      async attempt() {
        calls += 1;
        return { attempt: oralAttempt({ state: 'assessment_pending', speakingAssessment }) };
      },
    },
  });
  const restored = await runner.dispatch({ type: 'restore', form: publicForm() });
  assert.deepEqual(restored.speakingAssessment, speakingAssessment);
  assert.equal(calls, 1, 'safe GET restore performs no evaluation dispatch');
});

test('an already-authorized oral part restores offline from the exact device projection', async () => {
  const storage = memoryStorage();
  const form = publicForm();
  const attempt = oralAttempt({
    state: 'oral_in_progress', revision: 7,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 2,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  const first = createEgeMockOralRunner({
    owner: OWNER, storage, media, transport: { async attempt() { return { attempt }; } },
  });
  await first.dispatch({ type: 'restore', form });

  let networkCalls = 0;
  const offline = createEgeMockOralRunner({
    owner: OWNER, storage, media, online: () => false,
    transport: { async attempt() { networkCalls += 1; throw new Error('offline'); } },
  });
  const restored = await offline.dispatch({ type: 'restore', form });
  assert.equal(restored.phase, 'oral');
  assert.equal(restored.current.position, 40);
  assert.equal(restored.current.responseNumber, 2);
  assert.equal(networkCalls, 0);
});

test('offline restore rejects a local oral envelope from a different exact attempt', async () => {
  const storage = memoryStorage();
  const form = publicForm();
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  const attempt = oralAttempt({
    state: 'oral_in_progress', revision: 7,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 2,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  await createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage, media,
    transport: { async attempt() { return { attempt }; } },
  }).dispatch({ type: 'restore', form });

  const nextAttemptId = '69a24f88-a3f2-4a97-9cf0-80f54d144e17';
  const next = createEgeMockOralRunner({
    owner: OWNER, attemptId: nextAttemptId, storage, media, online: () => false,
    transport: { async attempt() { throw new Error('must not request while offline'); } },
  });
  await assert.rejects(next.dispatch({ type: 'restore', form }), {
    message: 'EGE_MOCK_ORAL_ATTEMPT_UNAVAILABLE',
  });
  assert.equal(storage.getItem(`easyboost-ege-mock-oral-v1:${OWNER.username}:${OWNER.generation}`), null,
    'the stale exact-attempt envelope is purged instead of leaking into the new attempt');
});

test('the final offline stage and submit form one durable journal that restores and replays in order', async () => {
  const storage = memoryStorage();
  const form = publicForm();
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  let connected = true;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 15,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:14:00.000Z',
      stageDeadlineAt: '2026-08-15T06:17:00.000Z', recordings: {},
    },
  });
  const sent = [];
  const transport = {
    async attempt() { return { attempt: running }; },
    async stage(_attemptId, body) {
      sent.push('stage');
      return { attempt: oralAttempt({
        state: 'oral_in_progress', revision: 16,
        oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
        oralProgress: {
          ...running.oralProgress, phase: 'ready_to_submit', stageStartedAt: null,
          stageDeadlineAt: null, recordings: { '42:1': body.recording },
        },
      }) };
    },
    async submit() {
      sent.push('submit');
      return { attempt: oralAttempt({
        state: 'assessment_pending', revision: 17,
        oralStartedAt: running.oralStartedAt, oralDeadlineAt: running.oralDeadlineAt,
        oralProgress: { ...running.oralProgress, phase: 'ready_to_submit', recordings: {} },
      }) };
    },
  };
  const first = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage, media, online: () => connected, transport,
  });
  await first.dispatch({ type: 'restore', form });
  connected = false;
  await first.dispatch({
    type: 'completeResponse', recording: {
      recordingId: crypto.randomUUID(), status: 'technical_issue', durationSeconds: 0,
      technicalIssueCode: 'response_timeout',
    },
  });
  const queued = await first.dispatch({ type: 'submit' });
  assert.equal(queued.readyToSubmit, true);
  assert.deepEqual(queued.pendingCommands.map(({ kind }) => kind), ['stage', 'submit']);

  const restoredRunner = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage, media, online: () => connected, transport,
  });
  const restored = await restoredRunner.dispatch({ type: 'restore', form });
  assert.equal(restored.readyToSubmit, true);
  assert.deepEqual(restored.pendingCommands.map(({ kind }) => kind), ['stage', 'submit']);
  connected = true;
  const submitted = await restoredRunner.dispatch({ type: 'sync' });
  assert.equal(submitted.phase, 'submitted');
  assert.deepEqual(sent, ['stage', 'submit']);
});

test('a validated oral projection survives a lying connectivity signal and separate local generation', async () => {
  const storage = memoryStorage();
  const form = publicForm();
  const localOwner = { username: OWNER.username, generation: 0 };
  const attempt = oralAttempt({
    state: 'oral_in_progress', revision: 7,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 41, responseNumber: 3,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  const first = createEgeMockOralRunner({
    owner: localOwner, attemptOwnerGeneration: OWNER.generation, storage, media,
    transport: { async attempt() { return { attempt }; } },
  });
  await first.dispatch({ type: 'restore', form });

  let safeGetCalls = 0;
  const restored = await createEgeMockOralRunner({
    owner: localOwner, attemptOwnerGeneration: OWNER.generation, storage, media,
    online: () => true,
    transport: { async attempt() { safeGetCalls += 1; throw new Error('network unavailable'); } },
  }).dispatch({ type: 'restore', form });
  assert.equal(restored.phase, 'oral');
  assert.equal(restored.current.position, 41);
  assert.equal(restored.current.responseNumber, 3);
  assert.equal(safeGetCalls, 1, 'only the observational restore GET is attempted');
});

test('real-clock reconnect keeps later offline stages queued until server deadlines authorize them', async () => {
  const form = publicForm();
  let current = Date.parse('2026-08-15T06:00:00.000Z');
  let connected = true;
  let authoritative = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const transport = {
    async attempt() { return { attempt: authoritative, serverTimeMs: current }; },
    async stage(_id, body) {
      const progress = authoritative.oralProgress;
      if (body.action === 'advance' && progress.phase === 'ready') {
        authoritative = oralAttempt({
          state: 'oral_in_progress', revision: authoritative.revision + 1,
          oralStartedAt: authoritative.oralStartedAt, oralDeadlineAt: authoritative.oralDeadlineAt,
          oralProgress: {
            ...progress, phase: 'preparing', stageStartedAt: new Date(current).toISOString(),
            stageDeadlineAt: new Date(current + 90_000).toISOString(),
          },
        });
        return { attempt: authoritative, serverTimeMs: current };
      }
      if (body.action === 'advance' && progress.phase === 'preparing') {
        if (current < Date.parse(progress.stageDeadlineAt)) {
          throw Object.assign(new Error('too early'), { code: 'EGE_MOCK_ORAL_STAGE_TOO_EARLY' });
        }
        authoritative = oralAttempt({
          state: 'oral_in_progress', revision: authoritative.revision + 1,
          oralStartedAt: authoritative.oralStartedAt, oralDeadlineAt: authoritative.oralDeadlineAt,
          oralProgress: {
            ...progress, phase: 'recording', stageStartedAt: progress.stageDeadlineAt,
            stageDeadlineAt: new Date(Date.parse(progress.stageDeadlineAt) + 90_000).toISOString(),
          },
        });
        return { attempt: authoritative, serverTimeMs: current };
      }
      if (body.action === 'complete' && progress.phase === 'recording') {
        if (current < Date.parse(progress.stageDeadlineAt)) {
          throw Object.assign(new Error('too early'), { code: 'EGE_MOCK_ORAL_STAGE_TOO_EARLY' });
        }
        authoritative = oralAttempt({
          state: 'oral_in_progress', revision: authoritative.revision + 1,
          oralStartedAt: authoritative.oralStartedAt, oralDeadlineAt: authoritative.oralDeadlineAt,
          oralProgress: {
            schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 1,
            phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
            recordings: { '39:1': body.recording },
          },
        });
        return { attempt: authoritative, serverTimeMs: current };
      }
      throw new Error('unexpected stage');
    },
  };
  const runner = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage: memoryStorage(), transport,
    now: () => current, monotonicNow: () => current, online: () => connected,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
  });
  await runner.dispatch({ type: 'restore', form });
  connected = false;
  await runner.dispatch({ type: 'advance' });
  current += 90_000;
  await runner.dispatch({ type: 'advance' });
  current += 90_000;
  await runner.dispatch({
    type: 'completeResponse', recording: {
      recordingId: crypto.randomUUID(), status: 'technical_issue', durationSeconds: 0,
      technicalIssueCode: 'response_timeout',
    },
  });
  current = Date.parse('2026-08-15T06:00:30.000Z');
  connected = true;
  let synced = await runner.dispatch({ type: 'sync' });
  assert.equal(synced.current.phase, 'preparing');
  assert.equal(synced.pendingCommands.length, 2);
  current = Date.parse(synced.current.stageDeadlineAt);
  synced = await runner.dispatch({ type: 'sync' });
  assert.equal(synced.current.phase, 'recording');
  assert.equal(synced.pendingCommands.length, 1);
  current = Date.parse(synced.current.stageDeadlineAt);
  synced = await runner.dispatch({ type: 'sync' });
  assert.equal(synced.current.position, 40);
  assert.equal(synced.pendingCommands.length, 0);
});

test('offline clock correction cannot mint a premature submit or block later stages', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  let wall = Date.parse('2026-08-15T06:00:00.000Z');
  let monotonic = 0;
  let connected = true;
  const attempt = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const runner = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage, now: () => wall,
    monotonicNow: () => monotonic, online: () => connected,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: { async attempt() { return { attempt, serverTimeMs: Date.parse(attempt.oralStartedAt) }; } },
  });
  await runner.dispatch({ type: 'restore', form });
  connected = false;
  wall += 60 * 60_000;
  monotonic += 1_000;
  const ticked = await runner.dispatch({ type: 'tick' });
  assert.equal(ticked.pendingCommands.length, 0);
  assert.ok(ticked.remainingMs > 15 * 60_000,
    'persisted server sample advances only by monotonic elapsed time, not corrected wall time');
});

test('offline reload advances from a cross-navigation monotonic origin without trusting wall correction', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  const startedAt = Date.parse('2026-08-15T06:00:00.000Z');
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: new Date(startedAt).toISOString(),
    oralDeadlineAt: new Date(startedAt + 17 * 60_000).toISOString(),
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const media = { async preflight() {}, async put() {}, async has() { return false; } };
  const first = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage, media,
    now: () => startedAt,
    performanceClock: { timeOrigin: startedAt - 10_000, now: () => 10_000 },
    transport: { async attempt() { return { attempt: running, serverTimeMs: startedAt }; } },
  });
  await first.dispatch({ type: 'restore', form });

  const reloaded = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage, media, online: () => false,
    now: () => startedAt,
    performanceClock: { timeOrigin: startedAt + 5 * 60_000 - 500, now: () => 500 },
    transport: { async attempt() { throw new Error('offline reload must not issue GET'); } },
  });
  const restored = await reloaded.dispatch({ type: 'restore', form });
  assert.equal(restored.remainingMs, 12 * 60_000,
    'time spent closed advances the exact 17-minute authority across a reset performance.now origin');
});

test('cross-tab local refresh adopts a newer journal without persisting a feedback event', async () => {
  const form = publicForm();
  const backing = memoryStorage();
  let writes = 0;
  const storage = {
    ...backing,
    setItem(key, value) { writes += 1; return backing.setItem(key, value); },
  };
  const locks = serialLockManager();
  let connected = true;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const options = {
    owner: OWNER, attemptId: ATTEMPT_ID, storage, lockManager: locks,
    now: () => Date.parse('2026-08-15T06:00:00.000Z'), online: () => connected,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: { async attempt() { return { attempt: running }; }, async stage() {} },
  };
  const first = createEgeMockOralRunner(options);
  const second = createEgeMockOralRunner(options);
  await first.dispatch({ type: 'restore', form });
  await second.dispatch({ type: 'restore', form });
  connected = false;
  await first.dispatch({ type: 'advance' });
  const beforeRefresh = writes;
  const adopted = await second.dispatch({ type: 'refreshLocal' });
  assert.equal(adopted.current.phase, 'preparing');
  assert.equal(writes, beforeRefresh,
    'storage-event adoption must not increment localRevision and ping-pong into the peer tab');
});

test('shared oral storage merges cross-tab commands under one durable lock and rolls back failed writes', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  const locks = serialLockManager();
  let current = Date.parse('2026-08-15T06:00:00.000Z');
  let connected = true;
  const attempt = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
    },
  });
  const options = {
    owner: OWNER, attemptId: ATTEMPT_ID, storage, lockManager: locks,
    now: () => current, monotonicNow: () => current, online: () => connected,
    media: { async preflight() {}, async put() {}, async has() { return false; } },
    transport: { async attempt() { return { attempt, serverTimeMs: current }; }, async stage() {} },
  };
  const first = createEgeMockOralRunner(options);
  const second = createEgeMockOralRunner(options);
  await first.dispatch({ type: 'restore', form });
  await second.dispatch({ type: 'restore', form });
  connected = false;
  await first.dispatch({ type: 'advance' });
  current += 90_000;
  const merged = await second.dispatch({ type: 'advance' });
  assert.equal(merged.current.phase, 'recording');
  assert.equal(merged.pendingCommands.length, 2);

  let fail = false;
  const fragileBacking = memoryStorage();
  const fragile = {
    ...fragileBacking,
    setItem(key, value) {
      if (fail) throw new Error('quota');
      return fragileBacking.setItem(key, value);
    },
  };
  connected = true;
  const isolated = createEgeMockOralRunner({ ...options, storage: fragile });
  await isolated.dispatch({ type: 'restore', form });
  connected = false;
  fail = true;
  const before = isolated.snapshot();
  await assert.rejects(isolated.dispatch({ type: 'advance' }), { code: 'EGE_MOCK_LOCAL_STORAGE_FAILED' });
  assert.deepEqual(isolated.snapshot(), before, 'failed persistence cannot publish an optimistic cursor or queue');
});

test('owner invalidation during audio persistence cannot recreate a purged journal or WAV', async () => {
  const form = publicForm();
  const storage = memoryStorage();
  let ownerCurrent = true;
  let audioPresent = false;
  let removals = 0;
  let stageCalls = 0;
  const running = oralAttempt({
    state: 'oral_in_progress', revision: 5,
    oralStartedAt: '2026-08-15T06:00:00.000Z', oralDeadlineAt: '2026-08-15T06:17:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
      phase: 'recording', stageStartedAt: '2026-08-15T06:01:30.000Z',
      stageDeadlineAt: '2026-08-15T06:03:00.000Z', recordings: {},
    },
  });
  const runner = createEgeMockOralRunner({
    owner: OWNER, attemptId: ATTEMPT_ID, storage,
    now: () => Date.parse('2026-08-15T06:03:00.000Z'),
    media: {
      async preflight() {},
      async has() { return false; },
      async put() { audioPresent = true; ownerCurrent = false; },
      async remove() { audioPresent = false; removals += 1; },
    },
    authority: {
      async commit(commit) {
        if (!ownerCurrent) throw Object.assign(new Error('owner changed'), {
          code: 'EGE_MOCK_OWNER_AUTHORITY_CHANGED',
        });
        commit();
      },
    },
    transport: {
      async attempt() { return { attempt: running, serverTimeMs: Date.parse(running.oralStartedAt) }; },
      async stage() { stageCalls += 1; throw new Error('stale owner must not reach the server'); },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  const journalBefore = storage.getItem(`easyboost-ege-mock-oral-v1:${OWNER.username}:${OWNER.generation}`);
  await assert.rejects(runner.dispatch({
    type: 'completeResponse', blob: new Blob(['owner-bound-audio']), recording: {
      recordingId: crypto.randomUUID(), status: 'completed', durationSeconds: 30,
      sha256: 'a'.repeat(64),
    },
  }), { code: 'EGE_MOCK_OWNER_AUTHORITY_CHANGED' });
  assert.equal(stageCalls, 0);
  assert.equal(audioPresent, false);
  assert.equal(removals, 1);
  assert.equal(storage.getItem(`easyboost-ege-mock-oral-v1:${OWNER.username}:${OWNER.generation}`),
    journalBefore, 'the deleted incarnation cannot recreate or revise its local journal');
});
