import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/adaptive-session-runtime.js', import.meta.url), 'utf8');
const runtimeSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replaceAll('export ', '')}
window.__adaptiveRuntimeTest={adaptiveRuntimeSnapshot,clearAdaptiveRuntime,openAdaptivePlan,beginAdaptiveBlock,completeAdaptiveModuleActivity,completeAdaptiveServerAttempt,completeAdaptiveVoiceTutorRepeat,advanceAdaptiveBreak,finishAdaptiveSession,resumeAdaptiveExecution,adaptiveSessionReplacementAvailable:typeof adaptiveSessionReplacementAvailable==='function'?adaptiveSessionReplacementAvailable:null};`;

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const BLOCK = {
  id: 'asb_aaaaaaaaaaaaaaaa_01', kind: 'learning', module: 'grammar',
  activityId: 'grammar_forms_topic_3', contentRef: 'builtin:grammar:topic:3',
  reasonCodes: [], launch: { kind: 'grammar_practice' },
};
const WRITING_BLOCK = {
  ...BLOCK, id: 'asb_bbbbbbbbbbbbbbbb_01', module: 'writing', activityId: 'writing_37',
  contentRef: 'builtin:writing_37:emily-new-flat', launch: { kind: 'writing_task' },
};
const READING_BLOCK = {
  ...BLOCK, id: 'asb_cccccccccccccccc_01', module: 'reading', activityId: 'reading_gaps',
  contentRef: 'builtin:reading:task11:b1:v1',
  launch: { kind: 'reading_mode', mode: 'task11', cefr: 'B1' },
};
const VOICE_BLOCK = {
  ...BLOCK, id: 'asb_dddddddddddddddd_01', module: 'speaking', activityId: 'voice_tutor_recovery',
  contentRef: 'builtin:voice:tutor:recovery', launch: { kind: 'voice_tutor_recovery' },
};
const OWNER_RUNTIME_KEY = 'easyboost.adaptive.execution.v1:adaptive-owner:g0';

test('runtime bound transport globally invalidates only its captured owner authority', () => {
  assert.match(rawSource, /isAuthorityFailure/u);
  assert.match(rawSource, /EasyBoostAuthority/u);
  assert.match(rawSource, /owner:state\.owner,ownerGeneration:state\.ownerGeneration/u);
});

function createRuntimeLockManager() {
  const calls = [];
  const tails = new Map();
  return {
    calls,
    idle() { return Promise.all([...tails.values()]); },
    request(name, _options, callback) {
      calls.push(name);
      const prior = tails.get(name) || Promise.resolve();
      const current = prior.catch(() => {}).then(() => callback({ name }));
      tails.set(name, current.catch(() => {}));
      return current;
    },
  };
}

function runtimeHarness({ lockManager = createRuntimeLockManager() } = {}) {
  const values = new Map();
  const requests = [];
  const syncCalls = [];
  const navigations = [];
  const launches = [];
  const listeners = new Map();
  const replays = new Map();
  const failAfterCommit = new Set();
  const terminalFailures = new Map();
  const deferredRequests = [];
  let startRecoveryAttempt = null;
  let startClaimSequence = 0;
  let ownerGeneration = 0;
  let syncAttemptResult = true;
  let beforeRuntimeWrite = null;
  let online = true;
  let id = 0;
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === OWNER_RUNTIME_KEY && beforeRuntimeWrite) {
        const callback = beforeRuntimeWrite; beforeRuntimeWrite = null; callback();
      }
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
  values.set('eb_current', 'adaptive-owner');
  const navigator = { locks: lockManager };
  Object.defineProperty(navigator, 'onLine', { get: () => online });
  async function waitForDeferred(path) {
    const index = deferredRequests.findIndex((entry) => path.endsWith(entry.suffix));
    if (index < 0) return;
    const [entry] = deferredRequests.splice(index, 1);
    entry.started();
    await entry.wait;
  }
  const api = {
    responseOwner(result) { return result && result.owner; },
    async post(path, body, headers) {
      requests.push({ method: 'POST', path, body, headers });
      if (!online) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 });
      await waitForDeferred(path);
      const terminalFailure = [...terminalFailures].find(([suffix]) => path.endsWith(suffix));
      if (terminalFailure) {
        terminalFailures.delete(terminalFailure[0]);
        throw Object.assign(new Error(terminalFailure[1].code), terminalFailure[1]);
      }
      if (path === '/api/v1/module-attempts') return { owner: values.get('eb_current'), id: body.id, created: true };
      return { owner: values.get('eb_current'), created: true };
    },
    async postIdempotent(path, body, key, headers) {
      requests.push({ method: 'POST_IDEMPOTENT', path, body, key, headers });
      if (!online) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 });
      const replayId = `${path}:${key}`;
      let result = replays.get(replayId);
      if (!result) {
        if (path.endsWith('/start')) {
          const startedBlock = body.blockId === WRITING_BLOCK.id
            ? WRITING_BLOCK : (body.blockId === READING_BLOCK.id
              ? READING_BLOCK : (body.blockId === VOICE_BLOCK.id ? VOICE_BLOCK : BLOCK));
          const claimCharacter = String.fromCharCode(97 + startClaimSequence % 20);
          startClaimSequence += 1;
          result = startRecoveryAttempt ? {
            block: startedBlock, launch: startedBlock.launch,
            evidenceContext: 'planned_practice', execution: { revision: 1 },
            recoveryAttempt: startRecoveryAttempt,
          } : {
            block: startedBlock, launch: startedBlock.launch,
            evidenceContext: startedBlock.module === 'writing' ? 'ai_assisted_review' : 'planned_practice',
            execution: { revision: 1 }, executionClaim: claimCharacter.repeat(43),
            claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        } else if (path.endsWith('/finish')) result = {
          session: { id: SESSION_ID, status: 'completed' },
          execution: { revision: 3, readyToFinish: true },
          summary: {
            plannedMinutes: 30, actualMinutes: 28,
            completedWork: [{ module: 'grammar', minutes: 18, evidenceContext: 'planned_practice' }],
            evidenceByQuality: { client_reported: 1 },
            evidenceByContext: { planned_practice: 1 },
            planChange: { revisionBefore: 1, revisionAfter: 2, changed: true },
            nextAction: { type: 'review_plan' },
          },
          nextAction: { type: 'review_plan' },
        };
        else result = {
          session: { id: SESSION_ID, status: 'in_progress' },
          execution: { revision: 2, readyToFinish: true },
          completedBlock: { blockId: BLOCK.id, evidenceQuality: 'client_reported' },
          profileChange: { evidenceSourceCountBefore: 0, evidenceSourceCountAfter: 1 },
          planChange: { reasonCode: 'learning_block_completed' },
          nextAction: { type: 'finish_session' },
        };
        replays.set(replayId, result);
      }
      const matchingFailure = [...failAfterCommit].find((suffix) => path.endsWith(suffix));
      if (matchingFailure) {
        failAfterCommit.delete(matchingFailure);
        throw Object.assign(new Error('response lost'), { code: 'NETWORK_ERROR', status: 0 });
      }
      await waitForDeferred(path);
      return { owner: values.get('eb_current'), ...result };
    },
  };
  const window = {
    EasyBoostApi: api,
    EasyBoostOwnerIncarnation: {
      clearMatchingStorage(owner, key, matcher) {
        return lockManager.request(`easyboost-owner-incarnation:${owner}`, { mode: 'exclusive' }, () => {
          const raw = localStorage.getItem(key); if (!raw) return true;
          if (matcher(raw) !== true) return false; localStorage.removeItem(key); return true;
        });
      },
    },
    EasyBoostSync: {
      ownerBoundGeneration(owner) { return owner === values.get('eb_current') ? ownerGeneration : null; },
      ownerAuthSnapshot(owner) { return { ownerGeneration, deleted: owner !== values.get('eb_current') }; },
      async withOwnerIncarnationLock(guard, action) {
        return lockManager.request(`easyboost-owner-incarnation:${guard.owner}`, { mode: 'exclusive' },
          () => action(Symbol('owner-incarnation-lock')));
      },
      async saveModuleAttempt(payload, guard) {
        syncCalls.push({ payload, guard });
        if (!online) return false;
        requests.push({ method: 'SYNC_ATTEMPT', path: '/api/v1/module-attempts', body: { ...payload, owner: guard.owner } });
        return syncAttemptResult;
      },
    },
    dispatchEvent() {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  vm.runInNewContext(runtimeSource, {
    window, localStorage, navigator, console,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    nav: (screen) => navigations.push(screen),
    launchAdaptiveActivity: async (descriptor, _contentRef, authorityCurrent) => {
      if (authorityCurrent && authorityCurrent() !== true) return false;
      launches.push(descriptor); return true;
    },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` },
    Date, JSON, Math, Number, String, Boolean, Object, Array, Promise, RegExp, Error,
  });
  return {
    runtime: window.__adaptiveRuntimeTest, requests, syncCalls, navigations, launches, values, lockManager,
    setOnline(value) { online = value; },
    setOwner(value) { if(value==null)values.delete('eb_current');else values.set('eb_current',value); },
    setOwnerGeneration(value) { ownerGeneration = value; },
    setSyncAttemptResult(value) { syncAttemptResult = value; },
    deferOnce(pathSuffix) {
      let started;
      let release;
      const startedPromise = new Promise((resolve) => { started = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      deferredRequests.push({ suffix: pathSuffix, started, wait });
      return { started: startedPromise, release };
    },
    recoverStartWith(attempt) { startRecoveryAttempt = attempt; },
    failAfterCommitOnce(pathSuffix) { failAfterCommit.add(pathSuffix); },
    rejectPostOnce(pathSuffix, error) { terminalFailures.set(pathSuffix, error); },
    beforeRuntimeWriteOnce(callback) { beforeRuntimeWrite = callback; },
    drainLocks() { return lockManager.idle(); },
  };
}

test('every adaptive operation is serialized by the owner runtime lock and launch receives an authority guard', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  assert.deepEqual(harness.lockManager.calls, [
    'easyboost-owner-incarnation:adaptive-owner',
    'easyboost-adaptive-runtime:adaptive-owner:0',
  ]);
  assert.match(rawSource, /locks\.request\('easyboost-adaptive-runtime:'/u);
  assert.match(rawSource, /launchAdaptiveActivity\([^;]+runtimeAuthorityCurrent/u);
});

test('every adaptive runtime request sends and verifies the exact owner contract', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  await harness.runtime.completeAdaptiveModuleActivity({
    module: 'grammar', activityId: 'grammar_forms_topic_3', score: 5, maxScore: 5,
  });
  const runtimeRequests = harness.requests.filter((item) => item.method !== 'SYNC_ATTEMPT');
  assert.ok(runtimeRequests.length >= 2);
  for (const request of runtimeRequests) {
    assert.equal(request.headers?.['X-EasyBoost-Expected-Owner'], 'adaptive-owner');
  }
  assert.match(rawSource, /api\(\)\.responseOwner\(result\)!==state\.owner/u);
});

test('generation-zero runtime storage is partitioned by owner and the singleton is migration-only', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  assert.equal(harness.values.has(OWNER_RUNTIME_KEY), true);
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  harness.setOwner('second-owner');
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1:second-owner:g0'), true);
  assert.equal(harness.values.has(OWNER_RUNTIME_KEY), true);
});

