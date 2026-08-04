import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/adaptive-session-runtime.js', import.meta.url), 'utf8');
const runtimeSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replaceAll('export ', '')}
window.__adaptiveRuntimeTest={adaptiveRuntimeSnapshot,beginAdaptiveBlock,completeAdaptiveModuleActivity,completeAdaptiveServerAttempt,resumeAdaptiveExecution};`;

function runtimeHarness() {
  const values = new Map();
  const requests = [];
  const navigations = [];
  const listeners = new Map();
  let online = true;
  let id = 0;
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
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
      if (path.endsWith('/start')) return {
        execution: { revision: 1 }, executionClaim: 'a'.repeat(43),
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      return {
        session: { id: '10000000-0000-4000-8000-000000000001', status: 'in_progress' },
        execution: { revision: 2, readyToFinish: true },
        completedBlock: { blockId: 'asb_aaaaaaaaaaaaaaaa_01', evidenceQuality: 'client_reported' },
        profileChange: { evidenceSourceCountBefore: 0, evidenceSourceCountAfter: 1 },
        planChange: { reasonCode: 'learning_block_completed' },
        nextAction: { type: 'finish_session' },
      };
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
  };
}

test('offline completion stays pending and is never displayed as a completed adaptive block', async () => {
  const harness = runtimeHarness();
  const session = { id: '10000000-0000-4000-8000-000000000001' };
  const block = {
    id: 'asb_aaaaaaaaaaaaaaaa_01', kind: 'learning', module: 'grammar',
    activityId: 'grammar_forms_topic_3', contentRef: 'builtin:grammar:topic:3',
    launch: { kind: 'grammar_practice' },
  };
  await harness.runtime.beginAdaptiveBlock(session, block, { revision: 0 });
  assert.equal(await harness.runtime.completeAdaptiveModuleActivity({
    module: 'reading', activityId: 'reading_headings', score: 4, maxScore: 5,
  }), false, 'a completion hook from another screen cannot consume the active claim');
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active.pending, null);
  harness.setOnline(false);
  const queued = await harness.runtime.completeAdaptiveModuleActivity({ module: 'grammar', activityId: 'grammar_forms_topic_3', score: 9, maxScore: 5 });
  assert.equal(queued.queued, true);
  const pending = harness.runtime.adaptiveRuntimeSnapshot();
  assert.equal(pending.active.pending.phase, 'attempt');
  assert.equal(pending.active.pending.payload.score, 5, 'client score is clamped to maxScore');
  assert.equal(pending.lastResult, null, 'offline work must not look server-completed');
  assert.equal(harness.navigations.length, 0, 'the learner stays in the activity until confirmation');
  assert.equal(harness.requests.filter((item) => item.path === '/api/v1/module-attempts').length, 0);
});

test('the exact queued attempt flushes before advance and returns to the plan only after confirmation', async () => {
  const harness = runtimeHarness();
  const session = { id: '10000000-0000-4000-8000-000000000001' };
  const block = {
    id: 'asb_aaaaaaaaaaaaaaaa_01', kind: 'learning', module: 'grammar',
    activityId: 'grammar_forms_topic_3', contentRef: 'builtin:grammar:topic:3',
    launch: { kind: 'grammar_practice' },
  };
  await harness.runtime.beginAdaptiveBlock(session, block, { revision: 0 });
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
    version: 1, savedAt: Date.now(), active: {
      sessionId: '../../admin', blockId: 'wrong', executionClaim: 'secret', expectedRevision: -1,
    },
  }));
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  assert.equal(harness.requests.length, 0);
});

test('a superficially valid handoff with a cross-activity pending payload is discarded', () => {
  const harness = runtimeHarness();
  const savedAt = Date.now();
  harness.values.set('easyboost.adaptive.execution.v1', JSON.stringify({
    version: 1, savedAt, active: {
      sessionId: '10000000-0000-4000-8000-000000000001',
      blockId: 'asb_aaaaaaaaaaaaaaaa_01', executionClaim: 'a'.repeat(43),
      module: 'grammar', activityId: 'grammar_forms_topic_3',
      contentRef: 'builtin:grammar:topic:3', expectedRevision: 1,
      startedAt: savedAt - 1_000, claimExpiresAt: savedAt + 60_000,
      pending: {
        phase: 'attempt', advanceKey: '10000000-0000-4000-8000-000000000002',
        payload: {
          id: '10000000-0000-4000-8000-000000000003', module: 'reading',
          activity: 'reading_headings', score: 1, maxScore: 1, durationMs: 1_000,
          adaptiveExecutionClaim: 'a'.repeat(43),
        },
      },
    }, lastResult: null,
  }));
  assert.equal(harness.runtime.adaptiveRuntimeSnapshot().active, null);
  assert.equal(harness.values.has('easyboost.adaptive.execution.v1'), false);
  assert.equal(harness.requests.length, 0);
});
