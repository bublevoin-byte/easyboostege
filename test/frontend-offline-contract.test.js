import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

/*
 * Section 6.2 of the specification lists six operations that are online only:
 * AI evaluation, task generation, server side TTS/STT, Telegram login,
 * progress synchronization and subscription management.
 *
 * The requirement behind that list is not "these need the network" — it is
 * "these must never pretend to work without it". An offline attempt has to end
 * in an honest typed state. Returning a cached verdict, a stale subscription or
 * a silent success would be worse than an error, because the student would act
 * on it.
 */

const apiSource = await fs.readFile(new URL('../public/api.js', import.meta.url), 'utf8');
const syncSource = await fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8');
const ownerIncarnationSource = await fs.readFile(new URL('../public/owner-incarnation.js', import.meta.url), 'utf8');
const workerSource = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const readingPilotSource = await fs.readFile(new URL('../public/reading-pilot-v1.js', import.meta.url), 'utf8');
const entrySource = await fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8');
const screenLoaderSource = await fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const privacySource = await fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8');
const wordFlushSource = appSource.match(
  /async function wFlushServer\(authority\)\{[\s\S]*?\n\}\nfunction wQueueServer/u,
)[0].replace(/\nfunction wQueueServer$/u, '');

const ORIGIN = 'https://app.easyboost.ru';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createApi({ offline = true, responseOwner = '', payload = { data: { score: 6 } } } = {}) {
  const attempts = [];
  const window = {
    location: { origin: ORIGIN, protocol: 'https:' },
    async fetch(url, options) {
      attempts.push({
        url: String(url),
        method: (options && options.method) || 'GET',
        headers: options?.headers || {},
      });
      if (offline) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => String(name).toLowerCase() === 'x-easyboost-response-owner' ? responseOwner : '' },
        json: async () => payload,
        blob: async () => ({ size: 128 }),
      };
    },
  };
  vm.runInNewContext(apiSource, { window });
  return { api: window.EasyBoostApi, attempts };
}

test('API client binds an adaptive response to the server-confirmed owner header', async () => {
  const { api } = createApi({
    offline: false,
    responseOwner: 'Owner_A',
    payload: { owner: 'payload-cannot-override-header', profile: { revision: 2 } },
  });
  const result = await api.get('/api/v1/adaptive-learning/overview');
  assert.equal(api.responseOwner(result), 'Owner_A');
  assert.equal(result.owner, 'payload-cannot-override-header');
  assert.equal(result.profile.revision, 2);
});

test('response-owner metadata is non-enumerable transport state and authority errors cannot use offline fallback', async () => {
  const { api } = createApi({
    offline: false,
    responseOwner: 'Owner_A',
    payload: { learned: 12 },
  });
  const result = await api.get('/api/v1/progress');
  assert.equal(api.responseOwner(result), 'Owner_A');
  assert.deepEqual(Object.keys(result), ['learned']);
  assert.equal(JSON.stringify(result), '{"learned":12}');
  assert.equal(api.canUseOfflineFallback(Object.assign(new Error(), { code: 'OWNER_CHANGED', status: 409 })), false);
  assert.equal(api.canUseOfflineFallback(Object.assign(new Error(), { status: 401 })), false);
  assert.equal(api.canUseOfflineFallback(Object.assign(new Error(), { status: 403 })), false);
  assert.equal(api.isAuthorityFailure(Object.assign(new Error(), { code: 'FORBIDDEN', status: 403 })), true);
  assert.equal(api.isAuthorityFailure(Object.assign(new Error(), { code: 'ADAPTIVE_PREMIUM_REQUIRED', status: 403 })), false,
    'an entitlement denial stays screen-local and must not log out the exact owner');
  assert.equal(api.canUseOfflineFallback(Object.assign(new Error(), { code: 'NETWORK_ERROR', status: 0 })), true);
  assert.equal(api.canUseOfflineFallback(Object.assign(new Error(), { status: 503 })), true);
  assert.equal(api.canUseOfflineFallback(Object.assign(new Error(), { status: 429 })), false);
  assert.equal(api.canUseOfflineFallback(new Error('client bug')), false);
});