test('a runtime created while its first request is pending keeps later writes under the same atomic lock', async () => {
  const harness = runtimeHarness();
  const deferred = harness.deferOnce('/start');
  const first = harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  await deferred.started;
  const second = harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.requests.filter((item) => item.path.endsWith('/start')).length, 1,
    'the second tab must wait even after the first tab creates a runtimeId');
  assert.deepEqual(harness.lockManager.calls, [
    'easyboost-owner-incarnation:adaptive-owner',
    'easyboost-adaptive-runtime:adaptive-owner:0',
    'easyboost-owner-incarnation:adaptive-owner',
  ]);

  deferred.release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(harness.requests.filter((item) => item.path.endsWith('/start')).length, 1);
  assert.equal(harness.lockManager.calls.at(-1), 'easyboost-adaptive-runtime:adaptive-owner:0');
});

test('a deletion between adaptive CAS and localStorage commit cannot resurrect the old envelope', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  harness.setOnline(false);
  harness.beforeRuntimeWriteOnce(() => {
    harness.setOwnerGeneration(1);
    harness.values.delete(OWNER_RUNTIME_KEY);
  });

  await assert.rejects(
    harness.runtime.completeAdaptiveModuleActivity({
      module: 'grammar', activityId: 'grammar_forms_topic_3', score: 4, maxScore: 5,
    }),
    (error) => error?.code === 'OWNER_CHANGED',
  );
  assert.equal(harness.values.has(OWNER_RUNTIME_KEY), false);
});

