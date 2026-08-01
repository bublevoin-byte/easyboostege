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
const workerSource = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');

const ORIGIN = 'https://app.easyboost.ru';

function createApi({ offline = true } = {}) {
  const attempts = [];
  const window = {
    location: { origin: ORIGIN, protocol: 'https:' },
    async fetch(url, options) {
      attempts.push({ url: String(url), method: (options && options.method) || 'GET' });
      if (offline) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        status: 200,
        headers: { get: () => '' },
        json: async () => ({ data: { score: 6 } }),
        blob: async () => ({ size: 128 }),
      };
    },
  };
  vm.runInNewContext(apiSource, { window });
  return { api: window.EasyBoostApi, attempts };
}

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

/* ---------- progress synchronization ---------- */

function createSync({ online = false, failRequest = true } = {}) {
  const values = new Map();
  const posts = [];
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    localStorage,
    navigator: { onLine: online },
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
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(syncSource, {
    window,
    localStorage,
    navigator: window.navigator,
    EasyBoostApi: window.EasyBoostApi,
    JSON,
    Object,
    Date,
    Promise,
  });
  return { sync: window.EasyBoostSync, posts, values };
}

test('offline progress synchronization reports failure instead of a silent success', async () => {
  const { sync, posts } = createSync({ online: false });
  await sync.setBaseline({ words: { learned: 10 } });

  const result = await sync.saveProgress({ words: { learned: 14 } });

  assert.equal(result, false, 'синхронизация без сети не должна отвечать «сохранено»');
  assert.equal(posts.length, 0, 'при navigator.onLine === false запрос не отправляется вовсе');
  assert.equal(sync.hasPending(), true, 'изменение обязано остаться в очереди, а не потеряться');
  assert.deepEqual(sync.pendingModules(), { words: { learned: 14 } });
});

test('a queued change survives until the network actually accepts it', async () => {
  const offline = createSync({ online: false });
  await offline.sync.setBaseline({ words: { learned: 10 } });
  await offline.sync.saveProgress({ words: { learned: 14 } });

  /* The queue is shared through localStorage, so a later online session sees it. */
  const queued = offline.values.get('easyboost_pending_modules_v2');
  assert.ok(queued, 'очередь синхронизации должна пережить перезапуск приложения');

  const online = createSync({ online: true, failRequest: false });
  online.values.set('easyboost_pending_modules_v2', queued);

  const flushed = await online.sync.flush();
  assert.equal(flushed, true);
  assert.equal(online.posts.length, 1);
  assert.deepEqual(online.posts[0].body.modules, { words: { learned: 14 } });
  assert.equal(online.sync.hasPending(), false, 'после успешной отправки очередь очищается');
});

test('a failed online attempt keeps the change queued rather than dropping it', async () => {
  const { sync, posts } = createSync({ online: true, failRequest: true });
  await sync.setBaseline({ words: { learned: 10 } });

  const result = await sync.saveProgress({ words: { learned: 14 } });

  assert.equal(result, false);
  assert.equal(posts.length, 1, 'при onLine === true попытка делается');
  assert.equal(sync.hasPending(), true, 'сорвавшийся запрос не должен стоить ученику прогресса');
});

/* ---------- service worker ---------- */

function createWorker({ cached = {}, networkFails = true } = {}) {
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
    URL,
    Promise,
    async fetch(request) {
      networkCalls.push(keyOf(request));
      if (networkFails) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, clone: () => ({ ok: true, fromNetwork: true }), fromNetwork: true };
    },
  };
  vm.runInNewContext(workerSource, sandbox);
  return { listeners, store, networkCalls };
}

function dispatchFetch(worker, request) {
  let responded;
  let handled = false;
  const event = {
    request,
    respondWith: (value) => { handled = true; responded = value; },
    waitUntil: () => {},
  };
  worker.listeners.get('fetch')(event);
  return { handled, responded };
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

test('a successful navigation refreshes the cached shell for the next offline start', async () => {
  const stale = { ok: true, status: 200, fromCache: true };
  const worker = createWorker({ cached: { '/': stale }, networkFails: false });

  const navigation = dispatchFetch(worker, { method: 'GET', url: `${ORIGIN}/`, mode: 'navigate' });
  assert.equal((await navigation.responded).fromNetwork, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(worker.store.get('/').fromNetwork, true, 'следующий офлайн-запуск должен получить свежую разметку');
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