test('debounced word mastery is bound to one exact owner incarnation and response owner', async () => {
  const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /function wAuthority\(/u);
  assert.match(app, /X-EasyBoost-Expected-Owner/u);
  assert.match(app, /apiResponseOwner\(result\)/u);
  assert.match(app, /ownerGeneration/u);
  assert.doesNotMatch(app, /W_SYNC_T=setTimeout\(function\(\)\{var pending=W_SYNC;W_SYNC=\{\}/u);
});

test('word response-owner mismatch invalidates only its captured incarnation and retains ambiguous evidence', async () => {
  function harness() {
    const authority = Object.freeze({ owner: 'owner-a', ownerGeneration: 0 });
    const key = `${authority.owner}\u0000${authority.ownerGeneration}`;
    const pending = new Map([['word', { word: 'word', stage: 1 }]]);
    const request = deferred();
    const current = { owner: authority.owner, ownerGeneration: authority.ownerGeneration };
    const invalidations = [];
    const context = vm.createContext({
      W_SYNC: new Map([[key, pending]]), W_SYNC_T: new Map([[key, 1]]),
      wAuthorityKey(value) { return `${value.owner}\u0000${value.ownerGeneration}`; },
      wAuthorityCurrent(value) { return current.owner === value.owner && current.ownerGeneration === value.ownerGeneration; },
      apiPut() { return request.promise; },
      apiResponseOwner(result) { return result.responseOwner; },
      apiIsAuthorityFailure() { return false; },
      async invalidateLearningAuthority(value) {
        invalidations.push({ ...value });
        return current.owner === value.owner && current.ownerGeneration === value.ownerGeneration;
      },
      Map, Array, Object, Promise,
    });
    vm.runInContext(`${wordFlushSource}\nthis.wFlushServer=wFlushServer;`, context);
    return { authority, current, invalidations, pending, request, flush: () => context.wFlushServer(authority) };
  }

  const mismatched = harness();
  const mismatchFlush = mismatched.flush();
  mismatched.request.resolve({ responseOwner: 'owner-b' });
  assert.equal(await mismatchFlush, false);
  assert.deepEqual(mismatched.invalidations, [{ owner: 'owner-a', ownerGeneration: 0 }]);
  assert.equal(mismatched.pending.size, 1, 'ambiguous evidence remains queued after response-owner mismatch');

  const stale = harness();
  const staleFlush = stale.flush();
  stale.current.owner = 'owner-b';
  stale.request.resolve({ responseOwner: 'owner-b' });
  assert.equal(await staleFlush, false);
  assert.deepEqual(stale.invalidations, [], 'an obsolete word continuation cannot invalidate a newer owner');
  assert.equal(stale.pending.size, 1);
});

/* The six online-only operations of section 6.2, in the order the specification lists them. */
function onlineOnlyOperations(api) {
  return [
    {
      requirement: 'ИИ-проверка',
      context: 'ai',
      run: () => api.post('/api/v1/ai/evaluate-writing', { task: 37, text: 'Dear Sam, ...' }),
    },
    {
      requirement: 'генерация новых заданий',
      context: 'ai',
      run: () => api.generateContent('reading-task', { level: 'B1' }),
    },
    {
      requirement: 'серверный TTS',
      context: 'tts',
      run: () => api.getBlob('/api/v1/tts?text=hello&voice=en-GB-SoniaNeural'),
    },
    {
      requirement: 'серверный STT',
      context: 'stt',
      run: () => api.postBinary('/api/v1/stt', new Uint8Array([1, 2, 3, 4]), 'audio/webm'),
    },
    {
      requirement: 'Telegram-вход',
      context: 'telegram',
      run: () => api.post('/api/v1/tg/start', {}),
    },
    {
      requirement: 'управление подпиской',
      context: 'request',
      run: () => api.get('/api/v1/me'),
    },
  ];
}

test('every online-only operation of section 6.2 fails with a typed offline state', async () => {
  const { api } = createApi({ offline: true });

  for (const operation of onlineOnlyOperations(api)) {
    let settled = 'pending';
    let error = null;

    try {
      await operation.run();
      settled = 'resolved';
    } catch (caught) {
      settled = 'rejected';
      error = caught;
    }

    assert.equal(
      settled,
      'rejected',
      `«${operation.requirement}» вернула результат без сети — это выдача устаревших данных за настоящие`,
    );
    assert.equal(error.name, 'ApiError', `«${operation.requirement}» должна давать типизированную ошибку`);
    assert.equal(error.code, 'NETWORK_ERROR', `«${operation.requirement}» должна различать отсутствие сети`);
    assert.equal(error.status, 0);
  }
});

test('the offline message names the network rather than blaming the service', async () => {
  const { api } = createApi({ offline: true });

  for (const operation of onlineOnlyOperations(api)) {
    const error = await operation.run().then(() => null, (caught) => caught);
    const message = api.messageFor(error, operation.context);

    assert.match(
      message,
      /нет подключения к интернету/iu,
      `«${operation.requirement}»: ученик должен понять, что дело в сети, а не в приложении`,
    );
    /* A missing network is not a broken subscription and not a broken AI provider. */
    assert.doesNotMatch(message, /подписк|провайдер|недоступ/iu);
  }
});

test('the same operations succeed once the network is back, so the contract is about the network', async () => {
  const { api, attempts } = createApi({ offline: false });

  const verdict = await api.post('/api/v1/ai/evaluate-writing', { task: 37, text: 'Dear Sam, ...' });
  assert.deepEqual(verdict.data, { score: 6 });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, `${ORIGIN}/api/v1/ai/evaluate-writing`);
});

test('binary requests forward explicit pronunciation headers without losing the content type', async () => {
  const { api, attempts } = createApi({ offline: false });
  await api.postBinary('/api/v1/speaking/upload', new Uint8Array([1, 2]), 'audio/wav', {
    'Idempotency-Key': '70000000-0000-4000-8000-000000000001',
    'X-Speech-Locale': 'en-GB',
    'X-Audio-Duration-Seconds': '12',
    'X-Speaking-Item': '3',
  });

  assert.deepEqual(Object.fromEntries(Object.entries(attempts[0].headers)), {
    'Content-Type': 'audio/wav',
    'Idempotency-Key': '70000000-0000-4000-8000-000000000001',
    'X-Speech-Locale': 'en-GB',
    'X-Audio-Duration-Seconds': '12',
    'X-Speaking-Item': '3',
  });
});

/* ---------- progress synchronization ---------- */

function createLockManager() {
  const tails = new Map();
  return { calls: [], request(name, _options, callback) {
    this.calls.push(name);
    const tail = tails.get(name) || Promise.resolve();
    const result = tail.then(() => callback({ name: 'grammar-queue' }));
    tails.set(name, result.catch(() => {}));
    return result;
  } };
}

function createBroadcastHub() {
  const channels = [];
  return class TestBroadcastChannel {
    constructor(name) { this.name = name; this.onmessage = null; channels.push(this); }
    postMessage(data) {
      for (const channel of channels) {
        if (channel !== this && channel.name === this.name) channel.onmessage?.({ data: JSON.parse(JSON.stringify(data)) });
      }
    }
    close() {}
  };
}

function createDeferredBroadcastHub() {
  const channels = [];
  const pending = [];
  class DeferredBroadcastChannel {
    constructor(name) { this.name = name; this.onmessage = null; channels.push(this); }
    postMessage(data) { pending.push({ sender: this, data: JSON.parse(JSON.stringify(data)) }); }
    close() {}
    static flush() {
      while (pending.length) {
        const message = pending.shift();
        for (const channel of channels) {
          if (channel !== message.sender && channel.name === message.sender.name) channel.onmessage?.({ data: message.data });
        }
      }
    }
  }
  return DeferredBroadcastChannel;
}

function createSync({ online = false, failRequest = true, sharedValues = null, lockManager = createLockManager(), BroadcastChannel, failSetKey = null, failSetKeys = [] } = {}) {
  const values = sharedValues || new Map();
  const posts = [];
  let uuid = 500;
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (key === failSetKey || failSetKeys.includes(key)) throw new Error('quota exceeded');
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
  const window = {
    localStorage,
    navigator: { onLine: online, locks: lockManager },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    BroadcastChannel,
    addEventListener() {},
    EasyBoostApi: {
      async post(path, body) {
        posts.push({ path, body });
        if (failRequest) {
          const error = new Error('Нет подключения к интернету.');
          error.code = 'NETWORK_ERROR';
          error.status = 0;
          throw error;
        }
        if (path === '/api/v1/grammar/mastery-events/batch') {
          return { batchId: body.batchId, results: body.events.map((entry) => ({
            eventId: entry.event.id, applied: true, conflict: false, replay: false,
            record: { masteryVersion: 2, masteryRevision: entry.event.expectedRevision + 1, stage: entry.event.expectedStage, reviewStep: entry.event.expectedReviewStep },
          })) };
        }
        return { ok: true };
      },
    },
  };
  const context = vm.createContext({
    window,
    localStorage,
    navigator: window.navigator,
    EasyBoostApi: window.EasyBoostApi,
    JSON,
    Object,
    Date,
    Promise,
    crypto: window.crypto,
    BroadcastChannel,
  });
  vm.runInContext(ownerIncarnationSource, context);
  vm.runInContext(syncSource, context);
  return { sync: window.EasyBoostSync, posts, values, window };
}

test('offline progress synchronization reports failure instead of a silent success', async () => {
  const { sync, posts } = createSync({ online: false });
  sync.setOwner('learner-a');
  await sync.setBaseline({ words: { learned: 10 } });

  const result = await sync.saveProgress({ words: { learned: 14 } });

  assert.equal(result, false, 'синхронизация без сети не должна отвечать «сохранено»');
  assert.equal(posts.length, 0, 'при navigator.onLine === false запрос не отправляется вовсе');
  assert.equal(sync.hasPending(), true, 'изменение обязано остаться в очереди, а не потеряться');
  assert.deepEqual(sync.pendingModules(), { words: { learned: 14 } });
  sync.setOwner('learner-b');
  assert.equal(Object.keys(sync.pendingModules()).length, 0, 'другой аккаунт не видит очередь прогресса');
  sync.setOwner('learner-a');
  assert.deepEqual(sync.pendingModules(), { words: { learned: 14 } });
});

test('a queued change survives until the network actually accepts it', async () => {
  const offline = createSync({ online: false });
  offline.sync.setOwner('learner-a');
  await offline.sync.setBaseline({ words: { learned: 10 } });
  await offline.sync.saveProgress({ words: { learned: 14 } });

  /* The queue is shared through localStorage, so a later online session sees it. */
  const queued = offline.values.get('easyboost_pending_modules_v3');
  assert.ok(queued, 'очередь синхронизации должна пережить перезапуск приложения');

  const online = createSync({ online: true, failRequest: false });
  online.values.set('easyboost_pending_modules_v3', queued);
  online.sync.setOwner('learner-a');

  const flushed = await online.sync.flush();
  assert.equal(flushed, true);
  assert.equal(online.posts.length, 1);
  assert.deepEqual(online.posts[0].body.modules, { words: { learned: 14 } });
  assert.equal(online.sync.hasPending(), false, 'после успешной отправки очередь очищается');
});

test('learner preferences changed offline replay only for the same owner', async () => {
  const learnerPreferences = {
    version: 1,
    schoolGrade: 9,
    preferredSessionMinutes: 35,
  };
  const offline = createSync({ online: false });
  offline.sync.setOwner('learner-a');
  await offline.sync.setBaseline({});

  assert.equal(await offline.sync.saveProgress({ learnerPreferences }), false);
  assert.deepEqual(offline.sync.pendingModules(), { learnerPreferences });

  const queued = offline.values.get('easyboost_pending_modules_v3');
  const online = createSync({ online: true, failRequest: false });
  online.values.set('easyboost_pending_modules_v3', queued);
  online.sync.setOwner('learner-b');
  assert.equal(await online.sync.flush(), false);
  assert.equal(online.posts.length, 0);

  online.sync.setOwner('learner-a');
  assert.equal(await online.sync.flush(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(online.posts)), [{
    path: '/api/v1/progress/modules',
    body: { owner: 'learner-a', modules: { learnerPreferences } },
  }]);
  assert.equal(online.sync.hasPending(), false);
});

test('server-owned Grammar mastery is excluded from generic progress synchronization', async () => {
  const offline = createSync({ online: false });
  offline.sync.setOwner('grammar-owner');
  await offline.sync.setBaseline({});
  assert.equal(await offline.sync.saveProgress({ grammarMastery: { 1: { stage: 'stable' } } }), true);
  assert.equal(Object.keys(offline.sync.pendingModules()).length, 0);
  assert.equal(offline.sync.hasPending(), false);
});

test('Grammar mastery event changed offline replays once and only for its owner', async () => {
  const event = {
    id: '00000000-0000-4000-8000-000000000091', type: 'review_completed',
    expectedRevision: 3, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  };
  const offline = createSync({ online: false });
  offline.sync.setOwner('grammar-owner');
  assert.equal(await offline.sync.saveGrammarMasteryEvent(1, event), false);
  assert.deepEqual(JSON.parse(JSON.stringify(offline.sync.pendingGrammarMasteryEvents())), [{ topicId: 1, event }]);

  const queued = offline.values.get('easyboost_pending_grammar_mastery_events_v1');
  const online = createSync({ online: true, failRequest: false });
  online.values.set('easyboost_pending_grammar_mastery_events_v1', queued);
  online.sync.setOwner('other-owner');
  assert.equal(await online.sync.flush(), false);
  assert.equal(online.posts.length, 0);

  online.sync.setOwner('grammar-owner');
  assert.equal(await online.sync.flush(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(online.posts)), [{
    path: '/api/v1/grammar/mastery-events/batch',
    body: { owner: 'grammar-owner', batchId: event.id, events: [{ topicId: 1, event }] },
  }]);
  assert.equal(await online.sync.flush(), false, 'accepted mastery event is not replayed twice');
});

test('the Grammar mastery queue fails closed at 20 and never evicts earlier proof', async () => {
  const offline = createSync({ online: false });
  offline.sync.setOwner('grammar-owner');
  const events = [];
  for (let index = 0; index < 20; index += 1) {
    const event = {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      type: 'review_completed', expectedRevision: index, expectedStage: 'learned', expectedReviewStep: 0,
      source: 'builtin', assisted: false, passed: true,
    };
    events.push(event);
    assert.equal(await offline.sync.saveGrammarMasteryEvent(1, event), false);
    if (index === 18) {
      assert.equal(offline.sync.canQueueGrammarMasteryEvent(1), true);
      assert.equal(offline.sync.canQueueGrammarMasteryEvent(2), false,
        'a multi-topic review must reserve every result slot before it starts');
    }
  }
  const rejected = await offline.sync.saveGrammarMasteryEvent(1, {
    ...events[19], id: '00000000-0000-4000-8000-000000000099', expectedRevision: 20,
  });
  assert.equal(rejected.code, 'GRAMMAR_MASTERY_QUEUE_FULL');
  assert.match(rejected.message, /подключитесь для синхронизации/iu);
  assert.equal(offline.sync.canQueueGrammarMasteryEvent(), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(offline.sync.pendingGrammarMasteryEvents().map((item) => item.event.id))),
    events.map((event) => event.id),
  );
});