test('old-incarnation cleanup cannot remove a newer adaptive runtime envelope', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  const current = JSON.parse(harness.values.get(OWNER_RUNTIME_KEY));
  const revived = { ...current, ownerGeneration: 1, revision: current.revision + 1 };
  const revivedKey = 'easyboost.adaptive.execution.v1:adaptive-owner:g1';
  harness.values.set(revivedKey, JSON.stringify(revived));
  assert.equal(await harness.runtime.clearAdaptiveRuntime({ owner: 'adaptive-owner', ownerGeneration: 0 }), true);
  assert.deepEqual(JSON.parse(harness.values.get(revivedKey)), revived);
  assert.equal(await harness.runtime.clearAdaptiveRuntime({
    owner: 'adaptive-owner', ownerGeneration: 1, runtimeId: revived.runtimeId, revision: revived.revision,
  }), true);
  assert.equal(harness.values.has(revivedKey), false);
});

test('legacy runtime cleanup treats missing generation as zero and snapshot migration never writes unlocked', async () => {
  const harness = runtimeHarness();
  const legacy = {
    version: 3, owner: 'adaptive-owner', savedAt: Date.now(),
    active: null, control: null, lastResult: null,
  };
  const raw = JSON.stringify(legacy);
  harness.values.set('easyboost.adaptive.execution.v1', raw);
  const snapshot = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(snapshot.ownerGeneration, 0);
  assert.equal(harness.values.get('easyboost.adaptive.execution.v1'), raw,
    'v3 is projected in memory and migrates only later inside the owner/runtime lock');
  assert.equal(await harness.runtime.clearAdaptiveRuntime({ owner: 'adaptive-owner', ownerGeneration: 0 }), true);
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
});

