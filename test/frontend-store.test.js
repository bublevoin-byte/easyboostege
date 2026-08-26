import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/store.js', import.meta.url), 'utf8');
const ownerIncarnationSource = await fs.readFile(new URL('../public/owner-incarnation.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const startLearningSource = appSource.match(
  /async function startLearningWithVerifiedSession\(session,\{signal=null\}=\{\}\)\{[\s\S]*?\n\}\nasync function startLearningWithDeadline/u,
)[0].replace(/\nasync function startLearningWithDeadline$/u, '');
const applyDeletedOwnerSource = appSource.match(
  /function applyDeletedOwner\(update\)\{[\s\S]*?\n\}/u,
)[0];
const invalidateLearningAuthoritySource = appSource.match(
  /async function invalidateLearningAuthority\(authority\)\{[\s\S]*?\n\}/u,
)[0];
const clearNoSessionAuthoritySource = appSource.match(
  /async function clearNoSessionAuthority\(authGuard\)\{[\s\S]*?\n\}/u,
)[0];
const checkLearningAccessSource = appSource.match(
  /async function checkLearningAccess\(session=null,[\s\S]*?\n\}/u,
)[0];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createStartLearningHarness({
  deferTaskBank = false,
  deferProgress = false,
  progressError = null,
  progressResponseOwner = 'grammar-owner',
  localWorkflow = {},
  restoredState = { learned: 1 },
} = {}) {
  const taskBank = deferred();
  const progress = deferred();
  const calls = [];
  let progressRequest = null;
  let restoredPayload = null;
  let savedState = null;
  const localReads = [];
  const deleted = new Set();
  const context = vm.createContext({
    currentUser: 'grammar-owner',
    TOKEN: 'cookie',
    S: null,
    AUTH_SESSION_GENERATION: 0,
    SRV: true,
    LEARNING_ACCESS_STATES: { ACTIVE: 'active' },
    normalizedAuthOwner(value) { return String(value || '').trim() || null; },
    ADOPTED_OWNER_GENERATION: 0,
    classifyLearningAccess() { return { state: 'active' }; },
    applyLearningAccess() {},
    currentOwnerAuthorityCurrent() { return true; },
    adoptServerSession(session) {
      context.AUTH_SESSION_GENERATION += 1;
      context.currentUser = session.username;
      context.TOKEN = 'cookie';
    },
    loadTaskBank() { calls.push('task-bank'); return deferTaskBank ? taskBank.promise : Promise.resolve(); },
    apiGet(pathname, options) {
      calls.push('progress'); progressRequest = { pathname, options };
      if (progressError) return Promise.reject(progressError);
      return deferProgress ? progress.promise : Promise.resolve({ owner: { custom: 'kept' }, learned: 1 });
    },
    apiResponseOwner() { return progressResponseOwner; },
    apiIsAuthorityFailure(error) {
      return String(error && error.code || '') === 'OWNER_CHANGED' || [401, 403].includes(Number(error && error.status));
    },
    apiCanUseOfflineFallback(error) {
      const status = Number(error && error.status) || 0;
      const code = String(error && error.code || '');
      return !['OWNER_CHANGED'].includes(String(error && error.code || ''))
        && ![401, 403].includes(status) && (['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TIMEOUT'].includes(code) || status >= 500);
    },
    async invalidateLearningAuthority(authority) { calls.push(`invalidate:${authority.owner}:${authority.ownerGeneration}`); return true; },
    store: {
      sync: {
        isOwnerDeleted(owner) { return deleted.has(owner); },
        setOwner(owner) { calls.push(`owner:${owner}`); },
        pendingModules() { return {}; },
        setBaseline() { calls.push('baseline'); },
      },
      loadLocal(owner, ownerGeneration) {
        calls.push('load-local'); localReads.push({ owner, ownerGeneration }); return structuredClone(localWorkflow);
      },
      restore(_owner, serverState) {
        calls.push('restore'); restoredPayload = serverState; return structuredClone(restoredState);
      },
      saveLocal(_owner, state) { calls.push('save'); savedState = structuredClone(state); return true; },
    },
    tab(screen) { calls.push(`tab:${screen}`); },
    START_HOOKS: [async () => { calls.push('hook'); }],
    toast() {},
    Promise,
  });
  vm.runInContext(`${startLearningSource}\nthis.startLearningWithVerifiedSession=startLearningWithVerifiedSession;`, context);
  return {
    calls,
    start: (session = { authenticated: true, username: 'grammar-owner' }, options) => context.startLearningWithVerifiedSession(session, options),
    resolveTaskBank: (value) => taskBank.resolve(value),
    resolveProgress: (value) => progress.resolve(value),
    progressRequest: () => progressRequest,
    restoredPayload: () => restoredPayload,
    localReads: () => localReads,
    savedState: () => savedState,
    deleteOwner({ recreate = false } = {}) {
      context.AUTH_SESSION_GENERATION += 1;
      context.TOKEN = '';
      context.currentUser = null;
      context.S = null;
      deleted.add('grammar-owner');
      if (recreate) {
        context.AUTH_SESSION_GENERATION += 1;
        context.TOKEN = 'cookie';
        context.currentUser = 'grammar-owner';
        deleted.delete('grammar-owner');
      }
    },
  };
}

function createStore(initial = {}, syncOverrides = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const sync = Object.freeze({ saveProgress() {}, setBaseline() {}, isOwnerDeleted() { return false; }, ...syncOverrides });
  const navigator = { locks: { request(_name, _options, callback) { return Promise.resolve(callback({})); } } };
  const window = { localStorage, navigator, EasyBoostSync: sync };
  const context = vm.createContext({ window, navigator, Date, JSON, Object, Number, String, Boolean, Set, Map, Symbol, Promise });
  vm.runInContext(ownerIncarnationSource, context);
  vm.runInContext(source, context);
  return { store: window.EasyBoostStore, values, sync };
}

test('a deleted owner tombstone blocks snapshot restore and recreation', () => {
  const { store, values } = createStore({ eb_data_deleted: JSON.stringify({ learned: 99 }) }, {
    isOwnerDeleted(username) { return username === 'deleted'; },
  });
  assert.equal(store.saveLocal('deleted', { learned: 100 }), false);
  assert.equal(store.loadLocal('deleted').learned, 0);
  assert.equal(store.restore('deleted', { learned: 100 }, {}).learned, 0);
  assert.equal(values.get('eb_data_deleted'), JSON.stringify({ learned: 99 }),
    'the guarded store never rewrites a deleted owner snapshot');
});

test('startup aborted during task-bank load cannot reopen learning after owner deletion', async () => {
  const harness = createStartLearningHarness({ deferTaskBank: true });
  const started = harness.start();
  await Promise.resolve();
  harness.deleteOwner();
  harness.resolveTaskBank();
  assert.equal(await started, false);
  assert.doesNotMatch(harness.calls.join(','), /progress|restore|save|tab:scr1|hook/u);
});

test('stale progress restore cannot replace a recreated same-name owner session', async () => {
  const harness = createStartLearningHarness({ deferProgress: true });
  const started = harness.start();
  await Promise.resolve();
  await Promise.resolve();
  harness.deleteOwner({ recreate: true });
  harness.resolveProgress({ learned: 99 });
  assert.equal(await started, false);
  assert.doesNotMatch(harness.calls.join(','), /restore|save|baseline|tab:scr1|hook/u);
});

test('startup aborted by its bootstrap deadline cannot commit after task-bank or progress waits', async () => {
  for (const mode of ['task-bank', 'progress']) {
    const harness = createStartLearningHarness({
      deferTaskBank: mode === 'task-bank',
      deferProgress: mode === 'progress',
    });
    const controller = new AbortController();
    const started = harness.start(undefined, { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(Object.assign(new Error('deadline'), { code: 'REQUEST_TIMEOUT' }));
    if (mode === 'task-bank') harness.resolveTaskBank();
    else harness.resolveProgress({ learned: 99 });
    assert.equal(await started, false);
    assert.doesNotMatch(harness.calls.join(','), /restore|save|baseline|tab:scr1|hook/u,
      `late ${mode} completion must not release Today`);
  }
});

test('startup progress restore sends and verifies the captured owner contract', async () => {
  const valid = createStartLearningHarness();
  assert.equal(await valid.start(), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(valid.progressRequest())),
    {
      pathname: '/api/v1/progress',
      options: { headers: { 'X-EasyBoost-Expected-Owner': 'grammar-owner' } },
    },
  );

  const switched = createStartLearningHarness({ deferProgress: true, progressResponseOwner: 'different-owner' });
  const started = switched.start(); await Promise.resolve(); await Promise.resolve();
  switched.resolveProgress({ learned: 99 });
  assert.equal(await started, false);
  assert.match(switched.calls.join(','), /invalidate:grammar-owner:0/u,
    'missing or mismatched response authority must close the adopted session');
  assert.doesNotMatch(switched.calls.join(','), /restore|save|baseline|tab:scr1|hook/u);
});

test('startup authority failures never fall back to an offline snapshot or open learning', async () => {
  for (const progressError of [
    Object.assign(new Error('owner changed'), { code: 'OWNER_CHANGED', status: 409 }),
    Object.assign(new Error('session expired'), { code: 'SESSION_EXPIRED', status: 401 }),
  ]) {
    const harness = createStartLearningHarness({ progressError });
    assert.equal(await harness.start(), false);
    assert.match(harness.calls.join(','), /invalidate:grammar-owner:0/u);
    assert.doesNotMatch(harness.calls.join(','), /restore|save|baseline|tab:scr1|hook/u);
  }
});

test('startup keeps a legitimate extensible owner progress field separate from response metadata', async () => {
  const harness = createStartLearningHarness();
  assert.equal(await harness.start(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.restoredPayload())), { owner: { custom: 'kept' }, learned: 1 });
});

test('startup overlays only the exact owner-generation local grammar workflow, never mastery', async () => {
  const localRunner = {
    schema: 'grammar-runner-v1', catalogVersion: 'grammar-core-v2', sessionId: 'local-session', queue: [],
  };
  const harness = createStartLearningHarness({
    localWorkflow: {
      grammarRunner: localRunner,
      grammarMastery: { 2: { stage: 'stable', forged: true } },
      learned: 999,
    },
    restoredState: {
      grammarRunner: { sessionId: 'stale-server-session' },
      grammarMastery: { 2: { stage: 'learning', masteryRevision: 4 } },
      learned: 7,
    },
  });

  assert.equal(await harness.start(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.localReads())), [
    { owner: 'grammar-owner', ownerGeneration: 0 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.savedState())), {
    grammarRunner: localRunner,
    grammarMastery: { 2: { stage: 'learning', masteryRevision: 4 } },
    learned: 7,
  });

  const completed = createStartLearningHarness({
    localWorkflow: { grammarRunner: null, grammarMastery: { forged: true } },
    restoredState: { grammarRunner: { sessionId: 'stale-server-session' }, grammarMastery: { server: true } },
  });
  assert.equal(await completed.start(), true);
  assert.equal(completed.savedState().grammarRunner, null, 'local null intentionally clears a stale server workflow');
  assert.deepEqual(JSON.parse(JSON.stringify(completed.savedState().grammarMastery)), { server: true });
});