test('a Grammar review batch is atomically owner-bound and cannot overbook across tabs', async () => {
  const sharedValues = new Map();
  const lockManager = createLockManager();
  const first = createSync({ online: false, sharedValues, lockManager });
  const second = createSync({ online: false, sharedValues, lockManager });
  first.sync.setOwner('grammar-owner'); second.sync.setOwner('grammar-owner');
  const event = (index) => ({
    topicId: index,
    event: {
      id: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
      type: 'review_completed', expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
      source: 'builtin', assisted: false, passed: true,
    },
  });
  await first.sync.saveGrammarMasteryEvents(Array.from({ length: 19 }, (_, index) => event(index + 1)));
  const [one, two] = await Promise.all([
    first.sync.saveGrammarMasteryEvents([event(20)]),
    second.sync.saveGrammarMasteryEvents([event(20), { ...event(19), event: { ...event(19).event, id: '00000000-0000-4000-8000-000000000999' } }]),
  ]);
  assert.equal([one, two].filter((result) => result === false).length, 1);
  assert.equal([one, two].filter((result) => result?.code === 'GRAMMAR_MASTERY_QUEUE_FULL').length, 1);
  assert.equal(first.sync.pendingGrammarMasteryEvents().length, 20);
});

test('Grammar 429 and stale CAS retain proof while replay/applied results clear it', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('grammar-owner');
  const entry = {
    topicId: 1,
    event: {
      id: '00000000-0000-4000-8000-000000000771', type: 'session_completed',
      expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  };
  active.window.EasyBoostApi.post = async () => {
    const error = new Error('rate limited'); error.status = 429; throw error;
  };
  assert.equal(await active.sync.saveGrammarMasteryEvents([entry]), false);
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 1, '429 must stay durable');

  let calls = 0;
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body }); calls += 1;
    if (calls === 1) return { results: [{
      eventId: entry.event.id, applied: false, conflict: true, replay: false,
      record: { masteryVersion: 2, masteryRevision: 4, stage: 'learning', reviewStep: 0 },
    }] };
    return { results: [{ eventId: body.events[0].event.id, applied: true, conflict: false, replay: false,
      record: { masteryVersion: 2, masteryRevision: 5, stage: 'learning', reviewStep: 0 } }] };
  };
  assert.ok(await active.sync.flush());
  assert.equal(active.posts.length, 2, 'a genuine stale event is durably rebuilt and retried');
  assert.notEqual(active.posts[1].body.events[0].event.id, entry.event.id);
  assert.equal(active.posts[1].body.events[0].event.expectedRevision, 4);
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 0);
});

test('Grammar queue fails closed without Web Locks and retains network/5xx proof', async () => {
  const entry = {
    topicId: 1,
    event: {
      id: '00000000-0000-4000-8000-000000000772', type: 'session_completed',
      expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  };
  const unsupported = createSync({ online: false, lockManager: null });
  unsupported.sync.setOwner('grammar-owner');
  const unavailable = await unsupported.sync.saveGrammarMasteryEvents([entry]);
  assert.equal(unavailable.code, 'GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE');
  assert.equal(unsupported.sync.pendingGrammarMasteryEvents().length, 0);

  const sharedValues = new Map();
  const supported = createSync({ online: false, sharedValues });
  supported.sync.setOwner('grammar-owner');
  await supported.sync.saveGrammarMasteryEvents([entry]);
  const reloadedUnsupported = createSync({ online: true, sharedValues, lockManager: null });
  reloadedUnsupported.sync.setOwner('grammar-owner');
  assert.equal(await reloadedUnsupported.sync.flush(), false, 'background flush cannot claim success without the queue lock');
  assert.equal(reloadedUnsupported.sync.pendingGrammarMasteryEvents().length, 1);

  for (const status of [0, 503]) {
    const active = createSync({ online: true, failRequest: false });
    active.sync.setOwner('grammar-owner');
    active.window.EasyBoostApi.post = async () => { const error = new Error('temporary'); error.status = status; throw error; };
    assert.equal(await active.sync.saveGrammarMasteryEvents([entry]), false);
    assert.equal(active.sync.pendingGrammarMasteryEvents().length, 1, `status ${status} remains queued`);
  }
});

test('a stale stage-advancing event is retained unchanged instead of being rebased', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('grammar-owner');
  const authoritativeUpdates = [];
  active.sync.onGrammarMasterySync((update) => authoritativeUpdates.push(update));
  const scores = Object.fromEntries(['choice', 'input', 'correction', 'transform']
    .map((type) => [type, { correct: 4, total: 4 }]));
  const entry = {
    topicId: 1,
    event: {
      id: '00000000-0000-4000-8000-000000000773', type: 'session_completed',
      expectedRevision: 0, expectedStage: 'learning', expectedReviewStep: 0,
      source: 'builtin', assisted: false,
      completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: scores,
    },
  };
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    return { results: [{ eventId: entry.event.id, applied: false, conflict: true, replay: false,
      record: { masteryVersion: 2, masteryRevision: 2, stage: 'learning', reviewStep: 0 } }] };
  };
  assert.ok(await active.sync.saveGrammarMasteryEvents([entry]));
  assert.equal(active.posts.length, 1);
  assert.equal(active.sync.pendingGrammarMasteryEvents()[0].event.id, entry.event.id);
  assert.equal(active.sync.pendingGrammarMasteryEvents()[0].event.expectedRevision, 0);
  assert.equal(authoritativeUpdates.length, 1, 'the conflict authority must still converge locally');
  assert.equal(authoritativeUpdates[0].records[0].record.masteryRevision, 2);
  assert.equal(active.sync.canQueueGrammarMasteryEvent(20), true,
    'resolved conflicts do not consume the retryable proof capacity');

  const fresh = {
    topicId: 1,
    event: {
      id: '00000000-0000-4000-8000-000000000784', type: 'session_completed',
      expectedRevision: 2, expectedStage: 'learning', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  };
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    return { results: body.events.map((item) => ({
      eventId: item.event.id, applied: true, conflict: false, replay: false,
      record: { masteryVersion: 2, masteryRevision: 3, stage: 'learning', reviewStep: 0 },
    })) };
  };
  const recovered = await active.sync.saveGrammarMasteryEvents([fresh]);
  assert.equal(recovered.results[0].eventId, fresh.event.id);
  assert.equal(active.posts.length, 2, 'the rejected stage proof is not retried ahead of fresh evidence');
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 0,
    'a fresh event at the converged revision replaces its obsolete conflict');
});