test('offline completion stays pending and is never displayed as a completed adaptive block', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  assert.equal(await harness.runtime.completeAdaptiveModuleActivity({
    module: 'reading', activityId: 'reading_headings', score: 4, maxScore: 5,
  }), false, 'a completion hook from another screen cannot consume the active claim');
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active.pending, null);
  harness.setOnline(false);
  const queued = await harness.runtime.completeAdaptiveModuleActivity({
    module: 'grammar', activityId: 'grammar_forms_topic_3', score: 9, maxScore: 5,
    metadata: { mode: 'topic_practice', source: 'builtin', helpUsed: true, hintsUsed: 2 },
  });
  assert.equal(queued.queued, true);
  const pending = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(pending.active.pending.phase, 'attempt');
  assert.equal(pending.active.pending.payload.score, 5, 'client score is clamped to maxScore');
  assert.deepEqual(pending.active.pending.payload.metadata, {
    mode: 'topic_practice', source: 'builtin', helpUsed: true, hintsUsed: 2,
  });
  assert.equal(pending.lastResult, null, 'offline work must not look server-completed');
  assert.equal(harness.navigations.length, 0, 'the learner stays in the activity until confirmation');
  assert.equal(harness.requests.filter((item) => item.path === '/api/v1/module-attempts').length, 0);
});

