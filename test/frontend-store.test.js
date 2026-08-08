import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/store.js', import.meta.url), 'utf8');
const ownerIncarnationSource = await fs.readFile(new URL('../public/owner-incarnation.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const startLearningSource = appSource.match(
  /async function startLearningWithVerifiedSession\(session\)\{[\s\S]*?\n\}\nasync function confirmExplicitServerOwner/u,
)[0].replace(/\nasync function confirmExplicitServerOwner$/u, '');
const confirmOwnerSource = appSource.match(
  /async function confirmExplicitServerOwner\(session[^)]*\)\{[\s\S]*?\n\}/u,
)[0];
const applyDeletedOwnerSource = appSource.match(
  /function applyDeletedOwner\(update\)\{[\s\S]*?\n\}/u,
)[0];
const invalidateLearningAuthoritySource = appSource.match(
  /async function invalidateLearningAuthority\(authority\)\{[\s\S]*?\n\}/u,
)[0];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createStartLearningHarness({ deferTaskBank = false, deferProgress = false, progressError = null, progressResponseOwner = 'grammar-owner' } = {}) {
  const taskBank = deferred();
  const progress = deferred();
  const calls = [];
  let progressRequest = null;
  let restoredPayload = null;
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
      restore(_owner, serverState) { calls.push('restore'); restoredPayload = serverState; return { learned: 1 }; },
      saveLocal() { calls.push('save'); return true; },
    },
    tab(screen) { calls.push(`tab:${screen}`); },
    START_HOOKS: [async () => { calls.push('hook'); }],
    toast() {},
    Promise,
  });
  vm.runInContext(`${startLearningSource}\nthis.startLearningWithVerifiedSession=startLearningWithVerifiedSession;`, context);
  return {
    calls,
    start: (session = { authenticated: true, username: 'grammar-owner' }) => context.startLearningWithVerifiedSession(session),
    resolveTaskBank: (value) => taskBank.resolve(value),
    resolveProgress: (value) => progress.resolve(value),
    progressRequest: () => progressRequest,
    restoredPayload: () => restoredPayload,
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

test('a stale explicit-auth response cannot revive a newer deletion tombstone', async () => {
  const calls = [];
  const ownerGenerations = new Map([['grammar-owner', 1]]);
  const context = vm.createContext({
    AUTH_SESSION_GENERATION: 4,
    AUTH_DELETION_GENERATION: 1,
    currentUser: null,
    normalizedAuthOwner(value) { return String(value || '').trim() || null; },
    adoptServerSession(session) { calls.push('adopt'); context.currentUser = session.username; },
    ownerAuthGeneration(owner) { return ownerGenerations.get(owner) || 0; },
    store: { sync: { async confirmOwner(owner, guard, callbacks) {
      calls.push(`revive:${owner}:${guard.ownerGeneration}`);
      if (guard.ownerGeneration !== 1) { calls.pop(); return null; }
      if (callbacks?.canCommit?.() === false) return null;
      callbacks?.commit?.();
      return 'grammar-owner';
    } } },
  });
  vm.runInContext(`${confirmOwnerSource}\nthis.confirmExplicitServerOwner=confirmExplicitServerOwner;`, context);
  const staleGuard = { sessionGeneration: 4, owner: 'grammar-owner', ownerGeneration: 0, globalGeneration: 0 };
  assert.equal(await context.confirmExplicitServerOwner({ authenticated: true, username: 'grammar-owner' }, staleGuard), false);
  assert.deepEqual(calls, []);
  const currentGuard = { sessionGeneration: 4, owner: 'grammar-owner', ownerGeneration: 1, globalGeneration: 1 };
  assert.equal(await context.confirmExplicitServerOwner({ authenticated: true, username: 'grammar-owner' }, currentGuard), true,
    'a server-confirmed auth started after deletion is the only legitimate revival path');
  assert.deepEqual(calls, ['revive:grammar-owner:1', 'adopt'], 'the tombstone must clear under the auth lock before app session state is adopted');
  assert.match(appSource, /ownerAuthSnapshot\?\.\(ownerKey\)/u,
    'auth capture must use the durable cross-tab owner generation');
  assert.match(appSource, /await store\.sync\.confirmOwner\?\.\(/u,
    'auth confirmation must await the same lock that owns deletion generation changes');
  assert.match(appSource, /captureExplicitAuth\(u\)[^\n]*await auth\.login[\s\S]*confirmExplicitServerOwner\([^,]+,[^)]+\)/u);
  assert.match(appSource, /captureExplicitAuth\(\)[^\n]*await auth\.checkTelegramLogin[\s\S]*confirmExplicitServerOwner\([^,]+,[^)]+\)/u);
});

test('owner deletion logs out only the matching session while durable sync authority invalidates every pending auth', () => {
  const context = vm.createContext({
    currentUser: null,
  });
  vm.runInContext(`${applyDeletedOwnerSource}\nthis.applyDeletedOwner=applyDeletedOwner;`, context);
  assert.equal(context.applyDeletedOwner({ owner: 'grammar-owner' }), false);
  context.currentUser = 'different-owner';
  assert.equal(context.applyDeletedOwner({ owner: 'second-owner' }), false);
  assert.match(appSource, /store\.sync\.ownerAuthSnapshot\?\.\(ownerKey\)/u,
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

test('failed durable owner adoption leaves app and session state untouched', async () => {
  const context = vm.createContext({
    AUTH_SESSION_GENERATION: 7, TOKEN: '', currentUser: null, ADOPTED_OWNER_GENERATION: null,
    normalizedAuthOwner(value) { return String(value || '').trim() || null; },
    store: { sync: { async confirmOwner() { return null; } } },
    window: { __sub: null },
    rememberSessionOwnerGeneration() { throw new Error('session state must not be written'); },
  });
  vm.runInContext(`${confirmOwnerSource}\nthis.confirmExplicitServerOwner=confirmExplicitServerOwner;`, context);
  assert.equal(await context.confirmExplicitServerOwner({ authenticated: true, username: 'grammar-owner' }, {
    sessionGeneration: 7, owner: 'grammar-owner', ownerGeneration: 1, globalGeneration: 1,
  }), false);
  assert.equal(context.AUTH_SESSION_GENERATION, 7);
  assert.equal(context.TOKEN, '');
  assert.equal(context.currentUser, null);
  assert.equal(context.ADOPTED_OWNER_GENERATION, null);
  assert.equal(context.window.__sub, null);
});

test('exact authority invalidation clears the captured subscription before showing login', () => {
  assert.match(invalidateLearningAuthoritySource, /window\.__sub=null/u);
  assert.match(appSource, /function registerAuthorityReset\(hook\)/u);
  assert.match(invalidateLearningAuthoritySource, /notifyAuthorityReset\(authority\)/u);
});

test('production owner cleanup delegates compare-remove to the shared incarnation lock', () => {
  assert.match(source, /EasyBoostOwnerIncarnation/u);
  assert.match(source, /clearMatchingStorage/u);
  assert.match(appSource, /commitOwnerAdoption|confirmOwner/u);
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