test('a stale wrong partial session cannot rebase onto and regress newer authority', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('grammar-owner');
  const entry = { topicId: 1, event: {
    id: '00000000-0000-4000-8000-000000001101', type: 'session_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, completedTypes: ['choice'],
    typeScores: { choice: { correct: 0, total: 1 } }, reason: 'construction_choice',
  } };
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    if (active.posts.length === 1) return { batchId: body.batchId, results: [{
      eventId: body.events[0].event.id, applied: false, conflict: true, replay: false,
      record: { masteryVersion: 2, masteryRevision: 5, stage: 'confirmed', reviewStep: 2, eligibleAt: 1 },
    }] };
    return { batchId: body.batchId, results: [{
      eventId: body.events[0].event.id, applied: true, conflict: false, replay: false,
      record: { masteryVersion: 2, masteryRevision: 6, stage: 'learned', reviewStep: 2, eligibleAt: 1,
        lastRegressionReason: 'construction_choice' },
    }] };
  };

  await active.sync.saveGrammarMasteryEvents([entry]);

  assert.equal(active.posts.length, 1, 'stale wrong work must never be replayed at a later server time');
  assert.equal(active.sync.pendingGrammarMasteryEvents()[0].event.id, entry.event.id);
  assert.equal(active.sync.pendingGrammarMasteryEvents()[0].event.expectedRevision, 1);
});