test('Reading completion persists only when its canonical content reference matches the active launch', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, READING_BLOCK, { revision: 0 });
  const metadata = {
    mode: 'reading_gaps', source: 'catalog', helpUsed: false, hintsUsed: 0,
    readingProvenance: 'canonical', readingSetId: 'reading-pilot-v1.task11.future-01',
    readingSetRevision: 1, readingKind: 'task11', readingCefr: 'B1',
    readingContentRef: READING_BLOCK.contentRef,
    readingAttemptId: 'reading-training-01', readingSlice: 'detail',
  };
  assert.equal(await harness.runtime.completeAdaptiveModuleActivity({
    module: 'reading', activityId: 'reading_gaps', score: 6, maxScore: 6,
    metadata: { ...metadata, readingContentRef: 'builtin:reading:task11:b2:v1' },
  }), false);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active.pending, null);

  await harness.runtime.completeAdaptiveModuleActivity({
    module: 'reading', activityId: 'reading_gaps', score: 6, maxScore: 6,
    durationMs: 10_000, metadata,
  });
  const request = harness.requests.find((item) => item.path === '/api/v1/module-attempts');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body.metadata)), metadata);
});

test('the exact queued attempt flushes before advance and returns to the plan only after confirmation', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  harness.setOnline(false);
  await harness.runtime.completeAdaptiveModuleActivity({ module: 'grammar', activityId: 'grammar_forms_topic_3', score: 4, maxScore: 5 });
  const attemptId = harness.runtime.adaptiveRuntimeSnapshot().active.pending.payload.id;
  harness.setOnline(true);
  const result = await harness.runtime.resumeAdaptiveExecution();
  const attemptRequest = harness.requests.find((item) => item.path === '/api/v1/module-attempts');
  const advanceRequest = harness.requests.find((item) => item.path.endsWith('/advance'));
  assert.equal(attemptRequest.body.id, attemptId);
  assert.equal(attemptRequest.method, 'SYNC_ATTEMPT', 'adaptive evidence uses the incarnation-bound durable sync seam');
  assert.equal(attemptRequest.body.owner, 'adaptive-owner');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.syncCalls[0].guard)), { owner: 'adaptive-owner', ownerGeneration: 0 });
  assert.equal(JSON.stringify(advanceRequest.body.attempt), JSON.stringify({ type: 'module', id: attemptId }));
  assert.equal(result.execution.readyToFinish, true);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(JSON.stringify(harness.navigations), JSON.stringify(['scr10']));
});

test('a recreated same-name owner cannot resume an adaptive claim from an older incarnation', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  harness.setOnline(false);
  await harness.runtime.completeAdaptiveModuleActivity({
    module: 'grammar', activityId: 'grammar_forms_topic_3', score: 4, maxScore: 5,
  });
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active.pending.phase, 'attempt');

  harness.setOwnerGeneration(1);

  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  await harness.drainLocks();
  assert.equal(harness.values.has(OWNER_RUNTIME_KEY), true,
    'the old generation partition is inaccessible and is removed by the serialized deletion purge');
});

test('a stale start response cannot overwrite or launch a recreated same-name runtime', async () => {
  const harness = runtimeHarness();
  const deferred = harness.deferOnce('/start');
  const staleStart = harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  const staleOutcome = staleStart.then((value) => value, (error) => error);
  await deferred.started;

  harness.setOwnerGeneration(1);
  const freshStart = harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  deferred.release();
  const staleError = await staleOutcome;
  assert.equal(staleError.code, 'OWNER_CHANGED');
  await freshStart;
  const fresh = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(fresh.ownerGeneration, 1);
  assert.equal(fresh.active.executionClaim, 'b'.repeat(43));
  assert.equal(harness.launches.length, 1);

  const preserved = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(preserved.ownerGeneration, 1);
  assert.equal(preserved.active.executionClaim, 'b'.repeat(43));
  assert.equal(harness.launches.length, 1, 'the stale launch is never opened');
});

