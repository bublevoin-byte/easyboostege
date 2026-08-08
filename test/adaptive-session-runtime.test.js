import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/adaptive-session-runtime.js', import.meta.url), 'utf8');
const runtimeSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replaceAll('export ', '')}
window.__adaptiveRuntimeTest={adaptiveRuntimeSnapshot,clearAdaptiveRuntime,openAdaptivePlan,beginAdaptiveBlock,completeAdaptiveModuleActivity,completeAdaptiveServerAttempt,advanceAdaptiveBreak,finishAdaptiveSession,resumeAdaptiveExecution,adaptiveSessionReplacementAvailable:typeof adaptiveSessionReplacementAvailable==='function'?adaptiveSessionReplacementAvailable:null};`;

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

function runtimeHarness() {
  const values = new Map();
  const requests = [];
  const navigations = [];
  const listeners = new Map();
  const replays = new Map();
  const failAfterCommit = new Set();
  let startRecoveryAttempt = null;
  let online = true;
  let id = 0;
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  values.set('eb_current', 'adaptive-owner');
  const navigator = {};
  Object.defineProperty(navigator, 'onLine', { get: () => online });
  const api = {
    async post(path, body) {
      requests.push({ method: 'POST', path, body });
      if (!online) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 });
      if (path === '/api/v1/module-attempts') return { id: body.id, created: true };
      return { created: true };
    },
    async postIdempotent(path, body, key) {
      requests.push({ method: 'POST_IDEMPOTENT', path, body, key });
      if (!online) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 });
      const replayId = `${path}:${key}`;
      let result = replays.get(replayId);
      if (!result) {
        if (path.endsWith('/start')) {
          const startedBlock = body.blockId === WRITING_BLOCK.id
            ? WRITING_BLOCK : (body.blockId === READING_BLOCK.id ? READING_BLOCK : BLOCK);
          result = startRecoveryAttempt ? {
            block: startedBlock, launch: startedBlock.launch,
            evidenceContext: 'planned_practice', execution: { revision: 1 },
            recoveryAttempt: startRecoveryAttempt,
          } : {
            block: startedBlock, launch: startedBlock.launch,
            evidenceContext: startedBlock.module === 'writing' ? 'ai_assisted_review' : 'planned_practice',
            execution: { revision: 1 }, executionClaim: 'a'.repeat(43),
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
      return result;
    },
  };
  const window = {
    EasyBoostApi: api,
    dispatchEvent() {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  vm.runInNewContext(runtimeSource, {
    window, localStorage, navigator, console,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    nav: (screen) => navigations.push(screen),
    launchAdaptiveActivity: async () => true,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` },
    Date, JSON, Math, Number, String, Boolean, Object, Array, Promise, RegExp, Error,
  });
  return {
    runtime: window.__adaptiveRuntimeTest, requests, navigations, values,
    setOnline(value) { online = value; },
    setOwner(value) { if(value==null)values.delete('eb_current');else values.set('eb_current',value); },
    recoverStartWith(attempt) { startRecoveryAttempt = attempt; },
    failAfterCommitOnce(pathSuffix) { failAfterCommit.add(pathSuffix); },
  };
}

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
  assert.equal(JSON.stringify(advanceRequest.body.attempt), JSON.stringify({ type: 'module', id: attemptId }));
  assert.equal(result.execution.readyToFinish, true);
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(JSON.stringify(harness.navigations), JSON.stringify(['scr10']));
});

test('tampered local handoff is discarded before any request is sent', () => {
  const harness = runtimeHarness();
  harness.values.set('easyboost.adaptive.execution.v1', JSON.stringify({
    version: 3, owner: 'adaptive-owner', savedAt: Date.now(), active: {
      sessionId: '../../admin', blockId: 'wrong', executionClaim: 'secret', expectedRevision: -1,
    }, control: null, lastResult: null,
  }));
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  assert.equal(harness.requests.length, 0);
});

test('a superficially valid handoff with a cross-activity pending payload is discarded', () => {
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
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  assert.equal(await harness.runtime.resumeAdaptiveExecution(), false);
  assert.equal(harness.requests.length, requestCount);
});

test('clearing the runtime removes pending claims and the last result', async () => {
  const harness = runtimeHarness();
  await harness.runtime.beginAdaptiveBlock({ id: SESSION_ID }, BLOCK, { revision: 0 });
  harness.runtime.clearAdaptiveRuntime();
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
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