test('simultaneous tabs receive only the authoritative result for their own queued batch', async () => {
  const sharedValues = new Map();
  const lockManager = createLockManager();
  const first = createSync({ online: true, failRequest: false, sharedValues, lockManager });
  const second = createSync({ online: true, failRequest: false, sharedValues, lockManager });
  first.sync.setOwner('grammar-owner'); second.sync.setOwner('grammar-owner');
  const entry = (topicId, suffix) => ({
    topicId,
    event: {
      id: `00000000-0000-4000-8000-${suffix}`, type: 'session_completed',
      expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  });
  const eventA = entry(1, '000000000781');
  const eventB = entry(2, '000000000782');
  const [resultA, resultB] = await Promise.all([
    first.sync.saveGrammarMasteryEvents([eventA]),
    second.sync.saveGrammarMasteryEvents([eventB]),
  ]);
  assert.equal(resultA.results[0].eventId, eventA.event.id);
  assert.equal(resultB.results[0].eventId, eventB.event.id);
  assert.equal(resultA.batchId, eventA.event.id);
  assert.equal(resultB.batchId, eventB.event.id);
});

test('accepted background Grammar batches publish owner-scoped authoritative records across tabs', async () => {
  const sharedValues = new Map();
  const BroadcastChannel = createBroadcastHub();
  const offline = createSync({ online: false, sharedValues, BroadcastChannel });
  offline.sync.setOwner('grammar-owner');
  const event = {
    id: '00000000-0000-4000-8000-000000000774', type: 'review_completed',
    expectedRevision: 2, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  };
  await offline.sync.saveGrammarMasteryEvent(3, event);
  const remoteUpdates = [];
  offline.sync.onGrammarMasterySync((update) => remoteUpdates.push(update));

  const online = createSync({ online: true, failRequest: false, sharedValues, BroadcastChannel });
  online.sync.setOwner('grammar-owner');
  const localUpdates = [];
  online.sync.onGrammarMasterySync((update) => localUpdates.push(update));
  assert.equal(await online.sync.flush(), true);
  await Promise.resolve();
  for (const updates of [localUpdates, remoteUpdates]) {
    assert.equal(updates.length, 1);
    assert.equal(updates[0].owner, 'grammar-owner');
    assert.equal(updates[0].ownerGeneration, 0);
    assert.equal(updates[0].records[0].topicId, 3);
    assert.equal(updates[0].records[0].record.masteryRevision, 3);
  }
  assert.match(appSource, /onGrammarMasterySync/u);
  assert.match(appSource, /masteryRevision/u, 'application merge must compare canonical revisions');
  assert.match(appSource, /update\.ownerGeneration\s*!==\s*ADOPTED_OWNER_GENERATION/u,
    'application merge must reject mastery from another owner incarnation');
});

test('Grammar batches carry owner generation and legacy generation-zero evidence cannot cross recreation', async () => {
  const sharedValues = new Map();
  const offline = createSync({ online: false, sharedValues });
  offline.sync.setOwner('grammar-owner');
  await offline.sync.saveGrammarMasteryEvent(1, {
    id: '00000000-0000-4000-8000-000000001119', type: 'review_completed',
    expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  });
  const stored = JSON.parse(sharedValues.get('easyboost_pending_grammar_mastery_events_v1'));
  assert.equal(stored.version, 2);
  assert.equal(stored.owners['grammar-owner'].ownerGeneration, 0);
  assert.equal(stored.owners['grammar-owner'].batches.length, 1);

  sharedValues.set('easyboost_deleted_owners_v1', JSON.stringify({
    version: 1, owners: {}, generations: { 'grammar-owner': 1 }, globalGeneration: 1,
  }));
  const recreated = createSync({ online: true, failRequest: false, sharedValues });
  recreated.sync.setOwner('grammar-owner');
  assert.equal(recreated.sync.pendingGrammarMasteryEvents().length, 0);
  assert.equal(await recreated.sync.flush(), false);
  assert.equal(recreated.posts.length, 0, 'pre-delete Grammar evidence cannot enter the recreated account');
});

test('account cleanup uses the Grammar queue lock and privacy waits before reload', async () => {
  const lockManager = createLockManager();
  const active = createSync({ online: false, lockManager });
  active.sync.setOwner('grammar-owner');
  await active.sync.saveGrammarMasteryEvent(1, {
    id: '00000000-0000-4000-8000-000000000775', type: 'review_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  });
  lockManager.calls.length = 0;
  assert.equal(await active.sync.clearOwner(), true);
  assert.deepEqual(lockManager.calls, [
    'easyboost-owner-incarnation:global',
    'easyboost-owner-incarnation:grammar-owner',
  ]);
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 0);
  assert.doesNotMatch(privacySource, /api\.remove\('\/api\/v1\/account'[\s\S]*?clearOwner/u,
    'the irreversible server call cannot happen before taking the owner-incarnation lock');
  assert.match(privacySource, /EasyBoostSync\?\.deleteOwner\([\s\S]*?api\.remove\('\/api\/v1\/account'/u,
    'privacy deletion must own the shared incarnation lock before the irreversible server call');
  assert.match(privacySource, /deleteOwner\(\(expectedOwner\)[\s\S]*?confirmation:\s*'DELETE',\s*owner:\s*expectedOwner/u,
    'the irreversible request must carry the owner captured under the incarnation lock');
});

test('account deletion passes the owner captured under the lock to the remote mutation', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('grammar-owner');
  active.values.set('eb_current', JSON.stringify({ version: 1, owner: 'grammar-owner', ownerGeneration: 0 }));
  active.values.set('eb_data_grammar-owner_g0', '{"state":{"learned":7}}');
  active.values.set('easyboost.adaptive.execution.v1', JSON.stringify({ version: 4, owner: 'grammar-owner', ownerGeneration: 0 }));
  active.values.set('easyboost.adaptive.overview.v1:grammar-owner:g0', JSON.stringify({ version: 'adaptive-overview-cache-v2', owner: 'grammar-owner', ownerGeneration: 0 }));
  let capturedOwner = null;

  assert.equal(await active.sync.deleteOwner(async (owner) => { capturedOwner = owner; }), true);
  assert.equal(capturedOwner, 'grammar-owner');
  for (const key of ['eb_current', 'eb_data_grammar-owner_g0', 'easyboost.adaptive.execution.v1', 'easyboost.adaptive.overview.v1:grammar-owner:g0']) {
    assert.equal(active.values.has(key), false, `${key} is purged before deleteOwner reports success`);
  }
});

test('account deletion fails closed before the server call when Web Locks are unavailable', async () => {
  const active = createSync({ online: true, failRequest: false, lockManager: null });
  active.sync.setOwner('grammar-owner');
  active.values.set('eb_data_grammar-owner', '{"kept":true}');
  let remoteCalls = 0;

  const result = await active.sync.deleteOwner(async () => { remoteCalls += 1; });

  assert.equal(result.code, 'GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE');
  assert.equal(remoteCalls, 0);
  assert.equal(active.values.get('eb_data_grammar-owner'), '{"kept":true}');
  assert.equal(active.sync.ownerBoundGeneration('grammar-owner'), 0);
  assert.match(privacySource, /GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE[\s\S]*?Удаление не выполнено/u);
});

test('account deletion tombstones the owner, purges snapshots and blocks cross-tab resurrection', async () => {
  const sharedValues = new Map([['eb_data_grammar-owner', JSON.stringify({ grammarMastery: { 1: { stage: 'stable' } } })]]);
  const lockManager = createLockManager();
  const BroadcastChannel = createBroadcastHub();
  const first = createSync({ online: false, sharedValues, lockManager, BroadcastChannel });
  const second = createSync({ online: false, sharedValues, lockManager, BroadcastChannel });
  first.sync.setOwner('grammar-owner'); second.sync.setOwner('grammar-owner');
  const deletedOwners = [];
  second.sync.onOwnerDeleted((update) => deletedOwners.push(update.owner));
  assert.equal(await first.sync.clearOwner(), true);
  await Promise.resolve();
  assert.deepEqual(deletedOwners, ['grammar-owner']);
  assert.equal(sharedValues.has('eb_data_grammar-owner'), false);
  const rejected = await second.sync.saveGrammarMasteryEvent(1, {
    id: '00000000-0000-4000-8000-000000000783', type: 'review_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  });
  assert.equal(rejected.code, 'GRAMMAR_MASTERY_OWNER_DELETED');
  assert.equal(second.sync.pendingGrammarMasteryEvents().length, 0);
  second.sync.setOwner('grammar-owner');
  assert.equal((await second.sync.saveGrammarMasteryEvent(1, {
    id: '00000000-0000-4000-8000-000000000785', type: 'review_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  })).code, 'GRAMMAR_MASTERY_OWNER_DELETED', 'ordinary setOwner cannot revive a tombstone');
  const revivalGuard = second.sync.ownerAuthSnapshot('grammar-owner');
  assert.equal(await second.sync.confirmOwner('grammar-owner', revivalGuard), 'grammar-owner',
    'only an explicit confirmed-auth handshake may revive a recreated account');

  const withoutLocks = createSync({ online: false, lockManager: null });
  withoutLocks.sync.setOwner('deleted-owner');
  withoutLocks.values.set('eb_data_deleted-owner', '{}');
  assert.equal(await withoutLocks.sync.clearOwner(), true, 'irreversible server deletion must always finish the local purge');
  assert.equal(withoutLocks.values.has('eb_data_deleted-owner'), false);
  assert.match(appSource, /onOwnerDeleted/u);
  assert.match(appSource, /currentUser=null/u);
});

test('durable owner generations reject a pre-delete auth response after tombstone revival', async () => {
  const sharedValues = new Map();
  const lockManager = createLockManager();
  const pausedTab = createSync({ online: false, sharedValues, lockManager });
  const deletingTab = createSync({ online: false, sharedValues, lockManager });
  const recreatedTab = createSync({ online: false, sharedValues, lockManager });

  const staleGuard = pausedTab.sync.ownerAuthSnapshot('grammar-owner');
  deletingTab.sync.setOwner('grammar-owner');
  assert.equal(await deletingTab.sync.clearOwner(), true);

  const freshGuard = recreatedTab.sync.ownerAuthSnapshot('grammar-owner');
  assert.ok(freshGuard.ownerGeneration > staleGuard.ownerGeneration,
    'deletion must advance durable authority before any BroadcastChannel delivery');
  assert.equal(await recreatedTab.sync.confirmOwner('grammar-owner', freshGuard), 'grammar-owner',
    'a request started after deletion may revive the same server-confirmed username');
  assert.equal(recreatedTab.sync.isOwnerDeleted('grammar-owner'), false);

  assert.equal(await pausedTab.sync.confirmOwner('grammar-owner', staleGuard), null,
    'revival must not erase the deletion generation or admit the paused old response');
  const stored = JSON.parse(sharedValues.get('easyboost_deleted_owners_v1'));
  assert.equal(stored.generations['grammar-owner'], freshGuard.ownerGeneration);
  assert.equal(stored.owners['grammar-owner'], undefined, 'revival clears only the tombstone status');
});

test('a delayed deletion notification logs out an old incarnation after legitimate revival', async () => {
  const sharedValues = new Map();
  const lockManager = createLockManager();
  const BroadcastChannel = createDeferredBroadcastHub();
  const oldTab = createSync({ online: false, sharedValues, lockManager, BroadcastChannel });
  const deletingTab = createSync({ online: false, sharedValues, lockManager, BroadcastChannel });
  const recreatedTab = createSync({ online: false, sharedValues, lockManager, BroadcastChannel });
  const delivered = [];
  oldTab.sync.setOwner('grammar-owner');
  oldTab.sync.onOwnerDeleted((update) => delivered.push(update));
  deletingTab.sync.setOwner('grammar-owner');
  assert.equal(await deletingTab.sync.clearOwner(), true);
  const freshGuard = recreatedTab.sync.ownerAuthSnapshot('grammar-owner');
  assert.equal(await recreatedTab.sync.confirmOwner('grammar-owner', freshGuard), 'grammar-owner');

  const staleWrite = await oldTab.sync.saveGrammarMasteryEvent(1, {
    id: '00000000-0000-4000-8000-000000000799', type: 'review_completed',
    expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  });
  assert.equal(staleWrite.code, 'GRAMMAR_MASTERY_OWNER_CHANGED',
    'the old sync owner generation cannot write into the recreated account before Broadcast delivery');
  assert.equal(await oldTab.sync.queueProgress({ learned: 99 }), false,
    'generic progress is bound to the same adopted owner generation');

  BroadcastChannel.flush();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(delivered.length, 1, 'notification delivery is independent of current tombstone status');
  assert.equal(delivered[0].ownerGeneration, freshGuard.ownerGeneration,
    'the app can distinguish the deleted incarnation from the recreated one');
  assert.equal(oldTab.sync.isOwnerDeleted('grammar-owner'), false,
    'a delayed notification must not re-create the cleared tombstone');
});

test('Telegram auth uses the durable global deletion generation when its owner is not known yet', async () => {
  const sharedValues = new Map();
  const lockManager = createLockManager();
  const pollingTab = createSync({ online: false, sharedValues, lockManager });
  const deletingTab = createSync({ online: false, sharedValues, lockManager });
  const staleGlobal = pollingTab.sync.ownerAuthSnapshot();

  deletingTab.sync.setOwner('grammar-owner');
  assert.equal(await deletingTab.sync.clearOwner(), true);
  const freshGlobal = pollingTab.sync.ownerAuthSnapshot();
  assert.ok(freshGlobal.globalGeneration > staleGlobal.globalGeneration);
  assert.equal(await pollingTab.sync.confirmOwner('grammar-owner', {
    ownerScoped: false, globalGeneration: staleGlobal.globalGeneration,
  }), null, 'a deletion during an owner-unknown Telegram poll invalidates its response');
  assert.equal(await pollingTab.sync.confirmOwner('grammar-owner', {
    ownerScoped: false, globalGeneration: freshGlobal.globalGeneration,
  }), 'grammar-owner', 'a new Telegram poll after deletion may confirm the recreated account');
});

test('irreversible deletion still purges and logs out when the durable tombstone write fails', async () => {
  const active = createSync({
    online: false,
    failSetKey: 'easyboost_deleted_owners_v1',
    sharedValues: new Map([
      ['eb_data_grammar-owner', JSON.stringify({ grammarMastery: { 1: { stage: 'stable' } } })],
      ['easyboost_pending_modules_v3', JSON.stringify({ version: 3, owners: { 'grammar-owner': { modules: { learned: 1 } } } })],
    ]),
  });
  const deleted = [];
  active.sync.setOwner('grammar-owner');
  active.sync.onOwnerDeleted((update) => deleted.push(update.owner));

  const result = await active.sync.clearOwner();

  assert.equal(result.code, 'GRAMMAR_MASTERY_QUEUE_WRITE_FAILED');
  assert.deepEqual(deleted, ['grammar-owner'], 'same-tab logout notification is mandatory after server deletion');
  assert.equal(active.values.has('eb_data_grammar-owner'), false);
  assert.equal(active.values.has('easyboost_pending_modules_v3'), false);
  assert.equal(active.sync.isOwnerDeleted('grammar-owner'), true,
    'an in-memory tombstone prevents resurrection when durable storage is unavailable');
  assert.equal(await active.sync.queueProgress({ learned: 2 }), false);
});

test('irreversible deletion attempts every owner store purge after the first write fails', async () => {
  const stores = new Map([
    ['easyboost_pending_modules_v3', JSON.stringify({ version: 3, owners: {
      'grammar-owner': { modules: { learned: 1 } }, other: { modules: { learned: 2 } },
    } })],
    ['easyboost_pending_module_attempts_v1', JSON.stringify({ version: 1, owners: {
      'grammar-owner': [{ id: 'attempt' }], other: [{ id: 'other-attempt' }],
    } })],
    ['easyboost_pending_grammar_mastery_events_v1', JSON.stringify({ version: 1, owners: {
      'grammar-owner': [{ id: 'batch', events: [] }], other: [{ id: 'other-batch', events: [] }],
    } })],
    ['eb_data_grammar-owner', '{}'],
  ]);
  const active = createSync({ online: false, sharedValues: stores, failSetKeys: ['easyboost_pending_modules_v3'] });
  active.sync.setOwner('grammar-owner');

  const result = await active.sync.clearOwner();

  assert.equal(result.code, 'GRAMMAR_MASTERY_QUEUE_WRITE_FAILED');
  assert.equal(JSON.parse(stores.get('easyboost_pending_module_attempts_v1')).owners['grammar-owner'], undefined);
  assert.equal(JSON.parse(stores.get('easyboost_pending_grammar_mastery_events_v1')).owners['grammar-owner'], undefined);
  assert.equal(stores.has('eb_data_grammar-owner'), false);
});

test('non-retryable Grammar conflicts coalesce to one bounded marker per topic', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('grammar-owner');
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    return { batchId: body.batchId, results: body.events.map((entry) => ({
      eventId: entry.event.id, applied: false, conflict: true, replay: false,
      record: { masteryVersion: 2, masteryRevision: 9, stage: 'learned', reviewStep: 0 },
    })) };
  };
  for (let index = 0; index < 30; index += 1) {
    await active.sync.saveGrammarMasteryEvent(1, {
      id: `00000000-0000-4000-8000-${String(900 + index).padStart(12, '0')}`,
      type: 'review_completed', expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
      source: 'builtin', assisted: false, passed: true,
    });
  }
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 1);
  assert.equal(active.sync.canQueueGrammarMasteryEvent(20), true);
});

test('a subset retry cannot borrow an enclosing batch correlation', async () => {
  const offline = createSync({ online: false });
  offline.sync.setOwner('grammar-owner');
  const entry = (topicId, suffix) => ({ topicId, event: {
    id: `00000000-0000-4000-8000-${suffix}`, type: 'review_completed',
    expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  } });
  const first = entry(1, '000000001001'), second = entry(2, '000000001002');
  await offline.sync.saveGrammarMasteryEvents([first, second]);
  const subset = await offline.sync.saveGrammarMasteryEvent(2, second.event);
  assert.equal(subset.code, 'GRAMMAR_MASTERY_EVENT_INVALID');
});

test('an owner switch stops a Grammar mastery flush before sending the next old-owner event', async () => {
  const active = createSync({ online: true, failRequest: false });
  let release;
  let started;
  const sent = new Promise((resolve) => { started = resolve; });
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    if (body.events[0].event.id.endsWith('092')) { started(); await new Promise((resolve) => { release = resolve; }); }
    return { results: body.events.map((entry) => ({
      eventId: entry.event.id, applied: true, conflict: false, replay: false,
      record: { masteryVersion: 2, masteryRevision: 1, stage: 'learned', reviewStep: 0 },
    })) };
  };
  const event = {
    id: '00000000-0000-4000-8000-000000000092', type: 'review_completed',
    expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: false, passed: true,
  };
  active.sync.setOwner('grammar-owner');
  active.window.navigator.onLine = false;
  await active.sync.saveGrammarMasteryEvent(1, event);
  await active.sync.saveGrammarMasteryEvent(1, { ...event, id: '00000000-0000-4000-8000-000000000093' });
  active.window.navigator.onLine = true;
  const saving = active.sync.flush();
  await sent;
  active.values.set('easyboost_deleted_owners_v1', JSON.stringify({
    version: 1, owners: {}, generations: { 'other-owner': 1 }, globalGeneration: 1,
  }));
  active.sync.setOwner('other-owner');
  release();
  assert.equal(await saving, true);
  assert.equal(active.posts.length, 1, 'the next event must not be sent after the owner changes');
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 0);
  active.sync.setOwner('grammar-owner');
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 1, 'unsent old-owner proof remains owner-scoped');
  assert.equal(await active.sync.flush(), true);
  assert.equal(active.posts.length, 2);
  assert.equal(active.sync.pendingGrammarMasteryEvents().length, 0);
});

test('a guarded adaptive attempt rechecks the exact incarnation inside the owner lock', async () => {
  const enterLocks = [];
  const lockManager = { request(_name, _options, callback) {
    return new Promise((resolve) => { enterLocks.push(() => Promise.resolve(callback({ name: 'deferred' })).then(resolve)); });
  } };
  const active = createSync({ online: false, lockManager });
  active.sync.setOwner('adaptive-owner');
  const saving = active.sync.saveModuleAttempt({
    id: '00000000-0000-4000-8000-000000001221', module: 'grammar',
    activity: 'grammar_forms_topic_3', score: 1, maxScore: 1,
  }, { owner: 'adaptive-owner', ownerGeneration: 0 });
  active.values.set('easyboost_deleted_owners_v1', JSON.stringify({
    version: 1, owners: {}, generations: { 'adaptive-owner': 1 }, globalGeneration: 1,
  }));
  active.sync.setOwner(null);
  active.sync.setOwner('adaptive-owner');
  enterLocks.shift()();
  await Promise.resolve();
  enterLocks.shift()();

  const guarded = await saving;
  assert.equal(guarded.status, 'owner_conflict');
  assert.equal(guarded.code, 'OWNER_CHANGED');
  assert.equal(active.sync.pendingModuleAttempts().length, 0);
});

test('a targeted terminal module-attempt response is typed and removed exactly once', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('adaptive-owner');
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    const error = new Error('claim expired');
    error.status = 409;
    error.code = 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED';
    throw error;
  };
  const result = await active.sync.saveModuleAttempt({
    id: '00000000-0000-4000-8000-000000001222', module: 'grammar',
    activity: 'grammar_forms_topic_3', score: 1, maxScore: 1,
  }, { owner: 'adaptive-owner', ownerGeneration: 0 });

  assert.equal(result.status, 'terminal_rejected');
  assert.equal(result.code, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
  assert.equal(active.posts.length, 1);
  assert.equal(active.sync.pendingModuleAttempts().length, 0);
});

test('an adaptive attempt flush reuses its already-held owner incarnation token', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('adaptive-owner');
  const attempt = {
    id: '00000000-0000-4000-8000-000000001299', module: 'grammar',
    activity: 'grammar_forms_topic_3', score: 1, maxScore: 1,
  };
  const result = await Promise.race([
    active.sync.withOwnerIncarnationLock({ owner: 'adaptive-owner', ownerGeneration: 0 }, (ownerLockToken) => (
      active.sync.saveModuleAttempt(attempt, { owner: 'adaptive-owner', ownerGeneration: 0, ownerLockToken })
    )),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'deadlocked' }), 100)),
  ]);
  assert.equal(result.status, 'delivered');
  assert.equal(active.sync.pendingModuleAttempts().length, 0);
});