test('a stale advance response cannot publish or clear a newer incarnation result', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  const deferred = harness.deferOnce('/advance');
  const staleCompletion = harness.runtime.completeAdaptiveModuleActivity({
    module: 'grammar', activityId: 'grammar_forms_topic_3', score: 4, maxScore: 5,
  });
  const staleOutcome = staleCompletion.then((value) => value, (error) => error);
  await deferred.started;

  harness.setOwnerGeneration(1);
  const freshStart = harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  deferred.release();
  const staleError = await staleOutcome;
  assert.equal(staleError.code, 'OWNER_CHANGED');
  await freshStart;
  const fresh = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(fresh.ownerGeneration, 1);
  assert.equal(fresh.active.executionClaim, 'b'.repeat(43));

  const preserved = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(preserved.ownerGeneration, 1);
  assert.equal(preserved.active.executionClaim, 'b'.repeat(43));
  assert.equal(preserved.lastResult, null);
  assert.equal(harness.navigations.length, 0, 'a stale completion cannot navigate the new owner');
});

test('a terminal adaptive attempt rejection is surfaced once and clears the unrecoverable claim', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  harness.setSyncAttemptResult({ status: 'terminal_rejected', code: 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' });

  await assert.rejects(
    harness.runtime.completeAdaptiveModuleActivity({
      module: 'grammar', activityId: 'grammar_forms_topic_3', score: 4, maxScore: 5,
    }),
    (error) => error?.code === 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED',
  );
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(harness.syncCalls.length, 1);
  assert.equal(await harness.runtime.resumeAdaptiveExecution(), false);
  assert.equal(harness.syncCalls.length, 1, 'terminal evidence is not requeued forever');
});

test('an expired initial Voice Tutor repeat claim is cleared once instead of retrying forever', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, VOICE_BLOCK, { revision: 0 });
  harness.rejectPostOnce('/attempts', { code: 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED', status: 410 });
  const payload = {
    repeatId: '20000000-0000-4000-8000-000000000001',
    taskId: 'voice-repeat-task-1', answer: 'was built',
    attemptId: '30000000-0000-4000-8000-000000000001',
  };

  await assert.rejects(
    harness.runtime.completeAdaptiveVoiceTutorRepeat(payload),
    (error) => error?.code === 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED',
  );
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(await harness.runtime.completeAdaptiveVoiceTutorRepeat(payload), false);
  assert.equal(harness.requests.filter((item) => item.path.endsWith('/attempts')).length, 1);
});

test('tampered local handoff is discarded before any request is sent', async () => {
  const harness = runtimeHarness();
  harness.values.set('easyboost.adaptive.execution.v1', JSON.stringify({
    version: 3, owner: 'adaptive-owner', savedAt: Date.now(), active: {
      sessionId: '../../admin', blockId: 'wrong', executionClaim: 'secret', expectedRevision: -1,
    }, control: null, lastResult: null,
  }));
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  await harness.drainLocks();
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  assert.equal(harness.requests.length, 0);
});

test('a superficially valid handoff with a cross-activity pending payload is discarded', async () => {
  const harness = runtimeHarness();
  const savedAt = Date.now();
  harness.values.set('easyboost.adaptive.execution.v1', JSON.stringify({
    version: 3, owner: 'adaptive-owner', savedAt, active: {
      sessionId: SESSION_ID,
      blockId: 'asb_aaaaaaaaaaaaaaaa_01', executionClaim: 'a'.repeat(43),
      module: 'grammar', activityId: 'grammar_forms_topic_3',
      contentRef: 'builtin:grammar:topic:3', expectedRevision: 1,
      startedAt: savedAt - 1_000, claimExpiresAt: savedAt + 60_000,
      evidenceContext: 'planned_practice',
      pending: {
        phase: 'attempt', advanceKey: '10000000-0000-4000-8000-000000000002',
        payload: {
          id: '10000000-0000-4000-8000-000000000003', module: 'reading',
          activity: 'reading_headings', score: 1, maxScore: 1, durationMs: 1_000,
          adaptiveExecutionClaim: 'a'.repeat(43),
        },
      },
    }, control: null, lastResult: null,
  }));
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  await harness.drainLocks();
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  assert.equal(harness.requests.length, 0);
});

test('a valid older queued module attempt without assisted metadata still resumes', async () => {
  const harness = runtimeHarness();
  const savedAt = Date.now();
  const attemptId = '10000000-0000-4000-8000-000000000033';
  harness.values.set('easyboost.adaptive.execution.v1', JSON.stringify({
    version: 3, owner: 'adaptive-owner', savedAt, active: {
      sessionId: SESSION_ID,
      blockId: BLOCK.id,
      executionClaim: 'a'.repeat(43),
      module: BLOCK.module,
      activityId: BLOCK.activityId,
      contentRef: BLOCK.contentRef,
      expectedRevision: 1,
      startedAt: savedAt - 1_000,
      claimExpiresAt: savedAt + 60_000,
      evidenceContext: 'planned_practice',
      pending: {
        phase: 'attempt', advanceKey: '10000000-0000-4000-8000-000000000034',
        payload: {
          id: attemptId, module: BLOCK.module, activity: BLOCK.activityId,
          score: 4, maxScore: 5, durationMs: 1_000,
          adaptiveExecutionClaim: 'a'.repeat(43),
        },
      },
    }, control: null, lastResult: null,
  }));

  await harness.runtime.resumeAdaptiveExecution();
  const attemptRequest = harness.requests.find((item) => item.path === '/api/v1/module-attempts');
  assert.equal(attemptRequest.body.id, attemptId);
  assert.equal(Object.hasOwn(attemptRequest.body, 'metadata'), false);
});

test('a lost start response is replayed with the exact idempotency key and body', async () => {
  const harness = runtimeHarness();
  harness.failAfterCommitOnce('/start');
  await assert.rejects(
    harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 }),
    /response lost/u,
  );
  const pending = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(pending.control.phase, 'start');
  assert.equal(pending.active, null);

  await harness.runtime.resumeAdaptiveExecution();
  const starts = harness.requests.filter((item) => item.path.endsWith('/start'));
  assert.equal(starts.length, 2);
  assert.equal(starts[0].key, starts[1].key);
  assert.deepEqual(starts[0].body, starts[1].body);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().control, null);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active.blockId, BLOCK.id);
  assert.equal(harness.navigations.length, 0);
});