test('server session adoption stays inside the durable owner-incarnation lock', () => {
  assert.match(appSource, /const adopted=await store\.sync\.adoptOwner\?\.\(sessionOwner,generation,\{/u,
    'the canonical /me bootstrap must adopt the opaque server owner through durable authority');
  assert.match(appSource, /canCommit:function\(\)\{return authGuard\.sessionGeneration===AUTH_SESSION_GENERATION&&signal\?\.aborted!==true\}/u,
    'a stale or timed-out /me response cannot commit after logout, deletion or deadline');
  assert.match(appSource, /commit:function\(committedGeneration\)\{return adoptServerSession\(current,committedGeneration\)\}/u,
    'app session state is written only by the adoption lock callback');
  assert.match(appSource, /if\(adopted!==sessionOwner\)return\{state:LEARNING_ACCESS_STATES\.NETWORK_UNKNOWN,session:null,stale:true\}/u,
    'failed or stale adoption must not open a learner session');
  assert.doesNotMatch(appSource, /auth\.(?:login|register|startTelegramLogin|checkTelegramLogin)\(/u,
    'removed password and Telegram learner flows cannot bypass the canonical /me adoption seam');
});

test('authoritative no-session clears only the generation-bound current-owner marker', () => {
  assert.match(clearNoSessionAuthoritySource, /previousOwner=authGuard\.owner,previousGeneration=authGuard\.ownerGeneration/u);
  assert.match(clearNoSessionAuthoritySource, /store\.clearCurrentOwner\?\.\(previousOwner,previousGeneration\)/u);
  assert.match(clearNoSessionAuthoritySource, /currentUser=null;S=null;window\.__sub=null/u);
  assert.doesNotMatch(appSource, /else\{[^}]*deleteUserData/u,
    'natural session expiry must not delete the previous learner data partition');
});

test('a real 401 /me response clears the stale marker before another VK account can sign in', async () => {
  const calls = [];
  const context = vm.createContext({
    SRV: true,
    currentUser: 'owner-a', ADOPTED_OWNER_GENERATION: 3, AUTH_SESSION_GENERATION: 7,
    TOKEN: 'cookie', S: { learned: 19 }, OFFLINE_EGE_MOCK_CONTINUATION: false,
    window: { __sub: { username: 'owner-a' } },
    auth: { async currentSession() { throw Object.assign(new Error('expired'), { status: 401 }); } },
    store: {
      sync: {
        ownerAuthSnapshot(owner) {
          return owner ? { ownerGeneration: 3, deleted: false } : { globalGeneration: 8 };
        },
        setOwner(owner) { calls.push(`set-owner:${owner}`); },
      },
      async clearCurrentOwner(owner, generation) { calls.push(`clear:${owner}:${generation}`); return true; },
    },
    rememberSessionOwnerGeneration(owner, generation) { calls.push(`remember:${owner}:${generation}`); },
    classifyLearningAccess() { return { state: 'no-session', session: null }; },
    LEARNING_ACCESS_STATES: { NETWORK_UNKNOWN: 'network-unknown', NO_SESSION: 'no-session' },
    offlineEgeMockContinuation() { return null; },
    closeAccessGate() {}, hideLearningShell() {}, queueMicrotask() {}, tab() {}, applyLearningAccess() {},
    Number, Boolean, Object, String, Date, Promise,
  });
  vm.runInContext(`${clearNoSessionAuthoritySource}\n${checkLearningAccessSource}\nthis.checkLearningAccess=checkLearningAccess;`, context);
  const result = await context.checkLearningAccess(null, { deferPresentation: true });
  assert.equal(result.state, 'no-session');
  assert.equal(context.currentUser, null);
  assert.equal(context.ADOPTED_OWNER_GENERATION, null);
  assert.equal(context.TOKEN, '');
  assert.equal(context.S, null);
  assert.deepEqual(calls, ['remember:null:null', 'set-owner:null', 'clear:owner-a:3']);
});

test('owner deletion logs out only the matching session while durable sync authority invalidates every pending auth', () => {
  const context = vm.createContext({
    currentUser: null,
  });
  vm.runInContext(`${applyDeletedOwnerSource}\nthis.applyDeletedOwner=applyDeletedOwner;`, context);
  assert.equal(context.applyDeletedOwner({ owner: 'grammar-owner' }), false);
  context.currentUser = 'different-owner';
  assert.equal(context.applyDeletedOwner({ owner: 'second-owner' }), false);
  assert.match(appSource, /store\.sync\.ownerAuthSnapshot\?\.\(sessionOwner\)/u,
    'pending auth validity comes from shared durable authority, not currentUser or Broadcast timing');
});

test('a delayed deletion logs out only an older adopted owner generation', () => {
  function run(adoptedOwnerGeneration) {
    const calls = [];
    const context = vm.createContext({
      currentUser: 'grammar-owner', ADOPTED_OWNER_GENERATION: adoptedOwnerGeneration,
      AUTH_SESSION_GENERATION: 2, TOKEN: 'cookie', S: { learned: 4 },
      rememberSessionOwnerGeneration() {},
      window: { __sub: {} }, notifyAuthorityReset() {},
      store: { sync: { setOwner() {} }, clearCurrentOwner(owner, generation) { calls.push(`owner:${owner}:${generation}`); } },
      localStorage: { removeItem() {} }, clearAdaptiveRuntime() { calls.push('runtime'); },
      clearAdaptiveOverviewCache() {}, hideLearningShell() {}, show(screen) { calls.push(screen); },
    });
    vm.runInContext(`${applyDeletedOwnerSource}\nthis.applyDeletedOwner=applyDeletedOwner;`, context);
    return { applied: context.applyDeletedOwner({ owner: 'grammar-owner', ownerGeneration: 1 }), calls };
  }
  assert.equal(run(1).applied, false, 'the recreated generation ignores an older delayed deletion notification');
  assert.equal(run(0).applied, true, 'the pre-delete generation is logged out even after revival');
  assert.match(appSource, /function currentOwnerAuthorityCurrent/u);
  assert.match(appSource, /function save\([^)]*\)\{[\s\S]*?currentOwnerAuthorityCurrent/u,
    'a missed Broadcast must still fail closed before a stale local snapshot is saved');
  assert.match(appSource, /function startStillCurrent\(\)[\s\S]*?currentOwnerAuthorityCurrent/u,
    'a missed Broadcast must still fail closed before the old learning shell reopens');
  assert.doesNotMatch(startLearningSource, /adoptServerSession/u,
    'routine launch must never resample and upgrade the owner generation');
});

test('the shared current-owner marker is generation-bound and clears by exact incarnation', async () => {
  const { store, values } = createStore({ eb_current: 'legacy-owner' });
  assert.equal(JSON.stringify(store.readCurrentOwner()), JSON.stringify({ owner: 'legacy-owner', ownerGeneration: 0 }));
  assert.equal(await store.writeCurrentOwner('grammar-owner', 1), true);
  assert.equal(JSON.stringify(store.readCurrentOwner()), JSON.stringify({ owner: 'grammar-owner', ownerGeneration: 1 }));
  assert.equal(await store.clearCurrentOwner('grammar-owner', 0), false,
    'an old tab cannot remove the marker adopted by a recreated account');
  assert.equal(values.has('eb_current'), true);
  assert.equal(await store.clearCurrentOwner('grammar-owner', 1), true);
  assert.equal(values.has('eb_current'), false);
});

test('owner-incarnation storage takes the global lock before the owner partition lock', async () => {
  const calls = [];
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const navigator = { locks: { async request(name, _options, action) {
    calls.push(`enter:${name}`);
    try { return await action({ name }); } finally { calls.push(`leave:${name}`); }
  } } };
  const window = { localStorage, navigator };
  const context = vm.createContext({ window, navigator, JSON, Object, Number, String, Boolean, Set, Map, Symbol, Promise });
  vm.runInContext(ownerIncarnationSource, context);

  await window.EasyBoostOwnerIncarnation.withOwnerLock('student-a', () => true);
  assert.deepEqual(calls, [
    'enter:easyboost-owner-incarnation:global',
    'enter:easyboost-owner-incarnation:student-a',
    'leave:easyboost-owner-incarnation:student-a',
    'leave:easyboost-owner-incarnation:global',
  ]);
});

test('a delayed old-generation logout preserves the revived tab marker and cleanup scope', async () => {
  const { store, values } = createStore();
  await store.writeCurrentOwner('grammar-owner', 1);
  const runtimeClears = [];
  const context = vm.createContext({
    currentUser: 'grammar-owner', ADOPTED_OWNER_GENERATION: 0,
    AUTH_SESSION_GENERATION: 2, TOKEN: 'cookie', S: { learned: 4 },
    rememberSessionOwnerGeneration() {}, window: { __sub: {} }, notifyAuthorityReset() {},
    store: { ...store, sync: { setOwner() {} } },
    localStorage: {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
    clearAdaptiveRuntime(authority) { runtimeClears.push(authority); return false; },
    clearAdaptiveOverviewCache(_storage, authority) { runtimeClears.push(authority); return false; },
    hideLearningShell() {}, show() {},
  });
  vm.runInContext(`${applyDeletedOwnerSource}\nthis.applyDeletedOwner=applyDeletedOwner;`, context);
  assert.equal(context.applyDeletedOwner({ owner: 'grammar-owner', ownerGeneration: 1 }), true);
  assert.equal(JSON.stringify(store.readCurrentOwner()), JSON.stringify({ owner: 'grammar-owner', ownerGeneration: 1 }),
    'the revived tab keeps the shared marker written for generation 1');
  assert.deepEqual(runtimeClears, [],
    'storage cleanup is completed by the serialized deletion operation before the app logout notification');
});

test('bootstrap keeps first launch and session authority parallel behind one private gate', () => {
  assert.match(appSource, /const opening=firstLaunch\.start\(\);[\s\S]*const accessCheck=[\s\S]*await opening;[\s\S]*const access=await accessCheck/u);
  assert.match(appSource, /runWithAbortDeadline\([\s\S]*checkLearningAccess\(null,\{deferPresentation:true,signal\}\)[\s\S]*FIRST_LAUNCH_SESSION_TIMEOUT_MS/u,
    'the parallel /me request must stay private and terminate through a bounded abort deadline');
  assert.match(appSource, /timedOut:true/u,
    'an exhausted bootstrap deadline must become the deterministic network-unknown presentation');
  assert.match(appSource, /if\(access\.state===LEARNING_ACCESS_STATES\.ACTIVE\)return startLearningWithDeadline\(access\.session\)/u,
    'only the canonical coordinator may release an authenticated returning learner to Today');
  assert.match(appSource, /async function startLearningWithDeadline\(session\)[\s\S]*runWithAbortDeadline\([\s\S]*startLearningWithVerifiedSession\(session,\{signal\}\)[\s\S]*NETWORK_UNKNOWN/u,
    'task-bank and progress bootstrap must terminate in the recoverable network gate');
  assert.match(startLearningSource, /tab\('scr1',function\(\)\{closeAccessGate\(\);firstLaunch\.release\(\);focusTodayHeading\(\)\}\)/u,
    'the access gate and splash stay private until Today commits, then focus enters that destination');
});

test('exact authority invalidation clears the captured subscription before showing login', () => {
  assert.match(invalidateLearningAuthoritySource, /window\.__sub=null/u);
  assert.match(appSource, /function registerAuthorityReset\(hook\)/u);
  assert.match(invalidateLearningAuthoritySource, /notifyAuthorityReset\(authority\)/u);
});

test('production owner cleanup delegates compare-remove to the shared incarnation lock', () => {
  assert.match(source, /EasyBoostOwnerIncarnation/u);
  assert.match(source, /clearMatchingStorage/u);
  assert.match(appSource, /store\.sync\.adoptOwner\?\.\(/u);
});

test('local snapshots use generation-qualified keys and reject delete-revive resurrection', () => {
  let generation = 0;
  const sync = {
    isOwnerDeleted() { return false; },
    ownerAuthSnapshot() { return { ownerGeneration: generation, globalGeneration: generation, deleted: false }; },
    ownerBoundGeneration() { return 0; },
  };
  const { store, values } = createStore({}, sync);
  assert.equal(store.saveLocal('student', { learned: 7 }, 0), true);
  const envelope = JSON.parse(values.get('eb_data_student_g0'));
  assert.equal(envelope.ownerGeneration, 0);
  assert.equal(envelope.state.learned, 7);

  generation = 1;
  assert.equal(store.loadLocal('student', 1).learned, 0,
    'the recreated account cannot restore the deleted incarnation snapshot');
  assert.equal(store.saveLocal('student', { learned: 8 }, 0), false,
    'an old tab cannot stamp stale state with the current generation');
  assert.equal(values.has('eb_data_student_g0'), true,
    'generation partitioning keeps stale bytes isolated until the deletion purge removes that exact partition');
  assert.equal(store.loadLocal('student', 1).learned, 0,
    'the stale generation partition can never be restored by the recreated account');
});

test('frontend store normalizes and persists isolated user state', () => {
  const { store, values } = createStore();
  const state = store.normalize({ learned: 4 });
  assert.equal(state.learned, 4);
  assert.deepEqual(Object.keys(state.prog), ['words', 'gram', 'read', 'listen', 'write', 'speak']);
  assert.equal(store.saveLocal('student', state), true);
  assert.equal(JSON.parse(values.get('eb_data_student_g0')).state.learned, 4);
  assert.equal(store.loadLocal('student').learned, 4);
});

test('listening rotation history remains isolated in the existing per-user offline snapshots', () => {
  const { store } = createStore();
  const student = store.normalize({
    listeningPilotHistory: {
      version: 1,
      items: {
        'listening-pilot-v1.matching.sample@1': {
          id: 'listening-pilot-v1.matching.sample', revision: 1, attempts: 1,
          lastScore: 4, lastMaxScore: 6, lastAttemptAt: 100,
          transcriptExposed: true,
          help: { slowPlayback: false, additionalPlaybacks: 0, synthFallback: false },
        },
      },
      lastSelected: { matching: { id: 'listening-pilot-v1.matching.sample', revision: 1 } },
    },
  });
  assert.equal(store.saveLocal('student-a', student), true);

  assert.equal(store.loadLocal('student-b').listeningPilotHistory, undefined);
  assert.equal(Object.keys(store.loadLocal('student-a').listeningPilotHistory.items).length, 1);
});

test('frontend store exposes the offline synchronization layer', () => {
  const { store, sync } = createStore({ eb_data_broken: '{invalid' });
  assert.equal(store.sync, sync);
  assert.equal(store.loadLocal('broken').learned, 0);
  assert.equal(store.saveLocal('', {}), false);
});

test('restore prefers the server answer and normalizes it', () => {
  const { store } = createStore({ eb_data_student: JSON.stringify({ learned: 4, streak: 9 }) });
  const state = store.restore('student', { learned: 12 }, {});

  assert.equal(state.learned, 12);
  assert.equal(state.streak, 0, 'the server answer replaces the snapshot, it is not merged into it');
  assert.deepEqual(Object.keys(state.prog), ['words', 'gram', 'read', 'listen', 'write', 'speak']);
});

test('restore falls back to the local snapshot when the network is gone', () => {
  const { store } = createStore({
    eb_data_student: JSON.stringify({ learned: 4, streak: 9, box: { apple: 3 }, prog: { words: 40 } }),
  });
  const state = store.restore('student', null, {});

  assert.equal(state.learned, 4);
  assert.equal(state.streak, 9);
  assert.equal(state.box.apple, 3);
  assert.equal(state.prog.words, 40);
});

test('restore starts from zero on a device with no snapshot', () => {
  const { store } = createStore();
  const state = store.restore('newcomer', null, {});

  assert.equal(state.learned, 0);
  assert.equal(state.streak, 0);
  assert.deepEqual(Object.keys(state.box), []);
});

test('queued modules win over both the server answer and the snapshot', () => {
  const { store } = createStore({ eb_data_student: JSON.stringify({ learned: 4 }) });
  const fromServer = store.restore('student', { learned: 12, srs: { a: 1 } }, { learned: 15 });
  const offline = store.restore('student', null, { learned: 15 });

  assert.equal(fromServer.learned, 15);
  assert.deepEqual({ ...fromServer.srs }, { a: 1 }, 'untouched modules keep the server value');
  assert.equal(offline.learned, 15);
  assert.equal(store.applyModules({ learned: 1 }, { learned: undefined }).learned, 1);
  assert.equal(store.applyModules({ learned: 1 }, null).learned, 1);
});