test('profile submit can durably queue preferences before its deferred network flush', async () => {
  const { sync, posts } = createSync({ online: true, failRequest: false });
  sync.setOwner('learner-a');
  const learnerPreferences = {
    version: 1,
    schoolGrade: 11,
    preferredSessionMinutes: 40,
  };

  assert.equal(await sync.queueProgress({ learnerPreferences }), true);
  assert.deepEqual(sync.pendingModules(), { learnerPreferences });
  assert.equal(posts.length, 0, 'durable queueing must not itself start the deferred network flush');
});

test('the learner preferences screen is available on a first offline open', () => {
  assert.match(entrySource, /import \* as profileScreen from '\.\/screens\/profile\.js'/u);
  assert.doesNotMatch(screenLoaderSource, /import\('\.\/screens\/profile\.js'\)/u);
  assert.match(workerSource, /'\/screens\/profile\.js'/u);
});

test('a failed online attempt keeps the change queued rather than dropping it', async () => {
  const { sync, posts } = createSync({ online: true, failRequest: true });
  sync.setOwner('learner-a');
  await sync.setBaseline({ words: { learned: 10 } });

  const result = await sync.saveProgress({ words: { learned: 14 } });

  assert.equal(result, false);
  assert.equal(posts.length, 1, 'при onLine === true попытка делается');
  assert.equal(sync.hasPending(), true, 'сорвавшийся запрос не должен стоить ученику прогресса');
});