test('a consumed attempt is recovered by an exact durable advance without issuing a second claim', async () => {
  const harness = runtimeHarness();
  const attempt = { type: 'module', id: '10000000-0000-4000-8000-000000000099' };
  harness.recoverStartWith(attempt);
  harness.failAfterCommitOnce('/advance');
  await assert.rejects(
    harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 1 }),
    /response lost/u,
  );
  const pending = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(pending.active, null);
  assert.equal(pending.control.phase, 'recovery');
  assert.deepEqual(pending.control.attempt, attempt);

  await harness.runtime.resumeAdaptiveExecution();
  const starts = harness.requests.filter((item) => item.path.endsWith('/start'));
  const advances = harness.requests.filter((item) => item.path.endsWith('/advance'));
  assert.equal(starts.length, 1);
  assert.equal(advances.length, 2);
  assert.equal(advances[0].key, advances[1].key);
  assert.deepEqual(advances[0].body, advances[1].body);
  assert.deepEqual(advances[0].body.attempt, attempt);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().control, null);
  assert.deepEqual(harness.navigations, ['scr10']);
});

test('a lost break response is replayed exactly and returns only after confirmation', async () => {
  const harness = runtimeHarness();
  harness.failAfterCommitOnce('/advance');
  await assert.rejects(
    harness.runtime.advanceAdaptiveBreak({ id: SESSION_ID }, BLOCK, { revision: 1 }),
    /response lost/u,
  );
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().control.phase, 'break');
  assert.equal(harness.navigations.length, 0);

  await harness.runtime.resumeAdaptiveExecution();
  const advances = harness.requests.filter((item) => item.path.endsWith('/advance'));
  assert.equal(advances.length, 2);
  assert.equal(advances[0].key, advances[1].key);
  assert.deepEqual(advances[0].body, advances[1].body);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().control, null);
  assert.deepEqual(harness.navigations, ['scr10']);
});