test('generic progress and attempt sends bind their intended owner to the authenticated request', async () => {
  const active = createSync({ online: true, failRequest: false });
  active.sync.setOwner('learner-a');
  await active.sync.setBaseline({ words: { learned: 0 } });
  assert.equal(await active.sync.saveProgress({ words: { learned: 1 } }), true);
  assert.equal(active.posts[0].body.owner, 'learner-a');

  await active.sync.saveModuleAttempt({
    id: '00000000-0000-4000-8000-000000000097', module: 'grammar',
    activity: 'grammar_topic', score: 1, maxScore: 1,
  });
  const attempt = active.posts.find((entry) => entry.path === '/api/v1/module-attempts');
  assert.equal(attempt.body.owner, 'learner-a');
});

test('an authenticated-owner conflict retains generic progress and attempt evidence', async () => {
  const active = createSync({ online: false, failRequest: false });
  active.sync.setOwner('learner-a');
  await active.sync.setBaseline({ words: { learned: 0 } });
  await active.sync.saveProgress({ words: { learned: 1 } });
  await active.sync.saveModuleAttempt({
    id: '00000000-0000-4000-8000-000000000096', module: 'grammar',
    activity: 'grammar_topic', score: 1, maxScore: 1,
  });
  active.window.navigator.onLine = true;
  active.window.EasyBoostApi.post = async () => {
    const error = new Error('owner changed'); error.status = 409; error.code = 'OWNER_CHANGED'; throw error;
  };

  assert.equal(await active.sync.flush(), false);
  assert.deepEqual(active.sync.pendingModules(), { words: { learned: 1 } });
  assert.equal(active.sync.pendingModuleAttempts().length, 1,
    'cross-account rejection must not silently discard the original owner evidence');
});

test('an offline vocabulary attempt is owner-bound, durable and first-write-wins', async () => {
  const { sync, posts } = createSync({ online: false });
  sync.setOwner('learner-a');
  const attempt = {
    id: 'vocabulary-session-1', module: 'vocabulary', activity: 'vocabulary_active_recall_session',
    score: 3, maxScore: 4, durationMs: 90_000, metadata: { evidence: 'objective' },
  };

  assert.equal(await sync.saveModuleAttempt(attempt), false);
  assert.equal(await sync.saveModuleAttempt({ ...attempt, score: 4 }), false);
  assert.equal(posts.length, 0);
  assert.equal(sync.hasPending(), true);
  assert.equal(sync.pendingModuleAttempts().length, 1);
  assert.equal(sync.pendingModuleAttempts()[0].score, 3,
    'conflicting replay must not replace the first durable result');

  sync.setOwner('learner-b');
  assert.equal(sync.pendingModuleAttempts().length, 0, 'another account cannot see the queued attempt');
  sync.setOwner('learner-a');
  assert.equal(sync.pendingModuleAttempts().length, 1);
  assert.equal(await sync.clearOwner(), true);
  sync.setOwner('learner-a');
  assert.equal(sync.pendingModuleAttempts().length, 0, 'account deletion must clear its local attempt queue');
  assert.equal(await sync.saveModuleAttempt({ ...attempt, id: 'oversized', metadata: { value: 'x'.repeat(21_000) } }), false);
  assert.equal(sync.pendingModuleAttempts().length, 0, 'oversized local attempts fail closed');
});

test('a queued vocabulary attempt syncs exactly once after the same owner returns online', async () => {
  const attempt = {
    id: 'vocabulary-session-2', module: 'vocabulary', activity: 'vocabulary_active_recall_session',
    score: 2, maxScore: 3, durationMs: 60_000, metadata: { evidence: 'objective' },
  };
  const offline = createSync({ online: false });
  offline.sync.setOwner('learner-a');
  await offline.sync.saveModuleAttempt(attempt);
  const queued = offline.values.get('easyboost_pending_module_attempts_v1');
  assert.ok(queued, 'attempt queue must survive a reload');

  const online = createSync({ online: true, failRequest: false });
  online.values.set('easyboost_pending_module_attempts_v1', queued);
  online.sync.setOwner('learner-b');
  assert.equal(await online.sync.flush(), false);
  assert.equal(online.posts.length, 0, 'a different owner must not upload the attempt');

  online.sync.setOwner('learner-a');
  assert.equal(await online.sync.flush(), true);
  assert.equal(online.posts.length, 1);
  assert.equal(online.posts[0].path, '/api/v1/module-attempts');
  assert.equal(online.posts[0].body.id, attempt.id);
  assert.equal(online.sync.pendingModuleAttempts().length, 0);
  assert.equal(await online.sync.flush(), false);
  assert.equal(online.posts.length, 1, 'a second flush must not duplicate the attempt');
});

test('switching accounts during an attempt flush cannot remove or upload the other owner queue', async () => {
  const active = createSync({ online: true, failRequest: false });
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    if (body.id === 'owner-a-attempt' && active.posts.length === 1) {
      firstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { ok: true };
  };

  active.sync.setOwner('learner-a');
  const first = active.sync.saveModuleAttempt({
    id: 'owner-a-attempt', module: 'vocabulary', activity: 'vocabulary_active_recall_session',
    score: 1, maxScore: 2, durationMs: 30_000, metadata: {},
  });
  await started;

  active.sync.setOwner('learner-b');
  const second = active.sync.saveModuleAttempt({
    id: 'owner-b-attempt', module: 'vocabulary', activity: 'vocabulary_active_recall_session',
    score: 2, maxScore: 2, durationMs: 30_000, metadata: {},
  });
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(active.posts.map((entry) => entry.body.id), ['owner-a-attempt', 'owner-b-attempt']);
  active.sync.setOwner('learner-a');
  assert.equal(active.sync.pendingModuleAttempts().length, 1,
    'a response observed after the owner switch stays queued for idempotent replay by its owner');
  assert.equal(await active.sync.flush(), true);
  assert.equal(active.sync.pendingModuleAttempts().length, 0);
  active.sync.setOwner('learner-b');
  assert.equal(active.sync.pendingModuleAttempts().length, 0);
});

test('deletion queued behind the first attempt stops every later captured attempt', async () => {
  const sharedValues = new Map();
  const lockManager = createLockManager();
  const active = createSync({ online: false, sharedValues, lockManager });
  const deleting = createSync({ online: false, sharedValues, lockManager });
  active.sync.setOwner('grammar-owner');
  deleting.sync.setOwner('grammar-owner');
  const attempt = (id) => ({ id, module: 'vocabulary', itemId: id, score: 1, maxScore: 1, durationMs: 10 });
  await active.sync.saveModuleAttempt(attempt('attempt-one'));
  await active.sync.saveModuleAttempt(attempt('attempt-two'));
  active.window.navigator.onLine = true;

  const firstPost = deferred();
  const started = deferred();
  const posts = [];
  active.window.EasyBoostApi.post = async (_path, body) => {
    posts.push(body.id); if (posts.length === 1) { started.resolve(); return firstPost.promise; }
    return { ok: true };
  };
  const flushing = active.sync.flush();
  await started.promise;
  const deletion = deleting.sync.clearOwner();
  firstPost.resolve({ ok: true });
  await deletion;
  await flushing;

  assert.deepEqual(posts, ['attempt-one'],
    'each network continuation must reacquire and recheck the owner generation');
});