test('a lost finish response replays exactly and preserves the durable summary', async () => {
  const harness = runtimeHarness();
  harness.failAfterCommitOnce('/finish');
  await assert.rejects(
    harness.runtime.finishAdaptiveSession({ id: SESSION_ID }, { revision: 2 }),
    /response lost/u,
  );
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().control.phase, 'finish');
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().lastResult, null);

  await harness.runtime.resumeAdaptiveExecution();
  const finishes = harness.requests.filter((item) => item.path.endsWith('/finish'));
  assert.equal(finishes.length, 2);
  assert.equal(finishes[0].key, finishes[1].key);
  assert.deepEqual(finishes[0].body, finishes[1].body);
  const completed = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(completed.control, null);
  assert.equal(completed.lastResult.summary.actualMinutes, 28);
  assert.deepEqual(harness.navigations, ['scr10']);
});

test('runtime is owner-bound and cannot resume or render after an account switch', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().owner, 'adaptive-owner');
  const requestCount = harness.requests.length;
  harness.setOwner('different-owner');
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(harness.values.has(OWNER_RUNTIME_KEY), true,
    'switching owners cannot destroy another owner\'s shared runtime envelope');
  assert.equal(await harness.runtime.resumeAdaptiveExecution(), false);
  assert.equal(harness.requests.length, requestCount);
});

test('clearing the runtime removes pending claims and the last result', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  await harness.runtime.clearAdaptiveRuntime();
  assert.equal(harness.values.has(OWNER_RUNTIME_KEY), false);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
});

test('confirmed writing evidence keeps the paid review open until the learner returns explicitly', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, WRITING_BLOCK, { revision: 0 });
  const result = await harness.runtime.completeAdaptiveServerAttempt('writing', 41);
  assert.equal(result.execution.readyToFinish, true);
  assert.deepEqual(harness.navigations, []);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  harness.runtime.openAdaptivePlan();
  assert.deepEqual(harness.navigations, ['scr10']);
});

test('replacement controls close for local pending, claimed, started, or completed execution', () => {
  const harness = runtimeHarness();
  const available = harness.runtime.adaptiveSessionReplacementAvailable;
  assert.equal(typeof available, 'function');
  const session = { id: SESSION_ID, status: 'created', replacement: null };
  const execution = {
    status: 'created', revision: 0, startedAt: null, completedBlockIds: [],
  };
  assert.equal(available(session, execution, { active: null, control: null }), true);
  assert.equal(available(session, execution, {
    active: null, control: { phase: 'start', sessionId: SESSION_ID },
  }), false);
  assert.equal(available(session, execution, {
    active: { sessionId: SESSION_ID }, control: null,
  }), false);
  assert.equal(available(session, { ...execution, status: 'in_progress' }, { active: null, control: null }), false);
  assert.equal(available(session, { ...execution, revision: 1 }, { active: null, control: null }), false);
  assert.equal(available(session, { ...execution, startedAt: '2026-08-08T10:00:00.000Z' }, { active: null, control: null }), false);
  assert.equal(available(session, { ...execution, completedBlockIds: [BLOCK.id] }, { active: null, control: null }), false);
});