test('an in-flight progress response only clears the owner and values it actually sent', async () => {
  const active = createSync({ online: true, failRequest: false });
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  active.window.EasyBoostApi.post = async (path, body) => {
    active.posts.push({ path, body });
    if (body.modules && body.modules.words && body.modules.words.learned === 11 && active.posts.length === 1) {
      firstStarted();
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { ok: true };
  };

  active.sync.setOwner('learner-a');
  await active.sync.setBaseline({ words: { learned: 10 } });
  const first = active.sync.saveProgress({ words: { learned: 11 } });
  await started;

  active.sync.setOwner('learner-b');
  await active.sync.setBaseline({ words: { learned: 20 } });
  active.window.navigator.onLine = false;
  assert.equal(await active.sync.saveProgress({ words: { learned: 21 } }), false);
  releaseFirst();
  await first;

  assert.deepEqual(active.sync.pendingModules(), { words: { learned: 21 } },
    'owner A response must not clear owner B queued progress');
  active.sync.setOwner('learner-a');
  assert.deepEqual(active.sync.pendingModules(), { words: { learned: 11 } },
    'a response observed after an owner switch remains queued for its original owner');
  active.window.navigator.onLine = true;
  assert.equal(await active.sync.flush(), true);
  assert.equal(Object.keys(active.sync.pendingModules()).length, 0);
});

/* ---------- service worker ---------- */

function createWorker({ cached = {}, networkFails = true, networkResponses = {} } = {}) {
  const listeners = new Map();
  const store = new Map(Object.entries(cached));
  const keyOf = (request) => (typeof request === 'string' ? request : request.url);

  const cache = {
    addAll: async () => {},
    put: async (request, response) => { store.set(keyOf(request), response); },
    match: async (request) => store.get(keyOf(request)),
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['easyboost-static-v17'],
    delete: async () => true,
    match: async (request) => store.get(keyOf(request)),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    caches,
  };

  const networkCalls = [];
  const sandbox = {
    self,
    caches,
    Headers,
    URL,
    Promise,
    Response,
    async fetch(request) {
      networkCalls.push(keyOf(request));
      if (networkFails) throw new TypeError('Failed to fetch');
      const configured = networkResponses[keyOf(request)];
      if (configured) return configured.clone();
      return { ok: true, status: 200, clone: () => ({ ok: true, fromNetwork: true }), fromNetwork: true };
    },
  };
  vm.runInNewContext(workerSource, sandbox);
  return { listeners, store, networkCalls };
}

function dispatchFetch(worker, request) {
  let responded;
  let handled = false;
  const waits = [];
  const event = {
    request,
    respondWith: (value) => { handled = true; responded = value; },
    waitUntil: (value) => { waits.push(Promise.resolve(value)); },
  };
  worker.listeners.get('fetch')(event);
  return { handled, responded, waits };
}

test('the service worker never answers an online-only API call from its cache', async () => {
  /* A cache deliberately poisoned with a stale answer for each online-only endpoint. */
  const staleVerdict = { ok: true, status: 200, fromCache: true };
  const apiPaths = [
    '/api/v1/ai/evaluate-writing',
    '/api/v1/ai/evaluate-speaking',
    '/api/v1/ai/generate-content',
    '/api/v1/tts?text=hello',
    '/api/v1/stt',
    '/api/v1/tg/start',
    '/api/v1/tg/check?code=123456',
    '/api/v1/progress/modules',
    '/api/v1/me',
  ];
  const cached = Object.fromEntries(apiPaths.map((path) => [ORIGIN + path, staleVerdict]));
  const worker = createWorker({ cached, networkFails: true });

  for (const path of apiPaths) {
    const result = dispatchFetch(worker, { method: 'GET', url: ORIGIN + path, mode: 'cors' });
    assert.equal(
      result.handled,
      false,
      `service worker перехватил ${path}: закэшированный ответ API нельзя выдавать за свежий`,
    );
  }
});

test('the app shell still comes from the cache offline, so the previous test is not vacuous', async () => {
  const shell = { ok: true, status: 200, fromCache: true };
  const worker = createWorker({
    cached: { [`${ORIGIN}/app.js`]: shell, '/': shell, '/offline.html': shell },
    networkFails: true,
  });

  const asset = dispatchFetch(worker, { method: 'GET', url: `${ORIGIN}/app.js`, mode: 'cors' });
  assert.equal(asset.handled, true, 'статика обязана работать офлайн — это раздел 6.1');
  assert.equal((await asset.responded).fromCache, true);

  const navigation = dispatchFetch(worker, { method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' });
  assert.equal(navigation.handled, true);
  assert.equal((await navigation.responded).fromCache, true);
});

test('a loaded listening catalog joins the runtime cache and remains available offline', async () => {
  const url = `${ORIGIN}/listening-pilot-v1.js`;
  const online = createWorker({ networkFails: false });
  const first = dispatchFetch(online, { method: 'GET', url, mode: 'cors' });
  assert.equal((await first.responded).fromNetwork, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(online.store.get(url).fromNetwork, true);

  const offline = createWorker({ cached: Object.fromEntries(online.store), networkFails: true });
  const replay = dispatchFetch(offline, { method: 'GET', url, mode: 'cors' });
  assert.equal((await replay.responded).fromNetwork, true);
});

test('all lazy Reading content shards stay out of the app shell and join the runtime cache after loading', async () => {
  const shardPaths = [
    '/content/reading/task10-v1.js',
    '/content/reading/task11-v1.js',
    '/content/reading/task12-18-v1.js',
  ];
  const shellDeclaration = workerSource.match(/const APP_SHELL=(\[[^\]]*\]);/u)?.[1] || '';
  const online = createWorker({ networkFails: false });

  for (const path of shardPaths) {
    const filename = path.split('/').at(-1);
    assert.equal(readingPilotSource.includes(`import('.${path}')`), true, `${filename} must use dynamic import`);
    assert.equal(shellDeclaration.includes(filename), false, `${filename} must not inflate initial JavaScript`);

    const url = ORIGIN + path;
    const first = dispatchFetch(online, { method: 'GET', url, mode: 'cors' });
    assert.equal((await first.responded).fromNetwork, true);
    assert.equal(first.waits.length, 1, `${filename} runtime-cache write must extend the worker lifetime`);
    await Promise.all(first.waits);
    assert.equal(online.store.get(url).fromNetwork, true);

    const offline = createWorker({ cached: Object.fromEntries(online.store), networkFails: true });
    const replay = dispatchFetch(offline, { method: 'GET', url, mode: 'cors' });
    assert.equal((await replay.responded).fromNetwork, true);
  }
});

test('a successful navigation refreshes the cached shell for the next offline start', async () => {
  const stale = { ok: true, status: 200, fromCache: true };
  const worker = createWorker({ cached: { '/': stale }, networkFails: false });

  const navigation = dispatchFetch(worker, { method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' });
  assert.equal((await navigation.responded).fromNetwork, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(worker.store.get('/').fromNetwork, true, 'следующий офлайн-запуск должен получить свежую разметку');
});

test('a ranged listening MP3 request caches the full asset and replays ranges offline', async () => {
  const url = `${ORIGIN}/audio/listening/listening-pilot-v1/matching/sample-r1-s01-speaker-a-female-1.mp3`;
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const online = createWorker({
    networkFails: false,
    networkResponses: {
      [url]: new Response(bytes, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length) },
      }),
    },
  });

  const first = dispatchFetch(online, {
    method: 'GET', url, mode: 'cors', headers: new Headers({ Range: 'bytes=4-11' }),
  });
  const firstResponse = await first.responded;
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all(first.waits);
  assert.equal(firstResponse.status, 206);
  assert.deepEqual(Array.from(new Uint8Array(await firstResponse.arrayBuffer())), Array.from(bytes.slice(4, 12)));
  assert.equal(online.store.get(url).status, 200, 'the cache must contain a complete reusable MP3');

  const offline = createWorker({ cached: Object.fromEntries(online.store), networkFails: true });
  const replay = dispatchFetch(offline, {
    method: 'GET', url, mode: 'cors', headers: new Headers({ Range: 'bytes=12-19' }),
  });
  const replayResponse = await replay.responded;
  assert.equal(replayResponse.status, 206);
  assert.equal(replayResponse.headers.get('Content-Range'), 'bytes 12-19/32');
  assert.deepEqual(Array.from(new Uint8Array(await replayResponse.arrayBuffer())), Array.from(bytes.slice(12, 20)));
});

test('a write to an online-only endpoint is never intercepted, cached or replayed', async () => {
  const worker = createWorker({ networkFails: true });

  const write = dispatchFetch(worker, { method: 'POST', url: `${ORIGIN}/api/v1/ai/evaluate-writing`, mode: 'cors' });
  assert.equal(write.handled, false, 'POST не должен проходить через service worker');
  assert.equal(worker.store.size, 0, 'ответы API не попадают в кэш ни при каких условиях');
  assert.equal(worker.networkCalls.length, 0);
});

test('a successful API response is not written into the cache for later reuse', async () => {
  const worker = createWorker({ networkFails: false });

  dispatchFetch(worker, { method: 'GET', url: `${ORIGIN}/api/v1/me`, mode: 'cors' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(worker.store.size, 0, 'даже удачный ответ /api/v1/me нельзя сохранять — подписка меняется на сервере');
});
